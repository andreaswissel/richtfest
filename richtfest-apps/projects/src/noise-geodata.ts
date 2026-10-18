import { SaxesParser } from "saxes";
import { simplifyPolyline, type MappedRail, type MappedRoad, type Point2, type ProjectAddress } from "@richtfest/shared";
import { boundedBody, validateLocationAddress } from "./location-context";

/**
 * Roads and railways around a site from the official topographic model
 * (ATKIS Basis-DLM), reduced to what an exterior noise inventory starts from:
 * which road or line it is, its class and how far its mapped axis runs from
 * the address point. Traffic volumes are not part of ATKIS and stay unknown.
 */
export type MappedAxis = {
  id: string;
  kind: "road" | "rail";
  /** Road the axis belongs to (AX_Strasse), or the rail route; null for loose axes. */
  group: string | null;
  name: string | null;
  dedication: string | null;
  designation: string | null;
  lanes: number | null;
  widthM: number | null;
  categories: string[];
  routeNumbers: string[];
  lines: string[];
  tracks: string | null;
  electrified: boolean | null;
  /** Published traffic count of this segment, where the source has one. */
  traffic?: MappedRoad["traffic"];
  /** Polyline parts as [longitude, latitude]. */
  parts: Array<Array<[number, number]>>;
};

const MAX_SOURCES = 150;
const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort();
const finiteOrNull = (value: unknown) => { const n = Number(value); return value !== null && value !== undefined && value !== "" && Number.isFinite(n) && n > 0 ? n : null; };

/** Shortest distance in metres from a point to a polyline; a local planar approximation, adequate within a few kilometres. */
export function distanceToPolylineMeters(site: { longitude: number; latitude: number }, parts: Array<Array<[number, number]>>): number | null {
  const kx = 111320 * Math.cos(site.latitude * Math.PI / 180), ky = 110574;
  const local = ([lon, lat]: [number, number]) => [(lon - site.longitude) * kx, (lat - site.latitude) * ky] as const;
  let best: number | null = null;
  for (const part of parts) for (let i = 0; i < part.length; i++) {
    const [ax, ay] = local(part[i]!);
    const [bx, by] = i + 1 < part.length ? local(part[i + 1]!) : [ax, ay];
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    if (best === null || distance < best) best = distance;
  }
  return best === null ? null : Math.round(best);
}

const AXIS_RANGE_M = 1500, MAX_AXIS_PARTS = 80, MAX_AXIS_POINTS = 400;
/** Axis parts near the site, simplified to 1 m and rounded to ~0.1 m, nearest part first. */
export function keptAxes(site: { longitude: number; latitude: number }, parts: Array<Array<[number, number]>>): Array<Array<[number, number]>> {
  const kx = 111320 * Math.cos(site.latitude * Math.PI / 180), ky = 110574;
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return parts
    .map(part => ({ part, distance: distanceToPolylineMeters(site, [part]) ?? Infinity }))
    .filter(item => item.part.length >= 2 && item.distance <= AXIS_RANGE_M)
    .sort((a, b) => a.distance - b.distance).slice(0, MAX_AXIS_PARTS)
    .map(({ part }) => {
      const local = part.map(([lon, lat]) => [(lon - site.longitude) * kx, (lat - site.latitude) * ky] as Point2);
      return simplifyPolyline(local, 1).slice(0, MAX_AXIS_POINTS).map(([x, y]) => [round(site.longitude + x / kx), round(site.latitude + y / ky)] as [number, number]);
    })
    .filter(part => part.length >= 2);
}

