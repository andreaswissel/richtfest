import { z } from "zod";
import type { AcousticCalculationInput, AcousticCalculationResult } from "./acoustic-calculation";
import { buildingEvidenceSchema } from "./building-model";
import type { Compass } from "./site-plan";
import type { FacadeNoiseLevels } from "./exterior-noise-levels";

/**
 * Exterior noise verification inputs assembled from the building model and
 * the calculated facade levels: per protected room its floor area, exterior
 * facades with La, and the facade elements. Values entered here are ordinary
 * building-model properties; the planner reviews them before a Nachweis.
 */
export const exteriorNoiseRoomKinds = ["sleeping", "living", "office", "hospital_bedroom", "not_protected"] as const;
export type ExteriorNoiseRoomKind = (typeof exteriorNoiseRoomKinds)[number];

const proposals: Array<[RegExp, ExteriorNoiseRoomKind]> = [
  // Living rooms first: "Wohnküche" and "Wohndiele" are living rooms, not kitchens or halls.
  [/wohn|ess|living|dining|lounge/i, "living"],
  [/schlaf|kind|gast|eltern|bedroom|child|guest|nursery/i, "sleeping"],
  [/büro|buero|arbeit|office|study|praxis|besprech/i, "office"],
  [/küche|kueche|kitchen|bad|dusch|wc|toilet|bath|flur|diele|gang|corridor|hall|abstell|lager|storage|hwr|hauswirt|technik|utility|treppe|stair|garderobe|ankleide|keller|garage|loggia|balkon|terrasse/i, "not_protected"],
];

/** A proposal from the room's name or use; a person confirms it. Null when nothing matches. */
export function proposeExteriorNoiseRoom(name: string, roomUse: string | null): ExteriorNoiseRoomKind | null {
  for (const text of [roomUse ?? "", name]) for (const [pattern, kind] of proposals) if (pattern.test(text)) return kind;
  return null;
}

/** Which La a room uses: sleeping rooms the night-based value, others the day value. */
export const exteriorNoiseLaPeriod = (kind: ExteriorNoiseRoomKind) => kind === "sleeping" || kind === "hospital_bedroom" ? "sleeping" as const : "day" as const;
export const exteriorNoiseCalculationUse = (kind: ExteriorNoiseRoomKind) =>
  kind === "hospital_bedroom" ? "hospital_bedroom" as const : kind === "office" ? "office" as const : "residential_accommodation_classroom" as const;

/** The current, not rejected value of a building-model property. */
export type ProofValue<T> = { value: T; reviewStatus: string; provenance: string; propertyId: string; version: number; reviewRevision: number };

/** Building-model properties the exterior noise verification reads; the agent may suggest any of them. */
export const exteriorNoiseInputKeys = ["exteriorNoiseApplicability", "exteriorNoiseFlanking", "clearRoomHeight", "exteriorNoiseRoom", "exteriorSurfacesComplete",
  "construction", "soundReductionIndex", "soundReductionIndexBasis", "openingArea", "openingWidth", "openingHeight", "normalizedLevelDifference", "elementCount", "surfaceArea",
  // A window's build-up, for its catalogue Rw when no tested value is declared.
  "glazing", "glassSoundReduction", "windowFrame", "rebateSeals", "windowOpening", "frameShare", "glazingBars"] as const;

/**
 * A value Richtfest suggested (agent or derivation) that nobody has confirmed
 * yet. It is calculated with, but the Nachweis stays a Teilstand until a
 * person accepts or replaces it.
 */
export type ProofSuggestion = {
  entityType: "building" | "storey" | "room" | "element"; entityId: string; entityLabel: string;
  propertyKey: string; value: unknown; unit: string | null;
  propertyId: string; version: number; reviewRevision: number;
  /** First cited source page, and a short quote when the source stated it. */
  evidence: { sourceVersionId: string; page: number; fileName: string | null; quote: string | null } | null;
};

