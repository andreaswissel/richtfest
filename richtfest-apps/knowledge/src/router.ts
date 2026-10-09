import { Router, type Request } from "express";
import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import {
  agentRunApprovals,
  agentRunEvents,
  agentRuns,
  conversations,
  drafts,
  messages,
  tasks,
} from "./schema";
import type { AppDeps } from "./deps";
import { agentProfilesRouter } from "./agent-profiles";
import { runsRouter } from "./runs";
import { reviewsRouter } from "./reviews";
import { conversation, missing } from "./workspace";
import { workspaceRouter } from "./workspace";
type GetDeps = (req: Request) => AppDeps;
const conversationInput = z.object({
  title: z.string().trim().min(1).max(300),
  projectId: z.string().uuid().optional(),
});
const renameConversationInput = z.object({
  title: z.string().trim().min(1).max(300),
}).strict();
const messageInput = z.object({
  body: z.string().trim().min(1).max(20000),
  sourceRef: z.string().max(1000).optional(),
});
const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  projectId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  assigneeType: z.enum(["user", "agent"]).default("user"),
  assigneeId: z.string().uuid().optional(),
});
const draftInput = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(50000),
  projectId: z.string().uuid().optional(),
  sourceRefs: z.array(z.string().max(1000)).default([]),
});
const runInput = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  goal: z.string().trim().min(1).max(5000),
  sourceVersionIds: z.array(z.string().uuid()).default([]),
});
const send = (res: any, status: number, body: any) =>
  res.status(status).json(body);
