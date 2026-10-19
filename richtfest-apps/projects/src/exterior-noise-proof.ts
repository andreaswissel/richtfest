import { Router, type Request } from "express";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  buildingComponentProperties, buildingEvidenceSchema, doorRoleSchema, exteriorNoiseCalculationUse, exteriorNoiseSuggestionInput, exteriorNoiseInputKeys, exteriorNoiseLaPeriod, exteriorNoiseRoomKinds, ok, validateBuildingComponentProperty, proposeExteriorNoiseRoom, segmentDistance,
  type AcousticCalculationInput, type Compass, type ExteriorNoiseProof, type ExteriorNoiseRoomKind, type Point2,
  type ProofFacade, type ProofGap, type ProofRoom, type SitePlanPage, type ProofSuggestion, type ProofValue, type ProofWindow,
} from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { appendPropertyVersion, evidenceVersionsForProject, modelForProject, modelTransaction, readSitePlan, touchRevision } from "./building-model-router";
import { readFacadeNoiseLevels, storeyLevels } from "./exterior-noise-levels";
import {
  buildingBuildings, buildingElements, buildingModels, buildingProperties, fileVersions, files, buildingPropertyVersions, buildingRelationships, buildingRevisions, buildingRooms, buildingStoreys,
} from "./schema";

/**
 * Exterior noise verification inputs from the building model: the protected
 * rooms of the placed plan, their exterior facades with La from the facade
 * levels, and the facade elements a person enters (wall Rw, windows and doors).
 * Rooms with every input form the exterior_noise_batch calculation input.
 */

// ---- Geometry (plan metres) -------------------------------------------------

export const polygonArea = (ring: Point2[]) => Math.abs(ring.reduce((sum, a, i) => {
  const b = ring[(i + 1) % ring.length]!;
  return sum + a[0] * b[1] - b[0] * a[1];
}, 0)) / 2;

export const inside = (p: Point2, ring: Point2[]) => {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
};
export const distanceToRing = (p: Point2, ring: Point2[]) => inside(p, ring) ? 0
  : Math.min(...ring.map((a, i) => segmentDistance(p, a, ring[(i + 1) % ring.length]!).distance));

/** How far a room extends along a wall: the overlap of both outlines projected on the wall's long axis. */
export function overlapAlongWall(room: Point2[], wall: Point2[]): number {
  let axis: Point2 = [1, 0], longest = 0;
  wall.forEach((a, i) => { const b = wall[(i + 1) % wall.length]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > longest) { longest = length; axis = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]; } });
  const project = (ring: Point2[]) => { const values = ring.map(p => p[0] * axis[0] + p[1] * axis[1]); return [Math.min(...values), Math.max(...values)] as const; };
  const [w0, w1] = project(wall), [r0, r1] = project(room);
  return Math.max(0, Math.min(w1, r1) - Math.max(w0, r0));
}

/**
 * Exterior wall length per wall that a room faces. With the model's room/wall
 * adjacency, the room's extent along each adjacent wall; without it, room edges
 * whose midpoint lies on or within `toleranceM` of a wall.
 */
export function facadeLengths(room: Point2[], walls: Array<{ id: string; ring: Point2[] }>, adjacent: Set<string> | null = null, toleranceM = 0.3): Map<string, number> {
  const lengths = new Map<string, number>();
  if (adjacent) {
    for (const wall of walls) if (adjacent.has(wall.id)) lengths.set(wall.id, overlapAlongWall(room, wall.ring));
    return lengths;
  }
  room.forEach((a, i) => {
    const b = room[(i + 1) % room.length]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 0.05) return;
    const mid: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let best: { id: string; distance: number } | null = null;
    for (const wall of walls) {
      const distance = distanceToRing(mid, wall.ring);
      if (distance <= toleranceM && (!best || distance < best.distance)) best = { id: wall.id, distance };
    }
    if (best) lengths.set(best.id, (lengths.get(best.id) ?? 0) + length);
  });
  return lengths;
}

// ---- Assembly (pure) ---------------------------------------------------------

const round2 = (value: number) => Math.round(value * 100) / 100;
const constructionOf = (value: unknown): ProofFacade["construction"] =>
  value === "masonry" || value === "concrete" ? "massive" : value === "drywall" || value === "timber" || value === "steel" ? "lightweight" : "unknown";

export type ProofAssemblyInput = {
  sourceLabel: string;
  storeyId: string;
  /** Prepended to room labels when several storeys are verified together, e.g. "EG · ". */
  labelPrefix?: string;
  /** The plan page the rooms and walls were traced from; their geometry cites it. */
  source: { versionId: string; page: number } | null;
  applicability: ProofValue<string> | null; flanking: ProofValue<string> | null; clearHeight: ProofValue<number> | null;
  rooms: Array<{ id: string; name: string; roomUse: string | null; polygon: Point2[] | null; holes: Point2[][]; adjacentWallIds: Set<string> | null;
    kind: ProofValue<string> | null; surfacesComplete: ProofValue<boolean> | null }>;
  walls: Array<{ id: string; name: string; ring: Point2[]; construction: unknown; rw: ProofValue<number> | null; rwBasis: ProofValue<string> | null }>;
  levels: Map<string, { compass: Compass; dayDb: number; sleepingDb: number; basis: "calculated" | "turned_away" }>;
  openings: Array<{ id: string; name: string; componentType: "window" | "door"; roomId: string; wallId: string | null;
    area: ProofValue<number> | null; rw: ProofValue<number> | null; basis: ProofValue<string> | null }>;
};
type BatchInput = Extract<AcousticCalculationInput, { method: "exterior_noise_batch" }>;
type RoomInput = BatchInput["rooms"][number];