/** One entry per road (all its mapped axes) and per rail route, nearest first. */
export function groupMappedSources(axes: MappedAxis[], site: { longitude: number; latitude: number }): { roads: MappedRoad[]; rail: MappedRail[] } {
  const groups = new Map<string, MappedAxis[]>();
  for (const axis of axes) {
    // ATKIS splits one street into several road objects; named roads of the same class are one source.
    // Unnamed classified roads (e.g. a B 43 between towns) group by their number.
    const key = axis.kind === "road" && (axis.name || axis.designation) ? `road:${(axis.name ?? "").toLowerCase()}|${axis.dedication ?? ""}|${axis.designation ?? ""}` : `${axis.kind}:${axis.group ?? axis.id}`;
    groups.set(key, [...(groups.get(key) ?? []), axis]);
  }
  const roads: MappedRoad[] = [], rail: MappedRail[] = [];
  for (const [key, items] of groups) {
    const first = items[0]!;
    const distances = items.map(item => distanceToPolylineMeters(site, item.parts)).filter((value): value is number => value !== null);
    const distanceMeters = distances.length ? Math.min(...distances) : null;
    const max = (values: Array<number | null>) => { const present = values.filter((value): value is number => value !== null); return present.length ? Math.max(...present) : null; };
    const pick = (values: Array<string | null>) => values.find(Boolean) ?? null;
    const axes = keptAxes(site, items.flatMap(item => item.parts));
    // A road's count varies along it; the segment nearest the site is the one that matters for its facades.
    const counted = items.filter(item => item.traffic).map(item => ({ traffic: item.traffic!, distance: distanceToPolylineMeters(site, item.parts) ?? Infinity })).sort((a, b) => a.distance - b.distance)[0];
    if (first.kind === "road") roads.push({ kind: "road", ref: key, name: pick(items.map(item => item.name)), dedication: pick(items.map(item => item.dedication)),
      designation: pick(items.map(item => item.designation)), lanes: max(items.map(item => item.lanes)), carriagewayWidthM: max(items.map(item => item.widthM)),
      ...(counted ? { traffic: counted.traffic } : {}), distanceMeters, segments: items.length, axes });
    else {
      const electrified = items.map(item => item.electrified).filter((value): value is boolean => value !== null);
      rail.push({ kind: "rail", ref: key, name: pick(items.map(item => item.name)), categories: unique(items.flatMap(item => item.categories)), routeNumbers: unique(items.flatMap(item => item.routeNumbers)),
        lines: unique(items.flatMap(item => item.lines)), tracks: items.some(item => item.tracks === "2000") ? "2000" : pick(items.map(item => item.tracks)),
        electrified: electrified.length ? electrified.some(Boolean) : null, distanceMeters, segments: items.length, axes });
    }
  }
  const nearest = (a: { distanceMeters: number | null }, b: { distanceMeters: number | null }) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
  return { roads: roads.sort(nearest).slice(0, MAX_SOURCES), rail: rail.sort(nearest).slice(0, MAX_SOURCES) };
}

/** Rail axes are grouped by VzG route; axes without one by category and line. */
const railGroup = (routes: string[], categories: string[], lines: string[]) =>
  routes.length ? `route:${routes.join("+")}` : categories.length || lines.length ? `${categories.join("+")}|${lines.join("+")}` : null;

const lineParts = (geometry: any): Array<Array<[number, number]>> => {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
};
const split = (value: unknown) => typeof value === "string" ? value.split("#").map(item => item.trim()).filter(Boolean) : typeof value === "number" ? [String(value)] : [];
const code = (value: unknown) => typeof value === "number" && value > 0 ? String(value) : typeof value === "string" && /^\d+$/.test(value) ? value : null;

/** Rheinland-Pfalz publishes the Basis-DLM flattened: wdm dedication, bez designation, fsz lanes, brf width, bkt/nrb/elk/gls rail attributes. */
export function rlpMappedAxis(feature: any): MappedAxis | null {
  const p = feature?.properties ?? {};
  const id = String(p.objid ?? p.gml_id ?? feature?.id ?? "");
  if (!id) return null;
  if (p.objart_txt === "AX_Strassenachse" || p.objart_txt === "AX_Fahrbahnachse")
    return { id, kind: "road", group: typeof p.objid_z === "string" ? p.objid_z : null, name: typeof p.nam === "string" ? p.nam.slice(0, 300) : null, dedication: code(p.wdm),
      designation: typeof p.bez === "string" ? p.bez.slice(0, 80) : null, lanes: finiteOrNull(p.fsz), widthM: finiteOrNull(p.brf), categories: [], routeNumbers: [], lines: [], tracks: null, electrified: null, parts: lineParts(feature.geometry) };
  if (p.objart_txt === "AX_Bahnstrecke") {
    const categories = unique(split(p.bkt)), routeNumbers = unique(split(p.nrb)), lines = unique(split(p.nrl));
    return { id, kind: "rail", group: railGroup(routeNumbers, categories, lines), name: typeof p.nam === "string" ? p.nam.slice(0, 300) : null, dedication: null, designation: null, lanes: null, widthM: null,
      categories, routeNumbers, lines, tracks: code(p.gls), electrified: p.elk === 1000 ? true : p.elk === 2000 ? false : null, parts: lineParts(feature.geometry) };
  }
  return null;
}

// --- Berlin: Geoportal Berlin, open under dl-de/zero-2-0 ---

