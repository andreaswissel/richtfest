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

/** Interior requirements per element role: the statutory minimum (DIN 4109-1) or an agreed elevated level (DIN 4109-5). */
const interiorRequirementsSchema = z.object({
  walls: z.record(z.enum(["apartment_partition", "corridor_partition", "stairwell"]), z.object({ rwMinDb: db, ref }).strict()),
  /** lnwMaxLightweightDb: the L'n,w limit for ceilings of lightweight (catalogue) construction, where it differs. */
  ceilings: z.record(z.enum(["apartment_separating", "over_common_space", "under_common_attic", "under_bathroom"]),
    z.object({ rwMinDb: db.nullable(), lnwMaxDb: db.nullable(), lnwMaxLightweightDb: db.optional(), ref }).strict()),
  /** Rw of doors from common hallways and stairwells into a dwelling. */
  doors: z.record(z.enum(["to_dwelling_hallway", "to_habitable_room"]), z.object({ rwMinDb: db, ref }).strict()).optional(),
  /** A stairwell or corridor wall with such a door: R'w(wall) required = Rw(door) required + offsetDb. */
  wallWithDoor: z.object({ offsetDb: db, ref }).strict().optional(),
  /** L'n,w of stair runs and landings into rooms of other units. */
  stairs: z.object({ lnwMaxDb: db, ref }).strict().optional(),
  /** L'n,w from the floor of a common hallway into rooms of other units, in every direction. */
  hallwayFloor: z.object({ lnwMaxDb: db, ref }).strict().optional(),
  /** LAF,max,n of building services in protected rooms of other units, per source and room use (living and sleeping, work). */
  services: z.record(z.enum(["sanitary", "other"]), z.object({ living: z.object({ maxDb: db, ref }).strict(), work: z.object({ maxDb: db, ref }).strict().optional() }).strict()).optional(),
}).strict();
const junction = z.object({
  k12: z.object({ constant: db, square: db }).strict(),
  k13: z.object({ breakM: db, below: z.object({ constant: db, linear: db, square: db }).strict(), above: z.object({ constant: db, linear: db }).strict() }).strict(),
}).strict();

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
  /** Window catalogue: single windows with insulating glass, rated from their glazing, seals and corrections. Optional; without it no window values are suggested. */
  din4109_35: z.object({
    edition: z.string().trim().min(1).max(200),
    /** Rows in ascending Rw; a window takes the highest row its glass and seals meet. */
    insulatingGlass: z.array(z.object({
      rwDb: db, ref,
      /** The declared glass Rw that qualifies, or else the glazing build-up: total glass thickness or the two outer panes, and the cavity. */
      glassRwMinDb: db,
      buildUp: z.object({ totalMinMm: positive.optional(), panesMinMm: z.tuple([positive, positive]).optional(), cavityMinMm: positive }).strict().nullable(),
      seals: z.number().int().min(0).max(4), woodSeals: z.number().int().min(0).max(4),
      corrections: z.object({ frameShare: db, twinSash: db, fixedGlazing: db, smallWindow: db, glazingBars: db }).strict(),
    }).strict()).min(1),
    /** Constant corrections and the limits that trigger them. */
    woodAluminiumDb: db, largePaneDb: db, largePaneM2: positive, smallWindowM2: positive, frameSharePct: positive,
    equationRef: ref,
    /**
     * Doors without a declared Rw: for a required Rw up to maxRequiredDb, the leaf must reach the requirement plus
     * its offset (rebated or flush leaf) and both seals the requirement plus sealOffsetDb.
     */
    doors: z.object({ maxRequiredDb: db, leafOffsetDb: z.object({ rebated: db, flush: db }).strict(), sealOffsetDb: db, ref }).strict().optional(),
  }).strict().optional(),
  /** Interior sound insulation in massive buildings: requirements, the flanking transmission method and impact sound. Optional; without it nothing is calculated. */
  din4109_interior: z.object({
    editions: z.object({ requirements: edition, method: edition, junctions: edition, screeds: edition }).strict(),
    requirements: interiorRequirementsSchema,
    /** The allowance on a door's tested Rw before it is compared with the requirement. */
    door: z.object({ uncertaintyDb: db, ref }).strict().optional(),
    airborne: z.object({
      referenceLengthM: positive, referenceAbsorptionM2: positive,
      /** Below this common area the requirement applies to Dn,w instead of R'w. */
      minSeparatingAreaM2: positive,
      /** Reference edge length of lightweight flanking elements' Dn,f,w: horizontal and vertical transmission. */
      labEdgeLengthM: z.object({ horizontal: positive, vertical: positive }).strict(),
      /** Rigid T-junction: K12 = constant + square · M²; K13 piecewise in M with a break point. */
      tJunction: junction,
      /** Rigid cross junction, the same form; without it every junction is taken as a T-junction. */
      crossJunction: junction.optional(),
      /** The lateral offset up to which a separating element continuing past a flanking element still forms a cross junction. */
      crossJunctionOffsetM: positive.optional(),
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
      /** Rooms beside or diagonally below the excited ceiling: L'n,w = Ln,eq,0,w − ΔLw − K_T, with rigidly connected walls of at least minWallKgM2. */
      otherDirections: z.object({ besideDb: db, diagonalBelowDb: db, minWallKgM2: positive, ref }).strict().optional(),
      /**
       * Massive stairs by their case: L'n,w as tabled without a covering, else Ln,eq,0,w − ΔLw of the covering or
       * floating screed. minWallKgM2: the stairwell wall's least area mass for the case.
       */
      stairs: z.object({
        cases: z.record(z.enum(["landing_rigid", "run_rigid", "run_separated", "landing_joint", "run_separated_joint", "run_elastic_joint"]),
          z.object({ lnEq0Db: db, lnwDb: db, minWallKgM2: positive.nullable(), ref }).strict()),
        ref,
      }).strict().optional(),
      /**
       * Timber ceilings: L'n,w = Ln,w + K1 + K2. K1 by the receiving room's wall lining and the ceiling's underside;
       * K2 by the walls' group and the screed, tabled from fromDb in 1 dB steps of Ln,w + K1 (the last value beyond).
       */
      timber: z.object({
        k1: z.record(z.enum(["gypsum_wood", "gypsum_fibre", "wood_board", "timber_element"]),
          z.record(z.enum(["two_boards_resilient", "one_board_resilient", "battens_or_direct", "open_beams", "solid_timber"]), db)),
        k2: z.record(z.enum(["boarded", "wood"]), z.record(z.enum(["wood_fibre", "mineral", "prefab"]), z.object({ fromDb: db, values: z.array(db).min(1) }).strict())),
        ref,
      }).strict().optional(),
    }).strict(),
    roundingDecimals: z.number().int().min(0).max(3),
  }).strict().optional(),
  /** Lightweight construction catalogue (timber, metal stud, dry lining): rows a planner picks per element. */
  din4109_33: z.object({
    edition,
    rows: z.array(z.object({
      key: z.string().trim().min(1).max(40), ref, kind: z.enum(["wall_separating", "ceiling", "flanking_wall", "flanking_ceiling"]),
      description: z.string().trim().min(1).max(600), transmission: z.enum(["horizontal", "vertical"]).nullable(),
      rwDb: db.nullable(), lnwDb: db.nullable(), dnfwDb: db.nullable(),
    }).strict()).min(1),
  }).strict().optional(),
  /**
   * Elevated sound insulation (DIN 4109-5) for buildings where it is agreed.
   * Rows it leaves out keep the statutory minimum. Optional; without it an
   * agreed elevated level is reported as not checked.
   */
  din4109_5: z.object({
    edition,
    requirements: interiorRequirementsSchema.partial().strict(),
  }).strict().optional(),
  /**
   * Linings, suspended ceilings and floating screeds on massive elements: ΔRw from the resonance frequency f0.
   * Up to lowBand.maxHz, ΔRw = max(constant − lgSlope · lg f0 − rwFactor · Rw, 0); above, the points interpolated
   * linearly (a frequency listed twice steps). f0 = f0Constant · √(s' · (1/m'1 + 1/m'2)) for bonded layers and
   * f0Constant · √(cavityFactor / d · (1/m'1 + 1/m'2)) for free-standing ones (d in m).
   */
  din4109_34: z.object({
    edition,
    lowBand: z.object({ minHz: positive, maxHz: positive, constant: db, lgSlope: db, rwFactor: db }).strict(),
    points: z.array(z.object({ f0Hz: positive, deltaRwDb: db }).strict()).min(1),
    f0Constant: positive, cavityFactor: positive,
    /** Both sides improved: the larger ΔR plus this factor times the smaller. */
    smallerFactor: db,
    refs: z.object({ table: ref, bonded: ref, freeStanding: ref, combination: ref }).strict(),
  }).strict().optional(),
  /**
   * Building services: sanitary installations proven without measurement by the reference installation walls,
   * a massive wall of at least massiveMinKgM2 or a stud wall of the reference build-up on a slab of at least
   * lightweightSlabMinKgM2, neither bordering a protected room of another unit.
   */
  din4109_36: z.object({ edition, massiveMinKgM2: positive, lightweightSlabMinKgM2: positive, refs: z.object({ massive: ref, lightweight: ref }).strict() }).strict().optional(),
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
export type InteriorDoorRole = "to_dwelling_hallway" | "to_habitable_room";
/** The requirements a check is held to: the statutory minimum, or the agreed elevated level where the pack has it. */
export type InteriorRequirementLevel = "statutory_minimum" | "elevated";
export type InteriorRequirements = {
  level: InteriorRequirementLevel; edition: string;
  wall: (role: InteriorWallRole) => { rwMinDb: number; ref: string } | null;
  ceiling: (role: InteriorCeilingRole) => { rwMinDb: number | null; lnwMaxDb: number | null; lnwMaxLightweightDb?: number; ref: string } | null;
  door: (role: InteriorDoorRole) => { rwMinDb: number; ref: string } | null;
  /** R'w a stairwell or corridor wall needs where it holds a door of this role: the door's requirement plus the offset. */
  wallWithDoor: (role: InteriorDoorRole) => { rwMinDb: number; ref: string } | null;
  stairs: { lnwMaxDb: number; ref: string } | null;
  hallwayFloor: { lnwMaxDb: number; ref: string } | null;
  service: (kind: ServiceKind, use: "living" | "work") => { maxDb: number; ref: string } | null;
};
/**
 * A door's check: its declared Rw less the allowance against the requirement,
 * or without a declared Rw the catalogue criteria on its leaf and seals.
 */
