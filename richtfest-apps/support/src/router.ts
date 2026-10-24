import { Router, type Request } from "express";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import { z } from "zod";
import { ok, supportContext, supportKind, supportProposal, supportStatus, type SupportSource } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { supportConversations as conversations, supportMessages as messages, supportReports as reports } from "./schema";

const uuid = z.string().uuid();
const error = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const own = (deps: AppDeps) => and(eq(conversations.tenantId, deps.tenantId), eq(conversations.createdBy, deps.actorId));
const visibleReports = (deps: AppDeps) => and(eq(reports.tenantId, deps.tenantId), deps.canManage ? undefined : eq(reports.createdBy, deps.actorId));
const reportData = (row: typeof reports.$inferSelect) => ({ ...row, url: `/help?report=${row.id}` });
// An interrupted process must not leave the conversation looking busy forever.
const publicMessage = (row: typeof messages.$inferSelect, reportId: string | null = null) => ({
  ...row, reportId,
  status: row.status === "pending" && Date.now() - row.createdAt.getTime() > 90_000 ? "failed" : row.status,
});

async function conversation(deps: AppDeps, id: string, db = deps.db, lock = false) {
  const query = db.select().from(conversations).where(and(own(deps), eq(conversations.id, id))).limit(1);
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw error(404, "not_found", "Conversation not found");
  return row as typeof conversations.$inferSelect;
}