const reviewed = (value: { reviewStatus: string } | null) => value?.reviewStatus === "approved" ? "geprüft" : "ungeprüft";
const kindLabels: Record<ExteriorNoiseRoomKind, string> = { sleeping: "Schlafraum", living: "Wohnraum", office: "Büro / Praxis", hospital_bedroom: "Bettenraum", not_protected: "nicht schutzbedürftig" };

export function assembleExteriorNoiseProof(input: ProofAssemblyInput): { rooms: ProofRoom[]; batch: BatchInput | null } {
  const assumption = (reason: string) => ({ kind: "assumption" as const, reason: reason.slice(0, 1000) });
  // Geometry measured on the plan cites the plan page; the excerpt says what was read there.
  const fromPlan = (what: string) => input.source
    ? { kind: "source" as const, versionId: input.source.versionId, page: input.source.page, excerpt: what.slice(0, 1000) }
    : assumption(`${what} (${input.sourceLabel})`);
  const labels = new Map<string, number>();
  const rooms: ProofRoom[] = [];
  const packets: RoomInput[] = [];
  const inventory: BatchInput["inventory"] = [];
  for (const room of input.rooms) {
    const count = (labels.get(room.name) ?? 0) + 1; labels.set(room.name, count);
    const label = `${input.labelPrefix ?? ""}${count > 1 ? `${room.name} (${count})` : room.name}`;
    const kind = room.kind && (exteriorNoiseRoomKinds as readonly string[]).includes(room.kind.value) ? room.kind.value as ExteriorNoiseRoomKind : null;
    const floorAreaM2 = room.polygon && room.polygon.length >= 3
      ? round2(Math.max(0, polygonArea(room.polygon) - room.holes.reduce((sum, hole) => sum + polygonArea(hole), 0))) : null;
    const lengths = room.polygon ? facadeLengths(room.polygon, input.walls, room.adjacentWallIds) : new Map<string, number>();
    const height = input.clearHeight?.value ?? null;
    const facades: ProofFacade[] = input.walls.filter(wall => (lengths.get(wall.id) ?? 0) >= 0.1).map(wall => {
      const lengthM = round2(lengths.get(wall.id)!);
      const areaM2 = height === null ? null : round2(lengthM * height);
      const windows: ProofWindow[] = input.openings.filter(opening => opening.roomId === room.id && opening.wallId === wall.id)
        .map(({ id, name, componentType, area, rw, basis }) => ({ id, name, componentType, area, rw, basis }));
      const openingArea = windows.reduce((sum, item) => sum + (item.area?.value ?? 0), 0);
      const level = input.levels.get(wall.id);
      return { wallId: wall.id, wallName: wall.name, compass: level?.compass ?? null, lengthM, areaM2,
        la: level ? { dayDb: level.dayDb, sleepingDb: level.sleepingDb, basis: level.basis } : null,
        construction: constructionOf(wall.construction), rw: wall.rw, rwBasis: wall.rwBasis, windows,
        opaqueAreaM2: areaM2 === null ? null : round2(areaM2 - openingArea) };
    });
    const gaps = new Set<ProofGap>();
    if (!kind) gaps.add("room_kind");
    const protectedRoom = kind !== null && kind !== "not_protected";
    if (protectedRoom) {
      if (floorAreaM2 === null || floorAreaM2 <= 0) gaps.add("floor_area");
      if (!facades.length) gaps.add("no_facade");
      if (height === null) gaps.add("clear_height");
      for (const facade of facades) {
        if (!facade.la) gaps.add("facade_level");
        if (!facade.rw) gaps.add("wall_rw");
        if (facade.construction === "unknown") gaps.add("wall_construction");
        for (const item of facade.windows) { if (!item.area) gaps.add("window_area"); if (!item.rw) gaps.add("window_rw"); }
        if (facade.opaqueAreaM2 !== null && facade.opaqueAreaM2 < 0) gaps.add("openings_exceed_facade");
      }
      if (room.surfacesComplete?.value !== true) gaps.add("surfaces_unconfirmed");
      if (input.applicability?.value !== "standard_exterior_noise") gaps.add("applicability");
      if (input.flanking?.value !== "negligible") gaps.add("flanking");
      inventory.push({ roomId: label, provenance: fromPlan(`Raum „${room.name}“, aus dem Plan in das Richtfest-Gebäudemodell übernommen.`) });
    }
    rooms.push({ id: room.id, storeyId: input.storeyId, name: room.name, label, roomUse: room.roomUse, kind: room.kind, proposedKind: proposeExteriorNoiseRoom(room.name, room.roomUse),
      floorAreaM2, surfacesComplete: room.surfacesComplete, facades, gaps: [...gaps], result: null });
    if (!protectedRoom || gaps.size) continue;
    const period = exteriorNoiseLaPeriod(kind!);
    const facadeLabel = (facade: ProofFacade) => `${facade.compass ? `${facade.compass} · ` : ""}${facade.wallName}`;
    packets.push({
      standard: "DIN 4109-1/-2:2018-01",
      room: { id: label, use: exteriorNoiseCalculationUse(kind!), floorAreaM2: floorAreaM2!,
        provenance: fromPlan(`Grundfläche ${floorAreaM2} m² aus dem Umriss von Raum „${room.name}“ im Planmaßstab gemessen; Nutzung ${kindLabels[kind!]} (${reviewed(room.kind)}).`) },
      applicability: { assessment: "standard_exterior_noise", basis: "Regelverfahren Außenlärm in Richtfest bestätigt.",
        provenance: assumption(`Anwendbarkeit im Richtfest-Gebäudemodell eingetragen (${reviewed(input.applicability)}).`) },
      envelopeComplete: true,
      facades: facades.map(facade => ({
        id: facadeLabel(facade), areaM2: facade.areaM2!,
        provenance: fromPlan(`Fassadenlänge ${facade.lengthM} m von Raum „${room.name}“ entlang ${facade.wallName}, im Planmaßstab gemessen; × lichte Raumhöhe ${height} m (${reviewed(input.clearHeight)}).`),
        // La to 0.1 dB, as stated in the report; the facade levels keep the unrounded values.
        noise: { metric: "La" as const, levelDb: Math.round((period === "sleeping" ? facade.la!.sleepingDb : facade.la!.dayDb) * 10) / 10,
          basis: `La ${period === "sleeping" ? "für Schlafräume" : "Tag"} dieser Fassade aus den Richtfest-Fassadenpegeln (${facade.la!.basis === "turned_away" ? "abgewandte Fassade" : "berechnet"}).`,
          provenance: assumption("Berechneter Fassadenpegel: Straßen-Beurteilungspegel nach RLS-19, La nach DIN 4109-2; Entwurf, Eingaben und Grenzen siehe Anlage Außenlärmpegel.") },
      })),
      elementsComplete: true,
      flanking: { assessment: "negligible", provenance: assumption(`Flankenübertragung als vernachlässigbar eingetragen (${reviewed(input.flanking)}).`) },
      elements: facades.flatMap(facade => [
        ...(facade.opaqueAreaM2! > 0 ? [{ kind: "area" as const, id: `${facadeLabel(facade)} · Wand`, facadeId: facadeLabel(facade), areaM2: facade.opaqueAreaM2!,
          rwDb: facade.rw!.value, construction: facade.construction, ratingBasis: "installed_configuration" as const,
          configuration: facade.rwBasis?.value ?? "Rw der Wand laut Gebäudemodell.",
          provenance: assumption(`Rw der Wand eingegeben (${reviewed(facade.rw)}); Fläche = Fassadenfläche abzüglich Öffnungen.`) }] : []),
        ...facade.windows.map(item => ({ kind: "area" as const, id: `${facadeLabel(facade)} · ${item.name}`, facadeId: facadeLabel(facade), areaM2: item.area!.value,
          rwDb: item.rw!.value, construction: "window_or_door" as const, ratingBasis: "installed_configuration" as const,
          configuration: item.basis?.value ?? "Rw im Einbauzustand laut Gebäudemodell.",
          provenance: assumption(`${item.componentType === "door" ? "Tür" : "Fenster"}: Fläche und Rw im Einbauzustand eingegeben (${reviewed(item.rw)}).`) })),
      ]),
    });
  }
  return { rooms, batch: inventory.length ? { method: "exterior_noise_batch", scope: `Außenlärm, ${input.sourceLabel}`, inventory, rooms: packets } : null };
}

