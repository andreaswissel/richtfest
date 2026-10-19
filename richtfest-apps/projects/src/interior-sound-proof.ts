import { Router, type Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  interiorSoundInputKeys, interiorSoundSuggestionInput, ok, verifiedWallRoles,
  type AirborneInput, type DoorResult, type FlankElement, type InteriorDoorCheck, type InteriorDoorRole, type FlankingEdge, type InteriorCeilingCheck, type InteriorCeilingRole, type InteriorElement, type InteriorElementReason,
  type InteriorGap, type InteriorLimitation, type InteriorSoundProof, type InteriorWallCheck, type InteriorWallRole, type MassiveWallInput, type MassiveWallRw,
  type Point2, type ProofSuggestion, type ProofValue,
} from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { evidenceVersionsForProject, modelForProject, readSitePlan, touchRevision } from "./building-model-router";
import { classifyMassiveWall, catalogueBasis } from "./exterior-noise-catalogue";
import { currentValues, distanceToRing, inside, overlapAlongWall, polygonArea, suggestedOpening, suggestionsOf, writeSuggestion, type CurrentValue } from "./exterior-noise-proof";
import { buildingBuildings, buildingElements, buildingModels, buildingRelationships, buildingRevisions, buildingRooms, buildingStoreys } from "./schema";

/**
 * Interior sound insulation verification from the building model: for every
 * separating wall the room pairs on its two sides, and for every ceiling the
 * rooms below it. Element values come from the component catalogue (massive)
 * or an entered Dn,f,w (lightweight flanking walls); the flanking elements are
 * found from the room/wall adjacency and the traced plan geometry.
 */

// ---- Elements ----------------------------------------------------------------

type Values = { construction: unknown; material: unknown; thickness: unknown; bulkDensity: unknown; flankingLevelDifference: unknown };
const lightweight = (construction: unknown) => construction === "drywall" || construction === "timber" || construction === "steel";

/** Catalogue values of one wall or ceiling, or why it has none. */
export function evaluateElement(id: string, name: string, componentType: "wall" | "ceiling", values: Values, massiveRw: ((input: MassiveWallInput) => MassiveWallRw) | null): InteriorElement {
  const construction = typeof values.construction === "string" ? values.construction : null;
  const material = typeof values.material === "string" ? values.material : null;
  const base = { id, name, componentType, construction, massKgM2: null, rwDb: null, dnfwDb: null, basis: null };
  if (lightweight(construction)) {
    const dnfw = typeof values.flankingLevelDifference === "number" ? values.flankingLevelDifference : null;
    return { ...base, massive: false, dnfwDb: dnfw, reason: dnfw === null ? "flanking_level_difference_missing" : null };
  }
  if (!construction && !material) return { ...base, massive: true, reason: "construction_missing" };
  const kind = classifyMassiveWall(construction, material);
  if ("reason" in kind) return { ...base, massive: true, reason: kind.reason === "not_massive" ? "construction_missing" : kind.reason };
  if (!massiveRw) return { ...base, massive: true, reason: "catalogue_missing" };
  const input: MassiveWallInput = { ...kind, thicknessCm: typeof values.thickness === "number" ? values.thickness : null, densityKgM3: typeof values.bulkDensity === "number" ? values.bulkDensity : null };
  const result = massiveRw(input);
  if (result.status !== "calculated") return { ...base, massive: true, reason: result.reason };
  return { ...base, massive: true, massKgM2: result.massKgM2, rwDb: result.rwDb, basis: catalogueBasis(result, input), reason: null };
}

// ---- Geometry (plan metres) ------------------------------------------------------

type Axis = { axis: Point2; normal: Point2; centre: Point2 };
const dot = (a: Point2, b: Point2) => a[0] * b[0] + a[1] * b[1];
function axisOf(ring: Point2[]): Axis {
  let axis: Point2 = [1, 0], longest = 0;
  ring.forEach((a, i) => { const b = ring[(i + 1) % ring.length]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > longest) { longest = length; axis = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]; } });
  const centre: Point2 = [ring.reduce((sum, p) => sum + p[0], 0) / ring.length, ring.reduce((sum, p) => sum + p[1], 0) / ring.length];
  return { axis, normal: [-axis[1], axis[0]], centre };
}
const span = (ring: Point2[], axis: Point2) => { const values = ring.map(p => dot(p, axis)); return [Math.min(...values), Math.max(...values)] as const; };
const areaOf = (room: { polygon: Point2[] | null; holes: Point2[][] }) => room.polygon
  ? Math.round(Math.max(0, polygonArea(room.polygon) - room.holes.reduce((sum, hole) => sum + polygonArea(hole), 0)) * 100) / 100 : null;
