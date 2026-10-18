import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toUtm } from "@richtfest/shared";
import { stateAttribution, stateCategories, stateConnectorVersion } from "./environment";
import { bwMappedAxis, fromUtm, normaliseDesignation, readGmlFeatures, thMappedAxis, STATE_CODES } from "./noise-geodata";

// Trimmed real responses recorded 2026-10-18 (see __fixtures__/noise).
const fixture = (name: string) => readFileSync(join(import.meta.dir, "__fixtures__", "noise", name), "utf8");
const empty = `<?xml version="1.0" encoding="utf-8"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberReturned="0"></wfs:FeatureCollection>`;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Serves fixtures by requested type name; records every request URL. */
function serve(byType: Record<string, string>) {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input)); urls.push(url);
    const type = url.searchParams.get("TYPENAMES") ?? (url.searchParams.has("RESOURCEID") ? "RESOURCEID" : "");
    const filter = url.searchParams.get("FILTER") ?? "";
    const key = filter ? (filter.includes("Bahnstrecke") ? "rail" : "roads") : type;
    return new Response(byType[key] ?? empty, { status: 200 });
  }) as typeof fetch;
  return urls;
}
const around = (longitude: number, latitude: number) => {
  const dy = 1000 / 111320, dx = 1000 / (111320 * Math.cos(latitude * Math.PI / 180));
  return { site: { longitude, latitude }, bbox: [longitude - dx, latitude - dy, longitude + dx, latitude + dy] as [number, number, number, number] };
};

test("designations are normalised to the signposted form", () => {
  expect(["B80", "B2R", "K2127", "L22", "A 1", "St2345", "K M 3", "B27#B10", " B  1 ", "", null].map(normaliseDesignation))
    .toEqual(["B 80", "B 2R", "K 2127", "L 22", "A 1", "St 2345", "K M 3", "B 27, B 10", "B 1", null, null]);
});

test("UTM 33 conversion round-trips within a centimetre", () => {
  for (const [lon, lat] of [[12.1401, 54.0891], [13.0578, 52.4055], [14.5, 53.5]] as const) {
    const [back, backLat] = fromUtm(...toUtm(lon, lat, 33), 33);
    expect(Math.abs(back - lon) * 65000).toBeLessThan(0.01);
    expect(Math.abs(backLat - lat) * 111000).toBeLessThan(0.01);
  }
});

test("every state has a connector version or an explicit gap", () => {
  const versions = Object.fromEntries(STATE_CODES.map(state => [state, stateConnectorVersion(state)]));
  expect(versions).toMatchObject({ HE: "he-basis-dlm-hako-framap-v1", NW: "nw-basis-dlm-v1", BY: "by-basis-dlm-v1", BW: "bw-basis-dlm-v1", TH: "th-basis-dlm-v1", MV: "mv-basis-dlm-v1", HH: null, SN: null, SL: null });
  expect(stateAttribution("NI", 2026)).toStartWith("LGLN (2026) Creative Commons");
});

test("Bayern: namespaces on every request, TYPENAMES on the AX_Strasse lookup, designation normalised", async () => {
  const urls = serve({ "adv:AX_Strassenachse": fixture("by-strassenachse.xml"), RESOURCEID: fixture("by-strasse.xml"), "adv:AX_Strasse": fixture("by-strasse.xml"), "adv:AX_Bahnstrecke": fixture("by-bahnstrecke.xml") });
  const { site, bbox } = around(11.5368, 48.1490);
  const [roads, rail] = await stateCategories("BY", site, bbox, "2026-10-18T00:00:00Z", []);
  expect(urls.every(url => url.searchParams.get("NAMESPACES") === "xmlns(adv,http://www.adv-online.de/namespaces/adv/gid/7.1)")).toBe(true);
  const lookup = urls.find(url => url.searchParams.has("RESOURCEID"))!;
  expect(lookup.searchParams.get("TYPENAMES")).toBe("adv:AX_Strasse");
  expect(lookup.searchParams.get("RESOURCEID")).toBe("DEBYBDLMaR000CCV");
  expect(urls[0]!.searchParams.get("BBOX")).toBe(`${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]},urn:ogc:def:crs:EPSG::4326`);
  expect(roads!.status).toBe("findings");
  expect(roads!.mapped).toEqual([expect.objectContaining({ name: "Landshuter Allee", dedication: "1303", designation: "B 2R", lanes: 3, carriagewayWidthM: 9, segments: 2 })]);
  expect(rail!.mapped).toEqual([expect.objectContaining({ ref: "rail:route:5550", categories: ["1104"], routeNumbers: ["5550"], tracks: "2000", electrified: true })]);
});