// ---- Reading -----------------------------------------------------------------

const proofKeys = [...exteriorNoiseInputKeys, "componentType"];

export type CurrentValue = ProofValue<any> & { unit: string | null; evidence: unknown };
export async function currentValues(d: AppDeps, modelId: string, entityIds: string[], keys: readonly string[] = proofKeys) {
  const values = new Map<string, CurrentValue>();
  if (!entityIds.length) return values;
  const properties = await d.db.select({ id: buildingProperties.id, entityId: buildingProperties.entityId, key: buildingProperties.propertyKey }).from(buildingProperties)
    .where(and(eq(buildingProperties.modelId, modelId), eq(buildingProperties.tenantId, d.tenantId), inArray(buildingProperties.entityId, entityIds), inArray(buildingProperties.propertyKey, [...keys])));
  if (!properties.length) return values;
  const versions = await d.db.select().from(buildingPropertyVersions)
    .where(and(eq(buildingPropertyVersions.tenantId, d.tenantId), inArray(buildingPropertyVersions.propertyId, (properties as any[]).map(row => row.id))))
    .orderBy(desc(buildingPropertyVersions.version));
  const byProperty = new Map((properties as any[]).map(row => [row.id, row]));
  for (const version of versions as any[]) {
    const property = byProperty.get(version.propertyId);
    const key = `${property.entityId}:${property.key}`;
    // The latest version that is not rejected; a rejected latest falls back to the one before.
    if (values.has(key) || version.reviewStatus === "rejected" || version.value === null) continue;
    values.set(key, { value: version.value, reviewStatus: version.reviewStatus, provenance: version.provenance, propertyId: property.id, version: version.version,
      reviewRevision: version.reviewRevision ?? 0, unit: version.unit ?? null, evidence: version.evidence });
  }
  return values;
}

