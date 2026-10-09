import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { runsRouter } from "../richtfest-apps/knowledge/src/runs";
import { createSupervisor } from "../richtfest-apps/knowledge/src/supervisor";
import {
  agentRuns,
  supervisorRuns,
  agentRunEvents,
  conversations,
  messages,
} from "../richtfest-apps/knowledge/src/schema";
const integration = process.env.DATABASE_URL ? test : test.skip;
integration(
  "steering route validates message/source scope, reuses composer message, and preserves manual steering",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID(),
      sourceId = crypto.randomUUID();
    const d: any = {
      db,
      tenantId,
      actorId,
      supervisorEnabled: true,
      requirePermission: () => {},
      validateProject: async (id: string) => id === projectId,
      validateSourceVersion: async (project: string, id: string) =>
        project === projectId && id === sourceId,
      auditRun: async () => {},
      cancelExecution: () => {},
    };
    const server = express()
      .use(express.json())
      .use(runsRouter(() => d))
      .use((e: any, _req: any, res: any, _next: any) =>
        res.status(e.status ?? 500).json({ error: e.code }),
      )
      .listen(0);
    const address = server.address() as { port: number };
    let id = "";
    const steer = async (body: unknown) =>
      fetch(`http://127.0.0.1:${address.port}/runs/${id}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const [thread, otherThread] = await db
        .insert(conversations)
        .values([
          { tenantId, projectId, title: "Owned thread", createdBy: actorId },
          { tenantId, projectId, title: "Other thread", createdBy: actorId },
        ])
        .returning();
      const base = {
        tenantId,
        conversationId: thread!.id,
        authorId: actorId,
        actorKind: "user",
        body: "Use this selected source",
      };
      const [own, crossThread, otherAuthor, agent, foreignTenant] = await db
        .insert(messages)
        .values([
          base,
          { ...base, conversationId: otherThread!.id },
          { ...base, authorId: crypto.randomUUID() },
          { ...base, actorKind: "agent" },
          { ...base, tenantId: crypto.randomUUID() },
        ])
        .returning();
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId,
          conversationId: thread!.id,
          goal: "Review",
          provider: "openai",
          status: "needs_review",
          outputSummary: "Previous result",
          rationale: "Previous reasoning",
          partialOutput: "Previous streamed result",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", {});
      const priorReview = { summary: "Previous result", rationale: "Previous reasoning", citations: [sourceId] };
      await db.update(supervisorRuns).set({ review: priorReview, history: [{ phase: "review", output: priorReview }] }).where(eq(supervisorRuns.runId,id));
      for (const invalid of [crossThread, otherAuthor, agent, foreignTenant])
        expect(
          (await steer({ instruction: "Follow up", messageId: invalid!.id }))
            .status,
        ).toBe(404);
      expect(
        (
          await steer({
            instruction: "Follow up",
            messageId: own!.id,
            sourceVersionIds: [crypto.randomUUID()],
          })
        ).status,
      ).toBe(404);
      let [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      expect(state!.generation).toBe(0);
      const initialCount = (
        await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, thread!.id))
      ).length;
      const accepted = await steer({
        instruction: "Follow up",
        messageId: own!.id,
        sourceVersionIds: [sourceId],
      });
      expect(accepted.status).toBe(201);
      const body = await accepted.json();
      expect(body.data.messageId).toBe(own!.id);
      expect(body.data.sourceVersionIds).toEqual([sourceId]);
      expect(body.data.outputSummary).toBeNull();
      expect(body.data.rationale).toBeNull();
      expect(body.data.partialOutput).toBe("");
      expect(
        (
          await db
            .select()
            .from(messages)
            .where(eq(messages.conversationId, thread!.id))
        ).length,
      ).toBe(initialCount);
      [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      expect(state!.generation).toBe(1);
      expect(state!.review).toBeNull();
      expect(state!.assignments).toEqual([]);
      expect(state!.history).toEqual([{ phase: "review", output: priorReview }]);
      // Approved work is immutable to steering and must start a new round.
      await db
        .update(agentRuns)
        .set({ status: "approved" })
        .where(eq(agentRuns.id, id));
      expect(
        (
          await steer({
            instruction: "Change approved output",
            messageId: own!.id,
          })
        ).status,
      ).toBe(409);
      await db
        .update(agentRuns)
        .set({ status: "failed" })
        .where(eq(agentRuns.id, id));
      const manual = await steer({ instruction: "Manual follow-up" });
      expect(manual.status).toBe(201);
      const manualBody = await manual.json();
      expect(manualBody.data.messageId).not.toBe(own!.id);
      expect(manualBody.data.sourceVersionIds).toEqual([sourceId]);
      expect(
        (
          await db
            .select()
            .from(messages)
            .where(eq(messages.conversationId, thread!.id))
        ).length,
      ).toBe(initialCount + 1);
      [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      expect(state!.generation).toBe(2);
      await db
        .update(conversations)
        .set({ projectId: crypto.randomUUID() })
        .where(eq(conversations.id, thread!.id));
      expect(
        (await steer({ instruction: "Wrong project", messageId: own!.id }))
          .status,
      ).toBe(404);
      await db.delete(messages).where(eq(messages.id, foreignTenant!.id));
    } finally {
      server.close();
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await db.delete(messages).where(eq(messages.tenantId, tenantId));
      await db
        .delete(conversations)
        .where(eq(conversations.tenantId, tenantId));
      await pool.end();
    }
  },
);
