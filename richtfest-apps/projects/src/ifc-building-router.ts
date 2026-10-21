import { Worker } from "node:worker_threads";
import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ifcBuildingImportInput, ok, type IfcBuildingPreview } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { isIfcSource } from "./ifc-model";
import { buildingBuildings, buildingElements, buildingModels, buildingRevisions, buildingRooms, buildingStoreys, files, fileVersions, projects } from "./schema";
import { modelTransaction, touchRevision } from "./building-model-router";

async function sourceFor(d: AppDeps, projectId: string, versionId: string, db = d.db) {
  const query = db.select({ version: fileVersions, name: files.name }).from(fileVersions)
    .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, d.tenantId), eq(files.projectId, projectId)))
    .where(and(eq(fileVersions.id, versionId), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready"))).limit(1);
  return (await (db === d.db ? query : query.for("share")))[0];
}

async function parse(d: AppDeps, key: string): Promise<IfcBuildingPreview> {
  const signal = AbortSignal.timeout(120_000);
  const stream = await d.fileStorage.read(key, signal);
  if (!stream) throw Object.assign(new Error("IFC source is unavailable"), { status: 422 });
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) { signal.throwIfAborted(); chunks.push(chunk); }
  signal.throwIfAborted();
  const worker = new Worker(new URL("./ifc-building-model-worker.ts", import.meta.url));
  let abort: () => void = () => {};
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(Object.assign(new Error("IFC preview timed out"), { status: 422 }));
      signal.addEventListener("abort", abort, { once: true });
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("IFC worker exited")));
      worker.once("message", message => message.error ? reject(Object.assign(new Error(message.error), { status: 422 })) : resolve(message.result));
      worker.postMessage(Buffer.concat(chunks));
    });
  } finally { signal.removeEventListener("abort", abort); await worker.terminate(); }
}

export function createIfcBuildingRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  for (const previewOnly of [true, false]) router.post(`/projects/:projectId/building-model/ifc/${previewOnly ? "preview" : "import"}`, async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = z.string().uuid().parse(req.params.projectId);
      const versionId = z.string().uuid().parse(req.body.sourceVersionId);
      const input = previewOnly ? null : ifcBuildingImportInput.parse(req.body);
      const source = await sourceFor(d, projectId, versionId);
      if (!source) return res.status(404).json({ data: null, error: { code: "not_found" }, message: "Ready project source not found" });
      if (!isIfcSource(source.version.mimeType, source.name)) return res.status(422).json({ data: null, error: { code: "invalid_source" }, message: "Choose an IFC source" });
      // Parse immutable stored bytes, never geometry supplied by the client. No model writes during preview.
      const preview = await parse(d, source.version.storageKey);
      if (!input) return res.json(ok(preview));
      const selected = [...input.storeyExpressIds].sort((a, b) => a - b);
      const storeys = preview.entities.filter(e => e.entityType === "storey" && selected.includes(e.expressId));
      if (storeys.length !== selected.length) return res.status(422).json({ data: null, error: { code: "invalid_storeys" }, message: "Select storeys from this IFC revision" });
      const buildingIds = new Set(storeys.map(e => e.buildingExpressId));
      const entities = preview.entities.filter(e => e.entityType === "building" ? buildingIds.has(e.expressId) : e.storeyExpressId !== undefined && selected.includes(e.storeyExpressId));
      if (!entities.some(e => e.geometry)) return res.status(422).json({ data: null, error: { code: "no_geometry" }, message: "The selected storeys contain no importable geometry" });
      const result = await modelTransaction(d.db, async (tx: any) => {
        // Serializes initial model creation and import retries with project deletion.
        const [project] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).for("update");
        if (!project || !await sourceFor(d, projectId, versionId, tx)) return { missing: true };
        let [model] = await tx.select().from(buildingModels).where(and(eq(buildingModels.projectId, projectId), eq(buildingModels.tenantId, d.tenantId))).for("update");
        if (model) {
          const existing = await tx.select().from(buildingBuildings).where(and(eq(buildingBuildings.modelId, model.id), eq(buildingBuildings.tenantId, d.tenantId)));
          const imported = existing.find((b: any) => b.geometry?.ifcImport?.sourceVersionId === versionId);
          if (imported) {
            if (JSON.stringify(imported.geometry.ifcImport.storeyExpressIds) !== JSON.stringify(selected)) return { invalid: true };
            return { revision: model.revision, alreadyImported: true };
          }
          const revision = await touchRevision(tx, d, model.id, input.baseRevision);
          if (revision === undefined) return { conflict: true };
          model = { ...model, revision };
        } else {
          if (input.baseRevision !== 0) return { conflict: true };
          [model] = await tx.insert(buildingModels).values({ tenantId: d.tenantId, projectId, createdBy: d.actorId, revision: 1 }).returning();
        }
        const receipt = { sourceVersionId: versionId, fileName: source.name, storeyExpressIds: selected, schema: preview.schema,
          parserVersion: preview.parserVersion, warnings: preview.warnings, reviewStatus: "unreviewed", importedAt: new Date().toISOString(),
          excludedEntityCount: preview.entities.length - entities.length };
        const buildingMap = new Map<number, string>(), storeyMap = new Map<number, string>();
        for (const entityType of ["building", "storey", "room", "element"] as const) {
          const rows = entities.filter(e => e.entityType === entityType).map(entity => ({
            id: crypto.randomUUID(), tenantId: d.tenantId, modelId: model.id, createdBy: d.actorId,
            stableKey: `ifc:${versionId}:${entity.expressId}`, name: entity.name, constructionState: "unknown",
            geometry: { ...entity.geometry, source: { kind: "ifc", sourceVersionId: versionId, expressId: entity.expressId, globalId: entity.globalId, ifcType: entity.ifcType },
              ...(entityType === "building" ? { ifcImport: receipt } : {}) },
            ...(entityType === "storey" || entityType === "element" ? { buildingId: buildingMap.get(entity.buildingExpressId) } : {}),
            ...(entityType === "room" || entityType === "element" ? { storeyId: storeyMap.get(entity.storeyExpressId!) } : {}),
            ...(entityType === "element" ? { kind: entity.ifcType.replace(/^IFC/, "").toLowerCase().replace("wallstandardcase", "wall") } : {}),
          }));
          if (!rows.length) continue;
          const table = { building: buildingBuildings, storey: buildingStoreys, room: buildingRooms, element: buildingElements }[entityType];
          for (let i = 0; i < rows.length; i += 100) await tx.insert(table).values(rows.slice(i, i + 100));
          if (entityType === "building" || entityType === "storey")
            for (const row of rows) (entityType === "building" ? buildingMap : storeyMap).set(row.geometry.source.expressId, row.id);
        }
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: model.id, revision: model.revision, status: "draft", label: "IFC import", createdBy: d.actorId });
        await d.audit(tx, "projects.building.ifc.imported", "building_model", model.id, { projectId, sourceVersionId: versionId, storeyExpressIds: selected, entityCount: entities.length, revision: model.revision });
        return { revision: model.revision, alreadyImported: false, importedEntityCount: entities.length, receipt };
      });
      if (result.missing) return res.status(404).json({ data: null, error: { code: "not_found" }, message: "Source or project no longer exists" });
      if (result.conflict || result.invalid) return res.status(409).json({ data: null, error: { code: "revision_conflict" }, message: result.invalid ? "This IFC revision was already imported with a different storey selection. Existing work has not been replaced." : "The building model changed. Reload before importing." });
      return res.status(result.alreadyImported ? 200 : 201).json(ok(result));
    } catch (error) { next(error); }
  });
  return router;
}
