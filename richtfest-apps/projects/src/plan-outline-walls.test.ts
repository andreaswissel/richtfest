import { expect, test } from "bun:test";
import { outlineWalls, wallPens } from "./plan-outline-walls";

const seg = (x0: number, y0: number, x1: number, y1: number, colour = "#494949") => ({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, colour });
const rect = (x: number, y: number, w: number, h: number, colour?: string) => [seg(x, y, x + w, y, colour), seg(x + w, y, x + w, y + h, colour), seg(x + w, y + h, x, y + h, colour), seg(x, y + h, x, y, colour)];

test("a plan drawn in outlines: the band between two rooms is a wall; a dimension strip and a stair-like room are not", () => {
  // Building 0.2–0.6 × 0.2–0.5 with a 0.01 thick outer wall, split by an inner wall at x 0.40–0.405.
  const segments = [
    ...rect(.2, .2, .4, .3), ...rect(.21, .21, .19, .28), ...rect(.405, .21, .185, .28),
    // A dimension strip below the building: two long lines closed at their ends, bordering no room.
    ...rect(.2, .55, .4, .008),
  ];
  const labels = [{ x: .3, y: .35, width: .02, height: .01 }, { x: .5, y: .35, width: .02, height: .01 }];
  const result = outlineWalls({ segments, aspect: 1, roomLabels: labels, resolution: 1000 });
  const inner = result.walls.filter(w => w.rect.x > .39 && w.rect.x < .41);
  expect(inner).toHaveLength(1);
  expect(inner[0]!.axis).toBe("vertical");
  // The wall includes its outline: about 0.005 + 2 px thick, the full clear height long.
  expect(inner[0]!.thickness).toBeCloseTo(.007, 2);
  expect(inner[0]!.length).toBeGreaterThan(.27);
  expect(result.walls.some(w => w.rect.y > .54)).toBe(false);
  // The outer ring splits into four runs; with the inner wall, five walls.
  expect(result.walls).toHaveLength(5);
});

test("the wall pen is the colour of the door swings, joined by a colour whose lines end on its lines", () => {
  const walls = Array.from({ length: 30 }, (_, i) => seg(.1, .1 + i * .01, .2, .1 + i * .01));
  const joining = Array.from({ length: 30 }, (_, i) => seg(.2, .1 + i * .01, .3, .1 + i * .01, "#000000"));
  const furniture = Array.from({ length: 30 }, (_, i) => seg(.5, .1 + i * .01, .6, .1 + i * .01, "#bfbfbf"));
  expect(wallPens([...walls, ...joining, ...furniture], ["#494949", "#494949", "#bfbfbf"])).toEqual(["#494949", "#000000"]);
  expect(wallPens(walls, [])).toEqual([]);
});
