import { componentInputGaps } from "@richtfest/shared";
import { assessFireProtection } from "./fire-protection";
import { regionComponentType } from "./component-properties";
import { buildingInputSources } from "./input-sources";
import { candidateRole, type BuildingComponentPropertyState, type BuildingModel, type BuildingModelState, type BuildingRegion } from "./types";

export type CandidateReviewOutcome = "accepted_unchanged" | "accepted_corrected" | "reconciled" | "rejected" | "deferred";
export type CandidateReviewRecord = { outcome: CandidateReviewOutcome; note: string | null; createdAt: string };
/** Latest source-bound decisions, not accuracy labels or independent reference answers. */
export function candidateReviewRecords(model: BuildingModel, sourceVersionId: string | undefined) {
  const records = new Map<string, CandidateReviewRecord>();
  if (!sourceVersionId || model.supersededSources.some(source => source.sourceVersionId === sourceVersionId)) return records;
  const outcomes: string[] = ["accepted_unchanged", "accepted_corrected", "reconciled", "rejected", "deferred"];
  for (const proposal of [...model.proposals].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    const payload = proposal.payload;
    if (!proposal.proposalType?.startsWith("plan_") || payload?.reviewSnapshot?.sourceVersionId !== sourceVersionId
      || typeof payload.candidateId !== "string" || !outcomes.includes(payload.outcome)) continue;
    const id = `candidate:${payload.candidateId}`;
    if (!records.has(id)) records.set(id, { outcome: payload.outcome, note: typeof payload.note === "string" ? payload.note : null, createdAt: String(proposal.createdAt ?? "") });
  }
  return records;
}

export type ModelReviewNeed = {
  id: string;
  entityType: "building" | "storey" | "room" | "element";
  entityId: string;
  label: string;
  field: string;
  status: "missing" | "review";
  property?: BuildingComponentPropertyState;
  region?: BuildingRegion;
  finding?: "area_conflict" | "outline_missing" | "boundary_review" | "corrected_outline" | "outline_review";
  lastReview?: CandidateReviewRecord;
};

const fireField = (key: string) => key.startsWith("fire") || ["federalState", "stateBuildingCodeEdition", "loadBearing", "stairwellSmokeVent", "garageArea", "garageEnclosure"].includes(key);
const classificationFields: Record<string, string> = {
  state: "federalState", height: "fireHeight", detached: "fireDetached", dwellings: "fireDwellings", otherUnits: "fireOtherUnits",
  usableArea: "fireUsableArea", specialUse: "fireSpecialUse", garageArea: "garageArea", largestUnitArea: "fireLargestUnitArea", unitsGrossArea: "fireUnitsGrossArea",
};

