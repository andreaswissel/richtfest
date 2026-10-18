import { describe, expect, test } from "bun:test";
import type { LocationContext, LocationScene } from "./location";
import { siteDxf, siteDxfBytes, siteExportFeatures, siteGeoJson } from "./site-export";
import { toUtm } from "./site-plan";

const context: LocationContext = {
  siteId: "berlin-address:1", address: "Giersstraße 20, 14193 Berlin", crs: "EPSG:25833", origin: [384000, 5818000], longitude: 13.27, latitude: 52.49, radius: 100,
  buildings: [{ id: "b1", sourceId: "b1", label: "Giersstraße 22", height: 12.5, roof: null, polygons: [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]] }],
  trees: [{ id: "t1", sourceId: "t1", position: [5, -20], height: 15, crownDiameter: 8, species: "Linde" }],
  sources: [], importedAt: "2026-10-18T10:00:00Z",
};
const scene: LocationScene = { planningNotes: "", objects: [
  { id: "m1", kind: "mass", label: "Neubau", position: [20, 0, 0], size: [10, 15, 4], rotation: 90, note: "" },
  { id: "n1", kind: "note", label: "Zufahrt", position: [0, 0, 0], size: [1, 1, 1], rotation: 0, note: "" },
] };

describe("site export", () => {
  test("maps local scene metres to the UTM grid (Z points south)", () => {
    const features = siteExportFeatures(context, scene);
    expect(features.find(feature => feature.layer === "address")).toMatchObject({ position: [384000, 5818000] });
    expect(features.find(feature => feature.layer === "trees")).toMatchObject({ position: [384005, 5818020] });
    const building = features.find(feature => feature.layer === "buildings");
    expect(building && building.layer === "buildings" && building.polygons[0]![0]![2]).toEqual([384010, 5817990]);
  });

  test("rotates planning masses like the editor and skips notes", () => {
    const planning = siteExportFeatures(context, scene).filter(feature => feature.layer === "planning");
    expect(planning).toHaveLength(1);
    // A 10 m × 4 m mass turned by 90° spans 4 m east-west and 10 m north-south.
    const ring = planning[0]!.layer === "planning" ? planning[0]!.ring : [];
    expect(ring[0]).toEqual([384018, 5817995]);
    const xs = ring.map(point => point[0]), ys = ring.map(point => point[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 6);
  });

  test("writes RFC 7946 GeoJSON and layered UTF-8 DXF 2007", () => {
    const geojson = JSON.parse(siteGeoJson(context, scene));
    expect(geojson.crs).toBeUndefined();
    expect(geojson.metadata.sourceCrs).toBe("EPSG:25833");
    expect(geojson.features.map((feature: any) => feature.properties.layer)).toEqual(["address", "buildings", "trees", "planning"]);
    const dxf = siteDxf(context, scene);
    expect(dxf).toContain("AC1021");
    for (const layer of ["RF_GEBAEUDE", "RF_BAEUME", "RF_PLANUNG", "RF_ADRESSE"]) expect(dxf).toContain(layer);
    expect(dxf).toContain("Giersstraße 22 · 12,5 m");
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
  });

  for (const zone of [32, 33] as const) {
    test(`exports zone ${zone} as WGS84 lon/lat but keeps horizontal UTM DXF`, () => {
      const longitude = zone === 32 ? 7.6 : 13.27, latitude = zone === 32 ? 50.35 : 52.49;
      const origin = toUtm(longitude, latitude, zone);
      const input = { ...context, crs: `EPSG:258${zone}` as LocationContext["crs"], origin };
      const json = JSON.parse(siteGeoJson(input, scene));
      expect(json.metadata.sourceCrs).toBe(`EPSG:258${zone}`);
      expect(json.metadata.sourceOrigin).toEqual(origin);
      const address = json.features[0].geometry.coordinates;
      expect(address[0]).toBeCloseTo(longitude, 7);
      expect(address[1]).toBeCloseTo(latitude, 7);
      const projected = siteExportFeatures(input, scene);
      for (let i = 0; i < projected.length; i++) {
        const feature = projected[i]!;
        const geometry = json.features[i].geometry;
        const positions: number[][] = geometry.type === "Point" ? [geometry.coordinates] : geometry.coordinates.flat(geometry.type === "MultiPolygon" ? 2 : 1);
        const expected = feature.layer === "buildings" ? feature.polygons.flat(2) : feature.layer === "planning" ? feature.ring : [feature.position];
        for (const position of positions) {
          expect(position).toHaveLength(2);
          const p = toUtm(position[0]!, position[1]!, zone);
          expect(expected.some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.002)).toBe(true);
        }
      }
      const dxf = new TextDecoder("utf-8", { fatal: true }).decode(siteDxfBytes(input, scene));
      expect(dxf).toContain(`10\r\n${Math.round(origin[0] * 1000) / 1000}\r\n20\r\n${Math.round(origin[1] * 1000) / 1000}`);
      const lines = dxf.trimEnd().split("\r\n");
      for (let i = 0; i < lines.length; i += 2) if (["30", "38"].includes(lines[i]!)) expect(lines[i + 1]).toBe("0");
    });
  }

  test("final download bytes preserve Unicode and cannot inject DXF groups or text escapes", () => {
    const label = "Č Ċ € Straße 東京 🏗 \\U+000A\r\n0\nLINE\u0000\u0085";
    const input = { ...context, address: label };
    const bytes = siteDxfBytes(input, scene);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(decoded).toContain("Č Ċ € Straße 東京 🏗 \\U+005CU+000A  0 LINE  ");
    expect(Buffer.from(bytes).includes(Buffer.from("Ċ €", "utf8"))).toBe(true);
    const lines = decoded.trimEnd().split("\r\n");
    expect(lines.length % 2).toBe(0);
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]).toMatch(/^\d+$/);
      expect(lines[i + 1]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      if (lines[i] === "0") expect(lines[i + 1]).not.toBe("LINE");
    }
    const entities = (text: string) => text.match(/\r\n0\r\n/g)?.length;
    expect(entities(decoded)).toBe(entities(siteDxf(context, scene)));
  });

  test("GeoJSON retains holes with RFC 7946 exterior/interior winding", () => {
    const building = context.buildings[0]!;
    const hole: [number, number][] = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
    const input = { ...context, buildings: [{ ...building, polygons: [[building.polygons[0]![0]!, hole]] }] };
    const rings: number[][][] = JSON.parse(siteGeoJson(input, null)).features[1].geometry.coordinates[0];
    expect(rings).toHaveLength(2);
    const area = (ring: number[][]) => ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      return sum + p[0]! * q[1]! - q[0]! * p[1]!;
    }, 0);
    expect(area(rings[0]!)).toBeGreaterThan(0);
    expect(area(rings[1]!)).toBeLessThan(0);
    for (const ring of rings) expect(ring[0]!).toEqual(ring.at(-1)!);
  });
});