export const BERLIN_WFS = "https://gdi.berlin.de/services/wfs";
export const berlinAttribution = "Geoportal Berlin / Detailnetz Berlin and Strategische Lärmkarten 2022 (Senatsverwaltung für Mobilität, Verkehr, Klimaschutz und Umwelt), dl-de/zero-2-0; selected, grouped and measured by Richtfest.";
/** Berlin's envelope with a small margin; sites outside fall back to the other connectors. */
export const inBerlin = (longitude: number, latitude: number) => longitude >= 13.05 && longitude <= 13.8 && latitude >= 52.3 && latitude <= 52.7;

/** Detailnetz Straßenklasse (B Bundesstraße, G Gemeindestraße, P private) as AdV dedication codes. */
const berlinDedication: Record<string, string> = { A: "1301", B: "1303", G: "1307", P: "9997" };
/** Detailnetz carries the Berlin street network; only carriageways and private streets are traffic sources (not footpaths, parking, squares or allotment paths). */
const BERLIN_ROAD_TYPES = new Set(["STRA", "PSTR"]);
export type BerlinTraffic = Map<string, NonNullable<MappedRoad["traffic"]>>;

/** Traffic counts of the strategic noise map's road layers, keyed by Detailnetz link (start_end connection point) in both directions. */
export function berlinTraffic(features: any[]): BerlinTraffic {
  const traffic: BerlinTraffic = new Map();
  for (const feature of features) {
    const p = feature?.properties ?? {};
    const daily = Number(p.kfz), heavy = Number(p.lkw);
    if (typeof p.link_id !== "string" || !Number.isInteger(daily) || daily < 0) continue;
    const year = Number(/(\d{4})/.exec(String(p.quelle_kfz ?? ""))?.[1] ?? 0);
    const value = { dailyTraffic: daily, heavyVehicles: Number.isInteger(heavy) && heavy >= 0 ? heavy : null, year: year || 2019, source: String(p.quelle_kfz || "Verkehrsmengenkarte").slice(0, 200) };
    const [a, b] = p.link_id.split("_");
    traffic.set(p.link_id, value);
    if (a && b) traffic.set(`${b}_${a}`, value);
  }
  return traffic;
}

/** Detailnetz Straßenabschnitt -> road axis (WGS84 GeoJSON), with the noise map's count where its link matches. */
export function berlinRoadAxis(feature: any, traffic: BerlinTraffic): MappedAxis | null {
  const p = feature?.properties ?? {};
  const id = String(p.element_nr ?? feature?.id ?? "");
  if (!id || !BERLIN_ROAD_TYPES.has(p.strassenklasse2)) return null;
  const count = traffic.get(`${p.beginnt_bei_vp}_${p.endet_bei_vp}`);
  return { id, kind: "road", group: typeof p.strassenschluessel === "string" ? p.strassenschluessel : null, name: typeof p.strassenname === "string" ? p.strassenname.slice(0, 300) : null,
    dedication: berlinDedication[p.strassenklasse] ?? null, designation: typeof p.str_bez === "string" && p.str_bez.trim() ? p.str_bez.trim().slice(0, 80) : null,
    lanes: null, widthM: null, categories: [], routeNumbers: [], lines: [], tracks: null, electrified: null, ...(count ? { traffic: count } : {}), parts: lineParts(feature.geometry) };
}

/** Rail sources of the strategic noise map: S- und Fernbahn (one layer, not split by line) and tram / above-ground U-Bahn tracks. */
export function berlinRailAxis(feature: any): MappedAxis | null {
  const p = feature?.properties ?? {};
  const id = String(feature?.id ?? p.importid ?? "");
  if (!id) return null;
  const kind = p.typ === "S- und Fernbahn" ? "sfern" : p.gruppe_txt === "Tram" ? "tram" : /u-?bahn/i.test(String(p.gruppe_txt ?? "")) ? "ubahn" : null;
  if (!kind) return null;
  const categories = kind === "sfern" ? ["1100", "1104"] : kind === "tram" ? ["1201"] : ["1202"];
  const name = kind === "sfern" ? "S- und Fernbahn" : kind === "tram" ? "Straßenbahn" : "U-Bahn (oberirdisch)";
  return { id, kind: "rail", group: `berlin:${kind}`, name, dedication: null, designation: null, lanes: null, widthM: null, categories, routeNumbers: [], lines: [], tracks: null, electrified: null, parts: lineParts(feature.geometry) };
}

// --- Hessen: HVBG geodata, open under dl-de/zero-2-0 (§ 18, § 24 HVGG) ---