export type DoorResult =
  | { status: "calculated"; method: "declared"; valueDb: number; uncertaintyDb: number; requiredDb: number; marginDb: number; meets: boolean; refs: string[] }
  | { status: "calculated"; method: "criteria"; requiredDb: number;
    /** Each part against the requirement plus its offset: leaf Rw, rebate seal and floor seal RS,w. */
    criteria: Array<{ part: "leaf" | "rebate_seal" | "floor_seal"; valueDb: number; requiredDb: number; meets: boolean }>;
    marginDb: number; meets: boolean; refs: string[] }
  | { status: "unsupported"; reason: "method_missing" | "no_requirement" | "criteria_not_applicable" };
export type DoorLeafType = "rebated" | "flush";
/** Leaf and seals of a door without a declared Rw. */
export type DoorConstruction = { leafRwDb: number; leafType: DoorLeafType; rebateSealDb: number; floorSealDb: number };
/** A layer improving a massive element's face: a lining, suspended ceiling or floating screed, with what its f0 needs. */
export type Lining =
  | { kind: "bonded"; massKgM2: number; stiffnessMNm3: number }
  | { kind: "free_standing"; massKgM2: number; cavityM: number };
export type LiningResult = { f0Hz: number; deltaRwDb: number; refs: string[] } | { f0Hz: number | null; deltaRwDb: null; reason: "method_missing" | "out_of_range" };
/**
 * A massive flanking element; liningDb is the ΔRw of a lining on its face in the room concerned. A lightweight one
 * by its Dn,f,w.
 */
