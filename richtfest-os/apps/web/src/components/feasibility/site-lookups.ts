import { useQuery } from "@tanstack/react-query";
import { baunutzungsplanCoverage, type LocationBuilding, type LocationContext, type SiteAssessmentInput, type SiteReference } from "@richtfest/shared";
import { api } from "../../api";

type Point = [number, number];
type Locator = NonNullable<SiteAssessmentInput["siteLocator"]>;
export type BerlinParcel = { id: string; label: string; number?: string; district?: string; area: number | null; sourceDate: string | null; sourceUrl: string; polygons: Point[][][]; containsAddress: boolean };
export type BerlinPlan = { id: string; name: string; status: string; sourceUrl: string; documentUrl: string | null; explanationUrl: string | null; effectiveDate: string | null; polygons?: Point[][][]; containsAddress: boolean; planType?: string | null; procedure?: string | null; courtReview?: string | null };
export type BerlinLandUse = { id: string; label: string; purpose: string | null; category: "building" | "open" | "other"; sourceUrl: string; polygons: Point[][][]; containsAddress: boolean };
/** Heritage monuments and preservation areas (Erhaltungsverordnungen): social (Milieuschutz) or urban character. */
export type BerlinHint = { id: string; kind: "heritage" | "social_preservation" | "urban_preservation" | "preservation"; type?: string | null; label: string; sourceUrl: string; detailUrl: string | null; effectiveDate?: string | null; polygons?: Point[][][]; containsAddress: boolean };
export type BerlinSiteContext = {
  /** Ortsteil at the address; absent in lookups cached before it was returned. */
  locality?: { name: string; key: string; sourceUrl: string } | null;
  landUse?: BerlinLandUse[]; landUseStatus?: string;
  hints?: BerlinHint[];
  hintStatus?: string; address: string; origin: Point; retrievedAt: string; parcelStatus: string; planStatus: string; parcels: BerlinParcel[]; plans: BerlinPlan[];
};
export type SiteDiscovery = { address: string; origin: Point; longitude: number; latitude: number; retrievedAt: string; references: SiteReference[]; buildings: LocationBuilding[]; sources: string[]; status: string[] };

const body = (locator?: Locator) => (locator ? { mapOrigin: locator.origin, mapLabel: locator.label } : {});
const locatorKey = (locator?: Locator) => [locator?.origin ?? null, locator?.label ?? null];

/**
 * Public lookups run only on request (a button or the site summary) and are shared through the query cache,
 * so the summary and the Site step panels show the same result without fetching twice.
 */
export const berlinContextQuery = (projectId: string, locator?: Locator) => ({
  queryKey: ["feasibility", projectId, "berlin-context", ...locatorKey(locator)],
  queryFn: () => api<BerlinSiteContext>(`/feasibility/projects/${projectId}/berlin-context`, body(locator), "POST"),
  staleTime: Infinity,
  retry: false,
});
export const siteDiscoveryQuery = (projectId: string, locator?: Locator) => ({
  queryKey: ["feasibility", projectId, "discovery", ...locatorKey(locator)],
  queryFn: () => api<SiteDiscovery>(`/feasibility/projects/${projectId}/references/discover`, body(locator), "POST"),
  staleTime: Infinity,
  retry: false,
});
export const useBerlinContext = (projectId: string, locator?: Locator) => useQuery({ ...berlinContextQuery(projectId, locator), enabled: false });
export const useSiteDiscovery = (projectId: string, locator?: Locator) => useQuery({ ...siteDiscoveryQuery(projectId, locator), enabled: false });

