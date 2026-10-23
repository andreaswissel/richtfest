import { createHash } from "node:crypto";
import { z } from "zod";
import type { Point2 } from "@richtfest/shared";
import { assessFirePlan } from "@richtfest/shared/fire-plan";
import type { AppDeps } from "./deps";
import { assembleFireProtectionSnapshot } from "./fire-protection";
import { planWallAdjacency, roomSpaceContext } from "./wall-adjacency";
import { planOpenings } from "./plan-openings";
import { assembleInteriorSound, evaluateElement } from "./interior-sound-proof";
import { assembleExteriorNoiseProof, polygonArea } from "./exterior-noise-proof";

export const candidateCalculationRequest = z.object({
  sourceVersionId: z.string().uuid(), page: z.number().int().positive(), storeyId: z.string().uuid(),
}).strict();
type Model = Parameters<typeof assembleFireProtectionSnapshot>[0] & { extractionCandidates: any[] };
const fail = (message: string) => Object.assign(new Error(message), { status: 422, code: "candidate_preview_unavailable" });

/** A read-only page projection. No accepted entity, property, review or model revision is written. */
export function calculateCandidates(data: Model, rawScope: unknown, host: Pick<AppDeps, "interiorSound"> = {}) {
  const scope = candidateCalculationRequest.parse(rawScope);
  const source = data.planSources.find(s => s.sourceVersionId === scope.sourceVersionId && s.page === scope.page && s.storeyId === scope.storeyId);
  const storey = data.storeys.find(s => s.id === scope.storeyId && s.constructionState !== "demolished");
  if (!source || !storey) throw fail("Choose an active plan page and its storey in this project.");
  const job = data.extractions.filter(j => j.sourceVersionId === scope.sourceVersionId && j.page === scope.page && j.storeyId === scope.storeyId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  if (!job || job.status !== "complete") throw fail("The current page extraction must complete before previewing calculations.");
  const scale = job.result?.pageScale;
  if (!(Number.isFinite(scale?.metresPerPageHeight) && scale.metresPerPageHeight > 0 && Number.isFinite(scale?.pageAspectRatio) && scale.pageAspectRatio > 0))
    throw fail("The page has no usable metric scale. No default scale is assumed.");
  const fromPage = (row: any) => row.storeyId === storey.id && row.geometry?.source?.sourceVersionId === scope.sourceVersionId && row.geometry.source.page === scope.page;
  const rooms = structuredClone(data.rooms.filter(fromPage).filter(r => r.constructionState !== "demolished"));
  const elements = structuredClone(data.elements.filter(fromPage).filter(r => r.constructionState !== "demolished"));
  const properties = structuredClone(data.properties);
  const excluded: Array<{ id: string; reason: string }> = [];
  const used: Array<{ id: string; sourceKey: string; geometryQuality: string; evidence: unknown; roomUseProposal: unknown }> = [];
  const validRing = (ring: any) => Array.isArray(ring) && ring.length >= 3 && ring.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  for (const candidate of data.extractionCandidates.filter(c => c.jobId === job.id)) {
    const geometry = candidate.geometry;
    const targetId = candidate.targetEntityId ?? candidate.match?.existingId;
    const canonical = [...rooms, ...elements].some(row => row.id === targetId || row.stableKey === `extraction:${candidate.id}`);
    const eligible = candidate.entityType === "room" ? ["enclosed_region", "approximate_region", "manual_outline"].includes(geometry?.quality) : geometry?.quality === "draft_wall";
    const reason = candidate.status !== "unreviewed" ? candidate.status : canonical ? "canonical_entity_present"
      : !eligible ? "unresolved_geometry" : geometry?.constructionState === "demolished" ? "demolished"
      : !validRing(geometry?.polygon) || (geometry.holes ?? []).some((ring: any) => !validRing(ring)) ? "invalid_polygon" : null;
    if (reason) { excluded.push({ id: candidate.id, reason }); continue; }
    const row = { id: candidate.id, name: candidate.name, storeyId: storey.id, buildingId: storey.buildingId,
      stableKey: `extraction:${candidate.id}`, kind: "draft_wall", constructionState: geometry.constructionState ?? "unknown",
      geometry: { ...structuredClone(geometry), source: { sourceVersionId: scope.sourceVersionId, page: scope.page }, evidence: candidate.evidence } };
    (candidate.entityType === "room" ? rooms : elements).push(row);
    used.push({ id: candidate.id, sourceKey: candidate.sourceKey, geometryQuality: geometry.quality, evidence: candidate.evidence,
      roomUseProposal: geometry.roomUseProposal ?? null });
  }
  const property = (id: string, key: string): any => {
    if (data.conflicts.some(c => c.entityId === id && c.propertyKey === key)) return null;
    const p = properties.find(p => p.entityId === id && p.propertyKey === key);
    return p?.reviewed?.reviewStatus === "approved" ? p.reviewed
      : p?.current && !["rejected", "superseded"].includes(p.current.reviewStatus) ? p.current : null;
  };
  const get = (id: string, key: string) => property(id, key)?.value ?? null;
  const propose = (entityType: string, entityId: string, propertyKey: string, value: unknown, quote: string) => {
    // Even rejected and conflicted properties fence automatic re-proposals.
    if (value == null || properties.some(p => p.entityId === entityId && p.propertyKey === propertyKey)
      || data.conflicts.some(c => c.entityId === entityId && c.propertyKey === propertyKey)) return;
    properties.push({ entityType, entityId, propertyKey, reviewed: null, current: { version: 0, value,
      reviewStatus: "unreviewed", provenance: "inferred", evidence: [{ kind: "page", sourceVersionId: scope.sourceVersionId, page: scope.page, quote }] } });
  };
  for (const room of rooms) {
    const context = roomSpaceContext({ name: room.name, groupLabel: room.geometry?.groupLabel },
      { apartmentUnit: get(room.id, "apartmentUnit"), spaceType: get(room.id, "spaceType") });
    propose("room", room.id, "apartmentUnit", context.apartmentUnit, room.geometry?.groupLabel ?? room.name);
    propose("room", room.id, "spaceType", context.spaceType, room.name);
    // A use proposal is not enough to establish necessary corridors/stairs or a fire role.
    const use = room.geometry?.roomUseProposal?.roomUse;
    const acousticUse = use === "bedroom" || use === "child_room" ? "sleeping" : use === "living_dining_kitchen" ? "living" : use === "office" ? "office" : null;
    propose("room", room.id, "exteriorNoiseRoom", acousticUse, room.name);
    if (acousticUse) propose("room", room.id, "roomUse", acousticUse, room.name);
  }
  // Unresolved outlines are not calculation rooms, but still obstruct an exterior-face inference.
  const obstacles = data.extractionCandidates.filter(c => c.jobId === job.id && c.entityType === "room"
    && c.status === "unreviewed" && validRing(c.geometry?.polygon)).map(c => ({ id: c.id, name: c.name,
    geometry: { ...c.geometry, source: { sourceVersionId: scope.sourceVersionId, page: scope.page } } }));
  const walls = planWallAdjacency({ rooms, elements, properties, candidateRooms: obstacles,
    scales: new Map([[`${scope.sourceVersionId}:${scope.page}`, scale]]) });
  const scopedIds = new Set([...rooms, ...elements].map(row => row.id));
  const relationships = structuredClone(data.relationships.filter(r => scopedIds.has(r.fromEntityId) && (scopedIds.has(r.toEntityId) || r.toEntityId === storey.id)));
  const link = (fromEntityId: string, toEntityId: string, relationshipType: string, side?: number) => {
    // Reviewed/rejected links are authoritative even in previews; never resurrect them.
    if (relationships.some(r => r.fromEntityId === fromEntityId && r.toEntityId === toEntityId && r.relationshipType === relationshipType && r.metadata?.side === side)) return;
    relationships.push({ fromEntityId, toEntityId, relationshipType, reviewStatus: "unreviewed",
      metadata: { side, sourceVersionId: scope.sourceVersionId, page: scope.page, method: "candidate_preview" } });
  };
  for (const wall of walls) {
    propose("element", wall.wallId, "wallRole", wall.role, "Inferred from source-labelled spaces on both wall sides.");
    propose("element", wall.wallId, "thickness", wall.thicknessCm, "Measured across the extracted polygon at the page scale; not a construction specification.");
    wall.sides.forEach((side, index) => {
      if (side === "exterior") link(wall.wallId, storey.id, "faces_exterior", index);
      else for (const room of side ?? []) link(wall.wallId, room.roomId, "separates", index);
    });
  }
  const active = () => relationships.filter(r => !["rejected", "superseded"].includes(r.reviewStatus));
  const sourceKeys = new Map(data.extractionCandidates.filter(c => c.jobId === job.id).map(c => [c.id, c.sourceKey]));
  const openings = planOpenings({ pages: [{ ...scope, pageAspectRatio: scale.pageAspectRatio, openings: job.result?.topologyCoverage?.openingEvidence ?? [] }],
    walls: walls.map(w => ({ id: w.wallId, ...scope, footprintKeys: elements.find(e => e.id === w.wallId)?.geometry?.sourceFootprintKeys ?? [],
      polygon: elements.find(e => e.id === w.wallId)?.geometry?.polygon,
      exterior: active().some(r => r.fromEntityId === w.wallId && r.relationshipType === "faces_exterior"),
      roomIds: active().filter(r => r.fromEntityId === w.wallId && r.relationshipType === "separates").map(r => r.toEntityId) })),
    rooms: rooms.map(r => ({ id: r.id, ...scope, polygon: r.geometry?.polygon ?? null, holes: r.geometry?.holes,
      boundaryResolved: r.geometry?.quality !== "approximate_partition", exterior: get(r.id, "spaceType") === "exterior",
      candidateKey: sourceKeys.get(r.stableKey?.slice(11)) ?? null })),
    existing: elements.filter(e => ["door", "window"].includes(e.kind)).map(e => ({ id: e.id, kind: e.kind,
      wallId: active().find(r => r.fromEntityId === e.id && r.relationshipType === "opening_in")?.toEntityId ?? null,
      planKey: e.geometry?.planOpeningKey ?? null })),
  });
  for (const opening of openings.planned) {
    if (opening.action !== "create") continue;
    const id = `opening-${createHash("sha256").update(opening.planKey).digest("hex").slice(0, 24)}`;
    const { x, y, width, height } = opening.closure;
    elements.push({ id, storeyId: storey.id, name: opening.kind, kind: opening.kind, roomId: opening.roomId,
      geometry: { source: { sourceVersionId: scope.sourceVersionId, page: scope.page }, planOpeningKey: opening.planKey,
        polygon: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] } });
    link(id, opening.wallId, "opening_in");
    propose("element", id, "openingWidth", opening.widthM, "Width measured from the traced opening; height remains unknown.");
  }
  const projected = { ...data, buildings: data.buildings.filter(b => b.id === storey.buildingId),
    rooms, elements, relationships, properties, planSources: [source], extractions: [job] };
  // Retain all building storeys for classification counts, but only this page's geometry is in scope.
  const fireSnapshot = assembleFireProtectionSnapshot(projected, "candidate_preview");
  const fire = fireSnapshot.available ? assessFirePlan({ ...fireSnapshot.plan,
    storeys: fireSnapshot.plan.storeys.filter(s => s.id === storey.id) }, "candidate_preview") : null;
  const metres = (ring: any[]): Point2[] => ring.map(p => [p.x * scale.pageAspectRatio * scale.metresPerPageHeight, p.y * scale.metresPerPageHeight]);
  const roomGeometry = rooms.map(r => ({ id: r.id, name: r.name, polygon: validRing(r.geometry?.polygon) ? metres(r.geometry.polygon) : null,
    holes: (r.geometry?.holes ?? []).map(metres), adjacentWallIds: new Set<string>(active().filter(a => a.relationshipType === "separates" && a.toEntityId === r.id).map(a => a.fromEntityId)),
    ceilingIds: active().filter(a => a.relationshipType === "covers" && a.toEntityId === r.id).map(a => a.fromEntityId),
    spaceType: get(r.id, "spaceType"), apartmentUnit: get(r.id, "apartmentUnit"), use: get(r.id, "exteriorNoiseRoom"),
    clearHeight: get(r.id, "clearRoomHeight") ?? get(storey.id, "clearRoomHeight") }));
  const wallGeometry = elements.filter(e => walls.some(w => w.wallId === e.id) && validRing(e.geometry?.polygon)).map(e => ({
    id: e.id, name: e.name, ring: metres(e.geometry.polygon), role: get(e.id, "wallRole"),
    exterior: active().some(r => r.fromEntityId === e.id && r.relationshipType === "faces_exterior") }));
  const elementValues = new Map(elements.map(e => [e.id, evaluateElement(e.id, e.name, e.kind === "ceiling" ? "ceiling" : "wall", {
    construction: get(e.id, "construction"), material: get(e.id, "material"), thickness: get(e.id, "thickness"),
    bulkDensity: get(e.id, "bulkDensity"), flankingLevelDifference: get(e.id, "flankingLevelDifference"),
  }, host.interiorSound ? { massiveRw: host.interiorSound.massiveRw, lightweightRow: host.interiorSound.lightweightRow } : null)]));
  const requirementLevel = get(storey.buildingId, "soundInsulationLevel") === "elevated" ? "elevated" : "statutory_minimum";
  const requirements = host.interiorSound?.requirements(requirementLevel);
  const interior = host.interiorSound && requirements ? assembleInteriorSound({ storeyId: storey.id,
    clearHeight: get(storey.id, "clearRoomHeight"), rooms: roomGeometry, walls: wallGeometry, ceilings: [], floorId: null, elements: elementValues,
    wallRequirement: requirements.wall, ceilingRequirement: requirements.ceiling,
    airborne: host.interiorSound.airborne, impact: host.interiorSound.impact,
  }) : null;
  const exterior = assembleExteriorNoiseProof({ sourceLabel: "Unreviewed candidate preview", storeyId: storey.id,
    source: { versionId: scope.sourceVersionId, page: scope.page }, applicability: null, flanking: null, clearHeight: null,
    rooms: roomGeometry.map(r => ({ ...r, clearHeight: null, roomUse: r.use, kind: property(r.id, "exteriorNoiseRoom"), surfacesComplete: null })),
    walls: wallGeometry.filter(w => w.exterior).map(w => ({ ...w, construction: get(w.id, "construction"), rw: null, rwBasis: null })),
    levels: new Map(), openings: [],
  });
  return { version: 1, mode: "candidate_preview", reviewStatus: "unreviewed", modelId: data.model.id, modelRevision: data.model.revision,
    scope, extraction: { id: job.id, version: job.extractorVersion, updatedAt: job.updatedAt },
    inputHash: createHash("sha256").update(JSON.stringify({ scope, job, rooms, elements, relationships, properties, conflicts: data.conflicts, buildings: projected.buildings, storeys: data.storeys })).digest("hex"),
    candidates: used, excluded, scale, relationships,
    geometry: roomGeometry.map(r => ({ id: r.id, name: r.name, areaM2: r.polygon ? polygonArea(r.polygon) - r.holes.reduce((sum: number, hole: Point2[]) => sum + polygonArea(hole), 0) : null,
      adjacentWallIds: [...r.adjacentWallIds], clearHeight: r.clearHeight })),
    properties: properties.filter(p => scopedIds.has(p.entityId) || p.entityId === storey.id || p.entityId === storey.buildingId), openings: openings.summary,
    fire: { snapshot: fireSnapshot, assessment: fire },
    interior: interior ? { ...interior, requirementLevel, usedElementIds: [...interior.usedElementIds] } : { unavailable: "acoustic_method_missing" }, exterior,
    limitations: ["Read-only, unreviewed page scope. No geometry, property or relationship is approved by this result.",
      "Missing and rejected values stay missing; no default height, material, density, acoustic rating or fire resistance is supplied.",
      "Whole-building inventory, cross-storey flanking/slabs, complete envelope and site-specific exterior noise are not established by this preview.",
      "Exterior preview reports geometry and gaps only; facade noise, openings and construction specifications need a complete calculation input.",
      "Plan-derived connections and room-use/unit proposals require source review; no automatic admission is based on area agreement alone."],
  };
}