/** A window or door (area and Rw), or a small element such as a ventilator or shutter box (count and Dn,e,w; area per element optional). */
export type ProofWindow = {
  id: string; name: string; componentType: "window" | "door" | "small_element";
  area: ProofValue<number> | null; rw: ProofValue<number> | null; basis: ProofValue<string> | null;
  count: ProofValue<number> | null; dnew: ProofValue<number> | null;
  /** A window's glazing build-up, read for its catalogue Rw. */
  glazing: ProofValue<string> | null;
  /** Clear width (from the plan) and height; without an entered area, width × height is the area. */
  width: ProofValue<number> | null; height: ProofValue<number> | null;
};
/** A roof surface over a room: its area and Rw. It takes the loudest La of the room's facades. */
export type ProofRoof = {
  id: string; name: string; construction: "massive" | "lightweight" | "unknown";
  area: ProofValue<number> | null; rw: ProofValue<number> | null; basis: ProofValue<string> | null;
};
export type ProofFacade = {
  wallId: string; wallName: string; compass: Compass | null; lengthM: number; areaM2: number | null;
  la: { dayDb: number; sleepingDb: number; basis: "calculated" | "turned_away" } | null;
  construction: "massive" | "lightweight" | "unknown";
  rw: ProofValue<number> | null; rwBasis: ProofValue<string> | null;
  windows: ProofWindow[]; opaqueAreaM2: number | null;
};
export type ProofGap =
  | "room_kind" | "floor_area" | "clear_height" | "facade_level" | "wall_rw" | "wall_construction"
  | "window_area" | "window_rw" | "openings_exceed_facade" | "surfaces_unconfirmed" | "applicability" | "flanking" | "no_facade"
  | "small_element_dnew" | "roof_area" | "roof_rw" | "roof_construction";
export type ProofRoomResult = {
  status: "calculated" | "unsupported" | "missing_input" | "invalid_inventory";
  targetDb: number | null; valueDb: number | null; marginDb: number | null; reason: string | null;
};
export type ProofRoom = {
  id: string; name: string; label: string; roomUse: string | null;
  /** The storey whose plan page the room was traced on. */
  storeyId: string;
  kind: ProofValue<string> | null; proposedKind: ExteriorNoiseRoomKind | null;
  floorAreaM2: number | null; surfacesComplete: ProofValue<boolean> | null;
  facades: ProofFacade[]; roofs: ProofRoof[]; gaps: ProofGap[]; result: ProofRoomResult | null;
};

export type ProofStorey = {
  id: string; name: string; levelIndex: number | null;
  page: { sourceVersionId: string; fileName: string | null; page: number };
  clearHeight: ProofValue<number> | null;
};

export type ExteriorNoiseProof =
  | { available: false; reason: "norm_pack_missing" | "location_missing" | "placement_missing" | "exterior_walls_missing" | "model_missing" }
  | {
    available: true; modelRevision: number;
    buildingId: string;
    /** Storeys with a traced plan page aligned to the placed page, ground floor first; each has its own clear room height. */
    storeys: ProofStorey[];
    applicability: ProofValue<string> | null; flanking: ProofValue<string> | null;
    rooms: ProofRoom[];
    /** Suggested values still waiting for a person, oldest entity first. */
    suggestions: ProofSuggestion[];
    /** The calculation input for every protected room that has all inputs, and its result. */
    calculation: { input: Extract<AcousticCalculationInput, { method: "exterior_noise_batch" }>; result: AcousticCalculationResult } | null;
    /** The facade levels the La values come from, with their sources, defaults and limitations. */
    levels: Extract<FacadeNoiseLevels, { available: true }>;
  };

/**
 * The verification state an agent needs to act on: per room what is missing
 * and which ids to propose values for. Bounded; no norm values.
 */
