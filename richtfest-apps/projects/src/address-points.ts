import { fromUtm, projectAddressInput, STATE_BY_KEY, STATE_NAMES, type ProjectAddress, type StateCode } from "@richtfest/shared";
import { boundedBody, findBerlinAddresses } from "./location-context";
import { readGmlFeatures, resolveHessenAddress, type GmlFeature } from "./noise-geodata";

/**
 * Site address -> one official address point, for any German state with an open register.
 *
 * 1. The municipality name is looked up in BKG VG250 (bundled, see scripts/build-address-areas.ts);
 *    its official key (AGS) gives the candidate states. A name shared by several states
 *    (Frankfurt, Halle, Neustadt) queries every candidate state's register.
 * 2. Each candidate state's own register is queried for the exact street and house number.
 * 3. A hit counts only if its point lies in that state (bundled, simplified VG250 Länder,
 *    ± BORDER_MARGIN_M for the simplification). The geocoded point, not the name, decides the state.
 *
 * Nothing nearby is ever substituted: street names are compared after spelling normalisation
 * (Str./Straße, ß/ss, umlauts, hyphens, case) and house number plus suffix must be equal.
 */

export type AddressPointPrecision = "house" | "building" | "parcel" | "approximate";
export type AddressPoint = {
  state: StateCode;
  siteId: string;
  address: string;
  latitude: number;
  longitude: number;
  /** house: official house coordinate; building: centre of the addressed cadastral building; parcel: centre of the addressed parcel(s); approximate: OpenStreetMap fallback. */
  precision: AddressPointPrecision;
  sourceUrl: string;
  body: string;
  attribution: string;
  /** Every upstream response that led to the point, in request order (the last one is sourceUrl/body). */
  responses: Array<{ url: string; body: string }>;
};
export type AddressPointMissReason = "invalid_address" | "outside_germany" | "municipality_not_found" | "municipality_ambiguous" | "no_open_service" | "not_found";
export type AddressPointLookup =
  | { point: AddressPoint; reason?: undefined }
  | { point: null; reason: AddressPointMissReason; states: StateCode[]; message: string };

/** A parsed, validated site address. `houseKey` is number plus suffix, normalised ("12a", "12/1"). */
export type AddressQuery = {
  address: ProjectAddress;
  street: string;
  number: number;
  suffix: string;
  houseKey: string;
  city: string;
  postalCode: string | null;
  /** Candidate municipalities in the state being queried (VG250 name and 8-digit AGS). */
  municipalities: Municipality[];
};
export type AddressHit = Omit<AddressPoint, "state" | "attribution">;
export type AddressPointResolver = { attribution: string; resolve: (query: AddressQuery, signal: AbortSignal) => Promise<AddressHit[]> };
export type Municipality = { ags: string; name: string; state: StateCode };

const BORDER_MARGIN_M = 400;
const SAME_PLACE_M = 150;
const coded = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });
const unavailable = (state: StateCode) => coded(`${STATE_NAMES[state]} address service unavailable; retry`, "environment_source_unavailable", 502);
const incomplete = () => coded("Site address lookup incomplete; add the postal code or the full municipality name in project details", "environment_address_ambiguous", 409);

// ---------------------------------------------------------------------------------------------
// Normalisation and matching

const fold = (value: string) => value.normalize("NFC").toLowerCase()
  .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");

/** Street names compare equal across Str./Straße/Strasse, ß/ss, umlaut transliteration, hyphens, dots and case. */
export function normalStreet(value: string): string {
  return fold(value)
    .replace(/\b(?:sankt|st\.?)(?=\s)/g, "st")
    .replace(/str(?:asse|\.)?(?=$|[\s-])/g, "str")
    .replace(/[.\-–/,]/g, " ").replace(/\s+/g, " ").trim();
}
export const normalHouse = (value: string) => value.toLowerCase().replace(/\s+/g, "").replace(/^0+(?=\d)/, "");

const ANY = "\u0001", ONE = "\u0002";
/**
 * A LIKE pattern that finds every spelling `normalStreet` would accept: Straße/Str./Strasse, umlauts,
 * ß/ss and separators become multi-character wildcards; word-initial letters a single-character
 * wildcard so case-sensitive services match too. Wildcard and quote characters in input are dropped.
 */