export async function readExteriorNoiseProof(d: AppDeps, projectId: string): Promise<ExteriorNoiseProof> {
  const levels = await readFacadeNoiseLevels(d, projectId);
  if (!levels.available) return levels;
  const modelRow = await modelForProject(d, projectId);
  if (!modelRow) return { available: false, reason: "model_missing" };
  const modelId = modelRow.model.id;
  const sitePlan = await readSitePlan(d, projectId);
  // The placed page and every page aligned to it, ground floor first: one storey each.
  const pages = levels.pages.flatMap(entry => sitePlan.pages.filter(item => item.sourceVersionId === entry.sourceVersionId && item.page === entry.page));
  if (!pages.length) return { available: false, reason: "placement_missing" };

  const allRooms = (await d.db.select().from(buildingRooms).where(and(eq(buildingRooms.modelId, modelId), eq(buildingRooms.tenantId, d.tenantId))) as any[])
    .filter(room => room.constructionState !== "demolished");
  const storeyRows = await d.db.select().from(buildingStoreys).where(and(eq(buildingStoreys.modelId, modelId), eq(buildingStoreys.tenantId, d.tenantId))) as any[];
  const plans: Array<{ page: SitePlanPage; storey: any; rooms: any[] }> = [];
  for (const page of pages) {
    const rooms = allRooms.filter(room => room.geometry?.source?.sourceVersionId === page.sourceVersionId && room.geometry?.source?.page === page.page);
    const storey = storeyRows.find(row => row.id === (page.storey?.id ?? rooms[0]?.storeyId));
    if (storey && !plans.some(plan => plan.storey.id === storey.id)) plans.push({ page, storey, rooms });
  }
  if (!plans.length) return { available: false, reason: "model_missing" };
  const levelOf = await storeyLevels(d, modelId, plans.map(plan => plan.storey));
  for (const plan of plans) plan.storey = { ...plan.storey, levelIndex: levelOf.get(plan.storey.id) ?? null };
  // Ground floor first, then upwards; storeys without a level last.
  plans.sort((a, b) => (a.storey.levelIndex ?? 1e6) - (b.storey.levelIndex ?? 1e6));
  const buildingId: string = plans[0]!.storey.buildingId;
  const roomRows = plans.flatMap(plan => plan.rooms);
  const roomIds = roomRows.map(room => room.id);
  const exterior = plans.flatMap(plan => plan.page.walls.filter(wall => wall.exterior));
  const openingRows = roomIds.length ? await d.db.select().from(buildingElements)
    .where(and(eq(buildingElements.modelId, modelId), eq(buildingElements.tenantId, d.tenantId), inArray(buildingElements.roomId, roomIds), inArray(buildingElements.kind, ["window", "door"]))) as any[] : [];
  const hosts = openingRows.length ? await d.db.select({ from: buildingRelationships.fromEntityId, to: buildingRelationships.toEntityId }).from(buildingRelationships)
    .where(and(eq(buildingRelationships.modelId, modelId), eq(buildingRelationships.tenantId, d.tenantId), eq(buildingRelationships.relationshipType, "opening_in"),
      inArray(buildingRelationships.fromEntityId, openingRows.map(row => row.id)))) as any[] : [];
  const hostOf = new Map(hosts.map(row => [row.from, row.to]));
  // Derived room/wall adjacency (wall separates room); rooms without any use the geometric fallback.
  const separates = roomIds.length ? await d.db.select({ wallId: buildingRelationships.fromEntityId, roomId: buildingRelationships.toEntityId }).from(buildingRelationships)
    .where(and(eq(buildingRelationships.modelId, modelId), eq(buildingRelationships.tenantId, d.tenantId), eq(buildingRelationships.relationshipType, "separates"),
      inArray(buildingRelationships.toEntityId, roomIds))) as any[] : [];
  const adjacentOf = new Map<string, Set<string>>();
  for (const row of separates) adjacentOf.set(row.roomId, (adjacentOf.get(row.roomId) ?? new Set()).add(row.wallId));
  const values = await currentValues(d, modelId, [buildingId, ...plans.map(plan => plan.storey.id), ...roomIds, ...exterior.map(wall => wall.id), ...openingRows.map(row => row.id)]);
  const value = <T,>(entityId: string, key: string) => {
    const found = values.get(`${entityId}:${key}`);
    return found ? { value: found.value, reviewStatus: found.reviewStatus, provenance: found.provenance, propertyId: found.propertyId, version: found.version, reviewRevision: found.reviewRevision } as ProofValue<T> : null;
  };

  const rooms: ProofRoom[] = [];
  const batches: BatchInput[] = [];
  for (const { page, storey, rooms: storeyRooms } of plans) {
    const toMetres = (point: { x: unknown; y: unknown }): Point2 => [Number(point.x) * page.scale.pageAspectRatio * page.scale.metresPerPageHeight, Number(point.y) * page.scale.metresPerPageHeight];
    const facadeLevel = new Map<string, { compass: Compass; dayDb: number; sleepingDb: number; basis: "calculated" | "turned_away" }>();
    for (const facade of levels.facades) {
      const sameStorey = facade.storey.id === storey.id || (facade.storey.id === null && (storey.levelIndex ?? 0) === facade.storey.levelIndex);
      if (!sameStorey || !facade.level || facade.basis === "none") continue;
      facadeLevel.set(facade.wallId, { compass: facade.compass as Compass, dayDb: facade.level.dayDb, sleepingDb: facade.level.sleepingDb, basis: facade.basis });
    }
    const assembled = assembleExteriorNoiseProof({
      sourceLabel: `${page.fileName ?? "plan"}, p. ${page.page}`, source: { versionId: page.sourceVersionId, page: page.page },
      storeyId: storey.id, labelPrefix: plans.length > 1 ? `${storey.name} · ` : "",
      applicability: value(buildingId, "exteriorNoiseApplicability"), flanking: value(buildingId, "exteriorNoiseFlanking"), clearHeight: value(storey.id, "clearRoomHeight"),
      rooms: storeyRooms.map(room => ({ id: room.id, name: room.name, roomUse: room.roomUse,
        polygon: Array.isArray(room.geometry?.polygon) ? room.geometry.polygon.map(toMetres) : null,
        adjacentWallIds: adjacentOf.get(room.id) ?? null,
        holes: Array.isArray(room.geometry?.holes) ? room.geometry.holes.filter(Array.isArray).map((hole: any[]) => hole.map(toMetres)) : [],
        kind: value(room.id, "exteriorNoiseRoom"), surfacesComplete: value(room.id, "exteriorSurfacesComplete") })),
      walls: page.walls.filter(wall => wall.exterior).map(wall => ({ id: wall.id, name: wall.name, ring: wall.ring, construction: value(wall.id, "construction")?.value ?? null,
        rw: value(wall.id, "soundReductionIndex"), rwBasis: value(wall.id, "soundReductionIndexBasis") })),
      levels: facadeLevel,
      openings: openingRows.filter(row => storeyRooms.some(room => room.id === row.roomId)).map(row => ({ id: row.id, name: row.name, componentType: row.kind === "door" ? "door" : "window", roomId: row.roomId, wallId: hostOf.get(row.id) ?? null,
        area: value(row.id, "openingArea"), rw: value(row.id, "soundReductionIndex"), basis: value(row.id, "soundReductionIndexBasis") })),
    });
    rooms.push(...assembled.rooms);
    if (assembled.batch) batches.push(assembled.batch);
  }
  // One batch over every storey: one inventory, one calculation, one Nachweis.
  const batch: BatchInput | null = batches.length ? { method: "exterior_noise_batch", scope: `Außenlärm, ${batches.map(item => item.scope.replace(/^Außenlärm, /, "")).join("; ")}`,
    inventory: batches.flatMap(item => item.inventory), rooms: batches.flatMap(item => item.rooms) } : null;
  let calculation: Extract<ExteriorNoiseProof, { available: true }>["calculation"] = null;
  if (batch && d.calculateAcoustics) {
    const result = d.calculateAcoustics(batch);
    calculation = { input: batch, result };
    for (const item of result.batch?.rooms ?? []) {
      const room = rooms.find(entry => entry.label === item.roomId);
      if (!room) continue;
      const outcome = item.result?.exteriorNoise;
      // As in the Nachweis: the requirement without, and the provided value less, the prognosis allowance.
      const allowance = outcome?.prognosisUncertaintyDb ?? 0;
      room.result = { status: item.status, targetDb: outcome ? outcome.targetRwDb - allowance : null,
        valueDb: item.result?.value != null ? item.result.value - allowance : null, marginDb: outcome?.marginDb ?? null,
        reason: item.status === "unsupported" ? item.result?.limitations[0] ?? null : null };
    }
  }
  type Entity = [ProofSuggestion["entityType"], string, string];
  const prefix = (plan: (typeof plans)[number] | undefined) => plans.length > 1 && plan ? `${plan.storey.name} · ` : "";
  const entities: Entity[] = [["building", buildingId, ""], ...plans.map(plan => ["storey", plan.storey.id, plan.storey.name] as Entity),
    ...rooms.map(room => ["room", room.id, room.label] as Entity),
    ...plans.flatMap(plan => plan.page.walls.filter(wall => wall.exterior).map(wall => ["element", wall.id, `${prefix(plan)}${wall.name}`] as Entity)),
    ...openingRows.map(row => ["element", row.id, `${prefix(plans.find(plan => plan.rooms.some(room => room.id === row.roomId)))}${row.name}`] as Entity)];
  const suggestions = await suggestionsOf(d, values, entities);
  return {
    available: true, modelRevision: modelRow.model.revision, buildingId,
    storeys: plans.map(({ page, storey }) => ({ id: storey.id, name: storey.name, levelIndex: storey.levelIndex,
      page: { sourceVersionId: page.sourceVersionId, fileName: page.fileName, page: page.page }, clearHeight: value<number>(storey.id, "clearRoomHeight") })),
    applicability: value(buildingId, "exteriorNoiseApplicability"), flanking: value(buildingId, "exteriorNoiseFlanking"),
    rooms, suggestions, calculation, levels,
  };
}