const round2 = (value: number) => Math.round(value * 100) / 100;

// ---- Assembly (pure) ---------------------------------------------------------

export type InteriorAssemblyInput = {
  storeyId: string;
  clearHeight: number | null;
  rooms: Array<{ id: string; name: string; polygon: Point2[] | null; holes: Point2[][]; adjacentWallIds: Set<string>; ceilingIds: string[] }>;
  walls: Array<{ id: string; name: string; ring: Point2[]; role: string | null }>;
  ceilings: Array<{ id: string; name: string; role: ProofValue<string> | null; coversRoomIds: string[];
    screed: { type: ProofValue<string> | null; mass: ProofValue<number> | null; stiffness: ProofValue<number> | null } }>;
  /** The slab under this storey (the ceiling of the storey below), when the model has it. */
  floorId: string | null;
  elements: Map<string, InteriorElement>;
  wallRequirement: (role: InteriorWallRole) => { rwMinDb: number; ref: string } | null;
  ceilingRequirement: (role: InteriorCeilingRole) => { rwMinDb: number | null; lnwMaxDb: number | null; ref: string } | null;
  airborne: (input: AirborneInput) => import("@richtfest/shared").AirborneResult;
  impact: (input: import("@richtfest/shared").ImpactInput) => import("@richtfest/shared").ImpactResult;
  /** Doors of this storey with the wall they sit in and the room they lead into. */
  doors?: Array<{ id: string; name: string; wallId: string | null; roomId: string | null; role: ProofValue<string> | null; rw: ProofValue<number> | null; basis: ProofValue<string> | null }>;
  door?: (input: { rwDb: number; role: InteriorDoorRole }) => DoorResult;
  wallWithDoorRequirement?: (role: InteriorDoorRole) => { rwMinDb: number; ref: string } | null;
};
const doorWallRoles = new Set(["stairwell", "corridor_partition"]);
const doorRoleOf = (door: { role: ProofValue<string> | null }) => door.role?.value === "to_dwelling_hallway" || door.role?.value === "to_habitable_room" ? door.role.value as InteriorDoorRole : null;

const MIN_COMMON_M = 0.1, FLANK_DISTANCE_M = 0.6, MIN_EDGE_M = 0.3, SAMPLE_M = 0.05;

