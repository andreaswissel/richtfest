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
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(resolve));
    await db.delete(agentRunUsage).where(eq(agentRunUsage.tenantId, tenantId));
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