export type FlankElement =
  | { kind: "massive"; id: string; name: string; massKgM2: number; rwDb: number; areaM2: number; liningDb?: number }
  | { kind: "lightweight"; id: string; name: string; dnfwDb: number };
/** How the separating and flanking elements meet at an edge: a rigid T-junction or a cross junction. */
export type JunctionKind = "t" | "cross";
/** One edge of the separating element with the flanking element on the source side (F) and on the receiving side (f). */
export type FlankingEdge = { edge: string; couplingLengthM: number; source: FlankElement; receiving: FlankElement; junction?: JunctionKind };
export type AirborneInput = {
  /**
   * A massive separating element with its mass and the ΔRw of linings on its source and receiving face, or a
   * lightweight one (catalogue or tested Rw) without.
   */
  separating: { id: string; name: string; massKgM2: number; rwDb: number; lightweight?: false; liningDb?: { source: number; receiving: number } }
    | { id: string; name: string; massKgM2: null; rwDb: number; lightweight: true };
  separatingAreaM2: number;
  /** Horizontal between rooms side by side, vertical through a ceiling. */
  transmission: "horizontal" | "vertical";
  edges: FlankingEdge[];
  requiredDb: number;
};
export type AirbornePath = { edge: string; path: "Ff" | "Df" | "Fd"; from: string; to: string; kijDb: number | null; kijMinApplied: boolean; rDb: number;
  /** The junction the Kij was taken for, and the combined lining improvement on the path. */
  junction?: JunctionKind; liningDb?: number };
