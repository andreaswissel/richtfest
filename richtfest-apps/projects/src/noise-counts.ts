import { createHash } from "node:crypto";
import type { EnvironmentSurvey, MappedRail, MappedRoad, RailTraffic, TrafficCountRecord } from "@richtfest/shared";
import { boundedBody } from "./location-context";
import { distanceToPolylineMeters, readGmlFeatures, type GmlFeature } from "./noise-geodata";

/**
 * Nationwide published counts laid over the roads and railways a state
 * connector mapped: the EU strategic noise mapping source data of the
 * Umweltbundesamt (roads above 3 million vehicles a year, major railways) and
 * the Eisenbahn-Bundesamt's federal main lines (trains per year by period).
 * Counts attach to a mapped road or railway only where a source segment runs
 * along it; nothing is interpolated, and richer state counts (Berlin) win.
 */
export const UBA_ROADS_WFS = "https://haleconnect.com/ows/services/org.1123.e059b78e-459c-49aa-91d0-2bc4808520bc_wfs";
export const UBA_RAIL_WFS = "https://haleconnect.com/ows/services/org.1123.abd99bf8-94a6-4456-8ba0-1ce837ae39bf_wfs";
export const EBA_WFS = "https://geoinformation.eisenbahn-bundesamt.de/wfs/eba/services/wfs";
export const UBA_ROAD_SOURCE = "UBA Lärmkartierung 2022 (Kfz/Jahr ÷ 365)";
export const UBA_RAIL_SOURCE = "UBA Lärmkartierung 2022 (Züge/Jahr)";
export const EBA_RAIL_SOURCE = "EBA Lärmkartierung Runde 4";
const UBA_YEAR = 2022, EBA_YEAR = 2022;
/** Reported for a few classified roads instead of a count; it is the reporting threshold, not a measurement. */
const UBA_PLACEHOLDER_FLOW = 3_000_300;
const ROAD_LIMIT = 1000, RAIL_LIMIT = 500;
/** A source segment belongs to a mapped axis when most of it runs within this distance and roughly parallel. */
export const ROAD_MATCH_M = 15, RAIL_MATCH_M = 30;
/** Route-number matches must still lie near the mapped railway, so a same-numbered line elsewhere in the box does not count. */
const RAIL_ROUTE_RANGE_M = 300;
const PARALLEL_COS = Math.cos(30 * Math.PI / 180), FIT_SHARE = 0.6, MAX_SAMPLES = 60, SAMPLE_STEP_M = 5;

type Category = EnvironmentSurvey["categories"][number];
type RawResponse = { url: string; retrievedAt: string; sha256: string; body: string };
type Site = { latitude: number; longitude: number };
type Parts = Array<Array<[number, number]>>;

export type RoadCount = { id: string; annual: number; name: string | null; code: string | null; parts: Parts };
export type RailCount = { id: string; routeNumbers: string[]; parts: Parts; traffic: RailTraffic };

// --- Parsing ---

