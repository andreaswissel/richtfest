import { describe, expect, test } from "bun:test";
import type { AirborneInput, ImpactInput, InteriorElement, Point2, ProofValue } from "@richtfest/shared";
import { assembleInteriorSound, evaluateElement, type InteriorAssemblyInput } from "./interior-sound-proof";

const value = <T,>(v: T): ProofValue<T> => ({ value: v, reviewStatus: "unreviewed", provenance: "manual", propertyId: "p", version: 1, reviewRevision: 0 });
const rect = (x0: number, y0: number, x1: number, y1: number): Point2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const massive = (id: string, massKgM2: number, rwDb: number, componentType: "wall" | "ceiling" = "wall"): InteriorElement =>
  ({ id, name: id, componentType, construction: "masonry", massive: true, massKgM2, rwDb, dnfwDb: null, basis: null, reason: null });

// Two rooms side by side (A west, B east) across a 0.2 m separating wall, between a north and a south wall, under one ceiling.
const calls: { airborne: AirborneInput[]; impact: ImpactInput[] } = { airborne: [], impact: [] };
const input = (patch: Partial<InteriorAssemblyInput> = {}): InteriorAssemblyInput => ({
  storeyId: "s", clearHeight: 2.5, floorId: null,
  rooms: [
    { id: "A", name: "A", polygon: rect(0, 0, 4, 5), holes: [], adjacentWallIds: new Set(["W", "N", "S"]), ceilingIds: ["C"] },
    { id: "B", name: "B", polygon: rect(4.2, 0, 8, 5), holes: [], adjacentWallIds: new Set(["W", "N", "S"]), ceilingIds: ["C"] },
  ],
  walls: [
    { id: "W", name: "W", ring: rect(4, -0.3, 4.2, 5.3), role: "apartment_partition" },
    { id: "N", name: "N", ring: rect(-0.3, -0.3, 8.3, 0), role: "exterior" },
    { id: "S", name: "S", ring: rect(-0.3, 5, 8.3, 5.3), role: "exterior" },
  ],
  ceilings: [{ id: "C", name: "C", role: value("apartment_separating"), coversRoomIds: ["A", "B"],
    screed: { type: value("mortar"), mass: value(90), stiffness: value(20) } }],
  elements: new Map([["W", massive("W", 400, 55)], ["N", massive("N", 600, 60)], ["S", massive("S", 600, 60)], ["C", massive("C", 500, 58, "ceiling")]]),
  wallRequirement: () => ({ rwMinDb: 53, ref: "row 13" }),
  ceilingRequirement: () => ({ rwMinDb: 54, lnwMaxDb: 50, ref: "row 2" }),
  airborne: request => { calls.airborne.push(request); return { status: "unsupported", reason: "method_missing" }; },
  impact: request => { calls.impact.push(request); return { status: "unsupported", reason: "method_missing" }; },
  ...patch,
});

