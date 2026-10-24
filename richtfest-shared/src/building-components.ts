import { z } from "zod";
import { fireClosureSchema, fireRatingSchema, fireRoomRoleSchema, fireSpecialUseSchema, garageEnclosureSchema, stairwellSmokeVentSchema } from "./fire-protection-schema";

/**
 * Shared component attributes on building-model entities. Every discipline
 * (sound, thermal, fire, cost) reads the same wall/ceiling record; these keys
 * are stored as ordinary versioned, reviewed building properties.
 */
export const componentTypeSchema = z.enum(["wall", "ceiling", "floor", "roof", "window", "door", "small_element", "stair", "installation", "other"]);
export type ComponentType = z.infer<typeof componentTypeSchema>;
export const componentConstructionSchema = z.enum(["masonry", "concrete", "drywall", "timber", "steel", "other"]);
export type ComponentConstruction = z.infer<typeof componentConstructionSchema>;
/** Requirement-relevant wall role: DIN 4109-1 sets different requirements per role. */
export const wallRoleSchema = z.enum(["apartment_partition", "corridor_partition", "stairwell", "exterior", "internal"]);
export type WallRole = z.infer<typeof wallRoleSchema>;
/** What a ceiling separates; it selects the interior requirement. Internal ceilings have none. */
export const ceilingRoleSchema = z.enum(["apartment_separating", "over_common_space", "under_common_attic", "under_bathroom", "internal"]);
export type CeilingRole = z.infer<typeof ceilingRoleSchema>;
/** Where a door leads from a common hallway or stairwell: into the dwelling's hallway, straight into a habitable room, or within one dwelling (no requirement). */
export const doorRoleSchema = z.enum(["to_dwelling_hallway", "to_habitable_room", "internal"]);
/** A door leaf closing into a rebate (rebated) or flush into the frame. */
export const doorLeafTypeSchema = z.enum(["rebated", "flush"]);
/** A layer on a massive element's face: none, bonded via an insulation layer, or free-standing with a cavity. Ceilings: a suspended ceiling. */
export const liningTypeSchema = z.enum(["none", "bonded", "free_standing"]);
/** Which faces of a wall carry the lining; one face counts only where the side is unambiguous. */
export const liningSidesSchema = z.enum(["one", "both"]);
/** Timber construction: a wall's lining and a timber ceiling's underside, and the insulation under a mineral or asphalt screed. */
export const timberWallLiningSchema = z.enum(["gypsum_wood", "gypsum_fibre", "wood_board", "timber_element"]);
export const timberCeilingUndersideSchema = z.enum(["two_boards_resilient", "one_board_resilient", "battens_or_direct", "open_beams", "solid_timber"]);
export const screedInsulationSchema = z.enum(["wood_fibre", "mineral"]);
/** A massive stair: landing or run, how it meets the stairwell wall, and whether a building joint runs through. */
export const stairCaseSchema = z.enum(["landing_rigid", "run_rigid", "run_separated", "landing_joint", "run_separated_joint", "run_elastic_joint"]);
/** Building services: sanitary and water installations, or other fixed equipment; proven by a reference installation wall or a measured level. */
export const installationKindSchema = z.enum(["sanitary", "other"]);
export const installationProofSchema = z.enum(["reference_wall", "level"]);
/** A window's frame material; wood frames need fewer rebate seals in the window catalogue, wood-aluminium frames take a correction. */
export const windowFrameSchema = z.enum(["wood", "plastic", "metal", "wood_aluminium"]);
/** How a window opens: single or multi-sash casement, twin sash without a fixed mullion (Stulp), or fixed glazing. */
export const windowOpeningSchema = z.enum(["casement", "twin_sash", "fixed"]);
/** Floating screed: mortar (cement, calcium sulphate, …), mastic asphalt, prefabricated dry screed, or none. */
export const screedTypeSchema = z.enum(["mortar", "mastic_asphalt", "prefab", "none"]);
export const spaceTypeSchema = z.enum(["apartment", "common_corridor", "stairwell", "common_other", "exterior"]);
export type SpaceType = z.infer<typeof spaceTypeSchema>;
/** Agreed sound insulation level: the statutory DIN 4109-1 minimum, the elevated civil-law level or DEGA 103. */
export const soundInsulationLevelSchema = z.enum(["statutory_minimum", "elevated", "dega"]);
/** German federal state: its Landesbauordnung and VVTB apply. */
export const federalStateSchema = z.enum(["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"]);
/** Whether a Bebauungsplan covers the site; it is checked first and binds the assessment. */
export const bebauungsplanSchema = z.enum(["applies", "none"]);
/** Whether a storey is a Vollgeschoss under the Landesbauordnung. */
export const fullStoreySchema = z.enum(["full", "not_full"]);
/** Shared bounds for stored clear heights and source-observation proposals. */
export const clearRoomHeightSchema = z.number().min(1.5).max(20);
/** Fire protection inputs on the building, in the order the specialist settles them. */
export const fireBuildingKeys = ["fireHeight", "fireDwellings", "fireOtherUnits", "fireDetached", "fireUsableArea", "fireLargestUnitArea", "fireUnitsGrossArea", "fireSpecialUse", "garageArea", "garageEnclosure", "stairwellSmokeVent"] as const;
/** Regulatory basis keys, in the order the specialist checks them. */
export const regulatoryBasisKeys = ["federalState", "bebauungsplan", "bebauungsplanNoise", "stateBuildingCodeEdition", "vvtbEdition", "din4109Edition"] as const;
export type SoundInsulationLevel = z.infer<typeof soundInsulationLevelSchema>;
/**
 * Art und Maß der baulichen Nutzung a Bebauungsplan states, as quoted text per
 * value. Asked only when a plan applies and not part of the sound insulation
 * basis, so they never block it.
 */
