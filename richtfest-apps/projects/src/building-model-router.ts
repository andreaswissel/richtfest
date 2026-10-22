import { lockProject } from "./project-lock";
import { assembleFireProtectionSnapshot } from "./fire-protection";
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
  buildingComponentProperties,
  componentDataRequest,
  dataRequestProgress,
  componentInputGaps,
  elementComponentType,
  soundInsulationChecks,
  regulatoryBasisGaps,
  regulatoryBasisKeys,
  developmentPlanZoningKeys,
  zoningLimits,
  zoningChecks,
  zoningCheckMethod,
  validateBuildingComponentProperty,
  type FeasibilitySiteFigures,
  type BuildingComponentRecord,
  type SitePlan,
} from "@richtfest/shared";
import {
  buildingAlternatives,
  buildingBuildings,
  buildingColourLegends,
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
  buildingSupersededSources,
  fileVersions,
  files,
  projects,
  sourceExtractions,
  sourceModels,
} from "./schema";
import type { AppDeps } from "./deps";
import { createBuildingExtractionRouter } from "./building-extraction-router";
import { createBuildingOutlineRouter } from "./building-outline-router";
import { createIfcBuildingRouter } from "./ifc-building-router";
import { derivedWritable, effectiveValue, planWallAdjacency, roomSpaceContext, wallAdjacencyMethod, type PageScale } from "./wall-adjacency";
import { buildingExtractionJobs, buildingExtractionCandidates, buildingSelectionMasks, inquiries } from "./schema";
import { planStoreyCeilings, storeyCeilingMethod } from "./storey-ceilings";
import { planOpeningMethod, planOpenings, type OpeningPage, type TracedOpening } from "./plan-openings";
import { planStoreyLevels, storeyLevelFromText, type StoreyLevelReading } from "./storey-levels";
import { sourcePages } from "./schema";
import { documentTypesFor } from "./document-types";
import { developmentPlanNoiseMethod, developmentPlanZoningMethod, readDevelopmentPlanNoise, readDevelopmentPlanZoning } from "./development-plan";
import { constructionDescriptionMethod, mergeComponentStatements, readConstructionDescription } from "./construction-description";