export const HESSEN_ATKIS = "https://www.gds.hessen.de/wfs2/aaa-suite/cgi-bin/atkis-bdlm/sf/wfs";
export const HESSEN_HOUSE_COORDINATES = "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-data.ows";
export const hessenAttribution = "Geobasisdaten © Hessische Verwaltung für Bodenmanagement und Geoinformation (HVBG), dl-de/zero-2-0; selected, grouped and measured by Richtfest.";

/** ETRS89 / UTM (zone 32N or 33N) -> longitude/latitude. Same accuracy note as toUtm: display and search geometry, not setting out. */
export function fromUtm(easting: number, northing: number, zone: number): [number, number] {
  const a = 6378137, e2 = 0.00669438002290, k0 = 0.9996, ep = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const mu = northing / k0 / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), t1 = Math.tan(p1) ** 2, c1 = ep * Math.cos(p1) ** 2;
  const r1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, d = (easting - 500000) / (n1 * k0);
  const latitude = p1 - (n1 * Math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep - 3 * c1 ** 2) * d ** 6 / 720);
  const longitude = (zone * 6 - 183) * Math.PI / 180 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep + 24 * t1 ** 2) * d ** 5 / 120) / Math.cos(p1);
  return [longitude * 180 / Math.PI, latitude * 180 / Math.PI];
}
export const fromUtm32 = (easting: number, northing: number) => fromUtm(easting, northing, 32);

export type GmlFeature = { type: string; id: string; fields: Record<string, string[]>; refs: Record<string, string[]>; parts: number[][]; points: number[][] };

/** Reads WFS GML features: direct child values and xlink references, plus every coordinate list. No DTDs, no external entities. */
export function readGmlFeatures(xml: string, types: string[]): GmlFeature[] {
  const parser = new SaxesParser({ xmlns: true });
  const features: GmlFeature[] = [];
  let feature: GmlFeature | null = null, depth = 0, text = "";
  const stack: string[] = [];
  parser.on("doctype", () => { throw new Error("GML response contains an unsupported DTD"); });
  parser.on("opentag", tag => {
    stack.push(tag.local); text = "";
    if (!feature && types.includes(tag.local)) {
      const id = Object.values(tag.attributes).find(attribute => attribute.local === "id")?.value ?? "";
      feature = { type: tag.local, id: id.replace(/^[a-z]+\./i, ""), fields: {}, refs: {}, parts: [], points: [] }; depth = stack.length;
      return;
    }
    if (feature && stack.length === depth + 1) {
      const href = Object.values(tag.attributes).find(attribute => attribute.local === "href")?.value;
      if (href) (feature.refs[tag.local] ??= []).push(href.replace(/^urn:adv:oid:/, ""));
    }
  });
  parser.on("text", value => { text += value; });
  parser.on("closetag", tag => {
    if (feature) {
      if (tag.local === "posList") feature.parts.push(text.trim().split(/\s+/).map(Number));
      else if (tag.local === "pos") feature.points.push(text.trim().split(/\s+/).map(Number));
      else if (stack.length === depth + 1 && text.trim()) (feature.fields[tag.local] ??= []).push(text.trim());
      if (stack.length === depth && tag.local === feature.type) { features.push(feature); feature = null; }
    }
    stack.pop(); text = "";
  });
  parser.write(xml).close();
  return features;
}

/** EPSG:4326 / 4258 in GML 3.2 are latitude first; returns [longitude, latitude] pairs. */
export const latLonPairs = (values: number[]) => {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < values.length; i += 2) if (Number.isFinite(values[i]) && Number.isFinite(values[i + 1])) pairs.push([values[i + 1]!, values[i]!]);
  return pairs;
};
/** ETRS89 / UTM easting-northing pairs -> [longitude, latitude] pairs. */
export const utmPairs = (zone: number) => (values: number[]) => {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < values.length; i += 2) if (Number.isFinite(values[i]) && Number.isFinite(values[i + 1])) pairs.push(fromUtm(values[i]!, values[i + 1]!, zone));
  return pairs;
};

/**
 * Road designations as signposted: "B80" -> "B 80", "B2R" -> "B 2R", "St2345" -> "St 2345"; "K 16" and "K M 3" stay.
 * Several designations ("B27#B10", "B27;B10") are normalised one by one and joined with ", ".
 */
