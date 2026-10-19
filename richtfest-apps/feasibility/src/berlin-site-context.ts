import { Router, type Request } from "express";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import type { AppDeps, AssessmentSite } from "./deps";
import { mapLocationSchema, resolveAssessmentLocation } from "./site-location";

type Point = [number, number];
type Polygon = Point[][];
type Feature = { id?: string; properties: Record<string, unknown>; geometry: { type: string; coordinates?: unknown } | null };
export const serviceUrl = (service: string, layer: string, point: Point, radius = 50, count = 100) => {
  const url = new URL(`https://gdi.berlin.de/services/wfs/${service}`);
  url.search = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: `${service}:${layer}`, outputFormat: "application/json", srsName: "EPSG:25833", bbox: [point[0] - radius, point[1] - radius, point[0] + radius, point[1] + radius, "EPSG:25833"].join(","), count: String(count) }).toString();
  return url.href;
};
const ringSchema = z.array(z.tuple([z.number().finite(), z.number().finite()])).min(4).max(20000);
const polygonsSchema = z.array(z.array(ringSchema).min(1)).max(1000);
export function polygonsOf(feature: Feature): Polygon[] {
  const geometry = feature.geometry;
  const result = polygonsSchema.safeParse(geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.type === "MultiPolygon" ? geometry.coordinates : null);
  return result.success ? result.data : [];
}
// A lookup is only a proposal. Boundary/nearby matches are all shown for deliberate selection.
export function containsPoint(polygons: Polygon[], point: Point): boolean {
  const inside = (ring: Point[]) => {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!, b = ring[j]!;
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
    }
    return result;
  };
  return polygons.some(polygon => inside(polygon[0]!) && !polygon.slice(1).some(inside));
}
const sourceDate = (v:unknown) => {if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v))return null;const d=new Date(v);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v?v:null;};
const text = (v: unknown) => typeof v === "string" ? v.slice(0, 2000) : "";
export const publicLink = (value: unknown) => {
  try { const u = new URL(text(value)); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
};
export async function features(url: string, signal: AbortSignal, limit = 100): Promise<Feature[]> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Public service unavailable (${response.status})`);
  // Bounded public-service reads, independent of customer upload limits.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty public service response");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 8_000_000) throw new Error("Public service response exceeds lookup budget"); parts.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const body = JSON.parse(Buffer.concat(parts).toString());
  if (!Array.isArray(body.features) || body.features.length > limit || Number(body.numberMatched) > body.features.length || body.features.length === limit)
    throw new Error("Public lookup incomplete; inspect the official map");
  const parsed = z.array(z.object({
    // WFS ids are strings; OGC API Features (Hamburg) uses numbers.
    id: z.union([z.string(), z.number().transform(String)]).optional(),
    properties: z.record(z.unknown()),
    geometry: z.object({ type: z.string(), coordinates: z.unknown() }).nullable(),
  })).safeParse(body.features);
  if (!parsed.success) throw new Error("Malformed public service response");
  return parsed.data;
}
/** Parcel and planning context for the resolved site, from the register of its state. */
export async function lookupSiteContext(site: AssessmentSite, signal: AbortSignal) {
  if (site.region === "HH") return (await import("./hamburg-site-context")).lookupHamburgContext(site, signal);
  return lookupBerlinContext(site, signal);
}
export async function lookupBerlinContext(site: Omit<AssessmentSite, "region">, signal: AbortSignal) {
  const parcelUrl = serviceUrl("alkis_flurstuecke", "flurstuecke", site.origin);
  const planUrls = [serviceUrl("bplan", "b_bp_fs", site.origin), serviceUrl("bplan", "a_bp_iv", site.origin)];
  const hintLayers = [["denkmale", "denkmale"], ["erhaltungsverordnungsgebiete", "erhaltgeb_em"], ["erhaltungsverordnungsgebiete", "erhaltgeb_es"]] as const;
  // Wide enough for the parcel map window: monuments next to the parcel (e.g. a protected avenue) matter as much as those on it.
  const hintUrls = hintLayers.map(([service,layer]) => serviceUrl(service,layer,site.origin,150,200));
  // Land-use plan (FNP): building land suggests § 34 where no B-Plan applies; forest, green or farmland suggests § 35.
  const landUseUrl = serviceUrl("fnp_ak", "fnp_ak_vektor", site.origin);
  // Locality (Ortsteil): in former West Berlin the Baunutzungsplan 1960 applies where no newer B-Plan replaced it.
  const localityUrl = serviceUrl("alkis_ortsteile", "ortsteile", site.origin, 1, 10);
  const [parcelResult, adoptedPlan, draftPlan, landUseResult, localityResult, ...hintResults] = await Promise.allSettled([features(parcelUrl, signal), ...planUrls.map(url => features(url, signal)), features(landUseUrl, signal), features(localityUrl, signal, 10), ...hintUrls.map(url => features(url, signal))]);
  const planResults = [adoptedPlan!, draftPlan!];
  const retrievedAt = new Date().toISOString();
  const parcels = parcelResult.status === "fulfilled" ? parcelResult.value.flatMap(feature => {
    const polygons = polygonsOf(feature), p = feature.properties;
    if (!polygons.length) return [];
    return [{ id: text(p.uuid) || text(feature.id), label: `${text(p.namgmk)} · ${text(p.fln)} / ${text(p.zae)}${p.nen ? ` / ${text(p.nen)}` : ""}`,
      area: typeof p.afl === "number" && p.afl > 0 ? p.afl : null, sourceDate: sourceDate(p.beg),
      number: `${text(p.zae)}${p.nen ? `/${text(p.nen)}` : ""}`, district: text(p.namgmk), sourceUrl: parcelUrl, polygons, containsAddress: containsPoint(polygons, site.origin) }];
  }).sort((a, b) => Number(b.containsAddress) - Number(a.containsAddress)) : [];
  const plans = planResults.flatMap((result, index) => result.status !== "fulfilled" ? [] : result.value.map(feature => ({
    id: text(feature.id), name: text(feature.properties.planname), status: index === 0 ? "adopted" : "in_progress",
    sourceUrl: planUrls[index]!, documentUrl: publicLink(feature.properties.scan_www), explanationUrl: publicLink(feature.properties.grund_www),
    effectiveDate: text(feature.properties.festsg_am) || null, polygons: polygonsOf(feature), containsAddress: containsPoint(polygonsOf(feature), site.origin),
    // Register facts: plan type (qualified, simple, project-specific), procedure and court review (e.g. partly invalid).
    planType: text(feature.properties.planartname) || null, procedure: text(feature.properties.verfahrensart) || null, courtReview: text(feature.properties.normkontr) || null,
  })));
  const localityFeature = localityResult!.status === "fulfilled" ? localityResult!.value.find(feature => containsPoint(polygonsOf(feature), site.origin)) : undefined;
  const locality = localityFeature && text(localityFeature.properties.sch) ? { name: text(localityFeature.properties.nam), key: text(localityFeature.properties.sch), sourceUrl: localityUrl } : null;
  const hints = hintResults.flatMap((result,index) => result.status !== "fulfilled" ? [] : result.value.map(feature => ({id: text(feature.id),kind:(["heritage","social_preservation","urban_preservation"] as const)[index]!, type: text(feature.properties.typ) || null, label: text(feature.properties.gebietsname) || text(feature.properties.typ) || text(feature.properties.id),polygons:polygonsOf(feature),sourceUrl:hintUrls[index]!,detailUrl:publicLink(feature.properties.link),effectiveDate:text(feature.properties.ae_inkraft)||text(feature.properties.f_in_kraft)||null,containsAddress:containsPoint(polygonsOf(feature),site.origin)})));
  const landUse = landUseResult!.status !== "fulfilled" ? [] : landUseResult!.value.flatMap(feature => {
    const polygons = polygonsOf(feature), label = text(feature.properties.nutzungsart);
    return polygons.length && label ? [{ id: text(feature.properties.gisid) || text(feature.id), label, purpose: text(feature.properties.zweckbestimmung) || null, category: landUseCategory(label), sourceUrl: landUseUrl, polygons, containsAddress: containsPoint(polygons, site.origin) }] : [];
  });
  return { region: "BE" as const, attribution: BERLIN_ATTRIBUTION, locality, landUse, landUseStatus: landUseResult!.status === "fulfilled" ? "available" : "unavailable", hints, hintStatus: hintResults.every(r => r.status === "fulfilled") ? "available" : "unavailable", address: site.address, origin: site.origin, crs: "EPSG:25833", retrievedAt, parcels, plans,
    parcelStatus: parcelResult.status === "fulfilled" ? "available" : "unavailable",
    planStatus: planResults.every(r => r.status === "fulfilled") ? "available" : "unavailable",
    sources: [...site.sources, { label: "ALKIS Berlin · dl-de/zero-2-0", url: parcelUrl }, ...planUrls.map(url => ({ label: "Berlin B-Plan register", url }))] };
}
const BERLIN_ATTRIBUTION = "Geoportal Berlin / TrueDOP 2024, ALKIS, B-Plan · dl-de/zero-2-0";
/** FNP land use as a planning-law hint, never a determination: building land → § 34 likely, open land → § 35 likely. */
export function landUseCategory(label: string): "building" | "open" | "other" {
  if (/baufläche|bauflaeche/i.test(label)) return "building";
  if (/wald|grünfläche|gruenflaeche|landwirtschaft|parkanlage|kleingarten|friedhof|wasserfläche|feld|wiese|naturschutz/i.test(label)) return "open";
  return "other";
}
export function createBerlinSiteContextRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  // Historic path: serves Berlin and Hamburg sites.
  router.post("/projects/:projectId/berlin-context", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read");
      const id = z.string().uuid().parse(req.params.projectId);
      if (!await d.project(id)) throw Object.assign(new Error("Project not found"), { status: 404, code: "not_found" });
      const signal = AbortSignal.timeout(15000);
      const site = await resolveAssessmentLocation(d, id, req.body, signal);
      res.setHeader("Cache-Control", "private, no-store");
      res.json(ok(await lookupSiteContext(site, signal)));
    } catch (e) { next(e); }
  });
  // Orthophoto under the parcel map: a fixed window around a Berlin point, snapped so nearby lookups share one cached image.
  router.get("/projects/:projectId/aerial", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read");
      const id = z.string().uuid().parse(req.params.projectId);
      const [e, n] = mapLocationSchema.shape.mapOrigin.parse([Number(req.query.e), Number(req.query.n)]);
      if (!await d.project(id)) throw Object.assign(new Error("Project not found"), { status: 404, code: "not_found" });
      if (!d.aerialImage) throw Object.assign(new Error("Aerial imagery is not configured"), { status: 503, code: "imagery_unavailable" });
      const snap = (v: number) => Math.round(v / AERIAL_SNAP_M) * AERIAL_SNAP_M;
      const image = await d.aerialImage(id, [snap(e), snap(n)], AERIAL_WINDOW_M);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", image.stale ? "private, no-cache" : `private, max-age=${Math.max(0, Math.floor((image.freshUntil.getTime() - Date.now()) / 1000))}`);
      res.setHeader("X-Imagery-Attribution", encodeURIComponent(image.attribution));
      res.end(image.body);
    } catch (e) { next(e); }
  });
  return router;
}
/** Half width of the orthophoto window and its grid; the client places the image at the same snapped square. */
export const AERIAL_WINDOW_M = 200;
export const AERIAL_SNAP_M = 25;
