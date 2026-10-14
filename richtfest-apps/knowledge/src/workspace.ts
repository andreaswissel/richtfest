import { repairLegacyRuns } from "./run-recovery";
import { Router, type Request } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ok, acousticDocumentTemplateSchema, agentBudgetDecisionSchema } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { sanitizeProviderDiagnostics } from "./deps";
import {
  annotations,
  artifacts,
  artifactRevisions,
  conversations,
  conversationReads,
  messages,
  agentRuns,
  agentRunEvents,
  supervisorRuns,
  tasks,
} from "./schema";
import { attachUsageSummaries } from "./usage";
import { prepareArtifactPdf, queueArtifactPdf } from "./artifact-pdf-exports";
import { projectAgentAnalytics } from "./analytics";

export const missing = (message = "Record not found") =>
  Object.assign(new Error(message), { status: 404, code: "not_found" });
export const conflict = (message: string) =>
  Object.assign(new Error(message), { status: 409, code: "invalid_state" });

/** Bounded, revision-specific human feedback for every phase of a subsequent run. */
export async function artifactReviewContext(d: AppDeps, conversationId: string | null) {
  if (!conversationId) return { comments: [], documents: [] };
  const rows = await d.db.select({
    revisionId: artifactRevisions.id, title: artifactRevisions.title,
    content: sql<string>`left(${artifactRevisions.content}, 12000)`,
    contentLength: sql<number>`length(${artifactRevisions.content})`,
    body: annotations.body, quote: annotations.quote,
  }).from(annotations)
    .innerJoin(messages, and(eq(annotations.messageId, messages.id), eq(messages.tenantId, d.tenantId)))
    .innerJoin(artifactRevisions, and(eq(annotations.artifactRevisionId, artifactRevisions.id), eq(artifactRevisions.tenantId, d.tenantId)))
    .where(and(eq(annotations.tenantId, d.tenantId), eq(messages.conversationId, conversationId)))
    .orderBy(desc(annotations.createdAt)).limit(10);
  let budget = 24000;
  const documents = new Map<string, { revisionId: string; title: string; excerpt: string; truncated: boolean }>();
  for (const row of rows) {
    if (documents.has(row.revisionId)) continue;
    const excerpt = row.content.slice(0, budget);
    budget -= excerpt.length;
    documents.set(row.revisionId, { revisionId: row.revisionId, title: row.title, excerpt, truncated: excerpt.length < row.contentLength });
  }
  return {
    comments: rows.map((row: any) => ({ revisionId: row.revisionId, body: row.body.slice(0, 2000), quote: row.quote?.slice(0, 2000) })),
    documents: [...documents.values()],
  };
}
// The web client uses this format when a thread has not received a meaningful title yet.
// Keep this deliberately narrow so a user-chosen title is never overwritten.
export const isGeneratedConversationPlaceholder = (title: string) =>
  /^Thread\s+\d+$/i.test(title.trim());
