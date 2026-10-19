import type { RoadClass, RoadSurfaceType } from "./acoustic-norm-pack";
import type { Point2 } from "./site-plan";

/** Inputs and results of the road noise (RLS-19) and relevant exterior noise level (DIN 4109-2) methods. */
export type Point3 = [number, number, number];
type Group = "car" | "truck1" | "truck2";

export type RoadNoiseSource = {
  id: string;
  roadClass: RoadClass;
  dailyTraffic: number | null;
  /** Sum of both truck groups as a share of all traffic; split with the standard ratios when given. */
  heavyVehicleSharePct: number | null;
  /** Posted limit; null means no limit, which only motorways may have. */
  speedLimitKmh: number | null;
  surface: RoadSurfaceType | null;
  gradientPct: number | null;
  lanes: number | null;
  laneWidthM: number;
  /** Mapped axes in site metres (x east, y north). */
  parts: Point2[][];
};
export type RoadNoiseReceiver = {
  id: string;
  /** Site metres; z above the flat reference ground. */
  position: Point3;
  /** Outward facade normal: sources behind the facade plane do not reach the receiver directly. */
  normal: Point2 | null;
};

export type RoadEmissionIssue = "missing_daily_traffic" | "missing_speed_limit" | "surface_not_defined_for_speed";
export type RoadEmissionNote = "standard_traffic" | "heavy_share_split" | "reference_surface" | "flat_gradient" | "lanes_assumed";
export type PeriodEmission = {
  hourlyTraffic: number;
  truck1Pct: number;
  truck2Pct: number;
  speedKmh: Record<Group, number>;
  vehicleLevelDb: Record<Group, number>;
  /** Length-related sound power level of one source line carrying half the traffic. */
  lineLevelDb: number;
};
export type RoadEmission =
  | { ok: true; day: PeriodEmission; night: PeriodEmission; notes: RoadEmissionNote[] }
  | { ok: false; issues: RoadEmissionIssue[]; notes: RoadEmissionNote[] };

export type RoadRatingLevel =
  | { receiverId: string; sourceId: string; ok: true; dayDb: number | null; nightDb: number | null; emission: Extract<RoadEmission, { ok: true }>; lanesAssumed: boolean }
  | { receiverId: string; sourceId: string; ok: false; emission: Extract<RoadEmission, { ok: false }> };


export type RatingLevelContribution = {
  sourceId: string;
  kind: "road" | "rail";
  dayDb: number;
  nightDb: number;
};
export type ExteriorNoiseLevel = {
  /** La for rooms not used for sleeping: the day level. */
  dayDb: number;
  /** La for the night, for rooms that can be used mainly for sleeping. */
  nightDb: number;
  /** The governing La for a room used for sleeping: the higher of day and night. */
  sleepingDb: number;
  contributions: Array<RatingLevelContribution & { dayLaDb: number; nightLaDb: number }>;
};

/** Per-facade road rating levels and relevant exterior noise levels of a project, as the API returns them. */
export type FacadeLevelLimitation =
  | "free_propagation" | "flat_ground" | "no_reflections" | "no_junction_correction" | "storey_height_assumed"
  | "rail_imported_all_facades" | "turned_away_reduction" | "storeys_aligned_by_outline" | "storey_plan_missing" | "storey_plan_not_aligned" | "storey_level_missing";
/** A plan page whose exterior walls form the facades of its storey: the placed page, or a page aligned to it by its outline. */
export type FacadeLevelPage = {
  sourceVersionId: string; page: number; fileName: string | null;
  storey: { id: string; name: string; levelIndex: number | null } | null;
  basis: "placed" | "outline"; fitM: number | null;
};
export type FacadeLevelSource = {
  id: string;
  name: string;
  kind: "road" | "rail";
  status: "calculated" | "imported" | "missing_inputs" | "no_geometry" | "not_used";
  issues: string[];
  notes: string[];
  /** Road emission per period, for the traceable calculation; absent for rail and sources not calculated. */
  emission: { day: { hourlyTraffic: number; truck1Pct: number; truck2Pct: number; lineLevelDb: number }; night: { hourlyTraffic: number; truck1Pct: number; truck2Pct: number; lineLevelDb: number }; speedKmh: { car: number; truck1: number; truck2: number } } | null;
  /** Assumed defaults applied to this source, e.g. the urban speed limit. */
  defaults: Array<{ key: string; value: number | string }>;
};
export type FacadeLevel = {
  id: string;
  wallId: string;
  wallName: string;
  storey: { id: string | null; name: string; levelIndex: number };
  compass: string;
  /** Receiver in site CRS metres and its height above ground. */
  receiver: { x: number; y: number; heightM: number };
  sources: Array<{ sourceId: string; dayDb: number; nightDb: number }>;
  level: { dayDb: number; nightDb: number; sleepingDb: number } | null;
  basis: "calculated" | "turned_away" | "none";
};
export type FacadeNoiseLevels =
  | { available: false; reason: "norm_pack_missing" | "location_missing" | "placement_missing" | "exterior_walls_missing" }
  | {
    available: true;
    editions: { rls19: string; din4109: string; pack: string };
    placement: { alignmentStatus: "unknown" | "approximate" | "reviewed"; sourceVersionId: string; page: number; fileName: string | null };
    storeyHeightM: number;
    /** Plan pages the facades come from, the placed page first. */
    pages: FacadeLevelPage[];
    sources: FacadeLevelSource[];
    facades: FacadeLevel[];
    limitations: FacadeLevelLimitation[];
  };
