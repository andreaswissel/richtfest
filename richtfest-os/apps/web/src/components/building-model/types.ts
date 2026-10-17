import type { DataRequestProgress } from "@richtfest/shared";
import type { RecordData } from "../../api";

export type BuildingModelState = "existing" | "demolition" | "proposed";

export type BuildingEvidence = {
  fileName: string;
  sourceVersionId?: string;
  fileId?: string;
  version?: number;
  pageCount: number;
  pdfUrl?: string;
  pages?: Array<{ page: number; label?: string; thumbnailUrl?: string }>;
  layers?: Array<{ id: string; label: string; visible?: boolean }>;
};
export type BuildingPlanSource = {
  id: string;
  storeyId?: string | null;
  page: number;
  pageCount?: number | null;
  layers?: Array<{ id?: string; name?: string; label?: string; visible?: boolean; defaultVisible?: boolean }>;
  source?: { fileId: string; fileName: string; versionId: string; version: number; downloadUrl: string };
};

export type PdfEvidenceLayer = { id: string; label: string; visible: boolean };
export type BuildingPlanPoint = { x: number; y: number };
export type BuildingGeometryPart = { polygon: BuildingPlanPoint[]; box?: { x: number; y: number; width: number; height: number } };

export type BuildingRegion = {
  id: string;
  entityType?: "building" | "storey" | "room" | "element";
  kind: "room" | "element" | "unknown-room";
  label: string;
  roomUse?: string | null;
  constructionState?: string | null;
  storeyId?: string | null;
  sourceVersionId?: string | null;
  page: number;
  box?: { x: number; y: number; width: number; height: number };
  polygon?: BuildingPlanPoint[];
  /** Holes cut out of `polygon` (courtyards, shafts); drawn with the even-odd rule. */
  holes?: BuildingPlanPoint[][];
  parts?: BuildingGeometryPart[];
  /** Set when a planner drew or reshaped this outline on the plan. */
  outlineEdit?: { method?: string; areaM2?: number | null; editCount?: number; editedAt?: string } | null;
  groupLabel?: string | null;
  sourceArea?: unknown;
  roomUseProposal?: {
    status?: string;
    provider?: string;
    model?: string;
    version?: string;
    roomUse?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
  } | null;
  algorithm?: string | null;
  competingLabels?: string[];
  layerId?: string | null;
  layerName?: string | null;
  geometryLimitations?: string | null;
  candidateRole?: "room-region" | "unresolved-anchor" | "draft-wall" | "construction-assembly" | "raw-footprint" | "element" | null;
  semanticType?: string | null;
  material?: unknown;
  wallThickness?: unknown;
  sourceScale?: unknown;
  sourceFootprintKeys?: string[];
  classification?: Record<string, unknown> | null;
  properties?: Record<string, unknown>;
  evidence?: Array<{
    label: string;
    value: string;
    page?: number;
    layerId?: string;
    layerName?: string;
    source?: "source-stated" | "inferred" | "calibrated";
  }>;
  measurements?: Array<{
    key: string;
    label: string;
    semanticQuantity?: string;
    value?: number | null;
    sourceValue?: string | number | null;
    calibratedValue?: string | number | null;
    unit?: string;
    sourceVersionId?: string;
    sourcePage?: number;
    method?: string;
    uncertainty?: unknown;
    evidence?: Array<RecordData>;
  }>;
  /** Raw element kind such as `draft_wall`; region `kind` only distinguishes rooms from elements. */
  elementKind?: string | null;
  /** Latest version of each shared component property (componentType, thickness, wallRole, ...). */
  componentProperties?: Record<string, BuildingComponentPropertyState>;
  /** Rooms on each face of a wall, from derived plan adjacency. */
  separates?: Array<{ side: number; roomIds: string[]; exterior?: boolean }>;
  /** Rooms under a derived storey ceiling. */
  covers?: string[];
  /** Storey directly above a derived ceiling, when both levels are known. */
  underStorey?: string;
  status?: "unreviewed" | "reviewed" | "needs-review" | "accepted" | "rejected" | "matched" | string;
  /** Extraction candidates use the same normalized geometry as reviewed regions. */
  isCandidate?: boolean;
  geometryQuality?: string | null;
  uncertainty?: unknown;
  match?: { existingId?: string | null; confidence?: number | null } | null;
};

