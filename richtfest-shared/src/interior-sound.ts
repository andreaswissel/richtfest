import { z } from "zod";
import type { AirborneResult, DoorResult, ImpactOtherResult, ImpactResult, InteriorWallRole, JunctionKind, ServiceResult, StairResult, TimberImpactResult } from "./acoustic-norm-pack";
import { suggestionEvidence, type ProofSuggestion, type ProofValue } from "./exterior-noise-proof";

/**
 * Interior sound insulation verification assembled from the building model:
 * airborne sound between room pairs across separating walls, and airborne and
 * impact sound through the ceiling into each room below. Values are ordinary
 * building-model properties; the planner reviews them before a Nachweis.
 */

/** Building-model properties the interior verification reads; the agent may suggest any of them. A door's tested Rw comes only with a door entry. */
export const interiorSoundInputKeys = ["clearRoomHeight", "construction", "material", "thickness", "bulkDensity", "wallRole",
  "ceilingRole", "screedType", "screedMass", "screedStiffness", "flankingLevelDifference", "doorRole",
  "doorLeafSoundReduction", "doorLeafType", "rebateSealSoundReduction", "floorSealSoundReduction",
  "liningType", "liningMass", "liningStiffness", "liningCavity", "liningSides", "timberWallLining", "timberCeilingUnderside", "screedInsulation",
  "stairCase", "impactSoundReduction", "installationKind", "installationProof", "serviceSoundLevel", "serviceSoundLevelBasis", "serviceReceivingUse",
  "apartmentUnit", "spaceType", "exteriorNoiseRoom"] as const;

/** Why an element has no catalogue value: an input is missing, or the element is outside the catalogue method. */
export type InteriorElementReason =
  | "construction_missing" | "material_unknown" | "multi_leaf" | "thickness_missing" | "density_missing" | "density_class_out_of_range"
  | "perforated_not_homogeneous" | "mass_out_of_range" | "catalogue_missing" | "flanking_level_difference_missing"
  /** A lightweight separating element needs a catalogue row with its Rw; a row key the pack does not know. */
  | "lightweight_separating" | "catalogue_row_unknown"
  /** A timber ceiling's impact sound needs its underside, the walls' lining and the screed's insulation. */
  | "timber_inputs_missing";
export type InteriorGap =
  | { code: "clear_height" | "geometry" | "ceiling_missing" | "ceiling_role" | "screed" | "no_requirement" | "room_use" | "stair_case" | "stair_wall"
    | "installation_kind" | "installation_proof" | "installation_wall" | "service_level" }
  | { code: "flanking_missing"; edge: string }
  | { code: "element"; elementId: string; elementName: string; reason: InteriorElementReason };

export type InteriorElement = {
  id: string; name: string; componentType: "wall" | "ceiling";
  construction: string | null; massive: boolean;
  /** Catalogue values of a massive element; Rw, Dn,f,w and a ceiling's Ln,w of a lightweight one from its catalogue row or entry. */
  massKgM2: number | null; rwDb: number | null; dnfwDb: number | null; lnwDb?: number | null;
  basis: string | null; reason: InteriorElementReason | null;
  /** The lightweight catalogue row picked for it. */
  catalogueRow?: string | null;
  /**
   * A lining (wall) or suspended ceiling (ceiling) and, for a ceiling, its floating screed: ΔRw on that face, or why
   * it is not credited. Sides: which faces of a wall carry the lining.
   */
  lining?: InteriorLining | null; screedLining?: InteriorLining | null;
  /** The storey the element is on, when it has one. */
  storeyId?: string | null;
};

export type InteriorLining = { f0Hz: number | null; deltaRwDb: number | null; sides: "one" | "both" | null; reason: "incomplete" | "out_of_range" | "method_missing" | null };

