import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AgentAnalyticsMember, AgentUsageAnalytics, ProjectAgentAnalytics } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { agentRuns, agentRunUsage, agentRunAttempts, supervisorRuns } from "./schema";
import { summarizeUsageRows } from "./usage";

/** Page coordinators, not children: a run's complete tree is always kept together. */
export async function projectAgentAnalytics(d: AppDeps, projectId: string, page: number): Promise<ProjectAgentAnalytics> {
  const roots = await d.db.select({ id: agentRuns.id, supervisorId: supervisorRuns.runId })
    .from(agentRuns)
    .leftJoin(supervisorRuns, and(eq(supervisorRuns.runId, agentRuns.id), eq(supervisorRuns.tenantId, d.tenantId)))
    .where(and(eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.projectId, projectId), isNull(agentRuns.parentRunId)))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(21).offset(page * 20);
  const pageRoots = roots.slice(0, 20) as { id: string; supervisorId: string | null }[];
  if (!pageRoots.length) return { runs: [], hasMore: false };
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