export const developmentPlanZoningKeys = ["bebauungsplanAreaType", "bebauungsplanGrz", "bebauungsplanGfz", "bebauungsplanStoreys", "bebauungsplanHeight", "bebauungsplanBauweise"] as const;

type PropertySpec = { value: z.ZodTypeAny; unit: string | null };
export const buildingComponentProperties = {
  element: {
    componentType: { value: componentTypeSchema, unit: null },
    // Explicitly reviewed classification, not the IFC export's possibly unreliable declaration.
    isExternal: { value: z.boolean(), unit: null },
    construction: { value: componentConstructionSchema, unit: null },
    material: { value: z.string().trim().min(1).max(200), unit: null },
    thickness: { value: z.number().positive().max(500), unit: "cm" },
    bulkDensity: { value: z.number().positive().max(10000), unit: "kg/m³" },
    wallRole: { value: wallRoleSchema, unit: null },
    // Exterior noise: Rw of the installed component (window corrections included), its basis, and an opening's area.
    soundReductionIndex: { value: z.number().min(0).max(100), unit: "dB" },
    soundReductionIndexBasis: { value: z.string().trim().min(1).max(500), unit: null },
    openingArea: { value: z.number().positive().max(10000), unit: "m²" },
    // Clear width (from the plan's scale) and height of an opening; without an entered area, width × height is its area.
    openingWidth: { value: z.number().positive().max(100), unit: "m" },
    openingHeight: { value: z.number().positive().max(100), unit: "m" },
    // Small elements (ventilators, roller shutter boxes): Dn,e,w and how many of the same element sit in the wall.
    normalizedLevelDifference: { value: z.number().min(0).max(100), unit: "dB" },
    elementCount: { value: z.number().int().min(1).max(100), unit: null },
    // A roof surface over a room, as it bounds the room (sloped area, not plan area).
    surfaceArea: { value: z.number().positive().max(100000), unit: "m²" },
    // Interior sound: what a ceiling separates, its floating screed, and Dn,f,w of a lightweight flanking wall.
    ceilingRole: { value: ceilingRoleSchema, unit: null },
    screedType: { value: screedTypeSchema, unit: null },
    screedMass: { value: z.number().positive().max(1000), unit: "kg/m²" },
    screedStiffness: { value: z.number().positive().max(1000), unit: "MN/m³" },
    flankingLevelDifference: { value: z.number().min(0).max(120), unit: "dB" },
    doorRole: { value: doorRoleSchema, unit: null },
    // A door without a declared Rw: its leaf's Rw and type and the RS,w of its rebate and floor seals (catalogue criteria).
    doorLeafSoundReduction: { value: z.number().min(0).max(100), unit: "dB" },
    doorLeafType: { value: doorLeafTypeSchema, unit: null },
    rebateSealSoundReduction: { value: z.number().min(0).max(100), unit: "dB" },
    floorSealSoundReduction: { value: z.number().min(0).max(100), unit: "dB" },
    // Lightweight construction: the catalogue row a planner picked (its values stay on the server).
    lightweightCatalogueRow: { value: z.string().trim().min(1).max(40), unit: null },
    // A lining (walls), a suspended ceiling (ceilings): its kind and what its resonance frequency needs.
    liningType: { value: liningTypeSchema, unit: null },
    liningMass: { value: z.number().positive().max(500), unit: "kg/m²" },
    liningStiffness: { value: z.number().positive().max(1000), unit: "MN/m³" },
    liningCavity: { value: z.number().positive().max(100), unit: "cm" },
    liningSides: { value: liningSidesSchema, unit: null },
    timberWallLining: { value: timberWallLiningSchema, unit: null },
    timberCeilingUnderside: { value: timberCeilingUndersideSchema, unit: null },
    screedInsulation: { value: screedInsulationSchema, unit: null },
    // A massive stair in a stairwell room, and a covering's or floating screed's ΔLw on it.
    stairCase: { value: stairCaseSchema, unit: null },
    impactSoundReduction: { value: z.number().min(0).max(60), unit: "dB" },
    // Building services in a room, mounted on a wall: kind, how it is proven, and a measured or certified LAF,max,n.
    installationKind: { value: installationKindSchema, unit: null },
    installationProof: { value: installationProofSchema, unit: null },
    serviceSoundLevel: { value: z.number().min(0).max(120), unit: "dB" },
    serviceSoundLevelBasis: { value: z.string().trim().min(1).max(500), unit: null },
    serviceReceivingUse: { value: z.enum(["living", "work"]), unit: null },
    /** A person confirmed the stud wall has the reference build-up. */
    referenceBuildUpConfirmed: { value: z.boolean(), unit: null },
    /** A person confirmed the fittings, mounting, decoupling and manufacturer proofs the reference wall presumes. */
    installationConditionsConfirmed: { value: z.boolean(), unit: null },
    // Window build-up for a catalogue Rw when no tested value is declared: glazing ("6/16/4"), declared glass Rw, frame, seals, opening, frame share, glazing bars.
    glazing: { value: z.string().trim().min(1).max(80), unit: null },
    glassSoundReduction: { value: z.number().min(0).max(100), unit: "dB" },
    windowFrame: { value: windowFrameSchema, unit: null },
    rebateSeals: { value: z.number().int().min(0).max(4), unit: null },
    windowOpening: { value: windowOpeningSchema, unit: null },
    frameShare: { value: z.number().min(0).max(100), unit: "%" },
    glazingBars: { value: z.boolean(), unit: null },
    // Fire protection: whether a wall carries load (§ 27 LBauO), the rating its build-up provides and why, and a door's closure.
    loadBearing: { value: z.boolean(), unit: null },
    fireResistance: { value: fireRatingSchema, unit: null },
    fireResistanceBasis: { value: z.string().trim().min(1).max(500), unit: null },
    fireClosure: { value: fireClosureSchema, unit: null },
    // Rescue-window clear passage is not an acoustic/rough opening dimension.
    fireRescueWindow: { value: z.boolean(), unit: null },
    fireRescueLocation: { value: z.enum(["facade", "roof"]), unit: null },
    fireRescueClearWidth: { value: z.number().finite().min(0).max(100), unit: "m" },
    fireRescueClearHeight: { value: z.number().finite().min(0).max(100), unit: "m" },
    fireRescueSillHeight: { value: z.number().finite().min(0).max(100), unit: "m" },
    fireRescueOpenableInside: { value: z.boolean(), unit: null },
  },
  building: {
    soundInsulationLevel: { value: soundInsulationLevelSchema, unit: null },
    // Regulatory basis: which law and editions apply, confirmed by approving each value.
    federalState: { value: federalStateSchema, unit: null },
    bebauungsplan: { value: bebauungsplanSchema, unit: null },
    bebauungsplanNoise: { value: z.string().trim().min(1).max(1000), unit: null },
    stateBuildingCodeEdition: { value: z.string().trim().min(1).max(120), unit: null },
    vvtbEdition: { value: z.string().trim().min(1).max(120), unit: null },
    din4109Edition: { value: z.string().trim().min(1).max(120), unit: null },
    // Art und Maß der baulichen Nutzung, as the plan states them, e.g. "0,4 (WA 1) · 0,35 (WA 2)".
    bebauungsplanAreaType: { value: z.string().trim().min(1).max(300), unit: null },
    bebauungsplanGrz: { value: z.string().trim().min(1).max(300), unit: null },
    bebauungsplanGfz: { value: z.string().trim().min(1).max(300), unit: null },
    bebauungsplanStoreys: { value: z.string().trim().min(1).max(300), unit: null },
    bebauungsplanHeight: { value: z.string().trim().min(1).max(300), unit: null },
    bebauungsplanBauweise: { value: z.string().trim().min(1).max(300), unit: null },
    // Zoning check inputs: the parcel (Grundstück) area on the site building, each building's Grundfläche.
    parcelArea: { value: z.number().positive().max(10_000_000), unit: "m²" },
    footprintArea: { value: z.number().positive().max(10_000_000), unit: "m²" },
    storeyInventory: { value: z.enum(["complete", "incomplete"]), unit: null },
    gfzCountingBasis: { value: z.enum(["full_storeys_only", "include_other_storeys"]), unit: null },
    // Exterior noise verification: whether the standard method applies and whether flanking is negligible.
    exteriorNoiseApplicability: { value: z.enum(["standard_exterior_noise", "special_assessment_required"]), unit: null },
    exteriorNoiseFlanking: { value: z.enum(["negligible", "required"]), unit: null },
    // Fire protection: inputs of the building class (height of the highest floor where Aufenthaltsräume are possible, on average above ground), Sonderbau, garage and Treppenraum venting.
    fireHeight: { value: z.number().min(0).max(500), unit: "m" },
    fireDetached: { value: z.boolean(), unit: null },
    fireDwellings: { value: z.number().int().min(0).max(10000), unit: null },
    fireOtherUnits: { value: z.number().int().min(0).max(10000), unit: null },
    fireUsableArea: { value: z.number().positive().max(10_000_000), unit: "m²" },
    // Berlin (§ 2 Abs. 3 BauO Bln) measures units by Brutto-Grundfläche: the largest unit for GK 4, all units together for GK 1–2.
    fireLargestUnitArea: { value: z.number().positive().max(10_000_000), unit: "m²" },
    fireUnitsGrossArea: { value: z.number().positive().max(10_000_000), unit: "m²" },
    fireSpecialUse: { value: fireSpecialUseSchema, unit: null },
    garageArea: { value: z.number().min(0).max(1_000_000), unit: "m²" },
    garageEnclosure: { value: garageEnclosureSchema, unit: null },
    stairwellSmokeVent: { value: stairwellSmokeVentSchema, unit: null },
  },
  /** 0 is the ground floor; upper storeys count up, basements down. */
  storey: {
    level: { value: z.number().int().min(-9).max(99), unit: null },
    // Vollgeschoss per Landesbauordnung, decided by a person; its Geschossfläche counts towards the GFZ.
    fullStorey: { value: fullStoreySchema, unit: null },
    grossFloorArea: { value: z.number().positive().max(1_000_000), unit: "m²" },
    countableFloorArea: { value: z.number().nonnegative().max(1_000_000), unit: "m²" },
    /** Clear room height: with the facade length it gives a room's exterior wall area. */
    clearRoomHeight: { value: clearRoomHeightSchema, unit: "m" },
  },
  room: {
    /** Overrides the storey height; null returns to inheritance. Never a compliance classification. */
    clearRoomHeight: { value: clearRoomHeightSchema, unit: "m" },
    apartmentUnit: { value: z.string().trim().min(1).max(80), unit: null },
    spaceType: { value: spaceTypeSchema, unit: null },
    exteriorNoiseRoom: { value: z.enum(["sleeping", "living", "office", "hospital_bedroom", "not_protected"]), unit: null },
    /** A person confirmed that every exterior surface and opening of the room is entered. */
    exteriorSurfacesComplete: { value: z.boolean(), unit: null },
    /** Escape role entered by a person; otherwise derived from space type, use and building class. */
    fireRoomRole: { value: fireRoomRoleSchema, unit: null },
    /** A notwendiger Treppenraum vented differently from the building default (one building with windows, another with an opening at the top). */
    stairwellSmokeVent: { value: stairwellSmokeVentSchema, unit: null },
  },
} satisfies Record<string, Record<string, PropertySpec>>;
/** Element kinds created by plan derivation imply a component type until one is entered. */
export function elementComponentType(kind: string | null | undefined, declared: unknown): ComponentType | null {
  if (typeof declared === "string" && componentTypeSchema.safeParse(declared).success) return declared as ComponentType;
  return kind === "draft_wall" ? "wall" : kind === "draft_ceiling" ? "ceiling" : null;
}