export function assembleInteriorSound(input: InteriorAssemblyInput): { walls: InteriorWallCheck[]; ceilings: InteriorCeilingCheck[]; doors: InteriorDoorCheck[]; floorAssumed: boolean; usedElementIds: Set<string> } {
  const h = input.clearHeight;
  // Every element a check reads, so the inputs list and suggestions cover exactly these.
  const usedElementIds = new Set<string>();
  const wallById = new Map(input.walls.map(wall => [wall.id, wall]));
  let floorAssumed = false;
  const elementGap = (element: InteriorElement | undefined, id: string, name: string): InteriorGap[] => {
    usedElementIds.add(id);
    if (!element) return [{ code: "element", elementId: id, elementName: name, reason: "construction_missing" }];
    return element.reason ? [{ code: "element", elementId: element.id, elementName: element.name, reason: element.reason }] : [];
  };
  const flank = (element: InteriorElement, areaM2: number): FlankElement => element.massive
    ? { kind: "massive", id: element.id, name: element.name, massKgM2: element.massKgM2!, rwDb: element.rwDb!, areaM2 }
    : { kind: "lightweight", id: element.id, name: element.name, dnfwDb: element.dnfwDb! };
  const unique = (gaps: InteriorGap[]) => [...new Map(gaps.map(gap => [JSON.stringify(gap), gap])).values()];

  const walls: InteriorWallCheck[] = [];
  for (const wall of input.walls) {
    if (!wall.role || !(verifiedWallRoles as readonly string[]).includes(wall.role)) continue;
    const role = wall.role as InteriorWallRole;
    const { axis, normal, centre } = axisOf(wall.ring);
    const [w0, w1] = span(wall.ring, axis);
    const [n0, n1] = span(wall.ring, normal);
    const point = (p: number, offset = 0): Point2 => [centre[0] + (p - dot(centre, axis)) * axis[0] + offset * normal[0], centre[1] + (p - dot(centre, axis)) * axis[1] + offset * normal[1]];
    // Probe just beside both wall faces along the wall: which side each room lies on and where it touches the wall.
    const reach = (n1 - n0) / 2 + 0.15, samples = Math.max(2, Math.ceil((w1 - w0) / SAMPLE_M)), step = (w1 - w0) / samples;
    const positions = Array.from({ length: samples }, (_, i) => w0 + (i + 0.5) * step);
    const touching = input.rooms.filter(room => room.adjacentWallIds.has(wall.id) && room.polygon).map(room => {
      const plus = positions.map(p => inside(point(p, reach), room.polygon!)), minus = positions.map(p => inside(point(p, -reach), room.polygon!));
      const plusHits = plus.filter(Boolean).length, minusHits = minus.filter(Boolean).length;
      return { room, side: plusHits >= minusHits ? 1 : 0, mask: plusHits >= minusHits ? plus : minus, hits: Math.max(plusHits, minusHits) };
    }).filter(item => item.hits > 0);
    const left = touching.filter(item => item.side === 0), right = touching.filter(item => item.side === 1);
    for (const { room: a, mask: maskA } of left) for (const { room: b, mask: maskB } of right) {
      const shared = positions.flatMap((p, i) => maskA[i] && maskB[i] ? [p] : []);
      // Rooms only diagonal to each other share no separating area; that case is not covered.
      if (shared.length * step < MIN_COMMON_M) continue;
      const from = shared[0]! - step / 2, to = shared[shared.length - 1]! + step / 2;
      const length = shared.length * step;
      const gaps: InteriorGap[] = [];
      if (h === null) gaps.push({ code: "clear_height" });
      const separating = input.elements.get(wall.id);
      if (separating && !separating.massive) { usedElementIds.add(wall.id); gaps.push({ code: "element", elementId: wall.id, elementName: wall.name, reason: "lightweight_separating" }); }
      else gaps.push(...elementGap(separating, wall.id, wall.name));
      const flankingAt = (room: typeof a, p: Point2) => {
        let best: { id: string; distance: number } | null = null;
        for (const id of room.adjacentWallIds) {
          const other = wallById.get(id);
          if (!other || id === wall.id || Math.abs(dot(axisOf(other.ring).axis, axis)) > 0.7) continue;
          const distance = distanceToRing(p, other.ring);
          if (distance <= FLANK_DISTANCE_M && (!best || distance < best.distance)) best = { id, distance };
        }
        return best ? wallById.get(best.id)! : null;
      };
      const edges: FlankingEdge[] = [], shownEdges: InteriorWallCheck["edges"] = [];
      for (const [edge, p] of [["start", from], ["end", to]] as const) {
        const f = flankingAt(a, point(p)), r = flankingAt(b, point(p));
        shownEdges.push({ edge, source: f?.name ?? null, receiving: r?.name ?? null });
        if (!f || !r) { gaps.push({ code: "flanking_missing", edge }); continue; }
        const fe = input.elements.get(f.id), re = input.elements.get(r.id);
        gaps.push(...elementGap(fe, f.id, f.name), ...elementGap(re, r.id, r.name));
        if (fe && re && !fe.reason && !re.reason && h !== null)
          edges.push({ edge, couplingLengthM: h, source: flank(fe, overlapAlongWall(a.polygon!, f.ring) * h), receiving: flank(re, overlapAlongWall(b.polygon!, r.ring) * h) });
      }
      // Top: the ceiling over both rooms. Bottom: the slab under the storey, else taken to equal the ceiling.
      for (const edge of ["top", "bottom"] as const) {
        const pick = (room: typeof a) => edge === "top" || !input.floorId ? room.ceilingIds[0] ?? null : input.floorId;
        const fid = pick(a), rid = pick(b);
        if (edge === "bottom" && !input.floorId) floorAssumed = true;
        const fe = fid ? input.elements.get(fid) : undefined, re = rid ? input.elements.get(rid) : undefined;
        shownEdges.push({ edge, source: fe?.name ?? null, receiving: re?.name ?? null });
        if (!fid || !rid) { gaps.push({ code: "ceiling_missing" }); continue; }
        gaps.push(...elementGap(fe, fid, fe?.name ?? fid), ...elementGap(re, rid, re?.name ?? rid));
        const areaA = areaOf(a), areaB = areaOf(b);
        if (fe && re && !fe.reason && !re.reason && areaA && areaB) edges.push({ edge, couplingLengthM: length, source: flank(fe, areaA), receiving: flank(re, areaB) });
      }
      // A stairwell or corridor wall with an entrance door into one of the two rooms needs only the door's requirement plus the offset.
      const roleRequirement = input.wallRequirement(role);
      let requirement: InteriorWallCheck["requirement"] = roleRequirement && { ...roleRequirement, door: null };
      if (doorWallRoles.has(role)) for (const door of input.doors ?? []) {
        const doorRole = doorRoleOf(door);
        if (door.wallId !== wall.id || !doorRole || (door.roomId !== a.id && door.roomId !== b.id)) continue;
        const relaxed = input.wallWithDoorRequirement?.(doorRole);
        if (relaxed && (!requirement?.door || relaxed.rwMinDb > requirement.rwMinDb)) requirement = { ...relaxed, door: { id: door.id, name: door.name } };
      }
      if (!requirement) gaps.push({ code: "no_requirement" });
      const finalGaps = unique(gaps);
      const area = h === null ? null : round2(length * h);
      walls.push({ id: `${wall.id}:${a.id}:${b.id}`, storeyId: input.storeyId, wallId: wall.id, wallName: wall.name, role,
        rooms: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], lengthM: round2(length), areaM2: area, requirement, edges: shownEdges, gaps: finalGaps,
        result: finalGaps.length || !requirement || area === null || !separating ? null
          : input.airborne({ separating: { id: wall.id, name: wall.name, massKgM2: separating.massKgM2!, rwDb: separating.rwDb! }, separatingAreaM2: length * h!,
            transmission: "horizontal", edges, requiredDb: requirement.rwMinDb }) });
    }
  }

  const ceilings: InteriorCeilingCheck[] = [];
  for (const ceiling of input.ceilings) {
    const role = typeof ceiling.role?.value === "string" ? ceiling.role.value : null;
    if (role === "internal") continue;
    const requirement = role ? input.ceilingRequirement(role as InteriorCeilingRole) : null;
    const slab = input.elements.get(ceiling.id);
    for (const room of input.rooms.filter(item => ceiling.coversRoomIds.includes(item.id))) {
      const gaps: InteriorGap[] = [];
      if (!role) gaps.push({ code: "ceiling_role" });
      else if (!requirement) gaps.push({ code: "no_requirement" });
      if (h === null) gaps.push({ code: "clear_height" });
      if (slab && !slab.massive) { usedElementIds.add(ceiling.id); gaps.push({ code: "element", elementId: ceiling.id, elementName: ceiling.name, reason: "lightweight_separating" }); }
      else gaps.push(...elementGap(slab, ceiling.id, ceiling.name));
      const area = areaOf(room);
      if (!area) gaps.push({ code: "geometry" });
      const screedType = typeof ceiling.screed.type?.value === "string" ? ceiling.screed.type.value : null;
      const screedMass = ceiling.screed.mass?.value ?? null, screedStiffness = ceiling.screed.stiffness?.value ?? null;
      if (!screedType || (screedType !== "none" && (screedMass === null || screedStiffness === null))) gaps.push({ code: "screed" });
      // The room's walls flank the ceiling; the storey above is taken to repeat them.
      const edges: FlankingEdge[] = [], masses: number[] = [];
      for (const wallId of room.adjacentWallIds) {
        const wall = wallById.get(wallId);
        if (!wall || !room.polygon) continue;
        const lf = overlapAlongWall(room.polygon, wall.ring);
        if (lf < MIN_EDGE_M) continue;
        const element = input.elements.get(wallId);
        gaps.push(...elementGap(element, wallId, wall.name));
        if (!element || element.reason || h === null) continue;
        edges.push({ edge: wall.name, couplingLengthM: lf, source: flank(element, lf * h), receiving: flank(element, lf * h) });
        if (element.massive) masses.push(element.massKgM2!);
      }
      const finalGaps = unique(gaps);
      const blocked = finalGaps.some(gap => gap.code !== "screed") || !slab || !area;
      const airborne = blocked || requirement?.rwMinDb == null ? null : input.airborne({ separating: { id: ceiling.id, name: ceiling.name, massKgM2: slab!.massKgM2!, rwDb: slab!.rwDb! },
        separatingAreaM2: area!, transmission: "vertical", edges, requiredDb: requirement.rwMinDb });
      const impact = blocked || finalGaps.length || requirement?.lnwMaxDb == null ? null : input.impact({ slabMassKgM2: slab!.massKgM2!,
        screed: screedType === "none" ? null : { type: screedType as "mortar" | "mastic_asphalt" | "prefab", massKgM2: screedMass!, stiffnessMNm3: screedStiffness! },
        flankingMassesKgM2: masses, maxDb: requirement.lnwMaxDb });
      ceilings.push({ id: `${ceiling.id}:${room.id}`, storeyId: input.storeyId, ceilingId: ceiling.id, ceilingName: ceiling.name, role: ceiling.role,
        room: { id: room.id, name: room.name }, areaM2: area, requirement, screed: ceiling.screed, gaps: finalGaps, airborne, impact });
    }
  }
  // Doors in stairwell and corridor walls, and any door given an entrance role.
  const doors: InteriorDoorCheck[] = [];
  const roomName = new Map(input.rooms.map(room => [room.id, room.name]));
  for (const door of input.doors ?? []) {
    const wall = door.wallId ? wallById.get(door.wallId) : undefined;
    if (door.role?.value === "internal" || (!door.role && !(wall?.role && doorWallRoles.has(wall.role)))) continue;
    const doorRole = doorRoleOf(door);
    const gaps: InteriorDoorCheck["gaps"] = [];
    if (!doorRole) gaps.push("door_role");
    if (!door.rw) gaps.push("door_rw");
    const result = doorRole && door.rw && input.door ? input.door({ rwDb: door.rw.value, role: doorRole }) : null;
    if (result?.status === "unsupported" && result.reason === "no_requirement") gaps.push("no_requirement");
    doors.push({ id: door.id, storeyId: input.storeyId, name: door.name, wall: wall ? { id: wall.id, name: wall.name } : null,
      room: door.roomId && roomName.has(door.roomId) ? { id: door.roomId, name: roomName.get(door.roomId)! } : null,
      role: door.role, rw: door.rw, basis: door.basis,
      requirement: result?.status === "calculated" ? { rwMinDb: result.requiredDb, ref: result.refs[0]! } : null, gaps,
      result: result?.status === "calculated" ? result : null });
  }
  return { walls, ceilings, doors, floorAssumed, usedElementIds };
}

