import { describe, expect, test } from "bun:test";
import { aerialSourceFor, alignPlanOutline, compassOf, facadeDistances, planToSite, shiftedPlacement, simplifyPolyline, siteToPlan, twoPointPlacement, type Point2 } from "./site-plan";

const close = (actual: Point2, expected: Point2) => {
  expect(actual[0]).toBeCloseTo(expected[0], 6);
  expect(actual[1]).toBeCloseTo(expected[1], 6);
};

describe("two-point plan placement", () => {
  test("turns a plan edge running right onto a site edge running north", () => {
    const placement = twoPointPlacement([[0, 0], [10, 0]], [[1000, 2000], [1000, 2010]])!;
    expect(placement.degrees).toBeCloseTo(90, 6);
    expect(placement.scaleRatio).toBeCloseTo(1, 6);
    close(planToSite([0, 0], placement), [1000, 2000]);
    close(planToSite([10, 0], placement), [1000, 2010]);
    // 5 m down the page is south on an unrotated plan; turned 90° counter-clockwise it is east.
    close(planToSite([0, 5], placement), [1005, 2000]);
    close(siteToPlan([1005, 2000], placement), [0, 5]);
  });

  test("keeps the printed scale and centres a length mismatch on the pair midpoints", () => {
    const placement = twoPointPlacement([[0, 0], [10, 0]], [[1000, 2000], [1000, 2010.2]])!;
    expect(placement.scaleRatio).toBeCloseTo(1.02, 6);
    close(planToSite([5, 0], placement), [1000, 2005.1]);
    close(planToSite([10, 0], placement), [1000, 2010.1]);
  });

  test("refuses coincident picks", () => {
    expect(twoPointPlacement([[0, 0], [0.1, 0]], [[0, 0], [10, 0]])).toBeNull();
  });
});

describe("facade distances", () => {
  // A 10 × 10 m building in a north-up frame with 30 cm walls.
  const walls = [
    { id: "south", ring: [[0, 0], [10, 0], [10, 0.3], [0, 0.3]] as Point2[] },
    { id: "north", ring: [[0, 9.7], [10, 9.7], [10, 10], [0, 10]] as Point2[] },
    { id: "west", ring: [[0, 0], [0.3, 0], [0.3, 10], [0, 10]] as Point2[] },
    { id: "east", ring: [[9.7, 0], [10, 0], [10, 10], [9.7, 10]] as Point2[] },
  ];

  test("measures from the outer face of the nearest wall and names its facade", () => {
    const [road] = facadeDistances(walls, [{ id: "road", parts: [[[-50, -20], [50, -20]]] }]);
    expect(road!.distance).toBe(20);
    expect(road!.wallId).toBe("south");
    expect(road!.facade).toBe("S");
    expect(road!.from[1]).toBeCloseTo(0, 6);
    expect(road!.to[1]).toBeCloseTo(-20, 6);
  });

  test("uses the nearest part of a multi-part axis and reports a crossing as zero", () => {
    const [rail] = facadeDistances(walls, [{ id: "rail", parts: [[[100, 100], [200, 100]], [[25, -40], [25, 40]]] }]);
    expect(rail!.distance).toBe(15);
    expect(rail!.facade).toBe("E");
    const [crossing] = facadeDistances(walls, [{ id: "path", parts: [[[5, -5], [5, 5]]] }]);
    expect(crossing!.distance).toBe(0);
  });
});

test("compass sectors and polyline simplification", () => {
  expect(compassOf([1, 1])).toBe("NE");
  expect(compassOf([0, -1])).toBe("S");
  expect(compassOf([-1, 0.1])).toBe("W");
  expect(simplifyPolyline<Point2>([[0, 0], [1, 0.05], [2, 0], [3, 5]], 0.5)).toEqual([[0, 0], [2, 0], [3, 5]]);
});

test("aerial imagery only for registers with an open orthophoto service in the site's CRS", () => {
  expect(aerialSourceFor({ siteId: "rlp-address:1", crs: "EPSG:25832" })?.id).toBe("rlp-dop20");
  expect(aerialSourceFor({ siteId: "rlp-address:1", crs: "EPSG:25833" })).toBeNull();
  expect(aerialSourceFor({ siteId: "berlin-address:1" })?.id).toBe("berlin-truedop");
  expect(aerialSourceFor({ siteId: "he-hako:1", crs: "EPSG:25832" })).toBeNull();
});

describe("aligning storey plans by their outline", () => {
  // Exterior walls as 0.3 m bands around a 10 × 8 m outline starting at (x, y).
  const walls = (x: number, y: number, w: number, h: number): Point2[][] => [
    [[x, y], [x + w, y], [x + w, y + 0.3], [x, y + 0.3]], [[x, y + h - 0.3], [x + w, y + h - 0.3], [x + w, y + h], [x, y + h]],
    [[x, y], [x + 0.3, y], [x + 0.3, y + h], [x, y + h]], [[x + w - 0.3, y], [x + w, y], [x + w, y + h], [x + w - 0.3, y + h]],
  ];
  test("the same outline drawn elsewhere on its sheet aligns with its offset and a near-zero fit", () => {
    const aligned = alignPlanOutline(walls(2, 3, 10, 8), walls(7.5, 1, 10, 8))!;
    expect(aligned.offset[0]).toBeCloseTo(-5.5, 9);
    expect(aligned.offset[1]).toBeCloseTo(2, 9);
    expect(aligned.fitM).toBeCloseTo(0, 9);
    // A point on the other page maps to the same site point as its aligned point on the placed page.
    const placement = { origin: [500000, 5800000] as Point2, degrees: 30 };
    const shifted = shiftedPlacement(placement, aligned.offset);
    const [a, b] = [planToSite([7.5, 1], shifted), planToSite([2, 3], placement)];
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
  });
  test("a set-back upper storey aligns at a shared corner; a different building does not fit", () => {
    // Upper storey 10 × 6 m flush with the south-west corner (minimum x and y) of the 10 × 8 m storey below.
    const upper = alignPlanOutline(walls(0, 0, 10, 8), walls(4, 4, 10, 6))!;
    expect(upper.offset[0]).toBeCloseTo(-4, 9);
    expect(upper.offset[1]).toBeCloseTo(-4, 9);
    expect(upper.fitM).toBeLessThan(0.3);
    expect(alignPlanOutline(walls(0, 0, 10, 8), walls(0, 0, 25, 4))!.fitM).toBeGreaterThan(0.3);
  });
});
