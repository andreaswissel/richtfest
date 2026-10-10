import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { eq, inArray } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { createRouter } from "../richtfest-apps/knowledge/src/router";
import {
  conversations,
  messages,
} from "../richtfest-apps/knowledge/src/schema";

const integration = process.env.DATABASE_URL ? test : test.skip;
integration(
  "conversation titles recover from provider failures and missed requests without replacing manual titles",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      foreignTenant = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    let generate:
      ((input: { message: string }) => Promise<string | null>) | undefined;
    const audits: { action: string; id: string; metadata: any }[] = [];
    const server = express()
      .use(express.json())
      .use(
        createRouter(
          (req) =>
            ({
              db,
              tenantId,
              actorId,
              requirePermission: () => {
                if (req.headers["x-test-deny"])
                  throw Object.assign(new Error("Forbidden"), { status: 403 });
              },
              generateConversationTitle: generate,
              audit: async (
                _tx: any,
                action: string,
                _type: string,
                id: string,
                metadata: any,
              ) => {
                audits.push({ action, id, metadata });
              },
            }) as any,
        ),
      )
      .use((error: any, _req: any, res: any, _next: any) =>
        res.status(error.status ?? 400).json({ error: "request_failed" }),
      )
      .listen(0);
    const { port } = server.address() as { port: number };
    const request = (id: string, body = {}, deny = false) =>
      fetch(`http://127.0.0.1:${port}/conversations/${id}/title-from-message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(deny ? { "x-test-deny": "true" } : {}),
        },
        body: JSON.stringify(body),
      });
    const create = async (
      body?: string,
      title = "Thread 20",
      tenant = tenantId,
    ) => {
      const [thread] = await db
        .insert(conversations)
        .values({ tenantId: tenant, title, createdBy: actorId })
        .returning();
      const [message] = body
        ? await db
            .insert(messages)
            .values({
              tenantId: tenant,
              conversationId: thread!.id,
              body,
              actorKind: "user",
              authorId: actorId,
            })
            .returning()
        : [];
      return { thread: thread!, message };
    };
    const storedTitle = async (id: string) =>
      (
        await db.select().from(conversations).where(eq(conversations.id, id))
      )[0]!.title;
    try {
      // Exercise both an absent host capability and actual failed/unconfigured providers.
      for (const provider of [
        undefined,
        async () => null,
        async () => {
          throw new Error("Provider unavailable");
        },
      ]) {
        generate = provider;
        const { thread, message } = await create(
          "  Schallschutz\n  für Haus B prüfen  ",
        );
        const response = await request(thread.id, { messageId: message!.id });
        expect(response.status).toBe(201);
        expect((await response.json()).data.title).toBe(
          "Schallschutz für Haus B prüfen",
        );
        expect(await storedTitle(thread.id)).toBe(
          "Schallschutz für Haus B prüfen",
        );
        expect(audits.at(-1)).toEqual({
          action: "knowledge.conversation.title_generated",
          id: thread.id,
          metadata: { messageId: message!.id },
        });
      }

      generate = async ({ message }) =>
        message === "Review the roof insulation"
          ? "Roof insulation review"
          : "Wrong source message";
      const recovered = await create("Review the roof insulation");
      const [later] = await db
        .insert(messages)
        .values({
          tenantId,
          conversationId: recovered.thread.id,
          body: "Discuss costs instead",
          actorKind: "user",
          authorId: actorId,
          createdAt: new Date(Date.now() + 1000),
        })
        .returning();
      expect(
        (
          await (
            await request(recovered.thread.id, { messageId: later!.id })
          ).json()
        ).data.title,
      ).toBe("Thread 20");
      // Recovery does not require the first message to be in the client's loaded page.
      expect(
        (await (await request(recovered.thread.id)).json()).data.title,
      ).toBe("Roof insulation review");
      expect(await storedTitle(recovered.thread.id)).toBe(
        "Roof insulation review",
      );
      generate = async () => "Should never replace an existing title";
      expect(
        (await (await request(recovered.thread.id)).json()).data.title,
      ).toBe("Roof insulation review");
      expect(
        audits.filter((entry) => entry.id === recovered.thread.id),
      ).toHaveLength(1);

      const manual = await create("A different topic", "Agreed project scope");
      expect((await (await request(manual.thread.id)).json()).data.title).toBe(
        "Agreed project scope",
      );
      const racing = await create("Review foundations");
      generate = async () => {
        await db
          .update(conversations)
          .set({ title: "My chosen title" })
          .where(eq(conversations.id, racing.thread.id));
        return "Automatic foundation title";
      };
      expect((await (await request(racing.thread.id)).json()).data.title).toBe(
        "My chosen title",
      );
      expect(await storedTitle(racing.thread.id)).toBe("My chosen title");
      expect(audits.some((entry) => entry.id === racing.thread.id)).toBe(false);

      generate = async () => null;
      const long = await create("Prüfen: " + "Dach ".repeat(30));
      expect((await (await request(long.thread.id)).json()).data.title).toBe(
        "Prüfen: " + "Dach ".repeat(14) + "D…",
      );
      const empty = await create();
      expect((await (await request(empty.thread.id)).json()).data.title).toBe(
        "Thread 20",
      );
      const foreign = await create("Private topic", "Thread 1", foreignTenant);
      expect((await request(foreign.thread.id)).status).toBe(404);
      expect((await request(empty.thread.id, {}, true)).status).toBe(403);
    } finally {
      server.close();
      await db
        .delete(messages)
        .where(inArray(messages.tenantId, [tenantId, foreignTenant]));
      await db
        .delete(conversations)
        .where(inArray(conversations.tenantId, [tenantId, foreignTenant]));
      await pool.end();
    }
  },
);
