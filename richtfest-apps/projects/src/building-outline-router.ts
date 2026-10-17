import { Router, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { buildingModels, buildingRooms, buildingStoreys, buildingRevisions, buildingExtractionJobs as jobs, buildingExtractionCandidates as candidates,
  buildingSelectionMasks as masks, buildingOutlineEdits, fileVersions, files } from "./schema";
import { decodeSelectionMask, magicSelection, outlineAreaM2, outlineProblem, type PageScale } from "./plan-selection";

const uuid = z.string().uuid();
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
const ring = z.array(point).max(1000);
const error = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const fail = (res: any, e: any, next: any) => e?.code && e?.status ? res.status(e.status).json({ data: null, error: { code: e.code }, message: e.message }) : next(e);

const magicInput = z.object({ sourceVersionId: uuid, page: z.number().int().positive(), point }).strict();
const outlineInput = z.object({
  baseRevision: z.number().int().nonnegative(),
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("room"), id: uuid, sourceVersionId: uuid.optional(), page: z.number().int().positive().optional() }).strict(),
    z.object({ type: z.literal("candidate"), id: uuid }).strict(),
    z.object({ type: z.literal("new_room"), storeyId: uuid, sourceVersionId: uuid, page: z.number().int().positive(), name: z.string().trim().min(1).max(300) }).strict(),
  ]),
  polygon: ring.min(3),
  holes: z.array(ring.min(3)).max(50).default([]),
  method: z.enum(["manual", "magic_selection"]),
  // What magic selection proposed before the planner adjusted it: the most useful training signal.
  magic: z.object({ point, polygon: ring, holes: z.array(ring).max(50).default([]) }).strict().optional(),
}).strict();

const bounds = (polygon: { x: number; y: number }[]) => {
  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y), x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

// Decoded masks are ~1.4 MB each; keep the few pages someone is actively clicking on.
const maskCache = new Map<string, Uint8Array>();
async function pageMask(db: any, tenantId: string, modelId: string, sourceVersionId: string, page: number) {
  const [row] = await db.select({ mask: masks, jobId: jobs.id }).from(masks).innerJoin(jobs, eq(jobs.id, masks.jobId))
    .where(and(eq(masks.modelId, modelId), eq(masks.tenantId, tenantId), eq(jobs.sourceVersionId, sourceVersionId), eq(jobs.page, page)))
    .orderBy(desc(masks.updatedAt)).limit(1);
  if (!row) return null;
  const scale: PageScale = { pageAspectRatio: Number(row.mask.pageAspectRatio), metresPerPageHeight: row.mask.metresPerPageHeight == null ? null : Number(row.mask.metresPerPageHeight) };
  return { row: row.mask, scale, cells: async () => {
    const key = `${row.mask.jobId}:${new Date(row.mask.updatedAt).getTime()}`;
    let cells = maskCache.get(key);
    if (!cells) {
      cells = decodeSelectionMask(row.mask.data, row.mask.gridSize);
      maskCache.set(key, cells);
      if (maskCache.size > 6) maskCache.delete(maskCache.keys().next().value!);
    }
    return cells;
  } };
}

async function projectModel(db: any, d: AppDeps, projectId: string, lock: boolean) {
  const query = db.select().from(buildingModels).where(and(eq(buildingModels.projectId, projectId), eq(buildingModels.tenantId, d.tenantId)));
  const [model] = await (lock ? query.for("update") : query);
  if (!model) throw error(404, "not_found", "Building model not found");
  return model;
}

