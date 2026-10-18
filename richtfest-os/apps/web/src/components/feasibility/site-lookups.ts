import { useQuery } from "@tanstack/react-query";
import type { LocationBuilding, LocationContext, SiteAssessmentInput, SiteReference } from "@richtfest/shared";
import { api } from "../../api";

type Point = [number, number];
type Locator = NonNullable<SiteAssessmentInput["siteLocator"]>;
export type BerlinParcel = { id: string; label: string; number?: string; district?: string; area: number | null; sourceDate: string | null; sourceUrl: string; polygons: Point[][][]; containsAddress: boolean };
export type BerlinPlan = { id: string; name: string; status: string; sourceUrl: string; documentUrl: string | null; explanationUrl: string | null; effectiveDate: string | null; polygons?: Point[][][]; containsAddress: boolean };
export type BerlinSiteContext = {
  hints?: { id: string; kind: string; label: string; sourceUrl: string; detailUrl: string | null; containsAddress: boolean }[];
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
