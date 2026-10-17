import { projectAddressInput, toUtm, type ProjectAddress, type LocationContext, type LocationBuilding, type LocationTree, type PublicDataSnapshot } from "@richtfest/shared";
import type { LocationWorkerDeps } from "./deps";

export function validateLocationAddress(input: ProjectAddress) {
  const address = projectAddressInput.parse(input);
  if (!address.street || !address.city) throw new Error("Site address requires a street, house number and city in project details");
  if (address.country && !["de", "deutschland", "germany"].includes(address.country.toLowerCase()))
    throw new Error("Site context currently supports Berlin and Rheinland-Pfalz, Germany only");
  const parts = address.street.match(/^(.+?)\s+(\d+)\s*([a-z]?)$/i);
  if (!parts || (address.postalCode && !/^\d{5}$/.test(address.postalCode)))
    throw new Error("Site address needs a street and exact house number (for example Giersstraße 20); check the postal code too");
  return { address, street: parts[1]!, house: Number(parts[2]), suffix: parts[3]!.toLowerCase() };
}

/** Resolve one exact house address. Never substitute a street/city centroid. */
export async function resolveLocationAddress(input: ProjectAddress, signal: AbortSignal) {
  const { address, street, house, suffix } = validateLocationAddress(input);
  if (address.city!.toLowerCase() !== "berlin") {
    const { resolveRlpAddress } = await import("./location-rlp");
    return resolveRlpAddress(address, signal);
  }
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const normal = (value: string) => value.trim().toLowerCase().replaceAll("ß", "ss");
  // Fetch bounded spelling candidates, then require exact normalized equality
  // below. Replacing every "ss" with "ß" corrupts names such as Giersstrasse.
  const pattern = street.replace(/ß|ss/gi, "%");
  const filter = `str_name ILIKE ${quote(pattern)} AND hnr=${house}${address.postalCode ? ` AND plz=${quote(address.postalCode)}` : ""}`;
  const url = new URL("https://gdi.berlin.de/services/wfs/adressen_berlin");
  url.search = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "adressen_berlin:adressen_berlin", outputFormat: "application/json", srsName: "EPSG:4326", CQL_FILTER: filter, count: "100" }).toString();
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Berlin address service unavailable (${response.status}); retry import`);
  const json = JSON.parse((await boundedBody(response, 1_000_000)).toString());
  if (!Array.isArray(json.features) || Number(json.numberMatched) > json.features.length) throw new Error("Site address lookup incomplete; add the postal code or retry");
  const matches = (json.features as Feature[]).filter(f => normal(String(f.properties.str_name ?? "")) === normal(street)
    && Number(f.properties.hnr) === house && normal(String(f.properties.hnr_zusatz ?? "")) === suffix
    && (!address.postalCode || f.properties.plz === address.postalCode));
  if (!matches.length) throw new Error("Site address not found in the official Berlin address register; check project details");
  if (matches.length !== 1) throw new Error("Site address is ambiguous; add the postal code in project details");
  const match = matches[0]!, p = match.properties;
  const [longitude, latitude] = match.geometry?.coordinates ?? [];
  if (match.geometry?.type !== "Point" || !Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < 13 || longitude > 14 || latitude < 52 || latitude > 53)
    throw new Error("Berlin address service returned invalid coordinates");
  return { siteId: `berlin-address:${p.adressid}`, projectAddress: address,
    address: `${p.str_name} ${p.hnr}${p.hnr_zusatz || ""}, ${p.plz} Berlin`, longitude, latitude,
    radius: 100, origin: toUtm(longitude, latitude, 33),
    sources: [{ label: "Official Berlin address register (CC BY 3.0 DE); Amt für Statistik Berlin-Brandenburg; not a surveyed setting-out point", url: url.href, surveyedAt: null }] };
}
export { toUtm };
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
export async function importLocationContext(address: ProjectAddress, signal: AbortSignal, publicDataSnapshot?: LocationWorkerDeps["publicDataSnapshot"]): Promise<LocationContext> {
  const site = await resolveLocationAddress(address, signal);
  if ("crs" in site && site.crs === "EPSG:25832") {
    const { importRlpBuildings } = await import("./location-rlp");
    const { buildings, sources } = await importRlpBuildings(site.origin, site.radius, signal);
    return { ...site, buildings, trees: [], sources: [...site.sources, ...sources], importedAt: new Date().toISOString() };
  }
  const snapshot = await publicDataSnapshot?.(site.origin, site.radius);
  if (snapshot) return contextFromPublicData(snapshot, site);
  const { origin, radius: r } = site;
  const bbox = [origin[0] - r, origin[1] - r, origin[0] + r, origin[1] + r, "EPSG:25833"].join(",");
  const layers = [
    ["ua_gebaeudehoehen", "gebaeudehoehen"], ["baumbestand", "strassenbaeume"], ["baumbestand", "anlagenbaeume"],
  ];
  const sources: LocationContext["sources"] = [...site.sources];
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
  return { ...site, origin, buildings: collections[0]!.map(f => buildingFeature(f, origin)).filter((f): f is LocationBuilding => !!f), trees: collections.slice(1).flat().map(f => treeFeature(f, origin)).filter((f): f is LocationTree => !!f), sources, importedAt: new Date().toISOString() };
}

export function contextFromPublicData(snapshot: PublicDataSnapshot, site: Pick<LocationContext, "siteId" | "projectAddress" | "address" | "origin" | "longitude" | "latitude" | "radius" | "sources">): LocationContext {
  const buildings: LocationBuilding[] = [], trees: LocationTree[] = [];
  for (const release of snapshot.releases) {
    for (const { revisionId, feature } of release.features) {
      const common = { id: `${release.datasetId}:${feature.sourceId}`, sourceId: feature.sourceId, publicRevisionId: revisionId, height: feature.height };
      if (feature.kind === "building") buildings.push({ ...common, label: feature.label, roof: feature.roof, polygons: feature.geometry.coordinates.map(polygon => polygon.map(ring => ring.map(p => localXZ(p, site.origin)))) });
      else trees.push({ ...common, position: localXZ(feature.geometry.coordinates, site.origin), crownDiameter: feature.crownDiameter, species: feature.species });
    }
  }
  return { ...site, buildings, trees, importedAt: new Date().toISOString(),
    sources: [...site.sources.filter(source => !snapshot.releases.some(r => r.sourceUrl === source.url)),
      ...snapshot.releases.map(r => ({ label: `${r.label} (${r.metadata.licence}; unreviewed context)`, url: r.sourceUrl, surveyedAt: r.metadata.surveyedAt }))],
    publicReleases: snapshot.releases.map(r => ({ releaseId: r.id, partitionId: r.partitionId, retrievedAt: r.retrievedAt, publishedAt: r.publishedAt })),
  };
}