export function normaliseDesignation(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const items = value.split(/[#;,]/).map(item => item.trim().replace(/\s+/g, " ")).filter(Boolean)
    .map(item => item.replace(/^([A-Z][A-Za-z]{0,2})\s*(\d+[A-Za-z]?)$/, "$1 $2"));
  return items.length ? [...new Set(items)].join(", ").slice(0, 80) : null;
}

/**
 * AdV ATKIS Basis-DLM GML (AAA "sf" or full NAS schema; same element names) -> mapped axis. Road name,
 * dedication and designation live on the parent AX_Strasse (`istTeilVon`), fetched separately by id.
 * `pairs` turns a posList into [longitude, latitude] for the CRS the service answered in.
 */
export function atkisMappedAxis(feature: GmlFeature, roads: Map<string, GmlFeature>, pairs: (values: number[]) => Array<[number, number]> = latLonPairs): MappedAxis | null {
  const value = (key: string, source = feature) => source.fields[key]?.[0] ?? null;
  const parts = feature.parts.map(pairs).filter(part => part.length);
  if (feature.type === "AX_Strassenachse" || feature.type === "AX_Fahrbahnachse") {
    const group = feature.refs.istTeilVon?.[0] ?? null, road = group ? roads.get(group) : undefined;
    return { id: feature.id, kind: "road", group, name: road ? value("name", road)?.slice(0, 300) ?? null : null, dedication: road ? value("widmung", road) : null,
      designation: road ? normaliseDesignation(value("bezeichnung", road)) : null, lanes: finiteOrNull(value("anzahlDerFahrstreifen")), widthM: finiteOrNull(value("breiteDerFahrbahn")),
      categories: [], routeNumbers: [], lines: [], tracks: null, electrified: null, parts };
  }
  if (feature.type === "AX_Bahnstrecke") {
    const categories = unique(feature.fields.bahnkategorie ?? []), routeNumbers = unique(feature.fields.nummerDerBahnstrecke ?? []), lines = unique(feature.fields.nummerDerLinie ?? []);
    const electrified = value("elektrifizierung");
    return { id: feature.id, kind: "rail", group: railGroup(routeNumbers, categories, lines), name: value("name")?.slice(0, 300) ?? null, dedication: null, designation: null, lanes: null, widthM: null,
      categories, routeNumbers, lines, tracks: value("anzahlDerStreckengleise"), electrified: electrified === "1000" ? true : electrified === "2000" ? false : null, parts };
  }
  return null;
}
/** Hessen answers in EPSG:4326 (latitude first). */
export const hessenMappedAxis = (feature: GmlFeature, roads: Map<string, GmlFeature>) => atkisMappedAxis(feature, roads);

// --- Per-state Basis-DLM road and rail connectors ---

export type StateCode = "BW" | "BY" | "BE" | "BB" | "HB" | "HH" | "HE" | "MV" | "NI" | "NW" | "RP" | "SL" | "SN" | "ST" | "SH" | "TH";
export const STATE_CODES: readonly StateCode[] = ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"];

/** A state's ATKIS Basis-DLM on the AdV "aaa-suite" WFS (same GML schema as Hessen). */
export type AtkisSfState = {
  state: StateCode;
  url: string;
  connector: string;
  /** Request and response CRS. Geographic CRS (4326, 4258) answer latitude first; UTM answers easting first. */
  crs: { srs: string; utmZone?: 32 | 33 };
  /** Extra parameters on every request, e.g. Bayern's namespace declaration for the `adv:` prefix. */
  params?: Record<string, string>;
  /** Send TYPENAMES=adv:AX_Strasse with the RESOURCEID lookup; required behind the LGLN, Bayern and Sachsen-Anhalt proxies. */
  strasseTypenames: boolean;
  /** Tries per request when the server answers with a transient InternalServerError report; default 1. */
  attempts?: number;
  attribution: (year: number) => string;
};
const RICHTFEST = "selected, grouped and measured by Richtfest.";
const EPSG4326 = { srs: "urn:ogc:def:crs:EPSG::4326" };
const ADV_NAMESPACES = { NAMESPACES: "xmlns(adv,http://www.adv-online.de/namespaces/adv/gid/7.1)" };

export const ATKIS_SF_STATES: Partial<Record<StateCode, AtkisSfState>> = {
  HE: { state: "HE", url: HESSEN_ATKIS, connector: "he-basis-dlm-hako-framap-v1", crs: EPSG4326, strasseTypenames: false, attribution: () => hessenAttribution },
  NW: { state: "NW", url: "https://www.wfs.nrw.de/geobasis/wfs_nw_atkis-basis-dlm_aaa-modell-basiert", connector: "nw-basis-dlm-v1",
    // NRW rejects EPSG:4326; ETRS89 geographic is also latitude first and differs from WGS84 by well under a metre.
    // Its XtraServer answers roughly one request in three with a transient InternalServerError.
    crs: { srs: "urn:ogc:def:crs:EPSG::4258" }, strasseTypenames: true, attempts: 3, attribution: () => `Geobasisdaten © Land NRW (Geobasis NRW), dl-de/zero-2-0; ${RICHTFEST}` },
  NI: { state: "NI", url: "https://opendata.lgln.niedersachsen.de/doorman/noauth/atkisbdlm_wfs_sf", connector: "ni-basis-dlm-v1", crs: EPSG4326, strasseTypenames: true,
    attribution: year => `LGLN (${year}) Creative Commons Namensnennung – 4.0 International (CC BY 4.0); ${RICHTFEST}` },
  HB: { state: "HB", url: "https://opendata.lgln.niedersachsen.de/doorman/noauth/atkisbdlm_hb_wfs_sf", connector: "hb-basis-dlm-v1", crs: EPSG4326, strasseTypenames: true,
    attribution: year => `GeoBremen (${year}) Creative Commons Namensnennung – 4.0 International (CC BY 4.0); ${RICHTFEST}` },
  BY: { state: "BY", url: "https://geoservices.bayern.de/wfs/v1/ogc_atkis_basisdlm.cgi", connector: "by-basis-dlm-v1", crs: EPSG4326, params: ADV_NAMESPACES, strasseTypenames: true,
    attribution: () => `Geobasisdaten © Bayerische Vermessungsverwaltung, CC BY 4.0; ${RICHTFEST}` },
  ST: { state: "ST", url: "https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_ATKIS_WFS_BDLM_OpenData/guest", connector: "st-basis-dlm-v1", crs: EPSG4326, strasseTypenames: true,
    attribution: () => `© GeoBasis-DE / LVermGeo LSA, dl-de/by-2-0; ${RICHTFEST}` },
  BB: { state: "BB", url: "https://isk.geobasis-bb.de/ows/atkisbdlm_sf_wfs", connector: "bb-basis-dlm-v1", crs: EPSG4326, strasseTypenames: true,
    attribution: () => `© GeoBasis-DE/LGB, dl-de/by-2-0; ${RICHTFEST}` },
  MV: { state: "MV", url: "https://www.geodaten-mv.de/dienste/atkis_bdlm_wfs_sf", connector: "mv-basis-dlm-v1",
    // Only EPSG:25833 and 5650 are offered.
    crs: { srs: "urn:ogc:def:crs:EPSG::25833", utmZone: 33 }, strasseTypenames: true, attribution: year => `© GeoBasis-DE/M-V ${year}; ${RICHTFEST}` },
  SH: { state: "SH", url: "https://dienste.gdi-sh.de/WFS_SH_ATKIS_BDLM_SF_OpenGBD", connector: "sh-basis-dlm-v1", crs: EPSG4326, strasseTypenames: true,
    attribution: () => `© GeoBasis-DE/LVermGeo SH/CC BY 4.0; ${RICHTFEST}` },
};

/** AdV Bahnkategorie code list, for services that publish the category as text. */
const RAIL_CATEGORY_CODES: Record<string, string> = {
  "eisenbahn": "1100", "personenverkehr": "1101", "güterverkehr": "1102", "betriebsgleis": "1103", "s-bahn": "1104",
  "stadtbahn": "1200", "straßenbahn": "1201", "u-bahn": "1202", "seilbahn, bergbahn": "1300", "zahnradbahn": "1301", "standseilbahn": "1302",
  "museumsbahn": "1400", "bahn im freizeitpark": "1500", "magnetschwebebahn": "1600",
};
/** "1307", "1307.0" -> "1307"; placeholders (-9998) and blanks -> null. */
const advCode = (value: string | null | undefined) => { const match = /^(\d+)(?:\.0+)?$/.exec(value?.trim() ?? ""); return match && Number(match[1]) > 0 ? match[1]! : null; };
const codes = (value: string | null | undefined) => unique(split(value ?? "").map(item => advCode(item)).filter((item): item is string => !!item));

// --- Baden-Württemberg: LGL NOrA view of the Basis-DLM (flat GML), dl-de/by-2-0 ---

export const BW_ATKIS = "https://owsproxy.lgl-bw.de/owsproxy/wfs/WFS_LGL-BW_ATKIS_Basis-DLM";
export const bwAttribution = (year: number) => `LGL-BW (${year}) Datenlizenz Deutschland – Namensnennung – Version 2.0, www.lgl-bw.de; ${RICHTFEST}`;
/**
 * nora:v_verkehrslinie: one flat layer for roads, carriageways, paths and rail (`objektart`). Requested in
 * EPSG:25832 because its EPSG:4326 output is rounded to two decimals. Road name in gml:name, `klasse_org`
 * dedication, `nummer` designation, `anzahl` lanes or tracks, `breite` width, `kennung` street key.
 * Rail has its category as text and no VzG route number in this view.
 */
export function bwMappedAxis(feature: GmlFeature): MappedAxis | null {
  const value = (key: string) => feature.fields[key]?.[0] ?? null;
  const id = value("id") ?? feature.id;
  const kind = value("objektart");
  if (!id) return null;
  const parts = feature.parts.map(utmPairs(32)).filter(part => part.length);
  const name = (value("name") ?? value("zweitname"))?.slice(0, 300) ?? null;
  if (kind === "Strassenachse" || kind === "Fahrbahnachse")
    return { id, kind: "road", group: value("kennung"), name, dedication: advCode(value("klasse_org")), designation: normaliseDesignation(value("nummer")),
      lanes: finiteOrNull(value("anzahl")), widthM: finiteOrNull(value("breite")), categories: [], routeNumbers: [], lines: [], tracks: null, electrified: null, parts };
  if (kind === "Bahnstrecke") {
    const raw = value("klasse") ?? "";
    let labels: string[] = [raw];
    if (raw.startsWith("[")) try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) labels = parsed.map(String); } catch { /* keep the raw text */ }
    const categories = unique(labels.map(label => RAIL_CATEGORY_CODES[label.trim().toLowerCase()] ?? "").filter(Boolean));
    const electrified = value("typ");
    return { id, kind: "rail", group: railGroup([], categories, []), name, dedication: null, designation: null, lanes: null, widthM: null,
      categories, routeNumbers: [], lines: [], tracks: advCode(value("anzahl")), electrified: electrified === "1000" ? true : electrified === "2000" ? false : null, parts };
  }
  return null;
}