/** Discovery buildings in the location scene's local metres, for the 2D/3D context layers. */
export const discoveryContext = (projectId: string, data: SiteDiscovery, sourceLabel: string): LocationContext => ({
  siteId: `assessment:${projectId}`, address: data.address, origin: data.origin, longitude: data.longitude, latitude: data.latitude, crs: "EPSG:25833", radius: 200,
  buildings: data.buildings, trees: [], sources: data.sources.map((url) => ({ label: sourceLabel, url, surveyedAt: null })), importedAt: data.retrievedAt,
});
/** Local X/Z (x east, z south) back to EPSG:25833. */
export const discoveryPolygons = (data: Pick<SiteDiscovery, "origin">, building: LocationBuilding): Point[][][] =>
  building.polygons.map((polygon) => polygon.map((ring) => ring.map(([x, z]) => [x + data.origin[0], data.origin[1] - z] as Point)));

/** Even-odd point test on outer rings minus holes (EPSG:25833). */
export const containsPoint = (polygons: Point[][][], point: Point) => polygons.some(([outer, ...holes]) => {
  const inRing = (ring: Point[]) => {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!, b = ring[j]!;
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) result = !result;
    }
    return result;
  };
  return !!outer && inRing(outer) && !holes.some(inRing);
});
export type PlanningLaw = { kind: "b_plan" | "in_progress" | "baunutzungsplan" | "section34" | "section35" | "unresolved"; plans: BerlinPlan[]; landUse: BerlinLandUse | null };
/**
 * Planning-law hint for a point: an adopted B-Plan decides; otherwise the land-use plan suggests § 35 (forest, green
 * or farmland), the Baunutzungsplan applies in former West Berlin, and building land elsewhere suggests § 34. Always a proposal for review, never a legal determination.
 */
export function planningLawAt(context: BerlinSiteContext, point: Point): PlanningLaw {
  // Cached responses from before plan outlines were returned only know whether a plan covers the address.
  const plans = context.plans.filter((p) => (p.polygons?.length ? containsPoint(p.polygons, point) : p.containsAddress && point[0] === context.origin[0] && point[1] === context.origin[1]));
  const landUse = (context.landUse ?? []).find((l) => containsPoint(l.polygons, point)) ?? null;
  if (plans.some((p) => p.status === "adopted")) return { kind: "b_plan", plans, landUse };
  if (plans.length) return { kind: "in_progress", plans, landUse };
  if (context.planStatus !== "available") return { kind: "unresolved", plans, landUse };
  if (landUse?.category === "open") return { kind: "section35", plans, landUse };
  // Former West Berlin: the Baunutzungsplan 1960 with BO 58 is a transferred B-Plan wherever no newer plan replaced it.
  if (baunutzungsplanCoverage(context.locality?.key) === "covered") return { kind: "baunutzungsplan", plans, landUse };
  return { kind: landUse?.category === "building" ? "section34" : "unresolved", plans, landUse };
}

/** Protection hints for one parcel: monuments on or next to it (within `near` metres of its outline's vertices) and the preservation areas it lies in. */
export function protectionAt(context: BerlinSiteContext, parcel: Pick<BerlinParcel, "polygons">, near = 25) {
  const vertices = parcel.polygons.flatMap((p) => p[0] ?? []);
  const hints = (context.hints ?? []).filter((h) => h.polygons?.length);
  const inside = (h: BerlinHint) => vertices.some((v) => containsPoint(h.polygons!, v)) || h.polygons!.some((p) => (p[0] ?? []).some((v) => containsPoint(parcel.polygons, v)));
  const close = (h: BerlinHint) => h.polygons!.some((p) => (p[0] ?? []).some(([x, y]) => vertices.some(([vx, vy]) => Math.hypot(x - vx, y - vy) <= near)));
  const heritage = hints.filter((h) => h.kind === "heritage");
  return {
    heritageOn: heritage.filter(inside),
    heritageNear: heritage.filter((h) => !inside(h) && close(h)),
    social: hints.filter((h) => h.kind === "social_preservation" && inside(h)),
    urban: hints.filter((h) => h.kind === "urban_preservation" && inside(h)),
    /** Without polygons (older cached lookups) or with the lookup down, absence is not evidence. */
    known: context.hintStatus !== "unavailable" && (context.hints ?? []).every((h) => h.polygons),
  };
}