export function createRouter(resolveDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  router.get("/", async (req, res, next) => {
    try {
      const deps = resolveDeps(req);
      const [rows, readiness] = await Promise.all([
        deps.db.select().from(conversations).where(own(deps)).orderBy(desc(conversations.createdAt)).limit(100),
        deps.readiness(),
      ]);
      res.json(ok({ conversations: rows, readiness: { ...readiness, canRun: deps.canRun }, canManage: deps.canManage }));
    } catch (e) { next(e); }
  });
  router.post("/conversations", async (req, res, next) => {
    try {
      const deps = resolveDeps(req), input = z.object({ id: uuid.default(() => crypto.randomUUID()) }).parse(req.body);
      const row = await deps.db.transaction(async (tx: any) => {
        const [created] = await tx.insert(conversations).values({ id: input.id, tenantId: deps.tenantId, createdBy: deps.actorId }).onConflictDoNothing().returning();
        if (!created) return conversation(deps, input.id, tx);
        await deps.audit(tx, "support.conversation.created", "support_conversation", created.id);
        return created;
      });
      res.json(ok(row));
    } catch (e) { next(e); }
  });
  router.get("/conversations/:id", async (req, res, next) => {
    try {
      const deps = resolveDeps(req), id = uuid.parse(req.params.id);
      const row = await conversation(deps, id);
      const [items, filed] = await Promise.all([
        deps.db.select().from(messages).where(eq(messages.conversationId, id))
          .orderBy(desc(messages.createdAt), asc(messages.role), desc(messages.id)).limit(100),
        deps.db.select({ id: reports.id, messageId: reports.messageId }).from(reports).where(and(visibleReports(deps), eq(reports.conversationId, id))),
      ]);
      res.json(ok({ conversation: row, messages: items.reverse().map((item: typeof messages.$inferSelect) => publicMessage(item, filed.find((r: any) => r.messageId === item.id)?.id ?? null)) }));
    } catch (e) { next(e); }
  });
  router.post("/conversations/:id/messages", async (req, res, next) => {
    try {
      const deps = resolveDeps(req), id = uuid.parse(req.params.id);
      if (!deps.canRun) throw error(403, "forbidden", "Agent execution permission is required");
      const input = supportContext.extend({ id: uuid, body: z.string().trim().min(1).max(12000) }).parse(req.body);
      await conversation(deps, id);
      const context = await deps.validateContext(supportContext.parse(input));
      const sources: SupportSource[] = [
        ...(context.pagePath ? [{ title: "Current page", path: context.pagePath }] : []),
        ...(context.projectId ? [{ title: "Current project", path: `/projects/${context.projectId}` }] : []),
      ];
      const reserved = await deps.db.transaction(async (tx: any) => {
        const thread = await conversation(deps, id, tx, true);
        const [existing] = await tx.select().from(messages).where(eq(messages.id, input.id)).limit(1);
        if (existing) {
          if (existing.conversationId !== id || existing.role !== "user" || existing.body !== input.body
            || existing.sources.length !== sources.length || sources.some((source, index) => source.title !== existing.sources[index]?.title || source.path !== existing.sources[index]?.path))
            throw error(409, "request_conflict", "This request ID was already used");
          const [reply] = await tx.select().from(messages).where(eq(messages.requestId, input.id)).limit(1);
          return { reply, execute: false };
        }
        const [busy] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.conversationId, id), eq(messages.status, "pending"), gt(messages.createdAt, new Date(Date.now() - 90_000)))).limit(1);
        if (busy) throw error(409, "conversation_busy", "Wait for the current answer before sending another message");
        await tx.insert(messages).values({ id: input.id, conversationId: id, role: "user", body: input.body, sources });
        const [reply] = await tx.insert(messages).values({ conversationId: id, requestId: input.id, role: "assistant", body: "", status: "pending" }).returning();
        if (!thread.title) await tx.update(conversations).set({ title: input.body.slice(0, 100) }).where(eq(conversations.id, id));
        await deps.audit(tx, "support.message.created", "support_conversation", id, { messageId: input.id });
        return { reply, execute: true };
      });
      if (!reserved.execute) {
        const [filed] = await deps.db.select({ id: reports.id }).from(reports).where(and(visibleReports(deps), eq(reports.messageId, reserved.reply.id))).limit(1);
        return res.json(ok({ message: publicMessage(reserved.reply, filed?.id ?? null) }));
      }
      let result: Record<string, unknown>;
      try {
        const history = await deps.db.select({ role: messages.role, body: messages.body }).from(messages)
          .where(and(eq(messages.conversationId, id), eq(messages.status, "completed")))
          .orderBy(desc(messages.createdAt), asc(messages.role), desc(messages.id)).limit(20);
        const output = await deps.answer(history.reverse(), context);
        result = output.status === "unconfigured"
          ? { status: "unconfigured", body: "" }
          : { status: "completed", body: output.summary, openui: output.openui ?? null, proposal: output.proposal, sources: output.sources };
      } catch {
        // No raw provider error or credentials enter messages, audit metadata or logs.
        result = { status: "failed", body: "" };
      }
      const reply = await deps.db.transaction(async (tx: any) => {
        const [saved] = await tx.update(messages).set(result).where(eq(messages.id, reserved.reply.id)).returning();
        await deps.audit(tx, "support.answer.completed", "support_conversation", id, { messageId: saved.id, status: saved.status });
        return saved;
      });
      res.json(ok({ message: publicMessage(reply) }));
    } catch (e) { next(e); }
  });
  router.get("/reports", async (req, res, next) => {
    try {
      const deps = resolveDeps(req);
      // UUID cursors paginate ONE full scan; they are never incremental watermarks.
      // Consumers must restart at the first page and upsert by id/updatedAt each scan.
      const input = z.object({ cursor: uuid.optional(), kind: supportKind.optional(), status: supportStatus.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
      const rows = await deps.db.select().from(reports).where(and(visibleReports(deps), input.cursor ? gt(reports.id, input.cursor) : undefined, input.kind ? eq(reports.kind, input.kind) : undefined, input.status ? eq(reports.status, input.status) : undefined)).orderBy(asc(reports.id)).limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      res.json(ok({ items: page.map(reportData), nextCursor: rows.length > input.limit ? page.at(-1).id : null }));
    } catch (e) { next(e); }
  });
  router.get("/reports/:id", async (req, res, next) => {
    try {
      const deps = resolveDeps(req), id = uuid.parse(req.params.id);
      const [row] = await deps.db.select().from(reports).where(and(visibleReports(deps), eq(reports.id, id))).limit(1);
      if (!row) throw error(404, "not_found", "Report not found");
      res.json(ok(reportData(row)));
    } catch (e) { next(e); }
  });
  router.post("/reports", async (req, res, next) => {
    try {
      const deps = resolveDeps(req);
      const input = supportProposal.extend({ id: uuid, messageId: uuid.optional() }).parse(req.body);
      const row = await deps.db.transaction(async (tx: any) => {
        let conversationId: string | null = null;
        if (input.messageId) {
          const [proposal] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).limit(1);
          if (!proposal || proposal.role !== "assistant" || !proposal.proposal) throw error(404, "not_found", "Proposal not found");
          await conversation(deps, proposal.conversationId, tx);
          conversationId = proposal.conversationId;
        }
        const { messageId, ...fields } = input;
        const [saved] = await tx.insert(reports).values({ ...fields, messageId: messageId ?? null, tenantId: deps.tenantId, createdBy: deps.actorId, conversationId }).onConflictDoNothing().returning();
        if (!saved) {
          const [existing] = await tx.select().from(reports).where(and(eq(reports.tenantId, deps.tenantId), eq(reports.createdBy, deps.actorId), or(eq(reports.id, input.id), messageId ? eq(reports.messageId, messageId) : undefined))).limit(1);
          if (!existing) throw error(409, "request_conflict", "This report ID was already used");
          if (existing.id === input.id && (existing.kind !== input.kind || existing.title !== input.title || existing.description !== input.description || existing.pagePath !== input.pagePath || existing.messageId !== (messageId ?? null)))
            throw error(409, "request_conflict", "This report ID was already used for different details");
          return existing;
        }
        await deps.audit(tx, "support.report.filed", "support_report", saved.id, { kind: saved.kind, conversationId });
        return saved;
      });
      res.json(ok(reportData(row)));
    } catch (e) { next(e); }
  });
  router.patch("/reports/:id", async (req, res, next) => {
    try {
      const deps = resolveDeps(req), id = uuid.parse(req.params.id);
      if (!deps.canManage) throw error(403, "forbidden", "Workspace administration access is required");
      const input = z.object({ status: supportStatus }).parse(req.body);
      const row = await deps.db.transaction(async (tx: any) => {
        const [saved] = await tx.update(reports).set({ status: input.status, updatedAt: new Date() }).where(and(visibleReports(deps), eq(reports.id, id))).returning();
        if (!saved) throw error(404, "not_found", "Report not found");
        await deps.audit(tx, "support.report.updated", "support_report", id, input);
        return saved;
      });
      res.json(ok(reportData(row)));
    } catch (e) { next(e); }
  });
  return router;
}
