import { z } from "zod";

/**
 * Structure of the acoustic norm pack. The pack holds the licensed numeric
 * content (tables, coefficients, corrections) of RLS-19 and DIN 4109; it is
 * configured on the server only and never committed or sent to clients.
 * Code implements the methods; every normative number comes from the pack.
 */
const db = z.number().finite();
const positive = z.number().finite().positive();
const edition = z.string().trim().min(1).max(200);
const ref = z.string().trim().min(1).max(80);
const speedTerm = z.object({
  /** Correction = (g − fromPct) / gradientDivisor · (constant + speedFactor · min(v, speedCapKmh)) / speedDivisor. */
  fromPct: db, gradientDivisor: db, constant: db, speedFactor: db, speedCapKmh: positive.nullable(), speedDivisor: db,
}).strict();
const gradientGroup = z.object({ downhill: speedTerm, uphill: speedTerm }).strict();
const emission = z.object({ a: db, b: positive, c: db }).strict();
const traffic = z.object({ hourlyPerDailyTraffic: positive, truck1Pct: z.number().min(0).max(100), truck2Pct: z.number().min(0).max(100) }).strict();

export const roadClassSchema = z.enum(["motorway", "federal", "state_district", "municipal"]);
export type RoadClass = z.infer<typeof roadClassSchema>;

export const roadSurfaceTypes = [
  "mastic_asphalt", "sma_5_8", "sma_8_11", "asphalt_concrete_ac11", "porous_asphalt_pa11", "porous_asphalt_pa8",
  "exposed_aggregate_concrete", "low_noise_mastic_asphalt", "optimised_ac_d_loa", "optimised_sma_la8", "thin_layer_dsh_v5",
  "paving_even", "paving_other",
] as const;
export const roadSurfaceTypeSchema = z.enum(roadSurfaceTypes);
export type RoadSurfaceType = z.infer<typeof roadSurfaceTypeSchema>;

const surface = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("by_vehicle"),
    /** Speeds up to and including this value use the low column. null marks a combination the guideline does not provide. */
    splitKmh: positive,
    car: z.object({ low: db.nullable(), high: db.nullable() }).strict(),
    truck: z.object({ low: db.nullable(), high: db.nullable() }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("by_speed"),
    /** Ascending speed columns; a speed uses the highest column it reaches, below the first the first. */
    columns: z.array(z.object({ fromKmh: positive, value: db }).strict()).min(1),
  }).strict(),
]);

const massLawSegment = z.object({
  slope: db, intercept: db, minKgM2: positive, maxKgM2: positive, minInclusive: z.boolean(), maxInclusive: z.boolean(), ref: z.string().trim().min(1).max(40),
}).strict();
export const massLawMaterials = ["dense", "lightweight_concrete", "aerated_concrete"] as const;
export type MassLawMaterial = (typeof massLawMaterials)[number];