describe("interior sound assembly", () => {
  test("a separating wall pairs the rooms on its two sides and finds the flanking walls at both ends, the ceiling and the floor", () => {
    calls.airborne = [];
    const { walls, floorAssumed } = assembleInteriorSound(input());
    expect(walls).toHaveLength(1);
    const check = walls[0]!;
    expect(new Set(check.rooms.map(room => room.id))).toEqual(new Set(["A", "B"]));
    expect([check.lengthM, check.areaM2, check.gaps]).toEqual([5, 12.5, []]);
    expect(check.edges.map(edge => [edge.edge, edge.source, edge.receiving])).toEqual([["start", "N", "N"], ["end", "S", "S"], ["top", "C", "C"], ["bottom", "C", "C"]]);
    // Without a slab under the storey, the floor is taken to equal the ceiling.
    expect(floorAssumed).toBe(true);
    const request = calls.airborne[0]!;
    expect(request.separatingAreaM2).toBeCloseTo(12.5, 9);
    expect(request.transmission).toBe("horizontal");
    const north = request.edges.find(edge => edge.edge === "start")!;
    expect(north.couplingLengthM).toBe(2.5);
    // Each side's flanking area is that wall's extent along the room times the clear height: 4 m and 3.8 m.
    const areas = [north.source, north.receiving].map(item => item.kind === "massive" ? item.areaM2 : 0).sort((x, y) => x - y);
    expect(areas[0]).toBeCloseTo(9.5, 9);
    expect(areas[1]).toBeCloseTo(10, 9);
    expect(request.edges.find(edge => edge.edge === "top")!.couplingLengthM).toBeCloseTo(5, 9);
  });

  test("an L-shaped room on one side is placed by probing beside the wall, not by its centroid", () => {
    // Room A becomes an L whose vertex centroid lies east of the wall, while it touches the wall only from the west.
    const lShape: Point2[] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 12], [12, 12], [12, 13], [0, 13]];
    const { walls } = assembleInteriorSound(input({ rooms: [{ ...input().rooms[0]!, polygon: lShape }, input().rooms[1]!] }));
    expect(walls).toHaveLength(1);
    expect(walls[0]!.lengthM).toBeCloseTo(1, 1);
  });

  test("missing inputs are gaps, not guesses: lightweight separating wall, missing flanking wall, unknown screed", () => {
    const elements = new Map(input().elements);
    elements.set("W", { ...massive("W", 0, 0), massive: false, construction: "drywall", massKgM2: null, rwDb: null });
    const light = assembleInteriorSound(input({ elements })).walls[0]!;
    expect(light.gaps).toContainEqual({ code: "element", elementId: "W", elementName: "W", reason: "lightweight_separating" });
    expect(light.result).toBeNull();
    const rooms = input().rooms.map(room => ({ ...room, adjacentWallIds: new Set(["W", "N"]) }));
    expect(assembleInteriorSound(input({ rooms })).walls[0]!.gaps).toContainEqual({ code: "flanking_missing", edge: "end" });
    const noScreed = assembleInteriorSound(input({ ceilings: [{ ...input().ceilings[0]!, screed: { type: value("mortar"), mass: null, stiffness: null } }] }));
    expect(noScreed.ceilings[0]!.gaps).toEqual([{ code: "screed" }]);
    expect(noScreed.ceilings[0]!.impact).toBeNull();
  });

  test("a ceiling is checked into each room below with the room's walls as flanking elements; internal ceilings are not checked", () => {
    calls.airborne = []; calls.impact = [];
    const { ceilings } = assembleInteriorSound(input());
    expect(ceilings.map(check => check.room.id)).toEqual(["A", "B"]);
    const vertical = calls.airborne.filter(request => request.transmission === "vertical");
    expect(vertical[0]!.separatingAreaM2).toBe(20);
    // Room A: W along 5 m, N and S along 4 m each.
    expect(vertical[0]!.edges.map(edge => [edge.edge, Math.round(edge.couplingLengthM * 100) / 100])).toEqual([["W", 5], ["N", 4], ["S", 4]]);
    expect(calls.impact[0]).toMatchObject({ slabMassKgM2: 500, screed: { type: "mortar", massKgM2: 90, stiffnessMNm3: 20 }, flankingMassesKgM2: [400, 600, 600], maxDb: 50 });
    expect(assembleInteriorSound(input({ ceilings: [{ ...input().ceilings[0]!, role: value("internal") }] })).ceilings).toEqual([]);
  });
});

describe("element catalogue values", () => {
  test("lightweight walls need their Dn,f,w; massive ones their material", () => {
    const rw = () => ({ status: "calculated" as const, rwDb: 55, massKgM2: 400, wallDensityKgM3: 1700, refs: ["x"], edition: "e", assumptions: [] });
    expect(evaluateElement("g", "g", "wall", { construction: "drywall", material: null, thickness: 10, bulkDensity: null, flankingLevelDifference: null }, rw).reason).toBe("flanking_level_difference_missing");
    expect(evaluateElement("g", "g", "wall", { construction: "drywall", material: null, thickness: 10, bulkDensity: null, flankingLevelDifference: 62 }, rw)).toMatchObject({ massive: false, dnfwDb: 62, reason: null });
    expect(evaluateElement("k", "k", "wall", { construction: null, material: null, thickness: 24, bulkDensity: 1800, flankingLevelDifference: null }, rw).reason).toBe("construction_missing");
    expect(evaluateElement("k", "k", "wall", { construction: "masonry", material: "Kalksandstein", thickness: 24, bulkDensity: 1800, flankingLevelDifference: null }, rw)).toMatchObject({ massKgM2: 400, rwDb: 55, reason: null });
  });
});
