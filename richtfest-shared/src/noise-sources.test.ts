import { expect, test } from "bun:test";
import { mappedRailSchema, railTrafficSummary, suggestNoiseSources } from "./noise-sources";

test("rail traffic summary states periods, routes and raw source categories", () => {
  const traffic = { trainsPerYear: 111_074, day: 67_546, evening: 20_175, night: 23_353, vehicleCategories: [{ label: "VK1", day: 23_640, evening: 5_271, night: 3_680, total: 32_591 }, { label: "VK3", day: 0, evening: 0, night: 0, total: 0 }],
    routeNumbers: ["2608", "2616"], segmentId: "DE_q_rl520643", year: 2022, source: "EBA Lärmkartierung Runde 4 (2022)" };
  expect(mappedRailSchema.shape.traffic.parse(traffic)).toEqual(traffic);
  expect(railTrafficSummary(traffic)).toBe("EBA Lärmkartierung Runde 4 (2022), routes 2608, 2616, segment DE_q_rl520643. 111,074 trains per year (about 304 per 24 h). Per year: day 06–18 h 67,546, evening 18–22 h 20,175, night 22–06 h 23,353. By source vehicle category per year: VK1 32,591 (night 3,680). Categories are the source's labels, not Schall 03 train types.");
  expect(railTrafficSummary({ ...traffic, day: null, evening: null, night: null, vehicleCategories: undefined, segmentId: null, routeNumbers: [], source: "UBA Lärmkartierung 2022 (Züge/Jahr)" }))
    .toBe("UBA Lärmkartierung 2022 (Züge/Jahr). 111,074 trains per year (about 304 per 24 h).");
});

test("suggests mapped sources within their class screening radius", () => {
  const road = (ref: string, dedication: string | null, lanes: number | null = 2) => ({ kind: "road" as const, ref, name: ref, dedication, designation: null, lanes, carriagewayWidthM: null, distanceMeters: null, segments: 1 });
  const rail = (ref: string, categories: string[]) => ({ kind: "rail" as const, ref, name: ref, categories, routeNumbers: [], lines: [], tracks: null, electrified: null, distanceMeters: null, segments: 1 });
  const distances: Record<string, number> = { municipalNear: 90, municipalFar: 120, wideMunicipal: 250, state: 290, motorway: 900, private: 5, mainline: 800, tram: 400 };
  const items = [road("municipalNear", "1307"), road("municipalFar", "1307"), road("wideMunicipal", "1307", 4), road("state", "1305"), road("motorway", "1301"), road("private", "9997"), rail("mainline", ["1101"]), rail("tram", ["1201"])];
  const suggested = suggestNoiseSources(items, item => distances[item.ref]!).map(s => s.item.ref);
  expect(suggested).toEqual(["municipalNear", "wideMunicipal", "state", "mainline", "motorway"]);
});
