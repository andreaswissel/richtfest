import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { germanNumber, plainNumber, utmToLonLat } from "./traffic-count-files";
import { countSource, normaliseRoad } from "./traffic-count-sources";
import { parseSource } from "./traffic-count-worker";

// Fixtures are a few real rows cut from each published file (BASt CC BY 4.0, Straßen.NRW / LASuV dl-de/by-2-0, NLStBV).
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/traffic-counts", name));
const parse = (id: string, ...names: string[]) => {
  const source = countSource(id)!;
  return parseSource(source, names.map((name, i) => ({ url: source.files[i]!, bytes: fixture(name) })));
};
const noHourly = { day: null, night: null, heavyShareDay: null, heavyShareNight: null, p1Day: null, p2Day: null, p1Night: null, p2Night: null };

test("number and designation helpers keep German formats apart from machine numbers", () => {
  expect([germanNumber("69.950"), germanNumber("16,4"), germanNumber("575"), germanNumber(""), germanNumber("-")]).toEqual([69950, 16.4, 575, null, null]);
  // Spreadsheet values use a decimal point: "1.281" is 1.281 km, not 1281.
  expect([plainNumber("1.281"), plainNumber("1.6E-2"), plainNumber("*****"), plainNumber(" ")]).toEqual([1.281, 0.016, null, null]);
  expect(["L593", "B 4", "A  1", "B4a", "K5 (HS)", "K14 (WAF", "Hauptstraße", null].map(normaliseRoad)).toEqual(["L 593", "B 4", "A 1", "B 4a", "K 5", "K 14", null, null]);
  const [lon, lat] = utmToLonLat(32, 559965.464, 5945263.208);
  expect(lon).toBeCloseTo(9.90729, 4); expect(lat).toBeCloseTo(53.65269, 4);
});

test("BASt permanent stations: ISO-8859-15 CSV with German numbers, empty stations skipped", async () => {
  const { release, records, skipped } = await parse("bast-dz-2024", "bast-dz-2024.csv");
  expect(release).toBe("2024");
  expect(skipped).toBe(1); // station 2218 published no 2024 values
  expect(records.find(record => record.stationId === "6310")).toEqual({
    release: "2024", year: 2024, stationId: "6310", road: "B 521", roadClass: "B", name: "Bad Vilbel", sourceUrl: countSource("bast-dz-2024")!.files[0]!, kind: "station",
    geometry: { type: "Point", coordinates: [8.72957982, 50.16434712] }, dailyTraffic: 28387, heavyVehicles: 1029,
    hourly: { ...noHourly, day: 1610, night: 329, heavyShareDay: 3.6, heavyShareNight: 4.3 },
  });
  expect(records.find(record => record.stationId === "9539")).toMatchObject({ road: "A 9", name: "AS Allersberg (S)", dailyTraffic: 69950, heavyVehicles: 11477, hourly: { day: 3881, night: 982 } });
});

test("BASt SVZ 2021: the Zeilenformat sheet with RLS-19 groups, UTM 32 points, rows without coordinates skipped", async () => {
  const { release, records, skipped } = await parse("bast-svz-2021", "bast-svz-2021.xlsx");
  expect(release).toBe("2021");
  expect(skipped).toBe(1);
  expect(records).toHaveLength(2);
  const [first] = records;
  expect(first).toMatchObject({ stationId: "23250509", road: "B 4", name: "Grenze HH – Bönningstedt (K 5)", kind: "station", year: 2021, dailyTraffic: 9810, heavyVehicles: 212,
    hourly: { day: 575, night: 76, heavyShareDay: 2.1, heavyShareNight: 3, p1Day: 1.5, p2Day: 0.6, p1Night: 1.9, p2Night: 1.1 } });
  expect(first!.geometry).toEqual({ type: "Point", coordinates: [9.9072874, 53.6526889] });
});

test("state section Shapefiles: NW (windows-1252, district qualifiers), NI (UTF-8 .cpg), SN (UTM 33)", async () => {
  const nw = await parse("nw-verkehrswerte", "nw-verkehrswerte.zip");
  expect(nw.release).toBe("2026-03-31"); // network date; the values are SVZ 2021
  expect(nw.skipped).toBe(1);
  expect(nw.records.map(record => [record.stationId, record.road, record.name, record.dailyTraffic, record.heavyVehicles, record.year, record.kind])).toEqual([
    ["4907046O4907101O/47/0", "B 9", "Zählstelle 49072202 (Köln)", 8909, 484, 2021, "section"],
    ["4907046O4907101O/47/2325", "B 9", "Zählstelle 49072202 (Stadt Dormagen)", 8909, 484, 2021, "section"],
    ["4902034C4902026D/8,2/0", "K 5", "Zählstelle 49021411 (Stadt Heinsberg)", 14499, 679, 2021, "section"],
  ]);
  const first = nw.records[0]!.geometry;
  expect(first.type === "MultiLineString" && first.coordinates[0]![0]).toEqual([6.8657997, 51.067425]);

  const ni = await parse("ni-svz-2021", "ni-svz-2021.zip");
  // The same count point serves two roads; ids stay unique and stable by road.
  expect(ni.records.map(record => [record.stationId, record.road, record.dailyTraffic, record.heavyVehicles])).toEqual([
    ["A1:25263351", "A 1", 99994, 15845], ["A1:26250059", "A 1", 58235, 10161], ["A293:27150165", "A 293", 12863, 1797], ["B211:27150165", "B 211", 12863, 1797],
  ]);

  const sn = await parse("sn-svz-2021", "sn-svz-2021.zip");
  expect(sn.skipped).toBe(1);
  expect(sn.records[0]).toMatchObject({ stationId: "A13:4648014-4648102:0", road: "A 13", name: "Landesgrenze zu Brandenburg – (A13:19) AS Schönborn", dailyTraffic: 29548, heavyVehicles: 5281, year: 2021 });
  const sx = sn.records[0]!.geometry;
  expect(sx.type === "MultiLineString" && sx.coordinates[0]![0]).toEqual([13.7182791, 51.3313797]);
});

test("a source repeating a station is rejected", async () => {
  const source = countSource("bast-dz-2024")!;
  const twice = { ...source, parse: async function* () { const base = (await parseSource(source, [{ url: source.files[0]!, bytes: fixture("bast-dz-2024.csv") }])).records[0]!; yield base; yield base; } };
  await expect(parseSource(twice, [])).rejects.toThrow("Duplicate station id");
});