export async function conversation(d: AppDeps, id: string, projectId?: string) {
  const [row] = await d.db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.id, id), eq(conversations.tenantId, d.tenantId)),
    );
  if (!row || (projectId && row.projectId !== projectId))
    throw missing("Conversation not found in project");
  return row;
}
export async function sources(
  d: AppDeps,
  projectId: string | null,
  ids: string[],
) {
  if (ids.length && !projectId) throw missing("Sources require a project");
  for (const id of ids)
    if (!(await d.validateSourceVersion(projectId!, id)))
      throw missing("Source version not found in project");
}
const revisionInput = z.object({
  title: z.string().trim().min(1).max(300),
  // Editable headroom for a 200k-character generated document plus review notes.
  content: z.string().max(500000),
  payload: z
    .object({
      kind: z.enum(["table", "checklist", "summary"]),
      template: acousticDocumentTemplateSchema.optional(),
      data: z
        .array(
          z.record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.null()]),
          ),
        )
        .max(1000),
    })
    .optional(),
  sourceVersionIds: z.array(z.string().uuid()).max(100).default([]),
});
export const artifactInput = revisionInput.extend({
  projectId: z.string().uuid(),
  type: z.enum(["document", "openui", "draft", "report"]).default("document"),
});
export async function createArtifact(
  d: AppDeps,
  tx: any,
  input: z.infer<typeof artifactInput>,
  runId?: string,
) {
  const [artifact] = await tx
    .insert(artifacts)
    .values({
      tenantId: d.tenantId,
      projectId: input.projectId,
      title: input.title,
      type: input.type,
      createdBy: d.actorId,
      runId,
      status: "draft",
    })
    .returning();
  const [revision] = await tx
    .insert(artifactRevisions)
    .values({
      tenantId: d.tenantId,
      artifactId: artifact.id,
      version: 1,
      title: input.title,
      content: input.content,
      payload: input.payload,
      sourceVersionIds: input.sourceVersionIds,
      createdBy: d.actorId,
    })
    .returning();
  await queueArtifactPdf(d, tx, revision.id);
  await d.audit(tx, "knowledge.artifact.created", "artifact", artifact.id, {
    revisionId: revision.id,
    runId,
  });
  await d.audit(
    tx,
    "knowledge.artifact_revision.created",
    "artifact_revision",
    revision.id,
    { artifactId: artifact.id, runId },
  );
  return { artifact, revision };
}
async function readState(d: AppDeps, id: string) {
  const [state] = await d.db
    .select()
    .from(conversationReads)
    .where(
      and(
        eq(conversationReads.tenantId, d.tenantId),
        eq(conversationReads.userId, d.actorId),
        eq(conversationReads.conversationId, id),
      ),
    );
  const [count] = await d.db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, d.tenantId),
        eq(messages.conversationId, id),
        sql`(${messages.authorId} <> ${d.actorId} or ${messages.actorKind} <> 'user')`,
        state?.readAt
          ? sql`${messages.createdAt} > ${state.readAt}`
          : undefined,
      ),
    );
  return { readState: state ?? null, unreadCount: count.count };
}
async function enrichAnnotations(d: AppDeps, items: any[]) {
  const ids = items.flatMap((m) => (m.annotationId ? [m.annotationId] : []));
  if (!ids.length) return items;
  const notes = await d.db
    .select({
      id: annotations.id,
      page: annotations.page,
      quote: annotations.quote,
      sourceVersionId: annotations.sourceVersionId,
      artifactRevisionId: annotations.artifactRevisionId,
      artifactId: artifactRevisions.artifactId,
    })
    .from(annotations)
    .leftJoin(
      artifactRevisions,
      and(
        eq(artifactRevisions.id, annotations.artifactRevisionId),
        eq(artifactRevisions.tenantId, d.tenantId),
      ),
    )
    .where(
      and(eq(annotations.tenantId, d.tenantId), inArray(annotations.id, ids)),
    );
  return items.map((m) => ({
    ...m,
    annotation: notes.find((n: any) => n.id === m.annotationId) ?? null,
  }));
}

async function withSourceReferences(d: AppDeps, projectId: string | null, items: any[]) {
  const ids = (item: any): string[] => Array.isArray(item.sourceVersionIds)
    ? item.sourceVersionIds.filter((id: unknown) => z.string().uuid().safeParse(id).success) : [];
  const allIds = [...new Set(items.flatMap(ids))];
  const references = projectId && allIds.length ? await d.sourceReferences(projectId, allIds) : [];
  return items.map(item => ({ ...item, sourceReferences: references.filter(source => ids(item).includes(source.versionId)) }));
}