export type BuildingExtractionCoverage = {
  pages?: number | null;
  regions?: number | null;
  objects?: number | null;
  unresolved?: number | null;
  byPage?: Array<{ page: number; regions?: number; objects?: number; unresolved?: number }>;
  note?: string | null;
};

export type BuildingExtractionJob = {
  id: string;
  sourceVersionId?: string;
  storeyId?: string | null;
  page?: number;
  status: "queued" | "running" | "complete" | "succeeded" | "failed" | "cancelled" | string;
  phase?: string | null;
  progress?: number | null;
  error?: string | null;
  source?: { fileId?: string; sourceVersionId?: string; versionId?: string; page?: number; storeyId?: string | null } | null;
  coverage?: BuildingExtractionCoverage | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  result?: {
    phase?: string;
    retryable?: boolean;
    inference?: { provider?: string; active?: boolean; configured?: boolean | null; outcome?: string | null } | null;
    pageCount?: number;
    method?: string;
    coverage?: string;
    geometryQuality?: string;
    candidateCount?: number;
    /** Page proportions and the unreviewed printed scale, used to show outline areas. */
    pageScale?: { pageAspectRatio: number; metresPerPageHeight: number | null } | null;
    roomAnchorCount?: number;
    roomHypothesisCount?: number;
    unresolvedAnchorCount?: number;
    elementFootprintCount?: number;
    constructionAssemblyCount?: number;
    constructionFragmentCount?: number;
    semanticWallCount?: number;
    draftWallCount?: number;
    wallCandidateCount?: number;
    rawFootprintCount?: number;
    sourceAreaObservationCount?: number;
    topologyCoverage?: {
      approximateRegionCount?: number;
      unresolvedRegionCount?: number;
      assemblyCount?: number;
      semanticWallCount?: number;
      draftWallCount?: number;
      wallCount?: number;
      fragmentAssemblyCount?: number;
      unsupportedFootprintCount?: number;
      sourceFootprintCount?: number;
      printedAreaCount?: number;
    } | null;
    geometryExtraction?: {
      status?: string;
      constructionFilledPaths?: number;
      retainedFootprints?: number;
      omittedSmall?: number;
      omittedUnsupported?: number;
      omittedDuplicate?: number;
      truncated?: boolean;
      limitations?: string | null;
    } | null;
    reason?: string | null;
  } | null;
};

export type BuildingAutomaticPlanProcessing = {
  fileId?: string;
  fileName: string;
  sourceVersionId: string;
  status: "reading_source" | "classifying_pages" | "planning" | "queued" | "extracting" | "complete" | "partial" | "unresolved" | "failed" | string;
  currentPhase?: "reading_plan" | "identifying_floors" | "extracting_geometry" | "preparing_draft" | "complete" | "partial" | "unsupported" | "failed" | string;
  inference?: { provider?: string; active?: boolean; configured?: boolean | null } | null;
  renderableSource?: { mimeType?: string | null; downloadUrl?: string | null } | null;
  sourceStatus?: string | null;
  classificationStatus?: string | null;
  pageCount?: number | null;
  registeredPageCount?: number;
  coverageTruncated?: boolean;
  floorPlanPages: number[];
  nonFloorPlanPages: Array<{ page: number; pageType?: string | null; confidence?: number | null }>;
  unresolvedPages: number[];
  reason?: string | null;
  jobStatuses?: Record<string, number>;
  errors?: Array<{ jobId?: string; page?: number; status?: string; retryable?: boolean; attempts?: number; reason?: string | null }>;
};

export type BuildingExtractionCandidate = BuildingRegion & {
  candidateId?: string;
  jobId?: string;
  status: "unreviewed" | "accepted" | "rejected" | "matched" | string;
  isCandidate: true;
};

export type BuildingSupersededSource = { sourceVersionId: string; fileName: string; supersededByVersionId: string | null };

export type BuildingComponentPropertyState = {
  propertyId: string;
  version: number;
  value: unknown;
  unit: string | null;
  provenance: string;
  reviewStatus: string;
  reviewRevision: number;
  reviewedValue: unknown;
  /** Quote of the first evidence item, such as "Printed scale 1:100" or a Baubeschreibung sentence. */
  evidenceQuote?: string | null;
  evidenceKind?: string | null;
};

