import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ok, projectPlanningInput, type ProjectPlanning } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { projectPlanning, projects } from "./schema";

const failure = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { status, code });
const output = (row?: ProjectPlanning): ProjectPlanning => row
  ? { revision: row.revision, currentPhase: row.currentPhase, items: row.items }
  : { revision: 0, currentPhase: null, items: [] };

export function createPlanningRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  const path = "/projects/:projectId/planning";
  router.get(path, async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:read");
      const projectId = z.string().uuid().parse(req.params.projectId);
      // One read, no lazy creation; the project join also enforces tenant ownership.
      const [row] = await d.db.select({ planning: projectPlanning }).from(projects)
        .leftJoin(projectPlanning, and(eq(projectPlanning.projectId, projects.id), eq(projectPlanning.tenantId, d.tenantId)))
        .where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId)));
      if (!row) throw failure(404, "not_found", "Project not found");
      res.set("Cache-Control", "private, no-store");
      return res.json(ok(output(row.planning ?? undefined)));
    } catch (error) { return next(error); }
  });
  router.put(path, async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:write");
      const projectId = z.string().uuid().parse(req.params.projectId);
      const input = projectPlanningInput.parse(req.body);
      const result = await d.db.transaction(async (tx: any) => {
        // Lock the existing parent, not the optional aggregate: concurrent first
        // saves serialize too, and a project cannot disappear during a save.
        const [project] = await tx.select({ id: projects.id }).from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).for("update");
        if (!project) throw failure(404, "not_found", "Project not found");
        const where = and(eq(projectPlanning.projectId, projectId), eq(projectPlanning.tenantId, d.tenantId));
        const [current] = await tx.select().from(projectPlanning).where(where);
        if ((current?.revision ?? 0) !== input.expectedRevision)
          throw failure(409, "planning_conflict", "Planning changed; reload before saving");
        const ids = new Set(input.items.map(item => item.id));
        if (current?.items.some((item: { id: string }) => !ids.has(item.id)))
          throw failure(400, "planning_items_required", "Keep existing planning items; archive them instead of removing them");
        // Only explicit currentPhase changes advance the actual phase. Item
        // completion never confers engineering approval or advances anything.
        const values = { revision: input.expectedRevision + 1, currentPhase: input.currentPhase, items: input.items, updatedAt: new Date() };
        const [saved] = current
          ? await tx.update(projectPlanning).set(values).where(where).returning()
          : await tx.insert(projectPlanning).values({ ...values, tenantId: d.tenantId, projectId }).returning();
        await d.audit(tx, "projects.planning.updated", "project", projectId, {
          revision: saved.revision, previousRevision: input.expectedRevision,
          previousPhase: current?.currentPhase ?? null, currentPhase: saved.currentPhase,
          itemIds: input.items.map(item => item.id), purpose: "planning_tracking_not_engineering_approval",
        });
        return output(saved);
      });
      return res.json(ok(result));
    } catch (error) { return next(error); }
  });
  return router;
}
