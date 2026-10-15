import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { agentMessageInputSchema, agentMessageSchema, type AgentMessage } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { agentRuns, agentRunSteps, agentRunEvents, conversations, messages } from "./schema";
import { recordStep, savedStep, stepHash } from "./run-steps";
import { conflict, missing } from "./workspace";
import { z } from "zod";

type Run = typeof agentRuns.$inferSelect;
const LIMIT = 12;
export const AGENT_MESSAGING_CONTEXT_BYTES = 16384;
const deliveryPolicy = "Same-project messages are persisted in chat only. Delivery does not wake, cancel, or restart a run. Maximum 12 deliveries per sender run.";

/** Validate model references before caching success; delivery still rechecks live access. */
export function validateAgentMessageTargets(output: unknown, context: {
  recipients: { runId: string }[]; inbox: { id: string; sender: { runId: string } }[]; remainingMessages: number;
} | undefined) {
  const outgoing = z.object({ messages: z.array(agentMessageInputSchema).max(3).optional() }).parse(output).messages ?? [];
  const issues: z.ZodIssue[] = [];
  const issue = (path: (string | number)[], reason: string) => issues.push({
    code: "custom", path: ["messages", ...path], message: "Use supplied message recipients and reply targets.", params: { messaging: reason },
  });
  if (outgoing.length > (context?.remainingMessages ?? 0)) issue([], "message_limit");
  outgoing.forEach((message, i) => {
    if (!context?.recipients.some(r => r.runId === message.recipientRunId)) issue([i, "recipientRunId"], "recipient_not_supplied");
    if (message.replyToMessageId) {
      const original = context?.inbox.find(m => m.id === message.replyToMessageId);
      if (!original) issue([i, "replyToMessageId"], "reply_not_supplied");
      else if (original.sender.runId !== message.recipientRunId) issue([i, "recipientRunId"], "reply_recipient_mismatch");
    }
  });
  if (issues.length) throw new z.ZodError(issues);
}

async function deliveryCount(d: AppDeps, runId: string, tx = d.db): Promise<number> {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(agentRunSteps).where(and(
    eq(agentRunSteps.tenantId, d.tenantId), eq(agentRunSteps.runId, runId),
    eq(agentRunSteps.version, 1), eq(agentRunSteps.kind, "agent_message"), eq(agentRunSteps.status, "completed"),
  ));
  return Number(row.count);
}

async function validConversation(d: AppDeps, tx: any, run: Run, includeArchived = false) {
  if (run.tenantId !== d.tenantId || !run.projectId || !run.conversationId) return false;
  const [row] = await tx.select({ id: conversations.id }).from(conversations).where(and(
    eq(conversations.id, run.conversationId), eq(conversations.tenantId, d.tenantId),
    eq(conversations.projectId, run.projectId), includeArchived ? undefined : isNull(conversations.archivedAt),
  )).limit(1);
  return !!row;
}

/** The caller owns the active sender/root fence and the transaction. Never lock or wake the recipient. */
export async function deliverAgentMessage(d: AppDeps, tx: any, sender: Run, rawInput: unknown, stepKey: string) {
  const input = agentMessageInputSchema.parse(rawInput);
  d.requirePermission("agent:run");
  d.requirePermission("knowledge:write");
  d.requirePermission("projects:read");
  if (!sender.projectId || sender.tenantId !== d.tenantId || !(await d.validateProject(sender.projectId)))
    throw missing("Project not found");
  if (!(await validConversation(d, tx, sender))) throw missing("Conversation not found in project");
  if (input.recipientRunId === sender.id) throw conflict("Cannot message the same run");
  const [recipient] = await tx.select().from(agentRuns).where(and(
    eq(agentRuns.id, input.recipientRunId), eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.projectId, sender.projectId),
  )).limit(1);
  if (!recipient || !(await validConversation(d, tx, recipient))) throw missing("Recipient not found in project");
  const inputHash = stepHash(input);
  const saved = await savedStep(d, sender.id, "agent_message", stepKey, undefined, tx);
  if (saved) {
    if (saved.inputHash !== inputHash) throw conflict("Saved message inputs changed. Start a new run instead.");
    return saved.output;
  }
  if (await deliveryCount(d, sender.id, tx) >= LIMIT) throw conflict("Agent message delivery limit reached");

  let recipientParentId: string | undefined;
  if (input.replyToMessageId) {
    const [original] = await tx.select().from(messages).where(and(
      eq(messages.id, input.replyToMessageId), eq(messages.tenantId, d.tenantId), eq(messages.conversationId, sender.conversationId!),
    )).limit(1);
    const metadata = agentMessageSchema.safeParse(original?.agentMessage);
    if (!metadata.success || metadata.data.sender.runId !== recipient.id || metadata.data.recipient.runId !== sender.id
      || metadata.data.sender.conversationId !== recipient.conversationId || metadata.data.recipient.conversationId !== sender.conversationId)
      throw missing("Reply message not found for these participants");
    if (sender.conversationId !== recipient.conversationId) {
      const [mirror] = await tx.select().from(messages).where(and(
        eq(messages.tenantId, d.tenantId), eq(messages.conversationId, recipient.conversationId!),
        sql`${messages.agentMessage}->>'deliveryId' = ${metadata.data.deliveryId}`,
        sql`${messages.agentMessage}->'sender'->>'runId' = ${recipient.id}`,
        sql`${messages.agentMessage}->'recipient'->>'runId' = ${sender.id}`,
      )).limit(1);
      recipientParentId = mirror?.id;
    }
  }
  const participant = (run: Run) => ({ runId: run.id, conversationId: run.conversationId!, role: run.specialistRole, goal: run.goal.slice(0, 500) });
  const envelope: AgentMessage = { deliveryId: randomUUID(), sender: participant(sender), recipient: participant(recipient),
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}) };
  const copies = await tx.insert(messages).values([
    { tenantId: d.tenantId, conversationId: sender.conversationId!, authorId: d.actorId, actorKind: "agent",
      runId: sender.id, body: input.body, agentMessage: envelope, parentMessageId: input.replyToMessageId },
    ...(sender.conversationId === recipient.conversationId ? [] : [{
      tenantId: d.tenantId, conversationId: recipient.conversationId!, authorId: d.actorId, actorKind: "agent",
      runId: sender.id, body: input.body, agentMessage: envelope, parentMessageId: recipientParentId,
    }]),
  ]).returning();
  const receipt = { deliveryId: envelope.deliveryId, senderRunId: sender.id, recipientRunId: recipient.id,
    messageIds: copies.map((row: typeof messages.$inferSelect) => row.id),
    senderMessageId: copies[0].id, recipientMessageId: copies[copies.length - 1].id };
  await recordStep(d, tx, sender, { kind: "agent_message", stepKey, inputHash, input, output: receipt, status: "completed" });
  for (const copy of copies) await d.auditRun(tx, "knowledge.agent_message.delivered", "message", copy.id,
    sender.id, sender.correlationId, receipt);

  // Walk parent chains to include supervisor roots, without leaking cross-project IDs.
  const notify = new Map<string, Run>([[sender.id, sender], [recipient.id, recipient]]);
  for (const start of [sender, recipient]) {
    let current = start;
    const visited = new Set<string>([start.id]);
    while (current.parentRunId && !visited.has(current.parentRunId)) {
      visited.add(current.parentRunId);
      const [parent] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, current.parentRunId),
        eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.projectId, sender.projectId))).limit(1);
      if (!parent) break;
      notify.set(parent.id, parent);
      current = parent;
    }
  }
  for (const run of notify.values()) {
    const [event] = await tx.insert(agentRunEvents).values({ tenantId: d.tenantId, runId: run.id,
      eventType: "thread_message", createdBy: d.actorId, resultSummary: JSON.stringify(receipt),
      paramsSummary: JSON.stringify({ conversationIds: [...new Set(copies.map((copy: typeof messages.$inferSelect) => copy.conversationId))] }),
    }).returning();
    await d.auditRun(tx, "knowledge.agent_run.thread_message", "agent_run", run.id, run.id, run.correlationId, { eventId: event.id, ...receipt });
  }
  return receipt;
}

