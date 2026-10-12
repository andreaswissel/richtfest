import { Router, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { files, fileVersions, sourceFacts } from "./schema";
import { readSourceModel } from "./source-model";

const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
export function createSourceModelRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  const scope = async (req: Request) => {
    const d = getDeps(req);
    d.requirePermission("projects:read");
    const projectId = z.string().uuid().parse(req.params.projectId);
    const versionId = z.string().uuid().parse(req.params.versionId);
    const [source] = await d.db.select({ id: fileVersions.id }).from(fileVersions)
      .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, d.tenantId)))
      .where(and(eq(files.projectId, projectId), eq(fileVersions.id, versionId), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready")));
    if (!source) throw failure(404, "not_found", "Source version not found in project");
    return { d, versionId };
  };
  router.get("/projects/:projectId/source-versions/:versionId/model", async (req, res, next) => {
    try {
      const { d, versionId } = await scope(req);
      const input = z.object({ query: z.string().max(500).optional(), entityKey: z.string().max(200).optional(),
        offset: z.coerce.number().int().min(0).max(1000000).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(req.query);
      res.json(ok(await readSourceModel(d.db, d.tenantId, versionId, input)));
    } catch (error) { next(error); }
  });
  // Review is human-only: this mutation is not in the agent tool registry.
  router.post("/projects/:projectId/source-versions/:versionId/facts/:factId/review", async (req, res, next) => {
    try {
      const { d, versionId } = await scope(req);
      d.requirePermission("knowledge:approve");
      const id = z.string().uuid().parse(req.params.factId);
      const input = z.object({ status: z.enum(["approved", "rejected", "unreviewed"]),
        expectedRevision: z.number().int().nonnegative(), note: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
      const saved = await d.db.transaction(async (tx: any) => {
        const where = and(eq(sourceFacts.id, id), eq(sourceFacts.versionId, versionId), eq(sourceFacts.tenantId, d.tenantId));
        const [current] = await tx.select().from(sourceFacts).where(where).for("update");
        if (!current) throw failure(404, "not_found", "Source fact not found");
        if (current.reviewRevision !== input.expectedRevision) throw failure(409, "review_conflict", "Fact review changed; reload before reviewing");
        const [fact] = await tx.update(sourceFacts).set({ reviewStatus: input.status, reviewRevision: sql`${sourceFacts.reviewRevision} + 1`,
          reviewedBy: d.actorId, reviewedAt: new Date(), reviewNote: input.note }).where(where).returning();
        await d.audit(tx, "projects.source.fact.reviewed", "source_fact", id,
          { versionId, previousStatus: current.reviewStatus, status: input.status, revision: fact.reviewRevision, note: input.note });
        return fact;
      });
      res.json(ok(saved));
    } catch (error) { next(error); }
  });
  return router;
}