export type ElementComponentKey = keyof typeof buildingComponentProperties.element;
export type RoomComponentKey = keyof typeof buildingComponentProperties.room;

/** One height selection for room geometry and calculations. The fallback is display-only, never a saved fact. */
export function resolveRoomHeight<T extends { value: unknown; reviewStatus: string; provenance: string }>(room?: T | null, storey?: T | null) {
  const usable = (state?: T | null) => state && !["rejected", "superseded"].includes(state.reviewStatus)
    && typeof state.value === "number" && Number.isFinite(state.value) && state.value >= 1.5 && state.value <= 20;
  const scope = usable(room) ? "room" : usable(storey) ? "storey" : "default";
  const property = scope === "room" ? room! : scope === "storey" ? storey! : null;
  const value = property ? property.value as number : 2.6;
  // Inferred dimensions entered by the geometry workflow remain unavailable to engineering until reviewed.
  const calculationValue = property && (property.provenance !== "inferred" || property.reviewStatus === "approved") ? value : null;
  return { value, scope, property, calculationValue };
}

const specFor = (entityType: string, key: string): PropertySpec | undefined =>
  (buildingComponentProperties as Record<string, Record<string, PropertySpec>>)[entityType]?.[key];

/** Validates a known component key; unknown keys stay free-form. Returns an error message or null. */
export function validateBuildingComponentProperty(entityType: string, key: string, value: unknown, unit: string | null | undefined) {
  const spec = specFor(entityType, key);
  if (!spec) return null;
  if (value === null) return null;
  if (!spec.value.safeParse(value).success) return `Invalid value for ${key}`;
  if ((unit ?? null) !== spec.unit) return spec.unit ? `${key} requires unit ${spec.unit}` : `${key} takes no unit`;
  return null;
}