export function exteriorNoiseAgentContext(proof: ExteriorNoiseProof, projectId: string, maxRooms = 40) {
  const view = `/projects/${projectId}?view=noise`;
  if (!proof.available) return { available: false as const, reason: proof.reason, view };
  const shown = <T,>(item: ProofValue<T> | null) => item ? { value: item.value, status: item.provenance === "inferred" && item.reviewStatus !== "approved" ? "suggested" : item.reviewStatus } : null;
  return {
    available: true as const, view, modelRevision: proof.modelRevision, buildingId: proof.buildingId,
    storeys: proof.storeys.map(storey => ({ storeyId: storey.id, name: storey.name, levelIndex: storey.levelIndex,
      plan: { fileName: storey.page.fileName, page: storey.page.page }, clearRoomHeightM: shown(storey.clearHeight) })),
    applicability: shown(proof.applicability), flanking: shown(proof.flanking),
    rooms: proof.rooms.slice(0, maxRooms).map(room => ({
      roomId: room.id, storeyId: room.storeyId, label: room.label, roomUse: room.roomUse, kind: shown(room.kind), proposedKind: room.kind ? null : room.proposedKind,
      floorAreaM2: room.floorAreaM2, surfacesComplete: shown(room.surfacesComplete), gaps: room.gaps,
      result: room.result && { status: room.result.status, requiredDb: room.result.targetDb, providedDb: room.result.valueDb, marginDb: room.result.marginDb },
      facades: room.facades.map(facade => ({
        wallId: facade.wallId, wall: facade.wallName, compass: facade.compass, lengthM: Math.round(facade.lengthM * 100) / 100, areaM2: facade.areaM2,
        laDb: facade.la ? Math.round((exteriorNoiseLaPeriod((room.kind?.value ?? "living") as ExteriorNoiseRoomKind) === "sleeping" ? facade.la.sleepingDb : facade.la.dayDb) * 10) / 10 : null,
        construction: facade.construction, rwDb: shown(facade.rw), rwBasis: facade.rwBasis?.value ?? null,
        openings: facade.windows.map(item => ({ elementId: item.id, name: item.name, type: item.componentType, areaM2: shown(item.area), rwDb: shown(item.rw),
          widthM: shown(item.width), heightM: shown(item.height),
          ...(item.componentType === "small_element" ? { count: shown(item.count), dnewDb: shown(item.dnew) } : {}) })),
      })),
      roofs: room.roofs.map(roof => ({ elementId: roof.id, name: roof.name, areaM2: shown(roof.area), rwDb: shown(roof.rw), construction: roof.construction })),
    })),
    omittedRooms: Math.max(0, proof.rooms.length - maxRooms),
    pendingSuggestions: proof.suggestions.length,
  };
}

/** What the Richtfest Agent may suggest for the verification: cited values on existing entities, and windows/doors it read from plans or a Fensterliste. */
export const suggestionEvidence = z.array(buildingEvidenceSchema).min(1).max(5);
export const exteriorNoiseSuggestionInput = z.object({
  values: z.array(z.object({
    entityType: z.enum(["building", "storey", "room", "element"]), entityId: z.string().uuid(),
    propertyKey: z.enum(exteriorNoiseInputKeys), value: z.union([z.string().trim().min(1).max(500), z.number(), z.boolean()]),
    unit: z.string().max(20).nullable().optional(), reason: z.string().trim().min(1).max(1000), evidence: suggestionEvidence,
  }).strict()).max(60).default([]),
  openings: z.array(z.object({
    roomId: z.string().uuid(), wallId: z.string().uuid(), componentType: z.enum(["window", "door"]), name: z.string().trim().min(1).max(120),
    area: z.number().positive().max(10000), rw: z.number().min(0).max(100).nullable().optional(), basis: z.string().trim().min(1).max(500).nullable().optional(),
    /** A window's glazing build-up ("6/16/4") and declared glass Rw, when the source states them instead of a tested window Rw. */
    glazing: z.string().trim().min(1).max(80).nullable().optional(), glassRw: z.number().min(0).max(100).nullable().optional(),
    reason: z.string().trim().min(1).max(1000), evidence: suggestionEvidence,
  }).strict()).max(40).default([]),
  /** Ventilators, roller shutter boxes and similar elements rated by Dn,e,w, in a room's exterior wall. */
  smallElements: z.array(z.object({
    roomId: z.string().uuid(), wallId: z.string().uuid(), name: z.string().trim().min(1).max(120),
    count: z.number().int().min(1).max(100), dnew: z.number().min(0).max(100).nullable().optional(), basis: z.string().trim().min(1).max(500).nullable().optional(),
    reason: z.string().trim().min(1).max(1000), evidence: suggestionEvidence,
  }).strict()).max(40).default([]),
}).strict().refine(input => input.values.length + input.openings.length + input.smallElements.length > 0, "Suggest at least one value, opening or small element");
export type ExteriorNoiseSuggestionInput = z.infer<typeof exteriorNoiseSuggestionInput>;