export type InteriorWallCheck = {
  id: string; storeyId: string; wallId: string; wallName: string; role: InteriorWallRole;
  rooms: [{ id: string; name: string }, { id: string; name: string }];
  lengthM: number; areaM2: number | null;
  /** The role's requirement, or the lower one of a stairwell or corridor wall with an entrance door (`door` names it). */
  requirement: { rwMinDb: number; ref: string; door: { id: string; name: string } | null } | null;
  /** Flanking elements per edge on the side of the first room and the second. */
  edges: Array<{ edge: string; source: string | null; receiving: string | null; junction?: JunctionKind }>;
  gaps: InteriorGap[];
  result: AirborneResult | null;
};

export type InteriorCeilingCheck = {
  id: string; storeyId: string; ceilingId: string; ceilingName: string; role: ProofValue<string> | null;
  /** The room below, which receives the sound. */
  room: { id: string; name: string }; areaM2: number | null;
  requirement: { rwMinDb: number | null; lnwMaxDb: number | null; ref: string } | null;
  screed: { type: ProofValue<string> | null; mass: ProofValue<number> | null; stiffness: ProofValue<number> | null };
  gaps: InteriorGap[];
  airborne: AirborneResult | null; impact: ImpactResult | TimberImpactResult | null;
};

/** Impact sound from a common hallway's floor into a protected room beside it, or from the hallway above into one diagonally below. */
export type InteriorImpactCheck = {
  id: string; storeyId: string; position: "beside" | "diagonal_below";
  source: { id: string; name: string }; room: { id: string; name: string }; wall: { id: string; name: string };
  slab: { id: string; name: string } | null;
  requirement: { lnwMaxDb: number; ref: string } | null;
  gaps: InteriorGap[]; result: ImpactOtherResult | null;
};
/** A massive stair in a stairwell room against a protected room behind the stairwell wall. */
export type InteriorStairCheck = {
  id: string; storeyId: string; stair: { id: string; name: string };
  /** The protected room behind the stairwell wall; null (with the gap stair_wall) while the stair's room has no stairwell wall to one. */
  room: { id: string; name: string } | null; wall: { id: string; name: string } | null;
  stairCase: ProofValue<string> | null; deltaLw: ProofValue<number> | null;
  requirement: { lnwMaxDb: number; ref: string } | null;
  gaps: InteriorGap[]; result: StairResult | null;
};
/** Building services in a room, mounted on a wall: a reference installation wall or a measured level against the protected rooms of other units. */
export type InteriorServiceCheck = {
  id: string; storeyId: string; name: string; room: { id: string; name: string } | null; wall: { id: string; name: string } | null;
  kind: ProofValue<string> | null; proof: ProofValue<string> | null; level: ProofValue<number> | null; basis: ProofValue<string> | null;
  receivingUse: ProofValue<string> | null; buildUpConfirmed: ProofValue<boolean> | null; conditionsConfirmed: ProofValue<boolean> | null;
  /** Protected rooms of other units the mounting wall borders. */
  borders: Array<{ id: string; name: string }>;
  requirement: { maxDb: number; ref: string } | null;
  gaps: InteriorGap[]; result: ServiceResult | null;
};

/** A door from a common hallway or stairwell into a dwelling: its tested Rw less the allowance against the requirement. */
export type InteriorDoorCheck = {
  id: string; storeyId: string; name: string;
  wall: { id: string; name: string } | null; room: { id: string; name: string } | null;
  role: ProofValue<string> | null; rw: ProofValue<number> | null; basis: ProofValue<string> | null;
  /** Without a declared Rw: leaf Rw and type, rebate and floor seal RS,w for the catalogue criteria. */
  construction: { leafRw: ProofValue<number> | null; leafType: ProofValue<string> | null; rebateSeal: ProofValue<number> | null; floorSeal: ProofValue<number> | null };
  requirement: { rwMinDb: number; ref: string } | null;
  /** door_rw: neither a declared Rw nor a complete leaf and seals; criteria_not_applicable: the requirement is above the criteria's limit, so only a declared Rw counts. */
  gaps: Array<"door_role" | "door_rw" | "no_requirement" | "criteria_not_applicable">;
  result: Extract<DoorResult, { status: "calculated" }> | null;
};