export type BuildingModel = {
  id?: string;
  revision?: number;
  reviewStatus?: "draft" | "needs-review" | "reviewed" | "conflict";
  evidence: BuildingEvidence;
  planSources: BuildingPlanSource[];
  proposals: RecordData[];
  extraction?: BuildingExtractionJob | null;
  extractions: BuildingExtractionJob[];
  extractionCandidates: BuildingExtractionCandidate[];
  extractionCoverage?: BuildingExtractionCoverage | null;
  automaticPlanProcessing: BuildingAutomaticPlanProcessing[];
  /** Plan sets replaced by another revision; hidden from the model, restorable. */
  supersededSources: BuildingSupersededSource[];
  storeys: Array<{ id: string; name?: string; levelIndex?: number | null; componentProperties?: Record<string, BuildingComponentPropertyState> }>;
  /** Sent component data requests and what has been answered since. */
  /** Buildings with their shared properties, such as the agreed sound insulation level. */
  buildings: Array<{ id: string; name: string; componentProperties: Record<string, BuildingComponentPropertyState> }>;
  states: Record<BuildingModelState, BuildingRegion[]>;
  updatedAt?: string;
};

const asString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;

const asNumber = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function planBox(value: unknown): BuildingRegion["box"] {
  if (!value || typeof value !== "object") return undefined;
  const item = value as RecordData;
  if ([item.x, item.y, item.width, item.height].every((part) => typeof part === "number" && Number.isFinite(part))) return { x: item.x, y: item.y, width: item.width, height: item.height };
  if ([item.left, item.top, item.right, item.bottom].every((part) => typeof part === "number" && Number.isFinite(part))) return { x: item.left, y: item.top, width: item.right - item.left, height: item.bottom - item.top };
  return undefined;
}
function outlineEdit(value: unknown): BuildingRegion["outlineEdit"] {
  if (!value || typeof value !== "object") return null;
  const edit = value as RecordData;
  return { method: typeof edit.method === "string" ? edit.method : undefined, areaM2: typeof edit.areaM2 === "number" ? edit.areaM2 : null,
    editCount: typeof edit.editCount === "number" ? edit.editCount : undefined, editedAt: typeof edit.editedAt === "string" ? edit.editedAt : undefined };
}
function planHoles(value: unknown): BuildingRegion["holes"] {
  if (!Array.isArray(value)) return undefined;
  const holes = value.map(planPolygon).filter((hole): hole is BuildingPlanPoint[] => Boolean(hole));
  return holes.length ? holes : undefined;
}
function planPolygon(value: unknown): BuildingRegion["polygon"] {
  if (!Array.isArray(value)) return undefined;
  const points = value.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const point = part as RecordData;
    return typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)
      ? [{ x: point.x, y: point.y }]
      : [];
  });
  return points.length >= 3 ? points : undefined;
}

function polygonBox(polygon: BuildingRegion["polygon"]): BuildingRegion["box"] {
  if (!polygon?.length) return undefined;
  const x = Math.min(...polygon.map((point) => point.x));
  const y = Math.min(...polygon.map((point) => point.y));
  return { x, y, width: Math.max(...polygon.map((point) => point.x)) - x, height: Math.max(...polygon.map((point) => point.y)) - y };
}

function planParts(value: unknown): BuildingRegion["parts"] {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    if (Array.isArray(part)) {
      const polygon = planPolygon(part);
      const box = polygonBox(polygon);
      return polygon && box ? [{ polygon, box }] : [];
    }
    const item = part as RecordData;
    const polygon = planPolygon(item.polygon || (item.geometry && typeof item.geometry === "object" ? (item.geometry as RecordData).polygon : undefined));
    if (!polygon || polygon.length < 3) return [];
    const box = planBox(item.planRegion || item.box || (item.geometry && typeof item.geometry === "object" ? (item.geometry as RecordData).planRegion : undefined)) || polygonBox(polygon);
    return box ? [{ polygon, box }] : [];
  });
  return parts.length ? parts : undefined;
}