/** Inferred values nobody has confirmed yet, with their first cited page. */
export async function suggestionsOf(d: AppDeps, values: Map<string, CurrentValue>, entities: Array<[ProofSuggestion["entityType"], string, string]>,
  keys: readonly string[] = exteriorNoiseInputKeys): Promise<ProofSuggestion[]> {
  const pending = entities.flatMap(([entityType, entityId, entityLabel]) => keys.flatMap(key => {
    const found = values.get(`${entityId}:${key}`);
    if (!found || found.provenance !== "inferred" || found.reviewStatus !== "unreviewed") return [];
    const cited = (Array.isArray(found.evidence) ? found.evidence : []).map(item => buildingEvidenceSchema.safeParse(item)).find(item => item.success && item.data.kind === "page");
    const page = cited?.success && cited.data.kind === "page" ? cited.data : null;
    return [{ entityType, entityId, entityLabel, propertyKey: key, value: found.value, unit: found.unit, propertyId: found.propertyId, version: found.version, reviewRevision: found.reviewRevision,
      evidence: page ? { sourceVersionId: page.sourceVersionId, page: page.page, fileName: null as string | null, quote: page.quote ?? null } : null }];
  }));
  const versionIds = [...new Set(pending.flatMap(item => item.evidence ? [item.evidence.sourceVersionId] : []))];
  if (versionIds.length) {
    const rows = await d.db.select({ id: fileVersions.id, name: files.name }).from(fileVersions).innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(eq(fileVersions.tenantId, d.tenantId), inArray(fileVersions.id, versionIds))) as Array<{ id: string; name: string }>;
    const names = new Map(rows.map(row => [row.id, row.name]));
    for (const item of pending) if (item.evidence) item.evidence.fileName = names.get(item.evidence.sourceVersionId) ?? null;
  }
  return pending;
}