export type SpaceContext = { apartmentUnit: string | null; spaceType: SpaceType | null };

/**
 * Wall role from the two spaces a wall separates. Returns null when the role
 * cannot be established from the sides; it never guesses.
 */
export function deriveWallRole(a: SpaceContext | null, b: SpaceContext | null): WallRole | null {
  if (!a?.spaceType || !b?.spaceType) return null;
  // Any indoor space facing outside is an exterior wall, whatever else it separates.
  if ((a.spaceType === "exterior") !== (b.spaceType === "exterior")) return "exterior";
  const [apartment, other] = a.spaceType === "apartment" ? [a, b] : b.spaceType === "apartment" ? [b, a] : [null, null];
  if (!apartment || !other) return null;
  if (other.spaceType === "apartment") {
    if (!apartment.apartmentUnit || !other.apartmentUnit) return null;
    return apartment.apartmentUnit === other.apartmentUnit ? "internal" : "apartment_partition";
  }
  return other.spaceType === "common_corridor" ? "corridor_partition"
    : other.spaceType === "stairwell" ? "stairwell" : null;
}

export type ComponentPropertyState = { value: unknown; reviewStatus: string } | null | undefined;
export type ComponentInputGap = { field: string; status: "missing" | "unreviewed" };

/** Inputs a sound-insulation calculation needs for a wall or ceiling, and which are missing or unreviewed. */
export function componentInputGaps(componentType: ComponentType | null, properties: Record<string, ComponentPropertyState>): ComponentInputGap[] {
  if (componentType !== "wall" && componentType !== "ceiling") return [];
  const construction = properties.construction?.value;
  const fields = ["construction", "thickness",
    // Lightweight systems are rated as tested assemblies, not by bulk density.
    ...(construction === "drywall" || construction === "timber" ? [] : ["bulkDensity"]),
    ...(componentType === "wall" ? ["wallRole"] : [])];
  return fields.flatMap((field): ComponentInputGap[] => {
    const state = properties[field];
    if (!state || state.value === null || state.value === undefined || state.reviewStatus === "rejected") return [{ field, status: "missing" as const }];
    return state.reviewStatus === "approved" ? [] : [{ field, status: "unreviewed" as const }];
  });
}