export function streetPattern(street: string): string {
  let s = street.normalize("NFC").toLowerCase().replace(/[*?%_!'"\\<>&]/g, ANY);
  s = s.replace(/\b(?:sankt|st\.?)(?=\s)/g, ONE + ANY);
  s = s.replace(/str(?:aße|asse|\.)?(?=$|[\s-])/g, `str${ANY}`);
  s = s.replace(/ä|ae|ö|oe|ü|ue|ß|ss/g, ANY);
  s = s.replace(/(^|[\s.\-–/,]+)(\p{L})/gu, (_, sep: string) => (sep ? ANY : "") + ONE);
  s = s.replace(/[\s.\-–/,]+/g, ANY);
  return s.replace(new RegExp(`${ANY}+`, "g"), ANY);
}
const fesLiteral = (pattern: string) => xml(pattern).replaceAll(ANY, "*").replaceAll(ONE, "?");
const cqlLiteral = (pattern: string) => pattern.replaceAll("'", "''").replaceAll(ANY, "%").replaceAll(ONE, "_");
const xml = (value: string) => value.replace(/[<>&'"]/g, char => `&#${char.charCodeAt(0)};`);

/** Parses "Friedrich-Ebert-Straße 79", "Hauptstr. 5 a", "Königstraße 12/1". Ranges ("12-14") are rejected: they are not one address. */
export function parseStreetAddress(street: string): { street: string; number: number; suffix: string; houseKey: string } | null {
  const match = street.trim().match(/^(.+?),?\s+(\d{1,5})\s*([a-z]|\/\s*\d{1,3})?$/i);
  if (!match || !/\p{L}/u.test(match[1]!)) return null;
  const number = Number(match[2]), suffix = (match[3] ?? "").toLowerCase().replace(/\s+/g, "");
  return number > 0 ? { street: match[1]!.trim(), number, suffix, houseKey: `${number}${suffix}` } : null;
}

// ---------------------------------------------------------------------------------------------
// Bundled VG250: municipalities (name -> AGS) and simplified state areas

type StateArea = { state: StateCode; rings: Float64Array[]; bbox: [number, number, number, number] };
let municipalities: Promise<Array<Municipality & { norm: string }>> | null = null;
let stateAreas: Promise<StateArea[]> | null = null;

/** Place names: like street folding, plus Sankt -> St and punctuation (brackets, slashes, dots) as spaces. Hyphens are kept. */
export const normalPlace = (value: string) => fold(value).replace(/\bsankt\b/g, "st").replace(/[().,/]/g, " ").replace(/\s+/g, " ").trim();
const STOP_WORDS = new Set(["am", "an", "der", "die", "den", "dem", "im", "in", "ob", "bei", "vor", "auf", "und"]);

function loadMunicipalities() {
  return municipalities ??= import("./data/vg250-municipalities.json").then(module => {
    const data = (module.default ?? module) as { municipalities: Record<string, string> };
    return Object.entries(data.municipalities).flatMap(([district, list]) => list.split("|").map(entry => {
      const ags = district + entry.slice(0, 3), name = entry.slice(3);
      return { ags, name, state: STATE_BY_KEY[ags.slice(0, 2)]!, norm: normalPlace(name) };
    }));
  });
}

/**
 * Municipalities a typed city name can mean: the official name itself and every official name that extends
 * it ("Frankfurt" -> Frankfurt am Main, Frankfurt (Oder)); otherwise shorter prefixes ("Berlin-Mitte" -> Berlin,
 * "Halle/Saale" -> Halle (Saale) by its qualifier).
 */
export async function municipalityCandidates(city: string): Promise<Municipality[]> {
  const all = await loadMunicipalities(), wanted = normalPlace(city);
  if (!wanted) return [];
  const strip = (list: typeof all) => list.map(({ norm: _norm, ...m }) => m);
  // "Halle" is both two villages of that exact name and Halle (Saale): the register hit decides, not the shorter name.
  const named = all.filter(m => m.norm === wanted || m.norm.startsWith(`${wanted} `));
  if (named.length) return strip(named);
  const words = wanted.split(/[\s-]+/);
  for (let k = words.length - 1; k >= 1; k--) {
    const base = words.slice(0, k).join(" ");
    const list = all.filter(m => m.norm === base || m.norm.startsWith(`${base} `) || m.norm === words.slice(0, k).join("-"));
    if (!list.length) continue;
    const qualifiers = words.slice(k).filter(word => word.length >= 3 && !STOP_WORDS.has(word));
    const refined = list.filter(m => qualifiers.length && qualifiers.every(word => m.norm.split(/[\s-]+/).includes(word)));
    return strip(refined.length ? refined : list);
  }
  return [];
}

function loadStateAreas() {
  return stateAreas ??= import("./data/vg250-states.json").then(module => {
    const data = (module.default ?? module) as { states: Record<string, number[][][]> };
    return Object.entries(data.states).map(([state, polygons]) => {
      const rings = polygons.flat().map(encoded => {
        const ring = new Float64Array(encoded.length);
        let x = 0, y = 0;
        for (let i = 0; i + 1 < encoded.length; i += 2) { x += encoded[i]!; y += encoded[i + 1]!; ring[i] = x / 1e4; ring[i + 1] = y / 1e4; }
        return ring;
      });
      const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const ring of rings) for (let i = 0; i < ring.length; i += 2) {
        bbox[0] = Math.min(bbox[0], ring[i]!); bbox[1] = Math.min(bbox[1], ring[i + 1]!); bbox[2] = Math.max(bbox[2], ring[i]!); bbox[3] = Math.max(bbox[3], ring[i + 1]!);
      }
      return { state: state as StateCode, rings, bbox };
    });
  });
}

/** Distance in metres from a point to a state's area: 0 inside, else to its nearest (simplified) boundary. */
function distanceToArea(area: StateArea, longitude: number, latitude: number, limit: number): number {
  const kx = 111320 * Math.cos(latitude * Math.PI / 180), ky = 110574;
  const marginX = limit / kx, marginY = limit / ky;
  if (longitude < area.bbox[0] - marginX || longitude > area.bbox[2] + marginX || latitude < area.bbox[1] - marginY || latitude > area.bbox[3] + marginY) return Infinity;
  let inside = false, best = Infinity;
  for (const ring of area.rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[2 * i]!, yi = ring[2 * i + 1]!, xj = ring[2 * j]!, yj = ring[2 * j + 1]!;
      if ((yi > latitude) !== (yj > latitude) && longitude < (xj - xi) * (latitude - yi) / (yj - yi) + xi) inside = !inside;
      const ax = (xj - longitude) * kx, ay = (yj - latitude) * ky, bx = (xi - longitude) * kx, by = (yi - latitude) * ky;
      const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
      const t = length2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return inside ? 0 : best;
}

/** States a point lies in or within `marginMeters` of (simplified VG250 boundaries), nearest first. */
export async function statesNear(longitude: number, latitude: number, marginMeters = BORDER_MARGIN_M): Promise<StateCode[]> {
  const areas = await loadStateAreas();
  return areas.map(area => ({ state: area.state, distance: distanceToArea(area, longitude, latitude, marginMeters) }))
    .filter(entry => entry.distance <= marginMeters).sort((a, b) => a.distance - b.distance).map(entry => entry.state);
}

/** The state containing a point (or the nearest within 2 km, for coast and border slivers lost in simplification); null outside Germany. */
export async function stateAt(longitude: number, latitude: number): Promise<StateCode | null> {
  return (await statesNear(longitude, latitude, 2000))[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// HTTP and geometry helpers

const kvp = (base: string, params: Record<string, string>) => `${base}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
async function request(state: StateCode, url: string, signal: AbortSignal, init: RequestInit = {}): Promise<string> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal, redirect: "error" }); }
  catch (error) { signal.throwIfAborted(); throw Object.assign(unavailable(state), { cause: error }); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw unavailable(state); }
  return (await boundedBody(response, 4_000_000)).toString("utf8");
}
const postWfs = (state: StateCode, url: string, typeName: string, filter: string, signal: AbortSignal, extra = "") =>
  request(state, url, signal, { method: "POST", headers: { "content-type": "application/xml" }, body: `<?xml version="1.0" encoding="UTF-8"?><wfs:GetFeature xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:adv="http://www.adv-online.de/namespaces/adv/gid/7.1" xmlns:ave="http://repository.gdi-de.org/schemas/adv/produkt/alkis-vereinfacht/2.0" service="WFS" version="2.0.0" count="${WFS_COUNT}"><wfs:Query typeNames="${typeName}"${extra}><fes:Filter>${filter}</fes:Filter></wfs:Query></wfs:GetFeature>` });
const WFS_COUNT = 200;
const fes = {
  eq: (property: string, value: string | number) => `<fes:PropertyIsEqualTo><fes:ValueReference>${property}</fes:ValueReference><fes:Literal>${xml(String(value))}</fes:Literal></fes:PropertyIsEqualTo>`,
  like: (property: string, pattern: string, matchCase = false) => `<fes:PropertyIsLike wildCard="*" singleChar="?" escapeChar="!"${matchCase ? "" : ` matchCase="false"`}><fes:ValueReference>${property}</fes:ValueReference><fes:Literal>${fesLiteral(pattern)}</fes:Literal></fes:PropertyIsLike>`,
  and: (...parts: string[]) => parts.length === 1 ? parts[0]! : `<fes:And>${parts.join("")}</fes:And>`,
  or: (...parts: string[]) => parts.length === 1 ? parts[0]! : `<fes:Or>${parts.join("")}</fes:Or>`,
};
const field = (feature: GmlFeature, key: string) => feature.fields[key]?.[0] ?? "";
const finitePoint = (point: number[] | undefined): point is [number, number] => !!point && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);
/** Centre of the bounding box of every coordinate (lat/lon order, as GML 3.2 EPSG:4326 returns them). Returns [longitude, latitude]. */
function latLonCentre(features: GmlFeature[]): [number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const feature of features) for (const values of [...feature.parts, ...feature.points]) for (let i = 0; i + 1 < values.length; i += 2) {
    const lat = values[i]!, lon = values[i + 1]!;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    minX = Math.min(minX, lon); maxX = Math.max(maxX, lon); minY = Math.min(minY, lat); maxY = Math.max(maxY, lat);
  }
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}
const distanceMeters = (a: { longitude: number; latitude: number }, b: { longitude: number; latitude: number }) =>
  Math.hypot((a.longitude - b.longitude) * 111320 * Math.cos(a.latitude * Math.PI / 180), (a.latitude - b.latitude) * 110574);
const municipalityName = (query: AddressQuery, ags: string) => query.municipalities.find(m => m.ags === ags)?.name ?? query.city;
const plzOk = (query: AddressQuery, plz: string) => !query.postalCode || !plz || plz === query.postalCode;
const sameStreet = (query: AddressQuery, candidate: string) => normalStreet(candidate) === normalStreet(query.street);
const hit = (values: Omit<AddressHit, "responses"> & { responses?: AddressHit["responses"] }): AddressHit =>
  ({ ...values, responses: values.responses ?? [{ url: values.sourceUrl, body: values.body }] });

// ---------------------------------------------------------------------------------------------
// State registers

/** OGC API Features (ldproxy) with CQL2 text filters: NRW GebRef, Hamburg Hauskoordinaten. Spaces must be %20, not '+'. */
async function ogcItems(state: StateCode, collection: string, filter: string, signal: AbortSignal) {
  const url = kvp(collection, { f: "json", limit: String(WFS_COUNT), "filter-lang": "cql2-text", filter });
  const body = await request(state, url, signal);
  const json = JSON.parse(body) as { features?: Array<{ id: string; geometry: { type: string; coordinates: number[] } | null; properties: Record<string, string | null> }>; numberMatched?: number };
  if (!Array.isArray(json.features)) throw coded(`${STATE_NAMES[state]} address service returned an invalid response`, "environment_invalid_response", 502);
  if (json.features.length >= WFS_COUNT || Number(json.numberMatched ?? 0) > json.features.length) throw incomplete();
  return { url, body, features: json.features.filter(feature => feature.geometry?.type === "Point" && finitePoint(feature.geometry.coordinates)) };
}

const NW: AddressPointResolver = {
  attribution: "Gebäudereferenzen NRW © Bezirksregierung Köln, dl-de/zero-2-0",
  async resolve(query, signal) {
    // AGS 05 3 15 000 = land, Regierungsbezirk, Kreis, Gemeinde.
    const places = query.municipalities.map(m => `(regbezschl='${m.ags[2]}' AND kreisschl='${m.ags.slice(3, 5)}' AND gmdschl='${m.ags.slice(5)}')`);
    const { url, body, features } = await ogcItems("NW", "https://ogc-api.nrw.de/gebref/v1/collections/gebref/items",
      `(${places.join(" OR ")}) AND hnr='${query.number}' AND CASEI(str) LIKE CASEI('${cqlLiteral(streetPattern(query.street))}')`, signal);
    return features.filter(f => sameStreet(query, f.properties.str ?? "") && normalHouse(`${f.properties.hnr}${f.properties.adz ?? ""}`) === query.houseKey && f.properties.qua !== "R")
      .map(f => hit({ siteId: `nw-gebref:${f.id}`, address: `${f.properties.str} ${f.properties.hnr}${f.properties.adz ?? ""}, ${f.properties.gmd}`,
        longitude: f.geometry!.coordinates[0]!, latitude: f.geometry!.coordinates[1]!, precision: f.properties.qua === "B" ? "parcel" : "house", sourceUrl: url, body }));
  },
};

const HH: AddressPointResolver = {
  attribution: "Hauskoordinaten Hamburg © Freie und Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung (LGV), dl-de/by-2-0",
  async resolve(query, signal) {
    const { url, body, features } = await ogcItems("HH", "https://api.hamburg.de/datasets/v1/gages_vereinfacht/collections/hauskoordinaten/items",
      `hausnummer='${query.number}' AND CASEI(strassenname) LIKE CASEI('${cqlLiteral(streetPattern(query.street))}')`, signal);
    return features.filter(f => sameStreet(query, f.properties.strassenname ?? "") && normalHouse(`${f.properties.hausnummer}${f.properties.hausnummernzusatz ?? ""}`) === query.houseKey && plzOk(query, f.properties.postleitzahl ?? ""))
      .map(f => hit({ siteId: `hh-hauskoordinaten:${f.id}`, address: `${f.properties.strassenname} ${f.properties.hausnummer}${f.properties.hausnummernzusatz ?? ""}, ${f.properties.postleitzahl} Hamburg`,
        longitude: f.geometry!.coordinates[0]!, latitude: f.geometry!.coordinates[1]!, precision: "house", sourceUrl: url, body }));
  },
};

const BB: AddressPointResolver = {
  attribution: "Hauskoordinaten Brandenburg © GeoBasis-DE/LGB, dl-de/by-2-0",
  async resolve(query, signal) {
    const filter = fes.and(fes.or(...query.municipalities.map(m => fes.eq("app:gemeindeschluessel", m.ags))), fes.eq("app:hnr", query.number), fes.like("app:strassenname", streetPattern(query.street)));
    const url = kvp("https://isk.geobasis-bb.de/ows/gaz_wfs", { SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: "app:Hauskoordinaten", NAMESPACES: "xmlns(app,http://www.deegree.org/app)", COUNT: String(WFS_COUNT), SRSNAME: "urn:ogc:def:crs:EPSG::4326", FILTER: `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0">${filter}</fes:Filter>` });
    const body = await request("BB", url, signal);
    // numberReturned is unreliable in this service; count members instead.
    const features = readGmlFeatures(body, ["Hauskoordinaten"]);
    if (features.length >= WFS_COUNT) throw incomplete();
    return features.filter(f => sameStreet(query, field(f, "strassenname")) && normalHouse(field(f, "hnr_adz") || field(f, "hnr")) === query.houseKey && plzOk(query, field(f, "post_plz")) && finitePoint(f.points[0]))
      .map(f => hit({ siteId: `bb-hauskoordinaten:${f.id}`, address: field(f, "adresse_amtlich") || `${field(f, "strassenname")} ${field(f, "hnr_adz")}, ${field(f, "gemeindename")}`,
        latitude: f.points[0]![0]!, longitude: f.points[0]![1]!, precision: "house", sourceUrl: url, body }));
  },
};

const SL: AddressPointResolver = {
  attribution: "Hauskoordinaten Saarland © LVGL Saarland, dl-de/by-2-0",
  async resolve(query, signal) {
    // ArcGIS WFS: GET filters are blocked by the portal's firewall, LIKE is case-sensitive (the pattern wildcards word-initial letters).
    const url = "https://geoportal.saarland.de/registry/wfs/416";
    const filter = fes.and(fes.or(...query.municipalities.map(m => fes.and(fes.eq("KRS", m.ags.slice(3, 5)), fes.eq("GMD", m.ags.slice(5))))), fes.eq("HNR", query.number), fes.like("STN", streetPattern(query.street), true));
    const body = await postWfs("SL", url, "GDI_ALKIS_Gebaeude:Hauskoordinaten", filter, signal);
    const features = readGmlFeatures(body, ["Hauskoordinaten"]);
    if (features.length >= WFS_COUNT) throw incomplete();
    return features.filter(f => sameStreet(query, field(f, "STN")) && normalHouse(`${field(f, "HNR")}${field(f, "ADZ")}`) === query.houseKey && plzOk(query, field(f, "PLZ")) && field(f, "QUA") !== "R" && finitePoint(f.points[0]))
      .map(f => {
        const [longitude, latitude] = fromUtm(f.points[0]![0]! % 1e6, f.points[0]![1]!, 32);
        return hit({ siteId: `sl-hauskoordinaten:${field(f, "OI") || f.id}`, address: `${field(f, "STN")} ${field(f, "HNR")}${field(f, "ADZ")}, ${field(f, "PLZ")} ${field(f, "ONM")}`.replace(/,\s+$/, ""),
          longitude, latitude, precision: field(f, "QUA") === "B" ? "parcel" : "house", sourceUrl: url, body });
      });
  },
};

const BW: AddressPointResolver = {
  attribution: "ALKIS Baden-Württemberg © LGL, www.lgl-bw.de, dl-de/by-2-0",
  async resolve(query, signal) {
    const filter = fes.and(fes.or(...query.municipalities.map(m => fes.eq("gemeinde_id", Number(m.ags)))), fes.eq("nummer", query.number), fes.like("lagebezeichnung", streetPattern(query.street)));
    const url = kvp("https://owsproxy.lgl-bw.de/owsproxy/wfs/WFS_LGL-BW_ALKIS", { SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: "nora:v_al_lagebezeichnung", COUNT: String(WFS_COUNT), FILTER: `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0">${filter}</fes:Filter>` });
    const body = await request("BW", url, signal);
    const features = readGmlFeatures(body, ["v_al_lagebezeichnung"]);
    if (features.length >= WFS_COUNT) throw incomplete();
    return features.filter(f => field(f, "hausnummer") && sameStreet(query, field(f, "lagebezeichnung")) && normalHouse(field(f, "hausnummer")) === query.houseKey && finitePoint(f.points[0]))
      .map(f => {
        const [longitude, latitude] = fromUtm(f.points[0]![0]!, f.points[0]![1]!, 32);
        const ags = `0${field(f, "gemeinde_id")}`.slice(-8);
        return hit({ siteId: `bw-alkis-lage:${field(f, "gml_id") || f.id}`, address: `${field(f, "lagebezeichnung")} ${field(f, "hausnummer")}, ${municipalityName(query, ags)}`,
          longitude, latitude, precision: "house", sourceUrl: url, body });
      });
  },
};

/** Niedersachsen and Bremen (LGLN): street catalogue -> address -> the building that points to it (or the parcel). */
function lglnAlkis(state: "NI" | "HB", endpoint: string, attribution: string): AddressPointResolver {
  const lageKey = "adv:lagebezeichnung/adv:AX_Lagebezeichnung/adv:verschluesselt/adv:AX_VerschluesselteLagebezeichnung";
  const catalogueKey = "adv:schluessel/adv:AX_VerschluesselteLagebezeichnung";
  return {
    attribution,
    async resolve(query, signal) {
      const responses: AddressHit["responses"] = [];
      const catalogue = await postWfs(state, endpoint, "adv:AX_LagebezeichnungKatalogeintrag", fes.and(
        fes.or(...query.municipalities.map(m => fes.and(fes.eq(`${catalogueKey}/adv:kreis`, m.ags.slice(3, 5)), fes.eq(`${catalogueKey}/adv:gemeinde`, m.ags.slice(5))))),
        fes.like("adv:bezeichnung", streetPattern(query.street))), signal);
      responses.push({ url: `${endpoint} (AX_LagebezeichnungKatalogeintrag)`, body: catalogue });
      // schluesselGesamt = land(2) regbez(1) kreis(2) gemeinde(3) lage(5): its first 8 digits are the AGS.
      const streets = readGmlFeatures(catalogue, ["AX_LagebezeichnungKatalogeintrag"])
        .filter(s => sameStreet(query, field(s, "bezeichnung")) && /^\d{13}$/.test(field(s, "schluesselGesamt")) && query.municipalities.some(m => m.ags === field(s, "schluesselGesamt").slice(0, 8)));
      if (streets.length >= WFS_COUNT) throw incomplete();
      const hits = await Promise.all(streets.map(async street => {
        const key = field(street, "schluesselGesamt"), ags = key.slice(0, 8);
        const addressBody = await postWfs(state, endpoint, "adv:AX_LagebezeichnungMitHausnummer", fes.and(
          fes.eq(`${lageKey}/adv:kreis`, key.slice(3, 5)), fes.eq(`${lageKey}/adv:gemeinde`, key.slice(5, 8)), fes.eq(`${lageKey}/adv:lage`, key.slice(8)),
          fes.like("adv:hausnummer", `${query.number}${ANY}`, true)), signal);
        const addresses = readGmlFeatures(addressBody, ["AX_LagebezeichnungMitHausnummer"]).filter(a => normalHouse(field(a, "hausnummer")) === query.houseKey);
        const steps = [{ url: `${endpoint} (AX_LagebezeichnungMitHausnummer ${key})`, body: addressBody }];
        return Promise.all(addresses.map(async address => {
          const buildings = address.refs.beziehtSichAuf ?? [], parcels = address.refs.gehoertZu ?? [];
          for (const [typeName, ids, precision] of [["adv:AX_Gebaeude", buildings, "building"], ["adv:AX_Flurstueck", parcels, "parcel"]] as const) {
            if (!ids.length) continue;
            const url = kvp(endpoint, { SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: typeName, RESOURCEID: ids.slice(0, 20).join(","), SRSNAME: "urn:ogc:def:crs:EPSG::4326" });
            const body = await request(state, url, signal);
            const shapes = readGmlFeatures(body, [typeName.slice(4)]);
            const centre = latLonCentre(shapes);
            if (!centre) continue;
            return hit({ siteId: `${state.toLowerCase()}-alkis:${address.id}`, address: `${field(street, "bezeichnung")} ${field(address, "hausnummer")}, ${municipalityName(query, ags)}`,
              longitude: centre[0], latitude: centre[1], precision, sourceUrl: url, body, responses: [...responses, ...steps, { url, body }] });
          }
          return null;
        }));
      }));
      return hits.flat().filter((h): h is AddressHit => !!h);
    },
  };
}
const NI = lglnAlkis("NI", "https://opendata.lgln.niedersachsen.de/doorman/noauth/alkis_wfs_sf", "ALKIS Niedersachsen © LGLN (2026), CC BY 4.0");
const HB = lglnAlkis("HB", "https://opendata.lgln.niedersachsen.de/doorman/noauth/alkishb_wfs_sf", "ALKIS Bremen © GeoBremen (2026), CC BY 4.0");

/** Address text of an ALKIS-vereinfacht parcel ("Breiter Weg 172, 173; Ulrichplatz 1, 2") -> [street, houseKey] pairs. */
export function parcelAddresses(text: string): Array<[string, string]> {
  return text.split(";").flatMap(segment => {
    const match = segment.trim().match(/^(.*?\D)\s+(\d.*)$/);
    return match ? match[2]!.split(",").map(number => [match[1]!.trim(), normalHouse(number)] as [string, string]) : [];
  });
}

/** ALKIS vereinfacht (Sachsen, Sachsen-Anhalt, Thüringen): parcels whose address text lists the house. Parcel-level only. */
function alkisSimple(state: "SN" | "ST" | "TH", endpoint: string, attribution: string, crs: "4326" | 33): AddressPointResolver {
  return {
    attribution,
    async resolve(query, signal) {
      const p = streetPattern(query.street), n = query.houseKey.replace(/^(\d+)([a-z])$/, `$1${ANY}$2`);
      // The house is the first item of a ", "-separated number list after its street, or a later one; a suffix may follow
      // with a space ("118 A"). Each extra LIKE costs the services seconds, so two broad patterns fetch and the parser decides.
      const patterns = [`${ANY}${p} ${n}${ANY}`, `${ANY}${p} ${ANY}, ${n}${ANY}`].map(pattern => fes.like("ave:lagebeztxt", pattern));
      const filter = fes.and(fes.or(...query.municipalities.map(m => fes.eq("ave:gmdschl", m.ags))), fes.or(...patterns));
      // Sachsen's firewall rejects an explicit srsName; its parcels come back in EPSG:25833.
      const body = await postWfs(state, endpoint, "ave:Flurstueck", filter, signal, crs === "4326" ? ` srsName="urn:ogc:def:crs:EPSG::4326"` : "");
      const parcels = readGmlFeatures(body, ["Flurstueck"]);
      if (parcels.length >= WFS_COUNT) throw incomplete();
      const matches = parcels.filter(parcel => query.municipalities.some(m => m.ags === field(parcel, "gmdschl"))
        && parcelAddresses(field(parcel, "lagebeztxt")).some(([street, house]) => sameStreet(query, street) && house === query.houseKey));
      const byMunicipality = new Map<string, GmlFeature[]>();
      for (const parcel of matches) byMunicipality.set(field(parcel, "gmdschl"), [...byMunicipality.get(field(parcel, "gmdschl")) ?? [], parcel]);
      return [...byMunicipality.entries()].flatMap(([ags, group]) => {
        const centres = group.map(parcel => {
          if (crs === "4326") return latLonCentre([parcel]);
          const utm = latLonCentre([{ ...parcel, parts: parcel.parts.map(part => part.flatMap((_, i) => i % 2 ? [] : [part[i + 1]!, part[i]!])), points: [] }]);
          return utm ? fromUtm(utm[0], utm[1], crs) : null;
        }).filter((c): c is [number, number] => !!c);
        if (!centres.length) return [];
        const longitude = centres.reduce((sum, c) => sum + c[0], 0) / centres.length, latitude = centres.reduce((sum, c) => sum + c[1], 0) / centres.length;
        const ids = group.map(parcel => field(parcel, "flstkennz") || parcel.id).sort();
        const label = parcelAddresses(field(group[0]!, "lagebeztxt")).find(([street, house]) => sameStreet(query, street) && house === query.houseKey)!;
        return [hit({ siteId: `${state.toLowerCase()}-alkis-flurstueck:${ids[0]}${ids.length > 1 ? `+${ids.length - 1}` : ""}`,
          address: `${label[0]} ${query.number}${query.suffix}, ${municipalityName(query, ags)}`, longitude, latitude, precision: "parcel", sourceUrl: endpoint, body })];
      });
    },
  };
}
const SN = alkisSimple("SN", "https://geodienste.sachsen.de/aaa/public_alkis/vereinf/wfs", "ALKIS vereinfacht © Landesamt für Geobasisinformation Sachsen (GeoSN), dl-de/by-2-0", 33);
const ST = alkisSimple("ST", "https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_ALKIS_WFS_OpenData/guest", "ALKIS vereinfacht © GeoBasis-DE / LVermGeo LSA, dl-de/by-2-0", "4326");
const TH = alkisSimple("TH", "https://www.geoproxy.geoportal-th.de/geoproxy/services/adv_alkis_v2_wfs", "ALKIS vereinfacht © GDI-Th, CC BY 4.0", "4326");

const BE: AddressPointResolver = {
  attribution: "Adressen Berlin © Amt für Statistik Berlin-Brandenburg, CC BY 3.0 DE",
  async resolve(query, signal) {
    if (query.suffix.includes("/")) return [];
    const expanded = query.street.replace(/str\.(?=$|[\s-])/i, "straße");
    const { url, body, matches } = await findBerlinAddresses(query.address, expanded, query.number, query.suffix, signal).catch(error => {
      if (/incomplete/.test(error?.message ?? "")) throw incomplete();
      signal.throwIfAborted(); throw Object.assign(unavailable("BE"), { cause: error });
    });
    return matches.filter(f => sameStreet(query, String(f.properties.str_name ?? ""))).map(f => hit({
      siteId: `berlin-address:${f.properties.adressid}`, address: `${f.properties.str_name} ${f.properties.hnr}${f.properties.hnr_zusatz || ""}, ${f.properties.plz} Berlin`,
      longitude: f.geometry!.coordinates[0], latitude: f.geometry!.coordinates[1], precision: "house", sourceUrl: url.href, body }));
  },
};

const HE: AddressPointResolver = {
  attribution: "Hauskoordinaten Hessen © Hessische Verwaltung für Bodenmanagement und Geoinformation (HVBG), dl-de/zero-2-0",
  async resolve(query, signal) {
    if (query.suffix.includes("/")) return [];
    const site = await resolveHessenAddress({ ...query.address, street: `${query.street.replace(/str\.(?=$|[\s-])/i, "straße")} ${query.number}${query.suffix}` }, signal);
    return site ? [hit({ siteId: site.siteId, address: site.address, longitude: site.longitude, latitude: site.latitude, precision: "house", sourceUrl: site.sourceUrl, body: site.body })] : [];
  },
};

const RP: AddressPointResolver = {
  attribution: "Adresssuche maps.rlp.de © GeoBasis-DE / LVermGeoRP, BKG",
  async resolve(query, signal) {
    const { resolveRlpAddress } = await import("./location-rlp");
    const site = await resolveRlpAddress(query.address, signal).catch(error => {
      if (error?.code === "address_not_found") return null;
      if (error?.code === "address_ambiguous") throw coded(error.message, "environment_address_ambiguous", 409);
      signal.throwIfAborted(); throw Object.assign(unavailable("RP"), { cause: error });
    });
    return site ? [hit({ siteId: site.siteId, address: site.address, longitude: site.longitude, latitude: site.latitude, precision: "house", sourceUrl: site.sources[0]!.url, body: JSON.stringify(site) })] : [];
  },
};

/** Official open registers per state. BY, MV and SH publish no open, exactly queryable house coordinates (see Richtfest Docs). */
const REGISTERS: Partial<Record<StateCode, AddressPointResolver>> = { BE, BB, BW, HB, HE, HH, NI, NW, RP, SL, SN, ST, TH };
export const ADDRESS_POINT_STATES = (Object.keys(REGISTERS) as StateCode[]).sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b], "de"));

// ---------------------------------------------------------------------------------------------
// Fallback geocoder: the single plug-in point for states without an open register

export type NominatimConfig = { url: string; userAgent: string };
let nominatimNextSlot = 0;
const nominatimCache = new Map<string, { at: number; hits: AddressHit[] }>();

/**
 * OpenStreetMap Nominatim, used only for states without an open official register (BY, MV, SH).
 * Usage policy: identifying User-Agent, at most one request per second per process, results cached,
 * no bulk use. Accepts only results whose address details carry the exact street and house number.
 */
export function nominatimGeocoder(config: NominatimConfig): AddressPointResolver {
  return {
    attribution: "© OpenStreetMap contributors, ODbL 1.0 (Nominatim); approximate, not an official house coordinate",
    async resolve(query, signal) {
      const url = kvp(`${config.url.replace(/\/+$/, "")}/search`, { street: `${query.number}${query.suffix} ${query.street}`, city: query.city, ...(query.postalCode ? { postalcode: query.postalCode } : {}),
        countrycodes: "de", format: "jsonv2", addressdetails: "1", limit: "10" });
      const cached = nominatimCache.get(url);
      if (cached && Date.now() - cached.at < 24 * 3600_000) return cached.hits;
      const wait = Math.max(0, nominatimNextSlot - Date.now());
      nominatimNextSlot = Math.max(Date.now(), nominatimNextSlot) + 1100;
      if (wait) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      const state = query.municipalities[0]?.state ?? "BY";
      const body = await request(state, url, signal, { headers: { "user-agent": config.userAgent, accept: "application/json" } });
      const results = JSON.parse(body) as Array<{ osm_type: string; osm_id: number; lat: string; lon: string; address?: Record<string, string> }>;
      if (!Array.isArray(results)) throw coded("Nominatim returned an invalid response", "environment_invalid_response", 502);
      const places = query.municipalities.map(m => normalPlace(m.name));
      const hits = results.filter(r => {
        const a = r.address ?? {};
        const street = a.road ?? a.pedestrian ?? a.square ?? a.footway ?? a.path ?? a.place ?? "";
        const place = [a.city, a.town, a.village, a.municipality].filter(Boolean).map(value => normalPlace(value!));
        return street && sameStreet(query, street) && normalHouse(a.house_number ?? "") === query.houseKey && plzOk(query, a.postcode ?? "")
          && place.some(value => places.some(p => value === p || p.startsWith(`${value} `) || value.startsWith(`${p} `)));
      }).map(r => {
        const a = r.address!;
        return hit({ siteId: `osm:${r.osm_type}/${r.osm_id}`, address: `${a.road ?? a.pedestrian ?? a.square ?? a.footway ?? a.path ?? a.place} ${a.house_number}, ${a.postcode ? `${a.postcode} ` : ""}${a.city ?? a.town ?? a.village ?? a.municipality}`,
          longitude: Number(r.lon), latitude: Number(r.lat), precision: "approximate", sourceUrl: url, body });
      }).filter(h => Number.isFinite(h.longitude) && Number.isFinite(h.latitude));
      nominatimCache.set(url, { at: Date.now(), hits });
      if (nominatimCache.size > 500) nominatimCache.delete(nominatimCache.keys().next().value!);
      return hits;
    },
  };
}

export type AddressPointOptions = {
  /** Fallback for states without an open register (BY, MV, SH). Production passes the configured Nominatim. */
  fallback?: AddressPointResolver | null;
  /** Test seam: replaces the official registers. */
  registers?: Partial<Record<StateCode, AddressPointResolver>>;
};

// ---------------------------------------------------------------------------------------------
// Resolution

const supportedText = (fallback: boolean) => `Site address points are available for ${ADDRESS_POINT_STATES.map(s => STATE_NAMES[s]).join(", ")}${fallback ? ", and approximately (OpenStreetMap) for Bayern, Mecklenburg-Vorpommern and Schleswig-Holstein" : ""}.`;


/** Resolves a project address to one address point, or explains why not. Throws for upstream failures and ambiguity. */
export async function locateAddressPoint(input: ProjectAddress, signal: AbortSignal, options: AddressPointOptions = {}): Promise<AddressPointLookup> {
  const registers = options.registers ?? REGISTERS, fallback = options.fallback ?? null;
  const address = projectAddressInput.parse(input);
  // Every miss names the states that are covered.
  const miss = (reason: AddressPointMissReason, states: StateCode[], message: string): AddressPointLookup => ({ point: null, reason, states, message: `${message} ${supportedText(!!fallback)}` });
  if (address.country && !["de", "deu", "deutschland", "germany"].includes(address.country.trim().toLowerCase())) return miss("outside_germany", [], `Site address must be in Germany.`);
  const parsed = address.street ? parseStreetAddress(address.street) : null;
  const postalCode = address.postalCode?.trim() || null;
  if (!parsed || !address.city?.trim() || (postalCode && !/^\d{5}$/.test(postalCode)))
    return miss("invalid_address", [], "Site address needs a street with one exact house number (for example Friedrich-Ebert-Straße 79) and a municipality; check the postal code too.");
  let candidates = await municipalityCandidates(address.city);
  // Hessen's register also knows historic municipality names, which VG250 does not.
  const byName = !candidates.length;
  if (byName && registers.HE) candidates = [{ ags: "", name: address.city.trim(), state: "HE" }];
  if (!candidates.length) return miss("municipality_not_found", [], `"${address.city}" is not an official municipality name (BKG VG250); use the municipality, not the district.`);
  if (candidates.length > 40) return miss("municipality_ambiguous", [...new Set(candidates.map(c => c.state))], `"${address.city}" matches ${candidates.length} municipalities; use the full official municipality name.`);
  const states = [...new Set(candidates.map(c => c.state))];
  const base = { address, ...parsed, city: address.city.trim(), postalCode };

  const outcomes = await Promise.allSettled(states.map(async state => {
    const resolver = registers[state] ?? (fallback && ["BY", "MV", "SH"].includes(state) ? fallback : undefined);
    if (!resolver) return { state, resolver: null, hits: [] as AddressHit[] };
    const hits = await resolver.resolve({ ...base, municipalities: candidates.filter(c => c.state === state) }, signal);
    // The point, not the register, decides the state: drop hits that lie outside the state they were found in.
    const inside = await Promise.all(hits.map(async h => (await statesNear(h.longitude, h.latitude)).includes(state)));
    return { state, resolver, hits: hits.filter((_, i) => inside[i]) };
  }));
  signal.throwIfAborted();
  const failure = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
  // Strict: an unavailable candidate register could hold the real address, so do not settle on another state's hit.
  if (failure) throw failure.reason;
  const resolved = outcomes.map(o => (o as PromiseFulfilledResult<{ state: StateCode; resolver: AddressPointResolver | null; hits: AddressHit[] }>).value);
  const found = resolved.filter(r => r.resolver && r.hits.length);
  if (!found.length) {
    const unsupported = resolved.filter(r => !r.resolver).map(r => r.state);
    if (byName) return miss("municipality_not_found", [], `"${address.city}" is not an official municipality name (BKG VG250) and was not found in Hessen; use the municipality, not the district.`);
    if (unsupported.length === states.length)
      return miss("no_open_service", unsupported, `${unsupported.map(s => STATE_NAMES[s]).join(" and ")} publish${unsupported.length > 1 ? "" : "es"} no open house coordinates${fallback ? "" : " and no fallback geocoder is configured"}.`);
    return miss("not_found", states, `Site address not found as an exact house in ${states.filter(s => !unsupported.includes(s)).map(s => STATE_NAMES[s]).join(" or ")}; check street, house number and municipality in project details.`);
  }
  if (found.length > 1) throw coded(`Site address exists in ${found.map(f => STATE_NAMES[f.state]).join(" and ")}; add the postal code or the full municipality name in project details`, "environment_address_ambiguous", 409);
  const { state, resolver, hits } = found[0]!;
  const sorted = [...hits].sort((a, b) => a.siteId.localeCompare(b.siteId));
  if (sorted.some(h => distanceMeters(h, sorted[0]!) > SAME_PLACE_M))
    throw coded("Site address matches several distant houses; add the postal code or the full municipality name in project details", "environment_address_ambiguous", 409);
  return { point: { state, ...sorted[0]!, attribution: resolver!.attribution } };
}

/** One address point for a project address, or null (see locateAddressPoint for the reason). */
export async function resolveAddressPoint(address: ProjectAddress, signal: AbortSignal, options?: AddressPointOptions): Promise<AddressPoint | null> {
  return (await locateAddressPoint(address, signal, options)).point;
}
