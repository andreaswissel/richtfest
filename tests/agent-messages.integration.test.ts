import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";
import { agentMessagingContext, deliverAgentMessage, runThreadMessages } from "../richtfest-apps/knowledge/src/agent-messages";
import { executeRun, runsRouter } from "../richtfest-apps/knowledge/src/runs";
import { createSupervisor, stepSupervisor } from "../richtfest-apps/knowledge/src/supervisor";
import { workspaceRouter } from "../richtfest-apps/knowledge/src/workspace";
import { agentRuns, agentRunSteps, agentRunEvents, agentRunAttempts, agentRunUsage, supervisorRuns,
  conversations, messages, tasks, artifacts, artifactRevisions } from "../richtfest-apps/knowledge/src/schema";

const integration = process.env.DATABASE_URL ? test : test.skip;
async function fixture() {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), otherTenant = crypto.randomUUID(), projectId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const d: AppDeps = {
    db, tenantId, actorId, requirePermission: () => {}, audit: async () => {}, auditRun: async () => {},
    validateProject: async id => id === projectId, validateSource: async () => true, validateSourceVersion: async () => true,
    validateUser: async () => true, validateConversation: async () => true, cancelExecution: () => {},
    providerConfigured: async () => true, sourceReferences: async () => [], resolveSource: async () => ({}),
    listProjectSources: async () => ({ sources: [], truncated: false, authority: "unreviewed_source_inventory" }),
    executeProvider: async () => { throw new Error("Unexpected provider call"); },
  };
  const threads = await db.insert(conversations).values([
    { tenantId, projectId, title: "Façade", createdBy: actorId },
    { tenantId, projectId, title: "Acoustics", createdBy: actorId },
    { tenantId, projectId: crypto.randomUUID(), title: "Other project", createdBy: actorId },
    { tenantId: otherTenant, projectId, title: "Other tenant", createdBy: actorId },
    { tenantId, projectId, title: "Archived", createdBy: actorId, archivedAt: new Date() },
  ]).returning();
  const runs = await db.insert(agentRuns).values(threads.map(thread => ({
    tenantId: thread.tenantId, projectId: thread.projectId, conversationId: thread.id,
    goal: thread.title, provider: "openai", status: "queued", requestedBy: actorId, correlationId: crypto.randomUUID(),
  }))).returning();
  const send = (sender: typeof agentRuns.$inferSelect, input: unknown, key: string, deps = d) => db.transaction(async tx => {
    await tx.select().from(agentRuns).where(eq(agentRuns.id, sender.id)).for("update");
    return deliverAgentMessage(deps, tx, sender, input, key);
  });
  const cleanup = async () => {
    for (const tenant of [tenantId, otherTenant])
      for (const table of [artifactRevisions, artifacts, agentRunSteps, agentRunAttempts, agentRunUsage, agentRunEvents, supervisorRuns, messages, tasks, agentRuns, conversations])
        await db.delete(table).where(eq(table.tenantId, tenant));
    await pool.end();
  };
  return { db, d, threads, runs, send, cleanup };
}