type GetDeps = (req: Request) => AppDeps;
// Existing route handlers return validation results. Roll those results back,
// including any optimistic revision increment performed earlier in the callback.
class ModelTransactionRejected { constructor(readonly result: any) {} }
export async function modelTransaction(db: any, work: (tx: any) => Promise<any>) {
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

export const modelForProject = async (d: AppDeps, projectId: string) => {
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
export const touchRevision = async (tx: any, d: AppDeps, modelId: string, baseRevision: number) => {
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
export const evidenceVersionsForProject = async (db: any, d: AppDeps, projectId: string, evidence: z.infer<typeof buildingEvidenceSchema>[]) => {
  // Correspondence evidence is written only by Richtfest when it reads an inquiry reply.
  if (evidence.some(item => item.kind === "correspondence")) return false;
  const ids = [...new Set(evidence.flatMap(item => "sourceVersionId" in item && item.sourceVersionId ? [item.sourceVersionId] : []))];
  if (!ids.length) return true;
  const rows = await db.select({ id: fileVersions.id }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId)).where(and(inArray(fileVersions.id, ids), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready"), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId)));
  return rows.length === ids.length;
};

/** Append a property version; a differing value over an approved one records a conflict instead of overwriting it. */
export async function appendPropertyVersion(tx: any, d: AppDeps, modelId: string, input: { entityType: string; entityId: string; propertyKey: string; claimKind?: string; value: unknown; unit?: string | null; provenance: string; evidence: unknown[] }) {
  let property = (await tx.select().from(buildingProperties).where(and(eq(buildingProperties.modelId, modelId), eq(buildingProperties.entityType, input.entityType), eq(buildingProperties.entityId, input.entityId), eq(buildingProperties.propertyKey, input.propertyKey))).limit(1))[0];
  if (!property) property = (await tx.insert(buildingProperties).values({ tenantId: d.tenantId, modelId, entityType: input.entityType, entityId: input.entityId, propertyKey: input.propertyKey, claimKind: input.claimKind ?? "observed_fact", createdBy: d.actorId }).returning())[0];
  const latest = (await tx.select({ version: buildingPropertyVersions.version, value: buildingPropertyVersions.value, reviewStatus: buildingPropertyVersions.reviewStatus, evidence: buildingPropertyVersions.evidence }).from(buildingPropertyVersions).where(eq(buildingPropertyVersions.propertyId, property.id)).orderBy(desc(buildingPropertyVersions.version)).limit(1))[0];
  const version = (await tx.insert(buildingPropertyVersions).values({ tenantId: d.tenantId, propertyId: property.id, version: (latest?.version ?? 0) + 1, value: input.value, unit: input.unit ?? null, provenance: input.provenance, evidence: input.evidence, createdBy: d.actorId }).returning())[0];
  if (latest && latest.reviewStatus === "approved" && JSON.stringify(latest.value) !== JSON.stringify(input.value)) await tx.insert(buildingConflicts).values({ tenantId: d.tenantId, modelId, propertyId: property.id, entityType: input.entityType, entityId: input.entityId, propertyKey: input.propertyKey, claims: [{ value: latest.value, evidence: latest.evidence }, { value: input.value, evidence: input.evidence }], createdBy: d.actorId });
  return { property, version, previous: latest ?? null };
}

/**
 * The fill colours a plan set's wall extraction found, with the pages they occur on, the
 * suggested reading and the reading a person saved. Newest completed run per page.
 */
const planColourLegend = (jobs: any[], saved: any | null) => {
  const latest = new Map<number, any>();
  for (const job of jobs) if (job.status === "complete" && (!latest.has(job.page) || latest.get(job.page).updatedAt < job.updatedAt)) latest.set(job.page, job);
  const colours = new Map<string, { colour: string; layer: string; count: number; pages: number[]; suggested: string; example: unknown }>();
  for (const job of latest.values()) for (const item of Array.isArray(job.result?.topologyCoverage?.wallColours) ? job.result.topologyCoverage.wallColours : []) {
    const key = `${item.layer}:${item.colour}`, entry = colours.get(key);
    if (entry) { entry.count += item.count; if (!entry.pages.includes(job.page)) entry.pages.push(job.page); }
    else colours.set(key, { colour: item.colour, layer: item.layer, count: item.count, pages: [job.page], suggested: item.suggested, example: { page: job.page, region: item.example } });
  }
  const entries: Array<{ colour: string; layer: string; state: string }> = Array.isArray(saved?.entries) ? saved.entries : [];
  return { colours: [...colours.values()].sort((a, b) => b.count - a.count).map(item => ({ ...item, pages: item.pages.sort((a, b) => a - b),
    state: entries.find(entry => entry.colour === item.colour && entry.layer === item.layer)?.state ?? null })),
    savedAt: entries.length ? saved?.updatedAt ?? null : null };
};

/** The scale each plan page was read at, and the plan set's scale where a person set one. */
const planScaleSummary = (jobs: any[], saved: any | null) => {
  const latest = new Map<number, any>();
  for (const job of jobs) if (job.status === "complete" && (!latest.has(job.page) || latest.get(job.page).updatedAt < job.updatedAt)) latest.set(job.page, job);
  const pages = [...latest.values()].sort((a, b) => a.page - b.page).map(job => {
    const scale = job.result?.scaleObservation;
    return { page: job.page, denominator: typeof scale?.denominator === "number" ? scale.denominator : null, source: typeof scale?.source === "string" ? scale.source : null,
      agreeingPairs: typeof scale?.agreeingPairs === "number" ? scale.agreeingPairs : 0, quote: typeof scale?.quote === "string" ? scale.quote : null };
  });
  return { pages, savedDenominator: typeof saved?.scaleDenominator === "number" ? saved.scaleDenominator : null };
};

const readModel = async (d: AppDeps, model: any) => {
  const [allExtractions, allExtractionCandidates, allAutomaticSources, colourLegendRows, supersededRows] = await Promise.all([
    d.db.select().from(buildingExtractionJobs).where(and(eq(buildingExtractionJobs.modelId, model.id), eq(buildingExtractionJobs.tenantId, d.tenantId))),
    d.db.select().from(buildingExtractionCandidates).where(and(eq(buildingExtractionCandidates.modelId, model.id), eq(buildingExtractionCandidates.tenantId, d.tenantId))),
    d.db.select({ fileId: files.id, fileName: files.name, sourceVersionId: fileVersions.id,
      version: fileVersions.version, mimeType: fileVersions.mimeType,
      sourceStatus: sourceExtractions.status, sourceResult: sourceExtractions.result,
      classificationStatus: sourceModels.status, classificationMetadata: sourceModels.metadata })
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready")))
      .innerJoin(sourceExtractions, and(eq(sourceExtractions.versionId, fileVersions.id), eq(sourceExtractions.tenantId, d.tenantId)))
      .innerJoin(sourceModels, and(eq(sourceModels.versionId, fileVersions.id), eq(sourceModels.tenantId, d.tenantId)))
      .where(and(eq(files.projectId, model.projectId), eq(files.tenantId, d.tenantId), eq(files.purpose, "project_evidence"),
        sql`(${fileVersions.mimeType} = 'application/pdf' or ${files.name} ~* '\\.pdf$')`,
        // Only sources enrolled for automatic processing; others would never progress.
        sql`${sourceModels.metadata}->'automaticBuildingModel' is not null`)),
    d.db.select().from(buildingColourLegends).where(and(eq(buildingColourLegends.modelId, model.id), eq(buildingColourLegends.tenantId, d.tenantId))),
    d.db.select({ superseded: buildingSupersededSources, fileName: files.name }).from(buildingSupersededSources)
      .innerJoin(fileVersions, and(eq(fileVersions.id, buildingSupersededSources.sourceVersionId), eq(fileVersions.tenantId, d.tenantId)))
      .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, d.tenantId)))
      .where(and(eq(buildingSupersededSources.modelId, model.id), eq(buildingSupersededSources.tenantId, d.tenantId))),
  ]);
  // Superseded plan sets leave the model: their jobs, candidates and page storeys are kept but not shown.
  const supersededVersionIds = new Set((supersededRows as any[]).map(row => row.superseded.sourceVersionId));
  const extractions = (allExtractions as any[]).filter(job => !supersededVersionIds.has(job.sourceVersionId));
  const activeJobIds = new Set(extractions.map(job => job.id));
  const extractionCandidates = (allExtractionCandidates as any[]).filter(candidate => activeJobIds.has(candidate.jobId));
  const automaticSources = (allAutomaticSources as any[]).filter(source => !supersededVersionIds.has(source.sourceVersionId));
  const [buildings, allStoreys, allRooms, allElements, properties, propertyVersions, measurements, allPlanSources, placementRows, relationships, conflicts, proposals, revisions, alternatives] = await Promise.all([
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

  const planSources = (allPlanSources as any[]).filter(row => !supersededVersionIds.has(row.plan.sourceVersionId));
  const activeStoreyIds = new Set(planSources.map(row => row.plan.storeyId).filter(Boolean));
  const supersededStoreyIds = new Set((allPlanSources as any[]).filter(row => supersededVersionIds.has(row.plan.sourceVersionId) && row.plan.storeyId && !activeStoreyIds.has(row.plan.storeyId)).map(row => row.plan.storeyId));
  const storeys = (allStoreys as any[]).filter(storey => !supersededStoreyIds.has(storey.id));
  const rooms = (allRooms as any[]).filter(room => !supersededStoreyIds.has(room.storeyId));
  const elements = (allElements as any[]).filter(element => !element.storeyId || !supersededStoreyIds.has(element.storeyId));
  const supersededSources = (supersededRows as any[]).map(row => ({ sourceVersionId: row.superseded.sourceVersionId, fileName: row.fileName,
    supersededByVersionId: row.superseded.supersededByVersionId, createdBy: row.superseded.createdBy, createdAt: row.superseded.createdAt }));
  const latestByProperty = new Map<string, any>();
  const reviewedByProperty = new Map<string, any>();
  for (const version of propertyVersions as any[]) {
    if (!latestByProperty.has(version.propertyId)) latestByProperty.set(version.propertyId, version);
    if (version.reviewStatus === "approved" && !reviewedByProperty.has(version.propertyId)) reviewedByProperty.set(version.propertyId, version);
  }
  const propertiesWithCurrent = (properties as any[]).map(property => ({ ...property, current: latestByProperty.get(property.id) ?? null, reviewed: reviewedByProperty.get(property.id) ?? null }));
  const withPlanRegion = (rows: any[]) => rows.map(row => ({ ...row, planRegion: row.geometry && typeof row.geometry === "object" && row.geometry.planRegion && typeof row.geometry.planRegion === "object" ? row.geometry.planRegion : null }));
  const extractionJobsBySource = new Map<string, any[]>();
  for (const extraction of extractions as any[]) extractionJobsBySource.set(extraction.sourceVersionId,
    [...(extractionJobsBySource.get(extraction.sourceVersionId) ?? []), extraction]);
  const automaticPlanProcessing = (automaticSources as any[]).map(source => {
    const metadata = source.classificationMetadata?.automaticBuildingModel ?? null;
    const extractionJobs = extractionJobsBySource.get(source.sourceVersionId) ?? [];
    const jobStatuses = extractionJobs.reduce((counts: Record<string, number>, job: any) => {
      counts[job.status] = (counts[job.status] ?? 0) + 1; return counts;
    }, {});
    const hasUnresolvedCoverage = metadata?.status === "partial" || (metadata?.unresolvedPages?.length ?? 0) > 0;
    const status = extractionJobs.some((job: any) => job.status === "running") ? "extracting"
      : extractionJobs.some((job: any) => job.status === "queued") ? "queued"
      : hasUnresolvedCoverage && extractionJobs.length ? "partial"
      : extractionJobs.length && extractionJobs.every((job: any) => job.status === "complete") ? "complete"
      : extractionJobs.some((job: any) => job.status === "failed") ? "partial"
      : metadata?.status === "unresolved" ? "unresolved"
      : metadata?.status === "failed" ? "failed"
      : ["queued", "running"].includes(source.sourceStatus) ? "reading_source"
      : ["queued", "running"].includes(source.classificationStatus) ? "classifying_pages"
      : metadata?.status ?? "planning";
    const activeJob = extractionJobs.find((job: any) => job.status === "running");
    const currentPhase = ["queued", "running"].includes(source.sourceStatus) ? "reading_plan"
      : ["queued", "running"].includes(source.classificationStatus) ? "identifying_floors"
      : status === "failed" ? "failed"
      : !metadata || metadata.status === "processing" ? "identifying_floors"
      : activeJob?.result?.phase ?? (extractionJobs.some((job: any) => job.status === "queued") ? "extracting_geometry"
        : status === "complete" ? "complete" : status === "partial" ? "partial"
        : status === "unresolved" ? "unsupported" : "preparing_draft");
    const activeInference = extractionJobs.find((job: any) => job.result?.inference?.active === true)?.result?.inference ?? null;
    const errors = extractionJobs.filter((job: any) => job.status === "failed" || job.result?.phase === "retrying")
      .map((job: any) => ({ jobId: job.id, page: job.page, status: job.status, retryable: job.result?.retryable ?? false,
        attempts: job.attempts, reason: job.result?.reason ?? null }));
    return { fileId: source.fileId, fileName: source.fileName, sourceVersionId: source.sourceVersionId, status,
      currentPhase, inference: activeInference ?? { provider: "typesafe", active: false, configured: null },
      sourceStatus: source.sourceStatus, classificationStatus: source.classificationStatus,
      renderableSource: { mimeType: source.mimeType, downloadUrl: `/api/projects/${model.projectId}/files/${source.fileId}/versions/${source.version}/download` },
      pageCount: metadata?.pageCount ?? source.sourceResult?.pages ?? null,
      registeredPageCount: metadata?.registeredPageCount ?? 0, coverageTruncated: metadata?.coverageTruncated ?? false,
      floorPlanPages: metadata?.floorPlanPages ?? [], nonFloorPlanPages: metadata?.nonFloorPlanPages ?? [],
      unresolvedPages: metadata?.unresolvedPages ?? [], reason: metadata?.reason ?? null, jobStatuses, errors,
      colourLegend: planColourLegend(extractionJobs, (colourLegendRows as any[]).find(row => row.sourceVersionId === source.sourceVersionId) ?? null),
      planScale: planScaleSummary(extractionJobs, (colourLegendRows as any[]).find(row => row.sourceVersionId === source.sourceVersionId) ?? null) };
  });
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
    automaticPlanProcessing,
    supersededSources,
    summary: {
      projectId: model.projectId, modelId: model.id, revision: model.revision,
      buildings: buildings.length, storeys: storeys.length, rooms: rooms.length, elements: elements.length,
      unresolvedConflicts: conflicts.length, pendingProposals: (proposals as any[]).filter(p => p.status === "pending").length,
    },
  };
};

/** Walls and ceilings with the current state of their component data. */
const componentRecords = (data: any): BuildingComponentRecord[] => {
  const latest = new Map<string, any>();
  for (const property of data.properties as any[]) if (property.entityType === "element") latest.set(`${property.entityId}:${property.propertyKey}`, property);
  return (data.elements as any[]).map(element => {
    const state = (key: string) => { const current = latest.get(`${element.id}:${key}`)?.current;
      return current ? { value: current.value, unit: current.unit ?? null, reviewStatus: current.reviewStatus, provenance: current.provenance, evidenceQuote: current.evidence?.[0]?.quote ?? null, evidenceKind: current.evidence?.[0]?.kind ?? null } : null; };
    return { id: element.id, componentType: elementComponentType(element.kind, effectiveValue(latest.get(`${element.id}:componentType`))),
      properties: Object.fromEntries(["construction", "material", "thickness", "bulkDensity", "wallRole"].map(key => [key, state(key)])) };
  });
};

/** Open component data inquiries with what has been answered since, computed against the current model. */
const openComponentInquiries = async (d: AppDeps, projectId: string, data: any) => {
  const rows = await d.db.select().from(inquiries).where(and(eq(inquiries.tenantId, d.tenantId), eq(inquiries.projectId, projectId), eq(inquiries.kind, "component_data"),
    sql`${inquiries.status} <> 'closed'`)).orderBy(desc(inquiries.updatedAt)).limit(50);
  const records = componentRecords(data);
  return (rows as any[]).map(row => ({ id: row.id, title: row.title, counterpart: row.counterpart, status: row.status, createdAt: row.createdAt,
    progress: dataRequestProgress(row.items as any, records), deepLink: `/projects/${projectId}?view=inquiries&inquiry=${row.id}` }));
};

/** Walls and ceilings with their component data, for inquiries and other project surfaces. */
export async function readComponentRecords(d: AppDeps, projectId: string) {
  const row = await modelForProject(d, projectId);
  return row ? componentRecords(await readModel(d, row.model)) : [];
}

/** Missing or unreviewed component inputs per wall/ceiling, for agents and the model view. */
const componentGaps = (projectId: string, data: any, objectId?: string) => componentRecords(data).filter(record => !objectId || record.id === objectId)
  .flatMap(record => componentInputGaps(record.componentType, record.properties).map(gap => ({ entityType: "element" as const, entityId: record.id, ...gap, deepLink: buildingDeepLink(projectId, "element", record.id) })));

/** Reviewed property states of one entity, keyed by property, for shared checks. */
const statesOf = (data: any, entityType: string, entityId: string) => Object.fromEntries((data.properties as any[])
  .filter(property => property.entityType === entityType && property.entityId === entityId && property.current)
  .map(property => [property.propertyKey, { value: property.current.value, reviewStatus: property.current.reviewStatus }]));

/** GRZ, GFZ and Vollgeschosse against the approved Bebauungsplan limits; demolished buildings and their storeys do not count. */
const zoningCheckFor = (data: any, limits: ReturnType<typeof zoningLimits>) => {
  const site = (data.buildings as any[])[0];
  const buildings = (data.buildings as any[]).filter(building => building.constructionState !== "demolished");
  const active = new Set(buildings.map(building => building.id));
  return zoningChecks({ limits, site: site ? { id: site.id, properties: statesOf(data, "building", site.id) } : null,
    buildings: buildings.map(building => ({ id: building.id, properties: statesOf(data, "building", building.id) })),
    storeys: (data.storeys as any[]).filter(storey => active.has(storey.buildingId)).map(storey => ({ id: storey.id, buildingId: storey.buildingId, properties: statesOf(data, "storey", storey.id) })) });
};

/**
 * Sound insulation preparation for agents: the agreed requirement level, which
 * separating walls and ceilings need a verification and whether their inputs
 * are complete, and what to ask the architect per wall type. No calculation.
 */
const soundInsulationContext = async (d: AppDeps, projectId: string, data: any) => {
  const records = componentRecords(data);
  const building = (data.buildings as any[])[0];
  const buildingProperty = (key: string) => (data.properties as any[]).find(property => property.entityType === "building" && property.entityId === building?.id && property.propertyKey === key);
  const level = buildingProperty("soundInsulationLevel");
  const regulatory = Object.fromEntries(regulatoryBasisKeys.map(key => { const current = buildingProperty(key)?.current;
    return [key, current ? { value: current.value, reviewStatus: current.reviewStatus } : null]; }));
  const zoning = Object.fromEntries(developmentPlanZoningKeys.map(key => { const current = buildingProperty(key)?.current;
    return [key, current && current.reviewStatus !== "rejected" ? { value: current.value, reviewStatus: current.reviewStatus } : null]; }));
  const checks = soundInsulationChecks(records);
  const levelOf = (storeyId: string) => (data.properties as any[]).find(property => property.entityType === "storey" && property.entityId === storeyId && property.propertyKey === "level");
  return {
    storeys: (data.storeys as any[]).slice(0, 100).map(storey => { const level = levelOf(storey.id)?.current;
      return { id: storey.id, name: storey.name, level: level && level.reviewStatus !== "rejected" ? { value: level.value, reviewStatus: level.reviewStatus, provenance: level.provenance } : storey.levelIndex === null ? null : { value: storey.levelIndex, reviewStatus: "approved", provenance: "manual" } }; }),
    regulatoryBasis: { ...Object.fromEntries(Object.entries(regulatory).filter(([, state]) => state && state.reviewStatus !== "rejected")), gaps: regulatoryBasisGaps(regulatory),
      // Art und Maß der baulichen Nutzung; limits are approved single values only, checked against approved parcel, footprint and storey inputs.
      developmentPlanZoning: { ...Object.fromEntries(Object.entries(zoning).filter(([, state]) => state)), limits: zoningLimits(zoning),
        compliance: { method: zoningCheckMethod, checks: zoningCheckFor(data, zoningLimits(zoning)) } } },
    requirementLevel: level?.current && level.current.reviewStatus !== "rejected" ? { value: level.current.value, reviewStatus: level.current.reviewStatus } : null,
    checks: { total: checks.length, ready: checks.filter(check => check.ready).length,
      items: checks.slice(0, 500).map(check => ({ ...check, deepLink: buildingDeepLink(projectId, "element", check.componentId) })) },
    calculation: { available: false, reason: "No validated DIN 4109-2 airborne or impact sound calculation tool exists yet." },
    dataRequest: componentDataRequest(records).map(group => ({ ...group, componentIds: group.componentIds.slice(0, 200) })),
    inquiries: await openComponentInquiries(d, projectId, data),
  };
};

/** Derived ceilings for agents: the rooms each covers and the storey above, when known. */
const ceilingContext = (data: any) => {
  const ceilings = new Map<string, { ceilingId: string; roomIds: string[]; upperStoreyId: string | null }>();
  for (const relationship of data.relationships as any[]) {
    if (!["covers", "under_storey"].includes(relationship.relationshipType) || relationship.metadata?.method !== storeyCeilingMethod) continue;
    const ceiling = ceilings.get(relationship.fromEntityId) ?? { ceilingId: relationship.fromEntityId, roomIds: [] as string[], upperStoreyId: null as string | null };
    if (relationship.relationshipType === "covers") ceiling.roomIds.push(relationship.toEntityId); else ceiling.upperStoreyId = relationship.toEntityId;
    ceilings.set(relationship.fromEntityId, ceiling);
  }
  return [...ceilings.values()];
};

/** Derived wall faces for agents: the rooms each wall separates, or that a face is outside. */
const wallAdjacencyContext = (data: any, objectId?: string) => (data.relationships as any[])
  .filter(relationship => ["separates", "faces_exterior"].includes(relationship.relationshipType) && (!objectId || relationship.fromEntityId === objectId || relationship.toEntityId === objectId))
  .map(relationship => ({ wallId: relationship.fromEntityId, roomId: relationship.relationshipType === "separates" ? relationship.toEntityId : null, exterior: relationship.relationshipType === "faces_exterior",
    side: relationship.metadata?.side ?? null, method: relationship.metadata?.method ?? null, reviewStatus: relationship.reviewStatus }));

/** Automatic draft storeys/buildings are page hypotheses, not reviewed structure; label them for agents. */
const inferredStructure = (entity: any) => ["unreviewed_page_hypothesis", "unreviewed_source_container", "derived_storey_ceiling"].includes(entity.geometry?.quality)
  ? { provenance: "inferred" as const, reviewStatus: "unreviewed" as const } : {};

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
  const missingComponentInputs = componentGaps(projectId, data, options.objectId);
  const wallAdjacency = wallAdjacencyContext(data, options.objectId);
  return {
    projectId, modelId: row.model.id, revision: row.model.revision,
    entities: selected.map(({ entityType, entity }) => ({ id: entity.id, entityType, stableKey: entity.stableKey, name: entity.name, roomUse: entity.roomUse ?? null, constructionState: entity.constructionState, ...inferredStructure(entity), deepLink: buildingDeepLink(projectId, entityType, entity.id) })),
    properties: reviewedProperties,
    measurements: (data.measurements as any[]).filter(measurement => measurement.reviewStatus === "approved" && (!options.objectId || selectedIds.has(measurement.entityId))).slice(0, 500),
    planSources: (data.planSources as any[]).slice(0, 100),
    placement: data.placement,
    conflicts: (data.conflicts as any[]).filter(conflict => !options.objectId || selectedIds.has(conflict.entityId)),
    missingInputs: [...missingInputs, ...missingComponentInputs.slice(0, 500)],
    wallAdjacency: wallAdjacency.slice(0, 1000),
    ceilings: ceilingContext(data).filter(ceiling => !options.objectId || ceiling.ceilingId === options.objectId).slice(0, 200),
    soundInsulation: options.objectId ? undefined : await soundInsulationContext(d, projectId, data),
    pendingProposals: (data.proposals as any[]).filter(proposal => proposal.status === "pending").slice(0, 100).map(proposal => ({ id: proposal.id, proposalType: proposal.proposalType, payload: proposal.payload, expectedRevision: proposal.expectedRevision, deepLink: proposal.deepLink })),
    truncated: selectedAll.length > selected.length || reviewedPropertiesAll.length > reviewedProperties.length || (data.planSources as any[]).length > 100 || missingComponentInputs.length > 500 || wallAdjacency.length > 1000,
  };
}

export const readBuildingModelAgentContext = readBuildingModelContext;

/** Consistent, tenant-scoped saved inputs for deterministic fire execution. */
export async function readFireProtectionSnapshot(d: AppDeps, projectId: string): Promise<import("@richtfest/shared/fire-plan").FireProtectionSnapshot> {
  d.requirePermission("projects:read");
  return d.db.transaction(async (tx: any) => {
    const scoped = { ...d, db: tx };
    const row = await modelForProject(scoped, projectId);
    if (!row) return { available: false, reason: "Building model unavailable for this project." };
    return assembleFireProtectionSnapshot(await readModel(scoped, row.model));
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * Approved figures a feasibility study starts from: parcel area, single-value
 * GRZ/GFZ and the Geschossfläche of approved Vollgeschosse in existing or
 * retained buildings. Unreviewed values are null, never passed on.
 */
export async function readFeasibilitySiteFigures(d: AppDeps, projectId: string): Promise<FeasibilitySiteFigures> {
  const modelRow = await modelForProject(d, projectId);
  if (!modelRow) return { parcelArea: null, grz: null, gfz: null, existingGrossFloorArea: null };
  const data = await readModel(d, modelRow.model);
  const site = (data.buildings as any[])[0];
  const siteStates = site ? statesOf(data, "building", site.id) : {};
  const limits = zoningLimits(siteStates);
  const approvedNumber = (states: Record<string, any>, key: string) => states[key]?.reviewStatus === "approved" && typeof states[key].value === "number" ? states[key].value as number : null;
  const existing = new Set((data.buildings as any[]).filter(building => building.constructionState === "existing" || building.constructionState === "retained").map(building => building.id));
  // Reuse the same completeness gate as zoning: never silently drop undecided floors.
  const existingCheck = zoningChecks({ limits, site: site ? { id: site.id, properties: siteStates } : null,
    buildings: (data.buildings as any[]).filter(building => existing.has(building.id)).map(building => ({ id: building.id, properties: statesOf(data, "building", building.id) })),
    storeys: (data.storeys as any[]).filter(storey => existing.has(storey.buildingId)).map(storey => ({ id: storey.id, buildingId: storey.buildingId, properties: statesOf(data, "storey", storey.id) }))
  }).find(check => check.key === "gfz")!;
  return { parcelArea: approvedNumber(siteStates, "parcelArea"), grz: limits.grz, gfz: limits.gfz,
    existingGrossFloorArea: existingCheck.actual === null ? null : existingCheck.actual * approvedNumber(siteStates, "parcelArea")! };
}

/** Create an inspectable proposal without mutating the reviewed model. */
export async function proposeBuildingModelChange(d: AppDeps, projectId: string, input: BuildingModelProposalInput, execution: BuildingModelProposalExecution = { runId: "unknown", agentId: d.actorId }, tx = d.db) {
  d.requirePermission("projects:write");
  d.requirePermission("agent:run");
  const row = await modelForProject(d, projectId);
  if (!row) return null;
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0 || input.baseRevision !== row.model.revision)
    throw Object.assign(new Error("The building model changed; reload before proposing a change."), { status: 409, code: "revision_conflict" });
  const proposedValue = buildingPropertyValueSchema.parse(input.value);
  const invalidComponent = validateBuildingComponentProperty(input.entityType, input.propertyKey, proposedValue, input.unit ?? null);
  if (invalidComponent) throw Object.assign(new Error(invalidComponent), { status: 422, code: "invalid_component_property" });
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


/**
 * Proposes the component data a text states (a construction description or a
 * reply) for every wall of the stated role and for the ceilings. Proposals stay
 * unreviewed and never replace an entered or reviewed value.
 */
export async function proposeStatedComponentData(d: AppDeps, projectId: string, model: any, baseRevision: number, pages: Array<{ page: number; text: string }>,
  evidenceFor: (stated: { page: number; quote: string }) => unknown, auditSource: Record<string, unknown>, action = "projects.building.component.description_read") {
      const statements = readConstructionDescription(pages);
      const groups = mergeComponentStatements(statements);
      const data = await readModel(d, model);
      const records = componentRecords(data);
      const props = new Map((data.properties as any[]).filter(property => property.entityType === "element").map(property => [`${property.entityId}:${property.propertyKey}`, property]));
      const roleOf = (elementId: string) => effectiveValue(props.get(`${elementId}:wallRole`));
      const units: Record<string, string | null> = { construction: null, material: null, thickness: "cm", bulkDensity: "kg/m³" };
      const result = await modelTransaction(d.db, async (tx: any) => {
        const revision = await touchRevision(tx, d, model.id, baseRevision); if (revision === undefined) return { conflict: model.revision };
        let proposals = 0;
        const summary = [];
        for (const group of groups) {
          const targets = records.filter(record => record.componentType === group.target.componentType && (group.target.componentType === "ceiling" || roleOf(record.id) === group.target.wallRole));
          let proposed = 0;
          for (const [field, stated] of Object.entries(group.values)) for (const target of targets) {
            if (!derivedWritable(props.get(`${target.id}:${field}`), stated.value)) continue;
            await appendPropertyVersion(tx, d, model.id, { entityType: "element", entityId: target.id, propertyKey: field, value: stated.value, unit: units[field], provenance: "inferred",
              evidence: [buildingEvidenceSchema.parse(evidenceFor(stated))] });
            proposed++;
          }
          proposals += proposed;
          summary.push({ ...group.target, values: Object.fromEntries(Object.entries(group.values).map(([field, stated]) => [field, stated.value])), conflicts: group.conflicts, components: targets.length, proposed });
        }
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: model.id, revision, status: "draft", createdBy: d.actorId });
        await d.audit(tx, action, "building_model", model.id, { projectId, modelRevision: revision, ...auditSource,
          method: constructionDescriptionMethod, statements: statements.length, proposals, groups: summary.map(group => ({ componentType: group.componentType, wallRole: group.wallRole, proposed: group.proposed, conflicts: group.conflicts })) });
        return { revision, summary: { statements: statements.length, proposals, groups: summary, method: constructionDescriptionMethod } };
      });
      return result;
}

/** Plan pages with their wall outlines in plan metres (printed scale) and the stored placement, so a page can be placed on the site. */
export async function readSitePlan(d: AppDeps, projectId: string): Promise<SitePlan> {
  const modelRow = await modelForProject(d, projectId); if (!modelRow) return { modelRevision: null, pages: [], placement: null };
  const modelId = modelRow.model.id, scoped = <T extends { modelId: any; tenantId: any }>(table: T) => and(eq(table.modelId, modelId), eq(table.tenantId, d.tenantId));
  const [elements, storeys, exterior, placementRows, maskRows] = await Promise.all([
    d.db.select({ id: buildingElements.id, kind: buildingElements.kind, name: buildingElements.name, storeyId: buildingElements.storeyId, geometry: buildingElements.geometry }).from(buildingElements).where(scoped(buildingElements)),
    d.db.select({ id: buildingStoreys.id, name: buildingStoreys.name, levelIndex: buildingStoreys.levelIndex }).from(buildingStoreys).where(scoped(buildingStoreys)),
    d.db.select({ id: buildingRelationships.fromEntityId }).from(buildingRelationships).where(and(scoped(buildingRelationships), eq(buildingRelationships.relationshipType, "faces_exterior"))),
    d.db.select().from(buildingPlacements).where(scoped(buildingPlacements)).limit(1),
    d.db.select({ mask: buildingSelectionMasks, job: buildingExtractionJobs }).from(buildingSelectionMasks).innerJoin(buildingExtractionJobs, eq(buildingExtractionJobs.id, buildingSelectionMasks.jobId))
      .where(scoped(buildingSelectionMasks)).orderBy(desc(buildingSelectionMasks.updatedAt)),
  ]);
  const scales = new Map<string, { pageAspectRatio: number; metresPerPageHeight: number; denominator: number | null }>();
  for (const row of maskRows as any[]) {
    const key = `${row.job.sourceVersionId}:${row.job.page}`;
    if (!scales.has(key) && row.mask.metresPerPageHeight != null) scales.set(key, { pageAspectRatio: Number(row.mask.pageAspectRatio), metresPerPageHeight: Number(row.mask.metresPerPageHeight), denominator: row.job.result?.scaleObservation?.denominator ?? null });
  }
  const exteriorIds = new Set((exterior as any[]).map(row => row.id)), storeyById = new Map((storeys as any[]).map(storey => [storey.id, storey]));
  const pages = new Map<string, any>();
  for (const element of elements as any[]) {
    const source = element.geometry?.source, polygon = element.geometry?.polygon;
    if (!source?.sourceVersionId || !Array.isArray(polygon) || polygon.length < 3) continue;
    if (!/wall/.test(element.kind) && !exteriorIds.has(element.id)) continue;
    const key = `${source.sourceVersionId}:${source.page}`, scale = scales.get(key);
    if (!scale) continue;
    const page = pages.get(key) ?? { sourceVersionId: source.sourceVersionId, page: source.page, scale, storeyIds: new Set<string>(), walls: [] };
    if (element.storeyId) page.storeyIds.add(element.storeyId);
    // Same conversion as wall thickness: x scales by the page aspect ratio, both by metres per page height.
    page.walls.push({ id: element.id, name: element.name, exterior: exteriorIds.has(element.id),
      ring: polygon.map((p: any) => [Number(p.x) * scale.pageAspectRatio * scale.metresPerPageHeight, Number(p.y) * scale.metresPerPageHeight]) });
    pages.set(key, page);
  }
  const versionIds = [...new Set([...pages.values()].map(page => page.sourceVersionId))];
  const names = versionIds.length ? await d.db.select({ id: fileVersions.id, name: files.name }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(inArray(fileVersions.id, versionIds), eq(fileVersions.tenantId, d.tenantId))) : [];
  const nameOf = new Map((names as any[]).map(row => [row.id, row.name]));
  const list = [...pages.values()].map(page => {
    const storey = [...page.storeyIds].map(storeyId => storeyById.get(storeyId)).find(Boolean) ?? null;
    return { sourceVersionId: page.sourceVersionId, page: page.page, fileName: nameOf.get(page.sourceVersionId) ?? null, storey: storey ? { id: storey.id, name: storey.name, levelIndex: storey.levelIndex } : null, scale: page.scale, walls: page.walls };
  });
  // Ground floor first: level 0, then the lowest level, then pages without a storey level.
  const rank = (page: any) => page.storey?.levelIndex === 0 ? -1e6 : page.storey?.levelIndex ?? 1e6;
  list.sort((a, b) => rank(a) - rank(b) || b.walls.length - a.walls.length);
  return { modelRevision: modelRow.model.revision, pages: list, placement: (placementRows as any[])[0] ?? null };
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
      const eligibleJobs = await d.db.select({ id: buildingExtractionJobs.id }).from(buildingExtractionJobs)
        .innerJoin(fileVersions, and(eq(fileVersions.id, buildingExtractionJobs.sourceVersionId), eq(fileVersions.tenantId, d.tenantId)))
        .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, d.tenantId)))
        .where(and(eq(buildingExtractionJobs.modelId, row.model.id), eq(buildingExtractionJobs.tenantId, d.tenantId),
          eq(files.projectId, projectId), eq(files.purpose, "project_evidence")));
      const eligibleJobIds = new Set(eligibleJobs.map((job: { id: string }) => job.id));
      const draftCandidates = (data.extractionCandidates as any[])
        .filter(candidate => candidate.status === "unreviewed" && eligibleJobIds.has(candidate.jobId));
      return res.json(ok({ projectId, modelId: row.model.id, revision: row.model.revision, summary: data.summary,
        entities: [
          ...(data.buildings as any[]).map(entity => ({ ...entity, entityType: "building" as const })),
          ...(data.storeys as any[]).map(entity => ({ ...entity, entityType: "storey" as const })),
          ...(data.rooms as any[]).map(entity => ({ ...entity, entityType: "room" as const })),
          ...(data.elements as any[]).map(entity => ({ ...entity, entityType: "element" as const })),
        ].map((entity: any) => ({ id: entity.id, stableKey: entity.stableKey, name: entity.name, roomUse: entity.roomUse ?? null, constructionState: entity.constructionState, ...inferredStructure(entity), deepLink: buildingDeepLink(projectId, entity.entityType, entity.id) })),
        missingInputs: [...(data.rooms as any[]).filter(room => !room.roomUse).map(room => ({ entityType: "room", entityId: room.id, field: "roomUse", deepLink: buildingDeepLink(projectId, "room", room.id) })),
          ...componentGaps(projectId, data).slice(0, 500)],
        wallAdjacency: wallAdjacencyContext(data).slice(0, 1000),
        ceilings: ceilingContext(data).slice(0, 200),
        soundInsulation: await soundInsulationContext(d, projectId, data),
        draftCandidates: draftCandidates.slice(0, 500).map(candidate => {
          const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.find((item: any) => item?.kind === "page") : null;
          const geometry = candidate.geometry && typeof candidate.geometry === "object" ? candidate.geometry : {};
          return { candidateId: candidate.id, entityType: candidate.entityType, name: candidate.name,
            reviewStatus: "unreviewed", sourceKey: candidate.sourceKey, sourceVersionId: evidence?.sourceVersionId ?? null,
            page: evidence?.page ?? null, geometry: { quality: geometry.quality ?? "unknown",
              planRegion: geometry.planRegion ?? null, method: geometry.method ?? null,
              limitations: geometry.limitations ?? geometry.topologyCoverage?.limitations ?? null,
              polygonCount: Array.isArray(geometry.polygons) ? geometry.polygons.length : geometry.polygon ? 1 : 0 },
            evidence: candidate.evidence, deepLink: `/projects/${projectId}?view=building-model` };
        }),
        draftCandidatesTruncated: draftCandidates.length > 500,
        automaticPlanProcessing: data.automaticPlanProcessing,
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
        await lockProject(tx, d.tenantId, projectId);
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
      const invalidComponent = validateBuildingComponentProperty(input.entityType, input.propertyKey, input.value, input.unit);
      if (invalidComponent) return send(res, 422, { data: null, error: { code: "invalid_component_property" }, message: invalidComponent });
      if (!(await evidenceVersionsForProject(d.db, d, projectId, input.evidence))) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "Every evidence item must reference a ready source revision in this project" });
      const result = await modelTransaction(d.db, async (tx: any) => { if (!(await entityExists(tx, d, modelRow.model.id, input.entityType, input.entityId))) return { missing: true }; const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision }; const { property, version } = await appendPropertyVersion(tx, d, modelRow.model.id, input); await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId }); await d.audit(tx, "projects.building.property.created", "building_property", property.id, { projectId, propertyKey: input.propertyKey, claimKind: input.claimKind, version: version.version, modelRevision: revision }); return { property, version, revision }; });
      if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Entity not found" }); if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 201, ok(result));
    } catch (e) { return next(e); }
  });

  // Review many component values at once. The client sends exactly the versions it showed; anything
  // changed since then is skipped rather than approved unseen.
  router.post("/projects/:projectId/building-model/properties/review", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), decision: z.enum(["approved", "rejected"]), note: z.string().max(2000).nullable().optional(),
        items: z.array(z.object({ propertyId: uuid, version: z.number().int().positive(), reviewRevision: z.number().int().nonnegative() }).strict()).min(1).max(2000) }).strict().parse(req.body);
      const modelRow = await modelForProject(d, projectId);
      if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const result = await modelTransaction(d.db, async (tx: any) => {
        const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        const properties = await tx.select({ id: buildingProperties.id, entityType: buildingProperties.entityType, propertyKey: buildingProperties.propertyKey }).from(buildingProperties)
          .where(and(inArray(buildingProperties.id, [...new Set(input.items.map(item => item.propertyId))]), eq(buildingProperties.modelId, modelRow.model.id), eq(buildingProperties.tenantId, d.tenantId)));
        // Shared component keys only: room use keeps its own review path, which also updates the room.
        const reviewable = new Set((properties as any[]).filter(property => Object.hasOwn((buildingComponentProperties as any)[property.entityType] ?? {}, property.propertyKey)).map(property => property.id));
        const latest = new Map<string, number>();
        const latestRows = reviewable.size ? await tx.select({ propertyId: buildingPropertyVersions.propertyId, version: sql<number>`max(${buildingPropertyVersions.version})` }).from(buildingPropertyVersions)
          .where(inArray(buildingPropertyVersions.propertyId, [...reviewable])).groupBy(buildingPropertyVersions.propertyId) : [];
        for (const row of latestRows as any[]) latest.set(row.propertyId, Number(row.version));
        const reviewed: string[] = []; let skipped = 0;
        for (const item of input.items) {
          if (!reviewable.has(item.propertyId) || latest.get(item.propertyId) !== item.version) { skipped++; continue; }
          const updated = await tx.update(buildingPropertyVersions).set({ reviewStatus: input.decision, reviewRevision: sql`${buildingPropertyVersions.reviewRevision} + 1`, reviewedBy: d.actorId, reviewedAt: new Date(), reviewNote: input.note ?? null })
            .where(and(eq(buildingPropertyVersions.propertyId, item.propertyId), eq(buildingPropertyVersions.version, item.version), eq(buildingPropertyVersions.reviewRevision, item.reviewRevision),
              eq(buildingPropertyVersions.reviewStatus, "unreviewed"), eq(buildingPropertyVersions.tenantId, d.tenantId))).returning({ id: buildingPropertyVersions.id });
          if (updated.length) reviewed.push(item.propertyId); else skipped++;
        }
        if (!reviewed.length) return { reviewConflict: true };
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: input.decision === "approved" ? "approved" : "draft", createdBy: d.actorId });
        await d.audit(tx, "projects.building.property.bulk_reviewed", "building_model", modelRow.model.id, { projectId, decision: input.decision, reviewed: reviewed.length, skipped, propertyIds: reviewed.slice(0, 200), modelRevision: revision });
        return { revision, reviewed: reviewed.length, skipped };
      });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict);
      if ((result as any).reviewConflict) return send(res, 409, { data: null, error: { code: "review_revision_conflict" }, message: "These values changed or were already reviewed; reload before reviewing." });
      return res.json(ok(result));
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

  // Deterministic: re-running replaces earlier derived adjacency and never overrides a person's entry or review.
  router.post("/projects/:projectId/building-model/wall-adjacency", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId));
      const input = revisionInput.strict().parse(req.body); const modelRow = await modelForProject(d, projectId);
      if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      if (modelRow.model.revision !== input.baseRevision) return revisionConflict(res, modelRow.model.revision);
      const data = await readModel(d, modelRow.model);
      const jobsById = new Map((data.extractions as any[]).map(job => [job.id, job]));
      const candidateRooms = (data.extractionCandidates as any[]).filter(candidate => candidate.entityType === "room" && candidate.status === "unreviewed" && jobsById.has(candidate.jobId))
        .map(candidate => { const job = jobsById.get(candidate.jobId); return { id: candidate.id, name: candidate.name, geometry: { ...candidate.geometry, source: { sourceVersionId: job.sourceVersionId, page: job.page } } }; });
      // Printed scale per plan page, newest extraction first; an unreviewed title-block scale only ever yields inferred values.
      const maskRows = await d.db.select({ mask: buildingSelectionMasks, job: buildingExtractionJobs }).from(buildingSelectionMasks)
        .innerJoin(buildingExtractionJobs, eq(buildingExtractionJobs.id, buildingSelectionMasks.jobId))
        .where(and(eq(buildingSelectionMasks.modelId, modelRow.model.id), eq(buildingSelectionMasks.tenantId, d.tenantId))).orderBy(desc(buildingSelectionMasks.updatedAt));
      const scales = new Map<string, PageScale>();
      for (const row of maskRows as any[]) {
        const key = `${row.job.sourceVersionId}:${row.job.page}`;
        if (!scales.has(key) && row.mask.metresPerPageHeight != null) scales.set(key, { pageAspectRatio: Number(row.mask.pageAspectRatio),
          metresPerPageHeight: Number(row.mask.metresPerPageHeight), denominator: row.job.result?.scaleObservation?.denominator ?? null });
      }
      const walls = planWallAdjacency({ rooms: data.rooms as any[], elements: data.elements as any[], properties: data.properties as any[], candidateRooms, scales });
      const storeyOf = new Map((data.elements as any[]).map(element => [element.id, element.storeyId]));
      // Storey levels from each plan page's printed title, so ceilings know the storey above.
      const storeyPages = (data.planSources as any[]).filter(source => source.storeyId);
      const pageRows = storeyPages.length ? await d.db.select({ versionId: sourcePages.versionId, page: sourcePages.page, text: sql<string>`left(coalesce(${sourcePages.content}->>'text',''), 20000)` }).from(sourcePages)
        .where(and(eq(sourcePages.tenantId, d.tenantId), inArray(sourcePages.versionId, [...new Set(storeyPages.map(source => source.sourceVersionId))]))) : [];
      const readings = new Map<string, StoreyLevelReading & { sourceVersionId: string; page: number }>();
      for (const source of storeyPages) {
        const row = (pageRows as any[]).find(item => item.versionId === source.sourceVersionId && Number(item.page) === source.page);
        const reading = row ? storeyLevelFromText(String(row.text)) : null;
        if (reading && !readings.has(source.storeyId)) readings.set(source.storeyId, { ...reading, sourceVersionId: source.sourceVersionId, page: source.page });
      }
      const levels = planStoreyLevels({ storeys: data.storeys as any[], properties: data.properties as any[], readings });
      // Openings the plan trace found on each storey's current plan page, newest extraction per page.
      const storeyPageKeys = new Set(storeyPages.map((source: any) => `${source.sourceVersionId}:${source.page}:${source.storeyId}`));
      const openingJobs = await d.db.select({ sourceVersionId: buildingExtractionJobs.sourceVersionId, page: buildingExtractionJobs.page, storeyId: buildingExtractionJobs.storeyId,
        openings: sql<unknown>`${buildingExtractionJobs.result}->'topologyCoverage'->'openingEvidence'`, aspect: sql<unknown>`${buildingExtractionJobs.result}->'pageScale'->'pageAspectRatio'` })
        .from(buildingExtractionJobs).where(and(eq(buildingExtractionJobs.modelId, modelRow.model.id), eq(buildingExtractionJobs.tenantId, d.tenantId), eq(buildingExtractionJobs.status, "complete")))
        .orderBy(desc(buildingExtractionJobs.updatedAt)) as any[];
      const openingPages = new Map<string, OpeningPage>();
      for (const job of openingJobs) {
        const key = `${job.sourceVersionId}:${job.page}:${job.storeyId}`;
        if (!storeyPageKeys.has(key) || openingPages.has(key) || !Array.isArray(job.openings)) continue;
        openingPages.set(key, { sourceVersionId: job.sourceVersionId, page: job.page, storeyId: job.storeyId, pageAspectRatio: Number(job.aspect) || 1, openings: job.openings as TracedOpening[] });
      }
      // Accepted rooms keep their extraction candidate; its source key names the room in the trace.
      const roomCandidateIds = (data.rooms as any[]).flatMap(room => typeof room.stableKey === "string" && room.stableKey.startsWith("extraction:") ? [room.stableKey.slice(11)] : [])
        .filter(candidateId => uuid.safeParse(candidateId).success);
      const candidateKeys = new Map(roomCandidateIds.length ? (await d.db.select({ id: buildingExtractionCandidates.id, sourceKey: buildingExtractionCandidates.sourceKey }).from(buildingExtractionCandidates)
        .where(and(eq(buildingExtractionCandidates.tenantId, d.tenantId), inArray(buildingExtractionCandidates.id, roomCandidateIds))) as any[]).map(row => [row.id, row.sourceKey]) : []);
      const hostOf = new Map((data.relationships as any[]).filter(item => item.relationshipType === "opening_in").map(item => [item.fromEntityId, item.toEntityId]));
      const openingPlan = planOpenings({
        pages: [...openingPages.values()],
        walls: walls.map(wall => {
          const element = (data.elements as any[]).find(item => item.id === wall.wallId);
          return { id: wall.wallId, storeyId: element?.storeyId, sourceVersionId: wall.sourceVersionId, page: wall.page,
            footprintKeys: Array.isArray(element?.geometry?.sourceFootprintKeys) ? element.geometry.sourceFootprintKeys : [],
            polygon: element?.geometry?.polygon,
            exterior: wall.sides.includes("exterior") || wall.role === "exterior", roomIds: wall.sides.flatMap(side => Array.isArray(side) ? side.map(room => room.roomId) : []) };
        }),
        rooms: (data.rooms as any[]).map(room => ({ id: room.id, storeyId: room.storeyId, polygon: Array.isArray(room.geometry?.polygon) ? room.geometry.polygon : null,
          holes: room.geometry?.holes, sourceVersionId: room.geometry?.source?.sourceVersionId, page: room.geometry?.source?.page,
          boundaryResolved: room.geometry?.quality !== "approximate_partition" && Boolean(room.geometry?.polygon?.length),
          exterior: roomSpaceContext(room, { spaceType: effectiveValue((data.properties as any[]).find(p => p.entityType === "room" && p.entityId === room.id && p.propertyKey === "spaceType")) }).spaceType === "exterior",
          candidateKey: typeof room.stableKey === "string" && room.stableKey.startsWith("extraction:") ? candidateKeys.get(room.stableKey.slice(11)) ?? null : null })),
        existing: (data.elements as any[]).filter(item => item.kind === "window" || item.kind === "door")
          .map(item => ({ id: item.id, kind: item.kind, wallId: hostOf.get(item.id) ?? null, planKey: typeof item.geometry?.planOpeningKey === "string" ? item.geometry.planOpeningKey : null })),
      });
      const result = await modelTransaction(d.db, async (tx: any) => {
        const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        await tx.delete(buildingRelationships).where(and(eq(buildingRelationships.modelId, modelRow.model.id), eq(buildingRelationships.tenantId, d.tenantId),
          inArray(buildingRelationships.relationshipType, ["separates", "faces_exterior"]), eq(buildingRelationships.reviewStatus, "unreviewed"), sql`${buildingRelationships.metadata}->>'method' like 'plan_side_probe_%'`));
        const relationships = walls.flatMap(wall => wall.sides.flatMap((side, sideIndex) => {
          const metadata = { method: wallAdjacencyMethod, side: sideIndex, sourceVersionId: wall.sourceVersionId, page: wall.page };
          if (side === "exterior") return storeyOf.get(wall.wallId) ? [{ tenantId: d.tenantId, modelId: modelRow.model.id, fromEntityType: "element", fromEntityId: wall.wallId,
            toEntityType: "storey", toEntityId: storeyOf.get(wall.wallId), relationshipType: "faces_exterior", metadata, createdBy: d.actorId }] : [];
          return (side ?? []).map(room => ({ tenantId: d.tenantId, modelId: modelRow.model.id, fromEntityType: "element", fromEntityId: wall.wallId,
            toEntityType: "room", toEntityId: room.roomId, relationshipType: "separates", metadata: { ...metadata, probeHits: room.hits }, createdBy: d.actorId }));
        }));
        if (relationships.length) await tx.insert(buildingRelationships).values(relationships);
        let roleProposals = 0, thicknessProposals = 0;
        for (const wall of walls) {
          const region = wall.planRegion && wall.planRegion.width > 0 && wall.planRegion.height > 0 ? { region: wall.planRegion } : {};
          if (wall.writeRole) {
            await appendPropertyVersion(tx, d, modelRow.model.id, { entityType: "element", entityId: wall.wallId, propertyKey: "wallRole", value: wall.role, unit: null, provenance: "inferred",
              evidence: [buildingEvidenceSchema.parse({ kind: "page", sourceVersionId: wall.sourceVersionId, page: wall.page, ...region })] });
            roleProposals++;
          }
          if (wall.writeThickness) {
            const quote = wall.scaleDenominator ? { quote: `Printed scale 1:${wall.scaleDenominator}` } : {};
            await appendPropertyVersion(tx, d, modelRow.model.id, { entityType: "element", entityId: wall.wallId, propertyKey: "thickness", value: wall.thicknessCm, unit: "cm", provenance: "inferred",
              evidence: [buildingEvidenceSchema.parse({ kind: "page", sourceVersionId: wall.sourceVersionId, page: wall.page, ...region, ...quote })] });
            thicknessProposals++;
          }
        }
        // Openings from the plan: elements with their outline, in their wall, with the plan's width; area and Rw come from a schedule or the planner.
        const storeyNumbers = new Map<string, { window: number; door: number }>();
        for (const item of openingPlan.planned) {
          const { x, y, width, height } = item.closure;
          const geometry = { quality: "derived_opening", method: planOpeningMethod, semanticKind: item.kind, source: { sourceVersionId: item.sourceVersionId, page: item.page },
            planRegion: item.closure, polygon: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }],
            planOpeningKey: item.planKey, doorSwing: item.doorSwing, roomSides: item.roomSides,
            limitations: "Unreviewed opening: a gap between two wall ends of the plan trace. Window or door, its room and wall are inferred; height, sill and rating are not in the plan." };
          let elementId: string;
          if (item.action === "adopt") {
            // An entered opening takes its place on the plan; everything entered for it stays.
            const [adopted] = await tx.update(buildingElements).set({ geometry }).where(and(eq(buildingElements.id, item.elementId), eq(buildingElements.tenantId, d.tenantId),
              sql`${buildingElements.geometry} is null`)).returning({ id: buildingElements.id });
            if (!adopted) continue;
            elementId = adopted.id;
          } else {
            const counter = storeyNumbers.get(item.storeyId) ?? { window: (data.elements as any[]).filter(el => el.storeyId === item.storeyId && el.kind === "window").length,
              door: (data.elements as any[]).filter(el => el.storeyId === item.storeyId && el.kind === "door").length };
            counter[item.kind]++; storeyNumbers.set(item.storeyId, counter);
            const wall = (data.elements as any[]).find(el => el.id === item.wallId);
            const [created] = await tx.insert(buildingElements).values({ tenantId: d.tenantId, modelId: modelRow.model.id, buildingId: wall.buildingId, storeyId: item.storeyId, roomId: item.roomId,
              stableKey: item.planKey, kind: item.kind, name: `${item.kind === "window" ? "Draft window" : "Draft door"} ${counter[item.kind]}`, constructionState: wall.constructionState,
              geometry, createdBy: d.actorId }).onConflictDoNothing().returning({ id: buildingElements.id });
            if (!created) continue;
            elementId = created.id;
            await tx.insert(buildingRelationships).values({ tenantId: d.tenantId, modelId: modelRow.model.id, fromEntityType: "element", fromEntityId: elementId, toEntityType: "element", toEntityId: item.wallId,
              relationshipType: "opening_in", metadata: { method: planOpeningMethod, sourceVersionId: item.sourceVersionId, page: item.page }, reviewStatus: "unreviewed", createdBy: d.actorId });
          }
          const evidence = [buildingEvidenceSchema.parse({ kind: "page", sourceVersionId: item.sourceVersionId, page: item.page, region: item.closure })];
          const existingProperty = (key: string) => (data.properties as any[]).find(property => property.entityType === "element" && property.entityId === elementId && property.propertyKey === key);
          if (item.action === "create") await appendPropertyVersion(tx, d, modelRow.model.id, { entityType: "element", entityId: elementId, propertyKey: "componentType", value: item.kind, unit: null, provenance: "inferred", evidence });
          if (item.widthM !== null && derivedWritable(existingProperty("openingWidth"), item.widthM))
            await appendPropertyVersion(tx, d, modelRow.model.id, { entityType: "element", entityId: elementId, propertyKey: "openingWidth", value: item.widthM, unit: "m", provenance: "inferred", evidence });
        }
        let levelProposals = 0;
        for (const level of levels.filter(item => item.write)) {
          const reading = readings.get(level.storeyId)!;
          await appendPropertyVersion(tx, d, modelRow.model.id, { entityType: "storey", entityId: level.storeyId, propertyKey: "level", value: level.level, unit: null, provenance: "inferred",
            evidence: [buildingEvidenceSchema.parse({ kind: "page", sourceVersionId: reading.sourceVersionId, page: reading.page, quote: level.quote })] });
          levelProposals++;
        }
        const levelOf = new Map(levels.map(level => [level.storeyId, level.level]));
        // One ceiling per storey with accepted rooms; derived links are replaced, the ceiling and its data stay.
        await tx.delete(buildingRelationships).where(and(eq(buildingRelationships.modelId, modelRow.model.id), eq(buildingRelationships.tenantId, d.tenantId),
          inArray(buildingRelationships.relationshipType, ["covers", "under_storey"]), eq(buildingRelationships.reviewStatus, "unreviewed"), sql`${buildingRelationships.metadata}->>'method' = ${storeyCeilingMethod}`));
        const ceilings = planStoreyCeilings({ storeys: (data.storeys as any[]).map(storey => ({ ...storey, levelIndex: levelOf.get(storey.id) ?? null })), rooms: data.rooms as any[], elements: data.elements as any[] });
        const ceilingRelationships: any[] = []; const createdCeilings: string[] = [];
        for (const ceiling of ceilings) {
          let ceilingId = ceiling.existingId;
          if (!ceilingId) {
            const [created] = await tx.insert(buildingElements).values({ tenantId: d.tenantId, modelId: modelRow.model.id, buildingId: ceiling.buildingId, storeyId: ceiling.storeyId,
              stableKey: ceiling.stableKey, kind: "draft_ceiling", name: ceiling.name, constructionState: ceiling.constructionState,
              geometry: { quality: "derived_storey_ceiling", method: storeyCeilingMethod, source: { ...ceiling.source, storeyId: ceiling.storeyId } }, createdBy: d.actorId })
              .onConflictDoNothing().returning({ id: buildingElements.id });
            ceilingId = created?.id ?? (await tx.select({ id: buildingElements.id }).from(buildingElements)
              .where(and(eq(buildingElements.modelId, modelRow.model.id), eq(buildingElements.stableKey, ceiling.stableKey))).limit(1))[0]?.id ?? null;
            if (created) createdCeilings.push(created.id);
          }
          if (!ceilingId) continue;
          const metadata = { method: storeyCeilingMethod, sourceVersionId: ceiling.source.sourceVersionId, page: ceiling.source.page };
          for (const roomId of ceiling.roomIds) ceilingRelationships.push({ tenantId: d.tenantId, modelId: modelRow.model.id, fromEntityType: "element", fromEntityId: ceilingId,
            toEntityType: "room", toEntityId: roomId, relationshipType: "covers", metadata, createdBy: d.actorId });
          if (ceiling.upperStoreyId) ceilingRelationships.push({ tenantId: d.tenantId, modelId: modelRow.model.id, fromEntityType: "element", fromEntityId: ceilingId,
            toEntityType: "storey", toEntityId: ceiling.upperStoreyId, relationshipType: "under_storey", metadata, createdBy: d.actorId });
        }
        if (ceilingRelationships.length) await tx.insert(buildingRelationships).values(ceilingRelationships);
        const summary = { storeyLevels: levels.filter(level => level.level !== null).length, levelProposals, ceilings: ceilings.length, ceilingsCreated: createdCeilings.length, walls: walls.length, bothSides: walls.filter(wall => wall.sides[0] && wall.sides[1]).length,
          exterior: walls.filter(wall => wall.sides.includes("exterior")).length, unresolvedSides: walls.filter(wall => !wall.sides[0] || !wall.sides[1]).length,
          roles: walls.filter(wall => wall.role).length, roleProposals, thicknesses: walls.filter(wall => wall.thicknessCm !== null).length, thicknessProposals,
          relationships: relationships.length + ceilingRelationships.length, method: wallAdjacencyMethod,
          ...openingPlan.summary };
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId });
        await d.audit(tx, "projects.building.wall_adjacency.derived", "building_model", modelRow.model.id, { projectId, modelRevision: revision, ...summary, createdCeilingIds: createdCeilings });
        return { revision, summary };
      });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict);
      return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  // Documents that can state component data: the project's text-bearing files without floor-plan pages,
  // a likely Baubeschreibung first.
  router.get("/projects/:projectId/building-model/component-sources", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); const projectId = uuid.parse(id(req.params.projectId));
      const modelRow = await modelForProject(d, projectId);
      if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const rows = await d.db.select({ fileId: files.id, name: files.name, documentType: files.documentType, versionId: fileVersions.id, version: fileVersions.version,
        mentions: sql<boolean>`exists (select 1 from ${sourcePages} where ${sourcePages.versionId} = ${fileVersions.id} and ${sourcePages.content}->>'text' ~* 'bau-?[[:space:]]*beschreibung')` })
        .from(files).innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready")))
        .where(and(eq(files.projectId, projectId), eq(files.tenantId, d.tenantId), eq(files.purpose, "project_evidence"),
          sql`exists (select 1 from ${sourcePages} where ${sourcePages.versionId} = ${fileVersions.id} and length(coalesce(${sourcePages.content}->>'text','')) > 0)`,
          // Every uploaded PDF is page-classified; only documents with floor-plan pages are plans.
          sql`not exists (select 1 from ${buildingPlanSources} where ${buildingPlanSources.sourceVersionId} = ${fileVersions.id} and ${buildingPlanSources.storeyId} is not null)`))
        .orderBy(desc(fileVersions.version));
      const latest = [...new Map((rows as any[]).map(row => [row.fileId, row])).values()];
      const types = await documentTypesFor(d, latest.map(row => ({ fileId: row.fileId, name: row.name, documentType: row.documentType, versionId: row.versionId })));
      const documents = latest.map(row => ({ fileId: row.fileId, name: row.name, sourceVersionId: row.versionId, version: row.version, documentType: types.get(row.fileId) ?? null,
        likelyConstructionDescription: types.get(row.fileId)?.documentType === "construction_description" || Boolean(row.mentions) }))
        // Plans and other drawings state no component data; a confirmed or inferred Baubeschreibung comes first.
        .filter(doc => doc.documentType?.documentType !== "plans").sort((a, b) => Number(b.likelyConstructionDescription) - Number(a.likelyConstructionDescription));
      return res.json(ok({ documents }));
    } catch (e) { return next(e); }
  });

  // Reads a construction description and proposes its stated component data for every wall of the stated role
  // and for the ceilings. Proposals stay unreviewed; entered or reviewed values are never replaced.
  router.post("/projects/:projectId/building-model/component-sources", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), sourceVersionId: uuid }).strict().parse(req.body);
      const modelRow = await modelForProject(d, projectId);
      if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      if (modelRow.model.revision !== input.baseRevision) return revisionConflict(res, modelRow.model.revision);
      if (!(await evidenceVersionsForProject(d.db, d, projectId, [{ kind: "page", sourceVersionId: input.sourceVersionId, page: 1 } as any])))
        return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "The document must be a ready file revision in this project" });
      const pages = await d.db.select({ page: sourcePages.page, text: sql<string>`left(coalesce(${sourcePages.content}->>'text',''), 60000)` }).from(sourcePages)
        .where(and(eq(sourcePages.versionId, input.sourceVersionId), eq(sourcePages.tenantId, d.tenantId))).orderBy(asc(sourcePages.page)).limit(300);
      if (!pages.length) return send(res, 422, { data: null, error: { code: "no_source_text" }, message: "No text has been read from this document yet" });
      const result = await proposeStatedComponentData(d, projectId, modelRow.model, input.baseRevision, (pages as any[]).map(row => ({ page: Number(row.page), text: String(row.text) })),
        stated => ({ kind: "page", sourceVersionId: input.sourceVersionId, page: stated.page, quote: stated.quote }), { sourceVersionId: input.sourceVersionId });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict);
      return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  // Reads a Bebauungsplan's noise requirements and its Art und Maß der baulichen Nutzung into the regulatory basis of
  // every building, as unreviewed proposals quoting each statement. Reading one also proposes that a Bebauungsplan
  // applies. People's values are kept. Zoning values are not checked against the building (no parcel area yet).
  router.post("/projects/:projectId/building-model/regulatory-sources", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), sourceVersionId: uuid }).strict().parse(req.body);
      const modelRow = await modelForProject(d, projectId);
      if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      if (modelRow.model.revision !== input.baseRevision) return revisionConflict(res, modelRow.model.revision);
      if (!(await evidenceVersionsForProject(d.db, d, projectId, [{ kind: "page", sourceVersionId: input.sourceVersionId, page: 1 } as any])))
        return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "The document must be a ready file revision in this project" });
      const pages = await d.db.select({ page: sourcePages.page, text: sql<string>`left(coalesce(${sourcePages.content}->>'text',''), 60000)` }).from(sourcePages)
        .where(and(eq(sourcePages.versionId, input.sourceVersionId), eq(sourcePages.tenantId, d.tenantId))).orderBy(asc(sourcePages.page)).limit(300);
      if (!(pages as any[]).some(row => String(row.text).trim())) return send(res, 422, { data: null, error: { code: "no_source_text" }, message: "No text has been read from this document yet" });
      const pageTexts = (pages as any[]).map(row => ({ page: Number(row.page), text: String(row.text) }));
      const noise = readDevelopmentPlanNoise(pageTexts);
      const zoning = readDevelopmentPlanZoning(pageTexts);
      const data = await readModel(d, modelRow.model);
      const props = new Map((data.properties as any[]).filter(property => property.entityType === "building").map(property => [`${property.entityId}:${property.propertyKey}`, property]));
      const first = (pages as any[]).find(row => String(row.text).trim());
      const planEvidence = buildingEvidenceSchema.parse({ kind: "page", sourceVersionId: input.sourceVersionId, page: Number(first.page), quote: String(first.text).trim().split("\n")[0].slice(0, 240) });
      // One evidence item per quoted sentence, even when it states several requirements.
      const evidenceOf = (statements: Array<{ page: number; quote: string }>) => [...new Map(statements.map(statement => [`${statement.page}:${statement.quote}`, statement])).values()].slice(0, 20)
        .map(statement => buildingEvidenceSchema.parse({ kind: "page", sourceVersionId: input.sourceVersionId, page: statement.page, quote: statement.quote }));
      const proposed: Array<readonly [string, string | null, unknown[]]> = [["bebauungsplan", "applies", [planEvidence]], ["bebauungsplanNoise", noise.summary, evidenceOf(noise.statements)],
        ...Object.entries(zoning.values).map(([key, value]) => [key, value ?? null, evidenceOf(zoning.statements.filter(statement => statement.key === key))] as const)];
      const result = await modelTransaction(d.db, async (tx: any) => {
        const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        let proposals = 0;
        for (const building of data.buildings as any[]) {
          for (const [key, value, evidence] of proposed) {
            if (value === null || !derivedWritable(props.get(`${building.id}:${key}`), value)) continue;
            await appendPropertyVersion(tx, d, modelRow.model.id, { entityType: "building", entityId: building.id, propertyKey: key, claimKind: "requirement", value, unit: null, provenance: "inferred", evidence: [...evidence] });
            proposals++;
          }
        }
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId });
        await d.audit(tx, "projects.building.regulatory.bebauungsplan_read", "building_model", modelRow.model.id, { projectId, modelRevision: revision, sourceVersionId: input.sourceVersionId,
          method: developmentPlanNoiseMethod, statements: noise.statements.length, zoningMethod: developmentPlanZoningMethod, zoningStatements: zoning.statements.length, proposals });
        return { revision, summary: { ...noise, zoning, proposals, method: developmentPlanNoiseMethod, zoningMethod: developmentPlanZoningMethod } };
      });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict);
      return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  // Architects answer per wall type, so one wall's construction data can fill every wall with the same role.
  router.post("/projects/:projectId/building-model/component-copy", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), sourceElementId: uuid,
        keys: z.array(z.enum(["construction", "material", "thickness", "bulkDensity"])).min(1).max(4) }).strict().parse(req.body);
      const modelRow = await modelForProject(d, projectId);
      if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      if (modelRow.model.revision !== input.baseRevision) return revisionConflict(res, modelRow.model.revision);
      const data = await readModel(d, modelRow.model);
      const props = new Map((data.properties as any[]).filter(property => property.entityType === "element").map(property => [`${property.entityId}:${property.propertyKey}`, property]));
      if (!(data.elements as any[]).some(element => element.id === input.sourceElementId)) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Element not found" });
      const role = effectiveValue(props.get(`${input.sourceElementId}:wallRole`));
      if (typeof role !== "string") return send(res, 422, { data: null, error: { code: "wall_role_required" }, message: "Set this wall's role before copying its data to walls of the same role" });
      const targets = (data.elements as any[]).filter(element => element.id !== input.sourceElementId && effectiveValue(props.get(`${element.id}:wallRole`)) === role);
      const result = await modelTransaction(d.db, async (tx: any) => {
        const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        const updated: Record<string, number> = {}; let kept = 0;
        for (const key of input.keys) {
          // Only what a person entered or approved is copied; a derived guess is not passed on as an entry.
          const source = props.get(`${input.sourceElementId}:${key}`) as any;
          const entered = source?.current && source.current.reviewStatus !== "rejected" && (source.current.provenance !== "inferred" || source.current.reviewStatus === "approved") ? source.current : source?.reviewed ?? null;
          if (!entered || entered.value === null) continue;
          const value = entered.value, unit = entered.unit ?? null, evidence = (entered.evidence ?? []).slice(0, 20);
          for (const target of targets) {
            const existing = props.get(`${target.id}:${key}`) as any;
            if (JSON.stringify(effectiveValue(existing)) === JSON.stringify(value)) continue;
            // Only fill gaps and replace derived guesses; a person's entry or a reviewed value stays.
            if (existing?.reviewed || (existing?.current && existing.current.provenance !== "inferred" && existing.current.reviewStatus !== "rejected")) { kept++; continue; }
            await appendPropertyVersion(tx, d, modelRow.model.id, { entityType: "element", entityId: target.id, propertyKey: key, value, unit, provenance: "manual", evidence });
            updated[key] = (updated[key] ?? 0) + 1;
          }
        }
        const summary = { wallRole: role, targets: targets.length, updated, kept };
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", createdBy: d.actorId });
        await d.audit(tx, "projects.building.component.copied", "building_element", input.sourceElementId, { projectId, modelRevision: revision, keys: input.keys, ...summary });
        return { revision, summary };
      });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict);
      return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  router.get("/projects/:projectId/building-model/site-plan", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); const projectId = uuid.parse(id(req.params.projectId));
      return res.json(ok(await readSitePlan(d, projectId)));
    } catch (e) { return next(e); }
  });

  router.put("/projects/:projectId/building-model/placement", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(id(req.params.projectId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), origin: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite().optional(), crs: z.enum(["EPSG:25832", "EPSG:25833"]).optional() }).strict(), orientation: z.object({ degrees: z.number().finite() }).strict().nullable().optional(), alignmentStatus: z.enum(["unknown", "approximate", "reviewed"]).default("unknown"), evidence: z.array(buildingEvidenceSchema).max(20).default([]) }).strict().parse(req.body);
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

  // Mark a plan set as replaced by another revision (or restore it). Only the model view changes:
  // the file, its extractions and candidates stay intact and reappear on restore.
  router.put("/projects/:projectId/building-model/superseded-sources/:sourceVersionId", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); d.requirePermission("projects:write");
      const projectId = uuid.parse(id(req.params.projectId)); const sourceVersionId = uuid.parse(id(req.params.sourceVersionId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), supersededByVersionId: uuid }).strict().parse(req.body);
      if (input.supersededByVersionId === sourceVersionId) return send(res, 422, { data: null, error: { code: "invalid_replacement" }, message: "A plan set cannot supersede itself" });
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const versions = await d.db.select({ id: fileVersions.id }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(and(inArray(fileVersions.id, [sourceVersionId, input.supersededByVersionId]), eq(fileVersions.tenantId, d.tenantId), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId)));
      if (versions.length !== 2) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "Both plan sets must be file revisions in this project" });
      const result = await modelTransaction(d.db, async (tx: any) => {
        const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        const [superseded] = await tx.insert(buildingSupersededSources).values({ tenantId: d.tenantId, modelId: modelRow.model.id, sourceVersionId, supersededByVersionId: input.supersededByVersionId, createdBy: d.actorId })
          .onConflictDoUpdate({ target: [buildingSupersededSources.modelId, buildingSupersededSources.sourceVersionId], set: { supersededByVersionId: input.supersededByVersionId } }).returning();
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", label: "Plan set superseded", createdBy: d.actorId });
        await d.audit(tx, "projects.building.plan_source.superseded", "file_version", sourceVersionId, { projectId, supersededByVersionId: input.supersededByVersionId, modelRevision: revision });
        return { superseded, revision };
      });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 200, ok(result));
    } catch (e) { return next(e); }
  });

  router.delete("/projects/:projectId/building-model/superseded-sources/:sourceVersionId", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); d.requirePermission("projects:write");
      const projectId = uuid.parse(id(req.params.projectId)); const sourceVersionId = uuid.parse(id(req.params.sourceVersionId));
      const input = z.object({ baseRevision: z.number().int().nonnegative() }).strict().parse(req.body);
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const result = await modelTransaction(d.db, async (tx: any) => {
        const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        const removed = await tx.delete(buildingSupersededSources).where(and(eq(buildingSupersededSources.modelId, modelRow.model.id), eq(buildingSupersededSources.tenantId, d.tenantId), eq(buildingSupersededSources.sourceVersionId, sourceVersionId))).returning();
        if (!removed.length) return { missing: true };
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", label: "Superseded plan set restored", createdBy: d.actorId });
        await d.audit(tx, "projects.building.plan_source.restored", "file_version", sourceVersionId, { projectId, modelRevision: revision });
        return { restored: sourceVersionId, revision };
      });
      if ((result as any).missing) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Plan set is not superseded" });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 200, ok(result));
    } catch (e) { return next(e); }
  });

  // What a plan set's fill colours mean for its walls. Saving re-extracts the plan set's pages;
  // walls already accepted keep the state they were given.
  router.put("/projects/:projectId/building-model/colour-legends/:sourceVersionId", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); d.requirePermission("projects:write");
      const projectId = uuid.parse(id(req.params.projectId)); const sourceVersionId = uuid.parse(id(req.params.sourceVersionId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), entries: z.array(z.object({
        colour: z.string().regex(/^#[0-9a-f]{6}$/), layer: z.enum(["construction", "existing"]), state: z.enum(["proposed", "retained", "demolished", "not_wall"]) }).strict()).max(200) }).strict().parse(req.body);
      const entries = [...new Map(input.entries.map(entry => [`${entry.layer}:${entry.colour}`, entry])).values()];
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const [version] = await d.db.select({ id: fileVersions.id }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(and(eq(fileVersions.id, sourceVersionId), eq(fileVersions.tenantId, d.tenantId), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId)));
      if (!version) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "The plan set must be a file revision in this project" });
      const result = await modelTransaction(d.db, async (tx: any) => {
        const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        const [legend] = await tx.insert(buildingColourLegends).values({ tenantId: d.tenantId, modelId: modelRow.model.id, sourceVersionId, entries, updatedBy: d.actorId })
          .onConflictDoUpdate({ target: [buildingColourLegends.modelId, buildingColourLegends.sourceVersionId], set: { entries, updatedBy: d.actorId, updatedAt: new Date() } }).returning();
        const requeued = await tx.update(buildingExtractionJobs).set({ status: "queued", attempts: 0, leaseToken: null, leaseUntil: null, result: null, updatedAt: new Date() })
          .where(and(eq(buildingExtractionJobs.modelId, modelRow.model.id), eq(buildingExtractionJobs.tenantId, d.tenantId), eq(buildingExtractionJobs.sourceVersionId, sourceVersionId),
            inArray(buildingExtractionJobs.status, ["complete", "failed"]))).returning({ id: buildingExtractionJobs.id });
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", label: "Plan colours set", createdBy: d.actorId });
        await d.audit(tx, "projects.building.colour_legend.saved", "file_version", sourceVersionId, { projectId, entries, requeuedJobCount: requeued.length, modelRevision: revision });
        return { legend, revision, requeuedJobCount: requeued.length };
      });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 200, ok(result));
    } catch (e) { return next(e); }
  });

  // The plan set's scale as a person sets it (1:n on its sheets); null returns to reading it from the plan.
  router.put("/projects/:projectId/building-model/plan-scales/:sourceVersionId", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); d.requirePermission("projects:write");
      const projectId = uuid.parse(id(req.params.projectId)); const sourceVersionId = uuid.parse(id(req.params.sourceVersionId));
      const input = z.object({ baseRevision: z.number().int().nonnegative(), denominator: z.number().int().min(10).max(5000).nullable() }).strict().parse(req.body);
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      const [version] = await d.db.select({ id: fileVersions.id }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(and(eq(fileVersions.id, sourceVersionId), eq(fileVersions.tenantId, d.tenantId), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId)));
      if (!version) return send(res, 422, { data: null, error: { code: "invalid_source_revision" }, message: "The plan set must be a file revision in this project" });
      const result = await modelTransaction(d.db, async (tx: any) => {
        const revision = await touchRevision(tx, d, modelRow.model.id, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        const [settings] = await tx.insert(buildingColourLegends).values({ tenantId: d.tenantId, modelId: modelRow.model.id, sourceVersionId, scaleDenominator: input.denominator, updatedBy: d.actorId })
          .onConflictDoUpdate({ target: [buildingColourLegends.modelId, buildingColourLegends.sourceVersionId], set: { scaleDenominator: input.denominator, updatedBy: d.actorId, updatedAt: new Date() } }).returning();
        const requeued = await tx.update(buildingExtractionJobs).set({ status: "queued", attempts: 0, leaseToken: null, leaseUntil: null, result: null, updatedAt: new Date() })
          .where(and(eq(buildingExtractionJobs.modelId, modelRow.model.id), eq(buildingExtractionJobs.tenantId, d.tenantId), eq(buildingExtractionJobs.sourceVersionId, sourceVersionId),
            inArray(buildingExtractionJobs.status, ["complete", "failed"]))).returning({ id: buildingExtractionJobs.id });
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: modelRow.model.id, revision, status: "draft", label: "Plan scale set", createdBy: d.actorId });
        await d.audit(tx, "projects.building.plan_scale.saved", "file_version", sourceVersionId, { projectId, denominator: input.denominator, requeuedJobCount: requeued.length, modelRevision: revision });
        return { scaleDenominator: settings.scaleDenominator, revision, requeuedJobCount: requeued.length };
      });
      if ((result as any).conflict !== undefined) return revisionConflict(res, (result as any).conflict); return send(res, 200, ok(result));
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
  router.use(createBuildingOutlineRouter(getDeps));
  router.use(createIfcBuildingRouter(getDeps));
  return router;
}