/** GML 3.2 in EPSG:4326 lists latitude first; returns [longitude, latitude] parts. */
const lonLatParts = (feature: GmlFeature): Parts => feature.parts.map(values => {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < values.length; i += 2) if (Number.isFinite(values[i]) && Number.isFinite(values[i + 1])) pairs.push([values[i + 1]!, values[i]!]);
  return pairs;
}).filter(part => part.length >= 2);
const field = (feature: GmlFeature, key: string) => feature.fields[key]?.[0]?.trim() || null;
/** Whole counts; the EBA writes them with German thousands separators ("111.074"). */
export const germanCount = (value: string | null) => {
  const text = value?.trim();
  if (!text || !/^\d{1,3}(\.\d{3})*$|^\d+$/.test(text)) return null;
  const n = Number(text.replaceAll(".", ""));
  return Number.isSafeInteger(n) ? n : null;
};
const routes = (value: string | null) => [...new Set((value ?? "").split(/[,;#\s]+/).map(item => item.trim()).filter(item => /^\d{3,5}$/.test(item)))].sort();

export function ubaRoadCounts(features: GmlFeature[]): RoadCount[] {
  return features.flatMap(feature => {
    const annual = Number(field(feature, "annualTrafficFlow"));
    const parts = lonLatParts(feature);
    if (!Number.isSafeInteger(annual) || annual <= 0 || annual === UBA_PLACEHOLDER_FLOW || !parts.length) return [];
    return [{ id: field(feature, "roadId_identifier") ?? feature.id, annual, name: field(feature, "roadName_localName"), code: field(feature, "roadNationalCode"), parts }];
  });
}

export function ubaRailCounts(features: GmlFeature[]): RailCount[] {
  return features.flatMap(feature => {
    const annual = Number(field(feature, "annualTrafficFlow"));
    const parts = lonLatParts(feature);
    if (!Number.isSafeInteger(annual) || annual <= 0 || !parts.length) return [];
    const id = field(feature, "railId_identifier") ?? feature.id, routeNumbers = routes(field(feature, "railNationalCode"));
    return [{ id, routeNumbers, parts, traffic: { trainsPerYear: annual, day: null, evening: null, night: null, routeNumbers, segmentId: id.slice(0, 100), year: UBA_YEAR, source: UBA_RAIL_SOURCE } }];
  });
}

export function ebaRailCounts(features: GmlFeature[]): RailCount[] {
  return features.flatMap(feature => {
    const parts = lonLatParts(feature);
    const total = germanCount(field(feature, "summe_gesamt")) ?? germanCount(field(feature, "atf"));
    // A published zero is a mapped corridor without counted trains, not a count to plan with.
    if (!total || !parts.length) return [];
    const id = field(feature, "uniquerail_id") ?? feature.id, routeNumbers = routes(field(feature, "str_liste"));
    const year = Number(/^(\d{4})-/.exec(field(feature, "net_beginlifespanversion") ?? "")?.[1]) || EBA_YEAR;
    const vehicleCategories = [1, 2, 3, 4].map(n => ({ label: `VK${n}`, day: germanCount(field(feature, `zuganzahl_tag_vk${n}`)), evening: germanCount(field(feature, `zuganzahl_abend_vk${n}`)),
      night: germanCount(field(feature, `zuganzahl_nacht_vk${n}`)), total: germanCount(field(feature, `zuganzahl_gesamt_vk${n}`)) })).filter(category => category.total !== null);
    return [{ id, routeNumbers, parts, traffic: { trainsPerYear: total, day: germanCount(field(feature, "summe_tag")), evening: germanCount(field(feature, "summe_abend")), night: germanCount(field(feature, "summe_nacht")),
      ...(vehicleCategories.length ? { vehicleCategories } : {}), routeNumbers, segmentId: id.slice(0, 100), year, source: `${EBA_RAIL_SOURCE} (${year})` } }];
  });
}

// --- Geometry (local metres around the site) ---

type Segment = { ax: number; ay: number; bx: number; by: number; ux: number; uy: number; length: number };
type Shape = { segments: Segment[]; box: [number, number, number, number] };
const projector = (site: Site) => {
  const kx = 111320 * Math.cos(site.latitude * Math.PI / 180), ky = 110574;
  return ([lon, lat]: [number, number]) => [(lon - site.longitude) * kx, (lat - site.latitude) * ky] as const;
};
function shape(parts: Parts, local: ReturnType<typeof projector>): Shape {
  const segments: Segment[] = [], box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of parts) for (let i = 0; i + 1 < part.length; i++) {
    const [ax, ay] = local(part[i]!), [bx, by] = local(part[i + 1]!), length = Math.hypot(bx - ax, by - ay);
    if (!length) continue;
    segments.push({ ax, ay, bx, by, ux: (bx - ax) / length, uy: (by - ay) / length, length });
    box[0] = Math.min(box[0], ax, bx); box[1] = Math.min(box[1], ay, by); box[2] = Math.max(box[2], ax, bx); box[3] = Math.max(box[3], ay, by);
  }
  return { segments, box };
}
const overlaps = (a: Shape["box"], b: Shape["box"], margin: number) => a[0] - margin <= b[2] && b[0] - margin <= a[2] && a[1] - margin <= b[3] && b[1] - margin <= a[3];
/** Points spread along a polyline (at most MAX_SAMPLES), each with the direction of its segment. */
function samples(source: Shape) {
  const total = source.segments.reduce((sum, segment) => sum + segment.length, 0);
  const step = Math.max(SAMPLE_STEP_M, total / MAX_SAMPLES);
  return source.segments.flatMap(segment => {
    const n = Math.max(1, Math.round(segment.length / step));
    return Array.from({ length: n }, (_, i) => { const t = (i + 0.5) / n; return { x: segment.ax + t * (segment.bx - segment.ax), y: segment.ay + t * (segment.by - segment.ay), ux: segment.ux, uy: segment.uy }; });
  });
}
function nearest(point: { x: number; y: number }, target: Shape) {
  let best = { distance: Infinity, ux: 0, uy: 0 };
  for (const s of target.segments) {
    const t = Math.max(0, Math.min(1, ((point.x - s.ax) * s.ux + (point.y - s.ay) * s.uy) / s.length));
    const distance = Math.hypot(s.ax + t * (s.bx - s.ax) - point.x, s.ay + t * (s.by - s.ay) - point.y);
    if (distance < best.distance) best = { distance, ux: s.ux, uy: s.uy };
  }
  return best;
}
/** Mean distance of a source segment to a mapped axis when most of it runs along the axis within the tolerance; null otherwise. */
function alongDistance(source: Shape, target: Shape, tolerance: number): number | null {
  if (!source.segments.length || !target.segments.length || !overlaps(source.box, target.box, tolerance)) return null;
  const points = samples(source);
  let fit = 0, sum = 0;
  for (const point of points) {
    const near = nearest(point, target);
    if (near.distance <= tolerance && Math.abs(point.ux * near.ux + point.uy * near.uy) >= PARALLEL_COS) fit++;
    sum += Math.min(near.distance, tolerance * 4);
  }
  const mean = sum / points.length;
  return fit / points.length >= FIT_SHARE && mean <= tolerance ? mean : null;
}
const minDistance = (source: Shape, target: Shape) => Math.min(...samples(source).map(point => nearest(point, target).distance));

// --- Matching ---

/** Attaches each source segment to the mapped road it runs along (nearest when several qualify); per road the matched segment nearest the site sets the count. Roads that already carry a count keep it. */
export function matchRoadCounts(roads: MappedRoad[], counts: RoadCount[], site: Site): number {
  const local = projector(site);
  const targets = roads.map(road => ({ road, shape: shape(road.axes ?? [], local) })).filter(target => !target.road.traffic && target.shape.segments.length);
  const matched = new Map<MappedRoad, RoadCount[]>();
  for (const count of counts) {
    const source = shape(count.parts, local);
    let best: { road: MappedRoad; distance: number } | null = null;
    for (const target of targets) {
      const distance = alongDistance(source, target.shape, ROAD_MATCH_M);
      if (distance !== null && (!best || distance < best.distance)) best = { road: target.road, distance };
    }
    if (best) matched.set(best.road, [...(matched.get(best.road) ?? []), count]);
  }
  for (const [road, items] of matched) {
    const count = items.map(item => ({ item, distance: distanceToPolylineMeters(site, item.parts) ?? Infinity })).sort((a, b) => a.distance - b.distance)[0]!.item;
    road.traffic = { dailyTraffic: Math.round(count.annual / 365), heavyVehicles: null, year: UBA_YEAR, source: UBA_ROAD_SOURCE };
  }
  return matched.size;
}

/** Mainline or unclassified tracks; trams and U-Bahn are not in the federal noise mapping. */
const heavyRail = (rail: MappedRail) => !rail.categories.length || rail.categories.some(code => code.startsWith("11"));

/**
 * Per mapped railway: segments sharing one of its VzG route numbers first,
 * otherwise segments running along its axis; of those, the one nearest the site.
 * Railways that already carry a count keep it.
 */
export function matchRailCounts(rail: MappedRail[], counts: RailCount[], site: Site): number {
  const local = projector(site);
  const sources = counts.map(count => ({ count, shape: shape(count.parts, local), distance: distanceToPolylineMeters(site, count.parts) ?? Infinity }));
  let attached = 0;
  for (const item of rail) {
    if (item.traffic || !heavyRail(item)) continue;
    const target = shape(item.axes ?? [], local);
    const near = (source: typeof sources[number]) => !target.segments.length || minDistance(source.shape, target) <= RAIL_ROUTE_RANGE_M;
    let candidates = item.routeNumbers.length ? sources.filter(source => source.count.routeNumbers.some(route => item.routeNumbers.includes(route)) && near(source)) : [];
    if (!candidates.length && target.segments.length) candidates = sources.filter(source => alongDistance(source.shape, target, RAIL_MATCH_M) !== null);
    const best = candidates.sort((a, b) => a.distance - b.distance)[0];
    if (best) { item.traffic = best.count.traffic; attached++; }
  }
  return attached;
}

// --- Imported file counts (BASt, state road authorities) ---

/** A count station (point) belongs to a mapped road whose axis passes within this distance. */
export const STATION_MATCH_M = 30;
/** A counted section must run along the mapped axis for at least this length near the axis. */
const SECTION_MIN_FIT_M = 50, SECTION_STEP_M = 5, SECTION_MAX_SAMPLES = 400;
const designationKey = (value: string | null | undefined) => value ? value.replace(/\s+/g, "").toUpperCase() : null;

/**
 * Mean distance of a counted section to a mapped axis where the section runs
 * along it; unlike `alongDistance`, only the part of a long section near the
 * axis is judged, since state sections often run for kilometres past the site.
 */
function sectionDistance(source: Shape, target: Shape, tolerance: number): number | null {
  const reach = tolerance * 4;
  if (!source.segments.length || !target.segments.length || !overlaps(source.box, target.box, reach)) return null;
  const box = target.box, near = (s: Segment) => Math.max(s.ax, s.bx) >= box[0] - reach && Math.min(s.ax, s.bx) <= box[2] + reach && Math.max(s.ay, s.by) >= box[1] - reach && Math.min(s.ay, s.by) <= box[3] + reach;
  const segments = source.segments.filter(near), total = segments.reduce((sum, segment) => sum + segment.length, 0);
  const step = Math.max(SECTION_STEP_M, total / SECTION_MAX_SAMPLES);
  let close = 0, fit = 0, sum = 0;
  for (const segment of segments) {
    const n = Math.max(1, Math.round(segment.length / step));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, point = { x: segment.ax + t * (segment.bx - segment.ax), y: segment.ay + t * (segment.by - segment.ay) };
      const hit = nearest(point, target);
      if (hit.distance > reach) continue;
      close++;
      if (hit.distance <= tolerance && Math.abs(segment.ux * hit.ux + segment.uy * hit.uy) >= PARALLEL_COS) { fit++; sum += hit.distance; }
    }
  }
  return fit * step >= SECTION_MIN_FIT_M && fit / close >= FIT_SHARE ? sum / fit : null;
}

const recordParts = (record: TrafficCountRecord): Parts => record.geometry.type === "Point" ? [[record.geometry.coordinates]] : record.geometry.coordinates;

/** Short provenance for a road count, e.g. "BASt Dauerzählstellen 2024, station 9539 AS Allersberg (S)". */
export const importedCountSource = (record: TrafficCountRecord) =>
  `${record.label}${record.label.includes(String(record.year)) ? "" : ` (${record.year})`}, ${record.kind === "station" ? "station" : "section"} ${record.stationId}${record.name ? ` ${record.name}` : ""}`.slice(0, 200);

/**
 * Attaches imported counts to mapped roads that have none yet. A station
 * attaches to every road within STATION_MATCH_M carrying its designation, or,
 * when none does, to the nearest road without a designation; a road with a
 * different designation never takes it. Sections attach the same way where
 * they run along the axis within ROAD_MATCH_M. Per road the most recent count
 * wins, then the more specific source (state section > BASt permanent station >
 * BASt SVZ point), then the one nearest the site. Returns the records used.
 */
export function matchImportedCounts(roads: MappedRoad[], records: TrafficCountRecord[], site: Site): TrafficCountRecord[] {
  const local = projector(site);
  const targets = roads.map(road => ({ road, key: designationKey(road.designation), shape: shape(road.axes ?? [], local) })).filter(target => !target.road.traffic && target.shape.segments.length);
  const candidates = new Map<MappedRoad, Array<{ record: TrafficCountRecord; site: number }>>();
  for (const record of records) {
    const key = designationKey(record.road);
    const hits = targets.flatMap(target => {
      if (key && target.key && key !== target.key) return [];
      let distance: number | null;
      if (record.geometry.type === "Point") {
        const [x, y] = local(record.geometry.coordinates);
        distance = nearest({ x, y }, target.shape).distance;
        if (distance > STATION_MATCH_M) distance = null;
      } else distance = sectionDistance(shape(record.geometry.coordinates, local), target.shape, ROAD_MATCH_M);
      return distance === null ? [] : [{ target, distance, named: Boolean(key && target.key) }];
    });
    const named = hits.filter(hit => hit.named);
    const chosen = named.length ? named : hits.filter(hit => !hit.target.key).sort((a, b) => a.distance - b.distance).slice(0, 1);
    const fromSite = distanceToPolylineMeters(site, recordParts(record)) ?? Infinity;
    for (const hit of chosen) candidates.set(hit.target.road, [...(candidates.get(hit.target.road) ?? []), { record, site: fromSite }]);
  }
  const used = new Set<TrafficCountRecord>();
  for (const [road, items] of candidates) {
    const { record } = items.sort((a, b) => b.record.year - a.record.year || b.record.specificity - a.record.specificity || a.site - b.site)[0]!;
    road.traffic = { dailyTraffic: record.dailyTraffic, heavyVehicles: record.heavyVehicles, year: record.year, source: importedCountSource(record) };
    used.add(record);
  }
  return [...used];
}

// --- Retrieval ---

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const timeout = (signal: AbortSignal | undefined, ms: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
async function wfs(url: string, type: string, limit: number, retrievedAt: string, rawResponses: RawResponse[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const response = await fetch(url, { signal: timeout(signal, 30000), redirect: "error" });
  if (!response.ok) throw new Error(`Count source answered ${response.status}`);
  const body = (await boundedBody(response, 8 * 1024 * 1024)).toString("utf8");
  if (!/<wfs:FeatureCollection[\s>]/.test(body)) throw new Error("Count source returned no feature collection");
  const sha256 = hash(body);
  rawResponses.push({ url, retrievedAt, sha256, body });
  const features = readGmlFeatures(body, [type]);
  return { features: features.slice(0, limit), truncated: features.length > limit, source: { url, retrievedAt, sha256 } };
}
/** GML 3.2 in EPSG:4326 takes latitude first. */
const latLonBox = (bbox: [number, number, number, number]) => `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]},urn:ogc:def:crs:EPSG::4326`;
export const ubaUrl = (service: string, type: string, bbox: [number, number, number, number], limit: number) =>
  `${service}?${new URLSearchParams({ SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: `gpkg:${type}`, COUNT: String(limit + 1), BBOX: latLonBox(bbox) })}`;
// The EBA's GeoJSON output is cut off mid-document; GML with an EPSG:4326 output CRS is complete.
export const ebaUrl = (bbox: [number, number, number, number], limit: number) =>
  `${EBA_WFS}?${new URLSearchParams({ SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: "app:Verkehrsweg", NAMESPACES: "xmlns(app,http://www.deegree.org/app)", COUNT: String(limit + 1), SRSNAME: "urn:ogc:def:crs:EPSG::4326", BBOX: latLonBox(bbox) })}`;

const unavailable = "Nationwide count source unavailable; published counts were not checked.";

const importedNote = (records: TrafficCountRecord[]) => {
  const sources = [...new Map(records.map(record => [record.sourceId, record])).values()];
  return `Counts marked ${sources.map(record => `"${record.label}"`).join(", ")} are published counts imported from the source files (${sources.map(record => `${record.label}: ${record.licence}`).join("; ")}): Kfz/24h (DTV) and heavy vehicles/24h (SV). Count stations attach to a mapped road within ${STATION_MATCH_M} m carrying the same designation, counted sections where they run along the road within ${ROAD_MATCH_M} m. They take precedence over the UBA noise-mapping counts; counts a state connector already set (Berlin) are kept. Per road the most recent count wins, then a state section over a BASt station; SVZ 2021 counts fall in the pandemic. Planning inputs, not an acoustic assessment.`.slice(0, 2000);
};

/**
 * Lays the nationwide counts over the roads and rail categories a state
 * connector built (mutating their mapped lists, sources and limitations).
 * Imported file counts (BASt, state road authorities) attach first; the UBA's
 * EU noise-mapping counts fill roads still without one. Counts a state
 * connector already set (Berlin) are never replaced.
 * Never throws except on abort; a failed source leaves the lists as they were.
 */
export async function overlayNationalCounts(categories: Category[], site: Site, bbox: [number, number, number, number], retrievedAt: string, rawResponses: RawResponse[], signal?: AbortSignal,
  importedCounts?: (bbox: [number, number, number, number]) => Promise<TrafficCountRecord[]>) {
  const roads = categories.find(item => item.category === "roads"), rail = categories.find(item => item.category === "rail");
  const tasks: Array<Promise<void>> = [];
  if (roads?.mapped?.length) tasks.push((async () => {
    const mapped = roads.mapped!.filter((item): item is MappedRoad => item.kind === "road");
    const url = ubaUrl(UBA_ROADS_WFS, "MajorRoadSource", bbox, ROAD_LIMIT);
    const uba = wfs(url, "MajorRoadSource", ROAD_LIMIT, retrievedAt, rawResponses, signal).catch(() => { signal?.throwIfAborted(); return null; });
    if (importedCounts) {
      const records = await importedCounts(bbox).catch(() => null);
      signal?.throwIfAborted();
      if (!records) roads.limitations.push("Imported traffic counts (BASt, state road authorities) could not be read; they were not checked.");
      else {
        const used = matchImportedCounts(mapped, records, site);
        // Provenance: the imported source file (URL and SHA-256) and when its records were imported.
        for (const record of new Map(used.map(item => [`${item.sourceUrl}|${item.checksum}`, item])).values()) roads.sources.push({ url: record.sourceUrl, retrievedAt: record.importedAt, sha256: record.checksum });
        if (used.length) roads.limitations.push(importedNote(used));
      }
    }
    const result = await uba;
    if (!result) { roads.sources.push({ url, retrievedAt, sha256: null }); roads.limitations.push(unavailable); return; }
    roads.sources.push(result.source);
    const attached = matchRoadCounts(mapped, ubaRoadCounts(result.features), site);
    if (attached) roads.limitations.push(`Counts marked "${UBA_ROAD_SOURCE}" come from the Umweltbundesamt's EU noise mapping source data (roads above 3 million vehicles a year, dl-de/zero-2-0): annual vehicles divided by 365, without a heavy-vehicle share. They attach only where a mapped segment runs along the road within ${ROAD_MATCH_M} m; indicative, not an RLS-19 input.`);
    if (result.truncated) roads.limitations.push("The nationwide road count query reached its limit; some counts may be missing.");
  })());
  if (rail?.mapped?.length) tasks.push((async () => {
    const queries = [
      { url: ebaUrl(bbox, RAIL_LIMIT), type: "Verkehrsweg", parse: ebaRailCounts },
      { url: ubaUrl(UBA_RAIL_WFS, "MajorRailwaySource", bbox, RAIL_LIMIT), type: "MajorRailwaySource", parse: ubaRailCounts },
    ];
    const results = await Promise.all(queries.map(async query => {
      try {
        const result = await wfs(query.url, query.type, RAIL_LIMIT, retrievedAt, rawResponses, signal);
        rail.sources.push(result.source);
        if (result.truncated) rail.limitations.push("A nationwide rail count query reached its limit; some counts may be missing.");
        return query.parse(result.features);
      } catch { signal?.throwIfAborted(); rail.sources.push({ url: query.url, retrievedAt, sha256: null }); rail.limitations.push(unavailable); return []; }
    }));
    const mapped = rail.mapped!.filter((item): item is MappedRail => item.kind === "rail");
    // EBA splits periods and categories, so it is matched first; the UBA's railway sources fill what it leaves.
    const attached = matchRailCounts(mapped, results[0]!, site) + matchRailCounts(mapped, results[1]!, site);
    if (attached) rail.limitations.push(`Train counts are published strategic noise mapping values (trains per year; day 06–18, evening 18–22, night 22–06), attached by VzG route number or, without one, by a segment running along the mapped track within ${RAIL_MATCH_M} m. EBA: federal main lines above 30,000 trains a year, as of 2022-06-30, © Eisenbahn-Bundesamt, dl-de/by-2-0; UBA: EU noise reporting, dl-de/zero-2-0. EBA vehicle categories VK1–VK4 are kept as published and are not Schall 03 train types; speeds, train types and forecasts still need the operator.`);
  })());
  await Promise.all(tasks);
}