export type ComponentValueState = { value: unknown; unit?: string | null; reviewStatus: string; provenance?: string | null; evidenceQuote?: string | null; evidenceKind?: string | null };

/** Where an unreviewed value came from: measured or derived from the plan, stated in a document or an inquiry reply, or entered by a person. */
export type ValueOrigin = "plan" | "document" | "correspondence" | "entered";
export const valueOrigin = (state: ComponentValueState): ValueOrigin => state.provenance !== "inferred" ? "entered"
  : state.evidenceKind === "correspondence" ? "correspondence"
  : state.evidenceQuote && !state.evidenceQuote.startsWith("Printed scale") ? "document" : "plan";
export type BuildingComponentRecord = { id: string; componentType: ComponentType | null; properties: Record<string, ComponentValueState | null | undefined> };

/** Latest non-rejected value of a component property; rejected values count as absent. */
const liveValue = (state: ComponentValueState | null | undefined) => state && state.reviewStatus !== "rejected" && state.value !== null && state.value !== undefined ? state : null;

/** Separating walls whose sound insulation must be verified against DIN 4109-1. Exterior walls go through the facade check. */
export const verifiedWallRoles = ["apartment_partition", "corridor_partition", "stairwell"] as const satisfies readonly WallRole[];
const roleOrder: Array<WallRole | null> = ["apartment_partition", "corridor_partition", "stairwell", "exterior", "internal", null];

export type ComponentRequestField = {
  field: string;
  /** Components without a usable value: ask for it. */
  missing: number;
  /** Unreviewed values grouped by value: ask to confirm them. */
  unconfirmed: Array<{ value: unknown; unit: string | null; origin: ValueOrigin; count: number }>;
};
export type ComponentRequestGroup = { componentType: "wall" | "ceiling"; wallRole: WallRole | null; count: number; componentIds: string[]; fields: ComponentRequestField[] };

/**
 * What still has to be asked of the architect or client, grouped the way they
 * answer: per wall role, and for ceilings. Only inputs a sound insulation
 * calculation needs are requested; a group appears only while something is
 * missing or unconfirmed.
 */