function partsBox(parts: BuildingRegion["parts"]): BuildingRegion["box"] {
  if (!parts?.length) return undefined;
  const boxes = parts.flatMap((part) => part.box ? [part.box] : []);
  if (!boxes.length) return undefined;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

const normalizedSemanticValue = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase().replaceAll("-", "_") : "";

/** Wall candidates require an explicit semantic marker. Names, partition algorithms and generic source paths never qualify. */
export function candidateRole(candidate: Pick<BuildingRegion, "entityType" | "geometryQuality" | "semanticType">): NonNullable<BuildingRegion["candidateRole"]> {
  const quality = normalizedSemanticValue(candidate.geometryQuality);
  const semanticType = normalizedSemanticValue(candidate.semanticType);
  if (candidate.entityType === "room") return quality === "anchor" ? "unresolved-anchor" : "room-region";
  if (["semantic_wall", "semantic_wall_candidate", "draft_wall", "wall_candidate", "source_wall"].includes(quality)
    || ["semantic_wall", "draft_wall", "wall", "wall_candidate"].includes(semanticType)) return "draft-wall";
  if (quality === "footprint" || quality === "raw_footprint") return "raw-footprint";
  if (["assembly", "construction_assembly", "construction_fragment_assembly"].includes(quality) || semanticType === "construction_fragment") return "construction-assembly";
  return "element";
}

function regions(value: unknown, defaultKind?: BuildingRegion["kind"], entityType?: BuildingRegion["entityType"], properties: RecordData[] = [], measurements: RecordData[] = []): BuildingRegion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as RecordData;
    const kind = row.kind === "element" || row.kind === "unknown-room" ? row.kind : (defaultKind || "room");
    const entityProperties = properties.filter((property) => property.entityId === row.id);
    const entityMeasurements = measurements.filter((measurement) => measurement.entityId === row.id);
    const geometrySource = row.geometry && typeof row.geometry === "object" && (row.geometry as RecordData).source && typeof (row.geometry as RecordData).source === "object" ? (row.geometry as RecordData).source as RecordData : undefined;
    const geometry = row.geometry && typeof row.geometry === "object" ? row.geometry as RecordData : undefined;
    const sourcePage = asNumber(geometrySource?.page, 1);
    const fieldEvidence: RecordData[] = entityProperties.flatMap((property) => property.current?.evidence || []).map((item: RecordData) => ({ ...item, value: item.value || item.quote || item.kind || "—", source: item.source || "source-stated", label: item.label || propertyLabel(entityProperties) }));
    const geometryEvidence: RecordData[] = geometrySource?.sourceVersionId ? [{ label: "Plan source", value: String(geometrySource.sourceVersionId), page: sourcePage, source: "source-stated" }] : [];
    return [{
      id: asString(row.id, crypto.randomUUID?.() || `region-${Math.random()}`),
      kind,
      entityType,
      label: asString(row.label || row.name, kind === "room" ? "Unnamed room" : "Unnamed element"),
      roomUse: typeof row.roomUse === "string" ? row.roomUse : null,
      constructionState: typeof row.constructionState === "string" ? row.constructionState : (typeof geometry?.constructionState === "string" ? geometry.constructionState : null),
      storeyId: typeof geometrySource?.storeyId === "string" ? geometrySource.storeyId : (typeof row.storeyId === "string" ? row.storeyId : null),
      sourceVersionId: typeof geometrySource?.sourceVersionId === "string" ? geometrySource.sourceVersionId : (typeof row.sourceVersionId === "string" ? row.sourceVersionId : null),
      page: Math.max(1, asNumber(geometrySource?.page, asNumber(row.page, 1))),
      box: planBox(row.planRegion || geometry?.planRegion),
      polygon: planPolygon(geometry?.polygon),
      holes: planHoles(geometry?.holes),
      parts: planParts(geometry?.parts ?? geometry?.polygons),
      geometryQuality: typeof geometry?.quality === "string" ? geometry.quality : null,
      outlineEdit: outlineEdit(geometry?.outlineEdit),
      properties: row.properties && typeof row.properties === "object" ? row.properties : undefined,
      evidence: Array.isArray(row.evidence) ? row.evidence : fieldEvidence.concat(geometryEvidence),
      elementKind: entityType === "element" && typeof row.kind === "string" ? row.kind : null,
      groupLabel: typeof geometry?.groupLabel === "string" ? geometry.groupLabel : null,
      componentProperties: componentStates(entityProperties),
      measurements: Array.isArray(row.measurements) ? row.measurements : entityMeasurements.map((item) => ({ key: item.id, label: item.label || item.quantity || "Measurement", semanticQuantity: item.quantity, value: item.value == null ? null : Number(item.value), sourceValue: item.method === "manual" ? null : item.value ?? item.quantity, calibratedValue: item.method === "manual" ? item.value : item.calibratedValue, unit: item.unit, sourcePage: item.evidence?.[0]?.page, method: item.method, uncertainty: item.uncertainty, evidence: item.evidence })),
      status: row.status === "reviewed" || row.status === "needs-review" ? row.status : "unreviewed",
    }];
  });
}