export function createBuildingOutlineRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();

  /** Propose the room outline around a clicked point; nothing is saved. */
  router.post("/projects/:projectId/building-model/magic-selection", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read");
      const projectId = uuid.parse(req.params.projectId); const input = magicInput.parse(req.body);
      const model = await projectModel(d.db, d, projectId, false);
      const mask = await pageMask(d.db, d.tenantId, model.id, input.sourceVersionId, input.page);
      if (!mask) throw error(404, "selection_unavailable", "Magic selection is available once this page has been extracted with the current plan parser.");
      const result = magicSelection(await mask.cells(), mask.row.gridSize, input.point, mask.scale);
      res.json(ok({ ...result, sourceVersionId: input.sourceVersionId, page: input.page, point: input.point, jobId: mask.row.jobId, extractorVersion: mask.row.extractorVersion, scale: mask.scale }));
    } catch (e) { fail(res, e, next); }
  });

  /** Save a planner's outline for a room, an unreviewed room candidate or a new room, and log it as training data. */
  router.post("/projects/:projectId/building-model/outline-edits", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = uuid.parse(req.params.projectId); const input = outlineInput.parse(req.body);
      const problem = outlineProblem(input.polygon);
      if (problem) throw error(422, "invalid_outline", problem);
      const result = await d.db.transaction(async (tx: any) => {
        const model = await projectModel(tx, d, projectId, true);
        if (model.revision !== input.baseRevision) throw error(409, "revision_conflict", "The building model changed; reload before saving.");
        const target = input.target;
        let before: any = null, source: { sourceVersionId: string; page: number }, jobId: string | null = null, extractorVersion: string | null = null;
        let row: any = null;
        if (target.type === "room") {
          [row] = await tx.select().from(buildingRooms).where(and(eq(buildingRooms.id, target.id), eq(buildingRooms.modelId, model.id), eq(buildingRooms.tenantId, d.tenantId))).for("update");
          if (!row) throw error(404, "not_found", "Room not found");
          const stored = (row.geometry as any)?.source;
          const sourceVersionId = stored?.sourceVersionId ?? target.sourceVersionId, page = stored?.page ?? target.page;
          if (!sourceVersionId || !page) throw error(422, "source_required", "Choose the plan page this outline is drawn on");
          source = { sourceVersionId, page };
        } else if (target.type === "candidate") {
          [row] = await tx.select().from(candidates).where(and(eq(candidates.id, target.id), eq(candidates.modelId, model.id), eq(candidates.tenantId, d.tenantId))).for("update");
          if (!row || row.entityType !== "room") throw error(404, "not_found", "Room candidate not found");
          if (row.status !== "unreviewed") throw error(409, "already_reviewed", "This candidate was already reviewed; edit the room instead.");
          const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, row.jobId), eq(jobs.tenantId, d.tenantId)));
          if (!job) throw error(404, "not_found", "Extraction not found");
          source = { sourceVersionId: job.sourceVersionId, page: job.page }; jobId = job.id; extractorVersion = job.extractorVersion;
        } else {
          const [storey] = await tx.select({ id: buildingStoreys.id }).from(buildingStoreys).where(and(eq(buildingStoreys.id, target.storeyId), eq(buildingStoreys.modelId, model.id), eq(buildingStoreys.tenantId, d.tenantId)));
          if (!storey) throw error(404, "not_found", "Storey not found");
          source = { sourceVersionId: target.sourceVersionId, page: target.page };
        }
        const [version] = await tx.select({ id: fileVersions.id }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId))
          .where(and(eq(fileVersions.id, source.sourceVersionId), eq(fileVersions.tenantId, d.tenantId), eq(files.projectId, projectId)));
        if (!version) throw error(422, "invalid_source_revision", "The plan source is not a file revision in this project");
        const mask = await pageMask(tx, d.tenantId, model.id, source.sourceVersionId, source.page);
        if (mask && !jobId) { jobId = mask.row.jobId; extractorVersion = mask.row.extractorVersion; }
        const scale: PageScale = mask?.scale ?? { pageAspectRatio: 1, metresPerPageHeight: null };
        const old = (row?.geometry ?? {}) as any;
        if (old.polygon) before = { quality: old.quality ?? null, polygon: old.polygon, holes: old.holes ?? [], planRegion: old.planRegion ?? null };
        else if (row) before = { quality: old.quality ?? null, polygon: null, holes: [], planRegion: old.planRegion ?? null };
        const areaM2 = outlineAreaM2(input.polygon, input.holes, scale);
        const editedAt = new Date().toISOString();
        const { parts: _parts, polygons: _polygons, ...kept } = old;
        const geometry = { ...kept, coordinateSpace: "normalized-page", quality: "manual_outline", polygon: input.polygon, holes: input.holes, planRegion: bounds(input.polygon),
          ...(old.quality === "anchor" && old.planRegion && !old.labelRegion ? { labelRegion: old.planRegion } : {}),
          ...(target.type !== "candidate" ? { source: { ...(old.source ?? {}), ...source } } : {}),
          outlineEdit: { method: input.method, editedBy: d.actorId, editedAt, areaM2, editCount: (old.outlineEdit?.editCount ?? 0) + 1 } };
        let entityType: "room" | "building_extraction_candidate" = "room", entityId: string;
        if (target.type === "room") { await tx.update(buildingRooms).set({ geometry }).where(eq(buildingRooms.id, row.id)); entityId = row.id; }
        else if (target.type === "candidate") { await tx.update(candidates).set({ geometry }).where(eq(candidates.id, row.id)); entityType = "building_extraction_candidate"; entityId = row.id; }
        else {
          const [created] = await tx.insert(buildingRooms).values({ tenantId: d.tenantId, modelId: model.id, storeyId: target.storeyId, stableKey: `outline:${crypto.randomUUID()}`,
            name: target.name, constructionState: "unknown", geometry, createdBy: d.actorId }).returning({ id: buildingRooms.id });
          entityId = created.id;
        }
        const revision = model.revision + 1;
        await tx.update(buildingModels).set({ revision, updatedAt: new Date() }).where(eq(buildingModels.id, model.id));
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: model.id, revision, status: "draft", label: target.type === "new_room" ? "Room drawn on plan" : "Room outline edited", createdBy: d.actorId });
        const action = target.type === "new_room" ? "create" : "reshape";
        const [edit] = await tx.insert(buildingOutlineEdits).values({ tenantId: d.tenantId, modelId: model.id, targetType: target.type === "candidate" ? "candidate" : "room", targetId: entityId,
          action, method: input.method, sourceVersionId: source.sourceVersionId, page: source.page, jobId, extractorVersion, before, after: { polygon: input.polygon, holes: input.holes },
          magic: input.magic ?? null, metrics: { areaBeforeM2: before?.polygon ? outlineAreaM2(before.polygon, before.holes, scale) : null, areaAfterM2: areaM2,
            vertexCountBefore: before?.polygon?.length ?? 0, vertexCountAfter: input.polygon.length, ...scale }, modelRevision: revision, createdBy: d.actorId }).returning({ id: buildingOutlineEdits.id });
        await d.audit(tx, target.type === "new_room" ? "projects.building.room.created" : `projects.building.${target.type === "room" ? "room" : "extraction_candidate"}.outline_edited`, entityType, entityId,
          { projectId, modelRevision: revision, method: input.method, outlineEditId: edit.id, areaM2, vertexCount: input.polygon.length });
        return { entityType: target.type === "candidate" ? "candidate" : "room", entityId, outlineEditId: edit.id, areaM2, revision };
      });
      res.status(input.target.type === "new_room" ? 201 : 200).json(ok(result));
    } catch (e) { fail(res, e, next); }
  });
  return router;
}