export function createRouter(getDeps: GetDeps) {
  const router = Router();
  router.use(agentProfilesRouter(getDeps));
  router.use(workspaceRouter(getDeps));
  router.use(runsRouter(getDeps));
  router.use(reviewsRouter(getDeps));
  router.get("/conversations", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      const { projectId } = z.object({ projectId: z.string().uuid().optional() }).parse(req.query);
      if (projectId && !(await d.validateProject(projectId))) throw missing("Project not found");
      const rows = await d.db
        .select()
        .from(conversations)
        .where(and(eq(conversations.tenantId, d.tenantId), projectId ? eq(conversations.projectId,projectId) : undefined))
        .orderBy(desc(conversations.createdAt));
      return send(res, 200, ok(rows));
    } catch (e) {
      return next(e);
    }
  });
  router.patch(
    "/conversations/:conversationId/archive",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("knowledge:write");
        const id = z.string().uuid().parse(req.params.conversationId);
        const { archived } = z
          .object({ archived: z.boolean() })
          .strict()
          .parse(req.body);
        const row = await d.db.transaction(async (tx: any) => {
          const [current] = await tx
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.id, id),
                eq(conversations.tenantId, d.tenantId),
              ),
            )
            .for("update");
          if (
            !current ||
            (current.projectId && !(await d.validateProject(current.projectId)))
          )
            throw missing("Conversation not found in project");
          // Repeated requests preserve the original archive timestamp and emit no duplicate audit.
          if (Boolean(current.archivedAt) === archived) return current;
          const [updated] = await tx
            .update(conversations)
            .set({ archivedAt: archived ? new Date() : null })
            .where(
              and(
                eq(conversations.id, id),
                eq(conversations.tenantId, d.tenantId),
              ),
            )
            .returning();
          await d.audit(
            tx,
            archived
              ? "knowledge.conversation.archived"
              : "knowledge.conversation.restored",
            "conversation",
            id,
            { projectId: current.projectId },
          );
          return updated;
        });
        return send(res, 200, ok(row));
      } catch (e) {
        return next(e);
      }
    },
  );
  router.patch(
    "/conversations/:conversationId/title",
    async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission("knowledge:write");
        const id = z.string().uuid().parse(req.params.conversationId);
        const { title } = renameConversationInput.parse(req.body);
        const row = await d.db.transaction(async (tx: any) => {
          const [current] = await tx
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.id, id),
                eq(conversations.tenantId, d.tenantId),
              ),
            )
            .for("update");
          if (
            !current ||
            (current.projectId && !(await d.validateProject(current.projectId)))
          )
            throw missing("Conversation not found in project");
          if (current.title === title) return current;
          const [updated] = await tx
            .update(conversations)
            .set({ title })
            .where(
              and(
                eq(conversations.id, id),
                eq(conversations.tenantId, d.tenantId),
              ),
            )
            .returning();
          await d.audit(
            tx,
            "knowledge.conversation.renamed",
            "conversation",
            id,
            { projectId: current.projectId },
          );
          return updated;
        });
        return send(res, 200, ok(row, "Thread renamed"));
      } catch (e) {
        return next(e);
      }
    },
  );
  router.post("/conversations", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:write");
      const input = conversationInput.parse(req.body);
      if (input.projectId && !(await d.validateProject(input.projectId)))
        throw Object.assign(new Error("Project not found"), {
          status: 404,
          code: "not_found",
        });
      const row = await d.db.transaction(async (tx: any) => {
        const [created] = await tx
          .insert(conversations)
          .values({ ...input, tenantId: d.tenantId, createdBy: d.actorId })
          .returning();
        await d.audit(
          tx,
          "knowledge.conversation.created",
          "conversation",
          created.id,
        );
        return created;
      });
      return send(res, 201, ok(row, "Conversation created"));
    } catch (e) {
      return next(e);
    }
  });
  router.get("/tasks", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      const rows = await d.db
        .select()
        .from(tasks)
        .where(eq(tasks.tenantId, d.tenantId))
        .orderBy(desc(tasks.createdAt));
      return send(res, 200, ok(rows));
    } catch (e) {
      return next(e);
    }
  });
  router.post("/tasks", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:write");
      const input = taskInput.parse(req.body);
      const projectId = input.projectId;
      if (projectId && !(await d.validateProject(projectId)))
        throw Object.assign(new Error("Project not found"), {
          status: 404,
          code: "not_found",
        });
      if (input.conversationId) {
        const thread = await conversation(d, input.conversationId, projectId);
        input.projectId = thread.projectId ?? undefined;
      }
      if (
        input.assigneeType === "user" &&
        input.assigneeId &&
        !(await d.validateUser(input.assigneeId))
      )
        throw Object.assign(new Error("Assignee not found"), {
          status: 404,
          code: "not_found",
        });
      const row = await d.db.transaction(async (tx: any) => {
        const [created] = await tx
          .insert(tasks)
          .values({
            ...input,
            assigneeId:
              input.assigneeType === "agent"
                ? null
                : (input.assigneeId ?? d.actorId),
            tenantId: d.tenantId,
            createdBy: d.actorId,
          })
          .returning();
        await d.audit(tx, "knowledge.task.created", "task", created.id, {
          assigneeType: created.assigneeType,
        });
        return created;
      });
      return send(res, 201, ok(row, "Task created"));
    } catch (e) {
      return next(e);
    }
  });
  router.get("/drafts", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      const { projectId } = z
        .object({ projectId: z.string().uuid().optional() })
        .parse(req.query);
      if (projectId && !(await d.validateProject(projectId)))
        throw Object.assign(new Error("Project not found"), {
          status: 404,
          code: "not_found",
        });
      const rows = await d.db
        .select()
        .from(drafts)
        .where(
          projectId
            ? and(
                eq(drafts.tenantId, d.tenantId),
                eq(drafts.projectId, projectId),
              )
            : eq(drafts.tenantId, d.tenantId),
        )
        .orderBy(desc(drafts.createdAt));
      return send(res, 200, ok(rows));
    } catch (e) {
      return next(e);
    }
  });
  router.post("/drafts", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:write");
      const input = draftInput.parse(req.body);
      if (input.projectId && !(await d.validateProject(input.projectId)))
        throw Object.assign(new Error("Project not found"), {
          status: 404,
          code: "not_found",
        });
      if (!input.projectId && input.sourceRefs.length)
        throw Object.assign(new Error("Source references require a project"), {
          status: 400,
          code: "validation_error",
        });
      if (input.projectId)
        for (const sourceId of input.sourceRefs)
          if (!(await d.validateSource(input.projectId, sourceId)))
            throw Object.assign(new Error("Source not found in project"), {
              status: 404,
              code: "not_found",
            });
      const row = await d.db.transaction(async (tx: any) => {
        const [created] = await tx
          .insert(drafts)
          .values({ ...input, tenantId: d.tenantId, createdBy: d.actorId })
          .returning();
        await d.audit(tx, "knowledge.draft.created", "draft", created.id, {
          sourceRefs: input.sourceRefs,
        });
        return created;
      });
      return send(res, 201, ok(row, "Draft created"));
    } catch (e) {
      return next(e);
    }
  });
  router.post("/drafts/:draftId/approve", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:approve");
      const row = await d.db.transaction(async (tx: any) => {
        const [updated] = await tx
          .update(drafts)
          .set({
            status: "approved",
            approvedBy: d.actorId,
            approvedAt: new Date(),
          })
          .where(
            and(
              eq(drafts.id, req.params.draftId),
              eq(drafts.tenantId, d.tenantId),
            ),
          )
          .returning();
        if (!updated)
          throw Object.assign(new Error("Draft not found"), {
            status: 404,
            code: "not_found",
          });
        await d.audit(tx, "knowledge.draft.approved", "draft", updated.id);
        return updated;
      });
      return send(res, 200, ok(row, "Draft approved"));
    } catch (e) {
      return next(e);
    }
  });
  router.get("/runs", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      const projectId =
        typeof req.query.projectId === "string"
          ? req.query.projectId
          : undefined;
      const rows = await d.db
        .select()
        .from(agentRuns)
        .where(
          projectId
            ? and(
                eq(agentRuns.tenantId, d.tenantId),
                eq(agentRuns.projectId, projectId),
              )
            : eq(agentRuns.tenantId, d.tenantId),
        )
        .orderBy(desc(agentRuns.createdAt));
      return send(res, 200, ok(rows));
    } catch (e) {
      return next(e);
    }
  });
  return router;
}
export { dashboardSummary } from "./dashboard";

export {
  tickSupervisors,
  stepSupervisor,
  supervisorProgress,
  listPendingSupervisors,
} from "./supervisor";