function extractionCandidates(value: unknown): BuildingExtractionCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as RecordData;
    const geometry = row.geometry && typeof row.geometry === "object" ? row.geometry as RecordData : undefined;
    const polygon = planPolygon(geometry?.polygon ?? row.polygon);
    const parts = planParts(geometry?.parts ?? geometry?.polygons ?? geometry?.sourcePolygons ?? row.sourcePolygons);
    const box = planBox(row.box || row.planRegion || geometry?.planRegion) || polygonBox(polygon) || partsBox(parts);
    const rawKind = row.entityType === "element" || row.kind === "element" ? "element" : row.kind === "unknown-room" ? "unknown-room" : "room";
    const sourceEvidence = Array.isArray(row.evidence) ? row.evidence : [];
    const layerEvidence = sourceEvidence.find((evidence: RecordData) => typeof evidence.layerId === "string" || typeof evidence.layerName === "string");
    const sourceFillEvidence = Array.isArray(geometry?.sourceFillEvidence) ? geometry.sourceFillEvidence as RecordData[] : [];
    const fillLayerEvidence = sourceFillEvidence.find((evidence) => typeof evidence.layerId === "string" || typeof evidence.layerName === "string");
    const topology = geometry?.topology && typeof geometry.topology === "object" ? geometry.topology as RecordData : undefined;
    const roomUseProposal = geometry?.roomUseProposal && typeof geometry.roomUseProposal === "object"
      ? geometry.roomUseProposal as BuildingRegion["roomUseProposal"] : null;
    const semanticType = [row.semanticType, row.semanticKind, row.candidateType, row.elementType, geometry?.semanticType, geometry?.semanticKind, geometry?.candidateType, geometry?.elementType, geometry?.objectType]
      .find((value) => typeof value === "string") as string | undefined;
    const geometryQuality = typeof row.geometryQuality === "string" ? row.geometryQuality : (typeof geometry?.quality === "string" ? geometry.quality : null);
    const role = candidateRole({ entityType: rawKind === "element" ? "element" : "room", geometryQuality, semanticType });
    const source = row.source && typeof row.source === "object" ? row.source as RecordData : undefined;
    const primaryEvidence = sourceEvidence.find((item: RecordData) => typeof item.sourceVersionId === "string" || typeof item.page === "number");
    return [{
      id: `candidate:${asString(row.id || row.candidateId, crypto.randomUUID?.() || `candidate-${Math.random()}`)}`,
      candidateId: asString(row.id || row.candidateId),
      jobId: asString(row.jobId) || undefined,
      isCandidate: true as const,
      entityType: rawKind === "element" ? "element" : "room",
      kind: rawKind,
      label: asString(row.label || row.name, rawKind === "room" ? "Unknown room" : "Unnamed element"),
      roomUse: typeof row.roomUse === "string" ? row.roomUse : null,
      constructionState: typeof row.constructionState === "string" ? row.constructionState : (typeof geometry?.constructionState === "string" ? geometry.constructionState : null),
      storeyId: typeof row.storeyId === "string" ? row.storeyId : null,
      sourceVersionId: typeof row.sourceVersionId === "string" ? row.sourceVersionId : (typeof source?.sourceVersionId === "string" ? source.sourceVersionId : (typeof primaryEvidence?.sourceVersionId === "string" ? primaryEvidence.sourceVersionId : null)),
      page: Math.max(1, asNumber(row.page || source?.page || primaryEvidence?.page, 1)),
      properties: row.properties && typeof row.properties === "object" ? row.properties : undefined,
      box,
      polygon,
      holes: planHoles(geometry?.holes),
      parts,
      outlineEdit: outlineEdit(geometry?.outlineEdit),
      groupLabel: typeof row.groupLabel === "string" ? row.groupLabel : (typeof geometry?.groupLabel === "string" ? geometry.groupLabel : null),
      sourceArea: row.sourceArea ?? geometry?.sourceArea ?? geometry?.printedArea ?? null,
      roomUseProposal,
      algorithm: typeof row.algorithm === "string" ? row.algorithm : (typeof geometry?.algorithm === "string" ? geometry.algorithm : (typeof topology?.method === "string" ? topology.method : null)),
      competingLabels: Array.isArray(row.competingLabels) ? row.competingLabels.filter((item): item is string => typeof item === "string") : (Array.isArray(geometry?.competingLabels) ? geometry.competingLabels.filter((item): item is string => typeof item === "string") : (Array.isArray(topology?.competingSourceKeys) ? topology.competingSourceKeys.filter((item): item is string => typeof item === "string") : [])),
      layerId: typeof geometry?.layerId === "string" ? geometry.layerId : (typeof layerEvidence?.layerId === "string" ? layerEvidence.layerId : (typeof fillLayerEvidence?.layerId === "string" ? fillLayerEvidence.layerId : null)),
      layerName: typeof geometry?.layerName === "string" ? geometry.layerName : (typeof layerEvidence?.layerName === "string" ? layerEvidence.layerName : (typeof fillLayerEvidence?.layerName === "string" ? fillLayerEvidence.layerName : null)),
      geometryLimitations: typeof row.limitations === "string" ? row.limitations : (typeof geometry?.limitations === "string" ? geometry.limitations : null),
      candidateRole: role,
      semanticType: semanticType || null,
      material: row.material ?? geometry?.material ?? null,
      wallThickness: row.wallThickness ?? row.thickness ?? geometry?.wallThickness ?? geometry?.thickness ?? null,
      sourceScale: row.sourceScale ?? row.scale ?? geometry?.sourceScale ?? geometry?.scale ?? null,
      sourceFootprintKeys: (Array.isArray(row.sourceFootprintKeys) ? row.sourceFootprintKeys : Array.isArray(geometry?.sourceFootprintKeys) ? geometry.sourceFootprintKeys : []).filter((item): item is string => typeof item === "string"),
      classification: geometry?.classification && typeof geometry.classification === "object" ? geometry.classification as Record<string, unknown> : (row.classification && typeof row.classification === "object" ? row.classification as Record<string, unknown> : null),
      evidence: sourceEvidence.map((item: RecordData) => ({ label: item.label || "Source page", value: String(item.value || item.quote || item.kind || "—"), page: typeof item.page === "number" ? item.page : undefined, layerId: item.layerId, layerName: item.layerName, source: "source-stated" as const })),
      measurements: Array.isArray(row.measurements) ? row.measurements : [],
      status: asString(row.status, "unreviewed"),
      geometryQuality,
      uncertainty: row.uncertainty,
      match: row.match && typeof row.match === "object" ? { existingId: row.match.existingId ?? row.match.targetEntityId ?? null, confidence: typeof row.match.confidence === "number" ? row.match.confidence : null } : null,
    }];
  });
}

