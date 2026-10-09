import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { createRouter } from "../richtfest-apps/knowledge/src/router";
import {
  conversations,
  messages,
  agentRuns,
} from "../richtfest-apps/knowledge/src/schema";
const integration = process.env.DATABASE_URL ? test : test.skip;
integration(
  "conversation archive/restore is scoped, reversible and does not change messages or active agents",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      foreignTenant = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID();
    const audit: string[] = [];
    let projectAccessible = true;
    const server = express()
      .use(express.json())
      .use(
        createRouter(
          (req) =>
            ({
              db,
              tenantId,
              actorId,
              validateProject: async (id: string) =>
                projectAccessible && id === projectId,
              requirePermission: (permission: string) => {
                if (
                  req.headers["x-test-deny"] === "write" &&
                  permission === "knowledge:write"
                )
                  throw Object.assign(new Error("Forbidden"), { status: 403 });
              },
              audit: async (_tx: any, action: string) => {
                audit.push(action);
              },
            }) as any,
        ),
      )
      .use((e: any, _req: any, res: any, _next: any) =>
        res.status(e.status ?? 400).json({ error: e.code ?? "bad_request" }),
      )
      .listen(0);
    const { port } = server.address() as { port: number };
    const patch = (id: string, archived: boolean, deny = false) =>
      fetch(`http://127.0.0.1:${port}/conversations/${id}/archive`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(deny ? { "x-test-deny": "write" } : {}),
        },
        body: JSON.stringify({ archived }),
      });
    try {
      const [thread, foreign] = await db
        .insert(conversations)
        .values([
          {
            tenantId,
            projectId,
            title: "Project discussion",
            createdBy: actorId,
          },
          {
            tenantId: foreignTenant,
            projectId,
            title: "Other tenant",
            createdBy: actorId,
          },
        ])
        .returning();
      const [message] = await db
        .insert(messages)
        .values({
          tenantId,
          conversationId: thread!.id,
          authorId: actorId,
          body: "Keep project evidence",
        })
        .returning();
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId,
          conversationId: thread!.id,
          goal: "Continue work",
          provider: "openai",
          status: "running",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      expect((await patch(thread!.id, true, true)).status).toBe(403);
      expect((await patch(foreign!.id, true)).status).toBe(404);
      projectAccessible = false;
      expect((await patch(thread!.id, true)).status).toBe(404);
      projectAccessible = true;
      const archived = await patch(thread!.id, true);
      expect(archived.status).toBe(200);
      const archivedBody = await archived.json();
      expect(typeof archivedBody.data.archivedAt).toBe("string");
      const [stored] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, thread!.id));
      expect(stored!.archivedAt?.toISOString()).toBe(
        archivedBody.data.archivedAt,
      );
      const repeated = await (await patch(thread!.id, true)).json();
      expect(repeated.data.archivedAt).toBe(archivedBody.data.archivedAt);
      expect(audit).toEqual(["knowledge.conversation.archived"]);
      const listing = await (
        await fetch(`http://127.0.0.1:${port}/conversations`)
      ).json();
      expect(
        listing.data.find((row: any) => row.id === thread!.id).archivedAt,
      ).toBe(archivedBody.data.archivedAt);
      expect(listing.data.some((row: any) => row.id === foreign!.id)).toBe(
        false,
      );
      const [otherProjectThread] = await db.insert(conversations).values({tenantId,projectId:crypto.randomUUID(),title:"Other project",createdBy:actorId}).returning();
      const projectListing = await (await fetch(`http://127.0.0.1:${port}/conversations?projectId=${projectId}`)).json();
      expect(projectListing.data.map((row:any)=>row.id)).toEqual([thread!.id]);
      expect(projectListing.data.some((row:any)=>row.id===otherProjectThread!.id)).toBe(false);
      expect((await fetch(`http://127.0.0.1:${port}/conversations?projectId=${crypto.randomUUID()}`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/conversations?projectId=invalid`)).status).toBe(400);
      const workspace = await (
        await fetch(`http://127.0.0.1:${port}/workspaces/${projectId}`)
      ).json();
      expect(
        workspace.data.conversations.find((row: any) => row.id === thread!.id)
          .archivedAt,
      ).toBe(archivedBody.data.archivedAt);
      expect(
        await db.select().from(messages).where(eq(messages.id, message!.id)),
      ).toEqual([message!]);
      expect(
        await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)),
      ).toEqual([run!]);
      const restored = await (await patch(thread!.id, false)).json();
      expect(restored.data.archivedAt).toBeNull();
      expect(audit).toEqual([
        "knowledge.conversation.archived",
        "knowledge.conversation.restored",
      ]);
      const [persisted] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, thread!.id));
      expect(persisted!.archivedAt).toBeNull();
      await db.delete(conversations).where(eq(conversations.id, foreign!.id));
    } finally {
      server.close();
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await db.delete(messages).where(eq(messages.tenantId, tenantId));
      await db
        .delete(conversations)
        .where(eq(conversations.tenantId, tenantId));
      await db
        .delete(conversations)
        .where(eq(conversations.tenantId, foreignTenant));
      await pool.end();
    }
  },
);