export function componentDataRequest(components: BuildingComponentRecord[]): ComponentRequestGroup[] {
  const groups = new Map<string, { componentType: "wall" | "ceiling"; wallRole: WallRole | null; items: BuildingComponentRecord[] }>();
  for (const component of components) {
    if (component.componentType !== "wall" && component.componentType !== "ceiling") continue;
    const role = component.componentType === "wall" ? (liveValue(component.properties.wallRole)?.value as WallRole | undefined) ?? null : null;
    const key = `${component.componentType}:${role}`;
    const group = groups.get(key) ?? { componentType: component.componentType, wallRole: role, items: [] };
    group.items.push(component);
    groups.set(key, group);
  }
  const result: ComponentRequestGroup[] = [];
  for (const group of groups.values()) {
    const fields = new Map<string, ComponentRequestField>();
    for (const item of group.items) {
      const gaps = componentInputGaps(item.componentType, Object.fromEntries(Object.entries(item.properties).map(([key, state]) => [key, state ? { value: state.value, reviewStatus: state.reviewStatus } : null])));
      // The wall role comes from the plan and Richtfest's review, not from the architect.
      for (const gap of gaps) {
        if (gap.field === "wallRole") continue;
        const field = fields.get(gap.field) ?? { field: gap.field, missing: 0, unconfirmed: [] };
        if (gap.status === "missing") field.missing++;
        else {
          const state = item.properties[gap.field]!;
          const unit = state.unit ?? null, origin = valueOrigin(state);
          const existing = field.unconfirmed.find(entry => JSON.stringify([entry.value, entry.unit, entry.origin]) === JSON.stringify([state.value, unit, origin]));
          if (existing) existing.count++; else field.unconfirmed.push({ value: state.value, unit, origin, count: 1 });
        }
        fields.set(gap.field, field);
      }
    }
    if (!fields.size) continue;
    const order = ["construction", "thickness", "bulkDensity"];
    result.push({ componentType: group.componentType, wallRole: group.wallRole, count: group.items.length, componentIds: group.items.map(item => item.id),
      fields: [...fields.values()].sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field)).map(field => ({ ...field, unconfirmed: field.unconfirmed.sort((a, b) => b.count - a.count) })) });
  }
  return result.sort((a, b) => (a.componentType === b.componentType ? 0 : a.componentType === "wall" ? -1 : 1) || roleOrder.indexOf(a.wallRole) - roleOrder.indexOf(b.wallRole));
}

export type SoundInsulationCheck = { componentId: string; componentType: "wall" | "ceiling"; wallRole: WallRole | null; ready: boolean; gaps: ComponentInputGap[] };

/**
 * Separating components that need an airborne/impact sound insulation
 * verification, and whether their inputs are complete and reviewed. This only
 * prepares the verification; it does not calculate anything.
 */
export function soundInsulationChecks(components: BuildingComponentRecord[]): SoundInsulationCheck[] {
  return components.flatMap((component): SoundInsulationCheck[] => {
    const role = component.componentType === "wall" ? (liveValue(component.properties.wallRole)?.value as WallRole | undefined) ?? null : null;
    if (component.componentType === "wall" ? !role || !(verifiedWallRoles as readonly string[]).includes(role) : component.componentType !== "ceiling") return [];
    const gaps = componentInputGaps(component.componentType, Object.fromEntries(Object.entries(component.properties).map(([key, state]) => [key, state ? { value: state.value, reviewStatus: state.reviewStatus } : null])));
    return [{ componentId: component.id, componentType: component.componentType as "wall" | "ceiling", wallRole: role, ready: gaps.length === 0, gaps }];
  });
}

/**
 * Regulatory basis items still to settle: missing or not yet confirmed by a
 * person. Bebauungsplan noise requirements are only asked for when a plan applies.
 */
export function regulatoryBasisGaps(properties: Record<string, ComponentPropertyState>): ComponentInputGap[] {
  const keys = regulatoryBasisKeys.filter(key => key !== "bebauungsplanNoise" || properties.bebauungsplan?.value === "applies");
  return keys.flatMap((field): ComponentInputGap[] => {
    const state = properties[field];
    if (!state || state.value === null || state.value === undefined || state.reviewStatus === "rejected") return [{ field, status: "missing" }];
    return state.reviewStatus === "approved" ? [] : [{ field, status: "unreviewed" }];
  });
}

export type ZoningLimits = { grz: number | null; gfz: number | null; maxFullStoreys: number | null };
const germanDecimal = (value: string) => /^\d,\d{1,2}$/.test(value) ? Number(value.replace(",", ".")) : null;
const storeyNumerals = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

/**
 * The Bebauungsplan limits a person approved, as numbers, for zoningChecks.
 * Only a single plain value counts ("0,4", "höchstens III"); values per
 * Baufeld, ranges or unreviewed proposals stay null so a check asks instead of guessing.
 */