export type InteriorLimitation =
  | "junction_types" | "floor_like_ceiling" | "walls_above_like_below" | "linings_one_side"
  | "doors_not_checked" | "impact_hallways_only" | "minimum_requirements_only" | "timber_impact_vertical" | "stairs_room_behind_wall" | "services_execution";

export type InteriorSoundProof =
  | { available: false; reason: "norm_pack_missing" | "model_missing" | "plan_missing" }
  | {
    available: true; modelRevision: number; buildingId: string;
    /** Each placed plan page with its storey and clear room height. */
    storeys: Array<{ id: string; name: string; sourceVersionId: string; fileName: string | null; page: number; clearHeight: ProofValue<number> | null }>;
    /** The agreed building sound insulation level, and the level the checks are held to (an elevated level needs its table in the pack). */
    level: string | null;
    requirementLevel: "statutory_minimum" | "elevated";
    editions: { requirements: string; method: string; junctions: string; screeds: string; catalogue: string } | null;
    elements: InteriorElement[];
    walls: InteriorWallCheck[]; ceilings: InteriorCeilingCheck[]; doors: InteriorDoorCheck[];
    impacts: InteriorImpactCheck[]; stairs: InteriorStairCheck[]; services: InteriorServiceCheck[];
    /** Rooms of the traced plans with the walls bounding them: where a stair or an installation can be added. */
    places: Array<{ roomId: string; roomName: string; storeyId: string; walls: Array<{ id: string; name: string }> }>;
    suggestions: ProofSuggestion[];
    limitations: InteriorLimitation[];
  };

const outcome = (result: AirborneResult | ImpactResult | TimberImpactResult | ImpactOtherResult | StairResult | null) => !result ? null : result.status !== "calculated" ? { status: result.status, reason: result.reason }
  : "lnwPrimeDb" in result ? { status: result.meets ? "meets" : "below", lnwDb: result.lnwPrimeDb, maxDb: result.maxDb, marginDb: result.marginDb }
  : { status: result.meets ? "meets" : "below", quantity: result.quantity, valueDb: result.valueDb, requiredDb: result.requiredDb, marginDb: result.marginDb };
const gapText = (gap: InteriorGap) => gap.code === "element" ? `${gap.elementName}: ${gap.reason}` : gap.code === "flanking_missing" ? `flanking_missing (${gap.edge})` : gap.code;

/**
 * The interior verification state an agent needs to act on: per check what is
 * missing and which element ids to propose values for. Bounded; no norm values.
 */
