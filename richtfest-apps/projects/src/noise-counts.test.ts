import { expect, test } from "bun:test";
import type { MappedRail, MappedRoad } from "@richtfest/shared";
import { ebaRailCounts, germanCount, matchRailCounts, matchRoadCounts, ubaRailCounts, ubaRoadCounts, type RailCount, type RoadCount } from "./noise-counts";
import { readGmlFeatures } from "./noise-geodata";

const site = { longitude: 8.68, latitude: 50.11 };
const kx = 111320 * Math.cos(site.latitude * Math.PI / 180), ky = 110574;
/** Local metres east/north of the site -> [longitude, latitude]. */
const at = (x: number, y: number): [number, number] => [site.longitude + x / kx, site.latitude + y / ky];
const line = (...points: Array<[number, number]>) => [points.map(([x, y]) => at(x, y))];
const road = (ref: string, axes: MappedRoad["axes"], traffic?: MappedRoad["traffic"]): MappedRoad =>
  ({ kind: "road", ref, name: ref, dedication: "1307", designation: null, lanes: null, carriagewayWidthM: null, ...(traffic ? { traffic } : {}), distanceMeters: null, segments: 1, axes });
const rail = (ref: string, routeNumbers: string[], axes: MappedRail["axes"], categories = ["1100"]): MappedRail =>
  ({ kind: "rail", ref, name: ref, categories, routeNumbers, lines: [], tracks: null, electrified: null, distanceMeters: null, segments: 1, axes });
const roadCount = (id: string, annual: number, parts: RoadCount["parts"]): RoadCount => ({ id, annual, name: null, code: null, parts });
const railCount = (id: string, routeNumbers: string[], trainsPerYear: number, parts: RailCount["parts"]): RailCount =>
  ({ id, routeNumbers, parts, traffic: { trainsPerYear, day: null, evening: null, night: null, routeNumbers, segmentId: id, year: 2022, source: "test" } });

test("a road count goes to the road it runs along, not to the road it crosses at its end", () => {
  // Road A runs east-west at y = 0; road B runs north-south at x = 200, where the count segment ends.
  const a = road("A", line([-300, 0], [300, 0])), b = road("B", line([200, -300], [200, 300]));
  // The count segment runs 8 m north of A from x = 0 to its end on B's axis.
  const attached = matchRoadCounts([b, a], [roadCount("seg", 3_650_000, line([0, 8], [200, 8]))], site);
  expect(attached).toBe(1);
  expect(a.traffic).toEqual({ dailyTraffic: 10_000, heavyVehicles: null, year: 2022, source: "UBA Lärmkartierung 2022 (Kfz/Jahr ÷ 365)" });
  expect(b.traffic).toBeUndefined();
});

test("a crossing or distant count segment attaches nowhere", () => {
  const a = road("A", line([-300, 0], [300, 0]));
  // Perpendicular across A, and parallel but 40 m away.
  expect(matchRoadCounts([a], [roadCount("cross", 4_000_000, line([0, -100], [0, 100])), roadCount("far", 4_000_000, line([-100, 40], [100, 40]))], site)).toBe(0);
  expect(a.traffic).toBeUndefined();
});

test("a road that already has a state count keeps it; of several matches the segment nearest the site wins", () => {
  const berlin = { dailyTraffic: 24_000, heavyVehicles: 1_200, year: 2019, source: "Verkehrsmengenkarte 2019" };
  const counted = road("counted", line([-300, 0], [300, 0]), berlin);
  const other = road("other", line([-300, 100], [300, 100]));
  const attached = matchRoadCounts([counted, other], [
    roadCount("on-counted", 7_300_000, line([-100, 3], [100, 3])),
    roadCount("other-far", 3_650_000, line([200, 104], [290, 104])),
    roadCount("other-near", 5_475_000, line([-50, 104], [50, 104])),
  ], site);
  expect(attached).toBe(1);
  expect(counted.traffic).toEqual(berlin);
  expect(other.traffic?.dailyTraffic).toBe(15_000);
});