export function zoningLimits(properties: Record<string, ComponentPropertyState | null | undefined>): ZoningLimits {
  const approved = (key: string) => { const state = properties[key]; return state?.reviewStatus === "approved" && typeof state.value === "string" ? state.value.trim() : null; };
  const storeys = approved("bebauungsplanStoreys")?.match(/^(?:höchstens\s+)?([IVX]+)$/)?.[1];
  return {
    grz: germanDecimal(approved("bebauungsplanGrz") ?? ""),
    gfz: germanDecimal(approved("bebauungsplanGfz") ?? ""),
    maxFullStoreys: storeys && storeyNumerals.includes(storeys) ? storeyNumerals.indexOf(storeys) + 1 : null,
  };
}

/** Inputs the zoning check needs, as reviewed building-model values. Areas are entered from the Lageplan or calculation, not derived from room outlines. */
export const zoningCheckBuildingKeys = ["parcelArea", "footprintArea", "storeyInventory", "gfzCountingBasis"] as const;
export const zoningCheckStoreyKeys = ["fullStorey", "grossFloorArea", "countableFloorArea"] as const;
export const zoningCheckMethod = "zoning_check_v1";
export type ZoningCheckKey = "grz" | "gfz" | "fullStoreys";
export type ZoningInputGap = { field: string; entityType: "building" | "storey"; entityId: string; status: "missing" | "unreviewed" };
export type ZoningCheck = { key: ZoningCheckKey; limit: number | null; actual: number | null; status: "within" | "exceeds" | "incomplete"; gaps: ZoningInputGap[] };
export type ZoningCheckInput = {
  limits: ZoningLimits;
  /** The site building carries the parcel area (the same building that holds the regulatory basis). */
  site: { id: string; properties: Record<string, ComponentPropertyState> } | null;
  buildings: Array<{ id: string; properties: Record<string, ComponentPropertyState> }>;
  /** buildingId groups storeys: the Vollgeschoss limit applies to each building on its own. */
  storeys: Array<{ id: string; buildingId?: string | null; properties: Record<string, ComponentPropertyState> }>;
};

/**
 * GRZ, GFZ and Vollgeschosse of the planned buildings against the approved
 * Bebauungsplan limits. Deterministic arithmetic on approved inputs only:
 * GRZ = Grundfläche (§ 19 Abs. 2 BauNVO, main buildings) / parcel area; GFZ =
 * Geschossfläche of the Vollgeschosse plus other countable areas when the
 * reviewed site counting basis requires them / parcel area. Each building's
 * storey inventory must be confirmed complete. Vollgeschosse are counted per building and the highest count
 * is checked. Whether a storey is a Vollgeschoss follows the Landesbauordnung
 * and is a person's decision. Any missing or unreviewed input makes a check
 * incomplete instead of guessing; § 19 Abs. 4 overruns (garages, access) are not assessed.
 */
