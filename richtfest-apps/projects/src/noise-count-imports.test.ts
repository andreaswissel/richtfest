import { expect, spyOn, test } from "bun:test";
import type { MappedRoad, TrafficCountRecord } from "@richtfest/shared";
import { matchImportedCounts, overlayNationalCounts } from "./noise-counts";

// Imported file counts (BASt, state road authorities) against mapped roads, in local metres around a site.
const site = { longitude: 8.68, latitude: 50.11 };
const kx = 111320 * Math.cos(site.latitude * Math.PI / 180), ky = 110574;
const at = (x: number, y: number): [number, number] => [site.longitude + x / kx, site.latitude + y / ky];
const line = (...points: Array<[number, number]>) => [points.map(([x, y]) => at(x, y))];
const road = (ref: string, designation: string | null, axes: MappedRoad["axes"], traffic?: MappedRoad["traffic"]): MappedRoad =>
  ({ kind: "road", ref, name: ref, dedication: "1303", designation, lanes: null, carriagewayWidthM: null, ...(traffic ? { traffic } : {}), distanceMeters: null, segments: 1, axes });
const imported = (stationId: string, over: Partial<TrafficCountRecord> & Pick<TrafficCountRecord, "geometry">): TrafficCountRecord => ({
  sourceId: "bast-dz-2024", label: "BASt Dauerzählstellen 2024", sourceUrl: "https://www.bast.de/jawe2024.csv", licence: "CC BY 4.0", release: "2024", year: 2024,
  stationId, road: null, name: null, kind: "station", specificity: 2, dailyTraffic: 20_000, heavyVehicles: 1_000,
  hourly: { day: null, night: null, heavyShareDay: null, heavyShareNight: null, p1Day: null, p2Day: null, p1Night: null, p2Night: null },
  checksum: "a".repeat(64), importedAt: "2026-10-18T00:00:00.000Z", ...over,
});
const station = (x: number, y: number) => ({ type: "Point" as const, coordinates: at(x, y) });
const section = (...points: Array<[number, number]>) => ({ type: "MultiLineString" as const, coordinates: line(...points) });
const nwSection = { sourceId: "nw-verkehrswerte", label: "Straßen.NRW Verkehrswerte (SVZ 2021)", kind: "section" as const, specificity: 3, year: 2021 };

test("a count station attaches to every nearby road with its designation, never to a road with another one", () => {
  // Two carriageways of the B521 10 m either side of the station; the B3 runs 5 m from it; a side street without designation 25 m away.
  const north = road("north", "B521", line([-300, 10], [300, 10])), south = road("south", "B521", line([-300, -10], [300, -10]));
  const other = road("b3", "B3", line([-300, 5], [300, 5])), side = road("side", null, line([25, -300], [25, 300]));
  const used = matchImportedCounts([north, south, other, side], [imported("6310", { road: "B 521", name: "Bad Vilbel", geometry: station(0, 0), dailyTraffic: 28_387, heavyVehicles: 1_029 })], site);
  expect(used.map(record => record.stationId)).toEqual(["6310"]);
  expect(north.traffic).toEqual({ dailyTraffic: 28_387, heavyVehicles: 1_029, year: 2024, source: "BASt Dauerzählstellen 2024, station 6310 Bad Vilbel" });
  expect(south.traffic).toEqual(north.traffic!);
  expect(other.traffic).toBeUndefined();
  expect(side.traffic).toBeUndefined();
});

test("without a designated match the nearest road of unknown designation takes a station; beyond 30 m it attaches nowhere", () => {
  const unnamed = road("unnamed", null, line([-300, 20], [300, 20])), farther = road("farther", null, line([-300, 28], [300, 28]));
  const other = road("b3", "B3", line([-300, 1], [300, 1]));
  matchImportedCounts([unnamed, farther, other], [imported("7000", { road: "B 521", geometry: station(0, 0) }), imported("far", { geometry: station(0, 80) })], site);
  expect(unnamed.traffic?.source).toBe("BASt Dauerzählstellen 2024, station 7000");
  expect(farther.traffic).toBeUndefined();
  expect(other.traffic).toBeUndefined();
});

test("counted sections attach where they run along the road, also when they extend far beyond the site", () => {
  const along = road("along", "L593", line([-500, 0], [500, 0])), crossing = road("crossing", "L12", line([0, -500], [0, 500]));
  const sections = [
    imported("long", { ...nwSection, road: "L 593", dailyTraffic: 1_388, heavyVehicles: 123, geometry: section([-6000, 6], [6000, 6]) }),
    imported("across", { ...nwSection, road: null, geometry: section([-200, -300], [200, 300]) }),
  ];
  expect(matchImportedCounts([along, crossing], sections, site).map(record => record.stationId)).toEqual(["long"]);
  expect(along.traffic).toEqual({ dailyTraffic: 1_388, heavyVehicles: 123, year: 2021, source: "Straßen.NRW Verkehrswerte (SVZ 2021), section long" });
  expect(crossing.traffic).toBeUndefined();
});

