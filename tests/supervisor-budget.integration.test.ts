import { expect, spyOn, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { agentRuns, supervisorRuns, tasks, agentRunEvents, agentRunUsage, agentRunAttempts, agentRunSteps } from "../richtfest-apps/knowledge/src/schema";
import { createSupervisor, stepSupervisor } from "../richtfest-apps/knowledge/src/supervisor";
import { runsRouter } from "../richtfest-apps/knowledge/src/runs";
import { executeTrackedProvider, recordProviderUsage } from "../richtfest-apps/knowledge/src/usage";

const integration = process.env.DATABASE_URL ? test : test.skip;
const config = { modelId: "test-model", maxOutputTokens: 1024, maxSteps: 1 };
const costs: Record<string, number> = { plan: 0.01, A: 0.07, B: 0.04, C: 0.03 };
const usage = (cost: number | null) => ({ provider: "openai", modelId: "test-model", inputTokens: 100, outputTokens: 10,
  totalTokens: 110, reasoningTokens: 0, cachedInputTokens: 0, estimatedCostUsd: cost, pricingVersion: "test" });
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
async function waitFor(condition: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 300; i++) { if (await condition()) return; await Bun.sleep(10); }
  throw new Error("Expected durable dispatch progress was not reached");
}
async function fixture(options: { maxCostUsd?: number; maxAutomaticRetries?: number; maxParallel?: number; goals?: string[]; stepAccounting?: boolean } = {}) {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const dispatched: string[] = [];
  const releases: (() => void)[] = [];
  const pending: Promise<unknown>[] = [];
  let behavior: (input: any, key: string) => Promise<any> = async (_input, key) => ({ status: "completed", output: {
    summary: `Saved ${key}`, rationale: "Bounded test evidence", citations: [],
  } });
  const policy = { provider: "openai", effort: "medium", version: 1, source: "vendor", supervisor: config,
    specialists: { source_reviewer: config, requirements_reviewer: config }, maxParallel: options.maxParallel ?? 2,
    maxTasks: 4, maxRevisions: 2, runBudget: { maxCostUsd: options.maxCostUsd ?? 1,
      maxAutomaticRetries: options.maxAutomaticRetries ?? 1, authorizedAt: new Date().toISOString() } };
  const d: any = { db, tenantId, actorId, supervisorEnabled: true, requirePermission: () => {}, auditRun: async () => {},
    audit: async () => {}, cancelExecution: () => {},
    validateProject: async (id: string) => id === projectId, providerConfigured: async () => false,
    listProjectSources: async () => ({ sources: [], truncated: false }),
    estimateCallCost: (_provider: string, settings: any) => costs[settings.modelId],
    executeSupervisor: async (input: any) => {
      const key = input.phase === "plan" ? "plan" : input.goal;
      await input.onRequest({ modelId: key, maxOutputTokens: 1024, maxSteps: options.stepAccounting ? 3 : 1,
        ...(options.stepAccounting ? { stepAccounting: "per-model-dispatch-v1" } : {}),
        promptHash: `${key}-${input.context.outputValidationFeedback ? "retry" : "initial"}` });
      const saved = await input.onPrepared({ version: 1, instructions: "Test only", prompt: JSON.stringify(input.context) });
      if (saved) return { status: "completed", output: saved.output };
      if (options.stepAccounting) await input.onBeforeModelStep({ ordinal: 1, inputBytes: 1234, hasMedia: false });
      // This is the network boundary: a rejected reservation must never reach it.
      dispatched.push(key);
      if (key === "plan") {
        if (options.stepAccounting) await input.onModelStepSettled({ ordinal: 1, usage: usage(costs.plan!) });
        else await input.onUsage(usage(costs.plan!));
        return { status: "completed", output: { tasks: (options.goals ?? ["A", "B"]).map(goal => ({ role: "source_reviewer", goal, sourceVersionIds: [] })) } };
      }
      return behavior(input, key);
    } };
  const [run] = await db.insert(agentRuns).values({ tenantId, projectId, requestedBy: actorId, goal: "Budget regression",
    provider: "openai", correlationId: crypto.randomUUID(), modelPolicy: policy }).returning();
  await createSupervisor(d, db, run, "medium", policy);
  const server = express().use(express.json()).use(runsRouter(() => d)).listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${run!.id}${path}`,
    body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { db, d, run: run!, dispatched, releases, pending, request,
    setBehavior: (fn: typeof behavior) => { behavior = fn; },
    state: async () => (await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id)))[0]!,
    attempts: () => db.select().from(agentRunAttempts).where(eq(agentRunAttempts.tenantId, tenantId)),
    async close() {
      releases.forEach(release => release());
      await Promise.allSettled(pending);
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const table of [agentRunSteps, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
        await db.delete(table).where(eq(table.tenantId, tenantId));
      await pool.end();
    } };
}

for (const settlesCheaply of [true, false]) integration(`pending sibling reservations wait and recheck actual cost: ${settlesCheaply}`, async () => {
  const f = await fixture({ maxCostUsd: 0.10 });
  const hold = gate(); f.releases.push(hold.resolve);
  f.setBehavior(async (input, key) => { await hold.promise; await input.onUsage(usage(settlesCheaply ? 0.02 : costs[key]!));
    return { status: "completed", output: { summary: `Saved ${key}`, rationale: "", citations: [] } }; });
  try {
    // An unavailable optional classifier never dispatched and is not unknown spend.
    await f.db.insert(agentRunAttempts).values({ tenantId: f.d.tenantId, runId: f.run.id, provider: "typesafe",
      phase: "decision", operationId: crypto.randomUUID(), attemptNumber: 1, generation: 0,
      status: "unconfigured", usageStatus: "missing", completedAt: new Date() });
    await stepSupervisor(f.d, f.run.id);
    const work = stepSupervisor(f.d, f.run.id); f.pending.push(work);
    await waitFor(async () => (await f.attempts()).some(a => (a.settings as any)?.budgetDecision?.state === "waiting"));
    expect(f.dispatched.filter(key => key !== "plan")).toHaveLength(1);
    const active = (await f.attempts()).filter(a => a.status === "running");
    expect(active).toHaveLength(2);
    const waiting = active.find(a => (a.settings as any).dispatchPending)!;
    expect(waiting.attemptNumber).toBe(1);
    expect((waiting.settings as any).reservedCostUsd).toBeUndefined();
    const reserved = (active.find(a => !(a.settings as any).dispatchPending)!.settings as any).reservedCostUsd;
    expect([0.07, 0.04]).toContain(reserved);
    expect(reserved + 0.01 + costs[f.dispatched.includes("A") ? "B" : "A"]!).toBeGreaterThan(0.10);
    hold.resolve(); await work;
    expect(f.dispatched).toHaveLength(settlesCheaply ? 3 : 2);
    const settled = (await f.attempts()).find(a => a.id === waiting.id)!;
    expect(settled.status).toBe(settlesCheaply ? "completed" : "failed");
    expect(settled.usageStatus).toBe(settlesCheaply ? "reported" : "not_applicable");
    expect((await f.attempts()).filter(a => a.phase === "specialist")).toHaveLength(2);
    const preview = (await f.request("/recovery").then(r => r.json()) as any).data;
    expect(preview.accounting.automaticRetries).toBe(0);
    expect(preview.accounting.unpricedAttempts).toBe(0);
    expect(preview.resumable).toBe(!settlesCheaply);
    if (!settlesCheaply) expect(preview.budgetDecision).toMatchObject({ state: "stopped", reason: "spend_allowance", limitUsd: 0.1 });
  } finally { await f.close(); }
});

for (const action of ["cancel", "lease_loss", "expire"] as const)
integration(`waiting reservations are bounded and not dispatched after ${action}`, async () => {
  const f = await fixture({ maxCostUsd: 0.10 });
  const hold = gate(); f.releases.push(hold.resolve);
  f.setBehavior(async (input, key) => { await hold.promise; await input.onUsage(usage(0.02));
    return { status: "completed", output: { summary: `Saved ${key}`, rationale: "", citations: [] } }; });
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    await stepSupervisor(f.d, f.run.id);
    const work = stepSupervisor(f.d, f.run.id); f.pending.push(work);
    await waitFor(async () => (await f.attempts()).some(a => (a.settings as any)?.budgetDecision?.state === "waiting"));
    const waiting = (await f.attempts()).find(a => (a.settings as any)?.budgetDecision?.state === "waiting")!;
    if (action === "cancel") expect((await f.request("/cancel", {})).status).toBe(201);
    else if (action === "lease_loss") {
      await f.db.update(supervisorRuns).set({ leaseUntil: new Date(0) }).where(eq(supervisorRuns.runId, f.run.id));
      await stepSupervisor(f.d, f.run.id);
    } else {
      const future = Date.now() + 600001;
      await f.db.update(supervisorRuns).set({ leaseUntil: new Date(future + 120000) }).where(eq(supervisorRuns.runId, f.run.id));
      clock = spyOn(Date, "now").mockReturnValue(future);
    }
    await waitFor(async () => (await f.attempts()).find(a => a.id === waiting.id)?.status !== "running");
    clock?.mockRestore(); clock = undefined;
    hold.resolve(); await work;
    expect(f.dispatched).toHaveLength(2);
    const settled = (await f.attempts()).find(a => a.id === waiting.id)!;
    expect(settled.usageStatus).toBe("not_applicable");
    if (action === "expire") expect((settled.settings as any).budgetDecision.reason).toBe("wait_expired");
    else expect((settled.response as any).outcome).toBe("not_dispatched");
  } finally { clock?.mockRestore(); await f.close(); }
});

integration("a legacy fresh-run retry keeps its models but cannot inherit an unbounded or old allowance", async () => {
  const f = await fixture({ maxCostUsd: 87 });
  try {
    await f.db.update(agentRuns).set({ status: "failed" }).where(eq(agentRuns.id, f.run.id));
    await f.db.update(supervisorRuns).set({ phase: "done" }).where(eq(supervisorRuns.runId, f.run.id));
    const response = await f.request("/retry", {});
    expect(response.status).toBe(201);
    const created = (await response.json() as any).data;
    expect(created.id).not.toBe(f.run.id);
    expect(created.modelPolicy.supervisor).toEqual(config);
    expect(created.modelPolicy.runBudget).toMatchObject({ maxCostUsd: 10, maxAutomaticRetries: 3 });
    expect(created.modelPolicy.runBudget.authorizedAt).not.toBe((f.run.modelPolicy as any).runBudget.authorizedAt);
    expect((await f.state()).modelPolicy).toEqual(f.run.modelPolicy);
    expect(f.dispatched).toEqual([]);
  } finally { await f.close(); }
});

integration("nested decision admission never waits on its parent reservation", async () => {
  const f = await fixture({ maxCostUsd: 0.1, goals: ["A"] });
  let nestedDispatches = 0;
  f.setBehavior(async (input) => {
    const state = await f.state();
    await expect(executeTrackedProvider(f.d, { ...f.run, provider: "typesafe" },
      { phase: "decision", rootRunId: f.run.id, leaseToken: state.leaseToken!, generation: 0 }, async telemetry => {
        await telemetry.onRequest?.({ modelId: "B" } as any);
        await telemetry.onPrepared?.({ version: 1, instructions: "", prompt: "Nested search ranking" });
        nestedDispatches++;
        return { status: "completed", output: {} };
      })).rejects.toMatchObject({ code: "budget_exhausted" });
    await input.onUsage(usage(0.02));
    return { status: "completed", output: { summary: "Saved with deterministic search fallback", rationale: "", citations: [] } };
  });
  try {
    await stepSupervisor(f.d, f.run.id); await stepSupervisor(f.d, f.run.id);
    expect(nestedDispatches).toBe(0);
    expect((await f.attempts()).find(a => a.phase === "decision")?.settings).toMatchObject({
      budgetDecision: { state: "stopped", reason: "nested_reservation" }, dispatchPending: true,
    });
    expect((await f.state()).phase).toBe("review");
  } finally { await f.close(); }
});

integration("automatic retry allowance spans distinct specialist operations", async () => {
  const f = await fixture({ maxParallel: 1, maxAutomaticRetries: 1 });
  const counts = new Map<string, number>();
  f.setBehavior(async (input, key) => {
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    await input.onUsage(usage(costs[key]!));
    if (count === 1) throw Object.assign(new Error("Test validation failure"), { providerFailure: true, retryable: true, failureCategory: "validation" });
    return { status: "completed", output: { summary: `Saved ${key}`, rationale: "", citations: [] } };
  });
  try {
    await stepSupervisor(f.d, f.run.id); await stepSupervisor(f.d, f.run.id);
    expect(counts.get("A")).toBe(2); expect(counts.get("B")).toBe(1);
    const preview = (await (await f.request("/recovery")).json() as any).data;
    expect(preview.accounting.automaticRetries).toBe(1);
    expect(preview.completedSpecialists).toBe(1);
    expect(preview.resumable).toBe(true);
  } finally { await f.close(); }
}, 15000);

for (const mode of ["missing", "unpriced"] as const) integration(`${mode} usage stops subsequent automatic dispatch`, async () => {
  const f = await fixture({ maxParallel: 1 });
  f.setBehavior(async (input, key) => {
    if (mode === "unpriced") await input.onUsage(usage(null));
    return { status: "completed", output: { summary: `Saved ${key}`, rationale: "", citations: [] } };
  });
  try {
    await stepSupervisor(f.d, f.run.id); await stepSupervisor(f.d, f.run.id);
    expect(f.dispatched).toEqual(["plan", "A"]);
    const preview = (await (await f.request("/recovery")).json() as any).data;
    expect(preview.resumable).toBe(true);
    expect(preview.accounting.unpricedAttempts).toBe(1);
    expect(preview.accounting.unpricedUsage).toBe(mode === "unpriced" ? 1 : 0);
    await stepSupervisor(f.d, f.run.id); expect(f.dispatched).toHaveLength(2);
  } finally { await f.close(); }
});

integration("expired and null leases reconcile orphan attempts and fence late results", async () => {
  for (const leaseUntil of [new Date(0), null]) {
    const f = await fixture({ goals: ["A"] });
    const hold = gate(); f.releases.push(hold.resolve);
    f.setBehavior(async () => { await hold.promise; return { status: "completed", usage: usage(0.07),
      output: { summary: "Late result must not replace checkpoint", rationale: "", citations: [] } }; });
    try {
      await stepSupervisor(f.d, f.run.id);
      const old = stepSupervisor(f.d, f.run.id); f.pending.push(old);
      await waitFor(() => f.dispatched.includes("A"));
      await f.db.update(supervisorRuns).set({ leaseToken: leaseUntil ? crypto.randomUUID() : null, leaseUntil }).where(eq(supervisorRuns.runId, f.run.id));
      await stepSupervisor(f.d, f.run.id);
      const orphan = (await f.attempts()).find(a => a.phase === "specialist")!;
      expect(orphan.status).toBe("interrupted");
      expect((orphan.response as any).outcome).toBe("unknown");
      expect(f.dispatched).toEqual(["plan", "A"]);
      hold.resolve(); await old;
      const settled = (await f.attempts()).find(a => a.id === orphan.id)!;
      expect(settled.status).toBe("interrupted");
      expect(settled.usageStatus).toBe("reported");
      expect((await f.state()).assignments.every((a: any) => !a.output)).toBe(true);
      const steps = await f.db.select().from(agentRunSteps).where(eq(agentRunSteps.attemptId, orphan.id));
      expect(steps.some(s => s.status === "completed")).toBe(false);
    } finally { await f.close(); }
  }
}, 15000);

integration("recovery preview is scoped/read-only and authorizes additional allowance against a fresh acknowledged checkpoint", async () => {
  const f = await fixture({ maxParallel: 1, goals: ["A", "B", "C"] });
  f.setBehavior(async (input, key) => {
    if (key === "A") await input.onUsage(usage(0.07));
    return { status: "completed", output: { summary: `Saved ${key}`, rationale: "", citations: [] } };
  });
  try {
    await stepSupervisor(f.d, f.run.id); await stepSupervisor(f.d, f.run.id);
    // Two checkpoints exist; missing B usage stopped C at its dispatch boundary.
    const before = await f.state(), attempts = await f.attempts();
    const preview = (await (await f.request("/recovery")).json() as any).data;
    expect(preview.resumable).toBe(true);
    expect(preview.completedSpecialists).toBe(2);
    expect((await (await f.request("/recovery")).json() as any).data).toEqual(preview);
    expect(await f.state()).toEqual(before); expect(await f.attempts()).toEqual(attempts);
    const tenant = f.d.tenantId; f.d.tenantId = crypto.randomUUID();
    expect((await f.request("/recovery")).status).toBe(404); f.d.tenantId = tenant;
    f.d.validateProject = async () => false;
    expect((await f.request("/recovery")).status).toBe(404);
    f.d.validateProject = async (id: string) => id === f.run.projectId;
    const body = { checkpointHash: preview.checkpointHash, generation: preview.generation,
      budget: { maxCostUsd: 0.13, maxAutomaticRetries: 2 }, acknowledgeUnknownOutcomes: true };
    expect((await f.request("/retry", { ...body, acknowledgeUnknownOutcomes: false })).status).toBe(409);
    await f.db.update(supervisorRuns).set({ steering: "New checkpoint direction" }).where(eq(supervisorRuns.runId, f.run.id));
    expect((await f.request("/retry", body)).status).toBe(409);
    const fresh = (await (await f.request("/recovery")).json() as any).data;
    expect((await f.request("/retry", { ...body, checkpointHash: fresh.checkpointHash })).status).toBe(201);
    const after = await f.state();
    expect(after.generation).toBe(before.generation + 1);
    expect(after.assignments).toEqual(before.assignments); expect(after.review).toEqual(before.review);
    expect(after.phase).toBe(before.phase);
    expect((after.modelPolicy as any).runBudget).toMatchObject(body.budget);
    expect((after.modelPolicy as any).runBudget.authorizedAt).not.toBe((before.modelPolicy as any).runBudget.authorizedAt);
    const authorized = (await (await f.request("/recovery")).json() as any).data;
    expect(authorized.accounting.windowCostUsd).toBe(0);
    expect(authorized.accounting.recordedCostUsd).toBe(0.08);
    expect(f.dispatched).toEqual(["plan", "A", "B"]);
    f.setBehavior(async (input, key) => {
      await input.onUsage(usage(costs[key]!));
      return { status: "completed", output: { summary: `Saved ${key}`, rationale: "", citations: [] } };
    });
    await stepSupervisor(f.d, f.run.id);
    expect(f.dispatched).toEqual(["plan", "A", "B", "C"]);
    const resumed = (await (await f.request("/recovery")).json() as any).data;
    expect(resumed.accounting.windowCostUsd).toBe(0.03);
    expect(resumed.accounting.recordedCostUsd).toBe(0.11);
    expect(resumed.completedSpecialists).toBe(3);
  } finally { await f.close(); }
});

for (const mode of ["success", "denial", "unknown", "interruption", "retry"] as const)
integration(`per-model dispatch accounting through supervisor provider calls: ${mode}`, async () => {
  const f = await fixture({ stepAccounting: true, goals: ["A"], maxCostUsd: mode === "denial" ? 0.09 : 1 });
  let calls = 0, secondDispatches = 0;
  const estimates: any[] = [];
  f.d.estimateCallCost = (_provider: unknown, settings: any, bytes: number, hasTools: boolean, inputTokenUpperBound?: number) => {
    estimates.push({ maxSteps: settings.maxSteps, bytes, hasTools, inputTokenUpperBound }); return costs[settings.modelId];
  };
  f.setBehavior(async input => {
    calls++;
    await input.onModelStepSettled({ ordinal: 1, usage: { ...usage(0.02), cacheWriteInputTokens: 7 } });
    await input.onModelStepSettled({ ordinal: 1, usage: usage(0.99) }); // duplicate cannot inflate spend
    if (mode === "retry" && calls === 1) throw Object.assign(new Error("Test validation"),
      { providerFailure: true, retryable: true, failureCategory: "validation" });
    if (mode === "interruption") {
      await f.db.update(supervisorRuns).set({ leaseUntil: new Date(0) }).where(eq(supervisorRuns.runId, f.run.id));
      await stepSupervisor(f.d, f.run.id);
    }
    await input.onBeforeModelStep({ ordinal: 2, inputBytes: 2345, hasMedia: mode === "success", inputTokenUpperBound: 2100 });
    secondDispatches++;
    await input.onModelStepSettled({ ordinal: 2, usage: mode === "unknown" ? usage(null) : usage(0.03) });
    if (mode === "unknown") await input.onBeforeModelStep({ ordinal: 3, inputBytes: 3456, hasMedia: false });
    // Aggregate legacy telemetry must not price a known prefix or add a second row.
    await input.onUsage(usage(0.99));
    return { status: "completed", usage: usage(0.99), output: { summary: "Saved A", rationale: "", citations: [] } };
  });
  try {
    await stepSupervisor(f.d, f.run.id); await stepSupervisor(f.d, f.run.id);
    const specialists = (await f.attempts()).filter(a => a.phase === "specialist").sort((a, b) => a.attemptNumber - b.attemptNumber);
    expect(specialists).toHaveLength(mode === "retry" ? 2 : 1);
    const attempt = specialists.at(-1)!;
    const ledger = attempt.settings as any;
    expect(ledger.everDispatched).toBe(true);
    expect(ledger.stepReceipts[0].usage.cacheWriteInputTokens).toBe(7);
    expect(attempt.usageStatus).not.toBe("not_applicable");
    expect(secondDispatches).toBe(mode === "denial" || mode === "interruption" ? 0 : 1);
    const rows = await f.db.select().from(agentRunUsage).where(eq(agentRunUsage.attemptId, attempt.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.estimatedCostUsd).toBe(mode === "unknown" ? null : mode === "denial" || mode === "interruption" ? 20000 : 50000);
    if (mode === "unknown") {
      expect(ledger.reservedCostUsd).toBeCloseTo(0.09);
      expect(ledger.budgetDecision.reason).toBe("unknown_usage");
    }
    if (mode === "denial") {
      expect(ledger.budgetDecision).toMatchObject({ reason: "spend_allowance", recordedUsd: 0.03, reservedUsd: 0, requestedUsd: 0.07 });
      expect(ledger.nextStepInput).toEqual({ ordinal: 2, inputBytes: 2345, hasMedia: false, inputTokenUpperBound: 2100 });
    }
    if (mode === "interruption") {
      expect(attempt.status).toBe("interrupted");
      expect(attempt.usageStatus).toBe("reported");
    }
    if (mode === "retry") {
      const preview = (await (await f.request("/recovery")).json() as any).data;
      expect(preview.accounting.automaticRetries).toBe(1);
    }
    if (mode === "success") {
      await Promise.all([1, 2].map(() => recordProviderUsage(f.d, { ...f.run, id: attempt.runId }, usage(0.99), attempt.startedAt, new Date(), attempt.id)));
      expect(await f.db.select().from(agentRunUsage).where(eq(agentRunUsage.attemptId, attempt.id))).toHaveLength(1);
      expect(estimates).toContainEqual({ maxSteps: 1, bytes: 2345, hasTools: true, inputTokenUpperBound: 2100 });
      expect(ledger.stepReceipts[1].input).toEqual({ ordinal: 2, inputBytes: 2345, hasMedia: true, inputTokenUpperBound: 2100 });
    }
    expect(estimates).toContainEqual({ maxSteps: 1, bytes: 1234, hasTools: false, inputTokenUpperBound: undefined });
  } finally { await f.close(); }
}, 15000);

integration("step replacement releases only its own bound and still waits for a sibling", async () => {
  const f = await fixture({ stepAccounting: true, maxCostUsd: 0.13 });
  const hold = gate(), siblingStarted = gate(); f.releases.push(hold.resolve, siblingStarted.resolve);
  let secondDispatched = false;
  f.setBehavior(async (input, key) => {
    if (key === "B") {
      siblingStarted.resolve(); await hold.promise;
      await input.onModelStepSettled({ ordinal: 1, usage: usage(0.01) });
    } else {
      await siblingStarted.promise;
      await input.onModelStepSettled({ ordinal: 1, usage: usage(0.02) });
      await input.onBeforeModelStep({ ordinal: 2, inputBytes: 4567, hasMedia: false });
      secondDispatched = true;
      await input.onModelStepSettled({ ordinal: 2, usage: usage(0.02) });
    }
    return { status: "completed", output: { summary: `Saved ${key}`, rationale: "", citations: [] } };
  });
  try {
    await stepSupervisor(f.d, f.run.id);
    const work = stepSupervisor(f.d, f.run.id); f.pending.push(work);
    await waitFor(async () => (await f.attempts()).some(a => (a.settings as any)?.budgetDecision?.state === "waiting"));
    const waiting = (await f.attempts()).find(a => (a.settings as any)?.budgetDecision?.state === "waiting")!;
    expect(waiting.settings).toMatchObject({ everDispatched: true, settledCostUsd: 0.02, reservedCostUsd: 0.02,
      budgetDecision: { reason: "pending_reservations", reservedUsd: 0.04 } });
    expect(secondDispatched).toBe(false);
    hold.resolve(); await work;
    expect(secondDispatched).toBe(true);
    const rows = await f.db.select().from(agentRunUsage).where(eq(agentRunUsage.attemptId, waiting.id));
    expect(rows).toHaveLength(1); expect(rows[0]!.estimatedCostUsd).toBe(40000);
  } finally { await f.close(); }
}, 15000);
