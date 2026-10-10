import { expect, test } from "bun:test";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import {
  stepSupervisor,
  createSupervisor,
} from "../richtfest-apps/knowledge/src/supervisor";
import {
  agentRuns,
  supervisorRuns,
  conversations,
  messages,
  artifacts,
  artifactRevisions,
  agentRunEvents,
} from "../richtfest-apps/knowledge/src/schema";
const integration = process.env.DATABASE_URL ? test : test.skip;
integration(
  "supervisor completion creates exact proposed artifact revision once per generation",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID(),
      sourceId = crypto.randomUUID();
    const model = { modelId: "test-model", maxOutputTokens: 1024, maxSteps: 1 };
    const policy = {
      provider: "openai",
      effort: "medium",
      version: 1,
      source: "vendor",
      supervisor: model,
      specialists: { source_reviewer: model, requirements_reviewer: model },
      maxParallel: 2,
      maxTasks: 4,
      maxRevisions: 2,
    };
    const d: any = {
      db,
      tenantId,
      actorId,
      requirePermission: () => {},
      validateProject: async () => true,
      validateSourceVersion: async () => true,
      auditRun: async () => {},
      executeSupervisor: async () => ({
        status: "completed",
        output: {
          decision: "accept",
          summary: "Actual reviewed result",
          rationale: "Checked source evidence",
          citations: [sourceId],
          revisions: [],
        },
      }),
    };
    try {
      const [thread] = await db
        .insert(conversations)
        .values({ tenantId, projectId, title: "Review", createdBy: actorId })
        .returning();
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId,
          conversationId: thread!.id,
          goal: "Review the project requirements",
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      await createSupervisor(d, db, run, "medium", policy);
      const assignments = [
        {
          runId: crypto.randomUUID(),
          taskId: crypto.randomUUID(),
          goal: "Review evidence",
          role: "source_reviewer",
          sourceVersionIds: [sourceId],
          output: {
            summary: "Child evidence",
            rationale: "Bounded",
            citations: [sourceId],
          },
        },
      ];
      await db
        .update(supervisorRuns)
        .set({ phase: "review", assignments })
        .where(eq(supervisorRuns.runId, run!.id));
      await stepSupervisor(d, run!.id);
      await stepSupervisor(d, run!.id);
      const artifactRows = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.runId, run!.id));
      expect(artifactRows).toHaveLength(1);
      expect(artifactRows[0]!.status).toBe("draft");
      const revisions = await db
        .select()
        .from(artifactRevisions)
        .where(eq(artifactRevisions.artifactId, artifactRows[0]!.id));
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.content).toContain("Actual reviewed result");
      expect(revisions[0]!.content).toContain("Checked source evidence");
      expect(revisions[0]!.sourceVersionIds).toEqual([sourceId]);
      const outputs = await db
        .select()
        .from(messages)
        .where(eq(messages.runId, run!.id));
      expect(outputs).toHaveLength(1);
      const reference = {
        kind: "supervisor_result",
        artifactId: artifactRows[0]!.id,
        revisionId: revisions[0]!.id,
        generation: 0,
      };
      expect(outputs[0]!.openui).toBe(
        `root = ArtifactPdf(${JSON.stringify(reference.artifactId)}, ${JSON.stringify(reference.revisionId)})`,
      );
      expect(outputs[0]!.sourceRef).toBeNull();
      const [parent] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, run!.id));
      expect(parent!.status).toBe("needs_review");
      // A later human-steered generation must have its own immutable proposal and exact reference.
      await db
        .update(supervisorRuns)
        .set({ generation: 1, phase: "review" })
        .where(eq(supervisorRuns.runId, run!.id));
      await db
        .update(agentRuns)
        .set({ status: "queued" })
        .where(eq(agentRuns.id, run!.id));
      await stepSupervisor(d, run!.id);
      await stepSupervisor(d, run!.id);
      const later = await db
        .select()
        .from(messages)
        .where(eq(messages.runId, run!.id));
      expect(later).toHaveLength(2);
      const [resultState] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, run!.id));
      const newest = (resultState!.review as any).result;
      expect(
        later.some(
          (m) =>
            m.openui ===
            `root = ArtifactPdf(${JSON.stringify(newest.artifactId)}, ${JSON.stringify(newest.revisionId)})`,
        ),
      ).toBe(true);
      expect(newest.artifactId).not.toBe(reference.artifactId);
      expect(newest.revisionId).not.toBe(reference.revisionId);
      expect(
        await db
          .select()
          .from(artifactRevisions)
          .where(eq(artifactRevisions.id, revisions[0]!.id)),
      ).toEqual(revisions);
      const [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, run!.id));
      expect((state!.review as any).result).toEqual(newest);
    } finally {
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db.delete(messages).where(eq(messages.tenantId, tenantId));
      await db
        .delete(conversations)
        .where(eq(conversations.tenantId, tenantId));
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