test("between imported counts the most recent wins, then the more specific source, then the one nearest the site", () => {
  const svzPoint = imported("svz", { sourceId: "bast-svz-2021", label: "BASt Straßenverkehrszählung 2021", year: 2021, specificity: 1, road: "B 9", dailyTraffic: 9_000, geometry: station(10, 3) });
  const stateSection = imported("nw", { ...nwSection, road: "B 9", dailyTraffic: 8_909, geometry: section([-400, 4], [400, 4]) });
  const permanent = imported("dz", { road: "B 9", dailyTraffic: 10_100, geometry: station(-250, 2) });
  const a = road("a", "B9", line([-500, 0], [500, 0])), b = road("b", "B9", line([-500, 0], [500, 0])), c = road("c", "B9", line([-500, 0], [500, 0]));
  matchImportedCounts([a], [svzPoint, stateSection, permanent], site);
  expect(a.traffic?.dailyTraffic).toBe(10_100); // the 2024 permanent station beats the 2021 counts
  matchImportedCounts([b], [svzPoint, stateSection], site);
  expect(b.traffic?.dailyTraffic).toBe(8_909); // same year: the state section beats the SVZ point
  matchImportedCounts([c], [imported("far", { road: "B 9", dailyTraffic: 1, geometry: station(450, 0) }), imported("near", { road: "B 9", dailyTraffic: 2, geometry: station(30, 0) })], site);
  expect(c.traffic?.dailyTraffic).toBe(2);
});

test("overlay precedence: an imported BASt count beats the UBA one, UBA fills the rest, a state connector's count is kept", async () => {
  const pos = (x: number, y: number) => { const [lon, lat] = at(x, y); return `${lat} ${lon}`; };
  // A UBA segment runs along each of the three roads.
  const uba = `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:gpkg="http://www.esdi-humboldt.eu/hale/gpkg">
${[0, 100, 200].map(y => `<wfs:member><gpkg:MajorRoadSource gml:id="U${y}"><roadId_identifier>U${y}</roadId_identifier><annualTrafficFlow>7300000</annualTrafficFlow>
<centrelineGeometry><gml:MultiCurve gml:id="g${y}"><gml:curveMember><gml:LineString gml:id="l${y}"><gml:posList>${pos(-200, y + 3)} ${pos(200, y + 3)}</gml:posList></gml:LineString></gml:curveMember></gml:MultiCurve></centrelineGeometry></gpkg:MajorRoadSource></wfs:member>`).join("\n")}
</wfs:FeatureCollection>`;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(uba)) as any);
  try {
    const bast = road("bast", "B521", line([-300, 0], [300, 0])), ubaOnly = road("uba", null, line([-300, 100], [300, 100]));
    const berlinCount = { dailyTraffic: 31_000, heavyVehicles: 2_100, year: 2019, source: "Verkehrsmengenkarte Berlin 2019" };
    const berlin = road("berlin", "B96", line([-300, 200], [300, 200]), berlinCount);
    const categories: any[] = [{ category: "roads", mapped: [bast, ubaOnly, berlin], sources: [], limitations: [] }];
    const records = [imported("6310", { road: "B 521", geometry: station(0, 5), dailyTraffic: 28_387, heavyVehicles: 1_029 }), imported("berlin-station", { road: "B 96", geometry: station(0, 200) })];
    let asked: number[] | null = null;
    await overlayNationalCounts(categories, site, [8.6, 50.0, 8.8, 50.2], "2026-10-18T00:00:00.000Z", [], undefined, async bbox => { asked = bbox; return records; });
    expect(asked!).toEqual([8.6, 50.0, 8.8, 50.2]);
    expect(bast.traffic).toEqual({ dailyTraffic: 28_387, heavyVehicles: 1_029, year: 2024, source: "BASt Dauerzählstellen 2024, station 6310" });
    expect(ubaOnly.traffic).toEqual({ dailyTraffic: 20_000, heavyVehicles: null, year: 2022, source: "UBA Lärmkartierung 2022 (Kfz/Jahr ÷ 365)" });
    expect(berlin.traffic).toEqual(berlinCount);
    expect(categories[0].sources).toContainEqual({ url: "https://www.bast.de/jawe2024.csv", retrievedAt: "2026-10-18T00:00:00.000Z", sha256: "a".repeat(64) });
    expect(categories[0].limitations.some((note: string) => note.startsWith('Counts marked "BASt Dauerzählstellen 2024"'))).toBe(true);

    // Unreadable imported counts are reported, and the UBA counts still apply.
    const fresh = road("fresh", "B521", line([-300, 0], [300, 0]));
    const again: any[] = [{ category: "roads", mapped: [fresh], sources: [], limitations: [] }];
    await overlayNationalCounts(again, site, [8.6, 50.0, 8.8, 50.2], "2026-10-18T00:00:00.000Z", [], undefined, async () => { throw new Error("relation missing"); });
    expect(fresh.traffic?.source).toBe("UBA Lärmkartierung 2022 (Kfz/Jahr ÷ 365)");
    expect(again[0].limitations).toContain("Imported traffic counts (BASt, state road authorities) could not be read; they were not checked.");
  } finally { fetchSpy.mockRestore(); }
});