test("rail counts match by VzG route number before geometry, nearest the site among route matches", () => {
  // The mapped line 2600 runs east-west at y = 50; another line (3600) runs right on top of it, 2600's count lies 40 m off.
  const mainline = rail("2600", ["2600"], line([-500, 50], [500, 50]));
  const counts = [
    railCount("other-line", ["3600"], 999_999, line([-400, 50], [400, 50])),
    railCount("route-far", ["2600", "2630"], 50_000, line([300, 90], [490, 90])),
    railCount("route-near", ["2600"], 111_074, line([-100, 90], [100, 90])),
  ];
  expect(matchRailCounts([mainline], counts, site)).toBe(1);
  expect(mainline.traffic?.segmentId).toBe("route-near");
  expect(mainline.traffic?.trainsPerYear).toBe(111_074);
});

test("rail without a route number takes a parallel segment; trams and already counted lines are left alone", () => {
  const unnumbered = rail("sfern", [], line([-500, 0], [500, 0]), ["1100", "1104"]);
  const tram = rail("tram", [], line([-500, 0], [500, 0]), ["1201"]);
  const counted = rail("counted", ["2600"], line([-500, 0], [500, 0]));
  counted.traffic = { trainsPerYear: 1, day: null, evening: null, night: null, routeNumbers: ["2600"], segmentId: "keep", year: 2020, source: "earlier" };
  const counts = [railCount("crossing", ["1234"], 10, line([0, -300], [0, 300])), railCount("along", ["1234"], 40_000, line([-200, 20], [200, 20]))];
  expect(matchRailCounts([unnumbered, tram, counted], counts, site)).toBe(1);
  expect(unnumbered.traffic?.segmentId).toBe("along");
  expect(tram.traffic).toBeUndefined();
  expect(counted.traffic.segmentId).toBe("keep");
});

