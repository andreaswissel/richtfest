import { Router, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { files, fileVersions, sourceFacts, sourceModels, sourceExtractions, sourcePages } from "./schema";
import { readSourceModel } from "./source-model";
import { readSourceDocumentModel, savedSourceDocumentPage, withSourceDocumentPage, prepareSourceDocumentLayers } from "./source-document";

const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
export function createSourceModelRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  const scope = async (req: Request) => {
    const d = getDeps(req);
    d.requirePermission("projects:read");
    const projectId = z.string().uuid().parse(req.params.projectId);
    const versionId = z.string().uuid().parse(req.params.versionId);
    const [source] = await d.db.select({ id: fileVersions.id, fileId: files.id, purpose: files.purpose, name: files.name, mimeType: fileVersions.mimeType, storageKey: fileVersions.storageKey }).from(fileVersions)
      .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, d.tenantId)))
      .where(and(eq(files.projectId, projectId), eq(fileVersions.id, versionId), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready")));
    if (!source) throw failure(404, "not_found", "Source version not found in project");
    return { d, versionId, projectId, source };
  };
  router.get("/projects/:projectId/source-versions/:versionId/model", async (req, res, next) => {
    try {
      const { d, versionId } = await scope(req);
      const input = z.object({ query: z.string().max(500).optional(), entityKey: z.string().max(200).optional(),
        offset: z.coerce.number().int().min(0).max(1000000).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(req.query);
      res.json(ok(await readSourceModel(d.db, d.tenantId, versionId, input)));
    } catch (error) { next(error); }
  });
  router.get("/projects/:projectId/source-versions/:versionId/document-model", async (req, res, next) => {
    try {
      const { d, versionId } = await scope(req);
      const input = z.object({ page: z.coerce.number().int().positive().optional(),
        offset: z.coerce.number().int().min(0).max(1000000).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(req.query);
      res.json(ok(await readSourceDocumentModel(d.db, d.tenantId, versionId, input)));
    } catch (error) { next(error); }
  });
  // Build deterministic blocks from already saved text only. No extraction or AI jobs.
  router.post("/projects/:projectId/source-versions/:versionId/document-model/prepare", async (req, res, next) => {
    try {
      const { d, versionId, projectId, source } = await scope(req);
      d.requirePermission("projects:write");
      z.object({}).strict().parse(req.body ?? {});
      if (source.purpose !== "project_evidence")
        throw failure(409, "source_purpose_excluded", "Only project evidence can be prepared as a document model");
      // Storage I/O and PDF parsing must finish before acquiring database locks.
      const [snapshot] = await d.db.select({ result: sourceExtractions.result }).from(sourceExtractions)
        .where(and(eq(sourceExtractions.versionId, versionId), eq(sourceExtractions.tenantId, d.tenantId)));
      if (!snapshot) throw failure(409, "source_text_unavailable", "Saved source extraction is unavailable");
      const preparedLayers = await prepareSourceDocumentLayers(source, d.fileStorage, snapshot.result?.documentLayers);
      const prepared = await d.db.transaction(async (tx: any) => {
        // Serialize against purpose changes; comparison documents are never backfilled.
        const [file] = await tx.select({ purpose: files.purpose }).from(files).where(and(
          eq(files.id, source.fileId), eq(files.tenantId, d.tenantId), eq(files.projectId, projectId),
        )).for("update");
        if (!file || file.purpose !== "project_evidence")
          throw failure(409, "source_purpose_excluded", "Only project evidence can be prepared as a document model");
        const [version] = await tx.select({ id: fileVersions.id, storageKey: fileVersions.storageKey, mimeType: fileVersions.mimeType }).from(fileVersions).where(and(
          eq(fileVersions.id, versionId), eq(fileVersions.fileId, source.fileId),
          eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready"),
        )).for("share");
        if (!version) throw failure(404, "not_found", "Ready source version not found");
        if (version.storageKey !== source.storageKey || version.mimeType !== source.mimeType)
          throw failure(409, "source_version_changed", "Source version changed during document preparation");
        const [extraction] = await tx.select({ result: sourceExtractions.result }).from(sourceExtractions)
          .where(and(eq(sourceExtractions.versionId, versionId), eq(sourceExtractions.tenantId, d.tenantId))).for("update");
        if (!extraction) throw failure(409, "source_text_unavailable", "Saved source extraction is unavailable");
        const rows = await tx.select({ page: sourcePages.page, content: sourcePages.content }).from(sourcePages)
          .where(and(eq(sourcePages.versionId, versionId), eq(sourcePages.tenantId, d.tenantId)))
          .orderBy(sourcePages.page).for("update");
        if (!rows.length) throw failure(409, "source_text_unavailable", "No saved pages are available; preparation does not re-extract the original");
        let preparedPages = 0;
        for (const row of rows) {
          if (savedSourceDocumentPage(versionId, row.page, row.content)) continue;
          const content = withSourceDocumentPage(versionId, row.page, row.content);
          await tx.update(sourcePages).set({ content }).where(and(
            eq(sourcePages.versionId, versionId), eq(sourcePages.tenantId, d.tenantId), eq(sourcePages.page, row.page),
          ));
          preparedPages++;
        }
        const layersPrepared = !extraction.result?.documentLayers;
        if (layersPrepared) {
          const documentLayers = preparedLayers;
          await tx.update(sourceExtractions).set({ result: { ...(extraction.result ?? { status: "unsupported" as const }), documentLayers } })
            .where(and(eq(sourceExtractions.versionId, versionId), eq(sourceExtractions.tenantId, d.tenantId)));
        }
        if (preparedPages || layersPrepared) await d.audit(tx, "projects.source.document_model.prepared", "file_version", versionId,
          { projectId, preparedPages, reusedPages: rows.length - preparedPages, parserVersion: "text-grid-v1", layersPrepared });
        return { preparedPages, reusedPages: rows.length - preparedPages };
      });
      res.json(ok({ ...prepared, documentModel: await readSourceDocumentModel(d.db, d.tenantId, versionId) }));
    } catch (error) { next(error); }
  });
  // Explicit, scoped recovery only. Reads and new agent runs never replay jobs.
  router.post("/projects/:projectId/source-versions/:versionId/reprocess", async (req, res, next) => {
    try {
      const { d, versionId } = await scope(req);
      d.requirePermission("projects:write");
      d.requirePermission("agent:run");
      z.object({}).strict().parse(req.body ?? {});
      const result = await d.db.transaction(async (tx: any) => {
        const where = and(eq(sourceExtractions.versionId, versionId), eq(sourceExtractions.tenantId, d.tenantId));
        const modelWhere = and(eq(sourceModels.versionId, versionId), eq(sourceModels.tenantId, d.tenantId));
        const [extraction] = await tx.select().from(sourceExtractions).where(where).for("update");
        const [model] = await tx.select().from(sourceModels).where(modelWhere).for("update");
        if (!extraction || !model) throw failure(409, "processing_unavailable", "No processing record exists for this version");
        if ([extraction.status, model.status].some(status => ["queued", "running"].includes(status)))
          throw failure(409, "processing_active", "Source processing is already queued or running");
        if (model.status === "complete")
          throw failure(409, "model_preserved", "A completed source model cannot be replaced by recovery");
        const [fact] = await tx.select({ id: sourceFacts.id }).from(sourceFacts)
          .where(and(eq(sourceFacts.versionId, versionId), eq(sourceFacts.tenantId, d.tenantId))).limit(1);
        if (fact) throw failure(409, "model_preserved", "Existing source facts and reviews must be preserved");
        const retryExtraction = extraction.status === "failed";
        if (retryExtraction) {
          await tx.delete(sourcePages).where(and(eq(sourcePages.versionId, versionId), eq(sourcePages.tenantId, d.tenantId)));
          await tx.update(sourceExtractions).set({ status: "queued", nextPage: 1, attempts: 0, result: null,
            leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(where);
        }
        await tx.update(sourceModels).set({ status: "queued", leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(modelWhere);
        await d.audit(tx, "projects.source.reprocessing.queued", "file_version", versionId,
          { extraction: retryExtraction, previousExtractionStatus: extraction.status, previousModelStatus: model.status,
            previousModelMetadata: model.metadata });
        return { versionId, extraction: retryExtraction ? "queued" : extraction.status, model: "queued" };
      });
      res.status(202).json(ok(result, "Source recovery queued; original version and citations preserved"));
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
