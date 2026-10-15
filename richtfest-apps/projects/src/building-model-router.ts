import { Router, type Request } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  buildingConstructionStateSchema,
  buildingClaimKindSchema,
  buildingDeepLink,
  buildingEntityTypeSchema,
  buildingEvidenceSchema,
  buildingMeasurementMethodSchema,
  buildingPropertyProvenanceSchema,
  buildingPropertyValueSchema,
  buildingReviewStatusSchema,
  ok,
} from "@richtfest/shared";
import {
  buildingAlternatives,
  buildingBuildings,
  buildingConflicts,
  buildingElements,
  buildingMeasurements,
  buildingModels,
  buildingPlanSources,
  buildingPlacements,
  buildingProperties,
  buildingPropertyVersions,
  buildingRelationships,
  buildingReconciliations,
  buildingReviews,
  buildingProposals,
  buildingRevisions,
  buildingRooms,
  buildingStoreys,
  fileVersions,
  files,
  projects,
} from "./schema";
import type { AppDeps } from "./deps";
import { createBuildingExtractionRouter } from "./building-extraction-router";
import { buildingExtractionJobs, buildingExtractionCandidates } from "./schema";

type GetDeps = (req: Request) => AppDeps;
// Existing route handlers return validation results. Roll those results back,
// including any optimistic revision increment performed earlier in the callback.
class ModelTransactionRejected { constructor(readonly result: any) {} }
async function modelTransaction(db: any, work: (tx: any) => Promise<any>) {
  try { return await db.transaction(async (tx: any) => {
    const result = await work(tx);
    if (result && ["conflict", "missing", "missingOrConflict", "reviewConflict", "invalid", "invalidSource"].some(key => Object.hasOwn(result, key)))
      throw new ModelTransactionRejected(result);
    return result;
  }); } catch (error) { if (error instanceof ModelTransactionRejected) return error.result; throw error; }
}
const send = (res: any, status: number, body: any) => res.status(status).json(body);
const id = (value: string | string[]) => String(value);
const uuid = z.string().uuid();
const entityType = buildingEntityTypeSchema;
const entityInput = z.object({
  stableKey: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(300),
  constructionState: buildingConstructionStateSchema.optional(),
  geometry: z.unknown().nullable().optional(),
}).strict();
const storeyInput = entityInput.extend({ levelIndex: z.number().int().nullable().optional() });
const elementInput = entityInput.extend({ kind: z.string().trim().min(1).max(100) });
const revisionInput = z.object({ baseRevision: z.number().int().nonnegative() });
const propertyInput = z.object({
  baseRevision: z.number().int().nonnegative(),
  entityType,
  entityId: uuid,
  propertyKey: z.string().trim().min(1).max(200),
  claimKind: buildingClaimKindSchema.default("observed_fact"),
  value: buildingPropertyValueSchema,
  unit: z.string().trim().max(80).nullable().optional(),
  provenance: buildingPropertyProvenanceSchema,
  evidence: z.array(buildingEvidenceSchema).max(20).default([]),
}).strict();
const measurementInput = z.object({
  baseRevision: z.number().int().nonnegative(),
  entityType,
  entityId: uuid,
  quantity: z.string().trim().min(1).max(100),
  value: z.number().finite(),
  unit: z.string().trim().min(1).max(40),
  method: buildingMeasurementMethodSchema,
  uncertainty: z.unknown().nullable().optional(),
  evidence: z.array(buildingEvidenceSchema).max(20).default([]),
}).strict();
const relationshipInput = z.object({
  baseRevision: z.number().int().nonnegative(),
  fromEntityType: entityType,
  fromEntityId: uuid,
  toEntityType: entityType,
  toEntityId: uuid,
  relationshipType: z.string().trim().min(1).max(100),
  metadata: z.record(z.unknown()).nullable().optional(),
}).strict();
const proposalInput = z.object({
  baseRevision: z.number().int().nonnegative(),
  proposalType: z.string().trim().min(1).max(100),
  targetEntityType: entityType.nullable().optional(),
  targetEntityId: uuid.nullable().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  payload: z.record(z.unknown()),
}).strict();

const modelForProject = async (d: AppDeps, projectId: string) => {
  const [row] = await d.db.select({ model: buildingModels, project: projects })
    .from(buildingModels)
    .innerJoin(projects, and(eq(projects.id, buildingModels.projectId), eq(projects.tenantId, d.tenantId)))
    .where(and(eq(buildingModels.projectId, projectId), eq(buildingModels.tenantId, d.tenantId)))
    .limit(1);
  return row;
};

const revisionConflict = (res: any, currentRevision: number) => send(res, 409, {
  data: { currentRevision },
  error: { code: "revision_conflict" },
  message: "The building model changed; reload before saving.",
});

