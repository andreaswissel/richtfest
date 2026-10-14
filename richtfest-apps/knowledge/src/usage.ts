import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { AppDeps, ProviderResult, ProviderTelemetry, ProviderUsage } from "./deps";
import { sanitizeProviderDiagnostics } from "./deps";
import { agentRunAttempts, agentRunEvents, agentRuns, agentRunUsage, supervisorRuns } from "./schema";
import { recordStep, savedStep, stepHash } from "./run-steps";
import { classifyRunFailure } from "./run-reasons";

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

/** Root plus children, across every phase. Callers lock the root before reserving. */
export async function runAccounting(d: AppDeps, rootId: string, authorizedAt?: string, tx = d.db) {
  const group = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(
    eq(agentRuns.tenantId, d.tenantId), or(eq(agentRuns.id, rootId), eq(agentRuns.parentRunId, rootId)),
  ));
  const ids = group.map((r: any) => r.id);
  if (!ids.length) throw new Error("Run unavailable");
  const attempts = await tx.select().from(agentRunAttempts).where(and(eq(agentRunAttempts.tenantId, d.tenantId), inArray(agentRunAttempts.runId, ids)));
  const usage = await tx.select().from(agentRunUsage).where(and(eq(agentRunUsage.tenantId, d.tenantId), inArray(agentRunUsage.runId, ids)));
  const since = authorizedAt ? new Date(authorizedAt).getTime() : 0;
  const windowUsage = usage.filter((u: any) => u.startedAt.getTime() >= since);
  const windowAttempts = attempts.filter((a: any) => a.startedAt.getTime() >= since);
  const priced = new Set(windowUsage.filter((u: any) => u.estimatedCostUsd != null).map((u: any) => u.attemptId));
  const unknown = (a: any) => !["reused", "unconfigured"].includes(a.status) && a.settings?.budgetRejected !== true &&
    !usage.some((u: any) => u.attemptId === a.id && u.estimatedCostUsd != null);
  return {
    recordedCostUsd: usage.reduce((n: number, u: any) => n + Number(u.estimatedCostUsd ?? 0), 0) / 1e6,
    windowCostUsd: windowUsage.reduce((n: number, u: any) => n + Number(u.estimatedCostUsd ?? 0), 0) / 1e6,
    reservedCostUsd: windowAttempts.filter((a: any) => !priced.has(a.id) && a.status !== "reused")
      .reduce((n: number, a: any) => n + Number(a.settings?.reservedCostUsd ?? 0), 0),
    automaticRetries: windowAttempts.filter((a: any) => a.attemptNumber > 1 && a.settings?.budgetAuthorization === authorizedAt && a.settings?.budgetRejected !== true).length,
    unknownOutcomes: attempts.filter((a: any) => a.status === "running" || a.status === "interrupted").length,
    unpricedAttempts: attempts.filter(unknown).length,
    windowUnpricedAttempts: windowAttempts.filter((a: any) => a.status !== "running" && unknown(a)).length,
    unpricedUsage: windowUsage.filter((u: any) => u.estimatedCostUsd == null).length,
  };
}