// ---- Suggestions from the Richtfest Agent -------------------------------------

/**
 * Writes one suggested value as an inferred, unreviewed version. Returns why it
 * was skipped: a value a person entered or reviewed, a value rejected before,
 * the same suggestion again, or a key that does not apply. Null when written.
 */
export async function writeSuggestion(tx: any, d: AppDeps, modelId: string, input: { entityType: string; entityId: string; propertyKey: string; value: unknown; unit: string | null; evidence: unknown[] }) {
  const { entityType, entityId, propertyKey, value, unit } = input;
  // Each key belongs to one kind of entity; a value on any other is a mistake, not a free-form note.
  const known = Object.hasOwn((buildingComponentProperties as Record<string, object>)[entityType] ?? {}, propertyKey);
  const invalid = known ? validateBuildingComponentProperty(entityType, propertyKey, value as any, unit) : `${propertyKey} does not apply to a ${entityType}`;
  if (invalid) return invalid;
  const [property] = await tx.select({ id: buildingProperties.id }).from(buildingProperties).where(and(eq(buildingProperties.modelId, modelId), eq(buildingProperties.entityType, entityType),
    eq(buildingProperties.entityId, entityId), eq(buildingProperties.propertyKey, propertyKey))).limit(1);
  const history = property ? await tx.select().from(buildingPropertyVersions).where(eq(buildingPropertyVersions.propertyId, property.id)).orderBy(desc(buildingPropertyVersions.version)) as any[] : [];
  const latest = history.find(version => version.reviewStatus !== "rejected");
  if (history.some(version => version.reviewStatus === "approved") || (latest && latest.provenance !== "inferred")) return "entered_or_reviewed";
  if (history.some(version => version.reviewStatus === "rejected" && JSON.stringify(version.value) === JSON.stringify(value))) return "rejected_before";
  if (latest && JSON.stringify(latest.value) === JSON.stringify(value)) return "already_suggested";
  await appendPropertyVersion(tx, d, modelId, { entityType, entityId, propertyKey, value, unit, provenance: "inferred", evidence: input.evidence });
  return null;
}


/**
 * The window or door the agent read from a plan or list, in a room and the wall
 * it sits in: the existing one of that name in the room, else a new element
 * linked to its wall, typed as an inferred value. Null when room or wall is not
 * in the model.
 */
export async function suggestedOpening(tx: any, d: AppDeps, modelId: string, item: { roomId: string; wallId: string; componentType: "window" | "door"; name: string; evidence: unknown[] }) {
  const [room] = await tx.select().from(buildingRooms).where(and(eq(buildingRooms.id, item.roomId), eq(buildingRooms.modelId, modelId), eq(buildingRooms.tenantId, d.tenantId))).limit(1);
  const [wall] = await tx.select().from(buildingElements).where(and(eq(buildingElements.id, item.wallId), eq(buildingElements.modelId, modelId), eq(buildingElements.tenantId, d.tenantId))).limit(1);
  if (!room || !wall) return null;
  // The same opening named twice in one room is one opening.
  const [existing] = await tx.select({ id: buildingElements.id }).from(buildingElements).where(and(eq(buildingElements.modelId, modelId), eq(buildingElements.roomId, room.id),
    eq(buildingElements.name, item.name), inArray(buildingElements.kind, ["window", "door"]))).limit(1);
  if (existing) return { elementId: existing.id as string, created: false };
  const [storey] = await tx.select({ buildingId: buildingStoreys.buildingId }).from(buildingStoreys).where(eq(buildingStoreys.id, room.storeyId)).limit(1);
  const [element] = await tx.insert(buildingElements).values({ tenantId: d.tenantId, modelId, buildingId: storey.buildingId, storeyId: room.storeyId, roomId: room.id,
    stableKey: `opening:${crypto.randomUUID()}`, kind: item.componentType, name: item.name, constructionState: wall.constructionState, createdBy: d.actorId }).returning();
  await tx.insert(buildingRelationships).values({ tenantId: d.tenantId, modelId, fromEntityType: "element", fromEntityId: element.id, toEntityType: "element", toEntityId: wall.id,
    relationshipType: "opening_in", metadata: { method: "agent_suggestion" }, reviewStatus: "unreviewed", createdBy: d.actorId });
  await appendPropertyVersion(tx, d, modelId, { entityType: "element", entityId: element.id, propertyKey: "componentType", value: item.componentType, unit: null, provenance: "inferred", evidence: item.evidence });
  return { elementId: element.id as string, created: true };
}

