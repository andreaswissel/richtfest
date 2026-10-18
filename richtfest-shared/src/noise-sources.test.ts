import { expect, test } from "bun:test";
import { suggestNoiseSources } from "./noise-sources";

test("suggests mapped sources within their class screening radius", () => {
  const road = (ref: string, dedication: string | null, lanes: number | null = 2) => ({ kind: "road" as const, ref, name: ref, dedication, designation: null, lanes, carriagewayWidthM: null, distanceMeters: null, segments: 1 });
  const rail = (ref: string, categories: string[]) => ({ kind: "rail" as const, ref, name: ref, categories, routeNumbers: [], lines: [], tracks: null, electrified: null, distanceMeters: null, segments: 1 });
  const distances: Record<string, number> = { municipalNear: 90, municipalFar: 120, wideMunicipal: 250, state: 290, motorway: 900, private: 5, mainline: 800, tram: 400 };
  const items = [road("municipalNear", "1307"), road("municipalFar", "1307"), road("wideMunicipal", "1307", 4), road("state", "1305"), road("motorway", "1301"), road("private", "9997"), rail("mainline", ["1101"]), rail("tram", ["1201"])];
  const suggested = suggestNoiseSources(items, item => distances[item.ref]!).map(s => s.item.ref);
  expect(suggested).toEqual(["municipalNear", "wideMunicipal", "state", "mainline", "motorway"]);
});
