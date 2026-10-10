import type { LocationContext, LocationBuilding, LocationTree } from "@richtfest/shared";

/** Verified exact house-number match, OSM way 173050070, queried 2026-10-10.
 * This is a geocoded building centre, not a surveyed setting-out point. */
export const SITE = {
  siteId: "berlin-giersstrasse-20" as const,
  address: "Giersstraße 20, 13088 Berlin",
  longitude: 13.4827108, latitude: 52.5575494, radius: 100,
  evidence: "https://nominatim.openstreetmap.org/search?street=20%20Giersstra%C3%9Fe&city=Berlin&format=jsonv2&addressdetails=1",
};
/** WGS84 -> ETRS89 / UTM zone 33N. WGS84/ETRS89 difference is immaterial
 * for this unsurveyed display; this must not be used for engineering clearance. */
export function toUtm33(longitude: number, latitude: number): [number, number] {
  const a = 6378137, e2 = 0.00669438002290, k = 0.9996;
  const p = latitude * Math.PI / 180, l = (longitude - 15) * Math.PI / 180;
  const ep = e2 / (1 - e2), n = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  const t = Math.tan(p) ** 2, c = ep * Math.cos(p) ** 2, A = Math.cos(p) * l;
  const m = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * p)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * p)
    - 35 * e2 ** 3 / 3072 * Math.sin(6 * p));
  return [500000 + k * n * (A + (1 - t + c) * A ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep) * A ** 5 / 120),
    k * (m + n * Math.tan(p) * (A ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * A ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep) * A ** 6 / 720))];
}
export const SITE_ORIGIN = toUtm33(SITE.longitude, SITE.latitude);
export const localXZ = (point: number[], origin: [number, number]): [number, number] => [point[0]! - origin[0], origin[1] - point[1]!];
export const measuredHeight = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
type Feature = { id?: string; properties: Record<string, any>; geometry: { type: string; coordinates: any } | null };
export function buildingFeature(f: Feature, origin: [number, number]): LocationBuilding | null {
  if (!f.geometry || !["MultiPolygon", "Polygon"].includes(f.geometry.type)) return null;
  const p = f.properties, sourceId = String(p.gml_id ?? f.id);
  const polygons = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  return { id: sourceId, sourceId, polygons: polygons.map((polygon: number[][][]) => polygon.map(ring => ring.map(point => localXZ(point, origin)))), height: measuredHeight(p.hoehe), label: [p.strasse, p.hnr].filter(Boolean).join(" ") || "Building", roof: p.dachart_txt ?? null };
}
export function treeFeature(f: Feature, origin: [number, number]): LocationTree | null {
  if (f.geometry?.type !== "Point") return null;
  const p = f.properties, sourceId = String(p.gisid ?? f.id);
  return { id: String(f.id ?? sourceId), sourceId, position: localXZ(f.geometry.coordinates, origin), height: measuredHeight(p.baumhoehe), crownDiameter: measuredHeight(p.kronedurch), species: p.art_dtsch ?? "" };
}
export async function boundedBody(response: Response, max: number): Promise<Buffer> {
  if (!response.body) throw new Error("Upstream returned no body");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error("Upstream payload exceeds bounded import budget");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export async function importLocationContext(signal: AbortSignal): Promise<LocationContext> {
  const origin = SITE_ORIGIN, r = SITE.radius;
  const bbox = [origin[0] - r, origin[1] - r, origin[0] + r, origin[1] + r, "EPSG:25833"].join(",");
  const layers = [
    ["ua_gebaeudehoehen", "gebaeudehoehen"], ["baumbestand", "strassenbaeume"], ["baumbestand", "anlagenbaeume"],
  ];
  const sources: LocationContext["sources"] = [{ label: "Exact address geocoder: OSM way 173050070 (ODbL); building centre, not surveyed", url: SITE.evidence, surveyedAt: null }];
  const collections = await Promise.all(layers.map(async ([service, layer]) => {
    const url = new URL(`https://gdi.berlin.de/services/wfs/${service}`);
    url.search = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: `${service}:${layer}`, outputFormat: "application/json", srsName: "EPSG:25833", bbox, count: "10000" }).toString();
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Berlin WFS unavailable (${response.status}); retry import`);
    const json = JSON.parse((await boundedBody(response, 10_000_000)).toString());
    if (!Array.isArray(json.features) || Number(json.numberMatched) > json.features.length) throw new Error("Berlin WFS returned incomplete features; retry import");
    sources.push({ label: `Berlin ${service}:${layer} (unreviewed context)`, url: url.href, surveyedAt: null });
    return json.features as Feature[];
  }));
  const { evidence: _evidence, ...site } = SITE;
  return { ...site, origin, buildings: collections[0]!.map(f => buildingFeature(f, origin)).filter((f): f is LocationBuilding => !!f), trees: collections.slice(1).flat().map(f => treeFeature(f, origin)).filter((f): f is LocationTree => !!f), sources, importedAt: new Date().toISOString() };
}
