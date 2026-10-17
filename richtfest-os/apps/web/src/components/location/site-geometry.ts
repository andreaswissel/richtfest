import { useMemo } from "react";
import {
  facadeDistances,
  placementForPage,
  planToSite,
  toUtm,
  utmZone,
  type FacadeDistance,
  type LocationContext,
  type LocationState,
  type MappedNoiseSource,
  type NoiseSource,
  type PlanPlacement,
  type Point2,
  type SitePlan,
  type SitePlanPage,
} from "@richtfest/shared";
import { useApi } from "../../query";

export type NoiseSurvey = {
  roads: MappedNoiseSource[] | null;
  rail: MappedNoiseSource[] | null;
} | null;
export type NoiseData = { sources: NoiseSource[]; survey: NoiseSurvey };

/** Geometry the location viewer draws on top of the public context, in local X/Z metres. */
export type SiteOverlay = {
  axes: Array<{ id: string; kind: "road" | "rail"; added: boolean; parts: Point2[][] }>;
  plan: { walls: Array<{ id: string; exterior: boolean; ring: Point2[] }> } | null;
  distances: Array<{ id: string; from: Point2; to: Point2; label: string }>;
  railNoise: string | null;
  aerial: { near: string | null; far: string | null };
  picks: Point2[];
  snaps: Point2[];
};

export type SiteGeometry = {
  page: SitePlanPage | null;
  /** Placement shown: pending alignment, else the stored one, else centred on the address point. */
  placement: PlanPlacement | null;
  stored: PlanPlacement | null;
  status: "none" | "approximate" | "reviewed" | "unknown";
  walls: Array<{ id: string; exterior: boolean; ring: Point2[] }>;
  axes: SiteOverlay["axes"];
  distances: Array<FacadeDistance & { source: NoiseSource }>;
  /** True when no wall is linked as exterior yet and all walls were measured. */
  allWalls: boolean;
};

const crsOf = (context: LocationContext) => context.crs ?? "EPSG:25833";
export const toLocal = (context: LocationContext, [e, n]: Point2): Point2 => [
  e - context.origin[0],
  context.origin[1] - n,
];
export const fromLocal = (context: LocationContext, [x, z]: Point2): Point2 => [
  x + context.origin[0],
  context.origin[1] - z,
];

/** Plan centred on the address point, unrotated: a starting point before alignment, never stored. */
export function defaultPlacement(context: LocationContext, page: SitePlanPage): PlanPlacement {
  const points = page.walls.flatMap((wall) => wall.ring);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return { origin: [context.origin[0] - cx, context.origin[1] + cy], degrees: 0 };
}

export function siteGeometry(
  context: LocationContext,
  sitePlan: SitePlan | undefined,
  noise: NoiseData | undefined,
  pageIndex: number,
  pending: PlanPlacement | null,
): SiteGeometry {
  const page = sitePlan?.pages[pageIndex] ?? sitePlan?.pages[0] ?? null;
  const stored = page ? placementForPage(sitePlan!.placement, page, crsOf(context)) : null;
  const placement = page ? pending ?? stored ?? defaultPlacement(context, page) : null;
  // Distances are measured in the north-up site CRS; only drawing converts to local X/Z (Z south).
  const zone = utmZone(context.crs);
  const siteWalls = page && placement ? page.walls.map((wall) => ({ id: wall.id, exterior: wall.exterior, ring: wall.ring.map((p) => planToSite(p, placement)) })) : [];
  const walls = siteWalls.map((wall) => ({ ...wall, ring: wall.ring.map((p) => toLocal(context, p)) }));
  const sources = noise?.sources ?? [];
  const addedRefs = new Set(sources.map((source) => source.mapped?.ref).filter(Boolean));
  const mapped = [...(noise?.survey?.roads ?? []), ...(noise?.survey?.rail ?? [])];
  const siteParts = (parts: Array<Array<[number, number]>>) => parts.map((part) => part.map(([lon, lat]) => toUtm(lon, lat, zone)));
  const axes = mapped
    .filter((item) => item.axes?.length)
    .map((item) => ({ id: item.ref, kind: item.kind, added: addedRefs.has(item.ref), parts: siteParts(item.axes!).map((part) => part.map((p) => toLocal(context, p))) }));
  const exterior = siteWalls.filter((wall) => wall.exterior);
  const measured = exterior.length ? exterior : siteWalls;
  const withAxes = new Map(sources.filter((source) => source.mapped?.axes?.length).map((source) => [source.id, source]));
  const distances = facadeDistances(measured, [...withAxes.values()].map((source) => ({ id: source.id, parts: siteParts(source.mapped!.axes!) })))
    .map((result) => ({ ...result, source: withAxes.get(result.sourceId)! }));
  const alignmentStatus = sitePlan?.placement?.alignmentStatus;
  return {
    page,
    placement,
    stored,
    status: stored ? (alignmentStatus === "reviewed" || alignmentStatus === "approximate" ? alignmentStatus : "unknown") : "none",
    walls,
    axes,
    distances,
    allWalls: measured.length > 0 && !exterior.length,
  };
}

export function useSiteGeometry(projectId: string, pageIndex = 0, pending: PlanPlacement | null = null) {
  const location = useApi(`/projects/${projectId}/location`);
  const sitePlan = useApi(`/projects/${projectId}/building-model/site-plan`);
  const noise = useApi(`/projects/${projectId}/noise-sources`);
  const context = (location.data as LocationState | undefined)?.context ?? null;
  const geometry = useMemo(
    () => context ? siteGeometry(context, sitePlan.data as SitePlan | undefined, noise.data as NoiseData | undefined, pageIndex, pending) : null,
    [context, sitePlan.data, noise.data, pageIndex, pending],
  );
  return { context, geometry, sitePlan: sitePlan.data as SitePlan | undefined, loading: location.isLoading || sitePlan.isLoading || noise.isLoading };
}
