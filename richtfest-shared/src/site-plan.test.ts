import { describe, expect, test } from "bun:test";
import { compassOf, facadeDistances, planToSite, simplifyPolyline, siteToPlan, twoPointPlacement, type Point2 } from "./site-plan";

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
