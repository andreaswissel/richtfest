import { expect, test } from "bun:test";
import type { LocationBuilding, LocationTree } from "@richtfest/shared";
import { CanopyGrid, detectTrees, withoutCadastreDuplicates } from "./location-trees";

let seed = 42;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const GROUND = 40;
/** Leaf-off crown: returns scattered between crown base and a domed top, like branches. */
function tree(grid: CanopyGrid, cx: number, cz: number, height: number, radius: number) {
  for (let k = 0; k < Math.round(radius * radius * 40); k++) {
    const a = random() * 2 * Math.PI, d = Math.sqrt(random()) * radius, x = cx + d * Math.cos(a), z = cz + d * Math.sin(a);
    const top = height * (1 - 0.35 * (d / radius) ** 2), base = height * 0.4;
    grid.add(x, z, GROUND + (random() < 0.4 ? top - random() * 0.3 : base + random() * (top - base)), 5);
  }
}
function slab(grid: CanopyGrid, x0: number, x1: number, z0: number, z1: number, height: number) {
  for (let x = x0; x < x1; x += 0.3) for (let z = z0; z < z1; z += 0.3) grid.add(x, z, GROUND + height + random() * 0.05, 5);
}

test("detects private trees beside buildings, skips roofs, flat structures and cadastre duplicates", () => {
  const grid = new CanopyGrid(40);
  const building: LocationBuilding = { id: "b", sourceId: "b", label: "House", roof: null, height: 10, polygons: [[[[5, -5], [15, -5], [15, 5], [5, 5], [5, -5]]]] };
  for (let x = -39.5; x < 40; x += 0.7) for (let z = -39.5; z < 40; z += 0.7) {
    const underRoof = x >= 5 && x <= 15 && z >= -5 && z <= 5;
    if (!underRoof && x * x + z * z < 40 * 40) grid.add(x, z, GROUND + random() * 0.1, 2);
  }
  // Mapped house roof (Berlin ALS labels roofs class 5) and an unmapped flat garage roof.
  slab(grid, 5, 15, -5, 5, 10);
  slab(grid, -2, 4, 20, 25, 3);
  // Private garden tree 2 m east of the house wall: must survive the footprint mask.
  tree(grid, 20, 0, 12, 3.5);
  // Tree under an official cadastre point: must be deduplicated.
  tree(grid, -20, 10, 15, 4);
  // Smaller garden tree in the south-west.
  tree(grid, -10, -25, 8, 2.5);
  const cadastre: LocationTree[] = [{ id: "c", sourceId: "c", position: [-19.2, 10.6], height: 14, crownDiameter: 7, species: "Linde" }];
  const detected = detectTrees(grid, { buildings: [building], trees: cadastre });
  expect(detected).toHaveLength(2);
  const [tall, small] = detected;
  expect(tall!.provenance).toBe("lidar-detected");
  expect(Math.hypot(tall!.position[0] - 20, tall!.position[1])).toBeLessThan(1.5);
  expect(tall!.height!).toBeGreaterThan(10.5); expect(tall!.height!).toBeLessThan(12.5);
  expect(tall!.crownDiameter!).toBeGreaterThan(6); expect(tall!.crownDiameter!).toBeLessThan(8);
  expect(Math.hypot(small!.position[0] + 10, small!.position[1] + 25)).toBeLessThan(1.5);
  expect(small!.height!).toBeGreaterThan(6.5); expect(small!.height!).toBeLessThan(8.5);
  expect(small!.crownDiameter!).toBeGreaterThan(4); expect(small!.crownDiameter!).toBeLessThan(6);
  for (const item of detected) expect(item.species).toBe("");
  // Without the cadastre point the third tree is found too; a later cadastre refresh removes it again.
  const all = detectTrees(grid, { buildings: [building], trees: [] });
  expect(all).toHaveLength(3);
  const refreshed = withoutCadastreDuplicates({ method: "m", sourceUrl: "u", surveyedAt: "s", detectedAt: "d", trees: all }, cadastre);
  expect(refreshed.trees.map(t => t.id)).toEqual(detected.map(t => t.id));
  // Without the footprint the house roof is still not a tree: it is flat.
  expect(detectTrees(grid, { buildings: [], trees: cadastre })).toHaveLength(2);
});