/** Batch the terminal call diagnostic into the workspace, including a failed child. */
async function withFailureDetails(d: AppDeps, runs: any[]) {
  const failed = runs.filter(run => run.status === "failed");
  if (!failed.length) return runs;
  const events = await d.db.select().from(agentRunEvents).where(and(
    eq(agentRunEvents.tenantId, d.tenantId),
    inArray(agentRunEvents.runId, failed.map(run => run.id)),
    inArray(agentRunEvents.eventType, ["provider_call_failed", "provider_attempt_failed", "budget_stopped", "resumed", "steered"]),
  )).orderBy(desc(agentRunEvents.createdAt));
  const parsed = events.flatMap((event: any) => {
    try {
      const metadata = JSON.parse(event.paramsSummary ?? "null");
      if (!metadata || !z.string().uuid().safeParse(metadata.runId).success) return [];
      return [{ event, metadata }];
    } catch { return []; }
  });
  const owners = parsed.length ? await d.db.select({ id: agentRuns.id, parentRunId: agentRuns.parentRunId, specialistRole: agentRuns.specialistRole })
    .from(agentRuns).where(and(eq(agentRuns.tenantId, d.tenantId), inArray(agentRuns.id, parsed.map((item: any) => item.metadata.runId)))) : [];
  return runs.map(run => {
    if (run.status !== "failed") return run;
    const phase = /(?:^|;)\s*phase=([a-z_]+)/.exec(run.error ?? "")?.[1];
    const budgetStopped = /(?:^|;)\s*category=budget(?:;|$)/.test(run.error ?? "");
    const resumed = events.find((event: any) => event.runId === run.id && ["resumed", "steered"].includes(event.eventType));
    const match = parsed.find(({ event, metadata }: any) => event.runId === run.id
      && (!resumed || event.createdAt >= resumed.createdAt)
      && (budgetStopped ? event.eventType === "budget_stopped" : ["provider_call_failed", "provider_attempt_failed"].includes(event.eventType))
      && (!phase || event.resultSummary?.split(";")[0] === phase)
      && owners.some((owner: any) => owner.id === metadata.runId && (owner.id === run.id || owner.parentRunId === run.id)));
    if (!match) return run;
    const owner = owners.find((owner: any) => owner.id === match.metadata.runId);
    const budget = agentBudgetDecisionSchema.safeParse(match.metadata.budget);
    return { ...run, failureRole: owner?.specialistRole ?? "supervisor", failureEvent: {
      eventType: budgetStopped ? "budget_stopped" : "provider_call_failed", resultSummary: phase ?? match.event.resultSummary?.split(";")[0],
      paramsSummary: JSON.stringify({ runId: owner.id, callId: match.metadata.callId, attempt: match.metadata.attempt,
        ...(budgetStopped && budget.success ? { budget: budget.data } : {}),
        providerStatus: match.metadata.providerStatus,
        diagnostics: sanitizeProviderDiagnostics(match.metadata.diagnostics) }),
    } };
  });
}
export function workspaceRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  // A conversation remains subscribable after its runs finish. Run activity
  // streams deliberately close at completion and cannot deliver late messages.
  router.get("/conversations/:conversationId/message-events", async (req, res, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      d.requirePermission("projects:read");
      const id = z.string().uuid().parse(req.params.conversationId);
      const thread = await conversation(d, id);
      if (!thread.projectId || !(await d.validateProject(thread.projectId))) throw missing();
      req.on("close", () => { closed = true; if (timer) clearTimeout(timer); });
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      let previous: number | undefined;
      const poll = async () => {
        if (closed) return;
        try {
          await conversation(d, id, thread.projectId);
          const [row] = await d.db.select({ count: sql<number>`count(*)::int` }).from(messages).where(and(
            eq(messages.tenantId, d.tenantId), eq(messages.conversationId, id), sql`${messages.agentMessage} is not null`,
          ));
          if (row.count !== previous) {
            res.write(`event: messages\ndata: ${JSON.stringify({ conversationId: id, count: row.count })}\n\n`);
            previous = row.count;
          } else res.write(": heartbeat\n\n");
          if (!closed) timer = setTimeout(poll, 1500);
        } catch { res.end(); }
      };
      void poll();
    } catch (error) { next(error); }
  });
  const route = (
    method: "get" | "post" | "put",
    path: string,
    permission: "knowledge:read" | "knowledge:write",
    handler: (d: AppDeps, req: Request) => Promise<unknown>,
  ) =>
    router[method](path, async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission(permission);
        res
          .status(method === "post" ? 201 : 200)
          .json(ok(await handler(d, req)));
      } catch (e) {
        next(e);
      }
    });
  route(
    "get",
    "/projects/:projectId/sources/:versionId/content",
    "knowledge:read",
    async (d, req) => {
      const projectId = z.string().uuid().parse(req.params.projectId);
      const versionId = z.string().uuid().parse(req.params.versionId);
      const range = z
        .object({
          pageStart: z.coerce.number().int().positive().optional(),
          pageEnd: z.coerce.number().int().positive().optional(),
          entityKey: z.string().min(1).max(200).optional(),
          modelOffset: z.coerce.number().int().min(0).max(1000000).optional(),
        })
        .refine((v) => !v.pageEnd || v.pageEnd >= (v.pageStart ?? 1))
        .parse(req.query);
      if (!(await d.validateProject(projectId))) throw missing();
      await sources(d, projectId, [versionId]);
      return d.resolveSource(projectId, { versionId, ...range });
    },
  );
  route("get", "/workspaces/:projectId/analytics", "knowledge:read", async (d, req) => {
    const id = z.string().uuid().parse(req.params.projectId);
    const { page } = z.object({ page: z.coerce.number().int().min(0).max(100000).default(0) }).parse(req.query);
    if (!(await d.validateProject(id))) throw missing("Project not found");
    return projectAgentAnalytics(d, id, page);
  });
  route("get", "/workspaces/:projectId", "knowledge:read", async (d, req) => {
    const id = z.string().uuid().parse(req.params.projectId);
    if (!(await d.validateProject(id))) throw missing("Project not found");
    await repairLegacyRuns(d, {projectId:id});
    const [threads, artifactRows, runs, taskRows, states, counts] =
      await Promise.all([
        d.db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, d.tenantId),
              eq(conversations.projectId, id),
            ),
          )
          .orderBy(desc(conversations.createdAt)),
        d.db
          .select({
            ...getTableColumns(artifacts),
            conversationId: agentRuns.conversationId,
            runGoal: agentRuns.goal,
            preview: sql<string>`(select left(r.content, 500) from knowledge_artifact_revisions r where r.artifact_id=${artifacts.id} and r.tenant_id=${d.tenantId} order by r.version desc limit 1)`,
            version: sql<number>`(select max(r.version) from knowledge_artifact_revisions r where r.artifact_id=${artifacts.id} and r.tenant_id=${d.tenantId})`,
          })
          .from(artifacts)
          .leftJoin(agentRuns, and(eq(artifacts.runId, agentRuns.id), eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.projectId, id)))
          .where(
            and(
              eq(artifacts.tenantId, d.tenantId),
              eq(artifacts.projectId, id),
            ),
          )
          .orderBy(desc(artifacts.createdAt)),
        d.db
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.tenantId, d.tenantId),
              eq(agentRuns.projectId, id),
            ),
          )
          .orderBy(desc(agentRuns.createdAt))
          .limit(50),
        d.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.tenantId, d.tenantId), eq(tasks.projectId, id))),
        d.db
          .select()
          .from(conversationReads)
          .where(
            and(
              eq(conversationReads.tenantId, d.tenantId),
              eq(conversationReads.userId, d.actorId),
            ),
          ),
        d.db.execute(
          sql`select m.conversation_id, count(*)::int as count from knowledge_messages m join knowledge_conversations c on c.id=m.conversation_id and c.tenant_id=m.tenant_id left join knowledge_conversation_reads r on r.conversation_id=m.conversation_id and r.tenant_id=m.tenant_id and r.user_id=${d.actorId} where m.tenant_id=${d.tenantId} and c.project_id=${id} and (m.author_id<>${d.actorId} or m.actor_kind<>'user') and (r.read_at is null or m.created_at>r.read_at) group by m.conversation_id`,
        ),
      ]);
    const supervisorIds = runs.length
      ? await d.db
          .select({ runId: supervisorRuns.runId })
          .from(supervisorRuns)
          .where(
            and(
              eq(supervisorRuns.tenantId, d.tenantId),
              inArray(
                supervisorRuns.runId,
                runs.map((run: any) => run.id),
              ),
            ),
          )
      : [];
    const supervisors = new Set(
      supervisorIds.map((run: { runId: string }) => run.runId),
    );
    const enrichedRuns = await withFailureDetails(d, await attachUsageSummaries(d, runs));
    return {
      conversations: threads.map((t: any) => ({
        ...t,
        readState: states.find((s: any) => s.conversationId === t.id) ?? null,
        unreadCount:
          counts.rows.find((c: any) => c.conversation_id === t.id)?.count ?? 0,
      })),
      artifacts: artifactRows,
      runs: enrichedRuns.map((run: any) => ({
        ...run,
        isSupervisor: supervisors.has(run.id),
      })),
      tasks: taskRows,
    };
  });
  route(
    "get",
    "/conversations/:conversationId/messages",
    "knowledge:read",
    async (d, req) => {
      const id = String(req.params.conversationId);
      const thread = await conversation(d, id);
      const query = z
        .object({
          before: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          q: z.string().max(300).optional(),
        })
        .parse(req.query);
      let before;
      if (query.before) {
        [before] = await d.db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.id, query.before),
              eq(messages.conversationId, id),
              eq(messages.tenantId, d.tenantId),
            ),
          );
        if (!before) throw missing("Cursor not found");
      }
      const rows = await d.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, d.tenantId),
            eq(messages.conversationId, id),
            before
              ? sql`(${messages.createdAt},${messages.id}) < (select created_at,id from knowledge_messages where id=${before.id}::uuid and tenant_id=${d.tenantId}::uuid)`
              : undefined,
            query.q
              ? sql`strpos(lower(${messages.body}),lower(${query.q})) > 0`
              : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      const items = await withSourceReferences(d, thread.projectId, await enrichAnnotations(
        d,
        rows.slice(0, query.limit).reverse(),
      ));
      return {
        items,
        nextCursor: more ? items[0].id : null,
        ...(await readState(d, id)),
      };
    },
  );
  route(
    "get",
    "/conversations/:conversationId/messages/:messageId",
    "knowledge:read",
    async (d, req) => {
      const thread = await conversation(d, String(req.params.conversationId));
      const [row] = await d.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, String(req.params.messageId)),
            eq(messages.conversationId, String(req.params.conversationId)),
            eq(messages.tenantId, d.tenantId),
          ),
        );
      if (!row) throw missing();
      return (await withSourceReferences(d, thread.projectId, await enrichAnnotations(d, [row])))[0];
    },
  );
  route(
    "post",
    "/conversations/:conversationId/messages",
    "knowledge:write",
    async (d, req) => {
      const id = String(req.params.conversationId);
      const thread = await conversation(d, id);
      const input = z
        .object({
          body: z.string().trim().min(1).max(20000),
          sourceRef: z.string().max(1000).optional(),
          parentMessageId: z.string().uuid().optional(),
          sourceVersionIds: z.array(z.string().uuid()).max(100).default([]),
        })
        .parse(req.body);
      await sources(d, thread.projectId, input.sourceVersionIds);
      if (input.parentMessageId) {
        const [parent] = await d.db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.id, input.parentMessageId),
              eq(messages.conversationId, id),
              eq(messages.tenantId, d.tenantId),
            ),
          );
        if (!parent) throw missing("Parent message not found in conversation");
      }
      return d.db.transaction(async (tx: any) => {
        const [row] = await tx
          .insert(messages)
          .values({
            ...input,
            tenantId: d.tenantId,
            conversationId: id,
            authorId: d.actorId,
            actorKind: "user",
          })
          .returning();
        await d.audit(tx, "knowledge.message.created", "message", row.id, {
          conversationId: id,
        });
        return row;
      });
    },
  );
  route(
    "post",
    "/conversations/:conversationId/title-from-message",
    "knowledge:write",
    async (d, req) => {
      const id = String(req.params.conversationId);
      const thread = await conversation(d, id);
      const input = z
        .object({ messageId: z.string().uuid().optional() })
        .strict()
        .parse(req.body);

      // This endpoint is intentionally idempotent. A retry after a successful
      // update, or a request for a renamed thread, returns the current title.
      if (!isGeneratedConversationPlaceholder(thread.title))
        return { title: thread.title };

      const [firstUserMessage] = await d.db
        .select({ id: messages.id, body: messages.body })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, d.tenantId),
            eq(messages.conversationId, id),
            eq(messages.actorKind, "user"),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(1);
      if (
        !firstUserMessage ||
        (input.messageId && firstUserMessage.id !== input.messageId)
      )
        return { title: thread.title };

      let generated: string | null = null;
      try {
        generated =
          (await d.generateConversationTitle?.({
            message: firstUserMessage.body,
          })) ?? null;
      } catch {
        // Provider failures must not turn a successful message into an error.
        generated = null;
      }
      // A missing connection or failed provider must not leave a useful
      // conversation with a numbered title. Keep this fallback provider-free.
      if (!generated) {
        const excerpt = firstUserMessage.body
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        generated = excerpt.length > 80 ? `${excerpt.slice(0, 79).trimEnd()}…` : excerpt;
      }
      if (!generated) return { title: thread.title };

      return d.db.transaction(async (tx: any) => {
        const [updated] = await tx
          .update(conversations)
          .set({ title: generated })
          .where(
            and(
              eq(conversations.id, id),
              eq(conversations.tenantId, d.tenantId),
              // Preserve a title edited while the provider was running.
              eq(conversations.title, thread.title),
            ),
          )
          .returning();
        if (!updated) {
          const [current] = await tx
            .select({ title: conversations.title })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, id),
                eq(conversations.tenantId, d.tenantId),
              ),
            );
          return { title: current?.title ?? thread.title };
        }
        await d.audit(
          tx,
          "knowledge.conversation.title_generated",
          "conversation",
          id,
          { messageId: firstUserMessage.id },
        );
        return { title: updated.title };
      });
    },
  );
  route(
    "put",
    "/conversations/:conversationId/read",
    "knowledge:read",
    async (d, req) => {
      const id = String(req.params.conversationId);
      await conversation(d, id);
      const input = z
        .object({
          lastReadMessageId: z.string().uuid().optional(),
          meaningfulMessageId: z.string().uuid().optional(),
          composerDraft: z.string().max(20000).optional(),
        })
        .parse(req.body);
      let readAt: Date | undefined;
      for (const messageId of [
        input.lastReadMessageId,
        input.meaningfulMessageId,
      ]) {
        if (!messageId) continue;
        const [message] = await d.db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.id, messageId),
              eq(messages.conversationId, id),
              eq(messages.tenantId, d.tenantId),
            ),
          );
        if (!message) throw missing("Message not found in conversation");
        if (messageId === input.lastReadMessageId) readAt = message.createdAt;
      }
      return d.db.transaction(async (tx: any) => {
        const values = {
          ...input,
          ...(readAt ? { readAt } : {}),
          updatedAt: new Date(),
        };
        const [row] = await tx
          .insert(conversationReads)
          .values({
            ...values,
            tenantId: d.tenantId,
            conversationId: id,
            userId: d.actorId,
          })
          .onConflictDoUpdate({
            target: [
              conversationReads.tenantId,
              conversationReads.conversationId,
              conversationReads.userId,
            ],
            set: values,
          })
          .returning();
        await d.audit(
          tx,
          "knowledge.conversation.read_state_updated",
          "conversation",
          id,
        );
        return row;
      });
    },
  );
  route("post", "/artifacts", "knowledge:write", async (d, req) => {
    const input = artifactInput.parse(req.body);
    if (!(await d.validateProject(input.projectId)))
      throw missing("Project not found");
    await sources(d, input.projectId, input.sourceVersionIds);
    return d.db.transaction((tx: any) => createArtifact(d, tx, input));
  });
  router.get(
    "/artifacts/:artifactId/revisions/:revisionId/pdf",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("knowledge:read");
        const artifactId = z.string().uuid().parse(req.params.artifactId);
        const revisionId = z.string().uuid().parse(req.params.revisionId);
        let pdf = await prepareArtifactPdf(d, artifactId, revisionId);
        const deadline = Date.now() + 120_000;
        // Cold legacy exports and downloads during preparation share the worker's lease.
        while (!pdf && Date.now() < deadline && !res.destroyed) {
          await new Promise(resolve => setTimeout(resolve, 500));
          pdf = await prepareArtifactPdf(d, artifactId, revisionId);
        }
        if (res.destroyed) return;
        if (!pdf) throw Object.assign(new Error("PDF is still preparing. Please try again shortly."),
          { status: 503, code: "pdf_preparing" });
        const filename = `${pdf.title}`
          .normalize("NFKD")
          .replace(/[^\w -]/g, "")
          .trim()
          .replace(/[\s-]+/g, "-")
          .slice(0, 80) || "richtfest-artifact";
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Length", String(pdf.sizeBytes));
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}-v${pdf.version}.pdf"`,
        );
        res.setHeader("Cache-Control", "private, no-store");
        await pipeline(Readable.from(pdf.stream), res);
      } catch (e) {
        return next(e);
      }
    },
  );
  route("get", "/artifacts/:artifactId", "knowledge:read", async (d, req) => {
    const [artifact] = await d.db
      .select({ ...getTableColumns(artifacts), conversationId: agentRuns.conversationId, runGoal: agentRuns.goal })
      .from(artifacts)
      .leftJoin(agentRuns, and(eq(artifacts.runId, agentRuns.id), eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.projectId, artifacts.projectId)))
      .where(
        and(
          eq(artifacts.id, String(req.params.artifactId)),
          eq(artifacts.tenantId, d.tenantId),
        ),
      );
    if (!artifact || !(await d.validateProject(artifact.projectId))) throw missing();
    const revisions = await d.db
      .select()
      .from(artifactRevisions)
      .where(
        and(
          eq(artifactRevisions.artifactId, artifact.id),
          eq(artifactRevisions.tenantId, d.tenantId),
        ),
      )
      .orderBy(desc(artifactRevisions.version));
    // Warm legacy reports when opened, without restarting agents or resetting completed exports.
    if (revisions[0]) await d.db.transaction((tx: any) => queueArtifactPdf(d, tx, revisions[0].id, false));
    const notes = await d.db
      .select({ annotation: annotations })
      .from(annotations)
      .innerJoin(
        artifactRevisions,
        eq(annotations.artifactRevisionId, artifactRevisions.id),
      )
      .where(
        and(
          eq(annotations.tenantId, d.tenantId),
          eq(artifactRevisions.artifactId, artifact.id),
        ),
      ).orderBy(asc(annotations.createdAt));
    const names = await d.userNames?.(notes.map((r: any) => r.annotation.createdBy)) ?? {};
    return {
      artifact,
      revisions: await withSourceReferences(d, artifact.projectId, revisions),
      annotations: notes.map((r: any) => ({ ...r.annotation, authorName: names[r.annotation.createdBy] ?? null })),
    };
  });
  route(
    "post",
    "/artifacts/:artifactId/revisions",
    "knowledge:write",
    async (d, req) => {
      const input = revisionInput.parse(req.body);
      return d.db.transaction(async (tx: any) => {
        const [artifact] = await tx
          .select()
          .from(artifacts)
          .where(
            and(
              eq(artifacts.id, String(req.params.artifactId)),
              eq(artifacts.tenantId, d.tenantId),
            ),
          )
          .for("update");
        if (!artifact) throw missing();
        await sources(d, artifact.projectId, input.sourceVersionIds);
        const [last] = await tx
          .select()
          .from(artifactRevisions)
          .where(eq(artifactRevisions.artifactId, artifact.id))
          .orderBy(desc(artifactRevisions.version))
          .limit(1);
        const [revision] = await tx
          .insert(artifactRevisions)
          .values({
            ...input,
            tenantId: d.tenantId,
            artifactId: artifact.id,
            version: (last?.version ?? 0) + 1,
            createdBy: d.actorId,
          })
          .returning();
        await tx
          .update(artifacts)
          .set({ title: input.title, status: "draft" })
          .where(eq(artifacts.id, artifact.id));
        await queueArtifactPdf(d, tx, revision.id);
        if (last) await queueArtifactPdf(d, tx, last.id);
        await d.audit(
          tx,
          "knowledge.artifact_revision.created",
          "artifact_revision",
          revision.id,
          { artifactId: artifact.id },
        );
        return revision;
      });
    },
  );
  route("get", "/annotations", "knowledge:read", async (d, req) => {
    const input = z
      .object({
        projectId: z.string().uuid(),
        sourceVersionId: z.string().uuid().optional(),
      })
      .parse(req.query);
    if (!(await d.validateProject(input.projectId))) throw missing();
    if (input.sourceVersionId)
      await sources(d, input.projectId, [input.sourceVersionId]);
    return d.db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.tenantId, d.tenantId),
          eq(annotations.projectId, input.projectId),
          input.sourceVersionId
            ? eq(annotations.sourceVersionId, input.sourceVersionId)
            : undefined,
        ),
      )
      .orderBy(asc(annotations.createdAt));
  });
  route("post", "/annotations", "knowledge:write", async (d, req) => {
    const input = z
      .object({
        projectId: z.string().uuid(),
        artifactRevisionId: z.string().uuid().optional(),
        sourceVersionId: z.string().uuid().optional(),
        page: z.number().int().positive().optional(),
        selection: z
          .object({
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
          })
          .refine((v) => v.end >= v.start)
          .optional(),
        quote: z.string().max(10000).optional(),
        body: z.string().trim().min(1).max(20000),
        conversationId: z.string().uuid().optional(),
      })
      .refine(
        (v) => Boolean(v.artifactRevisionId) !== Boolean(v.sourceVersionId),
        "Select exactly one immutable version",
      )
      .parse(req.body);
    if (!(await d.validateProject(input.projectId))) throw missing();
    if (input.sourceVersionId)
      await sources(d, input.projectId, [input.sourceVersionId]);
    let targetConversationId = input.conversationId;
    if (input.artifactRevisionId) {
      const [revision] = await d.db
        .select({ conversationId: agentRuns.conversationId })
        .from(artifactRevisions)
        .innerJoin(artifacts, eq(artifactRevisions.artifactId, artifacts.id))
        .leftJoin(agentRuns, and(eq(artifacts.runId, agentRuns.id), eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.projectId, input.projectId)))
        .where(
          and(
            eq(artifactRevisions.id, input.artifactRevisionId),
            eq(artifactRevisions.tenantId, d.tenantId),
            eq(artifacts.projectId, input.projectId),
            eq(artifacts.tenantId, d.tenantId),
          ),
        );
      if (!revision) throw missing("Artifact version not found in project");
      if (revision.conversationId) {
        if (targetConversationId && targetConversationId !== revision.conversationId)
          throw conflict("Artifact belongs to another conversation");
        targetConversationId = revision.conversationId;
      }
    }
    if (targetConversationId)
      await conversation(d, targetConversationId, input.projectId);
    return d.db.transaction(async (tx: any) => {
      const { conversationId: _conversationId, ...values } = input;
      const conversationId = targetConversationId;
      const [annotation] = await tx
        .insert(annotations)
        .values({ ...values, tenantId: d.tenantId, createdBy: d.actorId })
        .returning();
      let message = null;
      if (conversationId) {
        [message] = await tx
          .insert(messages)
          .values({
            tenantId: d.tenantId,
            conversationId,
            authorId: d.actorId,
            body: input.body,
            annotationId: annotation.id,
            sourceVersionIds: input.sourceVersionId
              ? [input.sourceVersionId]
              : [],
          })
          .returning();
        await tx
          .update(annotations)
          .set({ messageId: message.id })
          .where(eq(annotations.id, annotation.id));
        annotation.messageId = message.id;
        await d.audit(tx, "knowledge.message.created", "message", message.id, {
          annotationId: annotation.id,
        });
      }
      await d.audit(
        tx,
        "knowledge.annotation.created",
        "annotation",
        annotation.id,
        {
          sourceVersionId: input.sourceVersionId,
          artifactRevisionId: input.artifactRevisionId,
        },
      );
      return { annotation, message };
    });
  });
  return router;
}