async function threadRows(d: AppDeps, run: Run, incoming: boolean, limit: number) {
  return d.db.select({ id: messages.id, body: messages.body, agentMessage: messages.agentMessage, createdAt: messages.createdAt })
    .from(messages).where(and(eq(messages.tenantId, d.tenantId), eq(messages.conversationId, run.conversationId!),
      incoming ? sql`${messages.agentMessage}->'recipient'->>'runId' = ${run.id}` : or(
        sql`${messages.agentMessage}->'sender'->>'runId' = ${run.id}`,
        sql`${messages.agentMessage}->'recipient'->>'runId' = ${run.id}`,
      ),
    )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit);
}

export async function runThreadMessages(d: AppDeps, run: Run) {
  if (!(await validConversation(d, d.db, run, true)) || !(await d.validateProject(run.projectId!))) return [];
  return (await threadRows(d, run, false, 100)).reverse();
}

export async function agentMessagingContext(d: AppDeps, run: Run) {
  const empty = { selfRunId: run.id, recipients: [], inbox: [], remainingMessages: 0, deliveryPolicy };
  if (!(await validConversation(d, d.db, run)) || !(await d.validateProject(run.projectId!))) return empty;
  const recipients = await d.db.select({ runId: agentRuns.id, conversationId: agentRuns.conversationId,
    role: agentRuns.specialistRole, goal: sql<string>`left(${agentRuns.goal}, 500)`, status: agentRuns.status })
    .from(agentRuns).innerJoin(conversations, and(eq(conversations.id, agentRuns.conversationId),
      eq(conversations.tenantId, d.tenantId), eq(conversations.projectId, run.projectId!), isNull(conversations.archivedAt)))
    .where(and(eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.projectId, run.projectId!), ne(agentRuns.id, run.id)))
    .orderBy(sql`case when ${agentRuns.id} = ${run.parentRunId ?? run.id} then 0
      when ${agentRuns.parentRunId} = ${run.parentRunId ?? run.id} then 1 else 2 end`, desc(agentRuns.createdAt), desc(agentRuns.id)).limit(30);
  const incoming = await threadRows(d, run, true, 12);
  const inbox = incoming.map((message: typeof messages.$inferSelect) => ({
    id: message.id, body: message.body.slice(0, 1000), truncated: message.body.length > 1000,
    sender: { runId: message.agentMessage!.sender.runId, role: message.agentMessage!.sender.role },
  })).reverse();
  // Reserve a hard byte bound in source batching. Full messages remain in chat;
  // context explicitly reports omissions rather than crowding out source evidence.
  while (Buffer.byteLength(JSON.stringify(inbox), "utf8") > 8192) inbox.shift();
  const result = { selfRunId: run.id, recipients, inbox, inboxTruncated: incoming.length >= 12 || inbox.length < incoming.length,
    recipientsTruncated: recipients.length >= 30,
    remainingMessages: Math.max(0, LIMIT - await deliveryCount(d, run.id)), deliveryPolicy };
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > AGENT_MESSAGING_CONTEXT_BYTES && recipients.length) {
    recipients.pop();
    result.recipientsTruncated = true;
  }
  return result;
}