// Trimmed from real responses (EBA app:Verkehrsweg at Köln Hbf, UBA haleconnect MajorRoadSource / MajorRailwaySource).
const eba = `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"><wfs:member>
<app:Verkehrsweg xmlns:app="http://www.deegree.org/app" gml:id="APP_VERKEHRSWEG_119">
<app:net_beginlifespanversion>2022-06-30T00:00:00Z</app:net_beginlifespanversion><app:uniquerail_id>DE_q_rl520643</app:uniquerail_id>
<app:str_liste>2608, 2616, 2630</app:str_liste><app:atf>     111.074</app:atf><app:length>224,92</app:length>
<app:zuganzahl_tag_vk1>      23.640</app:zuganzahl_tag_vk1><app:zuganzahl_abend_vk1>       5.271</app:zuganzahl_abend_vk1><app:zuganzahl_nacht_vk1>       3.680</app:zuganzahl_nacht_vk1><app:zuganzahl_gesamt_vk1>      32.591</app:zuganzahl_gesamt_vk1>
<app:zuganzahl_tag_vk4>          19</app:zuganzahl_tag_vk4><app:zuganzahl_abend_vk4>         251</app:zuganzahl_abend_vk4><app:zuganzahl_nacht_vk4>       1.655</app:zuganzahl_nacht_vk4><app:zuganzahl_gesamt_vk4>       1.925</app:zuganzahl_gesamt_vk4>
<app:summe_tag>      67.546</app:summe_tag><app:summe_abend>      20.175</app:summe_abend><app:summe_nacht>      23.353</app:summe_nacht><app:summe_gesamt>     111.074</app:summe_gesamt>
<app:geometrie_2d><gml:MultiCurve gml:id="g"><gml:curveMember><gml:LineString gml:id="l"><gml:posList>50.942698 6.958888 50.944045 6.957470</gml:posList></gml:LineString></gml:curveMember></gml:MultiCurve></app:geometrie_2d>
</app:Verkehrsweg></wfs:member></wfs:FeatureCollection>`;
const ubaRoads = `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:gpkg="http://www.esdi-humboldt.eu/hale/gpkg">
<wfs:member><gpkg:MajorRoadSource gml:id="F1"><roadId_identifier>RD_DE_ST_565023410</roadId_identifier><roadNationalCode></roadNationalCode><roadName_localName>Ernst-Reuter-Allee</roadName_localName><annualTrafficFlow>4535636</annualTrafficFlow>
<centrelineGeometry><gml:MultiCurve gml:id="g1"><gml:curveMember><gml:LineString gml:id="l1"><gml:posList>52.130120 11.639750 52.130310 11.638910</gml:posList></gml:LineString></gml:curveMember></gml:MultiCurve></centrelineGeometry></gpkg:MajorRoadSource></wfs:member>
<wfs:member><gpkg:MajorRoadSource gml:id="F2"><roadId_identifier>RD_X</roadId_identifier><roadNationalCode>B0056</roadNationalCode><annualTrafficFlow>3000300</annualTrafficFlow>
<centrelineGeometry><gml:MultiCurve gml:id="g2"><gml:curveMember><gml:LineString gml:id="l2"><gml:posList>52.1 11.6 52.2 11.7</gml:posList></gml:LineString></gml:curveMember></gml:MultiCurve></centrelineGeometry></gpkg:MajorRoadSource></wfs:member>
</wfs:FeatureCollection>`;
const ubaRail = `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:gpkg="http://www.esdi-humboldt.eu/hale/gpkg">
<wfs:member><gpkg:MajorRailwaySource gml:id="R1"><id>2247</id><geom><gml:MultiCurve gml:id="g"><gml:curveMember><gml:LineString gml:id="l"><gml:posList>51.470047 11.995980 51.469994 11.996051</gml:posList></gml:LineString></gml:curveMember></gml:MultiCurve></geom>
<railId_identifier>RL_DE_00_029210</railId_identifier><railNationalCode>6053,6403</railNationalCode><annualTrafficFlow>69599</annualTrafficFlow></gpkg:MajorRailwaySource></wfs:member></wfs:FeatureCollection>`;

test("parses EBA counts with German thousands separators, periods and raw vehicle categories", () => {
  expect(germanCount("     111.074")).toBe(111_074);
  expect(germanCount("224,92")).toBeNull();
  const [count] = ebaRailCounts(readGmlFeatures(eba, ["Verkehrsweg"]));
  expect(count!.routeNumbers).toEqual(["2608", "2616", "2630"]);
  expect(count!.parts[0]![0]).toEqual([6.958888, 50.942698]);
  expect(count!.traffic).toMatchObject({ trainsPerYear: 111_074, day: 67_546, evening: 20_175, night: 23_353, segmentId: "DE_q_rl520643", year: 2022, source: "EBA Lärmkartierung Runde 4 (2022)" });
  expect(count!.traffic.vehicleCategories).toEqual([{ label: "VK1", day: 23_640, evening: 5_271, night: 3_680, total: 32_591 }, { label: "VK4", day: 19, evening: 251, night: 1_655, total: 1_925 }]);
});

test("parses UBA road and rail sources; the threshold placeholder is not a count", () => {
  const roads = ubaRoadCounts(readGmlFeatures(ubaRoads, ["MajorRoadSource"]));
  expect(roads).toHaveLength(1);
  expect(roads[0]).toMatchObject({ id: "RD_DE_ST_565023410", annual: 4_535_636, name: "Ernst-Reuter-Allee" });
  const [railway] = ubaRailCounts(readGmlFeatures(ubaRail, ["MajorRailwaySource"]));
  expect(railway!.traffic).toMatchObject({ trainsPerYear: 69_599, day: null, routeNumbers: ["6053", "6403"], segmentId: "RL_DE_00_029210" });
});
