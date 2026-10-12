import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { and, eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import {
  artifactRevisions,
  artifacts,
  agentRuns,
  supervisorRuns,
  tasks,
  agentRunEvents,
  agentRunUsage,
  agentRunAttempts,
  conversations,
  messages,
} from "../richtfest-apps/knowledge/src/schema";
import {
  stepSupervisor,
  createSupervisor,
} from "../richtfest-apps/knowledge/src/supervisor";
import { workspaceRouter } from "../richtfest-apps/knowledge/src/workspace";
import { runsRouter } from "../richtfest-apps/knowledge/src/runs";
import { soundInsulationPlanningFixture as fixture } from "./fixtures/sound-insulation-planning";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";
const integration = process.env.DATABASE_URL ? test : test.skip;
const config = { modelId: "test-model", maxOutputTokens: 1024, maxSteps: 1 };
const policy = {
  provider: "openai" as const,
  effort: "medium" as const,
  version: 1,
  source: "vendor" as const,
  supervisor: config,
  specialists: { source_reviewer: config, requirements_reviewer: config },
  maxParallel: 2,
  maxTasks: 4,
  maxRevisions: 2,
};
integration("large specialist assignments preserve every UTF-8 source slice and resume checkpointed findings", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  // Oversized multi-byte text, a nearly full batch, several tiny files and an
  // unreadable file exercise byte and file-count boundaries independently.
  const evidence = ["A".repeat(49151) + "🧱ß", "ä🧱\n".repeat(9000),
    "First requirement", "Second requirement", "Third requirement", "Fourth requirement",
    "Fifth requirement", "Last requirement", null].map((text, index) => ({
      versionId: crypto.randomUUID(), name: `Source ${index + 1}`, text,
    }));
  let runId = "", interrupted = false;
  const accepted: any[] = [];
  const d = {
    db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async () => true,
    listProjectSources: async () => ({ sources: evidence, truncated: false }),
    resolveSource: async (_project: string, input: { versionId: string }) => {
      const source = evidence.find(item => item.versionId === input.versionId)!;
      return { status: "resolved", source, content: source.text === null
        ? { status: "unsupported", reason: "Export required" }
        : { status: "available", text: source.text, truncated: source.versionId === evidence[1]!.versionId } };
    },
    executeSupervisor: async (input: any) => {
      if (input.phase === "plan") return { status: "completed", output: { tasks: [
        { role: "requirements_reviewer", goal: "Read every source", sourceVersionIds: evidence.map(source => source.versionId) },
      ] } };
      const context = input.context;
      if (context.sourceCoverage.batch === 2 && !interrupted) {
        interrupted = true;
        // Simulate a worker losing its lease after one saved batch. Its late
        // response must not be checkpointed, and the next worker must resume.
        await db.update(supervisorRuns).set({ leaseToken: null, leaseUntil: null }).where(eq(supervisorRuns.runId, runId));
        return { status: "completed", output: { summary: "Discard this late response", rationale: "", citations: [] } };
      }
      accepted.push(context);
      return { status: "completed", output: {
        summary: `Accumulated through batch ${context.sourceCoverage.batch}`,
        rationale: "Source 9 is unreadable; export required.",
        // Deliberately omit earlier citations: the checkpoint must retain them.
        citations: context.sourceVersionIds,
      } };
    },
  } as unknown as AppDeps;
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Batched evidence", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    runId = run!.id;
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, runId);
    await stepSupervisor(d, runId);
    const [checkpoint] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
    expect(checkpoint!.phase).toBe("specialists");
    expect((checkpoint!.assignments as any[])[0].sourceProgress.completedBatches).toBe(1);
    await stepSupervisor(d, runId);
    const [completed] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
    expect(completed!.phase).toBe("review");
    expect(accepted.length).toBeGreaterThan(3);
    expect(accepted.map(item => item.sourceCoverage.batch)).toEqual(accepted.map((_, index) => index + 1));
    for (const [index, context] of accepted.entries()) {
      expect(context.sources.length).toBeLessThanOrEqual(3);
      expect(context.sources.reduce((sum: number, source: any) => sum + Buffer.byteLength(source.text), 0)).toBeLessThanOrEqual(49152);
      expect(context.unreadableSources).toEqual([{ name: "Source 9", reason: "Export required" }]);
      expect(context.sourceVersionIds).not.toContain(evidence[8]!.versionId);
      if (index) expect(context.previousFindings.summary).toBe(`Accumulated through batch ${index}`);
      else expect(context.previousFindings).toBeUndefined();
    }
    for (const source of evidence.filter(item => item.text !== null)) {
      const slices = accepted.flatMap(context => context.sources).filter(item => item.versionId === source.versionId);
      expect(slices.map(item => item.text).join("")).toBe(source.text!);
      let offset = 0;
      for (const slice of slices) {
        expect(slice.textRange).toEqual({ startByte: offset, endByte: offset + Buffer.byteLength(slice.text), totalBytes: Buffer.byteLength(source.text!) });
        expect(slice.extractionTruncated).toBe(source.versionId === evidence[1]!.versionId);
        offset = slice.textRange.endByte;
        if (slices.length > 1) expect(slice.truncated).toBe(true);
      }
    }
    const assignment = (completed!.assignments as any[])[0];
    expect(assignment.output.summary).toBe(`Accumulated through batch ${accepted.length}`);
    expect(assignment.output.citations).toEqual(evidence.slice(0, 8).map(source => source.versionId));
    expect(assignment.sourceProgress).toBeUndefined();
    expect(JSON.stringify(completed)).not.toContain("Discard this late response");
    // A new extraction of the immutable file cannot inherit an older text
    // checkpoint, even when the version IDs are unchanged.
    evidence[0]!.text += "\nNewly recovered OCR line.";
    await db.update(supervisorRuns).set({ phase: "specialists", assignments: checkpoint!.assignments }).where(eq(supervisorRuns.runId, runId));
    const beforeChangedExtraction = accepted.length;
    await stepSupervisor(d, runId);
    expect(accepted[beforeChangedExtraction].sourceCoverage.batch).toBe(1);
    expect(accepted[beforeChangedExtraction].previousFindings).toBeUndefined();
    expect(accepted.slice(beforeChangedExtraction).flatMap(context => context.sources)
      .filter(source => source.versionId === evidence[0]!.versionId).map(source => source.text).join("")).toBe(evidence[0]!.text!);
    // Being assigned a version is not permission to cite it before its batch
    // was read. The last readable source is absent from the first batch.
    const invalidDeps: AppDeps = { ...d, executeSupervisor: async input => input.phase === "plan"
      ? d.executeSupervisor!(input)
      : { status: "completed", output: { summary: "Unsupported future citation", rationale: "", citations: [evidence[7]!.versionId] } } };
    const [invalid] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Reject unread evidence", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(invalidDeps, db, invalid, "medium", policy);
    await stepSupervisor(invalidDeps, invalid!.id);
    await stepSupervisor(invalidDeps, invalid!.id);
    const [rejected] = await db.select().from(agentRuns).where(eq(agentRuns.id, invalid!.id));
    expect(rejected!.status).toBe("failed");
    const [rejectedState] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, invalid!.id));
    expect((rejectedState!.assignments as any[])[0].sourceProgress).toBeUndefined();
    expect((rejectedState!.assignments as any[])[0].output).toBeUndefined();
  } finally {
    for (const table of [agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});
integration("specialist timeouts stop unchanged retries and preserve completed siblings", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const d = {
    db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, listProjectSources: async () => ({ sources: [], truncated: false }),
    executeSupervisor: async (input: any) => {
      if (input.phase === "plan") return { status: "completed", output: { tasks: [
        { role: "source_reviewer", goal: "Completes", sourceVersionIds: [] },
        { role: "requirements_reviewer", goal: "Times out", sourceVersionIds: [] },
      ] } };
      if (input.goal === "Completes") return { status: "completed", output: { summary: "Saved evidence", rationale: "", citations: [] } };
      // Even a retryable wrapper must not restart a deadline-limited request.
      throw Object.assign(new Error("sk-secret timeout body"), { code: "timeout", providerFailure: true, retryable: true });
    },
  } as unknown as AppDeps;
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Timeout regression", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", { ...policy, maxParallel: 1 });
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    const [parent] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(parent!.status).toBe("failed");
    expect(parent!.error).toContain("phase=specialist; category=timeout;");
    expect(parent!.error).toContain("Increase the call timeout in Agent model settings and start a new run");
    const children = await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, run!.id));
    expect(children.find(child => child.goal === "Completes")).toMatchObject({ status: "needs_review", outputSummary: "Saved evidence" });
    const failed = children.find(child => child.goal === "Times out")!;
    expect(failed.error).toContain("category=timeout");
    const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, failed.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: "failed", failureCategory: "timeout", usageStatus: "missing" });
    const events = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, run!.id));
    expect(events.some(event => event.eventType === "provider_call_retrying")).toBe(false);
    expect(JSON.stringify([parent, children, attempts, events])).not.toContain("sk-secret");
  } finally {
    for (const table of [agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});
integration("specialist costs belong to each child while the supervisor retains the total", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const d = {
    db, tenantId, actorId,
    requirePermission: () => {},
    validateProject: async () => true,
    auditRun: async () => {},
    listProjectSources: async () => ({ sources: [], truncated: false, authority: "unreviewed_source_inventory" }),
    executeSupervisor: async (input) => {
      await input.onUsage?.({
        provider: "openai", modelId: "test-model",
        inputTokens: 1000, outputTokens: 100, totalTokens: 1100,
        reasoningTokens: 0, cachedInputTokens: 0,
        estimatedCostUsd: input.phase === "plan" ? 0.01 : input.goal === "Review A" ? 0.02 : 0.03,
        pricingVersion: "test",
      });
      return {
        status: "completed",
        output: input.phase === "plan"
          ? { tasks: [
              { role: "source_reviewer", goal: "Review A", sourceVersionIds: [] },
              { role: "requirements_reviewer", goal: "Review B", sourceVersionIds: [] },
            ] }
          : { summary: "Reviewed", rationale: "No sources supplied", citations: [] },
      };
    },
  } as AppDeps;
  let server: any;
  try {
    const [parent] = await db.insert(agentRuns).values({
      tenantId, projectId, requestedBy: actorId,
      goal: "Review project", provider: "openai", correlationId: crypto.randomUUID(),
    }).returning();
    await createSupervisor(d, db, parent, "medium", policy);
    await stepSupervisor(d, parent!.id);
    await stepSupervisor(d, parent!.id);
    server = express()
      .use("/api/knowledge", workspaceRouter(() => d))
      .use("/api/knowledge", runsRouter(() => d))
      .listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/knowledge`;
    const workspace = await (await fetch(`${baseUrl}/workspaces/${projectId}`)).json() as any;
    const parentUsage = workspace.data.runs.find((run: any) => run.id === parent!.id).usage;
    expect(parentUsage.own.callCount).toBe(1);
    expect(parentUsage.own.estimatedCostUsd).toBe(0.01);
    expect(parentUsage.aggregate.callCount).toBe(3);
    expect(parentUsage.aggregate.estimatedCostUsd).toBe(0.06);
    for (const [goal, cost] of [["Review A", 0.02], ["Review B", 0.03]] as const) {
      const child = workspace.data.runs.find((run: any) => run.goal === goal);
      expect(child.usage.callCount).toBe(1);
      expect(child.usage.estimatedCostUsd).toBe(cost);
      const detail = await (await fetch(`${baseUrl}/runs/${child.id}`)).json() as any;
      expect(detail.data.usage.estimatedCostUsd).toBe(cost);
      expect(detail.data.usage.calls).toHaveLength(1);
      expect(detail.data.usage.calls[0].runId).toBe(child.id);
    }
    const analytics = async (page = 0) => {
      const response = await fetch(`${baseUrl}/workspaces/${projectId}/analytics?page=${page}`);
      expect(response.status).toBe(200);
      return (await response.json() as any).data;
    };
    const initial = await analytics();
    expect(initial.runs[0].aggregate.estimatedCostUsd).toBe(0.06);
    expect(initial.runs[0].usage.estimatedCostUsd).toBe(0.01);
    expect(initial.runs[0].isSupervisor).toBe(true);
    expect(initial.runs[0].aggregate.missingUsageAttempts).toBe(0);
    expect(initial.summary.usage.totalTokens).toBe(3300);
    expect(initial.summary.averagedRunCount).toBe(0);
    expect(initial.summary.averageTokensPerRun).toBeNull();
    await db.update(agentRuns).set({ status: "needs_review" }).where(eq(agentRuns.id, parent!.id));
    expect((await analytics()).summary.averageTokensPerRun).toBe(3300);

    // An old grandchild must survive both the workspace's 50-row window and root pagination.
    const [grandchild] = await db.insert(agentRuns).values({
      tenantId, projectId, requestedBy: actorId, parentRunId: workspace.data.runs.find((run: any) => run.goal === "Review A").id,
      goal: "Nested review", status: "completed", provider: "openai", correlationId: crypto.randomUUID(), createdAt: new Date("2020-01-01"),
    }).returning();
    await db.insert(agentRunUsage).values({ tenantId, runId: grandchild!.id, provider: "openai", modelId: "nested-model",
      callIndex: 0, inputTokens: 77, outputTokens: 13, reasoningTokens: 5, cachedInputTokens: 23, estimatedCostUsd: 40000, startedAt: new Date(), completedAt: new Date() });
    const older = await db.insert(agentRuns).values(Array.from({ length: 51 }, (_, i) => ({
      tenantId, projectId, requestedBy: actorId, goal: `Older run ${i}`, provider: "openai", correlationId: crypto.randomUUID(), createdAt: new Date("2021-01-01"),
    }))).returning();
    await db.update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, older[0]!.id));
    await db.insert(agentRunUsage).values({ tenantId, runId: older[0]!.id, provider: "anthropic", modelId: "test-model",
      callIndex: 0, inputTokens: 100, outputTokens: 20, estimatedCostUsd: 10000, startedAt: new Date(), completedAt: new Date() });
    const foreignTenant = crypto.randomUUID(), foreignProject = crypto.randomUUID();
    const foreignIds = [crypto.randomUUID(), crypto.randomUUID()];
    try {
      await db.insert(agentRuns).values(foreignIds.map((id, i) => ({
        id, tenantId: i ? tenantId : foreignTenant, projectId: i ? foreignProject : projectId,
        requestedBy: actorId, parentRunId: parent!.id, goal: "Must not leak", provider: "openai", correlationId: crypto.randomUUID(),
      })));
      const first = await analytics();
      expect(first.runs).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.runs[0].members).toHaveLength(4);
      expect(first.runs[0].aggregate.estimatedCostUsd).toBe(0.10);
      expect(first.runs[0].aggregate.inputTokens).toBe(3077);
      expect(first.runs[0].aggregate.outputTokens).toBe(313);
      expect(first.runs[0].aggregate.callCount).toBe(4);
      expect(first.summary).toMatchObject({ runCount: 52, averagedRunCount: 2, averageTokensPerRun: 1755,
        unreportedRuns: 50, missingUsageAttempts: 0,
        usage: { inputTokens: 3177, outputTokens: 333, totalTokens: 3510, recordedCostUsd: 0.11, reasoningTokens: 5, cachedInputTokens: 23 } });
      expect(first.summary.models).toHaveLength(3);
      expect(first.summary.models.find((model: any) => model.provider === "anthropic")).toMatchObject({ modelId: "test-model", totalTokens: 120, recordedCostUsd: 0.01 });
      const second = await analytics(1), third = await analytics(2);
      expect(second.runs).toHaveLength(20);
      expect(third.runs).toHaveLength(12);
      expect(third.hasMore).toBe(false);
      expect(new Set([...first.runs, ...second.runs, ...third.runs].map((run: any) => run.id)).size).toBe(52);
      expect(second.summary).toEqual(first.summary);
      expect(third.summary).toEqual(first.summary);
      expect((await analytics(3)).summary).toEqual(first.summary);
      const emptyRun = second.runs.find((run: any) => run.id !== older[0]!.id);
      expect(emptyRun.aggregate.estimatedCostUsd).toBeNull();
      expect(emptyRun.aggregate.recordedCostUsd).toBeNull();

      await db.insert(agentRunAttempts).values({ tenantId, runId: grandchild!.id, operationId: crypto.randomUUID(), phase: "specialist", attemptNumber: 2, provider: "openai", status: "failed", usageStatus: "missing" });
      await db.insert(agentRunUsage).values({ tenantId, runId: grandchild!.id, provider: "openai", modelId: "unpriced-model",
        callIndex: 1, inputTokens: 11, outputTokens: 3, startedAt: new Date(), completedAt: new Date() });
      const partialData = await analytics();
      expect(partialData.summary).toMatchObject({ averagedRunCount: 1, averageTokensPerRun: 120, missingUsageAttempts: 1,
        usage: { totalTokens: 3524, recordedCostUsd: 0.11, unpricedCalls: 1 } });
      const partial = partialData.runs[0];
      expect(partial.aggregate.estimatedCostUsd).toBeNull();
      expect(partial.aggregate.recordedCostUsd).toBe(0.10);
      expect(partial.aggregate.missingUsageAttempts).toBe(1);
      expect(partial.aggregate.unpricedCalls).toBe(1);
      expect(partial.members.find((run: any) => run.id === grandchild!.id).usage.recordedCostUsd).toBe(0.04);
      // Unknown model and partially reported tokens remain visible, not zeroed or invented.
      await db.insert(agentRunUsage).values({ tenantId, runId: older[1]!.id, provider: "openai", modelId: null,
        callIndex: 0, inputTokens: 7, outputTokens: null, startedAt: new Date(), completedAt: new Date() });
      const unknown = (await analytics()).summary;
      expect(unknown.usage.totalTokens).toBe(3531);
      expect(unknown.usage.incompleteTokenCalls).toBe(1);
      expect(unknown.models.find((model: any) => model.modelId === null)).toMatchObject({ inputTokens: 7, outputTokens: null, totalTokens: 7, recordedCostUsd: null });
      await db.update(agentRunUsage).set({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }).where(eq(agentRunUsage.runId, older[0]!.id));
      const zero = (await analytics()).summary;
      expect(zero).toMatchObject({ averagedRunCount: 1, averageTokensPerRun: 0 });
      expect(zero.models.find((model: any) => model.provider === "anthropic")).toMatchObject({ totalTokens: 0, recordedCostUsd: 0 });
      const empty = await (await fetch(`${baseUrl}/workspaces/${crypto.randomUUID()}/analytics`)).json() as any;
      expect(empty.data.summary).toMatchObject({ runCount: 0, averagedRunCount: 0, averageTokensPerRun: null, models: [],
        usage: { totalTokens: null, recordedCostUsd: null, callCount: 0 } });
      expect((await fetch(`${baseUrl}/workspaces/${projectId}/analytics?page=-1`)).status).not.toBe(200);
      d.validateProject = async () => false;
      expect((await fetch(`${baseUrl}/workspaces/${projectId}/analytics`)).status).toBe(404);
      d.requirePermission = () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };
      expect((await fetch(`${baseUrl}/workspaces/${projectId}/analytics`)).status).toBe(403);
    } finally {
      for (const id of foreignIds) await db.delete(agentRuns).where(eq(agentRuns.id, id));
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(resolve));
    await db.delete(agentRunUsage).where(eq(agentRunUsage.tenantId, tenantId));
    await db.delete(agentRunAttempts).where(eq(agentRunAttempts.tenantId, tenantId));
    await db.delete(agentRunEvents).where(eq(agentRunEvents.tenantId, tenantId));
    await db.delete(supervisorRuns).where(eq(supervisorRuns.tenantId, tenantId));
    await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
    await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
    await pool.end();
  }
});
integration(
  "Bendenweg sound-insulation fixture reaches specialist review and a downloadable OpenUI PDF",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID(),
      inventoryVersionId = fixture.sources[0].versionId;
    const calls: { phase: string; goal: string; context: any }[] = [];
    let reviewCount = 0;
    let conversationId = "";
    let server: any;
    const d: AppDeps = {
      db,
      tenantId,
      actorId,
      supervisorEnabled: true,
      requirePermission: () => {},
      audit: async () => {},
      auditRun: async () => {},
      validateProject: async () => true,
      validateSource: async () => true,
      validateSourceVersion: async () => true,
      validateUser: async () => true,
      validateConversation: async () => true,
      cancelExecution: () => {},
      providerConfigured: async () => true,
      executeProvider: async () => ({ status: "unconfigured" }),
      sourceReferences: async (_projectId, versionIds) => fixture.sources
        .filter(source => versionIds.includes(source.versionId))
        .map(source => ({ versionId: source.versionId, fileName: source.name, version: 1 })),
      listProjectSources: async () => ({
        sources: [...fixture.sources],
        truncated: false,
        authority: "unreviewed_source_inventory",
      }),
      resolveSource: async (_projectId: string, input: { versionId?: string }) => {
        const source = fixture.sources.find(
          (item) => item.versionId === input.versionId,
        );
        const text = input.versionId
          ? fixture.excerpts[input.versionId as keyof typeof fixture.excerpts]
          : undefined;
        return source && text
          ? {
              status: "resolved",
              source: { versionId: source.versionId, name: source.name },
              content: { status: "available", text },
            }
          : { status: "unavailable" };
      },
      executeSupervisor: async (input) => {
        calls.push({ phase: input.phase, goal: input.goal, context: input.context });
        if (input.phase === "plan")
          return {
            status: "completed",
            output: {
              tasks: [
                {
                  role: "source_reviewer",
                  goal: "Review A",
                  sourceVersionIds: [inventoryVersionId],
                },
                {
                  role: "requirements_reviewer",
                  goal: "Review B",
                  sourceVersionIds: [],
                },
              ],
            },
          };
        if (input.phase === "specialist")
          return {
            status: "completed",
            output: {
              summary: `Evidence for ${input.goal}`,
              rationale: "Bounded evidence",
              citations: [],
            },
          };
        await input.onSummaryDelta?.("Vorläufige Planungsvorlage");
        const [checkpoint] = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, input.runId));
        expect(checkpoint!.partialOutput).toBe("Vorläufige Planungsvorlage");
        const context = input.context as any;
        expect(
          context.assignments.every((a: any) =>
            a.output.summary.startsWith("Evidence"),
          ),
        ).toBe(true);
        return {
          status: "completed",
          output: {
            decision: reviewCount++ === 0 ? "revise" : "accept",
            summary: fixture.expectedSummary,
            rationale:
              "Die Quellen wurden abgeglichen. Maße und Bauteilaufbauten sind vor Ausführung durch eine Fachplanung zu prüfen.",
            citations: [inventoryVersionId],
            revisions:
              reviewCount === 1
                ? [{ taskId: context.assignments[0].taskId, goal: "Recheck A" }]
                : [],
          },
        };
      },
    };
    let id = "";
    try {
      const [thread] = await db
        .insert(conversations)
        .values({
          tenantId,
          projectId,
          title: fixture.projectName,
          createdBy: actorId,
        })
        .returning();
      conversationId = thread!.id;
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId,
          conversationId,
          goal: fixture.prompt,
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", policy);
      await stepSupervisor(d, id); // durable plan
      const planCall = calls.find((call) => call.phase === "plan");
      expect(planCall!.goal).toBe(fixture.prompt);
      expect((planCall!.context as any).sourceInventory.sources).toEqual(
        fixture.sources,
      );
      expect(
        (planCall!.context as any).sourceInventory.sources[0].versionId,
      ).toBe(inventoryVersionId);
      // Simulate one successfully committed specialist and process death before its sibling.
      const [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      const assignments = state!.assignments as any[];
      expect(assignments[0]!.sourceVersionIds).toEqual([inventoryVersionId]);
      assignments[0].output = {
        summary: "Evidence recovered from prior process",
        rationale: "saved",
        citations: [],
      };
      await db
        .update(supervisorRuns)
        .set({
          assignments,
          leaseToken: crypto.randomUUID(),
          leaseUntil: new Date(0),
        })
        .where(eq(supervisorRuns.runId, id));
      await stepSupervisor({ ...d }, id);
      expect(calls.filter((c) => c.phase === "specialist")).toHaveLength(1);
      await stepSupervisor({ ...d }, id); // reviews and requests revision
      await stepSupervisor({ ...d }, id); // only revised task
      await stepSupervisor({ ...d }, id); // reviews actual revision
      expect(calls.filter((c) => c.phase === "specialist")).toHaveLength(2);
      const [result] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, id));
      expect(result!.status).toBe("needs_review");
      expect(result!.outputSummary).toBe(fixture.expectedSummary);
      const outputMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.runId, id));
      expect(outputMessages).toHaveLength(1);
      const [resultArtifact] = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.runId, id));
      const [resultRevision] = await db
        .select()
        .from(artifactRevisions)
        .where(eq(artifactRevisions.artifactId, resultArtifact!.id));
      expect(outputMessages[0]!.openui).toBe(
        `root = ArtifactPdf(${JSON.stringify(resultArtifact!.id)}, ${JSON.stringify(resultRevision!.id)})`,
      );
      expect(resultRevision!.sourceVersionIds).toEqual([inventoryVersionId]);
      server = express()
        .use("/api/knowledge", workspaceRouter(() => d))
        .listen(0);
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      const pdfResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/knowledge/artifacts/${resultArtifact!.id}/revisions/${resultRevision!.id}/pdf`,
      );
      expect(pdfResponse.status).toBe(200);
      expect(pdfResponse.headers.get("content-type")).toContain("application/pdf");
      expect(pdfResponse.headers.get("content-disposition")).toContain("attachment");
      const pdf = Buffer.from(await pdfResponse.arrayBuffer());
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      const extracted = Bun.spawnSync(["pdftotext", "-", "-"], { stdin: pdf });
      expect(extracted.exitCode).toBe(0);
      expect(extracted.stdout.toString()).toContain(fixture.sources[0].name);
      expect(extracted.stdout.toString()).not.toContain(inventoryVersionId);
      await stepSupervisor({ ...d }, id); // terminal is idempotent
      expect(calls.filter((c) => c.phase === "review")).toHaveLength(2);
      const [final] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      expect(final!.revision).toBe(1);
      expect(
        (final!.history as any[]).filter((h) => h.phase === "review"),
      ).toHaveLength(2);
      await stepSupervisor({ ...d, tenantId: crypto.randomUUID() }, id);
      expect(calls).toHaveLength(5);
    } finally {
      if (server) await new Promise<void>((resolve) => server.close(resolve));
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await db.delete(messages).where(eq(messages.tenantId, tenantId));
      await db
        .delete(conversations)
        .where(eq(conversations.tenantId, tenantId));
      await pool.end();
    }
  },
);
integration("failed specialist attempts persist bounded diagnostics and usage exactly once", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  let attempts = 0;
  const d: any = {
    db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true,
    listProjectSources: async () => ({ sources: [], truncated: false }),
    executeSupervisor: async (input: any) => {
      if (input.phase === "plan") return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Inspect", sourceVersionIds: [] }] } };
      attempts++;
      const usage = { provider: "openai", modelId: "test-model", inputTokens: 12, outputTokens: 50, totalTokens: 62, reasoningTokens: null, cachedInputTokens: null };
      await input.onUsage(usage);
      await input.onUsage(usage); // Defensive boundary deduplication, not two calls.
      throw Object.assign(new Error("sk-secret raw provider body"), {
        providerFailure: true, retryable: true, failureCategory: "validation",
        diagnostics: {
          errorId: attempts === 1 ? "STRUCTURED_OUTPUT_TRUNCATED" : "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
          finishReason: attempts === 1 ? "length" : "error",
          raw: "sk-secret", stack: "sk-secret",
          issues: [{ code: "too_big", path: ["summary"], maximum: 10000, message: "sk-secret", value: "sk-secret" }, { code: "invalid_type", path: ["sk-secret"] }],
        },
      });
    },
  };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Diagnostic regression", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    expect(attempts).toBe(3);
    const events = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, run!.id));
    const failed = events.filter(event => ["provider_call_retrying", "provider_call_failed"].includes(event.eventType));
    const metadata = failed.map(event => JSON.parse(event.paramsSummary!)).sort((a, b) => a.attempt - b.attempt);
    expect(metadata.map(value => value.attempt)).toEqual([1, 2, 3]);
    expect(new Set(metadata.map(value => value.callId)).size).toBe(1);
    const children = await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, run!.id));
    expect(children).toHaveLength(1);
    expect(metadata.every(value => value.runId === children[0]!.id)).toBe(true);
    expect(metadata[0].diagnostics.errorId).toBe("STRUCTURED_OUTPUT_TRUNCATED");
    expect(metadata[2].diagnostics.errorId).toBe("STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED");
    expect(metadata[2].diagnostics.issues).toEqual([{ code: "too_big", path: ["summary"], maximum: 10000 }]);
    expect(JSON.stringify(events)).not.toContain("sk-secret");
    const usage = await db.select().from(agentRunUsage).where(eq(agentRunUsage.runId, children[0]!.id));
    expect(usage).toHaveLength(3);
    expect(usage.reduce((sum, row) => sum + row.totalTokens!, 0)).toBe(186);
    const tracked = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, children[0]!.id));
    expect(tracked).toHaveLength(3);
    for (const event of metadata) {
      const attempt = tracked.find(row => row.operationId === event.callId && row.attemptNumber === event.attempt);
      expect(attempt?.status).toBe("failed");
      expect(usage.filter(row => row.attemptId === attempt?.id)).toHaveLength(1);
    }
  } finally {
    await db.delete(agentRunUsage).where(eq(agentRunUsage.tenantId, tenantId));
    await db.delete(agentRunAttempts).where(eq(agentRunAttempts.tenantId, tenantId));
    await db.delete(agentRunEvents).where(eq(agentRunEvents.tenantId, tenantId));
    await db.delete(supervisorRuns).where(eq(supervisorRuns.tenantId, tenantId));
    await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
    await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
    await pool.end();
  }
});
integration(
  "cancelled parent fences late provider result and prevents child writes",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID();
    let id = "";
    const d: any = {
      db,
      tenantId,
      actorId,
      requirePermission: () => {},
      validateProject: async () => true,
      listProjectSources: async () => ({
        sources: [],
        truncated: false,
        authority: "unreviewed_source_inventory",
      }),
      auditRun: async () => {},
      executeSupervisor: async () => {
        await db
          .update(agentRuns)
          .set({ status: "cancelled" })
          .where(and(eq(agentRuns.id, id), eq(agentRuns.tenantId, tenantId)));
        return {
          status: "completed",
          output: {
            tasks: [
              {
                role: "source_reviewer",
                goal: "Cancelled task",
                sourceVersionIds: [],
              },
            ],
          },
        };
      },
    };
    try {
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId: crypto.randomUUID(),
          goal: "Cancelled goal",
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", policy);
      await stepSupervisor(d, id);
      expect(
        await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, id)),
      ).toHaveLength(0);
      const [parent] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, id));
      expect(parent!.status).toBe("cancelled");
    } finally {
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await pool.end();
    }
  },
);
integration(
  "steering replacement fences old plan and preserves its model policy; provider failure stops children",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID();
    let id = "",
      mode = "steer";
    const d: any = {
      db,
      tenantId,
      actorId,
      requirePermission: () => {},
      validateProject: async () => true,
      listProjectSources: async () => ({
        sources: [],
        truncated: false,
        authority: "unreviewed_source_inventory",
      }),
      auditRun: async () => {},
      executeSupervisor: async (input: any) => {
        expect(input.modelPolicy.version).toBe(1);
        if (mode === "steer") {
          await db
            .update(supervisorRuns)
            .set({
              generation: 1,
              steering: "New human direction",
              leaseToken: null,
              leaseUntil: null,
            })
            .where(eq(supervisorRuns.runId, id));
          await db
            .update(agentRuns)
            .set({ status: "queued" })
            .where(eq(agentRuns.id, id));
          return {
            status: "completed",
            output: {
              tasks: [
                {
                  role: "source_reviewer",
                  goal: "Obsolete plan",
                  sourceVersionIds: [],
                },
              ],
            },
          };
        }
        if (input.phase === "plan")
          return {
            status: "completed",
            output: {
              tasks: [
                {
                  role: "source_reviewer",
                  goal: "Fresh plan",
                  sourceVersionIds: [],
                },
              ],
            },
          };
        throw new Error("secret-provider-error-not-for-persistence");
      },
    };
    try {
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId: crypto.randomUUID(),
          goal: "Initial direction",
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", policy);
      await stepSupervisor(d, id);
      expect(
        await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, id)),
      ).toHaveLength(0);
      mode = "failure";
      // A newer admin config is available; execution must keep the saved version.
      d.resolveSupervisorPreset = async () => ({ ...policy, version: 2 });
      await stepSupervisor(d, id);
      await stepSupervisor(d, id);
      const [parent] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, id));
      expect(parent!.status).toBe("failed");
      expect(parent!.error).not.toContain("secret-provider");
      const children = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.parentRunId, id));
      expect(children).toHaveLength(1);
      expect(children[0]!.status).toBe("cancelled");
      const [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      expect((state!.modelPolicy as any).version).toBe(1);
      expect(state!.generation).toBe(1);
    } finally {
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await pool.end();
    }
  },
);
integration(
  "legacy recovery marks only abandoned legacy executions and excludes supervised children",
  async () => {
    const { repairLegacyRuns } =
      await import("../richtfest-apps/knowledge/src/run-recovery");
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID();
    const d: any = { db, tenantId, actorId, auditRun: async () => {} };
    try {
      const base = {
        tenantId,
        projectId,
        goal: "stale",
        provider: "openai",
        requestedBy: actorId,
        correlationId: crypto.randomUUID(),
        status: "running",
        updatedAt: new Date(0),
      };
      const [parent] = await db.insert(agentRuns).values(base).returning();
      await createSupervisor(d, db, parent, "medium", policy);
      const [child] = await db
        .insert(agentRuns)
        .values({ ...base, parentRunId: parent!.id })
        .returning();
      const [legacy] = await db.insert(agentRuns).values(base).returning();
      await repairLegacyRuns(d, { projectId });
      await repairLegacyRuns(d, { projectId });
      const records = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.tenantId, tenantId));
      expect(records.find((r) => r.id === parent!.id)!.status).toBe("running");
      expect(records.find((r) => r.id === child!.id)!.status).toBe("running");
      expect(records.find((r) => r.id === legacy!.id)!.status).toBe("failed");
      expect(
        await db
          .select()
          .from(agentRunEvents)
          .where(eq(agentRunEvents.tenantId, tenantId)),
      ).toHaveLength(1);
    } finally {
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await pool.end();
    }
  },
);
integration(
  "cancellation during a specialist prevents subsequent batches and discards late output",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID();
    let id = "",
      specialistCalls = 0;
    const d: any = {
      db,
      tenantId,
      actorId,
      requirePermission: () => {},
      validateProject: async () => true,
      listProjectSources: async () => ({
        sources: [],
        truncated: false,
        authority: "unreviewed_source_inventory",
      }),
      auditRun: async () => {},
      executeSupervisor: async (input: any) => {
        if (input.phase === "plan")
          return {
            status: "completed",
            output: {
              tasks: [
                {
                  role: "source_reviewer",
                  goal: "First",
                  sourceVersionIds: [],
                },
                {
                  role: "source_reviewer",
                  goal: "Never start",
                  sourceVersionIds: [],
                },
              ],
            },
          };
        specialistCalls++;
        await db
          .update(agentRuns)
          .set({ status: "cancelled" })
          .where(eq(agentRuns.id, id));
        return {
          status: "completed",
          output: {
            summary: "Late output",
            rationale: "discard",
            citations: [],
          },
        };
      },
    };
    try {
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId: crypto.randomUUID(),
          goal: "Cancel while working",
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", {
        ...policy,
        maxParallel: 1,
      });
      await stepSupervisor(d, id);
      await stepSupervisor(d, id);
      expect(specialistCalls).toBe(1);
      const [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      expect((state!.assignments as any[]).every((a) => !a.output)).toBe(true);
      expect(state!.phase).toBe("specialists");
    } finally {
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await pool.end();
    }
  },
);
