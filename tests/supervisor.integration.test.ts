import { expect, test } from "bun:test";
import { and, eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import {
  artifactRevisions,
  artifacts,
  agentRuns,
  supervisorRuns,
  tasks,
  agentRunEvents,
} from "../richtfest-apps/knowledge/src/schema";
import {
  stepSupervisor,
  createSupervisor,
} from "../richtfest-apps/knowledge/src/supervisor";
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
integration(
  "supervisor resumes saved specialists, reviews actual results and revises before human review",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID(),
      inventoryVersionId = crypto.randomUUID();
    const calls: { phase: string; context: any }[] = [];
    let reviewCount = 0;
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
      listProjectSources: async () => ({
        sources: [{
          fileId: crypto.randomUUID(),
          name: "DIN 4109 2025 159 Calculation IL.pdf",
          versionId: inventoryVersionId,
          version: 1,
          mimeType: "application/pdf",
        }],
        truncated: false,
        authority: "unreviewed_source_inventory",
      }),
      resolveSource: async () => ({ text: "source" }),
      executeSupervisor: async (input) => {
        calls.push({ phase: input.phase, context: input.context });
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
        await input.onSummaryDelta?.("Provisional synthesis");
        const [checkpoint] = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, input.runId));
        expect(checkpoint!.partialOutput).toBe("Provisional synthesis");
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
            summary: "Reviewed synthesis",
            rationale: "Actual child outputs reviewed",
            citations: [],
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
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId,
          goal: "Review project",
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", policy);
      await stepSupervisor(d, id); // durable plan
      const planCall = calls.find((call) => call.phase === "plan");
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
      expect(result!.outputSummary).toBe("Reviewed synthesis");
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
