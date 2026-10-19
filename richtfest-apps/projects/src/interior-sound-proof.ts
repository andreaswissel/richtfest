import { Router, type Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  alignPlanOutline, interiorSoundInputKeys, interiorSoundSuggestionInput, ok, verifiedWallRoles, type SitePlanPage,
  type AirborneInput, type AirborneResult, type DoorConstruction, type DoorResult, type FlankElement, type ImpactInput, type ImpactResult, type InteriorDoorCheck, type InteriorDoorRole, type FlankingEdge,
  type InteriorCeilingCheck, type InteriorCeilingRole, type InteriorElement, type InteriorElementReason, type InteriorImpactCheck, type InteriorLining, type InteriorServiceCheck, type InteriorStairCheck,
  type InteriorGap, type InteriorLimitation, type InteriorSoundProof, type InteriorWallCheck, type InteriorWallRole, type MassiveWallInput, type MassiveWallRw,
  type Point2, type ProofSuggestion, type ProofValue, type ScreedType, type ServiceInput, type ServiceKind, type StairCase, type TimberCeilingUnderside, type TimberWallLining,
} from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { evidenceVersionsForProject, modelForProject, readSitePlan, touchRevision } from "./building-model-router";
import { classifyMassiveWall, catalogueBasis } from "./exterior-noise-catalogue";
import { storeyLevels, STOREY_FIT_M } from "./exterior-noise-levels";
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

type Host = NonNullable<AppDeps["interiorSound"]>;
type Values = { construction: unknown; material: unknown; thickness: unknown; bulkDensity: unknown; flankingLevelDifference: unknown;
  lightweightCatalogueRow?: unknown; liningType?: unknown; liningMass?: unknown; liningStiffness?: unknown; liningCavity?: unknown; liningSides?: unknown;
  screedType?: unknown; screedMass?: unknown; screedStiffness?: unknown };
type ElementHost = { massiveRw: ((input: MassiveWallInput) => MassiveWallRw) | null; lightweightRow?: Host["lightweightRow"]; lining?: Host["lining"] };
const lightweight = (construction: unknown) => construction === "drywall" || construction === "timber" || construction === "steel";
const num = (value: unknown) => typeof value === "number" ? value : null;

/** ΔRw of a layer on a massive element's face, or why it is not credited; null without a layer. */
function liningOf(kind: unknown, mass: unknown, stiffness: unknown, cavityCm: unknown, sides: unknown, base: { massKgM2: number; rwDb: number }, lining: Host["lining"] | undefined): InteriorLining | null {
  if (kind !== "bonded" && kind !== "free_standing") return null;
  const side = sides === "one" || sides === "both" ? sides : null;
  const m = num(mass), s = num(stiffness), d = num(cavityCm);
  if (m === null || (kind === "bonded" ? s === null : d === null)) return { f0Hz: null, deltaRwDb: null, sides: side, reason: "incomplete" };
  if (!lining) return { f0Hz: null, deltaRwDb: null, sides: side, reason: "method_missing" };
  const result = lining({ lining: kind === "bonded" ? { kind, massKgM2: m, stiffnessMNm3: s! } : { kind, massKgM2: m, cavityM: d! / 100 }, baseMassKgM2: base.massKgM2, baseRwDb: base.rwDb });
  return result.deltaRwDb === null ? { f0Hz: result.f0Hz, deltaRwDb: null, sides: side, reason: result.reason } : { f0Hz: result.f0Hz, deltaRwDb: result.deltaRwDb, sides: side, reason: null };
}

/**
 * Catalogue values of one wall or ceiling, or why it has none. A lightweight
 * element takes Rw, Ln,w and Dn,f,w from its catalogue row (Dn,f,w may be
 * entered instead); a massive one its Rw from the mass law, and the ΔRw of a
 * lining or suspended ceiling and, for a ceiling, of its floating screed.
 */