/**
 * Writes the agent's exterior noise suggestions as inferred, unreviewed
 * building-model values with their cited pages, and windows/doors it read from
 * a plan or Fensterliste as new openings with inferred values. Never replaces a
 * value a person entered or reviewed and never repeats a rejected one; the
 * planner accepts or rejects each suggestion.
 */
export async function proposeExteriorNoiseInputs(d: AppDeps, projectId: string, raw: unknown, execution: { runId?: string; agentId?: string } = {}, tx: any = d.db) {
  d.requirePermission("projects:write");
  d.requirePermission("agent:run");
  const input = exteriorNoiseSuggestionInput.parse(raw);
  const modelRow = await modelForProject(d, projectId);
  if (!modelRow) throw Object.assign(new Error("Building model not found"), { status: 404, code: "not_found" });
  const modelId = modelRow.model.id;
  const evidence = [...input.values.flatMap(item => item.evidence), ...input.openings.flatMap(item => item.evidence)];
  if (!(await evidenceVersionsForProject(tx, d, projectId, evidence)))
    throw Object.assign(new Error("Every evidence item must reference a ready source revision in this project"), { status: 422, code: "invalid_source_revision" });
  // Lock the model so concurrent edits queue behind the suggestions; the revision moves only when something was written.
  const [model] = await tx.select({ revision: buildingModels.revision }).from(buildingModels).where(and(eq(buildingModels.id, modelId), eq(buildingModels.tenantId, d.tenantId))).for("update");
  const tables = { building: buildingBuildings, storey: buildingStoreys, room: buildingRooms, element: buildingElements } as const;
  const skipped: Array<{ entityId: string; propertyKey: string; reason: string }> = [];
  let written = 0, openings = 0;
  const suggest = async (entityType: keyof typeof tables, entityId: string, propertyKey: string, value: unknown, unit: string | null, cited: unknown[]) => {
    const reason = await writeSuggestion(tx, d, modelId, { entityType, entityId, propertyKey, value, unit, evidence: cited });
    if (reason) skipped.push({ entityId, propertyKey, reason }); else written++;
  };
  for (const item of input.values) {
    const table: any = tables[item.entityType];
    const [entity] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, item.entityId), eq(table.modelId, modelId), eq(table.tenantId, d.tenantId))).limit(1);
    if (!entity) { skipped.push({ entityId: item.entityId, propertyKey: item.propertyKey, reason: "not_in_model" }); continue; }
    await suggest(item.entityType, item.entityId, item.propertyKey, item.value, item.unit ?? null, item.evidence);
  }
  for (const item of input.openings) {
    const opening = await suggestedOpening(tx, d, modelId, item);
    if (!opening) { skipped.push({ entityId: item.roomId, propertyKey: "opening", reason: "not_in_model" }); continue; }
    if (opening.created) openings++;
    await suggest("element", opening.elementId, "openingArea", item.area, "m²", item.evidence);
    if (item.rw != null) await suggest("element", opening.elementId, "soundReductionIndex", item.rw, "dB", item.evidence);
    if (item.basis) await suggest("element", opening.elementId, "soundReductionIndexBasis", item.basis, null, item.evidence);
  }
  if (!written && !openings) return { status: "unchanged", modelRevision: model.revision, written, openings, skipped, review: `/projects/${projectId}?view=noise` };
  const revision = await touchRevision(tx, d, modelId, model.revision);
  await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId, revision, status: "draft", createdBy: d.actorId });
  await d.audit(tx, "projects.building.exterior_noise.suggested", "building_model", modelId, { projectId, modelRevision: revision, written, openings, skipped: skipped.length,
    actorType: "agent", runId: execution.runId ?? null, agentId: execution.agentId ?? null });
  return { status: "suggested", modelRevision: revision, written, openings, skipped, review: `/projects/${projectId}?view=noise` };
}

// ---- Openings ------------------------------------------------------------------

const openingInput = z.object({
  baseRevision: z.number().int().nonnegative(),
  roomId: z.string().uuid(), wallId: z.string().uuid(),
  componentType: z.enum(["window", "door"]),
  name: z.string().trim().min(1).max(120),
  area: z.number().positive().max(10000).nullable(),
  rw: z.number().min(0).max(100).nullable(),
  basis: z.string().trim().min(1).max(500).nullable(),
  /** Interior: where an entrance door leads; only for doors. */
  doorRole: doorRoleSchema.nullable().optional(),
}).strict().refine(input => !input.doorRole || input.componentType === "door", "Only doors take a door role");

