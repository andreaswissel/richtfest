import express from "../richtfest-os/apps/api/node_modules/express";
import { runsRouter } from "../richtfest-apps/knowledge/src/runs";
import { expect, test } from "bun:test";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { startSupervisorWorker } from "../richtfest-os/apps/api/src/supervisor-worker";
import {
  createMastraStorage,
  createSupervisorWorkflowRuntime,
} from "../richtfest-os/apps/api/src/agent-runtime/mastra-workflow";
import {
  artifactRevisions,
  artifacts,
  agentRuns,
  supervisorRuns,
  agentRunEvents,
  tasks,
} from "../richtfest-apps/knowledge/src/schema";
import {
  createSupervisor,
  stepSupervisor,
} from "../richtfest-apps/knowledge/src/supervisor";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";
const integration = process.env.DATABASE_URL ? test : test.skip;

integration(
  "real Mastra/Postgres workers coordinate replicas and resume saved domain/framework state",
  async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const { db, pool } = createDatabase(databaseUrl);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID();
    const config = {
      modelId: "test-model",
      maxOutputTokens: 1024,
      maxSteps: 1,
    };
    const policy = {
      provider: "openai",
      effort: "medium",
      version: 1,
      source: "vendor",
      supervisor: config,
      specialists: { source_reviewer: config, requirements_reviewer: config },
      maxParallel: 2,
      maxTasks: 4,
      maxRevisions: 2,
    };
    const calls: { phase: string; runId: string }[] = [];
    let activeSpecialists = 0,
      peakSpecialists = 0,
      hydrated = 0;
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
      resolveSource: async () => ({ text: "test evidence" }),
      executeSupervisor: async (input) => {
        calls.push({ phase: input.phase, runId: input.runId });
        if (input.phase === "plan")
          return {
            status: "completed",
            output: {
              tasks: [
                {
                  role: "source_reviewer",
                  goal: "Inspect source",
                  sourceVersionIds: [],
                },
                {
                  role: "requirements_reviewer",
                  goal: "Inspect requirements",
                  sourceVersionIds: [],
                },
              ],
            },
          };
        if (input.phase === "specialist") {
          activeSpecialists++;
          peakSpecialists = Math.max(peakSpecialists, activeSpecialists);
          await new Promise((resolve) => setTimeout(resolve, 40));
          activeSpecialists--;
          return {
            status: "completed",
            output: {
              summary: `Independent ${input.goal}`,
              rationale: "Bounded evidence",
              citations: [],
            },
          };
        }
        const context = input.context as any;
        expect(context.assignments).toHaveLength(2);
        expect(
          context.assignments.every((a: any) =>
            a.output.summary.startsWith("Independent"),
          ),
        ).toBe(true);
        return {
          status: "completed",
          output: {
            decision: "accept",
            summary: "Parent reviewed both specialist outputs",
            rationale: "Human approval remains required",
            citations: [],
            revisions: [],
          },
        };
      },
    };
    const workers: { stop: () => Promise<void> }[] = [];
    const bootstrapStorage = createMastraStorage(databaseUrl);
    const ids: string[] = [];
    const server = express()
      .use(express.json())
      .use(runsRouter(() => d))
      .listen(0);
    try {
      for (let i = 0; i < 2; i++) {
        const [run] = await db
          .insert(agentRuns)
          .values({
            tenantId,
            projectId,
            goal: `Worker test ${i}`,
            provider: "openai",
            requestedBy: actorId,
            correlationId: crypto.randomUUID(),
          })
          .returning();
        ids.push(run!.id);
        await createSupervisor(d, db, run, "medium", policy);
      }
      // The old process committed its plan, then died before the framework checkpoint advanced.
      await stepSupervisor(d, ids[1]!);
      await db
        .update(supervisorRuns)
        .set({ leaseToken: crypto.randomUUID(), leaseUntil: new Date(0) })
        .where(eq(supervisorRuns.runId, ids[1]!));
      const crashed = createSupervisorWorkflowRuntime({
        storage: bootstrapStorage,
        advance: async () => {
          throw new Error("simulated shutdown");
        },
      });
      expect((await crashed.execute(ids[1]!)).status).toBe("failed");
      const resolveDeps = async (tenant: string, actor: string) => {
        if (tenant !== tenantId || actor !== actorId)
          throw new Error("Test worker never touches another tenant");
        hydrated++;
        return { ...d };
      };
      workers.push(
        ...(await Promise.all([
          startSupervisorWorker(db, pool, {
            enabled: true,
            databaseUrl,
            resolveDeps,
          }),
          startSupervisorWorker(db, pool, {
            enabled: true,
            databaseUrl,
            resolveDeps,
          }),
        ])),
      );
      const deadline = Date.now() + 15000;
      let rows: any[] = [];
      while (Date.now() < deadline) {
        rows = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.tenantId, tenantId));
        if (
          ids.every(
            (id) => rows.find((r) => r.id === id)?.status === "needs_review",
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(ids.map((id) => rows.find((r) => r.id === id)?.status)).toEqual([
        "needs_review",
        "needs_review",
      ]);
      await Promise.all(workers.map((worker) => worker.stop()));
      workers.length = 0;
      expect(calls.filter((c) => c.phase === "plan")).toHaveLength(2);
      expect(calls.filter((c) => c.phase === "specialist")).toHaveLength(4);
      expect(calls.filter((c) => c.phase === "review")).toHaveLength(2);
      expect(peakSpecialists).toBeGreaterThanOrEqual(2);
      expect(hydrated).toBeGreaterThanOrEqual(5);
      expect(new Set(calls.map((c) => `${c.phase}:${c.runId}`)).size).toBe(
        calls.length,
      );
      for (const id of ids) {
        const snapshot = await crashed.workflow.getWorkflowRunById(id);
        expect(snapshot?.status).toBe("success");
        expect(JSON.stringify(snapshot)).not.toContain("Independent");
        expect(JSON.stringify(snapshot)).not.toContain("test-model");
      }
      // Exercise the public steering route against a completed framework snapshot.
      const address = server.address() as { port: number };
      const response = await fetch(
        `http://127.0.0.1:${address.port}/runs/${ids[0]}/steer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: "Reconsider the requirement scope",
          }),
        },
      );
      expect(response.status).toBe(201);
      const [steered] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, ids[0]!));
      expect(steered!.generation).toBe(1);
      expect(steered!.phase).toBe("plan");
      expect(steered!.assignments).toEqual([]);
      workers.push(
        await startSupervisorWorker(db, pool, {
          enabled: true,
          databaseUrl,
          resolveDeps,
        }),
      );
      const steeringDeadline = Date.now() + 10000;
      let steeredStatus = "queued";
      while (Date.now() < steeringDeadline) {
        const [parent] = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, ids[0]!));
        steeredStatus = parent!.status;
        if (steeredStatus === "needs_review") break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(steeredStatus).toBe("needs_review");
      await Promise.all(workers.map((worker) => worker.stop()));
      workers.length = 0;
      expect(
        (await crashed.workflow.getWorkflowRunById(`${ids[0]}:1`))?.status,
      ).toBe("success");
      expect(
        calls.filter((c) => c.phase === "plan" && c.runId === ids[0]),
      ).toHaveLength(2);
    } finally {
      server.close();
      await Promise.all(workers.map((worker) => worker.stop()));
      await bootstrapStorage.close();
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
  20000,
);
