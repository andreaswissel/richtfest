import { and, eq, inArray } from "drizzle-orm";
import type { AppDeps, ProviderResult, ProviderTelemetry, ProviderUsage } from "./deps";
import { agentRunAttempts, agentRuns, agentRunUsage } from "./schema";
import { recordStep, savedStep, stepHash } from "./run-steps";

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
  attemptId?: string,
) {
  if (!usage) return null;
  const estimatedCostMicros = usage.estimatedCostUsd == null ? null : Math.round(usage.estimatedCostUsd * 1_000_000);
  return d.db.transaction(async (tx: any) => {
    // Serialize call indices when multiple review slices finish together.
    await tx.select({ id: agentRuns.id }).from(agentRuns)
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.tenantId, d.tenantId))).for("update");
    const prior = await tx
      .select({ id: agentRunUsage.id })
      .from(agentRunUsage)
      .where(and(eq(agentRunUsage.runId, run.id), eq(agentRunUsage.tenantId, d.tenantId)));
    const [row] = await tx.insert(agentRunUsage).values({
      tenantId: d.tenantId,
      runId: run.id,
      attemptId,
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
      attemptId,
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

/** One durable attempt per invocation, including failures without provider usage. */
export async function executeTrackedProvider(
  d: AppDeps,
  run: { id: string; provider: string; correlationId: string },
  invocation: { phase: string; operationId?: string; attemptNumber?: number; generation?: number; assertActive?: () => Promise<void> },
  execute: (telemetry: ProviderTelemetry) => Promise<ProviderResult>,
): Promise<ProviderResult> {
  const [attempt] = await d.db.transaction(async (tx: any) => {
    const rows = await tx.insert(agentRunAttempts).values({
      tenantId: d.tenantId, runId: run.id, provider: run.provider,
      phase: invocation.phase, generation: invocation.generation,
      operationId: invocation.operationId ?? crypto.randomUUID(),
      attemptNumber: invocation.attemptNumber ?? 1,
    }).returning();
    await d.auditRun(tx, "knowledge.agent_run.attempt_started", "agent_run_attempt", rows[0].id, run.id, run.correlationId, {
      phase: invocation.phase, attemptNumber: rows[0].attemptNumber,
    });
    return rows;
  });
  const where = and(eq(agentRunAttempts.id, attempt.id), eq(agentRunAttempts.tenantId, d.tenantId));
  let usageRecorded = false;
  let usageReported = false;
  let settings: Parameters<NonNullable<ProviderTelemetry["onRequest"]>>[0] | undefined;
  let prepared: Parameters<NonNullable<ProviderTelemetry["onPrepared"]>>[0] | undefined;
  let inputHash = "";
  let reusedFromStepId: string | undefined;
  const onUsage: NonNullable<ProviderTelemetry["onUsage"]> = async (usage) => {
    if (usageRecorded) return;
    await recordProviderUsage(d, run, usage, attempt.startedAt, new Date(), attempt.id);
    usageRecorded = true;
    usageReported = [usage.inputTokens, usage.outputTokens, usage.totalTokens].some(value => value != null);
    await d.db.update(agentRunAttempts).set({ usageStatus: usageReported ? "reported" : "missing" }).where(where);
  };
  const finish = (status: string, failureCategory: string | null = null, providerStatus: number | null = null, output?: unknown) =>
    d.db.transaction(async (tx: any) => {
      await tx.update(agentRunAttempts).set({
        status, failureCategory, providerStatus, completedAt: new Date(),
        usageStatus: reusedFromStepId ? "not_applicable" : usageReported ? "reported" : "missing",
      }).where(where);
      await d.auditRun(tx, "knowledge.agent_run.attempt_finished", "agent_run_attempt", attempt.id, run.id, run.correlationId, {
        status, failureCategory, providerStatus, usageStatus: reusedFromStepId ? "not_applicable" : usageReported ? "reported" : "missing",
      });
      if (prepared) await recordStep(d, tx, run, {
        kind: "model", stepKey: invocation.phase, generation: invocation.generation ?? 0,
        attemptId: attempt.id, inputHash, input: { ...prepared, settings }, output, status, reusedFromStepId,
      });
    });
  try {
    const result = await execute({
      onRequest: async (value) => { settings = value; await d.db.update(agentRunAttempts).set({ settings }).where(where); },
      onResponse: async (response) => { await d.db.update(agentRunAttempts).set({ response }).where(where); },
      onUsage,
      onPrepared: async (input) => {
        await invocation.assertActive?.();
        prepared = input;
        // Effective settings include prompt/instruction/schema hashes and adapter/app versions.
        // Never key by redacted text alone: different secrets may redact to the same string.
        inputHash = stepHash({ provider: run.provider, settings });
        const saved = settings ? await savedStep(d, run.id, "model", invocation.phase, inputHash) : undefined;
        await d.db.transaction((tx: any) => recordStep(d, tx, run, {
          kind: "model", stepKey: invocation.phase, generation: invocation.generation ?? 0,
          attemptId: attempt.id, inputHash, input: { ...input, settings }, status: "started",
        }));
        if (saved) {
          reusedFromStepId = saved.id;
          return { output: saved.output };
        }
      },
    });
    await invocation.assertActive?.();
    if (result.status === "completed" && result.usage && !usageRecorded) await onUsage(result.usage);
    await finish(reusedFromStepId ? "reused" : result.status, null, null, result.status === "completed" ? result.output : undefined);
    return result;
  } catch (error) {
    // Never persist exception messages or objects, including nested SDK errors.
    const metadata = error as { code?: unknown; failureCategory?: unknown; providerStatus?: unknown } | null;
    const cancelled = metadata?.code === "cancelled";
    const category = cancelled ? "cancellation" : metadata?.code === "timeout" ? "timeout" :
      ["provider", "validation", "permission", "timeout"].includes(String(metadata?.failureCategory))
        ? String(metadata?.failureCategory) : "execution";
    const status = typeof metadata?.providerStatus === "number" && Number.isInteger(metadata.providerStatus)
      && metadata.providerStatus >= 100 && metadata.providerStatus <= 599 ? metadata.providerStatus : null;
    await finish(cancelled ? "cancelled" : "failed", category, status).catch(() => undefined);
    throw error;
  }
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