export type AirborneResult =
  | { status: "calculated"; rDdDb: number; paths: AirbornePath[]; rwPrimeDb: number; quantity: "R'w" | "Dn,w"; valueDb: number; uncertaintyDb: number;
    requiredDb: number; marginDb: number; meets: boolean; refs: string[]; edition: string }
  | { status: "unsupported"; reason: "method_missing" | "mixed_flanking" | "no_edges" | "invalid_geometry" };
/** One catalogue row for lightweight construction (direct Rw, Ln,w of a timber ceiling, or Dn,f,w of a flanking element), without its values. */
export type LightweightCatalogueOption = { key: string; ref: string; kind: "wall_separating" | "ceiling" | "flanking_wall" | "flanking_ceiling"; description: string; transmission: "horizontal" | "vertical" | null };
/** Impact sound into a room beside or diagonally below the excited floor (massive only), with the correction K_T. */
export type ImpactOtherInput = { slabMassKgM2: number; screed: ImpactInput["screed"]; position: "beside" | "diagonal_below"; wallMassKgM2: number; maxDb: number };
export type ImpactOtherResult =
  | { status: "calculated"; lnEq0Db: number; deltaLwDb: number; kTDb: number; lnwPrimeDb: number; uncertaintyDb: number; maxDb: number; marginDb: number; meets: boolean; refs: string[]; edition: string }
  | { status: "unsupported"; reason: "method_missing" | "slab_mass_out_of_range" | "screed_out_of_range" | "wall_too_light" };
export type StairCase = "landing_rigid" | "run_rigid" | "run_separated" | "landing_joint" | "run_separated_joint" | "run_elastic_joint";
/** A massive stair into the room behind the stairwell wall: its case, a covering's or floating screed's ΔLw if any. */
export type StairInput = { stairCase: StairCase; coveringDeltaLwDb: number | null; wallMassKgM2: number | null; maxDb: number; requirementRef: string };
export type StairResult =
  | { status: "calculated"; tableDb: number; quantity: "L'n,w" | "Ln,eq,0,w"; deltaLwDb: number | null; lnwPrimeDb: number; uncertaintyDb: number; maxDb: number; marginDb: number; meets: boolean; refs: string[] }
  | { status: "unsupported"; reason: "method_missing" | "case_missing" | "wall_too_light" | "wall_mass_missing" };
export type TimberWallLining = "gypsum_wood" | "gypsum_fibre" | "wood_board" | "timber_element";
export type TimberCeilingUnderside = "two_boards_resilient" | "one_board_resilient" | "battens_or_direct" | "open_beams" | "solid_timber";
export type TimberScreedClass = "wood_fibre" | "mineral" | "prefab";
/** A timber ceiling's catalogue Ln,w with the flanking corrections K1 and K2. */
export type TimberImpactInput = { lnwDb: number; underside: TimberCeilingUnderside; wallLinings: TimberWallLining[]; screed: TimberScreedClass; maxDb: number };
export type TimberImpactResult =
  | { status: "calculated"; lnwDb: number; k1Db: number; k2Db: number; lnwPrimeDb: number; uncertaintyDb: number; maxDb: number; marginDb: number; meets: boolean; refs: string[] }
  | { status: "unsupported"; reason: "method_missing" };
