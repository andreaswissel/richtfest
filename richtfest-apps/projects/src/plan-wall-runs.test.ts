import { expect, test } from "bun:test";
import { wallRuns } from "./plan-wall-runs";

const ring = (points: Array<[number, number]>) => points.map(([x, y]) => ({ x, y }));
const rounded = (runs: ReturnType<typeof wallRuns>) => runs!.runs.map(run => ({ axis: run.axis,
  rect: Object.fromEntries(Object.entries(run.rect).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) }))
  .sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);

test("an L-shaped fill splits into two runs that meet at the corner, the longer one keeping it", () => {
  // Horizontal arm 0.5 long, vertical arm 0.3 long, both 0.02 thick; corner at the top left.
  const runs = wallRuns([ring([[0, 0], [0.5, 0], [0.5, 0.02], [0.02, 0.02], [0.02, 0.3], [0, 0.3]])], 1, 0.03);
  expect(rounded(runs)).toEqual([
    { axis: "horizontal", rect: { x: 0, y: 0, width: 0.5, height: 0.02 } },
    { axis: "vertical", rect: { x: 0, y: 0.02, width: 0.02, height: 0.28 } },
  ]);
  expect(runs!.leftover).toBe(0);
});

test("a T junction keeps the through wall whole; a thick block and oblique edges are not split", () => {
  const t = wallRuns([ring([[0, 0], [0.6, 0], [0.6, 0.02], [0.31, 0.02], [0.31, 0.4], [0.29, 0.4], [0.29, 0.02], [0, 0.02]])], 1, 0.03);
  expect(rounded(t)).toEqual([
    { axis: "horizontal", rect: { x: 0, y: 0, width: 0.6, height: 0.02 } },
    { axis: "vertical", rect: { x: 0.29, y: 0.02, width: 0.02, height: 0.38 } },
  ]);
  // A wall ending in a column thicker than any wall: the column is left over.
  const column = wallRuns([ring([[0, 0], [0.4, 0], [0.4, -0.02], [0.46, -0.02], [0.46, 0.04], [0.4, 0.04], [0.4, 0.02], [0, 0.02]])], 1, 0.03);
  expect(rounded(column)).toEqual([{ axis: "horizontal", rect: { x: 0, y: 0, width: 0.4, height: 0.02 } }]);
  expect(column!.leftover).toBeGreaterThan(0);
  expect(wallRuns([ring([[0, 0], [0.5, 0.1], [0.5, 0.12], [0, 0.02]])], 1, 0.03)).toBeNull();
});

test("lengths and thicknesses are physical on a wide page", () => {
  // Page twice as wide as high: a fill 0.1 wide and 0.02 high is 0.2 long and 0.02 thick.
  const runs = wallRuns([ring([[0, 0], [0.1, 0], [0.1, 0.02], [0, 0.02]])], 2, 0.03)!;
  expect(runs.runs).toHaveLength(1);
  expect(runs.runs[0]!.length).toBeCloseTo(0.2);
  expect(runs.runs[0]!.thickness).toBeCloseTo(0.02);
});
