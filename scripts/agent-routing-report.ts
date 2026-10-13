import { parseArgs } from "node:util";
import { z } from "../richtfest-shared/node_modules/zod";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";

// Operator-only, read-only report. Explicit tenant/project scope; no prompts,
// credentials, source text or reviewer notes are exported.
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  tenant: { type: "string" }, project: { type: "string" }, since: { type: "string" },
} });
const tenant = z.string().uuid().parse(values.tenant);
const project = z.string().uuid().parse(values.project);
const since = z.string().datetime().parse(values.since);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const { pool } = createDatabase(process.env.DATABASE_URL);
const client = await pool.connect();
try {
  await client.query("begin read only");
  await client.query("set local statement_timeout = '30s'");
  const { rows } = await client.query(`
    with recursive roots as (
      select r.id, r.provider, r.status, r.started_at, r.finished_at,
        coalesce(r.model_policy->>'effort', 'legacy') as effort,
        coalesce(r.model_policy->'supervisor'->>'modelId', 'unknown') as model,
        coalesce(r.model_policy->'decisionRouting'->>'mode', 'off') as mode,
        coalesce((r.model_policy->>'knowledgeRerankingEnabled')::boolean, false) as knowledge_reranking,
        coalesce(plan.entry->>'strategy', 'supervisor') as route,
        decision.entry->'output'->>'outcome' as outcome,
        decision.entry->'output'->>'blocked' as blocked
      from knowledge_agent_runs r
      left join knowledge_supervisor_runs s on s.run_id=r.id and s.tenant_id=r.tenant_id
      left join lateral (select entry from jsonb_array_elements(s.history) with ordinality h(entry, n)
        where entry->>'phase'='plan' order by n desc limit 1) plan on true
      left join lateral (select entry from jsonb_array_elements(s.history) with ordinality h(entry, n)
        where entry->>'phase'='decision' order by n desc limit 1) decision on true
      where r.tenant_id=$1 and r.project_id=$2 and r.parent_run_id is null and r.created_at >= $3
    ), tree as (
      select id, id as root_id from roots
      union
      select r.id, t.root_id from knowledge_agent_runs r join tree t on r.parent_run_id=t.id
      where r.tenant_id=$1 and r.project_id=$2
    ), costs as (
      select t.root_id, count(*) as calls,
        sum(u.estimated_cost_usd_micros)::numeric / 1000000 as recorded_cost,
        bool_and(u.estimated_cost_usd_micros is not null) as priced
      from tree t join knowledge_agent_run_usage u on u.run_id=t.id and u.tenant_id=$1 group by t.root_id
    ), missing as (
      select t.root_id, count(*) as calls from tree t
      join knowledge_agent_run_attempts a on a.run_id=t.id and a.tenant_id=$1
      where a.status <> 'reused' and not exists (select 1 from knowledge_agent_run_usage u
        where u.attempt_id=a.id and u.run_id=a.run_id and u.tenant_id=$1 and u.estimated_cost_usd_micros is not null)
      group by t.root_id
    ), unreported as (
      select t.root_id, count(*) as members from tree t
      where not exists (select 1 from knowledge_agent_run_usage u where u.run_id=t.id and u.tenant_id=$1)
      group by t.root_id
    ), cohorts as (
      select r.provider, r.model, r.effort, r.mode, r.knowledge_reranking, r.route,
        count(*) as runs, count(*) filter (where r.status='approved') as approved,
        count(*) filter (where r.status='needs_review') as awaiting_review,
        count(*) filter (where r.status in ('failed','cancelled')) as failed_or_cancelled,
        count(*) filter (where r.outcome in ('fallback','unconfigured')) as router_fallbacks,
        count(*) filter (where r.blocked is not null) as ineligible,
        sum(c.recorded_cost) as recorded_cost_usd,
        coalesce(sum(m.calls), 0) as missing_or_unpriced_attempts,
        count(*) filter (where c.priced and m.root_id is null and u.root_id is null
          and r.status not in ('queued','running')) as fully_priced_finished_runs,
        avg(c.recorded_cost) filter (where c.priced and m.root_id is null and u.root_id is null
          and r.status not in ('queued','running')) as mean_cost_per_priced_finished_run_usd,
        avg(extract(epoch from (r.finished_at-r.started_at))*1000) as mean_duration_ms,
        percentile_cont(0.95) within group (order by extract(epoch from (r.finished_at-r.started_at))*1000) as p95_duration_ms,
        count(e.evaluation) as evaluated_runs,
        avg((e.evaluation->>'correctness')::numeric) as mean_correctness,
        count(*) filter (where e.evaluation->>'rework' in ('major','unusable')) as major_rework_runs
      from roots r left join costs c on c.root_id=r.id left join missing m on m.root_id=r.id
      left join unreported u on u.root_id=r.id
      left join lateral (select a.evaluation from knowledge_agent_run_approvals a
        where a.run_id=r.id and a.tenant_id=$1 and a.evaluation is not null
        order by a.created_at desc, a.id desc limit 1) e on true
      group by r.provider, r.model, r.effort, r.mode, r.knowledge_reranking, r.route
    ), phases as (
      select a.phase, a.provider, count(*) as attempts,
        count(*) filter (where a.status='failed') as failures,
        count(*) filter (where a.status <> 'reused' and u.estimated_cost_usd_micros is null) as missing_or_unpriced_attempts,
        sum(u.estimated_cost_usd_micros)::numeric / 1000000 as recorded_cost_usd,
        avg(extract(epoch from (a.completed_at-a.started_at))*1000) as mean_duration_ms
      from tree t join knowledge_agent_run_attempts a on a.run_id=t.id and a.tenant_id=$1
      left join knowledge_agent_run_usage u on u.attempt_id=a.id and u.run_id=a.run_id and u.tenant_id=$1
      group by a.phase, a.provider
    ) select jsonb_build_object('cohorts', coalesce((select jsonb_agg(c) from cohorts c), '[]'),
      'phases', coalesce((select jsonb_agg(p) from phases p), '[]')) as report
  `, [tenant, project, since]);
  console.log(JSON.stringify({ since, ...rows[0].report,
    caveat: "Observed cohorts, not causal savings. Costs include recorded run/child calls only, exclude source processing/title generation/hosting, and remain partial where usage is missing. Human ratings are not objective accuracy." }, null, 2));
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