/** Close bookkeeping, not the provider outcome. Root must be locked by the caller. */
export async function interruptProviderAttempts(d: AppDeps, tx: any, rootId: string, reason: string) {
  const group = await tx.select().from(agentRuns).where(and(eq(agentRuns.tenantId, d.tenantId),
    or(eq(agentRuns.id, rootId), eq(agentRuns.parentRunId, rootId))));
  const rows = await tx.update(agentRunAttempts).set({ status: "interrupted", completedAt: new Date(), failureCategory: "execution",
    usageStatus: sql`case when ${agentRunAttempts.usageStatus}='reported' then 'reported' else 'missing' end`,
    response: sql`coalesce(${agentRunAttempts.response}, '{}'::jsonb) || '{"outcome":"unknown"}'::jsonb`,
  }).where(and(eq(agentRunAttempts.tenantId, d.tenantId), inArray(agentRunAttempts.runId, group.map((r: any) => r.id)),
    eq(agentRunAttempts.status, "running"))).returning();
  for (const attempt of rows) {
    const owner = group.find((r: any) => r.id === attempt.runId);
    await d.auditRun(tx, "knowledge.agent_run.attempt_interrupted", "agent_run_attempt", attempt.id, owner.id, owner.correlationId,
      { reason, providerOutcome: "unknown", usageStatus: attempt.usageStatus });
  }
  return rows.length;
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
  invocation: { phase: string; operationId?: string; attemptNumber?: number; generation?: number; rootRunId?: string; leaseToken?: string; assertActive?: () => Promise<void> },
  execute: (telemetry: ProviderTelemetry) => Promise<ProviderResult>,
): Promise<ProviderResult> {
  const [attempt] = await d.db.transaction(async (tx: any) => {
    const rows = await tx.insert(agentRunAttempts).values({
      tenantId: d.tenantId, runId: run.id, provider: run.provider,
      phase: invocation.phase, generation: invocation.generation,
      operationId: invocation.operationId ?? crypto.randomUUID(),
      attemptNumber: invocation.attemptNumber ?? 1,
      settings: invocation.leaseToken ? { leaseToken: invocation.leaseToken } : undefined,
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
  let response: Parameters<NonNullable<ProviderTelemetry["onResponse"]>>[0] | undefined;
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
      const finished = await tx.update(agentRunAttempts).set({
        status, failureCategory, providerStatus, completedAt: new Date(),
        usageStatus: reusedFromStepId ? "not_applicable" : usageReported ? "reported" : "missing",
      }).where(and(where, eq(agentRunAttempts.status, "running"))).returning({ id: agentRunAttempts.id });
      // An old worker may report usage, but cannot turn an interrupted attempt
      // into a successful reusable step after its owner has been replaced.
      if (!finished.length) return;
      await d.auditRun(tx, "knowledge.agent_run.attempt_finished", "agent_run_attempt", attempt.id, run.id, run.correlationId, {
        status, failureCategory, providerStatus, usageStatus: reusedFromStepId ? "not_applicable" : usageReported ? "reported" : "missing",
      });
      if (prepared || failureCategory) await recordStep(d, tx, run, {
        kind: "model", stepKey: invocation.phase, generation: invocation.generation ?? 0,
        attemptId: attempt.id, inputHash: inputHash || stepHash({ settings }),
        input: { ...prepared, settings }, output, status, reusedFromStepId,
      });
      if (failureCategory && status !== "cancelled") await tx.insert(agentRunEvents).values({
        tenantId: d.tenantId, runId: run.id, eventType: "provider_attempt_failed",
        paramsSummary: JSON.stringify({ runId: run.id, callId: attempt.operationId, attempt: attempt.attemptNumber,
          attemptId: attempt.id, providerStatus,
          diagnostics: sanitizeProviderDiagnostics((output as { failure?: { diagnostics?: unknown } })?.failure?.diagnostics) }),
        resultSummary: invocation.phase,
      });
    });
  try {
    const result = await execute({
      onRequest: async (value) => { settings = value; await d.db.update(agentRunAttempts).set({ settings: { ...settings, leaseToken: invocation.leaseToken } }).where(and(where, eq(agentRunAttempts.status, "running"))); },
      onResponse: async (value) => { response = value; await d.db.update(agentRunAttempts).set({ response: sql`coalesce(${agentRunAttempts.response}, '{}'::jsonb) || ${JSON.stringify(response)}::jsonb` }).where(where); },
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
        if (invocation.rootRunId) {
          const rejection = await d.db.transaction(async (tx: any) => {
            const [root] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, invocation.rootRunId!), eq(agentRuns.tenantId, d.tenantId))).for("update");
            const [state] = await tx.select().from(supervisorRuns).where(eq(supervisorRuns.runId, invocation.rootRunId!));
            if (root?.status !== "running" || (invocation.leaseToken && state?.leaseToken !== invocation.leaseToken))
              throw Object.assign(new Error("Execution ownership changed"), { code: "outcome_unknown" });
            const budget = root.modelPolicy?.runBudget;
            if (!budget) return;
            const totals = await runAccounting(d, root.id, budget.authorizedAt, tx);
            const reservedCostUsd = settings && d.estimateCallCost?.(run.provider as ProviderUsage["provider"], settings,
              input.inputBytes ?? Buffer.byteLength(JSON.stringify(input), "utf8"), Array.isArray(input.tools) && input.tools.length > 0);
            const reason = reservedCostUsd == null || !Number.isFinite(reservedCostUsd) || reservedCostUsd < 0 ? "unpriced_call"
              : totals.windowUnpricedAttempts || totals.unpricedUsage ? "unknown_usage"
              : attempt.attemptNumber > 1 && totals.automaticRetries >= budget.maxAutomaticRetries ? "retry_allowance"
              : totals.windowCostUsd + totals.reservedCostUsd + reservedCostUsd > budget.maxCostUsd ? "spend_allowance" : undefined;
            await tx.update(agentRunAttempts).set({ settings: { ...settings, leaseToken: invocation.leaseToken,
              ...(reason ? { budgetRejected: true } : { reservedCostUsd, budgetAuthorization: budget.authorizedAt }),
            } }).where(where);
            await d.auditRun(tx, reason ? "knowledge.agent_run.budget_stopped" : "knowledge.agent_run.budget_reserved", "agent_run_attempt", attempt.id,
              root.id, root.correlationId, { reason, reservedCostUsd, budget });
            return reason;
          });
          if (rejection) throw Object.assign(new Error("Execution allowance requires human review"), { code: "budget_exhausted" });
        }
      },
    });
    if (result.status === "completed" && result.usage && !usageRecorded) await onUsage(result.usage);
    await invocation.assertActive?.();
    await finish(reusedFromStepId ? "reused" : result.status, null, null, result.status === "completed" ? result.output : undefined);
    return result;
  } catch (error) {
    // Never persist exception messages or objects, including nested SDK errors.
    const metadata = error as { code?: unknown; failureCategory?: unknown; providerStatus?: unknown; diagnostics?: unknown } | null;
    const cancelled = metadata?.code === "cancelled";
    const category = cancelled ? "cancellation" : metadata?.code === "timeout" ? "timeout" :
      ["provider", "validation", "permission", "timeout"].includes(String(metadata?.failureCategory))
        ? String(metadata?.failureCategory) : classifyRunFailure(error, "execution");
    const status = typeof metadata?.providerStatus === "number" && Number.isInteger(metadata.providerStatus)
      && metadata.providerStatus >= 100 && metadata.providerStatus <= 599 ? metadata.providerStatus : null;
    // A failed step is never reusable. Retain structural failure evidence even
    // when the adapter failed before preparing a prompt; never the rejected body.
    const diagnostics = { ...sanitizeProviderDiagnostics({ finishReason: response?.finishReason }),
      ...sanitizeProviderDiagnostics(metadata?.diagnostics) };
    const failureLog = { tenantId: d.tenantId, runId: run.id, attemptId: attempt.id, operationId: attempt.operationId,
      phase: invocation.phase, attempt: attempt.attemptNumber, provider: run.provider, modelId: settings?.modelId,
      category, providerStatus: status, diagnostics };
    if (!cancelled) console.error(JSON.stringify({ event: "agent_provider_failure", ...failureLog }));
    await finish(cancelled ? "cancelled" : "failed", category, status,
      { failure: { category, providerStatus: status, diagnostics } }).catch(() => {
        // Keep the original error and correlation IDs even during a database outage.
        console.error(JSON.stringify({ event: "agent_failure_persistence_failed", ...failureLog }));
      });
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
