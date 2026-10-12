import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AgentAnalyticsMember, AgentUsageAnalytics, ProjectAgentAnalytics } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { agentRuns, agentRunUsage, agentRunAttempts, supervisorRuns } from "./schema";
import { summarizeUsageRows } from "./usage";

/** Page coordinators, not children: a run's complete tree is always kept together. */
export async function projectAgentAnalytics(d: AppDeps, projectId: string, page: number): Promise<ProjectAgentAnalytics> {
  const [roots, projectTotals] = await Promise.all([d.db.select({ id: agentRuns.id, supervisorId: supervisorRuns.runId })
    .from(agentRuns)
    .leftJoin(supervisorRuns, and(eq(supervisorRuns.runId, agentRuns.id), eq(supervisorRuns.tenantId, d.tenantId)))
    .where(and(eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.projectId, projectId), isNull(agentRuns.parentRunId)))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(21).offset(page * 20),
    // Aggregate in Postgres: project KPIs must not depend on the visible page or
    // transfer every historical usage record to the API/browser.
    d.db.execute(sql`
      with recursive tree as (
        select id, id as root_id, status from knowledge_agent_runs
        where tenant_id=${d.tenantId} and project_id=${projectId} and parent_run_id is null
        union
        select child.id, tree.root_id, child.status from knowledge_agent_runs child
        join tree on child.parent_run_id=tree.id
        where child.tenant_id=${d.tenantId} and child.project_id=${projectId}
      ), usage as (
        select u.* from knowledge_agent_run_usage u join tree on tree.id=u.run_id
        where u.tenant_id=${d.tenantId}
      ), missing_attempts as (
        select a.run_id, count(*) as count from knowledge_agent_run_attempts a
        join tree on tree.id=a.run_id
        where a.tenant_id=${d.tenantId} and not exists (
          select 1 from usage u where u.attempt_id=a.id and u.run_id=a.run_id
            and u.input_tokens is not null and u.output_tokens is not null
        ) group by a.run_id
      ), agent_totals as (
        select run_id, bool_and(input_tokens is not null and output_tokens is not null) as complete,
          sum(input_tokens::bigint + output_tokens::bigint) as tokens
        from usage group by run_id
      ), root_totals as (
        select tree.root_id,
          bool_and(tree.status not in ('queued', 'running')) as inactive,
          bool_and(coalesce(agent_totals.complete, false) and coalesce(missing_attempts.count, 0)=0) as complete,
          sum(agent_totals.tokens) as tokens,
          sum(coalesce(missing_attempts.count, 0)) as missing,
          count(*) filter (where agent_totals.run_id is null) as unreported
        from tree left join agent_totals on agent_totals.run_id=tree.id
        left join missing_attempts on missing_attempts.run_id=tree.id
        group by tree.root_id
      ), model_totals as (
        select provider, model_id as "modelId", grouping(provider)=1 as "isTotal",
          count(*) as "callCount", sum(input_tokens) as "inputTokens", sum(output_tokens) as "outputTokens",
          sum(coalesce(input_tokens::bigint, 0) + coalesce(output_tokens::bigint, 0))
            filter (where input_tokens is not null or output_tokens is not null) as "totalTokens",
          sum(reasoning_tokens) as "reasoningTokens", sum(cached_input_tokens) as "cachedInputTokens",
          sum(estimated_cost_usd_micros)::numeric / 1000000 as "recordedCostUsd",
          count(*) filter (where estimated_cost_usd_micros is null) as "unpricedCalls",
          count(*) filter (where input_tokens is null or output_tokens is null) as "incompleteTokenCalls"
        from usage group by grouping sets ((provider, model_id), ())
      )
      select jsonb_build_object(
        'runCount', count(*),
        'averageTokensPerRun', avg(tokens) filter (where complete and inactive),
        'averagedRunCount', count(*) filter (where complete and inactive),
        'missingUsageAttempts', coalesce(sum(missing), 0),
        'unreportedRuns', coalesce(sum(unreported), 0),
        'usage', (select to_jsonb(m) - 'provider' - 'modelId' - 'isTotal' from model_totals m where "isTotal"),
        'models', coalesce((select jsonb_agg(to_jsonb(m) - 'isTotal' order by "totalTokens" desc nulls last, provider, "modelId")
          from model_totals m where not "isTotal"), '[]'::jsonb)
      ) as summary from root_totals
    `),
  ]);
  const summary = projectTotals.rows[0].summary as ProjectAgentAnalytics["summary"];
  const pageRoots = roots.slice(0, 20) as { id: string; supervisorId: string | null }[];
  if (!pageRoots.length) return { summary, runs: [], hasMore: false };
  // UNION (not UNION ALL) also prevents a malformed cycle from revisiting a node.
  // Both sides are scoped: lineage never authorizes cross-project/tenant access.
  const tree = await d.db.execute(sql`
    with recursive tree as (
      select id, id as root_id from knowledge_agent_runs
      where tenant_id=${d.tenantId} and project_id=${projectId}
        and id in (${sql.join(pageRoots.map(run => sql`${run.id}::uuid`), sql`, `)})
      union
      select child.id, tree.root_id from knowledge_agent_runs child
      join tree on child.parent_run_id=tree.id
      where child.tenant_id=${d.tenantId} and child.project_id=${projectId}
    )
    select r.id, tree.root_id as "rootId", r.parent_run_id as "parentRunId",
      r.goal, r.specialist_role as "specialistRole", r.status,
      r.created_at as "createdAt", r.started_at as "startedAt", r.finished_at as "finishedAt"
    from tree join knowledge_agent_runs r on r.id=tree.id
    order by r.created_at, r.id
  `);
  const members = tree.rows as (Omit<AgentAnalyticsMember, "usage"> & { rootId: string })[];
  const ids = members.map(run => run.id);
  const [usageRows, attempts] = await Promise.all([
    d.db.select().from(agentRunUsage).where(and(eq(agentRunUsage.tenantId, d.tenantId), inArray(agentRunUsage.runId, ids))),
    d.db.select({ id: agentRunAttempts.id, runId: agentRunAttempts.runId }).from(agentRunAttempts)
      .where(and(eq(agentRunAttempts.tenantId, d.tenantId), inArray(agentRunAttempts.runId, ids))),
  ]);
  const usageByRun = new Map<string, (typeof agentRunUsage.$inferSelect)[]>();
  const attemptsByRun = new Map<string, { id: string; runId: string }[]>();
  for (const row of usageRows) {
    if (!usageByRun.has(row.runId)) usageByRun.set(row.runId, []);
    usageByRun.get(row.runId)!.push(row);
  }
  for (const attempt of attempts) {
    if (!attemptsByRun.has(attempt.runId)) attemptsByRun.set(attempt.runId, []);
    attemptsByRun.get(attempt.runId)!.push(attempt);
  }
  const summarize = (runIds: string[]): AgentUsageAnalytics => {
    const rows = runIds.flatMap(id => usageByRun.get(id) ?? []);
    const calls = runIds.flatMap(id => attemptsByRun.get(id) ?? []);
    const reported = new Set(rows.filter(row => row.inputTokens !== null && row.outputTokens !== null).map(row => row.attemptId));
    const missingUsageAttempts = calls.filter(call => !reported.has(call.id)).length;
    const unreportedRuns = runIds.filter(id => !usageByRun.get(id)?.length).length;
    const summary = summarizeUsageRows(rows);
    const priced = rows.filter(row => row.estimatedCostUsd !== null);
    return {
      callCount: rows.length, attemptCount: calls.length, missingUsageAttempts, unreportedRuns,
      unpricedCalls: rows.length - priced.length,
      inputTokens: summary.inputTokens, outputTokens: summary.outputTokens,
      reasoningTokens: summary.reasoningTokens, cachedInputTokens: summary.cachedInputTokens,
      estimatedCostUsd: missingUsageAttempts || unreportedRuns ? null : summary.estimatedCostUsd,
      recordedCostUsd: priced.length ? priced.reduce((sum, row) => sum + Number(row.estimatedCostUsd), 0) / 1_000_000 : null,
      models: [...new Set(rows.map(row => `${row.provider} / ${row.modelId ?? "—"}`))].sort(),
    };
  };
  return {
    summary,
    hasMore: roots.length > 20,
    runs: pageRoots.map(root => {
      const descendants = members.filter(member => member.rootId === root.id);
      const enriched = descendants.map(({ rootId: _, ...member }) => ({ ...member, usage: summarize([member.id]) }));
      return {
        ...enriched.find(member => member.id === root.id)!,
        isSupervisor: root.supervisorId !== null,
        aggregate: summarize(descendants.map(member => member.id)),
        members: enriched,
      };
    }),
  };
}