integration("agent messages are scoped, atomic, retry-safe, reply-linked and live after recipient completion", async () => {
  const { db, d, threads, runs, send, cleanup } = await fixture();
  const [sender, recipient, otherProject, otherTenant, archived] = runs;
  const server = express().use(workspaceRouter(() => d)).use(runsRouter(() => d))
    .use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message })).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController();
  try {
    const before = (await db.select().from(agentRuns).where(eq(agentRuns.id, recipient!.id)))[0];
    const input = { recipientRunId: recipient!.id, body: "Which glazing revision should we use?" };
    const [first, retry] = await Promise.all([send(sender!, input, "exchange:1"), send(sender!, input, "exchange:1")]);
    expect(retry).toEqual(first);
    expect(await runThreadMessages(d, sender!)).toHaveLength(1);
    expect(await runThreadMessages(d, recipient!)).toHaveLength(1);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, recipient!.id)))[0]).toEqual(before);
    const context = await agentMessagingContext(d, recipient!);
    expect(context.inbox).toMatchObject([{ id: first.recipientMessageId, body: input.body, sender: { runId: sender!.id } }]);
    expect(context.recipients.map((r: any) => r.runId)).toEqual([sender!.id]);
    for (const target of [sender, otherProject, otherTenant, archived])
      await expect(send(sender!, { ...input, recipientRunId: target!.id }, "rejected")).rejects.toThrow();
    await expect(send(sender!, { ...input, body: "Changed intent" }, "exchange:1")).rejects.toThrow("Saved message inputs changed");
    await expect(send(sender!, input, "denied", { ...d, requirePermission: key => {
      if (key === "knowledge:write") throw new Error("forbidden");
    } })).rejects.toThrow("forbidden");
    await expect(send(sender!, input, "rollback", { ...d, auditRun: async () => { throw new Error("rollback"); } })).rejects.toThrow("rollback");
    expect(await runThreadMessages(d, sender!)).toHaveLength(1);
    expect((await agentMessagingContext(d, sender!)).remainingMessages).toBe(11);

    const reply = await send(recipient!, { recipientRunId: sender!.id, body: "Keep both revisions as conflicting evidence.", replyToMessageId: first.recipientMessageId }, "reply:1");
    const replyRows = await db.select().from(messages).where(eq(messages.runId, recipient!.id));
    expect(replyRows.find(row => row.id === reply.senderMessageId)!.parentMessageId).toBe(first.recipientMessageId);
    expect(replyRows.find(row => row.id === reply.recipientMessageId)!.parentMessageId).toBe(first.senderMessageId);
    await expect(send(sender!, { ...input, replyToMessageId: first.senderMessageId }, "bad-reply")).rejects.toThrow();
    const [sibling] = await db.insert(agentRuns).values({ ...sender!, id: crypto.randomUUID(), parentRunId: sender!.id, specialistRole: "source_reviewer" }).returning();
    const same = await send(sender!, { recipientRunId: sibling!.id, body: "Please check both revisions." }, "same-thread");
    expect(same.messageIds).toHaveLength(1);
    const detail = await (await fetch(`${base}/runs/${sibling!.id}`)).json() as any;
    expect(detail.data.threadMessages.map((row: any) => row.body)).toEqual(["Please check both revisions."]);
    const page = await (await fetch(`${base}/conversations/${threads[0]!.id}/messages`)).json() as any;
    expect(page.data.items.filter((row: any) => row.agentMessage)).toHaveLength(3);

    await db.update(agentRuns).set({ status: "needs_review", outputSummary: "Original completed result" }).where(eq(agentRuns.id, recipient!.id));
    const response = await fetch(`${base}/conversations/${threads[1]!.id}/message-events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"count":2');
    await send(sender!, { ...input, body: "A later finding, without waking you." }, "late-message");
    let received = "";
    for (let i = 0; i < 4 && !received.includes('"count":3'); i++)
      received += new TextDecoder().decode((await reader.read()).value);
    expect(received).toContain('"count":3');
    controller.abort();
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, recipient!.id)))[0]).toMatchObject({ status: "needs_review", outputSummary: "Original completed result", generation: 0 });
    for (let i = 3; i < 12; i++) await send(sender!, { ...input, body: "ä".repeat(4000) }, `bounded:${i}`);
    await expect(send(sender!, input, "overflow")).rejects.toThrow("limit reached");
    expect(await send(sender!, input, "exchange:1")).toEqual(first);
    const bounded = await agentMessagingContext(d, recipient!);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(16384);
    expect(bounded.inbox.some((row: any) => row.truncated)).toBe(true);
  } finally {
    controller.abort(); server.close(); server.closeAllConnections(); await cleanup();
  }
}, 15000);

integration("direct tools and supervisor specialists deliver messages into the next model step", async () => {
  const { db, d, runs, send, cleanup } = await fixture();
  const [coordinator, external] = runs;
  const model = { modelId: "test-model", maxOutputTokens: 1024, maxSteps: 1 };
  try {
    let directCalls = 0;
    d.executeProvider = async input => {
      directCalls++;
      const context = input.context as any;
      expect(context.messaging.recipients.some((r: any) => r.runId === coordinator!.id)).toBe(true);
      return { status: "completed", output: { summary: "Request sent.", rationale: "Need the current revision.", citations: [], tools: input.toolResults?.length ? [] : [
        { name: "send_thread_message", input: { recipientRunId: coordinator!.id, body: "Please identify the authoritative revision." } },
      ] } };
    };
    await executeRun(d, external!);
    expect(directCalls).toBe(2);
    expect((await runThreadMessages(d, coordinator!))[0].body).toBe("Please identify the authoritative revision.");
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, external!.id)))[0]!.status).toBe("needs_review");
    let specialistId = "";
    let sawReply = false;
    d.executeSupervisor = async input => {
      const context = input.context as any;
      if (input.phase === "plan") {
        expect(context.messaging.inbox[0].body).toBe("Please identify the authoritative revision.");
        return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Check glazing", sourceVersionIds: [] }] } };
      }
      if (input.phase === "specialist") {
        specialistId = input.runId;
        expect(context.messaging.inbox[0].body).toBe("Check the conflicting schedules.");
        return { status: "completed", output: { summary: "Revision conflict remains.", rationale: "Needs a human source decision.", citations: [], messages: [
          { recipientRunId: coordinator!.id, body: "Both revisions remain unverified.", replyToMessageId: context.messaging.inbox[0].id },
        ] } };
      }
      sawReply = context.messaging.inbox.some((message: any) => message.body === "Both revisions remain unverified." && message.sender.runId === specialistId);
      return { status: "completed", output: { summary: "Awaiting the source decision.", rationale: "Conflicting revisions.", citations: [], decision: "accept", revisions: [],
        document: { title: "Revision conflict", content: "Confirm the authoritative glazing revision before proceeding." } } };
    };
    await createSupervisor(d, db, coordinator!, "medium", { provider: "openai", effort: "medium", version: 1, source: "vendor",
      supervisor: model, specialists: { source_reviewer: model, requirements_reviewer: model }, maxParallel: 2, maxTasks: 4, maxRevisions: 2 });
    await stepSupervisor(d, coordinator!.id);
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, coordinator!.id));
    const assignment = (state!.assignments as any[])[0];
    expect(assignment).toBeDefined();
    await send(coordinator!, { recipientRunId: assignment.runId, body: "Check the conflicting schedules." }, "coordinator-question");
    await stepSupervisor(d, coordinator!.id);
    await stepSupervisor(d, coordinator!.id);
    expect(sawReply).toBe(true);
    expect((await runThreadMessages(d, coordinator!)).map((message: any) => message.body)).toEqual([
      "Please identify the authoritative revision.", "Check the conflicting schedules.", "Both revisions remain unverified.",
    ]);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, coordinator!.id)))[0]!.status).toBe("needs_review");
  } finally { await cleanup(); }
}, 15000);