export function evaluateElement(id: string, name: string, componentType: "wall" | "ceiling", values: Values, hostOrRw: ElementHost | ((input: MassiveWallInput) => MassiveWallRw) | null): InteriorElement {
  const host: ElementHost = typeof hostOrRw === "function" || hostOrRw === null ? { massiveRw: hostOrRw } : hostOrRw;
  const construction = typeof values.construction === "string" ? values.construction : null;
  const material = typeof values.material === "string" ? values.material : null;
  const base = { id, name, componentType, construction, massKgM2: null, rwDb: null, dnfwDb: null, basis: null };
  if (lightweight(construction)) {
    const key = typeof values.lightweightCatalogueRow === "string" ? values.lightweightCatalogueRow : null;
    const row = key && host.lightweightRow ? host.lightweightRow(key) : null;
    return { ...base, massive: false, catalogueRow: key, rwDb: row?.rwDb ?? null, lnwDb: row?.lnwDb ?? null, dnfwDb: row?.dnfwDb ?? num(values.flankingLevelDifference),
      basis: row ? `${row.ref}: ${row.description}` : null, reason: key && !row ? "catalogue_row_unknown" : null };
  }
  if (!construction && !material) return { ...base, massive: true, reason: "construction_missing" };
  const kind = classifyMassiveWall(construction, material);
  if ("reason" in kind) return { ...base, massive: true, reason: kind.reason === "not_massive" ? "construction_missing" : kind.reason };
  if (!host.massiveRw) return { ...base, massive: true, reason: "catalogue_missing" };
  const input: MassiveWallInput = { ...kind, thicknessCm: num(values.thickness), densityKgM3: num(values.bulkDensity) };
  const result = host.massiveRw(input);
  if (result.status !== "calculated") return { ...base, massive: true, reason: result.reason };
  const element = { massKgM2: result.massKgM2, rwDb: result.rwDb };
  const screed = values.screedType === "mortar" || values.screedType === "mastic_asphalt" || values.screedType === "prefab";
  return { ...base, massive: true, ...element, basis: catalogueBasis(result, input), reason: null,
    lining: liningOf(values.liningType, values.liningMass, values.liningStiffness, values.liningCavity, componentType === "wall" ? values.liningSides : "both", element, host.lining),
    ...(componentType === "ceiling" ? { screedLining: screed ? liningOf("bonded", values.screedMass, values.screedStiffness, null, "both", element, host.lining) : null } : {}) };
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
const centroid = (polygon: Point2[]): Point2 => [polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length, polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length];

// ---- Assembly (pure) ---------------------------------------------------------

type Requirement = { lnwMaxDb: number; ref: string } | null;
type Screed = { type: ProofValue<string> | null; mass: ProofValue<number> | null; stiffness: ProofValue<number> | null };
type PlanWall = { id: string; name: string; ring: Point2[] };
export type InteriorAssemblyInput = {
  storeyId: string;
  clearHeight: number | null;
  /** Rooms with their unit, space type and use (exterior-noise room kind), which decide whose rooms are protected from whom. */
  rooms: Array<{ id: string; name: string; polygon: Point2[] | null; holes: Point2[][]; adjacentWallIds: Set<string>; ceilingIds: string[];
    spaceType?: string | null; apartmentUnit?: string | null; use?: string | null }>;
  walls: Array<{ id: string; name: string; ring: Point2[]; role: string | null; exterior?: boolean }>;
  ceilings: Array<{ id: string; name: string; role: ProofValue<string> | null; coversRoomIds: string[]; screed: Screed }>;
  /** The slab under this storey (the ceiling of the storey below), when the model has it, and its floating screed. */
  floorId: string | null;
  floorScreed?: Screed | null;
  elements: Map<string, InteriorElement>;
  /** Timber construction inputs per element: a wall's lining, a ceiling's underside and its screed's insulation. */
  timber?: Map<string, { wallLining: string | null; underside: string | null; screedInsulation: string | null }>;
  wallRequirement: (role: InteriorWallRole) => { rwMinDb: number; ref: string } | null;
  ceilingRequirement: (role: InteriorCeilingRole) => { rwMinDb: number | null; lnwMaxDb: number | null; lnwMaxLightweightDb?: number; ref: string } | null;
  airborne: (input: AirborneInput) => AirborneResult;
  impact: (input: ImpactInput) => ImpactResult;
  timberImpact?: Host["timberImpact"];
  /** Walls of the storeys above and below, in this storey's plan coordinates (aligned by the outline); absent where there is none. */
  wallsAbove?: PlanWall[];
  wallsBelow?: PlanWall[];
  /** The pack's lateral offset for a wall continuing past a flanking wall to form a cross junction; without it no vertical edge is a cross junction. */
  crossOffsetM?: number | null;
  /** Rooms of the storey above in this storey's plan coordinates, for impact sound from a hallway above. */
  roomsAbove?: Array<{ id: string; name: string; polygon: Point2[] | null; spaceType?: string | null }>;
  /** Doors of this storey with the wall they sit in and the room they lead into. */
  doors?: Array<{ id: string; name: string; wallId: string | null; roomId: string | null; role: ProofValue<string> | null; rw: ProofValue<number> | null; basis: ProofValue<string> | null;
    construction?: InteriorDoorCheck["construction"] }>;
  door?: (input: { rwDb: number; role: InteriorDoorRole }) => DoorResult;
  /** A door without a declared Rw from its leaf and seals. */
  doorCriteria?: (input: DoorConstruction & { role: InteriorDoorRole }) => DoorResult;
  wallWithDoorRequirement?: (role: InteriorDoorRole) => { rwMinDb: number; ref: string } | null;
  impactOther?: Host["impactOther"];
  hallwayFloorRequirement?: Requirement;
  /** Stairs of this storey in their stairwell room. */
  stairs?: Array<{ id: string; name: string; roomId: string | null; stairCase: ProofValue<string> | null; deltaLw: ProofValue<number> | null }>;
  stair?: Host["stair"];
  stairsRequirement?: Requirement;
  /** Building services of this storey in their room, mounted on a wall. */
  installations?: Array<{ id: string; name: string; roomId: string | null; wallId: string | null; kind: ProofValue<string> | null; proof: ProofValue<string> | null;
    level: ProofValue<number> | null; basis: ProofValue<string> | null; receivingUse: ProofValue<string> | null;
    buildUpConfirmed: ProofValue<boolean> | null; conditionsConfirmed: ProofValue<boolean> | null }>;
  service?: Host["service"];
  serviceRequirement?: (kind: ServiceKind, use: "living" | "work") => { maxDb: number; ref: string } | null;
};
const doorWallRoles = new Set(["stairwell", "corridor_partition"]);
const doorRoleOf = (door: { role: ProofValue<string> | null }) => door.role?.value === "to_dwelling_hallway" || door.role?.value === "to_habitable_room" ? door.role.value as InteriorDoorRole : null;
const protectedUses = new Set(["sleeping", "living", "office", "hospital_bedroom"]);
const commonSpaces = new Set(["common_corridor", "stairwell", "common_other"]);
type Room = InteriorAssemblyInput["rooms"][number];
/** Whether a room is protected: known from its use; null while its use is open. */
const isProtected = (room: Room) => room.use ? protectedUses.has(room.use) : null;
/** Whether a room belongs to another unit than the source: a common space is everyone's neighbour; unknown units count as other, which errs safe. */
const otherUnit = (source: Room, room: Room) => commonSpaces.has(source.spaceType ?? "") || !source.apartmentUnit || !room.apartmentUnit || source.apartmentUnit !== room.apartmentUnit;
const screedOf = (screed: Screed | null | undefined): { input: ImpactInput["screed"]; complete: boolean } => {
  const type = typeof screed?.type?.value === "string" ? screed.type.value : null;
  if (type === "none") return { input: null, complete: true };
  const mass = screed?.mass?.value ?? null, stiffness = screed?.stiffness?.value ?? null;
  if (!type || mass === null || stiffness === null) return { input: null, complete: false };
  return { input: { type: type as ScreedType, massKgM2: mass, stiffnessMNm3: stiffness }, complete: true };
};

const MIN_COMMON_M = 0.1, FLANK_DISTANCE_M = 0.6, MIN_EDGE_M = 0.3, SAMPLE_M = 0.05, ABOVE_OFFSET_M = 0.3;
/** How far past a flanking wall's face a wall continuing in line may start. */
const JOIN_M = 0.3;

export function assembleInteriorSound(input: InteriorAssemblyInput): { walls: InteriorWallCheck[]; ceilings: InteriorCeilingCheck[]; doors: InteriorDoorCheck[];
  impacts: InteriorImpactCheck[]; stairs: InteriorStairCheck[]; services: InteriorServiceCheck[];
  floorAssumed: boolean; wallsAboveAssumed: boolean; oneSidedLining: boolean; usedElementIds: Set<string> } {
  const h = input.clearHeight;
  // Every element a check reads, so the inputs list and suggestions cover exactly these.
  const usedElementIds = new Set<string>();
  const wallById = new Map(input.walls.map(wall => [wall.id, wall]));
  const roomById = new Map(input.rooms.map(room => [room.id, room]));
  let floorAssumed = false, wallsAboveAssumed = false, oneSidedLining = false;
  // The wall of another storey standing on or under a wall: parallel, within a wall thickness, overlapping most.
  const stacked = (ring: Point2[], others: PlanWall[] | undefined) => {
    const below = axisOf(ring), [b0, b1] = span(ring, below.axis);
    let best: { wall: PlanWall; overlap: number } | null = null;
    for (const wall of others ?? []) {
      const above = axisOf(wall.ring);
      if (Math.abs(dot(above.axis, below.axis)) < 0.95 || Math.abs(dot(above.centre, below.normal) - dot(below.centre, below.normal)) > ABOVE_OFFSET_M) continue;
      const [a0, a1] = span(wall.ring, below.axis), overlap = Math.min(a1, b1) - Math.max(a0, b0);
      if (overlap >= MIN_EDGE_M && (!best || overlap > best.overlap)) best = { wall, overlap };
    }
    return best?.wall ?? null;
  };
  const gapOf = (element: InteriorElement | undefined, id: string, name: string, reason?: InteriorElementReason | null): InteriorGap[] => {
    usedElementIds.add(id);
    if (!element) return [{ code: "element", elementId: id, elementName: name, reason: "construction_missing" }];
    const found = reason ?? element.reason;
    return found ? [{ code: "element", elementId: element.id, elementName: element.name, reason: found }] : [];
  };
  /** A flanking element: massive by its catalogue values, lightweight by its Dn,f,w. */
  const flankingGap = (element: InteriorElement | undefined, id: string, name: string) =>
    gapOf(element, id, name, element && !element.massive && element.dnfwDb === null && !element.reason ? "flanking_level_difference_missing" : null);
  /** A separating element: massive by its catalogue values, lightweight by its catalogue Rw. */
  const separatingGap = (element: InteriorElement | undefined, id: string, name: string) =>
    gapOf(element, id, name, element && !element.massive && element.rwDb === null && !element.reason ? "lightweight_separating" : null);
  const ready = (element: InteriorElement | undefined): element is InteriorElement => Boolean(element && !element.reason && (element.massive || element.dnfwDb !== null));
  /** A wall's lining in one room: both faces, or the inner face of an exterior wall; a one-sided lining of an inner wall counts only where it worsens. */
  const faceLining = (element: InteriorElement, exterior: boolean) => {
    const lining = element.lining;
    if (!lining || lining.deltaRwDb === null) return 0;
    if (lining.sides === "both" || exterior) return lining.deltaRwDb;
    return Math.min(lining.deltaRwDb, 0);
  };
  const flank = (element: InteriorElement, areaM2: number, liningDb = 0): FlankElement => element.massive
    ? { kind: "massive", id: element.id, name: element.name, massKgM2: element.massKgM2!, rwDb: element.rwDb!, areaM2, ...(liningDb ? { liningDb } : {}) }
    : { kind: "lightweight", id: element.id, name: element.name, dnfwDb: element.dnfwDb! };
  const separatingOf = (element: InteriorElement, lining: { source: number; receiving: number }): AirborneInput["separating"] => element.massive
    ? { id: element.id, name: element.name, massKgM2: element.massKgM2!, rwDb: element.rwDb!, ...(lining.source || lining.receiving ? { liningDb: lining } : {}) }
    : { id: element.id, name: element.name, massKgM2: null, rwDb: element.rwDb!, lightweight: true };
  /** Of two calculated results the lower value; the side of a one-sided lining is not known. */
  const lower = (a: AirborneResult, b: AirborneResult) => a.status === "calculated" && b.status === "calculated" ? (b.valueDb < a.valueDb ? b : a) : a;
  const unique = (gaps: InteriorGap[]) => [...new Map(gaps.map(gap => [JSON.stringify(gap), gap])).values()];

  const walls: InteriorWallCheck[] = [];
  const pairs: Array<{ wall: InteriorAssemblyInput["walls"][number]; a: Room; b: Room; separating: InteriorElement | undefined }> = [];
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
    // Whether a wall in line with this one continues past a flanking wall at an edge: a cross junction rather than a T.
    const continuesPast = (flanking: PlanWall, sign: 1 | -1) => {
      if (input.crossOffsetM == null) return false;
      const offset = input.crossOffsetM;
      const [f0, f1] = span(flanking.ring, axis), face = sign > 0 ? f1 : f0;
      return input.walls.some(other => {
        if (other.id === flanking.id) return false;
        const along = axisOf(other.ring);
        if (Math.abs(dot(along.axis, axis)) < 0.95 || Math.abs(dot(along.centre, normal) - dot(centre, normal)) > offset) return false;
        const [o0, o1] = span(other.ring, axis);
        return sign > 0 ? o0 <= face + JOIN_M && o1 > face + JOIN_M : o1 >= face - JOIN_M && o0 < face - JOIN_M;
      });
    };
    for (const { room: a, mask: maskA } of left) for (const { room: b, mask: maskB } of right) {
      const shared = positions.flatMap((p, i) => maskA[i] && maskB[i] ? [p] : []);
      // Rooms only diagonal to each other share no separating area; that case is not covered.
      if (shared.length * step < MIN_COMMON_M) continue;
      const from = shared[0]! - step / 2, to = shared[shared.length - 1]! + step / 2;
      const length = shared.length * step;
      const gaps: InteriorGap[] = [];
      if (h === null) gaps.push({ code: "clear_height" });
      const separating = input.elements.get(wall.id);
      gaps.push(...separatingGap(separating, wall.id, wall.name));
      pairs.push({ wall, a, b, separating });
      const flankingAt = (room: Room, p: Point2) => {
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
        if (!f || !r) { shownEdges.push({ edge, source: f?.name ?? null, receiving: r?.name ?? null }); gaps.push({ code: "flanking_missing", edge }); continue; }
        const junction = continuesPast(f, edge === "start" ? -1 : 1) ? "cross" as const : "t" as const;
        shownEdges.push({ edge, source: f.name, receiving: r.name, junction });
        const fe = input.elements.get(f.id), re = input.elements.get(r.id);
        gaps.push(...flankingGap(fe, f.id, f.name), ...flankingGap(re, r.id, r.name));
        if (ready(fe) && ready(re) && h !== null)
          edges.push({ edge, couplingLengthM: h, junction, source: flank(fe, overlapAlongWall(a.polygon!, f.ring) * h, faceLining(fe, Boolean(f.exterior))),
            receiving: flank(re, overlapAlongWall(b.polygon!, r.ring) * h, faceLining(re, Boolean(r.exterior))) });
      }
      // Top: the ceiling over both rooms, its underside facing them. Bottom: the slab under the storey, its screed facing them; else taken to equal the ceiling.
      for (const edge of ["top", "bottom"] as const) {
        const pick = (room: Room) => edge === "top" || !input.floorId ? room.ceilingIds[0] ?? null : input.floorId;
        const fid = pick(a), rid = pick(b);
        if (edge === "bottom" && !input.floorId) floorAssumed = true;
        const fe = fid ? input.elements.get(fid) : undefined, re = rid ? input.elements.get(rid) : undefined;
        // The wall continuing on the other storey makes the junction a cross.
        const junction = stacked(wall.ring, edge === "top" ? input.wallsAbove : input.wallsBelow) ? "cross" as const : "t" as const;
        shownEdges.push({ edge, source: fe?.name ?? null, receiving: re?.name ?? null, junction });
        if (!fid || !rid) { gaps.push({ code: "ceiling_missing" }); continue; }
        gaps.push(...flankingGap(fe, fid, fe?.name ?? fid), ...flankingGap(re, rid, re?.name ?? rid));
        const areaA = areaOf(a), areaB = areaOf(b);
        const face = (element: InteriorElement) => (edge === "top" ? element.lining?.deltaRwDb : element.screedLining?.deltaRwDb) ?? 0;
        if (ready(fe) && ready(re) && areaA && areaB) edges.push({ edge, couplingLengthM: length, junction, source: flank(fe, areaA, face(fe)), receiving: flank(re, areaB, face(re)) });
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
      let result: AirborneResult | null = null;
      if (!finalGaps.length && requirement && area !== null && separating) {
        const run = (lining: { source: number; receiving: number }) => input.airborne({ separating: separatingOf(separating, lining), separatingAreaM2: length * h!,
          transmission: "horizontal", edges, requiredDb: requirement!.rwMinDb });
        const lining = separating.massive ? separating.lining : null, d = lining?.deltaRwDb ?? 0;
        if (lining && d && lining.sides !== "both") { oneSidedLining = true; result = lower(run({ source: d, receiving: 0 }), run({ source: 0, receiving: d })); }
        else result = run({ source: d, receiving: d });
      }
      walls.push({ id: `${wall.id}:${a.id}:${b.id}`, storeyId: input.storeyId, wallId: wall.id, wallName: wall.name, role,
        rooms: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], lengthM: round2(length), areaM2: area, requirement, edges: shownEdges, gaps: finalGaps, result });
    }
  }

  const ceilings: InteriorCeilingCheck[] = [];
  for (const ceiling of input.ceilings) {
    const role = typeof ceiling.role?.value === "string" ? ceiling.role.value : null;
    if (role === "internal") continue;
    const requirement = role ? input.ceilingRequirement(role as InteriorCeilingRole) : null;
    const slab = input.elements.get(ceiling.id);
    const timber = input.timber?.get(ceiling.id);
    for (const room of input.rooms.filter(item => ceiling.coversRoomIds.includes(item.id))) {
      const gaps: InteriorGap[] = [];
      if (!role) gaps.push({ code: "ceiling_role" });
      else if (!requirement) gaps.push({ code: "no_requirement" });
      if (h === null) gaps.push({ code: "clear_height" });
      gaps.push(...separatingGap(slab, ceiling.id, ceiling.name));
      const area = areaOf(room);
      if (!area) gaps.push({ code: "geometry" });
      const screed = screedOf(ceiling.screed);
      if (!screed.complete) gaps.push({ code: "screed" });
      // The room's walls flank the ceiling below it; above it, the wall of the storey above standing on each, else the same wall taken to continue.
      const edges: FlankingEdge[] = [], masses: number[] = [], linings: string[] = [];
      let timberWalls = true;
      for (const wallId of room.adjacentWallIds) {
        const wall = wallById.get(wallId);
        if (!wall || !room.polygon) continue;
        const lf = overlapAlongWall(room.polygon, wall.ring);
        if (lf < MIN_EDGE_M) continue;
        const element = input.elements.get(wallId);
        gaps.push(...flankingGap(element, wallId, wall.name));
        const upper = stacked(wall.ring, input.wallsAbove), upperElement = upper ? input.elements.get(upper.id) : element;
        if (upper) gaps.push(...flankingGap(upperElement, upper.id, upper.name)); else wallsAboveAssumed = true;
        const lining = input.timber?.get(wallId)?.wallLining;
        if (lining) linings.push(lining); else timberWalls = false;
        if (!ready(element) || !ready(upperElement) || h === null) continue;
        // An inner wall has the slab continuing past it: a cross junction; an exterior wall a T.
        const exterior = Boolean(wall.exterior);
        edges.push({ edge: wall.name, couplingLengthM: lf, junction: exterior ? "t" : "cross", source: flank(upperElement, lf * h, faceLining(upperElement, exterior)),
          receiving: flank(element, lf * h, faceLining(element, exterior)) });
        if (element.massive) masses.push(element.massKgM2!);
      }
      const finalGaps = unique(gaps);
      const blocked = finalGaps.some(gap => gap.code !== "screed") || !slab || !area;
      const airborne = blocked || requirement?.rwMinDb == null ? null : input.airborne({
        separating: separatingOf(slab!, { source: slab!.screedLining?.deltaRwDb ?? 0, receiving: slab!.lining?.deltaRwDb ?? 0 }),
        separatingAreaM2: area!, transmission: "vertical", edges, requiredDb: requirement.rwMinDb });
      let impact: InteriorCeilingCheck["impact"] = null;
      if (!blocked && !finalGaps.length && requirement?.lnwMaxDb != null) {
        if (slab!.massive) impact = input.impact({ slabMassKgM2: slab!.massKgM2!, screed: screed.input, flankingMassesKgM2: masses, maxDb: requirement.lnwMaxDb });
        else if (input.timberImpact && slab!.lnwDb != null) {
          const screedType = ceiling.screed.type?.value;
          const screedClass = screedType === "prefab" ? "prefab" : timber?.screedInsulation === "wood_fibre" || timber?.screedInsulation === "mineral" ? timber.screedInsulation : null;
          if (timber?.underside && screedClass && timberWalls && linings.length)
            impact = input.timberImpact({ lnwDb: slab!.lnwDb, underside: timber.underside as TimberCeilingUnderside, wallLinings: linings as TimberWallLining[],
              screed: screedClass, maxDb: requirement.lnwMaxLightweightDb ?? requirement.lnwMaxDb });
          else finalGaps.push({ code: "element", elementId: ceiling.id, elementName: ceiling.name, reason: "timber_inputs_missing" });
        }
      }
      ceilings.push({ id: `${ceiling.id}:${room.id}`, storeyId: input.storeyId, ceilingId: ceiling.id, ceilingName: ceiling.name, role: ceiling.role,
        room: { id: room.id, name: room.name }, areaM2: area, requirement, screed: ceiling.screed, gaps: finalGaps, airborne, impact });
    }
  }

  // Impact sound from a common hallway into the protected rooms beside it, and from the hallway above into those diagonally below.
  const impacts: InteriorImpactCheck[] = [];
  const ceilingById = new Map(input.ceilings.map(ceiling => [ceiling.id, ceiling]));
  for (const { wall, a, b, separating } of pairs) {
    if (wall.role !== "corridor_partition") continue;
    for (const [source, room] of [[a, b], [b, a]] as const) {
      if (source.spaceType !== "common_corridor" || commonSpaces.has(room.spaceType ?? "") || isProtected(room) === false) continue;
      const roomAbove = source.polygon && input.roomsAbove?.find(item => item.polygon && inside(centroid(source.polygon!), item.polygon));
      const cases: Array<{ position: InteriorImpactCheck["position"]; slabId: string | null; screed: Screed | null | undefined }> = [
        { position: "beside", slabId: input.floorId ?? source.ceilingIds[0] ?? null, screed: input.floorId ? input.floorScreed : ceilingById.get(source.ceilingIds[0] ?? "")?.screed },
        ...(roomAbove?.spaceType === "common_corridor" ? [{ position: "diagonal_below" as const, slabId: source.ceilingIds[0] ?? null, screed: ceilingById.get(source.ceilingIds[0] ?? "")?.screed }] : []),
      ];
      for (const item of cases) {
        if (item.position === "beside" && !input.floorId) floorAssumed = true;
        const slab = item.slabId ? input.elements.get(item.slabId) : undefined;
        // Lightweight floors have no method for other directions.
        if (slab && !slab.massive) continue;
        const gaps: InteriorGap[] = [];
        if (isProtected(room) === null) gaps.push({ code: "room_use" });
        if (!input.hallwayFloorRequirement) gaps.push({ code: "no_requirement" });
        if (!item.slabId) gaps.push({ code: "ceiling_missing" }); else gaps.push(...gapOf(slab, item.slabId, slab?.name ?? item.slabId));
        gaps.push(...gapOf(separating, wall.id, wall.name));
        const screed = screedOf(item.screed);
        if (!screed.complete) gaps.push({ code: "screed" });
        const finalGaps = unique(gaps);
        impacts.push({ id: `${item.position}:${wall.id}:${source.id}:${room.id}`, storeyId: input.storeyId, position: item.position,
          source: { id: source.id, name: source.name }, room: { id: room.id, name: room.name }, wall: { id: wall.id, name: wall.name },
          slab: slab ? { id: slab.id, name: slab.name } : null, requirement: input.hallwayFloorRequirement ?? null, gaps: finalGaps,
          result: finalGaps.length || !input.impactOther || !separating?.massive ? null : input.impactOther({ slabMassKgM2: slab!.massKgM2!, screed: screed.input,
            position: item.position, wallMassKgM2: separating.massKgM2!, maxDb: input.hallwayFloorRequirement!.lnwMaxDb }) });
      }
    }
  }

  // Stairs against the protected rooms behind their stairwell's walls.
  const stairs: InteriorStairCheck[] = [];
  for (const stair of input.stairs ?? []) {
    const before = stairs.length;
    for (const { wall, a, b, separating } of pairs) {
      if (wall.role !== "stairwell" || (a.id !== stair.roomId && b.id !== stair.roomId)) continue;
      const room = a.id === stair.roomId ? b : a;
      if (isProtected(room) === false || commonSpaces.has(room.spaceType ?? "")) continue;
      const gaps: InteriorGap[] = [];
      if (isProtected(room) === null) gaps.push({ code: "room_use" });
      const stairCase = typeof stair.stairCase?.value === "string" ? stair.stairCase.value as StairCase : null;
      if (!stairCase) gaps.push({ code: "stair_case" });
      if (!input.stairsRequirement) gaps.push({ code: "no_requirement" });
      usedElementIds.add(wall.id);
      const finalGaps = unique(gaps);
      stairs.push({ id: `${stair.id}:${wall.id}:${room.id}`, storeyId: input.storeyId, stair: { id: stair.id, name: stair.name }, room: { id: room.id, name: room.name },
        wall: { id: wall.id, name: wall.name }, stairCase: stair.stairCase, deltaLw: stair.deltaLw, requirement: input.stairsRequirement ?? null, gaps: finalGaps,
        // A missing covering errs high: the bare stair's tabled level applies.
        result: finalGaps.length || !input.stair ? null : input.stair({ stairCase: stairCase!, coveringDeltaLwDb: stair.deltaLw?.value ?? null,
          wallMassKgM2: separating?.massive && !separating.reason ? separating.massKgM2 : null, maxDb: input.stairsRequirement!.lnwMaxDb, requirementRef: input.stairsRequirement!.ref }) });
    }
    // A stair whose room has no stairwell wall to a protected room still shows, so its room and walls can be set.
    if (stairs.length === before) stairs.push({ id: stair.id, storeyId: input.storeyId, stair: { id: stair.id, name: stair.name }, room: null, wall: null,
      stairCase: stair.stairCase, deltaLw: stair.deltaLw, requirement: input.stairsRequirement ?? null, gaps: [{ code: "stair_wall" }], result: null });
  }

  // Building services: the mounting wall against the reference installation walls, or a measured level against the requirement.
  const services: InteriorServiceCheck[] = [];
  for (const item of input.installations ?? []) {
    const source = item.roomId ? roomById.get(item.roomId) : undefined, wall = item.wallId ? wallById.get(item.wallId) : undefined;
    const kind = item.kind?.value === "sanitary" || item.kind?.value === "other" ? item.kind.value as ServiceKind : null;
    const method = item.proof?.value === "reference_wall" || item.proof?.value === "level" ? item.proof.value : null;
    const gaps: InteriorGap[] = [];
    if (!kind) gaps.push({ code: "installation_kind" });
    if (!method) gaps.push({ code: "installation_proof" });
    const borders = source && wall ? input.rooms.filter(room => room.id !== source.id && room.adjacentWallIds.has(wall.id) && isProtected(room) !== false
      && !commonSpaces.has(room.spaceType ?? "") && otherUnit(source, room)) : [];
    const use = item.receivingUse?.value === "work" ? "work" : "living";
    const requirement = kind && method === "level" ? input.serviceRequirement?.(kind, use) ?? null : null;
    let request: ServiceInput | null = null;
    if (method === "reference_wall") {
      const element = wall ? input.elements.get(wall.id) : undefined;
      if (!wall) gaps.push({ code: "installation_wall" }); else gaps.push(...gapOf(element, wall.id, wall.name));
      const floor = input.floorId ? input.elements.get(input.floorId) : undefined;
      if (kind && element && !element.reason) request = { method, kind, bordersProtectedRoom: borders.length > 0, conditionsConfirmed: item.conditionsConfirmed?.value === true,
        wall: element.massive ? { massive: true, massKgM2: element.massKgM2! } : { massive: false, buildUpConfirmed: item.buildUpConfirmed?.value === true, slabMassKgM2: floor?.massive ? floor.massKgM2 : null } };
    } else if (method === "level") {
      if (!item.level) gaps.push({ code: "service_level" });
      else if (kind) { if (!requirement) gaps.push({ code: "no_requirement" }); request = { method, valueDb: item.level.value, requirement }; }
    }
    const finalGaps = unique(gaps);
    services.push({ id: item.id, storeyId: input.storeyId, name: item.name, room: source ? { id: source.id, name: source.name } : null, wall: wall ? { id: wall.id, name: wall.name } : null,
      kind: item.kind, proof: item.proof, level: item.level, basis: item.basis, receivingUse: item.receivingUse, buildUpConfirmed: item.buildUpConfirmed, conditionsConfirmed: item.conditionsConfirmed,
      borders: borders.map(room => ({ id: room.id, name: room.name })), requirement, gaps: finalGaps,
      result: finalGaps.length || !request || !input.service ? null : input.service(request) });
  }

  // Doors in stairwell and corridor walls, and any door given an entrance role.
  const doors: InteriorDoorCheck[] = [];
  for (const door of input.doors ?? []) {
    const wall = door.wallId ? wallById.get(door.wallId) : undefined;
    if (door.role?.value === "internal" || (!door.role && !(wall?.role && doorWallRoles.has(wall.role)))) continue;
    const doorRole = doorRoleOf(door);
    const gaps: InteriorDoorCheck["gaps"] = [];
    const construction = door.construction ?? { leafRw: null, leafType: null, rebateSeal: null, floorSeal: null };
    const { leafRw, leafType, rebateSeal, floorSeal } = construction;
    const built = leafRw && (leafType?.value === "rebated" || leafType?.value === "flush") && rebateSeal && floorSeal
      ? { leafRwDb: leafRw.value, leafType: leafType.value as DoorConstruction["leafType"], rebateSealDb: rebateSeal.value, floorSealDb: floorSeal.value } : null;
    if (!doorRole) gaps.push("door_role");
    // A declared Rw decides; without one, the leaf and seals under the catalogue criteria.
    const result = !doorRole ? null : door.rw && input.door ? input.door({ rwDb: door.rw.value, role: doorRole })
      : built && input.doorCriteria ? input.doorCriteria({ ...built, role: doorRole }) : null;
    if (!door.rw && !built) gaps.push("door_rw");
    if (result?.status === "unsupported" && result.reason === "no_requirement") gaps.push("no_requirement");
    if (result?.status === "unsupported" && result.reason === "criteria_not_applicable") gaps.push("criteria_not_applicable");
    doors.push({ id: door.id, storeyId: input.storeyId, name: door.name, wall: wall ? { id: wall.id, name: wall.name } : null,
      room: door.roomId && roomById.has(door.roomId) ? { id: door.roomId, name: roomById.get(door.roomId)!.name } : null,
      role: door.role, rw: door.rw, basis: door.basis, construction,
      requirement: result?.status === "calculated" ? { rwMinDb: result.requiredDb, ref: result.refs[0]! } : null, gaps,
      result: result?.status === "calculated" ? result : null });
  }
  return { walls, ceilings, doors, impacts, stairs, services, floorAssumed, wallsAboveAssumed, oneSidedLining, usedElementIds };
}