// ---- Reading -----------------------------------------------------------------

const elementKeys = ["componentType", "construction", "material", "thickness", "bulkDensity", "wallRole", "ceilingRole", "screedType", "screedMass", "screedStiffness", "flankingLevelDifference",
  "doorRole", "soundReductionIndex", "soundReductionIndexBasis"];

export async function readInteriorSoundProof(d: AppDeps, projectId: string): Promise<InteriorSoundProof> {
  const host = d.interiorSound;
  if (!host) return { available: false, reason: "norm_pack_missing" };
  const modelRow = await modelForProject(d, projectId);
  if (!modelRow) return { available: false, reason: "model_missing" };
  const modelId = modelRow.model.id;
  const sitePlan = await readSitePlan(d, projectId);
  const pages = sitePlan.pages.filter(page => page.storey && page.walls.length);
  if (!pages.length) return { available: false, reason: "plan_missing" };
  const scope = { modelId, tenantId: d.tenantId };
  const roomRows = (await d.db.select().from(buildingRooms).where(and(eq(buildingRooms.modelId, scope.modelId), eq(buildingRooms.tenantId, scope.tenantId))) as any[])
    .filter(room => room.constructionState !== "demolished");
  const elementRows = await d.db.select().from(buildingElements).where(and(eq(buildingElements.modelId, scope.modelId), eq(buildingElements.tenantId, scope.tenantId))) as any[];
  const relationships = await d.db.select().from(buildingRelationships).where(and(eq(buildingRelationships.modelId, scope.modelId), eq(buildingRelationships.tenantId, scope.tenantId),
    inArray(buildingRelationships.relationshipType, ["separates", "covers", "under_storey", "opening_in"]))) as any[];
  const storeyRows = await d.db.select().from(buildingStoreys).where(and(eq(buildingStoreys.modelId, scope.modelId), eq(buildingStoreys.tenantId, scope.tenantId))) as any[];
  const [building] = await d.db.select({ id: buildingBuildings.id }).from(buildingBuildings).where(and(eq(buildingBuildings.modelId, scope.modelId), eq(buildingBuildings.tenantId, scope.tenantId))).limit(1) as any[];
  const values = await currentValues(d, modelId, [...elementRows.map(row => row.id), ...storeyRows.map(row => row.id), ...(building ? [building.id] : [])],
    [...elementKeys, "clearRoomHeight", "soundInsulationLevel"]);
  const raw = (entityId: string, key: string) => values.get(`${entityId}:${key}`) ?? null;
  const value = <T,>(entityId: string, key: string) => {
    const found = raw(entityId, key);
    return found ? { value: found.value, reviewStatus: found.reviewStatus, provenance: found.provenance, propertyId: found.propertyId, version: found.version, reviewRevision: found.reviewRevision } as ProofValue<T> : null;
  };
  const typeOf = (row: any) => { const declared = raw(row.id, "componentType")?.value;
    return declared === "wall" || declared === "ceiling" ? declared : row.kind === "draft_wall" ? "wall" : row.kind === "draft_ceiling" ? "ceiling" : null; };
  const elements = new Map<string, InteriorElement>();
  for (const row of elementRows) {
    const type = typeOf(row);
    if (!type || row.constructionState === "demolished") continue;
    elements.set(row.id, evaluateElement(row.id, row.name, type, Object.fromEntries(["construction", "material", "thickness", "bulkDensity", "flankingLevelDifference"]
      .map(key => [key, raw(row.id, key)?.value ?? null])) as Values, host.massiveRw));
  }
  const adjacent = new Map<string, Set<string>>(), covers = new Map<string, string[]>(), underStorey = new Map<string, string>(), hostOf = new Map<string, string>();
  for (const row of relationships) {
    if (row.relationshipType === "opening_in") hostOf.set(row.fromEntityId, row.toEntityId);
    else if (row.relationshipType === "separates") adjacent.set(row.toEntityId, (adjacent.get(row.toEntityId) ?? new Set()).add(row.fromEntityId));
    else if (row.relationshipType === "covers") covers.set(row.fromEntityId, [...(covers.get(row.fromEntityId) ?? []), row.toEntityId]);
    else underStorey.set(row.fromEntityId, row.toEntityId);
  }
  const ceilingRows = elementRows.filter(row => elements.get(row.id)?.componentType === "ceiling");
  const doorRows = elementRows.filter(row => row.constructionState !== "demolished" && (raw(row.id, "componentType")?.value ?? row.kind) === "door");
  const walls: InteriorWallCheck[] = [], ceilings: InteriorCeilingCheck[] = [], doors: InteriorDoorCheck[] = [], storeys: Extract<InteriorSoundProof, { available: true }>["storeys"] = [];
  let floorAssumed = false;
  const used = new Set<string>();
  for (const page of pages) {
    const storey = storeyRows.find(row => row.id === page.storey!.id);
    if (!storey) continue;
    const toMetres = (point: { x: unknown; y: unknown }): Point2 => [Number(point.x) * page.scale.pageAspectRatio * page.scale.metresPerPageHeight, Number(point.y) * page.scale.metresPerPageHeight];
    const rooms = roomRows.filter(room => room.storeyId === storey.id && room.geometry?.source?.sourceVersionId === page.sourceVersionId && room.geometry?.source?.page === page.page);
    const roomIds = new Set(rooms.map(room => room.id));
    const clearHeight = value<number>(storey.id, "clearRoomHeight");
    storeys.push({ id: storey.id, name: storey.name, sourceVersionId: page.sourceVersionId, fileName: page.fileName, page: page.page, clearHeight });
    const storeyCeilings = ceilingRows.filter(row => (covers.get(row.id) ?? []).some(id => roomIds.has(id)));
    const assembled = assembleInteriorSound({
      storeyId: storey.id, clearHeight: typeof clearHeight?.value === "number" ? clearHeight.value : null,
      rooms: rooms.map(room => ({ id: room.id, name: room.name, polygon: Array.isArray(room.geometry?.polygon) ? room.geometry.polygon.map(toMetres) : null,
        holes: Array.isArray(room.geometry?.holes) ? room.geometry.holes.filter(Array.isArray).map((hole: any[]) => hole.map(toMetres)) : [],
        adjacentWallIds: adjacent.get(room.id) ?? new Set(), ceilingIds: storeyCeilings.filter(row => covers.get(row.id)!.includes(room.id)).map(row => row.id) })),
      walls: page.walls.map(wall => ({ id: wall.id, name: wall.name, ring: wall.ring, role: (raw(wall.id, "wallRole")?.value as string | undefined) ?? null })),
      ceilings: storeyCeilings.map(row => ({ id: row.id, name: row.name, role: value<string>(row.id, "ceilingRole"), coversRoomIds: covers.get(row.id) ?? [],
        screed: { type: value<string>(row.id, "screedType"), mass: value<number>(row.id, "screedMass"), stiffness: value<number>(row.id, "screedStiffness") } })),
      floorId: ceilingRows.find(row => underStorey.get(row.id) === storey.id)?.id ?? null,
      elements, wallRequirement: host.wallRequirement, ceilingRequirement: host.ceilingRequirement, airborne: host.airborne, impact: host.impact,
      doors: doorRows.filter(row => row.storeyId === storey.id).map(row => ({ id: row.id, name: row.name, wallId: hostOf.get(row.id) ?? null, roomId: row.roomId ?? null,
        role: value<string>(row.id, "doorRole"), rw: value<number>(row.id, "soundReductionIndex"), basis: value<string>(row.id, "soundReductionIndexBasis") })),
      door: host.door, wallWithDoorRequirement: host.wallWithDoorRequirement,
    });
    walls.push(...assembled.walls); ceilings.push(...assembled.ceilings); doors.push(...assembled.doors);
    floorAssumed ||= assembled.floorAssumed;
    for (const id of assembled.usedElementIds) used.add(id);
  }
  const limitations: InteriorLimitation[] = ["minimum_requirements_only", "t_junctions", "without_linings"];
  if (!host.door) limitations.push("doors_not_checked");
  if (floorAssumed) limitations.push("floor_like_ceiling");
  if (ceilings.length) limitations.push("walls_above_like_below", "screed_not_credited_airborne", "impact_vertical_only");
  type Entity = [ProofSuggestion["entityType"], string, string];
  // Doors carry their role and Rw; walls and ceilings their build-up (an exterior wall's Rw belongs to the exterior check).
  const doorKeys = ["doorRole", "soundReductionIndex", "soundReductionIndexBasis"];
  const suggestions = [
    ...await suggestionsOf(d, values as Map<string, CurrentValue>, [...storeys.map(storey => ["storey", storey.id, storey.name] as Entity),
      ...elementRows.filter(row => used.has(row.id)).map(row => ["element", row.id, row.name] as Entity)], interiorSoundInputKeys.filter(key => key !== "doorRole")),
    ...await suggestionsOf(d, values as Map<string, CurrentValue>, doors.map(door => ["element", door.id, door.name] as Entity), doorKeys),
  ];
  return {
    available: true, modelRevision: modelRow.model.revision, buildingId: building?.id ?? storeyRows[0]?.buildingId,
    storeys, level: (raw(building?.id ?? "", "soundInsulationLevel")?.value as string | undefined) ?? null, editions: host.editions,
    elements: [...elements.values()].filter(element => used.has(element.id)).sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true })),
    walls, ceilings, doors, suggestions, limitations,
  };
}