const propertyLabel = (properties: RecordData[]) => properties[0]?.propertyKey || "Property";

function componentStates(entityProperties: RecordData[]): Record<string, BuildingComponentPropertyState> {
  return Object.fromEntries(entityProperties.filter((property) => property.current).map((property) => [String(property.propertyKey), {
    propertyId: String(property.id), version: asNumber(property.current.version, 1), value: property.current.value, unit: typeof property.current.unit === "string" ? property.current.unit : null,
    provenance: asString(property.current.provenance), reviewStatus: asString(property.current.reviewStatus, "unreviewed"), reviewRevision: asNumber(property.current.reviewRevision, 0),
    reviewedValue: property.reviewed ? property.reviewed.value : null,
    evidenceQuote: typeof property.current.evidence?.[0]?.quote === "string" ? property.current.evidence[0].quote : null,
    evidenceKind: typeof property.current.evidence?.[0]?.kind === "string" ? property.current.evidence[0].kind : null,
  }]));
}

function coversByCeiling(relationships: RecordData[]) {
  const result = new Map<string, { covers: string[]; underStorey?: string }>();
  for (const relationship of relationships) {
    if (relationship.fromEntityType !== "element") continue;
    const entry = result.get(relationship.fromEntityId) ?? { covers: [] };
    if (relationship.relationshipType === "covers" && relationship.toEntityType === "room") entry.covers.push(relationship.toEntityId);
    else if (relationship.relationshipType === "under_storey" && relationship.toEntityType === "storey") entry.underStorey = relationship.toEntityId;
    else continue;
    result.set(relationship.fromEntityId, entry);
  }
  return result;
}