// ---- Reading -----------------------------------------------------------------

const valueKeys = ["construction", "material", "thickness", "bulkDensity", "flankingLevelDifference", "lightweightCatalogueRow", "liningType", "liningMass", "liningStiffness", "liningCavity", "liningSides",
  "screedType", "screedMass", "screedStiffness"] as const;
const doorKeys = ["doorRole", "soundReductionIndex", "soundReductionIndexBasis", "doorLeafSoundReduction", "doorLeafType", "rebateSealSoundReduction", "floorSealSoundReduction"];
const stairKeys = ["stairCase", "impactSoundReduction"];
const installationKeys = ["installationKind", "installationProof", "serviceSoundLevel", "serviceSoundLevelBasis", "serviceReceivingUse", "referenceBuildUpConfirmed", "installationConditionsConfirmed"];
const roomKeys = ["apartmentUnit", "spaceType", "exteriorNoiseRoom"];
const elementKeys = ["componentType", ...valueKeys, "wallRole", "ceilingRole", "timberWallLining", "timberCeilingUnderside", "screedInsulation", ...doorKeys, ...stairKeys, ...installationKeys];

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
  const values = await currentValues(d, modelId, [...elementRows.map(row => row.id), ...roomRows.map(row => row.id), ...storeyRows.map(row => row.id), ...(building ? [building.id] : [])],
    [...elementKeys, ...roomKeys, "clearRoomHeight", "soundInsulationLevel"]);
  const raw = (entityId: string, key: string) => values.get(`${entityId}:${key}`) ?? null;
  const value = <T,>(entityId: string, key: string) => {
    const found = raw(entityId, key);
    return found ? { value: found.value, reviewStatus: found.reviewStatus, provenance: found.provenance, propertyId: found.propertyId, version: found.version, reviewRevision: found.reviewRevision } as ProofValue<T> : null;
  };
  const typeOf = (row: any) => { const declared = raw(row.id, "componentType")?.value;
    return declared === "wall" || declared === "ceiling" ? declared : row.kind === "draft_wall" ? "wall" : row.kind === "draft_ceiling" ? "ceiling" : null; };
  const text = (entityId: string, key: string) => { const found = raw(entityId, key)?.value; return typeof found === "string" ? found : null; };
  const elements = new Map<string, InteriorElement>();
  const timber = new Map<string, { wallLining: string | null; underside: string | null; screedInsulation: string | null }>();
  for (const row of elementRows) {
    const type = typeOf(row);
    if (!type || row.constructionState === "demolished") continue;
    elements.set(row.id, { ...evaluateElement(row.id, row.name, type, Object.fromEntries(valueKeys.map(key => [key, raw(row.id, key)?.value ?? null])) as Values,
      { massiveRw: host.massiveRw, lightweightRow: host.lightweightRow, lining: host.lining }), storeyId: row.storeyId ?? null });
    timber.set(row.id, { wallLining: text(row.id, "timberWallLining"), underside: text(row.id, "timberCeilingUnderside"), screedInsulation: text(row.id, "screedInsulation") });
  }
  const adjacent = new Map<string, Set<string>>(), covers = new Map<string, string[]>(), underStorey = new Map<string, string>(), hostOf = new Map<string, string>();
  for (const row of relationships) {
    if (row.relationshipType === "opening_in") hostOf.set(row.fromEntityId, row.toEntityId);
    else if (row.relationshipType === "separates") adjacent.set(row.toEntityId, (adjacent.get(row.toEntityId) ?? new Set()).add(row.fromEntityId));
    else if (row.relationshipType === "covers") covers.set(row.fromEntityId, [...(covers.get(row.fromEntityId) ?? []), row.toEntityId]);
    else underStorey.set(row.fromEntityId, row.toEntityId);
  }
  const ceilingRows = elementRows.filter(row => elements.get(row.id)?.componentType === "ceiling");
  const ofType = (type: string) => elementRows.filter(row => row.constructionState !== "demolished" && (raw(row.id, "componentType")?.value ?? row.kind) === type);
  const doorRows = ofType("door"), stairRows = ofType("stair"), installationRows = ofType("installation");
  const walls: InteriorWallCheck[] = [], ceilings: InteriorCeilingCheck[] = [], doors: InteriorDoorCheck[] = [], storeys: Extract<InteriorSoundProof, { available: true }>["storeys"] = [];
  const impacts: InteriorImpactCheck[] = [], stairs: InteriorStairCheck[] = [], services: InteriorServiceCheck[] = [];
  const places: Extract<InteriorSoundProof, { available: true }>["places"] = [];
  let floorAssumed = false, wallsAboveAssumed = false, oneSidedLining = false;
  const used = new Set<string>();
  const levelOf = await storeyLevels(d, modelId, storeyRows);
  // The agreed level decides the requirements; an elevated level the pack has no table for is checked against the minimum and said so.
  const agreed = (raw(building?.id ?? "", "soundInsulationLevel")?.value as string | undefined) ?? null;
  const requirements = (agreed === "elevated" ? host.requirements("elevated") : null) ?? host.requirements("statutory_minimum");
  if (!requirements) return { available: false, reason: "norm_pack_missing" };
  const exteriorRings = (page: SitePlanPage) => page.walls.filter(wall => wall.exterior).map(wall => wall.ring);
  // The plan of the storey one level up or down, shifted onto this plan by the building outline; none when it does not fit.
  const neighbourOf = (page: SitePlanPage, step: 1 | -1) => {
    const level = levelOf.get(page.storey!.id);
    const other = level == null ? undefined : pages.find(item => item.storey && levelOf.get(item.storey.id) === level + step);
    const aligned = other && alignPlanOutline(exteriorRings(page), exteriorRings(other));
    if (!other || !aligned || aligned.fitM > STOREY_FIT_M) return undefined;
    const shift = ([x, y]: Point2): Point2 => [x + aligned.offset[0], y + aligned.offset[1]];
    return { page: other, walls: other.walls.map(wall => ({ id: wall.id, name: wall.name, ring: wall.ring.map(shift) })), shift };
  };
  const roomsOf = (page: SitePlanPage) => roomRows.filter(room => room.storeyId === page.storey!.id && room.geometry?.source?.sourceVersionId === page.sourceVersionId && room.geometry?.source?.page === page.page);
  const metres = (page: SitePlanPage) => (point: { x: unknown; y: unknown }): Point2 => [Number(point.x) * page.scale.pageAspectRatio * page.scale.metresPerPageHeight, Number(point.y) * page.scale.metresPerPageHeight];
  for (const page of pages) {
    const storey = storeyRows.find(row => row.id === page.storey!.id);
    if (!storey) continue;
    const toMetres = metres(page);
    const rooms = roomsOf(page);
    const wallName = new Map(page.walls.map(wall => [wall.id, wall.name]));
    places.push(...rooms.map(room => ({ roomId: room.id as string, roomName: room.name as string, storeyId: storey.id as string,
      walls: [...(adjacent.get(room.id) ?? [])].filter(id => wallName.has(id)).map(id => ({ id, name: wallName.get(id)! })) })));
    const above = neighbourOf(page, 1), below = neighbourOf(page, -1);
    const floorRow = ceilingRows.find(row => underStorey.get(row.id) === storey.id);
    const screedValues = (id: string) => ({ type: value<string>(id, "screedType"), mass: value<number>(id, "screedMass"), stiffness: value<number>(id, "screedStiffness") });
    const opening = (row: any) => ({ id: row.id as string, name: row.name as string, roomId: (row.roomId ?? null) as string | null });
    const roomIds = new Set(rooms.map(room => room.id));
    const clearHeight = value<number>(storey.id, "clearRoomHeight");
    storeys.push({ id: storey.id, name: storey.name, sourceVersionId: page.sourceVersionId, fileName: page.fileName, page: page.page, clearHeight });
    const storeyCeilings = ceilingRows.filter(row => (covers.get(row.id) ?? []).some(id => roomIds.has(id)));
    const assembled = assembleInteriorSound({
      storeyId: storey.id, clearHeight: typeof clearHeight?.value === "number" ? clearHeight.value : null,
      rooms: rooms.map(room => ({ id: room.id, name: room.name, polygon: Array.isArray(room.geometry?.polygon) ? room.geometry.polygon.map(toMetres) : null,
        holes: Array.isArray(room.geometry?.holes) ? room.geometry.holes.filter(Array.isArray).map((hole: any[]) => hole.map(toMetres)) : [],
        adjacentWallIds: adjacent.get(room.id) ?? new Set(), ceilingIds: storeyCeilings.filter(row => covers.get(row.id)!.includes(room.id)).map(row => row.id),
        spaceType: text(room.id, "spaceType"), apartmentUnit: text(room.id, "apartmentUnit"), use: text(room.id, "exteriorNoiseRoom") })),
      walls: page.walls.map(wall => ({ id: wall.id, name: wall.name, ring: wall.ring, role: text(wall.id, "wallRole"), exterior: Boolean(wall.exterior) })),
      ceilings: storeyCeilings.map(row => ({ id: row.id, name: row.name, role: value<string>(row.id, "ceilingRole"), coversRoomIds: covers.get(row.id) ?? [], screed: screedValues(row.id) })),
      floorId: floorRow?.id ?? null, floorScreed: floorRow ? screedValues(floorRow.id) : null, timber,
      elements, wallRequirement: requirements.wall, ceilingRequirement: requirements.ceiling, airborne: host.airborne, impact: host.impact, timberImpact: host.timberImpact,
      wallsBelow: below?.walls,
      roomsAbove: above && roomsOf(above.page).map(room => ({ id: room.id, name: room.name, spaceType: text(room.id, "spaceType"),
        polygon: Array.isArray(room.geometry?.polygon) ? room.geometry.polygon.map(metres(above.page)).map(above.shift) : null })),
      impactOther: host.impactOther, hallwayFloorRequirement: requirements.hallwayFloor,
      stairs: stairRows.filter(row => row.storeyId === storey.id).map(row => ({ ...opening(row), stairCase: value<string>(row.id, "stairCase"), deltaLw: value<number>(row.id, "impactSoundReduction") })),
      stair: host.stair, stairsRequirement: requirements.stairs, crossOffsetM: host.crossJunctionOffsetM,
      installations: installationRows.filter(row => row.storeyId === storey.id).map(row => ({ ...opening(row), wallId: hostOf.get(row.id) ?? null,
        kind: value<string>(row.id, "installationKind"), proof: value<string>(row.id, "installationProof"), level: value<number>(row.id, "serviceSoundLevel"),
        basis: value<string>(row.id, "serviceSoundLevelBasis"), receivingUse: value<string>(row.id, "serviceReceivingUse"),
        buildUpConfirmed: value<boolean>(row.id, "referenceBuildUpConfirmed"), conditionsConfirmed: value<boolean>(row.id, "installationConditionsConfirmed") })),
      service: host.service, serviceRequirement: requirements.service,
      doors: doorRows.filter(row => row.storeyId === storey.id).map(row => ({ id: row.id, name: row.name, wallId: hostOf.get(row.id) ?? null, roomId: row.roomId ?? null,
        role: value<string>(row.id, "doorRole"), rw: value<number>(row.id, "soundReductionIndex"), basis: value<string>(row.id, "soundReductionIndexBasis"),
        construction: { leafRw: value<number>(row.id, "doorLeafSoundReduction"), leafType: value<string>(row.id, "doorLeafType"),
          rebateSeal: value<number>(row.id, "rebateSealSoundReduction"), floorSeal: value<number>(row.id, "floorSealSoundReduction") } })),
      door: host.door && (input => host.door!({ rwDb: input.rwDb, requirement: requirements.door(input.role) })),
      doorCriteria: host.doorCriteria && (input => host.doorCriteria!({ ...input, requirement: requirements.door(input.role) })), wallWithDoorRequirement: requirements.wallWithDoor, wallsAbove: above?.walls,
    });
    walls.push(...assembled.walls); ceilings.push(...assembled.ceilings); doors.push(...assembled.doors);
    impacts.push(...assembled.impacts); stairs.push(...assembled.stairs); services.push(...assembled.services);
    floorAssumed ||= assembled.floorAssumed;
    wallsAboveAssumed ||= assembled.wallsAboveAssumed;
    oneSidedLining ||= assembled.oneSidedLining;
    for (const id of assembled.usedElementIds) used.add(id);
  }
  const limitations: InteriorLimitation[] = [...(agreed && agreed !== "statutory_minimum" && requirements.level !== "elevated" ? ["minimum_requirements_only" as const] : []), "junction_types"];
  if (oneSidedLining) limitations.push("linings_one_side");
  if (!host.door) limitations.push("doors_not_checked");
  if (floorAssumed) limitations.push("floor_like_ceiling");
  if (ceilings.length) limitations.push(...(wallsAboveAssumed ? ["walls_above_like_below" as const] : []), "impact_hallways_only");
  if (ceilings.some(check => check.impact && "k1Db" in check.impact) || [...elements.values()].some(element => element.componentType === "ceiling" && !element.massive)) limitations.push("timber_impact_vertical");
  if (stairs.length) limitations.push("stairs_room_behind_wall");
  if (services.length) limitations.push("services_execution");
  type Entity = [ProofSuggestion["entityType"], string, string];
  // Doors carry their role and Rw, stairs and installations their own keys; walls and ceilings their build-up (an exterior wall's Rw belongs to the exterior check).
  const own = new Set([...doorKeys, ...stairKeys, ...installationKeys, ...roomKeys]);
  const checkedRooms = new Set([...walls.flatMap(check => check.rooms.map(room => room.id)), ...ceilings.map(check => check.room.id)]);
  const suggestions = [
    ...await suggestionsOf(d, values as Map<string, CurrentValue>, [...storeys.map(storey => ["storey", storey.id, storey.name] as Entity),
      ...elementRows.filter(row => used.has(row.id)).map(row => ["element", row.id, row.name] as Entity)], interiorSoundInputKeys.filter(key => !own.has(key))),
    ...await suggestionsOf(d, values as Map<string, CurrentValue>, doors.map(door => ["element", door.id, door.name] as Entity), doorKeys),
    ...await suggestionsOf(d, values as Map<string, CurrentValue>, [...stairRows, ...installationRows].map(row => ["element", row.id, row.name] as Entity), [...stairKeys, ...installationKeys]),
    ...await suggestionsOf(d, values as Map<string, CurrentValue>, roomRows.filter(room => checkedRooms.has(room.id)).map(room => ["room", room.id, room.name] as Entity), roomKeys),
  ];
  return {
    available: true, modelRevision: modelRow.model.revision, buildingId: building?.id ?? storeyRows[0]?.buildingId,
    storeys, level: agreed, requirementLevel: requirements.level, editions: { ...host.editions, requirements: requirements.edition },
    elements: [...elements.values()].filter(element => used.has(element.id)).sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true })),
    walls, ceilings, doors, impacts, stairs, services, places, suggestions, limitations,
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
  const review = `/projects/${projectId}?view=noise&step=interior`;
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
  // Lightweight catalogue rows to pick per element: key, reference and description, never their values.
  router.get("/projects/:projectId/interior-sound/catalogue", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:read");
      z.string().uuid().parse(req.params.projectId);
      res.json(ok({ rows: d.interiorSound?.lightweightOptions() ?? [] }));
    } catch (error) { next(error); }
  });
  return router;
}
