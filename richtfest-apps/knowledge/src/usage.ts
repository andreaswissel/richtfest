import { and, eq, inArray, or, sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentBudgetDecision } from "@richtfest/shared";
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
export async function runAccounting(d: AppDeps, rootId: string, authorizedAt?: string, tx = d.db, excludeAttemptId?: string) {
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
  const dispatched = (a: any) => a.settings?.everDispatched === true || (a.settings?.everDispatched !== false && a.settings?.dispatchPending !== true);
  const unknown = (a: any) => !["reused", "unconfigured"].includes(a.status) && dispatched(a) &&
    !usage.some((u: any) => u.attemptId === a.id && u.estimatedCostUsd != null);
  return {
    recordedCostUsd: usage.reduce((n: number, u: any) => n + Number(u.estimatedCostUsd ?? 0), 0) / 1e6,
    windowCostUsd: windowUsage.reduce((n: number, u: any) => n + Number(u.estimatedCostUsd ?? 0), 0) / 1e6,
    committedCostUsd: windowAttempts.filter((a: any) => !priced.has(a.id))
      .reduce((n: number, a: any) => n + Number(a.settings?.settledCostUsd ?? 0), 0),
    reservedCostUsd: windowAttempts.filter((a: any) => a.id !== excludeAttemptId && !priced.has(a.id) && a.status !== "reused")
      .reduce((n: number, a: any) => n + Number(a.settings?.reservedCostUsd ?? 0), 0),
    automaticRetries: windowAttempts.filter((a: any) => a.attemptNumber > 1 && a.settings?.budgetAuthorization === authorizedAt && dispatched(a)).length,
    unknownOutcomes: attempts.filter((a: any) => dispatched(a) && (a.status === "running" || a.status === "interrupted")).length,
    unpricedAttempts: attempts.filter(unknown).length,
    windowUnpricedAttempts: windowAttempts.filter((a: any) => (a.status !== "running" ||
      a.settings?.stepReceipts?.some((r: any) => r.status === "unknown")) && unknown(a)).length,
    unpricedUsage: windowUsage.filter((u: any) => u.estimatedCostUsd == null).length,
  };
}

/** Close bookkeeping, not the provider outcome. Root must be locked by the caller. */
export async function interruptProviderAttempts(d: AppDeps, tx: any, rootId: string, reason: string) {
  const group = await tx.select().from(agentRuns).where(and(eq(agentRuns.tenantId, d.tenantId),
    or(eq(agentRuns.id, rootId), eq(agentRuns.parentRunId, rootId))));
  const rows = await tx.update(agentRunAttempts).set({
    status: sql`case when ${agentRunAttempts.settings}->>'dispatchPending'='true' and coalesce(${agentRunAttempts.settings}->>'everDispatched', 'false')!='true' then 'cancelled' else 'interrupted' end`,
    completedAt: new Date(), failureCategory: "execution",
    usageStatus: sql`case when ${agentRunAttempts.settings}->>'dispatchPending'='true' and coalesce(${agentRunAttempts.settings}->>'everDispatched', 'false')!='true' then 'not_applicable' when ${agentRunAttempts.usageStatus}='reported' then 'reported' else 'missing' end`,
    response: sql`coalesce(${agentRunAttempts.response}, '{}'::jsonb) || jsonb_build_object('outcome', case when ${agentRunAttempts.settings}->>'dispatchPending'='true' and coalesce(${agentRunAttempts.settings}->>'everDispatched', 'false')!='true' then 'not_dispatched' else 'unknown' end)`,
  }).where(and(eq(agentRunAttempts.tenantId, d.tenantId), inArray(agentRunAttempts.runId, group.map((r: any) => r.id)),
    eq(agentRunAttempts.status, "running"))).returning();
  for (const attempt of rows) {
    const owner = group.find((r: any) => r.id === attempt.runId);
    await d.auditRun(tx, "knowledge.agent_run.attempt_interrupted", "agent_run_attempt", attempt.id, owner.id, owner.correlationId,
      { reason, providerOutcome: attempt.response.outcome, usageStatus: attempt.usageStatus });
  }
  return rows.filter((attempt: any) => attempt.status === "interrupted").length;
}