/** Building services noise in a protected room: a reference installation wall met, or a measured or certified level. */
export type ServiceKind = "sanitary" | "other";
export type ServiceInput =
  | { method: "reference_wall"; kind: ServiceKind; wall: { massive: true; massKgM2: number } | { massive: false; buildUpConfirmed: boolean; slabMassKgM2: number | null };
    bordersProtectedRoom: boolean; conditionsConfirmed: boolean }
  | { method: "level"; valueDb: number; requirement: { maxDb: number; ref: string } | null };
export type ServiceResult =
  | { status: "calculated"; method: "reference_wall"; wall: "massive" | "lightweight"; meets: boolean;
    /** The rule a wall that is not covered fails. */
    failures: Array<"wall_too_light" | "slab_too_light" | "borders_protected_room" | "build_up_unconfirmed" | "conditions_unconfirmed" | "not_sanitary">; refs: string[] }
  | { status: "calculated"; method: "level"; valueDb: number; maxDb: number; marginDb: number; meets: boolean; refs: string[] }
  | { status: "unsupported"; reason: "method_missing" | "no_requirement" };
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

/** Input and result of a window's catalogue Rw (method in @richtfest/acoustics, rows in the pack). Unknown conditions are taken at their least favourable. */
export type WindowRwInput = {
  glassRwDb: number | null;
  glazing: Glazing | null;
  frame: "wood" | "plastic" | "metal" | "wood_aluminium" | null;
  seals: number | null;
  opening: "casement" | "twin_sash" | "fixed" | null;
  frameSharePct: number | null;
  glazingBars: boolean | null;
  areaM2: number | null;
};
export type WindowCorrection = "wood_aluminium" | "frame_share" | "twin_sash" | "fixed_glazing" | "small_window" | "large_pane" | "glazing_bars";
export type WindowRw =
  | { status: "calculated"; rwDb: number; tableRwDb: number; ref: string; edition: string; equationRef: string;
    corrections: Array<{ kind: WindowCorrection; db: number; assumed: boolean }>;
    /** The pack's limits behind the frame-share, small-window and large-pane corrections, for the basis text. */
    limits: { frameSharePct: number; smallWindowM2: number; largePaneM2: number };
    assumptions: Array<"insulating_glass_single_window" | "seals_assumed" | "frame_unknown"> }
  | { status: "unavailable"; reason: "catalogue_missing" | "glazing_missing" | "glazing_unreadable" | "below_catalogue" };

/** Panes and cavities of a glazing build-up, outer pane first, in mm. */
export type Glazing = { panesMm: number[]; cavitiesMm: number[] };
/**
 * Reads a glazing build-up as plans and window schedules write it: panes and
 * cavities separated by slashes, "6/16/4" or "4/12/4/12/4". Laminated panes
 * in the "44.2" notation count as their two plies (8 mm); a trailing word such as
 * "VSG" or "Ar" is ignored. Anything else is unreadable.
 */
export function parseGlazing(text: string | null | undefined): Glazing | null {
  if (!text) return null;
  const parts = text.split("/").map(part => part.trim());
  if (parts.length < 3 || parts.length % 2 === 0) return null;
  const values: number[] = [];
  for (const [index, part] of parts.entries()) {
    const laminated = index % 2 === 0 ? /^(\d)(\d)\.\d\b/.exec(part) : null;
    const plain = /^(\d+(?:[.,]\d+)?)\s*(?:mm)?\s*[A-Za-zÄÖÜäöü.-]*$/.exec(part);
    const value = laminated ? Number(laminated[1]) + Number(laminated[2]) : plain ? Number(plain[1].replace(",", ".")) : NaN;
    if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
    values.push(value);
  }
  return { panesMm: values.filter((_, index) => index % 2 === 0), cavitiesMm: values.filter((_, index) => index % 2 === 1) };
}