export function zoningChecks(input: ZoningCheckInput): ZoningCheck[] {
  const gapOf = (entityType: "building" | "storey", entityId: string, properties: Record<string, ComponentPropertyState>, field: string): ZoningInputGap | null => {
    const state = properties[field];
    if (!state || state.value === null || state.value === undefined || state.reviewStatus === "rejected") return { field, entityType, entityId, status: "missing" };
    if (state.reviewStatus !== "approved") return { field, entityType, entityId, status: "unreviewed" };
    const invalid = field === "storeyInventory" ? state.value !== "complete"
      : field === "gfzCountingBasis" ? !["full_storeys_only", "include_other_storeys"].includes(String(state.value))
      : field === "fullStorey" ? !["full", "not_full"].includes(String(state.value))
      : typeof state.value !== "number" || !Number.isFinite(state.value) || (field === "countableFloorArea" ? state.value < 0 : state.value <= 0);
    return invalid ? { field, entityType, entityId, status: "missing" } : null;
  };
  const number = (properties: Record<string, ComponentPropertyState>, field: string) => typeof properties[field]?.value === "number" ? properties[field]!.value as number : 0;
  const parcelGap = input.site ? gapOf("building", input.site.id, input.site.properties, "parcelArea") : null;
  const parcel = input.site && !parcelGap ? number(input.site.properties, "parcelArea") : null;
  const ratio = (area: number | null, gaps: ZoningInputGap[]) => gaps.length || !parcel || area === null ? null : area / parcel;
  const result = (key: ZoningCheckKey, limit: number | null, actual: number | null, gaps: ZoningInputGap[]): ZoningCheck => ({ key, limit, actual, gaps,
    status: limit === null || actual === null || gaps.length ? "incomplete" : actual > limit + 1e-9 ? "exceeds" : "within" });

  const footprintGaps = [...(parcelGap ? [parcelGap] : []), ...input.buildings.flatMap(building => gapOf("building", building.id, building.properties, "footprintArea") ?? [])];
  const footprint = input.buildings.reduce((sum, building) => sum + number(building.properties, "footprintArea"), 0);
  const inventoryGaps = input.buildings.flatMap((building): ZoningInputGap[] => {
    const gap = gapOf("building", building.id, building.properties, "storeyInventory");
    if (gap) return [gap];
    const hasStoreys = input.storeys.some(storey => storey.buildingId === building.id || (!storey.buildingId && input.buildings.length === 1));
    return hasStoreys ? [] : [{ field: "storeyInventory", entityType: "building", entityId: building.id, status: "missing" }];
  });
  const storeyStatusGaps = [...inventoryGaps, ...input.storeys.flatMap(storey => gapOf("storey", storey.id, storey.properties, "fullStorey") ?? [])];
  const basisGap = input.site ? gapOf("building", input.site.id, input.site.properties, "gfzCountingBasis") : null;
  const other = input.site?.properties.gfzCountingBasis?.value === "include_other_storeys"
    ? input.storeys.filter(storey => storey.properties.fullStorey?.value === "not_full") : [];
  const full = input.storeys.filter(storey => storey.properties.fullStorey?.reviewStatus === "approved" && storey.properties.fullStorey.value === "full");
  const floorGaps = [...(parcelGap ? [parcelGap] : []), ...(basisGap ? [basisGap] : []), ...storeyStatusGaps, ...full.flatMap(storey => gapOf("storey", storey.id, storey.properties, "grossFloorArea") ?? []),
    ...other.flatMap(storey => gapOf("storey", storey.id, storey.properties, "countableFloorArea") ?? [])];
  const floorArea = full.reduce((sum, storey) => sum + number(storey.properties, "grossFloorArea"), 0)
    + other.reduce((sum, storey) => sum + number(storey.properties, "countableFloorArea"), 0);
  const perBuilding = new Map<string, number>();
  for (const storey of full) perBuilding.set(storey.buildingId ?? "", (perBuilding.get(storey.buildingId ?? "") ?? 0) + 1);
  const mostFullStoreys = Math.max(0, ...perBuilding.values());
  return [
    result("grz", input.limits.grz, ratio(footprint, footprintGaps), footprintGaps),
    result("gfz", input.limits.gfz, input.site && input.buildings.length ? ratio(floorArea, floorGaps) : null, floorGaps),
    result("fullStoreys", input.limits.maxFullStoreys, storeyStatusGaps.length || !input.storeys.length ? null : mostFullStoreys, storeyStatusGaps),
  ];
}

export type DataRequestProgress = { total: number; answered: number; outstanding: ComponentRequestGroup[] };

/**
 * How much of a sent request has been answered. An item (one field of one
 * group) counts as answered once none of the requested components still has it
 * missing or unreviewed, whether it was entered, copied, read or approved.
 * Components deleted since are ignored.
 */
export function dataRequestProgress(items: ComponentRequestGroup[], components: BuildingComponentRecord[]): DataRequestProgress {
  const byId = new Map(components.map(component => [component.id, component]));
  const gapsOf = (component: BuildingComponentRecord) => new Set(componentInputGaps(component.componentType, Object.fromEntries(Object.entries(component.properties)
    .map(([key, state]) => [key, state ? { value: state.value, reviewStatus: state.reviewStatus } : null]))).map(gap => gap.field));
  let total = 0, answered = 0;
  const outstanding: ComponentRequestGroup[] = [];
  for (const group of items) {
    const current = group.componentIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const fields = group.fields.filter(field => {
      total++;
      const open = current.some(component => gapsOf(component).has(field.field));
      if (!open) answered++;
      return open;
    });
    if (fields.length) outstanding.push({ ...group, fields });
  }
  return { total, answered, outstanding };
}

/**
 * What to ask again for a sent request: the current data request for the
 * requested components, limited to the items still open. Values the
 * counterpart already stated in a reply are left out: they need an internal
 * review, not another question. Other proposed values appear to confirm.
 */
export function followUpRequest(items: ComponentRequestGroup[], components: BuildingComponentRecord[]): ComponentRequestGroup[] {
  const open = new Map<string, Set<string>>();
  for (const group of dataRequestProgress(items, components).outstanding)
    for (const id of group.componentIds) open.set(id, new Set([...(open.get(id) ?? []), ...group.fields.map(field => field.field)]));
  return componentDataRequest(components.filter(component => open.has(component.id)))
    .map(group => ({ ...group, fields: group.fields.filter(field => group.componentIds.some(id => open.get(id)?.has(field.field)))
      .map(field => ({ ...field, unconfirmed: field.unconfirmed.filter(entry => entry.origin !== "correspondence") }))
      .filter(field => field.missing > 0 || field.unconfirmed.length > 0) }))
    .filter(group => group.fields.length);
}
