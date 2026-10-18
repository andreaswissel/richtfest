import { describe, expect, test } from "bun:test";
import type { LocationContext, LocationScene } from "./location";
import { siteDxf, siteExportFeatures, siteGeoJson } from "./site-export";

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
    const xs = ring.map(point => point[0]), ys = ring.map(point => point[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 6);
  });

  test("writes a named-CRS GeoJSON and a layered DXF R12", () => {
    const geojson = JSON.parse(siteGeoJson(context, scene));
    expect(geojson.crs.properties.name).toBe("urn:ogc:def:crs:EPSG::25833");
    expect(geojson.features.map((feature: any) => feature.properties.layer)).toEqual(["address", "buildings", "trees", "planning"]);
    const dxf = siteDxf(context, scene);
    expect(dxf).toContain("AC1009");
    for (const layer of ["RF_GEBAEUDE", "RF_BAEUME", "RF_PLANUNG", "RF_ADRESSE"]) expect(dxf).toContain(layer);
    expect(dxf).toContain("Giersstraße 22 · 12,5 m");
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
  });
});