/** A scoped review queue, not an assessment of completeness or a second task database. */
export function modelReviewNeeds(model: BuildingModel, sourceVersionId: string | undefined, state: BuildingModelState, discipline: "physics" | "fire"): ModelReviewNeed[] {
  if (!sourceVersionId || model.supersededSources.some(source => source.sourceVersionId === sourceVersionId)) return [];
  const regions = model.states[state].filter(region => !region.isCandidate && region.sourceVersionId === sourceVersionId && region.constructionState !== "demolished");
  const storeys = model.storeys.filter(storey => regions.some(region => region.storeyId === storey.id));
  const buildings = model.buildings.filter(building => storeys.some(storey => storey.buildingId === building.id));
  const needs = new Map<string, ModelReviewNeed>();
  type Target = Omit<ModelReviewNeed, "id" | "field" | "status" | "property">;
  function add(target: Target, field: string, properties: Record<string, BuildingComponentPropertyState> = {}) {
    // Use the existing UI input registry, not the server's full Zod property map.
    if (!buildingInputSources.some(group => group.fields.includes(field))) return;
    const property = properties[field];
    if (property?.reviewStatus === "approved" && property.value != null) return;
    const id = `${target.entityType}:${target.entityId}:${field}`;
    const missing = !property || property.value == null || ["rejected", "superseded"].includes(property.reviewStatus);
    needs.set(id, { ...target, id, field, property, status: missing ? "missing" : "review" });
  }
  function pending(target: Target, properties: Record<string, BuildingComponentPropertyState> = {}) {
    for (const key of Object.keys(properties)) {
      if ((discipline === "fire") === fireField(key)) add(target, key, properties);
    }
  }
  for (const building of buildings) {
    const target: Target = { entityType: "building", entityId: building.id, label: building.name };
    pending(target, building.componentProperties);
    if (discipline === "fire") {
      const buildingStoreys = storeys.filter(storey => storey.buildingId === building.id);
      const buildingRegions = regions.filter(region => buildingStoreys.some(storey => storey.id === region.storeyId));
      const assessment = assessFireProtection({ ...model, buildings: [building], storeys: buildingStoreys,
        states: { existing: buildingRegions, proposed: [], demolition: [] } });
      for (const gap of assessment.classification.gaps) {
        const field = classificationFields[gap];
        if (field) add(target, field, building.componentProperties);
      }
    }
  }
  for (const region of regions) {
    if (region.entityType !== "room" && region.entityType !== "element") continue;
    const target: Target = { entityType: region.entityType, entityId: region.id, label: region.label, region };
    const properties = region.componentProperties ?? {};
    pending(target, properties);
    if (discipline === "physics") {
      if (region.entityType === "element") {
        for (const gap of componentInputGaps(regionComponentType(region), properties)) add(target, gap.field, properties);
      }
      if (region.entityType === "room") {
        const storey = storeys.find(item => item.id === region.storeyId);
        // An inherited height is reviewed at its owner, not copied into every room.
        if (!properties.clearRoomHeight && storey?.componentProperties?.clearRoomHeight) {
          add({ entityType: "storey", entityId: storey.id, label: storey.name ?? storey.id }, "clearRoomHeight", storey.componentProperties);
        } else add(target, "clearRoomHeight", properties);
      }
    } else if (region.entityType === "room") {
      add(target, "fireRoomRole", properties);
    } else if (regionComponentType(region) === "window") {
      add(target, "fireRescueWindow", properties);
      if (properties.fireRescueWindow?.value === true && !["rejected", "superseded"].includes(properties.fireRescueWindow.reviewStatus)) {
        for (const key of ["fireRescueLocation", "fireRescueClearWidth", "fireRescueClearHeight", "fireRescueSillHeight", "fireRescueOpenableInside"]) add(target, key, properties);
      }
    }
  }
  for (const candidate of model.extractionCandidates) {
    if (candidate.status !== "unreviewed" || candidate.sourceVersionId !== sourceVersionId) continue;
    const role = candidateRole(candidate);
    if (role !== "room-region" && role !== "draft-wall" && role !== "unresolved-anchor") continue;
    const phase = candidate.constructionState;
    if (candidate.entityType !== "room" && phase && phase !== "unknown" && (state === "proposed" ? !["proposed", "retained"].includes(phase) : state === "demolition" ? !["demolished", "retained"].includes(phase) : ["proposed", "demolished"].includes(phase))) continue;
    const id = candidate.id;
    const finding = candidate.entityType !== "room" ? undefined : candidate.outlineEdit ? "corrected_outline" : candidate.areaComparison?.status === "conflict" ? "area_conflict"
      : !candidate.polygon?.length && candidate.entityType === "room" ? "outline_missing"
      : candidate.geometryQuality === "approximate_partition" || candidate.competingLabels?.length ? "boundary_review" : "outline_review";
    needs.set(id, { id, entityType: candidate.entityType === "element" ? "element" : "room", entityId: id, label: candidate.label, field: "outline", status: "review", region: candidate, finding });
  }
  const records = candidateReviewRecords(model, sourceVersionId);
  const priority = (need: ModelReviewNeed) => need.lastReview?.outcome === "deferred" ? 5
    : need.finding === "area_conflict" ? 0 : need.finding === "outline_missing" || need.finding === "boundary_review" ? 1
    : need.finding === "corrected_outline" ? 2 : 3;
  return [...needs.values()].map(need => ({ ...need, lastReview: records.get(need.id) }))
    .sort((a, b) => priority(a) - priority(b) || Number(b.status === "review") - Number(a.status === "review") || a.label.localeCompare(b.label) || a.field.localeCompare(b.field) || a.id.localeCompare(b.id));
}