// --- Thüringen: GDI-Th deegree WFS, flat Basis-DLM (dlm: namespace, PascalCase fields), CC BY 4.0 ---

export const TH_ATKIS = "https://www.geoproxy.geoportal-th.de/geoproxy/services/adv_atkis_wfs";
export const thAttribution = (year: number) => `© GDI-Th (${year}), CC BY 4.0; ${RICHTFEST}`;
/** dlm:AX_STRASSENACHSE / AX_FAHRBAHNACHSE / AX_BAHNSTRECKE with name, dedication and designation inline; multi-values '#'-joined; -9998 means unset. */
export function thMappedAxis(feature: GmlFeature): MappedAxis | null {
  const value = (key: string) => feature.fields[key]?.[0] ?? null;
  const id = value("eindeutigerObjektidentifikator") ?? feature.id;
  if (!id) return null;
  const parts = feature.parts.map(utmPairs(32)).filter(part => part.length);
  const name = value("Name")?.slice(0, 300) ?? null;
  if (feature.type === "AX_STRASSENACHSE" || feature.type === "AX_FAHRBAHNACHSE")
    return { id, kind: "road", group: value("ObjektIDdesZUSO"), name, dedication: advCode(value("Widmung")), designation: normaliseDesignation(value("Bezeichnung")),
      lanes: finiteOrNull(value("AnzahlDerFahrstreifen")), widthM: finiteOrNull(value("BreiteDerFahrbahn")), categories: [], routeNumbers: [], lines: [], tracks: null, electrified: null, parts };
  if (feature.type === "AX_BAHNSTRECKE") {
    const categories = codes(value("Bahnkategorie")), routeNumbers = unique(split(value("NummerDerBahnstrecke"))), lines = unique(split(value("NummerDerLinie")));
    const electrified = advCode(value("Elektrifizierung"));
    return { id, kind: "rail", group: railGroup(routeNumbers, categories, lines), name, dedication: null, designation: null, lanes: null, widthM: null,
      categories, routeNumbers, lines, tracks: advCode(value("AnzahlDerStreckengleise")), electrified: electrified === "1000" ? true : electrified === "2000" ? false : null, parts };
  }
  return null;
}

