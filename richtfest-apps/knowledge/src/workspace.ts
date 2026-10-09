import { repairLegacyRuns } from "./run-recovery";
import { Router, type Request } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import {
  annotations,
  artifacts,
  artifactRevisions,
  conversations,
  conversationReads,
  messages,
  agentRuns,
  tasks,
} from "./schema";
export const missing = (message = "Record not found") =>
  Object.assign(new Error(message), { status: 404, code: "not_found" });
export const conflict = (message: string) =>
  Object.assign(new Error(message), { status: 409, code: "invalid_state" });
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
  content: z.string().max(100000),
  payload: z
    .object({
      kind: z.enum(["table", "checklist", "summary"]),
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
export function workspaceRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
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
        })
        .refine((v) => !v.pageEnd || v.pageEnd >= (v.pageStart ?? 1))
        .parse(req.query);
      if (!(await d.validateProject(projectId))) throw missing();
      await sources(d, projectId, [versionId]);
      return d.resolveSource(projectId, { versionId, ...range });
    },
  );
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
          .select()
          .from(artifacts)
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
    return {
      conversations: threads.map((t: any) => ({
        ...t,
        readState: states.find((s: any) => s.conversationId === t.id) ?? null,
        unreadCount:
          counts.rows.find((c: any) => c.conversation_id === t.id)?.count ?? 0,
      })),
      artifacts: artifactRows,
      runs,
      tasks: taskRows,
    };
  });
  route(
    "get",
    "/conversations/:conversationId/messages",
    "knowledge:read",
    async (d, req) => {
      const id = String(req.params.conversationId);
      await conversation(d, id);
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
      const items = await enrichAnnotations(
        d,
        rows.slice(0, query.limit).reverse(),
      );
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
      await conversation(d, String(req.params.conversationId));
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
      return (await enrichAnnotations(d, [row]))[0];
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
  route("get", "/artifacts/:artifactId", "knowledge:read", async (d, req) => {
    const [artifact] = await d.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, String(req.params.artifactId)),
          eq(artifacts.tenantId, d.tenantId),
        ),
      );
    if (!artifact) throw missing();
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
      );
    return {
      artifact,
      revisions,
      annotations: notes.map((r: any) => r.annotation),
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
    if (input.artifactRevisionId) {
      const [revision] = await d.db
        .select()
        .from(artifactRevisions)
        .innerJoin(artifacts, eq(artifactRevisions.artifactId, artifacts.id))
        .where(
          and(
            eq(artifactRevisions.id, input.artifactRevisionId),
            eq(artifactRevisions.tenantId, d.tenantId),
            eq(artifacts.projectId, input.projectId),
            eq(artifacts.tenantId, d.tenantId),
          ),
        );
      if (!revision) throw missing("Artifact version not found in project");
    }
    if (input.conversationId)
      await conversation(d, input.conversationId, input.projectId);
    return d.db.transaction(async (tx: any) => {
      const { conversationId, ...values } = input;
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