export function createExteriorNoiseProofRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  const conflict = (res: any, revision: number) => res.status(409).json({ data: { currentRevision: revision }, error: { code: "revision_conflict" }, message: "The building model changed; reload before saving." });
  const notFound = (res: any, message: string) => res.status(404).json({ data: null, error: { code: "not_found" }, message });

  router.get("/projects/:projectId/exterior-noise/proof", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read");
      res.json(ok(await readExteriorNoiseProof(d, z.string().uuid().parse(req.params.projectId))));
    } catch (error) { next(error); }
  });

  // A window or door in a wall of a room, with its area and installed Rw; an entrance door also with its role.
  router.post("/projects/:projectId/exterior-noise/proof/openings", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = z.string().uuid().parse(req.params.projectId);
      const input = openingInput.parse(req.body);
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return notFound(res, "Building model not found");
      const modelId = modelRow.model.id;
      const result = await modelTransaction(d.db, async (tx: any) => {
        const [room] = await tx.select().from(buildingRooms).where(and(eq(buildingRooms.id, input.roomId), eq(buildingRooms.modelId, modelId), eq(buildingRooms.tenantId, d.tenantId))).limit(1);
        const [wall] = await tx.select().from(buildingElements).where(and(eq(buildingElements.id, input.wallId), eq(buildingElements.modelId, modelId), eq(buildingElements.tenantId, d.tenantId))).limit(1);
        if (!room || !wall) return { missing: true };
        const [storey] = await tx.select({ buildingId: buildingStoreys.buildingId }).from(buildingStoreys).where(eq(buildingStoreys.id, room.storeyId)).limit(1);
        const revision = await touchRevision(tx, d, modelId, input.baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        const [element] = await tx.insert(buildingElements).values({ tenantId: d.tenantId, modelId, buildingId: storey.buildingId, storeyId: room.storeyId, roomId: room.id,
          stableKey: `opening:${crypto.randomUUID()}`, kind: input.componentType, name: input.name, constructionState: wall.constructionState, createdBy: d.actorId }).returning();
        await tx.insert(buildingRelationships).values({ tenantId: d.tenantId, modelId, fromEntityType: "element", fromEntityId: element.id, toEntityType: "element", toEntityId: wall.id,
          relationshipType: "opening_in", metadata: { method: "manual" }, reviewStatus: "approved", createdBy: d.actorId });
        const entries: Array<[string, unknown, string | null]> = [["componentType", input.componentType, null], ["openingArea", input.area, "m²"], ["soundReductionIndex", input.rw, "dB"],
          ["soundReductionIndexBasis", input.basis, null], ["doorRole", input.doorRole ?? null, null]];
        for (const [propertyKey, value, unit] of entries) if (value !== null)
          await appendPropertyVersion(tx, d, modelId, { entityType: "element", entityId: element.id, propertyKey, value, unit, provenance: "manual", evidence: [] });
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId, revision, status: "draft", createdBy: d.actorId });
        await d.audit(tx, "projects.building.element.created", "element", element.id, { projectId, roomId: room.id, wallId: wall.id, kind: input.componentType, modelRevision: revision });
        return { element, revision };
      });
      if (result.missing) return notFound(res, "Room or wall not found");
      if (result.conflict !== undefined) return conflict(res, result.conflict);
      res.status(201).json(ok(result));
    } catch (error) { next(error); }
  });

  router.delete("/projects/:projectId/exterior-noise/proof/openings/:elementId", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = z.string().uuid().parse(req.params.projectId);
      const elementId = z.string().uuid().parse(req.params.elementId);
      const baseRevision = z.coerce.number().int().nonnegative().parse(req.query.baseRevision);
      const modelRow = await modelForProject(d, projectId); if (!modelRow) return notFound(res, "Building model not found");
      const modelId = modelRow.model.id;
      const result = await modelTransaction(d.db, async (tx: any) => {
        const [element] = await tx.select().from(buildingElements).where(and(eq(buildingElements.id, elementId), eq(buildingElements.modelId, modelId), eq(buildingElements.tenantId, d.tenantId),
          inArray(buildingElements.kind, ["window", "door"]))).limit(1);
        if (!element) return { missing: true };
        const revision = await touchRevision(tx, d, modelId, baseRevision); if (revision === undefined) return { conflict: modelRow.model.revision };
        await tx.delete(buildingRelationships).where(and(eq(buildingRelationships.modelId, modelId), or(eq(buildingRelationships.fromEntityId, elementId), eq(buildingRelationships.toEntityId, elementId))));
        await tx.delete(buildingProperties).where(and(eq(buildingProperties.modelId, modelId), eq(buildingProperties.entityType, "element"), eq(buildingProperties.entityId, elementId)));
        await tx.delete(buildingElements).where(eq(buildingElements.id, elementId));
        await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId, revision, status: "draft", createdBy: d.actorId });
        await d.audit(tx, "projects.building.element.deleted", "element", elementId, { projectId, kind: element.kind, name: element.name, modelRevision: revision });
        return { revision };
      });
      if (result.missing) return notFound(res, "Opening not found");
      if (result.conflict !== undefined) return conflict(res, result.conflict);
      res.json(ok(result));
    } catch (error) { next(error); }
  });
  return router;
}