function separatesByWall(relationships: RecordData[]) {
  const result = new Map<string, NonNullable<BuildingRegion["separates"]>>();
  for (const relationship of relationships) {
    if (!["separates", "faces_exterior"].includes(relationship.relationshipType) || relationship.fromEntityType !== "element") continue;
    const side = asNumber(relationship.metadata?.side, 0), faces = result.get(relationship.fromEntityId) ?? [];
    const exterior = relationship.relationshipType === "faces_exterior";
    const face = faces.find((item) => item.side === side);
    if (face) { if (exterior) face.exterior = true; else face.roomIds.push(relationship.toEntityId); }
    else faces.push({ side, roomIds: exterior ? [] : [relationship.toEntityId], ...(exterior ? { exterior } : {}) });
    result.set(relationship.fromEntityId, faces.sort((a, b) => a.side - b.side));
  }
  return result;
}

function entityRows(raw: RecordData, state: BuildingModelState, kind: BuildingRegion["kind"], entityType: BuildingRegion["entityType"], properties: RecordData[], measurements: RecordData[]) {
  const rows = Array.isArray(raw) ? raw.filter((row) => {
    const constructionState = row.constructionState;
    if (state === "demolition") return constructionState === "demolished" || constructionState === "retained";
    if (state === "proposed") return constructionState === "proposed" || constructionState === "retained";
    return constructionState !== "demolished" && constructionState !== "proposed";
  }) : [];
  return regions(rows, kind, entityType, properties, measurements).map((region) => ({
    ...region,
    kind: region.entityType === "room" && !rows.find((row) => row.id === region.id)?.roomUse ? "unknown-room" : region.kind,
  }));
}