/** Increment the model revision only when the client read the current value. */
const touchRevision = async (tx: any, d: AppDeps, modelId: string, baseRevision: number) => {
  const rows = await tx.update(buildingModels)
    .set({ revision: sql`${buildingModels.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(buildingModels.id, modelId), eq(buildingModels.tenantId, d.tenantId), eq(buildingModels.revision, baseRevision)))
    .returning({ revision: buildingModels.revision });
  return rows[0]?.revision as number | undefined;
};

const tableFor = (type: string) => ({ building: buildingBuildings, storey: buildingStoreys, room: buildingRooms, element: buildingElements } as any)[type];
const entityExists = async (db: any, d: AppDeps, modelId: string, type: string, entityId: string) => {
  const table = tableFor(type); if (!table) return false;
  const rows = await db.select({ id: table.id }).from(table).where(and(eq(table.id, entityId), eq(table.modelId, modelId), eq(table.tenantId, d.tenantId))).limit(1);
  return Boolean(rows[0]);
};
const evidenceVersionsForProject = async (db: any, d: AppDeps, projectId: string, evidence: z.infer<typeof buildingEvidenceSchema>[]) => {
  const ids = [...new Set(evidence.map(item => item.sourceVersionId))];
  if (!ids.length) return true;
  const rows = await db.select({ id: fileVersions.id }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId)).where(and(inArray(fileVersions.id, ids), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready"), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId)));
  return rows.length === ids.length;
};

const readModel = async (d: AppDeps, model: any) => {
  const [extractions, extractionCandidates] = await Promise.all([
    d.db.select().from(buildingExtractionJobs).where(and(eq(buildingExtractionJobs.modelId, model.id), eq(buildingExtractionJobs.tenantId, d.tenantId))),
    d.db.select().from(buildingExtractionCandidates).where(and(eq(buildingExtractionCandidates.modelId, model.id), eq(buildingExtractionCandidates.tenantId, d.tenantId))),
  ]);
  const [buildings, storeys, rooms, elements, properties, propertyVersions, measurements, planSources, placementRows, relationships, conflicts, proposals, revisions, alternatives] = await Promise.all([
    d.db.select().from(buildingBuildings).where(eq(buildingBuildings.modelId, model.id)).orderBy(asc(buildingBuildings.createdAt)),
    d.db.select().from(buildingStoreys).where(eq(buildingStoreys.modelId, model.id)).orderBy(asc(buildingStoreys.levelIndex)),
    d.db.select().from(buildingRooms).where(eq(buildingRooms.modelId, model.id)).orderBy(asc(buildingRooms.createdAt)),
    d.db.select().from(buildingElements).where(eq(buildingElements.modelId, model.id)).orderBy(asc(buildingElements.createdAt)),
    d.db.select().from(buildingProperties).where(eq(buildingProperties.modelId, model.id)),
    d.db.select().from(buildingPropertyVersions).where(eq(buildingPropertyVersions.tenantId, d.tenantId)).orderBy(desc(buildingPropertyVersions.version)),
    d.db.select().from(buildingMeasurements).where(eq(buildingMeasurements.modelId, model.id)).orderBy(desc(buildingMeasurements.createdAt)),
    d.db.select({ plan: buildingPlanSources, file: files, version: fileVersions }).from(buildingPlanSources)
      .innerJoin(fileVersions, and(eq(fileVersions.id, buildingPlanSources.sourceVersionId), eq(fileVersions.tenantId, d.tenantId)))
      .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, d.tenantId)))
      .where(and(eq(buildingPlanSources.modelId, model.id), eq(buildingPlanSources.tenantId, d.tenantId))).orderBy(asc(buildingPlanSources.page)),
    d.db.select().from(buildingPlacements).where(and(eq(buildingPlacements.modelId, model.id), eq(buildingPlacements.tenantId, d.tenantId))).limit(1),
    d.db.select().from(buildingRelationships).where(eq(buildingRelationships.modelId, model.id)).orderBy(asc(buildingRelationships.createdAt)),
    d.db.select().from(buildingConflicts).where(and(eq(buildingConflicts.modelId, model.id), eq(buildingConflicts.status, "unresolved"))),
    d.db.select().from(buildingProposals).where(eq(buildingProposals.modelId, model.id)).orderBy(desc(buildingProposals.createdAt)),
    d.db.select().from(buildingRevisions).where(eq(buildingRevisions.modelId, model.id)).orderBy(desc(buildingRevisions.revision)),
    d.db.select().from(buildingAlternatives).where(eq(buildingAlternatives.modelId, model.id)).orderBy(asc(buildingAlternatives.createdAt)),
  ]);
  const latestByProperty = new Map<string, any>();
  const reviewedByProperty = new Map<string, any>();
  for (const version of propertyVersions as any[]) {
    if (!latestByProperty.has(version.propertyId)) latestByProperty.set(version.propertyId, version);
    if (version.reviewStatus === "approved" && !reviewedByProperty.has(version.propertyId)) reviewedByProperty.set(version.propertyId, version);
  }
  const propertiesWithCurrent = (properties as any[]).map(property => ({ ...property, current: latestByProperty.get(property.id) ?? null, reviewed: reviewedByProperty.get(property.id) ?? null }));
  const withPlanRegion = (rows: any[]) => rows.map(row => ({ ...row, planRegion: row.geometry && typeof row.geometry === "object" && row.geometry.planRegion && typeof row.geometry.planRegion === "object" ? row.geometry.planRegion : null }));
  return {
    model,
    extractions,
    extractionCandidates,
    buildings,
    storeys,
    rooms: withPlanRegion(rooms as any[]),
    elements: withPlanRegion(elements as any[]),
    properties: propertiesWithCurrent,
    measurements,
    placement: (placementRows as any[])[0] ?? null,
    planSources: (planSources as any[]).map(row => ({ ...row.plan, source: { fileId: row.file.id, fileName: row.file.name, versionId: row.version.id, version: row.version.version, mimeType: row.version.mimeType, downloadUrl: `/api/projects/${model.projectId}/files/${row.file.id}/versions/${row.version.version}/download` } })),
    relationships,
    conflicts,
    proposals,
    revisions,
    alternatives,
    summary: {
      projectId: model.projectId, modelId: model.id, revision: model.revision,
      buildings: buildings.length, storeys: storeys.length, rooms: rooms.length, elements: elements.length,
      unresolvedConflicts: conflicts.length, pendingProposals: (proposals as any[]).filter(p => p.status === "pending").length,
    },
  };
};

export type BuildingModelContextOptions = { objectId?: string };
export type BuildingModelProposalInput = {
  entityType: z.infer<typeof buildingEntityTypeSchema>;
  entityId: string;
  propertyKey: string;
  value: unknown;
  unit?: string | null;
  baseRevision: number;
  reason: string;
  evidence?: z.infer<typeof buildingEvidenceSchema>[];
};
export type BuildingModelProposalExecution = { runId: string; agentId: string };

/**
 * Bounded, agent-safe read surface. It deliberately returns only approved
 * property versions; unreviewed and conflicting claims remain available from
 * the human Building Model view and are never silently promoted to context.
 */
export async function readBuildingModelContext(d: AppDeps, projectId: string, options: BuildingModelContextOptions = {}) {
  d.requirePermission("projects:read");
  const row = await modelForProject(d, projectId);
  if (!row) return null;
  const data = await readModel(d, row.model);
  const allEntities = [
    ...(data.buildings as any[]).map(entity => ({ entityType: "building" as const, entity })),
    ...(data.storeys as any[]).map(entity => ({ entityType: "storey" as const, entity })),
    ...(data.rooms as any[]).map(entity => ({ entityType: "room" as const, entity })),
    ...(data.elements as any[]).map(entity => ({ entityType: "element" as const, entity })),
  ];
  const selectedAll = options.objectId ? allEntities.filter(item => item.entity.id === options.objectId) : allEntities;
  const selected = selectedAll.slice(0, 200);
  const selectedIds = new Set(selected.map(item => item.entity.id));
  const reviewedPropertiesAll = (data.properties as any[])
    .filter(property => property.reviewed?.reviewStatus === "approved" && (!options.objectId || selectedIds.has(property.entityId)))
    .map(property => ({ propertyId: property.id, entityType: property.entityType, entityId: property.entityId, propertyKey: property.propertyKey, claimKind: property.claimKind, version: property.reviewed.version, value: property.reviewed.value, unit: property.reviewed.unit, provenance: property.reviewed.provenance, evidence: property.reviewed.evidence, reviewStatus: property.reviewed.reviewStatus }));
  const reviewedProperties = reviewedPropertiesAll.slice(0, 500);
  const missingInputs = (data.rooms as any[])
    .filter(room => !room.roomUse && (!options.objectId || room.id === options.objectId))
    .map(room => ({ entityType: "room" as const, entityId: room.id, field: "roomUse", deepLink: buildingDeepLink(projectId, "room", room.id) }));
  return {
    projectId, modelId: row.model.id, revision: row.model.revision,
    entities: selected.map(({ entityType, entity }) => ({ id: entity.id, entityType, stableKey: entity.stableKey, name: entity.name, roomUse: entity.roomUse ?? null, constructionState: entity.constructionState, deepLink: buildingDeepLink(projectId, entityType, entity.id) })),
    properties: reviewedProperties,
    measurements: (data.measurements as any[]).filter(measurement => measurement.reviewStatus === "approved" && (!options.objectId || selectedIds.has(measurement.entityId))).slice(0, 500),
    planSources: (data.planSources as any[]).slice(0, 100),
    placement: data.placement,
    conflicts: (data.conflicts as any[]).filter(conflict => !options.objectId || selectedIds.has(conflict.entityId)),
    missingInputs,
    pendingProposals: (data.proposals as any[]).filter(proposal => proposal.status === "pending").slice(0, 100).map(proposal => ({ id: proposal.id, proposalType: proposal.proposalType, payload: proposal.payload, expectedRevision: proposal.expectedRevision, deepLink: proposal.deepLink })),
    truncated: selectedAll.length > selected.length || reviewedPropertiesAll.length > reviewedProperties.length || (data.planSources as any[]).length > 100,
  };
}

export const readBuildingModelAgentContext = readBuildingModelContext;

/** Create an inspectable proposal without mutating the reviewed model. */
export async function proposeBuildingModelChange(d: AppDeps, projectId: string, input: BuildingModelProposalInput, execution: BuildingModelProposalExecution = { runId: "unknown", agentId: d.actorId }, tx = d.db) {
  d.requirePermission("projects:write");
  d.requirePermission("agent:run");
  const row = await modelForProject(d, projectId);
  if (!row) return null;
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0 || input.baseRevision !== row.model.revision)
    throw Object.assign(new Error("The building model changed; reload before proposing a change."), { status: 409, code: "revision_conflict" });
  const proposedValue = buildingPropertyValueSchema.parse(input.value);
  const evidence = z.array(buildingEvidenceSchema).max(20).parse(input.evidence ?? []);
  if (JSON.stringify(proposedValue).length > 8000) throw Object.assign(new Error("Proposed value exceeds context limit"), { status: 422, code: "value_too_large" });
  if (!(await evidenceVersionsForProject(tx, d, projectId, evidence))) throw Object.assign(new Error("Every evidence item must reference a ready source revision in this project"), { status: 422, code: "invalid_source_revision" });
  const target = await entityExists(tx, d, row.model.id, input.entityType, input.entityId);
  if (!target) throw Object.assign(new Error("Target building entity not found"), { status: 404, code: "not_found" });
  const [proposal] = await tx.insert(buildingProposals).values({ tenantId: d.tenantId, modelId: row.model.id, proposalType: "property_change", targetEntityType: input.entityType, targetEntityId: input.entityId, expectedRevision: input.baseRevision, payload: { entityType: input.entityType, entityId: input.entityId, propertyKey: input.propertyKey, value: proposedValue, unit: input.unit ?? null, reason: input.reason, evidence }, deepLink: buildingDeepLink(projectId, input.entityType, input.entityId), createdBy: d.actorId }).returning();
  await d.audit(tx, "projects.building.agent.proposal.created", "building_proposal", proposal.id, { projectId, entityType: input.entityType, entityId: input.entityId, propertyKey: input.propertyKey, expectedRevision: input.baseRevision, actorType: "agent", runId: execution.runId, agentId: execution.agentId });
  return proposal;
}

export async function createBuildingModelProposal(d: AppDeps, projectId: string, input: { objectId: string; proposedValue: unknown; propertyKey: string; baseRevision: number; reason: string; evidence?: z.infer<typeof buildingEvidenceSchema>[] }) {
  const entityType: z.infer<typeof buildingEntityTypeSchema> = "element";
  return proposeBuildingModelChange(d, projectId, { entityType, entityId: input.objectId, propertyKey: input.propertyKey, value: input.proposedValue, baseRevision: input.baseRevision, reason: input.reason, evidence: input.evidence });
}

export function createBuildingModelRouter(getDeps: GetDeps) {
  const router = Router();

  router.get("/projects/:projectId/building-model", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read");
      const projectId = uuid.parse(id(req.params.projectId));
      const row = await modelForProject(d, projectId);
      if (!row) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      return res.json(ok(await readModel(d, row.model)));
    } catch (e) { return next(e); }
  });

  // Agent-facing retrieval uses the same durable records and returns only the
  // compact, source-linked context needed for a scoped proposal.
  router.get("/projects/:projectId/building-model/agent-context", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); d.requirePermission("agent:run");
      const projectId = uuid.parse(id(req.params.projectId)); const row = await modelForProject(d, projectId);
      if (!row) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const data = await readModel(d, row.model);
      return res.json(ok({ projectId, modelId: row.model.id, revision: row.model.revision, summary: data.summary,
        entities: [
          ...(data.buildings as any[]).map(entity => ({ ...entity, entityType: "building" as const })),
          ...(data.storeys as any[]).map(entity => ({ ...entity, entityType: "storey" as const })),
          ...(data.rooms as any[]).map(entity => ({ ...entity, entityType: "room" as const })),
          ...(data.elements as any[]).map(entity => ({ ...entity, entityType: "element" as const })),
        ].map((entity: any) => ({ id: entity.id, stableKey: entity.stableKey, name: entity.name, roomUse: entity.roomUse ?? null, constructionState: entity.constructionState, deepLink: buildingDeepLink(projectId, entity.entityType, entity.id) })),
        missingInputs: (data.rooms as any[]).filter(room => !room.roomUse).map(room => ({ entityType: "room", entityId: room.id, field: "roomUse", deepLink: buildingDeepLink(projectId, "room", room.id) })),
        proposals: (data.proposals as any[]).filter(p => p.status === "pending").map(p => ({ ...p, deepLink: p.deepLink ?? buildingDeepLink(projectId, p.targetEntityType ?? "building", p.targetEntityId ?? row.model.id) })),
      }));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const input = entityInput.parse({ stableKey: req.body.stableKey, name: req.body.name, constructionState: req.body.constructionState, geometry: req.body.geometry }); const requestedBaseRevision = req.body.baseRevision === undefined ? undefined : z.number().int().nonnegative().parse(req.body.baseRevision);
      const project = await d.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).limit(1);
      if (!project[0]) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Project not found" });
      const result = await modelTransaction(d.db, async (tx: any) => {
        let model = (await tx.select().from(buildingModels).where(and(eq(buildingModels.projectId, projectId), eq(buildingModels.tenantId, d.tenantId))).limit(1))[0];
        if (!model) {
          model = (await tx.insert(buildingModels).values({ tenantId: d.tenantId, projectId, createdBy: d.actorId, revision: 1 }).returning())[0];
          await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: model.id, revision: 1, status: "draft", createdBy: d.actorId });
        } else {
          if (requestedBaseRevision === undefined) return { conflict: model.revision };
          const revision = await touchRevision(tx, d, model.id, requestedBaseRevision);
          if (revision === undefined) return { conflict: model.revision };
          model = { ...model, revision };
          await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: model.id, revision, status: "draft", createdBy: d.actorId });
        }
        const [building] = await tx.insert(buildingBuildings).values({ ...input, modelId: model.id, tenantId: d.tenantId, createdBy: d.actorId }).returning();
        await d.audit(tx, "projects.building.building.created", "building", building.id, { projectId, modelRevision: model.revision });
        return { model, building };
      });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict);
      return send(res, 201, ok(result, "Building created"));
    } catch (e) { return next(e); }
  });

  const createChild = (path: string, table: any, parentTable: any, parentColumn: any, type: string) => {
    router.post(path, async (req, res, next) => {
      try {
        const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const parentId = uuid.parse(id(req.params[`${type === "storey" ? "building" : "storey"}Id`])); const inputSchema = type === "storey" ? storeyInput : type === "element" ? elementInput : entityInput; const input = inputSchema.parse({ stableKey: req.body.stableKey, name: req.body.name, constructionState: req.body.constructionState, geometry: req.body.geometry, ...(type === "storey" ? { levelIndex: req.body.levelIndex } : type === "element" ? { kind: req.body.kind } : {}) }); const baseRevision = revisionInput.parse(req.body).baseRevision;
        const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
        const result = await modelTransaction(d.db, async (tx: any) => {
          const parentSelection = type === "element" ? { id: parentTable.id, modelId: parentTable.modelId, buildingId: buildingStoreys.buildingId } : { id: parentTable.id, modelId: parentTable.modelId };
          const [parent] = await tx.select(parentSelection).from(parentTable).where(and(eq(parentTable.id, parentId), eq(parentTable.modelId, modelRow.model.id), eq(parentTable.tenantId, d.tenantId))).limit(1);
          if (!parent) return { missing: true };
          const revision = await touchRevision(tx, d, modelRow.model.id, baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
          const values: any = { ...input, modelId: modelRow.model.id, tenantId: d.tenantId, createdBy: d.actorId, [parentColumn]: parentId };
          if (type === "element") { values.buildingId = parent.buildingId; values.storeyId = parentId; }
          const [created] = await tx.insert(table).values(values).returning();
          await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId });
          await d.audit(tx, `projects.building.${type}.created`, type, created.id, { projectId, modelRevision: revision }); return { created, revision };
        });
        if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Parent entity not found" });
        if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict);
        return send(res, 201, ok(result));
      } catch (e) { return next(e); }
    });
  };
  createChild("/projects/:projectId/building-model/buildings/:buildingId/storeys", buildingStoreys, buildingBuildings, "buildingId", "storey");
  createChild("/projects/:projectId/building-model/storeys/:storeyId/rooms", buildingRooms, buildingStoreys, "storeyId", "room");
  createChild("/projects/:projectId/building-model/storeys/:storeyId/elements", buildingElements, buildingStoreys, "storeyId", "element");
  router.post("/projects/:projectId/building-model/rooms/:roomId/elements", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const roomId = uuid.parse(id(req.params.roomId)); const input = elementInput.parse({ stableKey: req.body.stableKey, name: req.body.name, constructionState: req.body.constructionState, geometry: req.body.geometry, kind: req.body.kind }); const baseRevision = revisionInput.parse(req.body).baseRevision;
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const result = await modelTransaction(d.db, async (tx: any) => { const room = (await tx.select({ id: buildingRooms.id, storeyId: buildingRooms.storeyId }).from(buildingRooms).where(and(eq(buildingRooms.id, roomId), eq(buildingRooms.modelId, modelRow.model.id), eq(buildingRooms.tenantId, d.tenantId))).limit(1))[0]; if (!room) return { missing: true }; const building = (await tx.select({ id: buildingStoreys.buildingId }).from(buildingStoreys).where(eq(buildingStoreys.id, room.storeyId)).limit(1))[0]; const revision = await touchRevision(tx, d, modelRow.model.id, baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const [created] = await tx.insert(buildingElements).values({ ...input, tenantId: d.tenantId, modelId: modelRow.model.id, buildingId: building.id, storeyId: room.storeyId, roomId, createdBy: d.actorId }).returning(); await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.element.created", "element", created.id, { projectId, roomId, modelRevision: revision }); return { created, revision }; });
      if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Room not found" }); if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 201, ok(result));
    } catch (e) { return next(e); }
  });

  router.patch("/projects/:projectId/building-model/:entityType/:entityId", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const type = entityType.parse(id(req.params.entityType)); const entityId = uuid.parse(id(req.params.entityId)); const input = z.object({ ...revisionInput.shape, name: z.string().trim().min(1).max(300).optional(), roomUse: z.string().trim().max(200).nullable().optional(), constructionState: buildingConstructionStateSchema.optional(), geometry: z.unknown().nullable().optional(), evidence: z.array(buildingEvidenceSchema).max(20).default([]) }).strict().parse(req.body);
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      if (input.roomUse !== undefined && !input.evidence.length) return send(res, 422, { data: null, error: { code: "evidence_required" }, message: "A room-use correction requires exact source evidence" });
      if (!(await evidenceVersionsForProject(d.db, d, projectId, input.evidence))) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "Every evidence item must reference a ready source revision in this project" });
      const table = tableFor(type); const { baseRevision, evidence, ...changes } = input;
      const result = await modelTransaction(d.db, async (tx: any) => { const revision = await touchRevision(tx, d, modelRow.model.id, baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const [updated] = await tx.update(table).set(changes).where(and(eq(table.id, entityId), eq(table.modelId, modelRow.model.id), eq(table.tenantId, d.tenantId))).returning(); if (!updated) return { missing: true }; if (input.roomUse !== undefined && type === "room") { let property = (await tx.select().from(buildingProperties).where(and(eq(buildingProperties.modelId, modelRow.model.id), eq(buildingProperties.entityType, "room"), eq(buildingProperties.entityId, entityId), eq(buildingProperties.propertyKey, "roomUse"))).limit(1))[0]; if (!property) property = (await tx.insert(buildingProperties).values({ tenantId: d.tenantId, modelId: modelRow.model.id, entityType: "room", entityId, propertyKey: "roomUse", claimKind: "observed_fact", createdBy: d.actorId }).returning())[0]; const latest = (await tx.select({ version: buildingPropertyVersions.version, value: buildingPropertyVersions.value, evidence: buildingPropertyVersions.evidence, reviewStatus: buildingPropertyVersions.reviewStatus }).from(buildingPropertyVersions).where(eq(buildingPropertyVersions.propertyId, property!.id)).orderBy(desc(buildingPropertyVersions.version)).limit(1))[0]; await tx.insert(buildingPropertyVersions).values({ tenantId: d.tenantId, propertyId: property!.id, version: (latest?.version ?? 0) + 1, value: input.roomUse, provenance: "manual", evidence, reviewStatus: "approved", reviewedBy: d.actorId, reviewedAt: new Date(), createdBy: d.actorId }); if (latest?.reviewStatus === "approved" && JSON.stringify(latest.value) !== JSON.stringify(input.roomUse)) await tx.insert(buildingConflicts).values({ tenantId: d.tenantId, modelId: modelRow.model.id, propertyId: property!.id, entityType: "room", entityId, propertyKey: "roomUse", claims: [{ value: latest.value, evidence: latest.evidence }, { value: input.roomUse, evidence }], createdBy: d.actorId }); } await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId }); await d.audit(tx, `projects.building.${type}.updated`, type, entityId, { projectId, fields: Object.keys(changes), modelRevision: revision, reviewedRoomUse: input.roomUse !== undefined }); return { updated, revision }; });
      if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Entity not found" }); if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model/properties", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const input = propertyInput.parse(req.body); const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      if (!(await evidenceVersionsForProject(d.db, d, projectId, input.evidence))) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "Every evidence item must reference a ready source revision in this project" });
      const result = await modelTransaction(d.db, async (tx: any) => { if (!(await entityExists(tx, d, modelRow.model.id, input.entityType, input.entityId))) return { missing: true }; const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; let property = (await tx.select().from(buildingProperties).where(and(eq(buildingProperties.modelId, modelRow.model.id), eq(buildingProperties.entityType, input.entityType), eq(buildingProperties.entityId, input.entityId), eq(buildingProperties.propertyKey, input.propertyKey))).limit(1))[0]; if (!property) property = (await tx.insert(buildingProperties).values({ tenantId: d.tenantId, modelId: modelRow.model.id, entityType: input.entityType, entityId: input.entityId, propertyKey: input.propertyKey, claimKind: input.claimKind, createdBy: d.actorId }).returning())[0]; const latest = (await tx.select({ version: buildingPropertyVersions.version, value: buildingPropertyVersions.value, reviewStatus: buildingPropertyVersions.reviewStatus, evidence: buildingPropertyVersions.evidence }).from(buildingPropertyVersions).where(eq(buildingPropertyVersions.propertyId, property.id)).orderBy(desc(buildingPropertyVersions.version)).limit(1))[0]; const version = (await tx.insert(buildingPropertyVersions).values({ tenantId: d.tenantId, propertyId: property.id, version: (latest?.version ?? 0) + 1, value: input.value, unit: input.unit ?? null, provenance: input.provenance, evidence: input.evidence, createdBy: d.actorId }).returning())[0]; if (latest && latest.reviewStatus === "approved" && JSON.stringify(latest.value) !== JSON.stringify(input.value)) await tx.insert(buildingConflicts).values({ tenantId: d.tenantId, modelId: modelRow.model.id, propertyId: property.id, entityType: input.entityType, entityId: input.entityId, propertyKey: input.propertyKey, claims: [{ value: latest.value, evidence: latest.evidence }, { value: input.value, evidence: input.evidence }], createdBy: d.actorId }); await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.property.created", "building_property", property.id, { projectId, propertyKey: input.propertyKey, claimKind: input.claimKind, version: version.version, modelRevision: revision }); return { property, version, revision }; });
      if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Entity not found" }); if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 201, ok(result));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model/properties/:propertyId/versions/:version/review", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const propertyId = uuid.parse(id(req.params.propertyId)); const version = z.coerce.number().int().positive().parse(id(req.params.version)); const input = z.object({ baseRevision: z.number().int().nonnegative(), reviewRevision: z.number().int().nonnegative(), decision: z.enum(["approved", "rejected"]), note: z.string().max(2000).nullable().optional() }).strict().parse(req.body); const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const result = await modelTransaction(d.db, async (tx: any) => { const property = (await tx.select({ id: buildingProperties.id, modelId: buildingProperties.modelId, entityType: buildingProperties.entityType, entityId: buildingProperties.entityId, propertyKey: buildingProperties.propertyKey }).from(buildingProperties).where(and(eq(buildingProperties.id, propertyId), eq(buildingProperties.modelId, modelRow.model.id), eq(buildingProperties.tenantId, d.tenantId))).limit(1))[0]; if (!property) return { missing: true }; const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const updated = await tx.update(buildingPropertyVersions).set({ reviewStatus: input.decision, reviewRevision: sql`${buildingPropertyVersions.reviewRevision} + 1`, reviewedBy: d.actorId, reviewedAt: new Date(), reviewNote: input.note ?? null }).where(and(eq(buildingPropertyVersions.propertyId, propertyId), eq(buildingPropertyVersions.version, version), eq(buildingPropertyVersions.reviewRevision, input.reviewRevision), eq(buildingPropertyVersions.tenantId, d.tenantId))).returning(); if (!updated.length) return { reviewConflict: true };
      if (property.entityType === "room" && property.propertyKey === "roomUse") {
        const [approved] = await tx.select({value:buildingPropertyVersions.value}).from(buildingPropertyVersions).where(and(eq(buildingPropertyVersions.propertyId,propertyId),eq(buildingPropertyVersions.tenantId,d.tenantId),eq(buildingPropertyVersions.reviewStatus,"approved"))).orderBy(desc(buildingPropertyVersions.version)).limit(1);
        await tx.update(buildingRooms).set({roomUse:typeof approved?.value==="string"?approved.value:null}).where(and(eq(buildingRooms.id,property.entityId),eq(buildingRooms.modelId,modelRow.model.id),eq(buildingRooms.tenantId,d.tenantId)));
      }
      await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: input.decision === "approved" ? "approved" : "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.property.reviewed", "building_property_version", updated[0].id, { projectId, propertyId, version, decision: input.decision, modelRevision: revision }); return { version: updated[0], revision }; });
      if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Property not found" }); if ((result as any).reviewConflict) return send(res, 409, { data: null, error: { code: "review_revision_conflict" }, message: "Property version was reviewed by someone else" }); if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model/measurements", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const input = measurementInput.parse(req.body); const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      if (!(await evidenceVersionsForProject(d.db, d, projectId, input.evidence))) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "Every evidence item must reference a ready source revision in this project" });
      const result = await modelTransaction(d.db, async (tx: any) => { if (!(await entityExists(tx, d, modelRow.model.id, input.entityType, input.entityId))) return { missing: true }; const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const { baseRevision: _baseRevision, value, ...measurementValues } = input; const [measurement] = await tx.insert(buildingMeasurements).values({ ...measurementValues, value: String(value), tenantId: d.tenantId, modelId: modelRow.model.id, createdBy: d.actorId }).returning(); await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.measurement.created", "building_measurement", measurement.id, { projectId, modelRevision: revision }); return { measurement, revision }; });
      if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Entity not found" }); if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 201, ok(result));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model/measurements/:measurementId/review", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const measurementId = uuid.parse(id(req.params.measurementId)); const input = z.object({ baseRevision: z.number().int().nonnegative(), reviewRevision: z.number().int().nonnegative(), decision: z.enum(["approved", "rejected"]) }).strict().parse(req.body); const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const result = await modelTransaction(d.db, async (tx: any) => { const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const updated = await tx.update(buildingMeasurements).set({ reviewStatus: input.decision, reviewRevision: sql`${buildingMeasurements.reviewRevision} + 1`, reviewedBy: d.actorId, reviewedAt: new Date() }).where(and(eq(buildingMeasurements.id, measurementId), eq(buildingMeasurements.modelId, modelRow.model.id), eq(buildingMeasurements.tenantId, d.tenantId), eq(buildingMeasurements.reviewRevision, input.reviewRevision))).returning(); if (!updated.length) return { missingOrConflict: true }; await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: input.decision === "approved" ? "approved" : "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.measurement.reviewed", "building_measurement", measurementId, { projectId, decision: input.decision, modelRevision: revision }); return { measurement: updated[0], revision }; });
      if ((result as any).missingOrConflict) return send(res, 409, { data: null, error: { code: "review_revision_conflict" }, message: "Measurement was reviewed by someone else or does not exist" }); if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model/relationships", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const input = relationshipInput.parse(req.body); const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const result = await modelTransaction(d.db, async (tx: any) => { if (!(await entityExists(tx, d, modelRow.model.id, input.fromEntityType, input.fromEntityId)) || !(await entityExists(tx, d, modelRow.model.id, input.toEntityType, input.toEntityId))) return { missing: true }; const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const { baseRevision: _baseRevision, ...relationshipValues } = input; const [relationship] = await tx.insert(buildingRelationships).values({ ...relationshipValues, tenantId: d.tenantId, modelId: modelRow.model.id, createdBy: d.actorId }).returning(); await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.relationship.created", "building_relationship", relationship.id, { projectId, modelRevision: revision }); return { relationship, revision }; });
      if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Entity not found" }); if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 201, ok(result));
    } catch (e) { return next(e); }
  });

  router.put("/projects/:projectId/building-model/placement", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), origin: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite().optional() }).strict(), orientation: z.object({ degrees: z.number().finite() }).strict().nullable().optional(), alignmentStatus: z.enum(["unknown", "approximate", "reviewed"]).default("unknown"), evidence: z.array(buildingEvidenceSchema).max(20).default([]) }).strict().parse(req.body);
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      if (!(await evidenceVersionsForProject(d.db, d, projectId, input.evidence))) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "Every evidence item must reference a ready source revision in this project" });
      const result = await modelTransaction(d.db, async (tx: any) => { const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const current = (await tx.select({ id: buildingPlacements.id }).from(buildingPlacements).where(eq(buildingPlacements.modelId, modelRow.model.id)).limit(1))[0]; const placement = current ? (await tx.update(buildingPlacements).set({ origin: input.origin, orientation: input.orientation ?? null, alignmentStatus: input.alignmentStatus, evidence: input.evidence }).where(eq(buildingPlacements.id, current.id)).returning())[0] : (await tx.insert(buildingPlacements).values({ tenantId: d.tenantId, modelId: modelRow.model.id, origin: input.origin, orientation: input.orientation ?? null, alignmentStatus: input.alignmentStatus, evidence: input.evidence, createdBy: d.actorId }).returning())[0]; await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.placement.updated", "building_placement", placement.id, { projectId, alignmentStatus: input.alignmentStatus, modelRevision: revision }); return { placement, revision }; });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model/plan-sources", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), storeyId: uuid.nullable().optional(), sourceVersionId: uuid, page: z.number().int().positive(), pageCount: z.number().int().positive().nullable().optional(), layers: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(300), defaultVisible: z.boolean().optional() }).strict()).max(200).default([]), coordinateReference: z.string().max(200).nullable().optional(), alignmentStatus: z.enum(["unknown", "approximate", "reviewed"]).default("unknown") }).strict().parse(req.body);
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const source = await d.db.select({ id: fileVersions.id }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId)).where(and(eq(fileVersions.id, input.sourceVersionId), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready"), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId))).limit(1); if (!source[0]) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "Source revision is not a ready file revision in this project" });
      if (input.storeyId && !(await entityExists(d.db, d, modelRow.model.id, "storey", input.storeyId))) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Storey not found" });
      const result = await modelTransaction(d.db, async (tx: any) => { const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const [planSource] = await tx.insert(buildingPlanSources).values({ ...input, tenantId: d.tenantId, modelId: modelRow.model.id, createdBy: d.actorId }).returning(); await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.plan_source.created", "building_plan_source", planSource.id, { projectId, sourceVersionId: input.sourceVersionId, page: input.page, modelRevision: revision }); return { planSource, revision }; });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 201, ok(result));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model/reconciliations", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const input = z.object({ baseRevision: z.number().int().nonnegative(), sourceVersionId: uuid, sourceEntityKey: z.string().trim().min(1).max(200), targetEntityType: entityType, targetEntityId: uuid.nullable().optional(), method: z.enum(["exact", "manual"]), status: z.enum(["proposed", "accepted", "rejected"]).default("proposed"), note: z.string().max(2000).nullable().optional() }).strict().parse(req.body); const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const validSource = await d.db.select({ id: fileVersions.id }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId)).where(and(eq(fileVersions.id, input.sourceVersionId), eq(fileVersions.tenantId, d.tenantId), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId), eq(fileVersions.status, "ready"))).limit(1); if (!validSource[0]) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "Source revision is not a ready file revision in this project" });
      if (input.targetEntityId && !(await entityExists(d.db,d,modelRow.model.id,input.targetEntityType,input.targetEntityId))) return send(res,422,{data:null,error:{code:"invalid_target"},message:"Target entity is not in this building model"});
      if (!input.targetEntityId && input.status === "accepted") return send(res, 422, { data: null, error: { code: "target_required" }, message: "An accepted reconciliation must name a stable target entity" });
      const result = await modelTransaction(d.db, async (tx: any) => { const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const [link] = await tx.insert(buildingReconciliations).values({ ...input, tenantId: d.tenantId, modelId: modelRow.model.id, createdBy: d.actorId, reviewedBy: input.status === "accepted" ? d.actorId : null, reviewedAt: input.status === "accepted" ? new Date() : null }).onConflictDoUpdate({ target: [buildingReconciliations.modelId, buildingReconciliations.sourceVersionId, buildingReconciliations.sourceEntityKey], set: { targetEntityType: input.targetEntityType, targetEntityId: input.targetEntityId ?? null, method: input.method, status: input.status, note: input.note ?? null, reviewedBy: input.status === "accepted" ? d.actorId : null, reviewedAt: input.status === "accepted" ? new Date() : null } }).returning(); await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.reconciliation.updated", "building_reconciliation", link.id, { projectId, sourceVersionId: input.sourceVersionId, sourceEntityKey: input.sourceEntityKey, method: input.method, status: input.status, modelRevision: revision }); return { link, revision }; });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 201, ok(result));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model/proposals", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const input = proposalInput.parse(req.body); const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      if (input.targetEntityId && (!input.targetEntityType || !(await entityExists(d.db,d,modelRow.model.id,input.targetEntityType,input.targetEntityId)))) return send(res,422,{data:null,error:{code:"invalid_target"},message:"Target entity is not in this building model"});
      if (input.targetEntityType && !input.targetEntityId) return send(res, 422, { data: null, error: { code: "target_required" }, message: "A targeted proposal must name a stable entity" });
      const [proposal] = await d.db.insert(buildingProposals).values({ tenantId: d.tenantId, modelId: modelRow.model.id, proposalType: input.proposalType, targetEntityType: input.targetEntityType ?? null, targetEntityId: input.targetEntityId ?? null, expectedRevision: input.expectedRevision ?? input.baseRevision, payload: input.payload, deepLink: input.targetEntityType && input.targetEntityId ? buildingDeepLink(projectId, input.targetEntityType, input.targetEntityId) : `/projects/${projectId}/building`, createdBy: d.actorId }).returning(); await d.audit(d.db, "projects.building.proposal.created", "building_proposal", proposal.id, { projectId, expectedRevision: proposal.expectedRevision }); return send(res, 201, ok(proposal));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/building-model/proposals/:proposalId/review", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId)); const proposalId = uuid.parse(id(req.params.proposalId)); const input = z.object({ baseRevision: z.number().int().nonnegative(), decision: z.enum(["approved", "rejected"]), note: z.string().max(2000).nullable().optional() }).strict().parse(req.body); const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const result = await modelTransaction(d.db, async (tx: any) => { const [proposal] = await tx.select().from(buildingProposals).where(and(eq(buildingProposals.id, proposalId), eq(buildingProposals.modelId, modelRow.model.id), eq(buildingProposals.tenantId, d.tenantId))).limit(1); if (!proposal) return { missing: true }; if (proposal.status !== "pending") return { invalid: true }; if (proposal.expectedRevision !== input.baseRevision) return { conflict: modelRow.model.revision }; const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; if (input.decision === "approved") { if (!proposal.targetEntityType || !proposal.targetEntityId || !(await entityExists(tx,d,modelRow.model.id,proposal.targetEntityType,proposal.targetEntityId))) return { invalidSource:true }; const payload = proposal.payload as any; const propertyKey = z.string().min(1).max(200).parse(payload.propertyKey); const value = buildingPropertyValueSchema.parse(payload.value); const evidence = z.array(buildingEvidenceSchema).max(20).parse(payload.evidence ?? []); if (!(await evidenceVersionsForProject(tx, d, projectId, evidence))) return { invalidSource: true }; let property = (await tx.select().from(buildingProperties).where(and(eq(buildingProperties.modelId, modelRow.model.id), eq(buildingProperties.entityType, proposal.targetEntityType), eq(buildingProperties.entityId, proposal.targetEntityId), eq(buildingProperties.propertyKey, propertyKey))).limit(1))[0]; if (!property) property = (await tx.insert(buildingProperties).values({ tenantId: d.tenantId, modelId: modelRow.model.id, entityType: proposal.targetEntityType, entityId: proposal.targetEntityId, propertyKey, claimKind: "observed_fact", createdBy: d.actorId }).returning())[0]; const latest = (await tx.select({ version: buildingPropertyVersions.version }).from(buildingPropertyVersions).where(eq(buildingPropertyVersions.propertyId, property.id)).orderBy(desc(buildingPropertyVersions.version)).limit(1))[0]; await tx.insert(buildingPropertyVersions).values({ tenantId: d.tenantId, propertyId: property.id, version: (latest?.version ?? 0) + 1, value, unit: payload.unit ?? null, provenance: "manual", evidence, reviewStatus: "approved", reviewedBy: d.actorId, reviewedAt: new Date(), reviewNote: input.note ?? null, createdBy: d.actorId }); if (proposal.targetEntityType === "room" && propertyKey === "roomUse") await tx.update(buildingRooms).set({ roomUse: typeof value === "string" ? value : null }).where(and(eq(buildingRooms.id, proposal.targetEntityId), eq(buildingRooms.modelId, modelRow.model.id))); } await tx.update(buildingProposals).set({ status: input.decision === "approved" ? "approved" : "rejected" }).where(eq(buildingProposals.id, proposalId)); const [review] = await tx.insert(buildingReviews).values({ tenantId: d.tenantId, proposalId, decision: input.decision, note: input.note ?? null, reviewedBy: d.actorId }).returning(); await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: input.decision === "approved" ? "approved" : "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.proposal.reviewed", "building_proposal", proposalId, { projectId, decision: input.decision, applied: input.decision === "approved", modelRevision: revision }); return { review, revision }; });
      if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Proposal not found" }); if ((result as any).invalid) return send(res, 409, { data: null, error: { code: "proposal_already_reviewed" }, message: "Proposal was already reviewed" }); if ((result as any).invalidSource) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "Proposal evidence is not a ready source revision in this project" }); if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  router.use(createBuildingExtractionRouter(getDeps));
  return router;
}