export function interiorSoundAgentContext(proof: InteriorSoundProof, projectId: string, maxChecks = 40) {
  const view = `/projects/${projectId}?view=noise&step=interior`;
  if (!proof.available) return { available: false as const, reason: proof.reason, view };
  const shown = <T,>(item: ProofValue<T> | null) => item ? { value: item.value, status: item.provenance === "inferred" && item.reviewStatus !== "approved" ? "suggested" : item.reviewStatus } : null;
  return {
    available: true as const, view, modelRevision: proof.modelRevision, buildingId: proof.buildingId,
    storeys: proof.storeys.map(storey => ({ storeyId: storey.id, name: storey.name, plan: { fileName: storey.fileName, page: storey.page }, clearRoomHeightM: shown(storey.clearHeight) })),
    elements: proof.elements.slice(0, maxChecks * 2).map(item => ({ elementId: item.id, name: item.name, type: item.componentType, construction: item.construction,
      massKgM2: item.massKgM2, missing: item.reason })),
    walls: proof.walls.slice(0, maxChecks).map(check => ({ storeyId: check.storeyId, wallId: check.wallId, wall: check.wallName, role: check.role, rooms: check.rooms.map(room => room.name),
      areaM2: check.areaM2, gaps: check.gaps.map(gapText), result: outcome(check.result) })),
    ceilings: proof.ceilings.slice(0, maxChecks).map(check => ({ storeyId: check.storeyId, ceilingId: check.ceilingId, ceiling: check.ceilingName, roomBelow: check.room.name, role: shown(check.role),
      screed: { type: shown(check.screed.type), massKgM2: shown(check.screed.mass), stiffnessMNm3: shown(check.screed.stiffness) },
      gaps: check.gaps.map(gapText), airborne: outcome(check.airborne), impact: outcome(check.impact) })),
    doors: proof.doors.slice(0, maxChecks).map(check => ({ storeyId: check.storeyId, doorId: check.id, door: check.name, wallId: check.wall?.id ?? null, wall: check.wall?.name ?? null,
      roomId: check.room?.id ?? null, room: check.room?.name ?? null,
      role: shown(check.role), rwDb: shown(check.rw), gaps: check.gaps,
      result: check.result && { status: check.result.meets ? "meets" : "below", method: check.result.method, valueDb: check.result.method === "declared" ? check.result.valueDb : null,
        requiredDb: check.result.requiredDb, marginDb: check.result.marginDb } })),
    impacts: proof.impacts.slice(0, maxChecks).map(check => ({ storeyId: check.storeyId, position: check.position, from: check.source.name, roomId: check.room.id, room: check.room.name,
      wall: check.wall.name, gaps: check.gaps.map(gapText), result: outcome(check.result) })),
    stairs: proof.stairs.slice(0, maxChecks).map(check => ({ storeyId: check.storeyId, stairId: check.stair.id, stair: check.stair.name, roomId: check.room?.id ?? null, room: check.room?.name ?? null,
      stairCase: shown(check.stairCase), deltaLwDb: shown(check.deltaLw), gaps: check.gaps.map(gapText), result: outcome(check.result) })),
    services: proof.services.slice(0, maxChecks).map(check => ({ storeyId: check.storeyId, installationId: check.id, name: check.name, room: check.room?.name ?? null, wall: check.wall?.name ?? null,
      kind: shown(check.kind), proof: shown(check.proof), levelDb: shown(check.level), gaps: check.gaps.map(gapText),
      result: !check.result ? null : check.result.status !== "calculated" ? { status: check.result.status, reason: check.result.reason }
        : check.result.method === "level" ? { status: check.result.meets ? "meets" : "below", valueDb: check.result.valueDb, maxDb: check.result.maxDb }
        : { status: check.result.meets ? "meets" : "not_covered", failures: check.result.failures } })),
    omitted: Math.max(0, proof.walls.length - maxChecks) + Math.max(0, proof.ceilings.length - maxChecks),
    limitations: proof.limitations,
    pendingSuggestions: proof.suggestions.length,
  };
}

/** Cited values the Richtfest Agent may suggest for the interior verification. */
export const interiorSoundSuggestionInput = z.object({
  values: z.array(z.object({
    entityType: z.enum(["building", "storey", "room", "element"]), entityId: z.string().uuid(),
    propertyKey: z.enum(interiorSoundInputKeys), value: z.union([z.string().trim().min(1).max(500), z.number(), z.boolean()]),
    unit: z.string().max(20).nullable().optional(), reason: z.string().trim().min(1).max(1000), evidence: suggestionEvidence,
  }).strict()).max(60).default([]),
  /** Entrance doors read from a plan or Türliste: the room they lead into and the stairwell or corridor wall they sit in. */
  doors: z.array(z.object({
    roomId: z.string().uuid(), wallId: z.string().uuid(), name: z.string().trim().min(1).max(120),
    role: z.enum(["to_dwelling_hallway", "to_habitable_room", "internal"]).nullable().optional(),
    rw: z.number().min(0).max(100).nullable().optional(), basis: z.string().trim().min(1).max(500).nullable().optional(),
    reason: z.string().trim().min(1).max(1000), evidence: suggestionEvidence,
  }).strict()).max(40).default([]),
}).strict().refine(input => input.values.length + input.doors.length > 0, "Suggest at least one value or door");
export type InteriorSoundSuggestionInput = z.infer<typeof interiorSoundSuggestionInput>;