test("Mecklenburg-Vorpommern: EPSG:25833 bbox easting first, axes converted back from UTM 33", async () => {
  const urls = serve({ "adv:AX_Strassenachse": fixture("mv-strassenachse.xml"), "adv:AX_Strasse": fixture("mv-strasse.xml"), "adv:AX_Bahnstrecke": fixture("mv-bahnstrecke.xml") });
  const [longitude, latitude] = fromUtm(312957.381, 5997216.228, 33);
  const { site, bbox } = around(longitude, latitude);
  const [roads, rail] = await stateCategories("MV", site, bbox, "2026-10-18T00:00:00Z", []);
  const [minE, minN, maxE, maxN, crs] = urls[0]!.searchParams.get("BBOX")!.split(",");
  expect(crs).toBe("urn:ogc:def:crs:EPSG::25833");
  expect(Number(minE)).toBeLessThan(312957); expect(Number(maxE)).toBeGreaterThan(312957);
  expect(Number(minN)).toBeLessThan(5997216); expect(Number(maxN)).toBeGreaterThan(5997216);
  expect(urls[0]!.searchParams.get("SRSNAME")).toBe("urn:ogc:def:crs:EPSG::25833");
  const church = roads!.mapped!.find(road => road.kind === "road" && road.name === "Bei der Marienkirche")!;
  expect(church).toMatchObject({ dedication: "1307", designation: null });
  // The address point lies on this street: a wrong zone would put it ~400 km away.
  expect(church.distanceMeters).toBeLessThan(20);
  expect(rail!.mapped![0]).toMatchObject({ categories: ["1201"], tracks: "2000", electrified: true });
});

test("Hessen keeps its unchanged request shape: EPSG:4326 and RESOURCEID without TYPENAMES", async () => {
  const urls = serve({ "adv:AX_Strassenachse": fixture("by-strassenachse.xml") });
  const { site, bbox } = around(11.5368, 48.1490);
  await stateCategories("HE", site, bbox, "2026-10-18T00:00:00Z", []);
  expect(urls[0]!.origin + urls[0]!.pathname).toBe("https://www.gds.hessen.de/wfs2/aaa-suite/cgi-bin/atkis-bdlm/sf/wfs");
  expect(urls[0]!.searchParams.has("NAMESPACES")).toBe(false);
  const lookup = urls.find(url => url.searchParams.has("RESOURCEID"))!;
  expect([...lookup.searchParams.keys()]).toEqual(["SERVICE", "VERSION", "REQUEST", "RESOURCEID"]);
});