export async function recordProviderUsage(
  d: AppDeps,
  run: { id: string; tenantId?: string; provider: string; correlationId: string },
  usage: ProviderUsage | undefined,
  startedAt: Date,
  completedAt = new Date(),
  attemptId?: string,
  transaction?: any,
) {
  if (!usage) return null;
  const estimatedCostMicros = usage.estimatedCostUsd == null ? null : Math.round(usage.estimatedCostUsd * 1_000_000);
  const write = async (tx: any) => {
    // Serialize call indices when multiple review slices finish together.
    await tx.select({ id: agentRuns.id }).from(agentRuns)
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.tenantId, d.tenantId))).for("update");
    const prior = await tx
      .select()
      .from(agentRunUsage)
      .where(and(eq(agentRunUsage.runId, run.id), eq(agentRunUsage.tenantId, d.tenantId)));
    if (attemptId) {
      const existing = prior.find((row: any) => row.attemptId === attemptId);
      if (existing) return existing;
    }
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
  };
  return transaction ? write(transaction) : d.db.transaction(write);
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
      settings: invocation.rootRunId ? { leaseToken: invocation.leaseToken, dispatchPending: true } : undefined,
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
  let dispatchPending = !!invocation.rootRunId;
  let everDispatched = false;
  let settledCostUsd = 0;
  let nextBoundUsd = 0;
  type Receipt = { ordinal: number; status: "in_flight" | "settled" | "unknown"; usage?: ProviderUsage };
  const receipts: Receipt[] = [];
  const stepAccounted = () => settings?.stepAccounting === "per-model-dispatch-v1";
  const ledger = () => stepAccounted() ? { everDispatched, settledCostUsd, nextBoundUsd, nextStepOrdinal: receipts.length + 1, stepReceipts: receipts,
    reservedCostUsd: settledCostUsd + (receipts.some(r => r.status !== "settled") ? nextBoundUsd : 0) } : {};
  const aggregateUsage = (): ProviderUsage | undefined => {
    if (!receipts.length) return;
    const known = receipts.every(r => r.status === "settled" && r.usage?.estimatedCostUsd != null);
    const sum = (key: "inputTokens" | "outputTokens" | "reasoningTokens" | "cachedInputTokens" | "totalTokens") =>
      receipts.every(r => r.usage?.[key] != null) ? receipts.reduce((n, r) => n + r.usage![key]!, 0) : null;
    return { provider: run.provider as ProviderUsage["provider"], modelId: settings?.modelId ?? null,
      inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), reasoningTokens: sum("reasoningTokens"),
      cachedInputTokens: sum("cachedInputTokens"), totalTokens: sum("totalTokens"),
      estimatedCostUsd: known ? settledCostUsd : null,
      pricingVersion: receipts.every(r => r.usage?.pricingVersion === receipts[0].usage?.pricingVersion) ? receipts[0].usage?.pricingVersion : null };
  };
  const onUsage: NonNullable<ProviderTelemetry["onUsage"]> = async (usage) => {
    if (stepAccounted()) return;
    if (usageRecorded) return;
    await recordProviderUsage(d, run, usage, attempt.startedAt, new Date(), attempt.id);
    usageRecorded = true;
    usageReported = [usage.inputTokens, usage.outputTokens, usage.totalTokens].some(value => value != null);
    await d.db.update(agentRunAttempts).set({ usageStatus: usageReported ? "reported" : "missing" }).where(where);
  };
  const finish = async (status: string, failureCategory: string | null = null, providerStatus: number | null = null, output?: unknown) => {
    return d.db.transaction(async (tx: any) => {
      if (stepAccounted() && everDispatched) {
        await tx.select().from(agentRuns).where(and(eq(agentRuns.id, invocation.rootRunId ?? run.id), eq(agentRuns.tenantId, d.tenantId))).for("update");
        const [current] = await tx.select().from(agentRunAttempts).where(where).for("update");
        receipts.splice(0, receipts.length, ...(current.settings?.stepReceipts ?? []));
        settledCostUsd = current.settings?.settledCostUsd ?? 0;
        await recordProviderUsage(d, run, aggregateUsage(), attempt.startedAt, new Date(), attempt.id, tx);
        usageReported = receipts.length > 0 && receipts.every(r => r.status === "settled" && r.usage?.estimatedCostUsd != null);
        // Late usage may close accounting, never restore an interrupted output.
        await tx.update(agentRunAttempts).set({ usageStatus: usageReported ? "reported" : "missing" }).where(where);
      }
      const finished = await tx.update(agentRunAttempts).set({
        status, failureCategory, providerStatus, completedAt: new Date(),
        usageStatus: reusedFromStepId || (dispatchPending && !everDispatched) ? "not_applicable" : usageReported ? "reported" : "missing",
      }).where(and(where, eq(agentRunAttempts.status, "running"))).returning({ id: agentRunAttempts.id });
      // An old worker may report usage, but cannot turn an interrupted attempt
      // into a successful reusable step after its owner has been replaced.
      if (!finished.length) return;
      await d.auditRun(tx, "knowledge.agent_run.attempt_finished", "agent_run_attempt", attempt.id, run.id, run.correlationId, {
        status, failureCategory, providerStatus, usageStatus: reusedFromStepId || (dispatchPending && !everDispatched) ? "not_applicable" : usageReported ? "reported" : "missing",
      });
      if (prepared || failureCategory) await recordStep(d, tx, run, {
        kind: "model", stepKey: invocation.phase, generation: invocation.generation ?? 0,
        attemptId: attempt.id, inputHash: inputHash || stepHash({ settings }),
        input: { ...prepared, settings }, output, status, reusedFromStepId,
      });
      if (failureCategory && failureCategory !== "budget" && status !== "cancelled") await tx.insert(agentRunEvents).values({
        tenantId: d.tenantId, runId: run.id, eventType: "provider_attempt_failed",
        paramsSummary: JSON.stringify({ runId: run.id, callId: attempt.operationId, attempt: attempt.attemptNumber,
          attemptId: attempt.id, providerStatus,
          diagnostics: sanitizeProviderDiagnostics((output as { failure?: { diagnostics?: unknown } })?.failure?.diagnostics) }),
        resultSummary: invocation.phase,
      });
    });
  };
  const prepareAndAdmit = async (input: NonNullable<Parameters<NonNullable<ProviderTelemetry["onPrepared"]>>[0]>, signal?: AbortSignal,
    modelStep?: { ordinal: number; inputBytes: number; hasMedia: boolean }) => {
        signal?.throwIfAborted();
        await invocation.assertActive?.();
        if (!modelStep) {
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
        if (stepAccounted()) return;
        }
        if (invocation.rootRunId) {
          const waitUntil = Date.now() + 600000;
          const estimate = settings && d.estimateCallCost?.(run.provider as ProviderUsage["provider"],
            modelStep ? { ...settings, maxSteps: 1 } : settings,
            modelStep?.inputBytes ?? input.inputBytes ?? Buffer.byteLength(JSON.stringify(input), "utf8"),
            modelStep ? modelStep.hasMedia : Array.isArray(input.tools) && input.tools.length > 0);
          const requestedUsd = estimate == null || !Number.isFinite(estimate) || estimate < 0 ? null : estimate;
          if (modelStep && receipts.every(r => r.status === "settled")) nextBoundUsd = requestedUsd ?? 0;
          let lastDecision = "";
          for (;;) {
            signal?.throwIfAborted();
            const decision = await d.db.transaction(async (tx: any) => {
              const [root] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, invocation.rootRunId!), eq(agentRuns.tenantId, d.tenantId))).for("update");
              const [state] = await tx.select().from(supervisorRuns).where(eq(supervisorRuns.runId, invocation.rootRunId!));
              const [current] = await tx.select().from(agentRunAttempts).where(where);
              if (root?.status !== "running" || current?.status !== "running" ||
                (invocation.generation !== undefined && state?.generation !== invocation.generation) || (invocation.leaseToken &&
                (state?.leaseToken !== invocation.leaseToken || !state.leaseUntil || state.leaseUntil.getTime() <= Date.now())))
                throw Object.assign(new Error("Execution ownership changed"), { code: "outcome_unknown" });
              const budget = root.modelPolicy?.runBudget;
              if (!budget) {
                if (modelStep && receipts.some(r => r.status !== "settled"))
                  throw Object.assign(new Error("Previous model step outcome is unknown"), { code: "budget_exhausted" });
                if (modelStep) { everDispatched = true; nextBoundUsd = requestedUsd ?? 0; receipts.push({ ordinal: modelStep.ordinal, status: "in_flight" }); }
                await tx.update(agentRunAttempts).set({ settings: { ...settings, ...ledger(), leaseToken: invocation.leaseToken,
                  dispatchPending: false, dispatchedAt: new Date().toISOString() } }).where(where);
                return;
              }
              const totals = await runAccounting(d, root.id, budget.authorizedAt, tx, attempt.id);
              const reason: AgentBudgetDecision["reason"] = requestedUsd === null ? "unpriced_call"
                : receipts.some(r => r.status !== "settled") || totals.windowUnpricedAttempts || totals.unpricedUsage ? "unknown_usage"
                : !everDispatched && attempt.attemptNumber > 1 && totals.automaticRetries >= budget.maxAutomaticRetries ? "retry_allowance"
                : totals.windowCostUsd + totals.committedCostUsd + requestedUsd > budget.maxCostUsd ? "spend_allowance"
                : totals.windowCostUsd + totals.reservedCostUsd + settledCostUsd + requestedUsd > budget.maxCostUsd
                  // A classifier/reranker may be inside a reserved model's tool
                  // call. Waiting there could deadlock on its own parent.
                  ? run.provider === "typesafe" ? "nested_reservation"
                    : Date.now() >= waitUntil ? "wait_expired" : "pending_reservations"
                  : null;
              const value: AgentBudgetDecision = { state: reason === "pending_reservations" ? "waiting" : reason ? "stopped" : "reserved",
                reason, limitUsd: budget.maxCostUsd, recordedUsd: totals.windowCostUsd + totals.committedCostUsd,
                reservedUsd: Math.max(0, totals.reservedCostUsd - (totals.committedCostUsd - settledCostUsd)),
                requestedUsd, retriesUsed: totals.automaticRetries, retryLimit: budget.maxAutomaticRetries };
              const fingerprint = JSON.stringify(value);
              if (fingerprint !== lastDecision) {
                if (modelStep && value.state === "reserved") {
                  everDispatched = true; nextBoundUsd = requestedUsd!;
                  receipts.push({ ordinal: modelStep.ordinal, status: "in_flight" });
                }
                await tx.update(agentRunAttempts).set({ settings: { ...current.settings, ...settings, leaseToken: invocation.leaseToken, budgetDecision: value,
                  dispatchPending: value.state !== "reserved",
                  ...(value.state === "stopped" ? { budgetRejected: true } : value.state === "reserved"
                    ? { reservedCostUsd: requestedUsd, budgetAuthorization: budget.authorizedAt, dispatchedAt: new Date().toISOString() } : {}),
                  ...ledger(),
                } }).where(where);
                await d.auditRun(tx, `knowledge.agent_run.budget_${value.state}`, "agent_run_attempt", attempt.id,
                  root.id, root.correlationId, { reason, reservedCostUsd: requestedUsd, budget, decision: value });
                const event = { tenantId: d.tenantId, eventType: `budget_${value.state}`, resultSummary: invocation.phase,
                  paramsSummary: JSON.stringify({ runId: run.id, callId: attempt.operationId, attempt: attempt.attemptNumber, attemptId: attempt.id, budget: value }) };
                await tx.insert(agentRunEvents).values([...new Set([root.id, run.id])].map(runId => ({ ...event, runId })));
              }
              return value;
            });
            if (decision?.state === "stopped") throw Object.assign(new Error("Execution allowance requires human review"), { code: "budget_exhausted" });
            if (decision?.state !== "waiting") { dispatchPending = false; break; }
            lastDecision = JSON.stringify(decision);
            await delay(500, undefined, { signal });
          }
        }
  };
  try {
    const result = await execute({
      onRequest: async (value) => { settings = value;
        const metadata = { ...settings, ...ledger(), leaseToken: invocation.leaseToken,
          ...(invocation.rootRunId ? { dispatchPending } : {}) };
        await d.db.update(agentRunAttempts).set({ settings: sql`coalesce(${agentRunAttempts.settings}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb` })
          .where(and(where, eq(agentRunAttempts.status, "running"))); },
      onResponse: async (value) => { response = value; await d.db.update(agentRunAttempts).set({ response: sql`coalesce(${agentRunAttempts.response}, '{}'::jsonb) || ${JSON.stringify(response)}::jsonb` }).where(where); },
      onUsage,
      onPrepared: (input, signal) => prepareAndAdmit(input, signal),
      onBeforeModelStep: async (input, signal) => {
        if (!stepAccounted() || reusedFromStepId || !prepared || !Number.isSafeInteger(input.inputBytes) || input.inputBytes < 0 ||
          input.ordinal !== receipts.length + 1 || input.ordinal > Math.min(settings!.maxSteps, 100))
          throw new Error("Invalid model step accounting contract");
        if (!invocation.rootRunId && receipts.some(r => r.status !== "settled"))
          throw Object.assign(new Error("Previous model step outcome is unknown"), { code: "budget_exhausted" });
        await prepareAndAdmit(prepared, signal, input);
        if (!invocation.rootRunId) {
          everDispatched = true; receipts.push({ ordinal: input.ordinal, status: "in_flight" });
          await d.db.update(agentRunAttempts).set({ settings: { ...settings, ...ledger() } }).where(where);
        }
      },
      onModelStepSettled: async ({ ordinal, usage }) => {
        await d.db.transaction(async (tx: any) => {
          await tx.select().from(agentRuns).where(and(eq(agentRuns.id, invocation.rootRunId ?? run.id), eq(agentRuns.tenantId, d.tenantId))).for("update");
          const [current] = await tx.select().from(agentRunAttempts).where(where).for("update");
          const receipt = receipts.find(r => r.ordinal === ordinal);
          if (!stepAccounted() || !receipt) throw new Error("Invalid model step settlement");
          const finalized = await tx.select({ id: agentRunUsage.id }).from(agentRunUsage).where(and(
            eq(agentRunUsage.tenantId, d.tenantId), eq(agentRunUsage.attemptId, attempt.id)));
          if (finalized.length) return;
          if (current.settings?.stepReceipts?.find((r: Receipt) => r.ordinal === ordinal)?.status !== "in_flight") return;
          const cost = usage?.estimatedCostUsd;
          const known = cost != null && Number.isFinite(cost) && cost >= 0;
          receipt.status = known ? "settled" : "unknown";
          receipt.usage = usage ? { provider: usage.provider, modelId: usage.modelId,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
            reasoningTokens: usage.reasoningTokens, cachedInputTokens: usage.cachedInputTokens,
            pricingVersion: usage.pricingVersion, estimatedCostUsd: known ? cost : null } : undefined;
          if (known) settledCostUsd += cost;
          dispatchPending = true;
          await tx.update(agentRunAttempts).set({ settings: { ...current.settings, ...ledger(), dispatchPending } }).where(where);
        });
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
