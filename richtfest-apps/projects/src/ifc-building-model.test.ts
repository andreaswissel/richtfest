import { expect, test } from "bun:test";
import { extractIfcBuildingModel } from "./ifc-building-model";
import { geometryArea } from "@richtfest/shared/site-geometry";

test("IFC import preserves rotated nested placements, millimetre conversion, holes and composed walls", async () => {
  const bytes = new Uint8Array(await Bun.file(new URL("./fixtures/building-model.ifc", import.meta.url)).arrayBuffer());
  const model = await extractIfcBuildingModel(bytes);
  expect(model.entities.filter(e => e.entityType === "storey").map(e => e.expressId)).toEqual([20, 25]);
  const room = model.entities.find(e => e.expressId === 30)!;
  expect(room).toMatchObject({ buildingExpressId: 10, storeyExpressId: 20, globalId: "room" });
  const geometry = room.geometry!;
  expect(geometry.coordinateSpace).toBe("ifc-metre");
  expect(geometry.footprint[0]).toHaveLength(2);
  expect(geometryArea(geometry.footprint)).toBeCloseTo(7.5, 5);
  const points = geometry.footprint.flat(2);
  expect(Math.min(...points.map(p => p[0]))).toBeCloseTo(6.4, 5);
  expect(Math.max(...points.map(p => p[0]))).toBeCloseTo(8.4, 5);
  expect(Math.min(...points.map(p => p[1]))).toBeCloseTo(19.5, 5);
  expect(Math.max(...points.map(p => p[1]))).toBeCloseTo(23.5, 5);
  expect(geometry.elevationRange[0]).toBeCloseTo(3, 5);
  expect(geometry.elevationRange[1]).toBeCloseTo(5.8, 5);
  const wall = model.entities.find(e => e.expressId === 60)!;
  expect(wall.geometry?.composedFromExpressIds).toEqual([61]);
  expect(wall.geometry?.footprint).toEqual(geometry.footprint);
  expect(model.warnings.some(w => w.code === "missingGeometry")).toBe(false);
  expect(await extractIfcBuildingModel(bytes)).toEqual(model);
  // A space assigned to two storeys must not be silently placed in whichever was read last.
  const ambiguous = new TextDecoder().decode(bytes).replace("ENDSEC;\nEND-ISO", "#75=IFCRELAGGREGATES('ambiguous',$,$,$,#25,(#30));\nENDSEC;\nEND-ISO");
  const result = await extractIfcBuildingModel(new TextEncoder().encode(ambiguous));
  expect(result.entities.some(e => e.expressId === 30)).toBe(false);
  expect(result.warnings).toContainEqual({ code: "unmapped", count: 1 });
  await expect(extractIfcBuildingModel(new TextEncoder().encode("not IFC"))).rejects.toThrow();
});
