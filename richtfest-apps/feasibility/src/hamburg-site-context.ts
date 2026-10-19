import { fromUtm, toUtm } from "@richtfest/shared";
import { containsPoint, features, polygonsOf } from "./berlin-site-context";
import type { AssessmentSite } from "./deps";

type Point = [number, number];

/** ALKIS vereinfacht (LGV Hamburg) as OGC API Features; served in EPSG:25832 only. */
const PARCELS = "https://api.hamburg.de/datasets/v1/alkis_vereinfacht/collections/Flurstueck/items";
const CRS_25832 = "http://www.opengis.net/def/crs/EPSG/0/25832";
export const HAMBURG_PARCEL_ATTRIBUTION = "ALKIS Hamburg © Freie und Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung (LGV), dl-de/by-2-0";

/** EPSG:25833 <-> EPSG:25832 through geographic coordinates; display/planning accuracy, not a survey transformation. */
export const to25832 = ([e, n]: Point): Point => { const [lon, lat] = fromUtm(e, n, 33); return toUtm(lon, lat, 32); };
export const to25833 = ([e, n]: Point): Point => { const [lon, lat] = fromUtm(e, n, 32); return toUtm(lon, lat, 33); };

export const hamburgParcelUrl = (origin: Point, radius = 50, limit = 100) => {
  const [e, n] = to25832(origin), url = new URL(PARCELS);
  // ldproxy expects %20-free values; URLSearchParams encodes the CRS URIs safely.
  url.search = new URLSearchParams({ f: "json", limit: String(limit), bbox: [e - radius, n - radius, e + radius, n + radius].map(v => v.toFixed(2)).join(","),
    "bbox-crs": CRS_25832, crs: CRS_25832 }).toString();
  return url.href;
};

const text = (v: unknown) => typeof v === "string" ? v.slice(0, 2000) : typeof v === "number" ? String(v) : "";
/** `aktualit` is the parcel's last update ("2025-12-01Z"). */
const sourceDate = (v: unknown) => {
  const day = text(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(day).toISOString().slice(0, 10) === day ? day : null;
};

/**
 * Hamburg parcels for the site assessment, in its EPSG:25833 frame. Official areas come from the ALKIS attribute;
 * reprojected outlines carry about 0.1 % scale and a ~4° grid rotation at Hamburg's longitude.
 */
export async function lookupHamburgParcels(site: AssessmentSite, signal: AbortSignal) {
  const parcelUrl = hamburgParcelUrl(site.origin);
  const result = await features(parcelUrl, signal).then(value => ({ ok: true as const, value }), () => ({ ok: false as const, value: [] }));
  const parcels = result.value.flatMap(feature => {
    const p = feature.properties;
    const polygons = polygonsOf(feature).map(polygon => polygon.map(ring => ring.map(point => to25833(point))));
    if (!polygons.length) return [];
    const number = `${text(p.flstnrzae)}${p.flstnrnen ? `/${text(p.flstnrnen)}` : ""}`;
    return [{ id: text(p.idflurst) || text(feature.id), label: `${text(p.gemarkung)}${p.flur ? ` · ${text(p.flur)}` : ""} / ${number}`,
      area: typeof p.flaeche === "number" && p.flaeche > 0 ? p.flaeche : null, sourceDate: sourceDate(p.aktualit),
      number, district: text(p.gemarkung), sourceUrl: parcelUrl, polygons, containsAddress: containsPoint(polygons, site.origin) }];
  }).sort((a, b) => Number(b.containsAddress) - Number(a.containsAddress));
  return { parcelUrl, parcels, parcelStatus: result.ok ? "available" : "unavailable" };
}

/** Same shape as the Berlin lookup. Plans, land use, heritage and localities are not connected for Hamburg yet. */
export async function lookupHamburgContext(site: AssessmentSite, signal: AbortSignal) {
  const { parcelUrl, parcels, parcelStatus } = await lookupHamburgParcels(site, signal);
  return { region: "HH" as const, attribution: HAMBURG_PARCEL_ATTRIBUTION, locality: null, landUse: [], landUseStatus: "not_connected", hints: [], hintStatus: "not_connected",
    address: site.address, origin: site.origin, crs: "EPSG:25833", retrievedAt: new Date().toISOString(), parcels, plans: [], parcelStatus, planStatus: "not_connected",
    sources: [...site.sources, { label: HAMBURG_PARCEL_ATTRIBUTION, url: parcelUrl }] };
}