export function adaptBuildingModel(input: unknown): BuildingModel {
  const raw = (input && typeof input === "object" ? input : {}) as RecordData;
  const evidence = (raw.evidence && typeof raw.evidence === "object" ? raw.evidence : raw.source) as RecordData | undefined;
  const source = raw.model && typeof raw.model === "object" ? raw.model : raw;
  const fallbackEvidence: BuildingEvidence = {
    fileName: asString(evidence?.fileName || raw.fileName, "Building plan.pdf"),
    sourceVersionId: asString(evidence?.sourceVersionId || raw.sourceVersionId || source?.sourceVersionId) || undefined,
    fileId: asString(evidence?.fileId || raw.fileId || source?.fileId) || undefined,
    version: asNumber(evidence?.version || raw.version || source?.version, 1),
    pageCount: Math.max(1, asNumber(evidence?.pageCount || raw.pageCount, 1)),
    pdfUrl: asString(evidence?.pdfUrl || raw.pdfUrl) || undefined,
    pages: Array.isArray(evidence?.pages) ? evidence.pages : undefined,
    layers: Array.isArray(evidence?.layers) ? evidence.layers : undefined,
  };
  const properties = Array.isArray(raw.properties) ? raw.properties : [];
  const measurements = Array.isArray(raw.measurements) ? raw.measurements : [];
  const planSources: BuildingPlanSource[] = Array.isArray(raw.planSources) ? raw.planSources : [];
  const rawExtraction = raw.extraction && typeof raw.extraction === "object" ? raw.extraction as RecordData : undefined;
  const extractions: BuildingExtractionJob[] = (Array.isArray(raw.extractions) ? raw.extractions : rawExtraction ? [rawExtraction.job || rawExtraction] : []).flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || typeof (item as RecordData).id !== "string") return [];
    return [item as BuildingExtractionJob];
  }).sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  const rawCandidates = raw.extractionCandidates || raw.candidates || rawExtraction?.candidates;
  const hasUnreviewedCandidates = Array.isArray(rawCandidates) && rawCandidates.some((item) => item && typeof item === "object" && (!((item as RecordData).status) || (item as RecordData).status === "unreviewed"));
  const coverage = raw.extractionCoverage || rawExtraction?.coverage;
  const extractionJobsById = new Map(extractions.map((job) => [job.id, job]));
  const withPlanSourcePage = (items: BuildingRegion[]) => items.map((region) => ({
    ...region,
    page: region.sourceVersionId ? region.page : planSources.find((source) => source.storeyId && source.storeyId === region.storeyId)?.page ?? region.page,
  }));
  const separates = separatesByWall(Array.isArray(raw.relationships) ? raw.relationships : []);
  const covers = coversByCeiling(Array.isArray(raw.relationships) ? raw.relationships : []);
  const entityRowsForState = (state: BuildingModelState) => [
    ...entityRows(raw.rooms, state, "room", "room", properties, measurements),
    ...entityRows(raw.elements, state, "element", "element", properties, measurements).map((region) => ({ ...region,
      ...(separates.has(region.id) ? { separates: separates.get(region.id) } : {}), ...covers.get(region.id) })),
  ];
  return {
    id: asString(source.id) || undefined,
    revision: asNumber(source.revision, 0),
    reviewStatus: raw.conflicts?.length ? "conflict" : raw.proposals?.some((proposal: RecordData) => proposal.status === "pending") || hasUnreviewedCandidates ? "needs-review" : raw.revisions?.[0]?.status === "approved" ? "reviewed" : source.reviewStatus === "reviewed" || source.reviewStatus === "needs-review" || source.reviewStatus === "conflict" ? source.reviewStatus : "draft",
    evidence: fallbackEvidence,
    planSources,
    proposals: Array.isArray(raw.proposals) ? raw.proposals : [],
    extraction: extractions[0] || undefined,
    extractions,
    extractionCandidates: extractionCandidates(rawCandidates).map((candidate) => {
      const job = candidate.jobId ? extractionJobsById.get(candidate.jobId) : undefined;
      return { ...candidate, storeyId: candidate.storeyId || job?.storeyId || null, sourceVersionId: candidate.sourceVersionId || job?.sourceVersionId || null, page: candidate.page || job?.page || 1 };
    }),
    extractionCoverage: coverage && typeof coverage === "object" ? coverage as BuildingExtractionCoverage : undefined,
    supersededSources: Array.isArray(raw.supersededSources) ? raw.supersededSources.flatMap((item: unknown) => {
      const row = item && typeof item === "object" ? item as RecordData : null;
      return row && typeof row.sourceVersionId === "string" ? [{ sourceVersionId: row.sourceVersionId, fileName: asString(row.fileName, "Building plan.pdf"),
        supersededByVersionId: typeof row.supersededByVersionId === "string" ? row.supersededByVersionId : null }] : [];
    }) : [],
    automaticPlanProcessing: Array.isArray(raw.automaticPlanProcessing) ? raw.automaticPlanProcessing.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const row = item as RecordData;
      if (typeof row.sourceVersionId !== "string") return [];
      return [{
        ...row,
        fileName: asString(row.fileName, "Building plan.pdf"),
        sourceVersionId: row.sourceVersionId,
        status: asString(row.status, "planning"),
        floorPlanPages: Array.isArray(row.floorPlanPages) ? row.floorPlanPages.filter((page): page is number => typeof page === "number") : [],
        nonFloorPlanPages: Array.isArray(row.nonFloorPlanPages) ? row.nonFloorPlanPages.filter((page): page is { page: number; pageType?: string | null; confidence?: number | null } => Boolean(page) && typeof page === "object" && typeof page.page === "number") : [],
        unresolvedPages: Array.isArray(row.unresolvedPages) ? row.unresolvedPages.filter((page): page is number => typeof page === "number") : [],
      } as BuildingAutomaticPlanProcessing];
    }) : [],
    storeys: Array.isArray(raw.storeys) ? raw.storeys.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const row = item as RecordData;
      return typeof row.id === "string" ? [{ id: row.id, name: typeof row.name === "string" ? row.name : undefined, levelIndex: typeof row.levelIndex === "number" ? row.levelIndex : null,
        componentProperties: componentStates(properties.filter((property: RecordData) => property.entityType === "storey" && property.entityId === row.id)) }] : [];
    }) : [],
    buildings: Array.isArray(raw.buildings) ? raw.buildings.flatMap((item: unknown) => {
      const row = item && typeof item === "object" ? item as RecordData : null;
      return row && typeof row.id === "string" ? [{ id: row.id, name: asString(row.name), componentProperties: componentStates(properties.filter((property: RecordData) => property.entityType === "building" && property.entityId === row.id)) }] : [];
    }) : [],
    states: {
      existing: withPlanSourcePage(source.states?.existing ? regions(source.states.existing) : entityRowsForState("existing")),
      demolition: withPlanSourcePage(source.states?.demolition ? regions(source.states.demolition) : entityRowsForState("demolition")),
      proposed: withPlanSourcePage(source.states?.proposed ? regions(source.states.proposed) : entityRowsForState("proposed")),
    },
    updatedAt: asString(source.updatedAt) || undefined,
  };
}