const xmlEscape = (value: string) => value.replace(/[<>&'"]/g, char => `&#${char.charCodeAt(0)};`);
const normal = (value: string) => value.trim().toLowerCase().replaceAll("ß", "ss").replace(/str\.?$/, "strasse").replace(/\s+/g, " ");

export type HessenSite = { siteId: string; address: string; longitude: number; latitude: number; sourceUrl: string; body: string };

/**
 * Exact house address -> official house coordinate (Hauskoordinaten Hessen).
 * Several coordinates for one address are accepted only when they lie within
 * 150 m of each other; the first is used. Returns null when Hessen has no such house.
 */
export async function resolveHessenAddress(input: ProjectAddress, signal: AbortSignal): Promise<HessenSite | null> {
  const { address, street, house, suffix } = validateLocationAddress(input);
  // Spelling variants (ß/ss, "Str.") are fetched by pattern, then matched exactly after normalising.
  const pattern = street.trim().replace(/str\.?$/i, "straße").replace(/[*?!]/g, "").replace(/ß|ss/gi, "*");
  const filter = `<ogc:Filter xmlns:ogc="http://www.opengis.net/ogc"><ogc:And><ogc:PropertyIsLike wildCard="*" singleChar="?" escapeChar="!"><ogc:PropertyName>HA_STR</ogc:PropertyName><ogc:Literal>${xmlEscape(pattern)}</ogc:Literal></ogc:PropertyIsLike><ogc:PropertyIsLike wildCard="*" singleChar="?" escapeChar="!"><ogc:PropertyName>GD_GDBEZ</ogc:PropertyName><ogc:Literal>${xmlEscape(address.city!.trim().replace(/[*?!]/g, ""))}*</ogc:Literal></ogc:PropertyIsLike><ogc:PropertyIsEqualTo><ogc:PropertyName>HA_HAUSNR</ogc:PropertyName><ogc:Literal>${house}</ogc:Literal></ogc:PropertyIsEqualTo></ogc:And></ogc:Filter>`;
  const url = new URL(HESSEN_HOUSE_COORDINATES);
  url.search = new URLSearchParams({ SERVICE: "WFS", VERSION: "1.1.0", REQUEST: "GetFeature", TYPENAME: "hako", MAXFEATURES: "100", SRSNAME: "urn:ogc:def:crs:EPSG::25832", FILTER: filter }).toString();
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) throw Object.assign(new Error("Hessen house coordinate service unavailable; retry"), { status: 502, code: "environment_source_unavailable" });
  const body = (await boundedBody(response, 2_000_000)).toString("utf8");
  const features = readGmlFeatures(body, ["hako"]);
  if (features.length >= 100) throw Object.assign(new Error("Site address lookup incomplete; add the city in project details"), { status: 409, code: "environment_address_ambiguous" });
  const city = normal(address.city ?? "");
  const matches = features.filter(feature => {
    const field = (key: string) => feature.fields[key]?.[0] ?? "";
    return normal(field("HA_STR")) === normal(street) && Number(field("HA_HAUSNR")) === house && field("HA_HAUSNRZU").toLowerCase() === suffix
      && normal(field("GD_GDBEZ")).startsWith(city) && (!address.postalCode || !field("HA_PLZ") || field("HA_PLZ") === address.postalCode);
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!matches.length) return null;
  const points = matches.map(feature => feature.points[0]).filter((point): point is number[] => !!point && point.length >= 2 && point.every(Number.isFinite));
  if (points.length !== matches.length) throw Object.assign(new Error("Hessen house coordinate without a usable position"), { status: 502, code: "environment_invalid_response" });
  if (points.some(point => Math.hypot(point[0]! - points[0]![0]!, point[1]! - points[0]![1]!) > 150))
    throw Object.assign(new Error("Site address matches several distant houses; check the city in project details"), { status: 409, code: "environment_address_ambiguous" });
  const [easting, northing] = points[0]!;
  // Hessen lies within roughly 32U 410000–590000 E, 5470000–5730000 N.
  if (easting! < 380000 || easting! > 620000 || northing! < 5440000 || northing! > 5760000) throw Object.assign(new Error("Hessen house coordinate outside Hessen"), { status: 502, code: "environment_invalid_response" });
  const [longitude, latitude] = fromUtm32(easting!, northing!);
  const match = matches[0]!, field = (key: string) => match.fields[key]?.[0] ?? "";
  return { siteId: `he-hako:${match.id}`, address: `${field("HA_STR")} ${field("HA_HAUSNR")}${field("HA_HAUSNRZU")}, ${field("GD_GDBEZ").replace(/\s*\(historisch\)$/, "")}`, longitude, latitude, sourceUrl: url.href, body };
}