// ---- Suggestions from the Richtfest Agent -------------------------------------

/**
 * Writes the agent's interior sound suggestions (element construction, material,
 * thickness, density, roles, screed, Dn,f,w; storey clear height) and entrance
 * doors (role, Rw) as inferred, unreviewed values with their cited pages. Never replaces a value a person
 * entered or reviewed and never repeats a rejected one.
 */
export async function proposeInteriorSoundInputs(d: AppDeps, projectId: string, raw: unknown, execution: { runId?: string; agentId?: string } = {}, tx: any = d.db) {
  d.requirePermission("projects:write");
  d.requirePermission("agent:run");
  const input = interiorSoundSuggestionInput.parse(raw);
  const modelRow = await modelForProject(d, projectId);
  if (!modelRow) throw Object.assign(new Error("Building model not found"), { status: 404, code: "not_found" });
  const modelId = modelRow.model.id;
  if (!(await evidenceVersionsForProject(tx, d, projectId, [...input.values.flatMap(item => item.evidence), ...input.doors.flatMap(item => item.evidence)])))
    throw Object.assign(new Error("Every evidence item must reference a ready source revision in this project"), { status: 422, code: "invalid_source_revision" });
  const [model] = await tx.select({ revision: buildingModels.revision }).from(buildingModels).where(and(eq(buildingModels.id, modelId), eq(buildingModels.tenantId, d.tenantId))).for("update");
  const tables = { building: buildingBuildings, storey: buildingStoreys, room: buildingRooms, element: buildingElements } as const;
  const skipped: Array<{ entityId: string; propertyKey: string; reason: string }> = [];
  let written = 0;
  for (const item of input.values) {
    const table: any = tables[item.entityType];
    const [entity] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, item.entityId), eq(table.modelId, modelId), eq(table.tenantId, d.tenantId))).limit(1);
    if (!entity) { skipped.push({ entityId: item.entityId, propertyKey: item.propertyKey, reason: "not_in_model" }); continue; }
    const reason = await writeSuggestion(tx, d, modelId, { entityType: item.entityType, entityId: item.entityId, propertyKey: item.propertyKey, value: item.value, unit: item.unit ?? null, evidence: item.evidence });
    if (reason) skipped.push({ entityId: item.entityId, propertyKey: item.propertyKey, reason }); else written++;
  }
  let doors = 0;
  for (const item of input.doors) {
    const door = await suggestedOpening(tx, d, modelId, { ...item, componentType: "door" });
    if (!door) { skipped.push({ entityId: item.roomId, propertyKey: "door", reason: "not_in_model" }); continue; }
    if (door.created) doors++;
    const suggest = async (propertyKey: string, value: unknown, unit: string | null) => {
      const reason = await writeSuggestion(tx, d, modelId, { entityType: "element", entityId: door.elementId, propertyKey, value, unit, evidence: item.evidence });
      if (reason) skipped.push({ entityId: door.elementId, propertyKey, reason }); else written++;
    };
    if (item.role) await suggest("doorRole", item.role, null);
    if (item.rw != null) await suggest("soundReductionIndex", item.rw, "dB");
    if (item.basis) await suggest("soundReductionIndexBasis", item.basis, null);
  }
  const review = `/projects/${projectId}?view=noise`;
  if (!written && !doors) return { status: "unchanged", modelRevision: model.revision, written, doors, skipped, review };
  const revision = await touchRevision(tx, d, modelId, model.revision);
  await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId, revision, status: "draft", createdBy: d.actorId });
  await d.audit(tx, "projects.building.interior_sound.suggested", "building_model", modelId, { projectId, modelRevision: revision, written, doors, skipped: skipped.length,
    actorType: "agent", runId: execution.runId ?? null, agentId: execution.agentId ?? null });
  return { status: "suggested", modelRevision: revision, written, doors, skipped, review };
}

export function createInteriorSoundProofRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.get("/projects/:projectId/interior-sound/proof", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:read");
      res.json(ok(await readInteriorSoundProof(d, z.string().uuid().parse(req.params.projectId))));
    } catch (error) { next(error); }
  });
  return router;
}
