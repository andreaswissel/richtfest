import type { AcousticCalculationInput, AcousticCalculationResult } from "./acoustic-calculation";
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
export type ProofValue<T> = { value: T; reviewStatus: string; provenance: string; propertyId: string; version: number };

export type ProofWindow = {
  id: string; name: string; componentType: "window" | "door";
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
  | "window_area" | "window_rw" | "openings_exceed_facade" | "surfaces_unconfirmed" | "applicability" | "flanking" | "no_facade";
export type ProofRoomResult = {
  status: "calculated" | "unsupported" | "missing_input" | "invalid_inventory";
  targetDb: number | null; valueDb: number | null; marginDb: number | null; reason: string | null;
};
export type ProofRoom = {
  id: string; name: string; label: string; roomUse: string | null;
  kind: ProofValue<string> | null; proposedKind: ExteriorNoiseRoomKind | null;
  floorAreaM2: number | null; surfacesComplete: ProofValue<boolean> | null;
  facades: ProofFacade[]; gaps: ProofGap[]; result: ProofRoomResult | null;
};

export type ExteriorNoiseProof =
  | { available: false; reason: "norm_pack_missing" | "location_missing" | "placement_missing" | "exterior_walls_missing" | "model_missing" }
  | {
    available: true; modelRevision: number;
    buildingId: string; page: { fileName: string | null; page: number };
    storey: { id: string; name: string; levelIndex: number | null };
    applicability: ProofValue<string> | null; flanking: ProofValue<string> | null; clearHeight: ProofValue<number> | null;
    rooms: ProofRoom[];
    /** The calculation input for every protected room that has all inputs, and its result. */
    calculation: { input: Extract<AcousticCalculationInput, { method: "exterior_noise_batch" }>; result: AcousticCalculationResult } | null;
    /** The facade levels the La values come from, with their sources, defaults and limitations. */
    levels: Extract<FacadeNoiseLevels, { available: true }>;
  };
