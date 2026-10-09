import { and, eq, inArray } from "drizzle-orm";
import type { AppDeps, ProviderUsage } from "./deps";
import { agentRunUsage } from "./schema";

export function summarizeUsageRows(rows: any[]) {
  const sum = (key: string) => rows.length > 0 && rows.every((row) => row[key] !== null && row[key] !== undefined)
    ? rows.reduce((total, row) => total + Number(row[key]), 0)
    : null;
  const costsKnown = rows.length > 0 && rows.every((row) => row.estimatedCostUsd !== null && row.estimatedCostUsd !== undefined);
  return {
    callCount: rows.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("reasoningTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    totalTokens: sum("totalTokens"),
    estimatedCostUsd: costsKnown ? rows.reduce((total, row) => total + Number(row.estimatedCostUsd ?? 0), 0) / 1_000_000 : null,
    pricingVersions: [...new Set(rows.map((row) => row.pricingVersion).filter(Boolean))],
  };
}

export async function recordProviderUsage(
  d: AppDeps,
  run: { id: string; tenantId?: string; provider: string; correlationId: string },
  usage: ProviderUsage | undefined,
  startedAt: Date,
  completedAt = new Date(),
) {
  if (!usage) return null;
  const estimatedCostMicros = usage.estimatedCostUsd == null ? null : Math.round(usage.estimatedCostUsd * 1_000_000);
  return d.db.transaction(async (tx: any) => {
    const prior = await tx
      .select({ id: agentRunUsage.id })
      .from(agentRunUsage)
      .where(and(eq(agentRunUsage.runId, run.id), eq(agentRunUsage.tenantId, d.tenantId)));
    const [row] = await tx.insert(agentRunUsage).values({
      tenantId: d.tenantId,
      runId: run.id,
      callIndex: prior.length,
      provider: usage.provider,
      modelId: usage.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cachedInputTokens: usage.cachedInputTokens,
      totalTokens: usage.totalTokens,
      estimatedCostUsd: estimatedCostMicros,
      pricingVersion: usage.pricingVersion ?? null,
      startedAt,
      completedAt,
    }).returning();
    await d.auditRun(tx, "knowledge.agent_run.usage_recorded", "agent_run_usage", row.id, run.id, run.correlationId, {
      callIndex: row.callIndex,
      modelId: row.modelId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      cachedInputTokens: row.cachedInputTokens,
      totalTokens: row.totalTokens,
      estimatedCostUsd: usage.estimatedCostUsd ?? null,
      pricingVersion: row.pricingVersion,
    });
    return row;
  });
}

export async function attachUsageSummaries(d: AppDeps, runs: any[]) {
  if (!runs.length) return runs;
  const rows = await d.db.select().from(agentRunUsage).where(and(eq(agentRunUsage.tenantId, d.tenantId), inArray(agentRunUsage.runId, runs.map((run) => run.id))));
  const byRun = new Map<string, any[]>();
  for (const row of rows) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
  return runs.map((run) => {
    const ownRows = byRun.get(run.id) ?? [];
    const childRows = runs.filter((child) => child.parentRunId === run.id).flatMap((child) => byRun.get(child.id) ?? []);
    const own = summarizeUsageRows(ownRows);
    const aggregate = summarizeUsageRows([...ownRows, ...childRows]);
    return { ...run, usage: { ...own, own, aggregate } };
  });
}