test("Baden-Württemberg: flat NOrA axes with dedication, normalised designation and text rail categories", async () => {
  const roads = readGmlFeatures(fixture("bw-roads.xml"), ["v_verkehrslinie"]).map(bwMappedAxis);
  expect(roads[0]).toMatchObject({ id: "DEBWB0010000SE3U", kind: "road", name: "Heilbronner Straße", dedication: "1303", designation: "B 27", lanes: 3, widthM: 11, group: "0811100021540" });
  expect(roads[1]).toMatchObject({ name: "Kriegerstraße", dedication: "1307", designation: null, lanes: 2, widthM: null });
  // EPSG:25832 posList -> [longitude, latitude] near Stuttgart Hbf.
  expect(roads[0]!.parts[0]![0]![0]).toBeCloseTo(9.18, 1); expect(roads[0]!.parts[0]![0]![1]).toBeCloseTo(48.79, 1);
  // The service also publishes several categories as a JSON list.
  const rail = readGmlFeatures(fixture("bw-rail.xml").replace("<nora:klasse>Eisenbahn</nora:klasse>", `<nora:klasse>["Eisenbahn", "Güterverkehr"]</nora:klasse>`), ["v_verkehrslinie"]).map(bwMappedAxis);
  expect(rail[0]).toMatchObject({ kind: "rail", categories: ["1100", "1102"], routeNumbers: [], tracks: "2000", electrified: true });
  expect(rail[1]).toMatchObject({ categories: ["1104"], group: "1104|" });

  const urls = serve({ roads: fixture("bw-roads.xml"), rail: fixture("bw-rail.xml") });
  const [longitude, latitude] = fromUtm(513345.37, 5403393.06, 32);
  const { site, bbox } = around(longitude, latitude);
  const [roadCategory, railCategory, industry] = await stateCategories("BW", site, bbox, "2026-10-18T00:00:00Z", []);
  expect(urls[0]!.searchParams.get("SRSNAME")).toBe("urn:ogc:def:crs:EPSG::25832");
  expect(urls[0]!.searchParams.get("FILTER")).toContain("<fes:Literal>Fahrbahnachse</fes:Literal>");
  expect(roadCategory!.mapped!.map(road => road.kind === "road" && road.designation)).toContain("B 27");
  expect(railCategory!.mapped).toHaveLength(2);
  expect(industry!.status).toBe("not_checked");
});

test("Thüringen: flat deegree axes with inline name, '#'-joined routes and -9998 placeholders", async () => {
  const roads = readGmlFeatures(fixture("th-strassenachse.xml"), ["AX_STRASSENACHSE"]).map(thMappedAxis);
  expect(roads[0]).toMatchObject({ id: "DETHTL25000056dA", name: "Krämerbrücke", dedication: "1307", designation: null, lanes: null, widthM: 3, group: "DETHTL25000056XQ" });
  expect(roads[1]).toMatchObject({ dedication: "1306", designation: "K 16", lanes: 3, widthM: 7 });
  const rail = readGmlFeatures(fixture("th-bahnstrecke.xml"), ["AX_BAHNSTRECKE"]).map(thMappedAxis);
  expect(rail[0]).toMatchObject({ categories: ["1100"], routeNumbers: ["6291", "6340"], group: "route:6291+6340", tracks: "2000", electrified: true });
  expect(rail[1]).toMatchObject({ categories: ["1200"], routeNumbers: [], lines: ["2", "3", "6"] });

  const urls = serve({ "dlm:AX_STRASSENACHSE": fixture("th-strassenachse.xml"), "dlm:AX_BAHNSTRECKE": fixture("th-bahnstrecke.xml") });
  const [longitude, latitude] = fromUtm(642439.467, 5649327.58, 32);
  const { site, bbox } = around(longitude, latitude);
  const [roadCategory, railCategory] = await stateCategories("TH", site, bbox, "2026-10-18T00:00:00Z", []);
  expect(urls[0]!.searchParams.get("BBOX")).toEndWith(",urn:ogc:def:crs:EPSG::25832");
  expect(roadCategory!.mapped![0]).toMatchObject({ name: "Krämerbrücke" });
  expect(roadCategory!.mapped![0]!.distanceMeters).toBeLessThan(200);
  expect(railCategory!.mapped!.map(item => item.kind === "rail" && item.routeNumbers)).toContainEqual(["6291", "6340"]);
});

test("states without an open classified source return not_checked categories", async () => {
  const { site, bbox } = around(9.99, 53.55);
  const categories = await stateCategories("HH", site, bbox, "2026-10-18T00:00:00Z", []);
  expect(categories.map(item => item.status)).toEqual(["not_checked", "not_checked", "not_checked", "not_checked"]);
});