export const acousticNormPackSchema = z.object({
  id: z.string().trim().min(1).max(100),
  rls19: z.object({
    edition: z.string().trim().min(1).max(200),
    sourceHeightM: positive,
    emission: z.object({ car: emission, truck1: emission, truck2: emission }).strict(),
    speed: z.object({ minimumKmh: positive, unrestrictedCarKmh: positive, truckCapKmh: z.object({ motorway: positive, other: positive }).strict() }).strict(),
    standardTraffic: z.record(roadClassSchema, z.object({ day: traffic, night: traffic }).strict()),
    surfaces: z.record(roadSurfaceTypeSchema, surface),
    referenceSurface: roadSurfaceTypeSchema,
    gradient: z.object({ clampPct: positive, car: gradientGroup, truck1: gradientGroup, truck2: gradientGroup }).strict(),
    /** Source line position from the road centre, in lane widths, for 1…n lanes per direction; beyond, n minus manyLanesFromOuter. */
    sourceLineLanes: z.object({ offsets: z.array(db).min(1), manyLanesFromOuter: db }).strict(),
    propagation: z.object({
      /** Constant term of the geometric divergence (hemispherical spreading). */
      divergenceConstantDb: db,
      airAbsorptionDivisorM: positive,
      ground: z.object({ maxDb: db, heightFactor: db, distanceTermM: db }).strict(),
    }).strict(),
  }).strict(),
  din4109: z.object({
    edition: z.string().trim().min(1).max(200),
    /** Added once, to the combined rating level, to form the relevant exterior noise level. */
    exteriorLevelAdditionDb: db,
    nightSurchargeDb: db,
    railReductionDb: db,
    turnedAwayReductionDb: z.object({ open: db, closed: db }).strict(),
  }).strict(),
  /** Component catalogue for single-leaf massive walls: wall density from the density class and the mass law per material. Optional; without it no catalogue values are suggested. */
  din4109_32: z.object({
    edition: z.string().trim().min(1).max(200),
    /** Masonry wall density = factor · density class + offset, per mortar, within its density class range. */
    masonryWallDensity: z.array(z.object({ mortar: z.enum(["normal", "lightweight", "thin_bed"]), factor: positive, offset: db,
      minRdk: z.number().min(0), maxRdk: positive, minExclusive: z.boolean(), ref: z.string().trim().min(1).max(40) }).strict()).min(1),
    concreteDensityKgM3: z.object({ plain: positive, reinforced: positive }).strict(),
    /** Rw = slope · lg(m') + intercept within each segment's mass range. */
    massLaws: z.object({ dense: z.array(massLawSegment).min(1), lightweight_concrete: z.array(massLawSegment).min(1), aerated_concrete: z.array(massLawSegment).min(1) }).strict(),
    /** When perforated masonry may still be treated as homogeneous. */
    perforated: z.object({ maxThicknessMm: positive, clayMinRdkAboveMaxThickness: positive, blockMinRdk: positive }).strict(),
    roundingDecimals: z.number().int().min(0).max(3),
  }).strict().optional(),
  /** Interior sound insulation in massive buildings: requirements, the flanking transmission method and impact sound. Optional; without it nothing is calculated. */
  din4109_interior: z.object({
    editions: z.object({ requirements: edition, method: edition, junctions: edition, screeds: edition }).strict(),
    requirements: z.object({
      walls: z.record(z.enum(["apartment_partition", "corridor_partition", "stairwell"]), z.object({ rwMinDb: db, ref }).strict()),
      ceilings: z.record(z.enum(["apartment_separating", "over_common_space", "under_common_attic", "under_bathroom"]), z.object({ rwMinDb: db.nullable(), lnwMaxDb: db.nullable(), ref }).strict()),
    }).strict(),
    airborne: z.object({
      referenceLengthM: positive, referenceAbsorptionM2: positive,
      /** Below this common area the requirement applies to Dn,w instead of R'w. */
      minSeparatingAreaM2: positive,
      /** Reference edge length of lightweight flanking elements' Dn,f,w: horizontal and vertical transmission. */
      labEdgeLengthM: z.object({ horizontal: positive, vertical: positive }).strict(),
      /** Rigid T-junction: K12 = constant + square · M²; K13 piecewise in M with a break point. */
      tJunction: z.object({
        k12: z.object({ constant: db, square: db }).strict(),
        k13: z.object({ breakM: db, below: z.object({ constant: db, linear: db, square: db }).strict(), above: z.object({ constant: db, linear: db }).strict() }).strict(),
      }).strict(),
      uncertaintyDb: db,
      refs: z.object({ total: ref, direct: ref, flanking: ref, kijMin: ref, dnw: ref, lightweight: ref, junction: ref, uncertainty: ref }).strict(),
    }).strict(),
    impact: z.object({
      /** Ln,eq,0,w = constant − slope · lg(m') within the slab mass range. */
      bareSlab: z.object({ constant: db, slope: db, minKgM2: positive, maxKgM2: positive, ref }).strict(),
      /** K = constant + slope · lg(m's / m'f,m) when m'f,m ≤ m's, else 0, within both mass ranges. */
      flanking: z.object({ constant: db, slope: db, minSlabKgM2: positive, maxSlabKgM2: positive, minFlankingKgM2: positive, maxFlankingKgM2: positive, ref }).strict(),
      /** ΔLw = massLog · lg m' + stiffnessLog · lg s' + massStiffnessLog · m' · lg s' + mass · m' + constant, within its ranges. */
      screeds: z.record(z.enum(["mortar", "mastic_asphalt", "prefab"]), z.object({
        massLog: db, stiffnessLog: db, massStiffnessLog: db, mass: db, constant: db,
        minStiffness: positive, maxStiffness: positive, minMassKgM2: positive, maxMassKgM2: positive, ref,
      }).strict()),
      uncertaintyDb: db,
      refs: z.object({ total: ref, uncertainty: ref }).strict(),
    }).strict(),
    roundingDecimals: z.number().int().min(0).max(3),
  }).strict().optional(),
}).strict();
export type AcousticNormPack = z.infer<typeof acousticNormPackSchema>;

/** Input and result of the catalogue Rw of a single-leaf massive wall (method in @richtfest/acoustics, numbers in the pack). */
export type MassiveWallInput = {
  material: MassLawMaterial;
  /** Masonry is laid from units of a density class; concrete is cast or precast. */
  form: "masonry" | "concrete";
  /** Perforated units: clay (Hochlochziegel) or blocks (hollow lightweight or concrete blocks). */
  perforated: "none" | "clay" | "block";
  thicknessCm: number | null;
  /** Unit density (density class × 1000) for masonry, material density for concrete; kg/m³. */
  densityKgM3: number | null;
};
export type MassiveWallRw =
  | { status: "calculated"; rwDb: number; massKgM2: number; wallDensityKgM3: number; refs: string[]; edition: string;
    assumptions: Array<"mortar_unknown_lowest" | "without_plaster" | "reinforced_concrete_density"> }
  | { status: "unavailable"; reason: "catalogue_missing" | "thickness_missing" | "density_missing" | "density_class_out_of_range" | "perforated_not_homogeneous" | "mass_out_of_range" };

/** Interior sound: inputs and results of the airborne (flanking transmission) and impact sound methods (code in @richtfest/acoustics, numbers in the pack). */
export type InteriorWallRole = "apartment_partition" | "corridor_partition" | "stairwell";
export type InteriorCeilingRole = "apartment_separating" | "over_common_space" | "under_common_attic" | "under_bathroom";
export type FlankElement =
  | { kind: "massive"; id: string; name: string; massKgM2: number; rwDb: number; areaM2: number }
  | { kind: "lightweight"; id: string; name: string; dnfwDb: number };
/** One edge of the separating element with the flanking element on the source side (F) and on the receiving side (f). */
export type FlankingEdge = { edge: string; couplingLengthM: number; source: FlankElement; receiving: FlankElement };
export type AirborneInput = {
  separating: { id: string; name: string; massKgM2: number; rwDb: number };
  separatingAreaM2: number;
  /** Horizontal between rooms side by side, vertical through a ceiling. */
  transmission: "horizontal" | "vertical";
  edges: FlankingEdge[];
  requiredDb: number;
};
export type AirbornePath = { edge: string; path: "Ff" | "Df" | "Fd"; from: string; to: string; kijDb: number | null; kijMinApplied: boolean; rDb: number };
export type AirborneResult =
  | { status: "calculated"; rDdDb: number; paths: AirbornePath[]; rwPrimeDb: number; quantity: "R'w" | "Dn,w"; valueDb: number; uncertaintyDb: number;
    requiredDb: number; marginDb: number; meets: boolean; refs: string[]; edition: string }
  | { status: "unsupported"; reason: "method_missing" | "mixed_flanking" | "no_edges" | "invalid_geometry" };
export type ScreedType = "mortar" | "mastic_asphalt" | "prefab";
export type ImpactInput = {
  slabMassKgM2: number;
  screed: { type: ScreedType; massKgM2: number; stiffnessMNm3: number } | null;
  /** Area masses of the receiving room's massive flanking walls without linings. */
  flankingMassesKgM2: number[];
  maxDb: number;
};
export type ImpactResult =
  | { status: "calculated"; lnEq0Db: number; deltaLwDb: number; kDb: number; flankingMeanKgM2: number;
    /** The mean flanking mass was above the method's range and K was taken at its upper limit, which errs high. */
    flankingMassCapped: boolean; lnwPrimeDb: number; uncertaintyDb: number;
    maxDb: number; marginDb: number; meets: boolean; refs: string[]; edition: string }
  | { status: "unsupported"; reason: "method_missing" | "slab_mass_out_of_range" | "flanking_mass_out_of_range" | "no_massive_flanking" | "screed_out_of_range" };
