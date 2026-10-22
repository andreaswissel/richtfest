import { describe, expect, test } from "bun:test";
import type { AirborneInput, AirborneResult, ImpactInput, InteriorElement, Point2, ProofValue, ServiceInput } from "@richtfest/shared";
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
  test("unequal or unconfirmed room heights leave height-dependent checks incomplete instead of using the storey height", () => {
    for (const height of [3.2, null]) {
      const rooms = input().rooms.map((room, index) => ({ ...room, clearHeight: index === 0 ? height : 2.5 }));
      const result = assembleInteriorSound(input({ rooms }));
      expect(result.walls[0]!.areaM2).toBeNull();
      expect(result.walls[0]!.gaps).toContainEqual({ code: "clear_height" });
      expect(result.walls[0]!.result).toBeNull();
    }
    const rooms = input().rooms.map(room => ({ ...room, clearHeight: 3.2 }));
    expect(assembleInteriorSound(input({ rooms })).walls[0]!.areaM2).toBe(16);
  });

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

  test("above the ceiling, the walls of the storey above standing on the walls below are the source-side flanking elements", () => {
    calls.airborne = [];
    const elements = new Map(input().elements);
    elements.set("N2", massive("N2", 300, 50));
    // Upper storey: a lighter north wall 5 cm off the one below, and the west wall W again; no south wall above.
    const wallsAbove = [{ id: "N2", name: "N2", ring: rect(-0.3, -0.25, 8.3, 0.05) }, { id: "W2", name: "W2", ring: rect(4, -0.3, 4.2, 5.3) }];
    elements.set("W2", massive("W2", 400, 55));
    const result = assembleInteriorSound(input({ elements, wallsAbove }));
    const roomA = calls.airborne.filter(request => request.transmission === "vertical")[0]!;
    const sourceOf = (edge: string) => { const found = roomA.edges.find(item => item.edge === edge)!; return [found.source.id, found.receiving.id]; };
    expect([sourceOf("N"), sourceOf("W"), sourceOf("S")]).toEqual([["N2", "N"], ["W2", "W"], ["S", "S"]]);
    // The south wall had no wall above, so that edge is still assumed to continue.
    expect(result.wallsAboveAssumed).toBe(true);
    expect(assembleInteriorSound(input({ elements, wallsAbove: [...wallsAbove, { id: "S2", name: "S2", ring: rect(-0.3, 5, 8.3, 5.3) }] })).wallsAboveAssumed).toBe(false);
  });
});

describe("entrance doors", () => {
  const stairwell = (patch: Partial<InteriorAssemblyInput> = {}) => input({
    walls: input().walls.map(wall => wall.id === "W" ? { ...wall, role: "stairwell" } : wall),
    wallRequirement: role => role === "stairwell" ? { rwMinDb: 53, ref: "row 14" } : null,
    wallWithDoorRequirement: role => ({ rwMinDb: role === "to_habitable_room" ? 52 : 42, ref: "row 14 note" }),
    door: ({ rwDb, role }) => ({ status: "calculated", method: "declared", valueDb: rwDb, uncertaintyDb: 5, requiredDb: role === "to_habitable_room" ? 37 : 27, marginDb: rwDb - 5 - 27, meets: rwDb - 5 >= 27, refs: ["row 18", "eq 52"] }),
    ...patch,
  });
  const door = (id: string, patch: Record<string, unknown> = {}) => ({ id, name: id, wallId: "W", roomId: "A", role: value("to_dwelling_hallway"), rw: value(32), basis: null, ...patch });

  test("a stairwell wall with an entrance door into one of its rooms takes the door's wall requirement; the door is checked on its own", () => {
    calls.airborne = [];
    const { walls, doors } = assembleInteriorSound(stairwell({ doors: [door("D")] }));
    expect(walls[0]!.requirement).toEqual({ rwMinDb: 42, ref: "row 14 note", door: { id: "D", name: "D" } });
    expect(calls.airborne.find(request => request.transmission === "horizontal")!.requiredDb).toBe(42);
    expect(doors).toHaveLength(1);
    expect(doors[0]).toMatchObject({ wall: { id: "W" }, room: { id: "A", name: "A" }, gaps: [], requirement: { rwMinDb: 27 }, result: { meets: true } });
    // The stricter door decides when two lead through the same wall.
    expect(assembleInteriorSound(stairwell({ doors: [door("D"), door("E", { role: value("to_habitable_room"), roomId: "B" })] })).walls[0]!.requirement!.rwMinDb).toBe(52);
  });

  test("doors in stairwell walls need a role and an Rw; internal doors and doors elsewhere without a role are not checked", () => {
    const { doors, walls } = assembleInteriorSound(stairwell({ doors: [door("D", { role: null, rw: null }), door("I", { role: value("internal") }), door("N", { wallId: "N", role: null })] }));
    expect(doors.map(check => [check.id, check.gaps])).toEqual([["D", ["door_role", "door_rw"]]]);
    expect(doors[0]!.result).toBeNull();
    // A door without a role does not relax the wall requirement.
    expect(walls[0]!.requirement).toEqual({ rwMinDb: 53, ref: "row 14", door: null });
  });
});

describe("doors without a declared Rw", () => {
  const criteria = { leafRw: value(33), leafType: value("rebated"), rebateSeal: value(40), floorSeal: value(40) };
  const run = (doors: NonNullable<InteriorAssemblyInput["doors"]>) => assembleInteriorSound(input({
    walls: input().walls.map(wall => wall.id === "W" ? { ...wall, role: "stairwell" } : wall),
    door: () => ({ status: "calculated", method: "declared", valueDb: 0, uncertaintyDb: 0, requiredDb: 27, marginDb: 0, meets: true, refs: ["declared"] }),
    doorCriteria: ({ role }) => role === "to_habitable_room" ? { status: "unsupported", reason: "criteria_not_applicable" }
      : { status: "calculated", method: "criteria", requiredDb: 27, criteria: [], marginDb: 4, meets: true, refs: ["criteria"] },
    doors,
  })).doors;
  const door = (patch: Record<string, unknown>) => ({ id: "D", name: "D", wallId: "W", roomId: "A", role: value("to_dwelling_hallway"), rw: null, basis: null, construction: criteria, ...patch });

  test("a complete leaf and seals are checked under the criteria; a declared Rw takes precedence", () => {
    expect(run([door({})])[0]).toMatchObject({ gaps: [], result: { method: "criteria", refs: ["criteria"] } });
    expect(run([door({ rw: value(32) })])[0]!.result).toMatchObject({ method: "declared" });
  });
  test("an incomplete construction is a missing Rw; above the criteria's limit only a declared Rw counts", () => {
    expect(run([door({ construction: { ...criteria, floorSeal: null } })])[0]).toMatchObject({ gaps: ["door_rw"], result: null });
    expect(run([door({ role: value("to_habitable_room") })])[0]).toMatchObject({ gaps: ["criteria_not_applicable"], result: null });
  });
});

describe("element catalogue values", () => {
  const rw = () => ({ status: "calculated" as const, rwDb: 55, massKgM2: 400, wallDensityKgM3: 1700, refs: ["x"], edition: "e", assumptions: [] });
  const base = { construction: null, material: null, thickness: null, bulkDensity: null, flankingLevelDifference: null };

  test("lightweight elements take their catalogue row's values or an entered Dn,f,w; massive ones need their material", () => {
    const lightweightRow = (key: string) => key === "T2-1" ? { kind: "wall_separating" as const, ref: "Tab. 2", description: "stud wall", rwDb: 47, lnwDb: null, dnfwDb: 60 } : null;
    const host = { massiveRw: rw, lightweightRow };
    expect(evaluateElement("g", "g", "wall", { ...base, construction: "drywall", lightweightCatalogueRow: "T2-1" }, host)).toMatchObject({ massive: false, rwDb: 47, dnfwDb: 60, basis: "Tab. 2: stud wall", reason: null });
    expect(evaluateElement("g", "g", "wall", { ...base, construction: "drywall", flankingLevelDifference: 62 }, host)).toMatchObject({ rwDb: null, dnfwDb: 62, reason: null });
    expect(evaluateElement("g", "g", "wall", { ...base, construction: "drywall", lightweightCatalogueRow: "nope" }, host).reason).toBe("catalogue_row_unknown");
    expect(evaluateElement("k", "k", "wall", { ...base, thickness: 24, bulkDensity: 1800 }, rw).reason).toBe("construction_missing");
    expect(evaluateElement("k", "k", "wall", { ...base, construction: "masonry", material: "Kalksandstein", thickness: 24, bulkDensity: 1800 }, rw)).toMatchObject({ massKgM2: 400, rwDb: 55, reason: null });
  });

  test("a lining, suspended ceiling or screed is credited from its f0 inputs; incomplete inputs credit nothing", () => {
    const seen: unknown[] = [];
    const lining = (request: unknown) => { seen.push(request); return { f0Hz: 80, deltaRwDb: 6, refs: ["T1"] }; };
    const wall = evaluateElement("k", "k", "wall", { ...base, construction: "masonry", material: "Kalksandstein", thickness: 24, bulkDensity: 1800,
      liningType: "free_standing", liningMass: 10, liningCavity: 5, liningSides: "one" }, { massiveRw: rw, lining });
    expect(wall.lining).toEqual({ f0Hz: 80, deltaRwDb: 6, sides: "one", reason: null });
    // The cavity is entered in cm and passed in m.
    expect(seen[0]).toEqual({ lining: { kind: "free_standing", massKgM2: 10, cavityM: 0.05 }, baseMassKgM2: 400, baseRwDb: 55 });
    const ceiling = evaluateElement("c", "c", "ceiling", { ...base, construction: "concrete", material: "Stahlbeton", thickness: 18, bulkDensity: 2400, liningType: "bonded", liningMass: 10,
      screedType: "mortar", screedMass: 90, screedStiffness: 20 }, { massiveRw: rw, lining });
    expect([ceiling.lining?.reason, ceiling.screedLining?.deltaRwDb]).toEqual(["incomplete", 6]);
  });
});

describe("junctions, linings and the further checks", () => {
  const calculated = (request: AirborneInput): AirborneResult => ({ status: "calculated", rDdDb: 0, paths: [], rwPrimeDb: 0, quantity: "R'w",
    valueDb: request.separating.rwDb + (("liningDb" in request.separating && request.separating.liningDb?.source) || 0) * 2 + (("liningDb" in request.separating && request.separating.liningDb?.receiving) || 0),
    uncertaintyDb: 2, requiredDb: 53, marginDb: 0, meets: true, refs: [], edition: "" });

  test("a wall continuing past the flanking wall or onto the next storey makes a cross junction", () => {
    calls.airborne = [];
    // W continues north past N (W3, 0.1 m off line), and stands under W2 on the storey above.
    const walls = [...input().walls, { id: "W3", name: "W3", ring: rect(4.1, -4, 4.3, -0.3), role: null }];
    const check = assembleInteriorSound(input({ walls, crossOffsetM: 0.5, wallsAbove: [{ id: "W2", name: "W2", ring: rect(4, -0.3, 4.2, 5.3) }] })).walls[0]!;
    // Further off line than the pack's offset, the continuing wall no longer makes a cross junction.
    expect(assembleInteriorSound(input({ walls, crossOffsetM: 0.05 })).walls[0]!.edges[0]!.junction).toBe("t");
    expect(check.edges.map(edge => [edge.edge, edge.junction])).toEqual([["start", "cross"], ["end", "t"], ["top", "cross"], ["bottom", "t"]]);
    expect(calls.airborne[0]!.edges.map(edge => edge.junction)).toEqual(["cross", "t", "cross", "t"]);
  });

  test("a one-sided lining on the separating wall is tried on either face and the lower result kept", () => {
    calls.airborne = [];
    const elements = new Map(input().elements);
    elements.set("W", { ...massive("W", 400, 55), lining: { f0Hz: 80, deltaRwDb: 4, sides: "one", reason: null } });
    const result = assembleInteriorSound(input({ elements, airborne: request => { calls.airborne.push(request); return calculated(request); } }));
    const horizontal = calls.airborne.filter(request => request.transmission === "horizontal");
    expect(horizontal.map(request => "liningDb" in request.separating ? request.separating.liningDb : null)).toEqual([{ source: 4, receiving: 0 }, { source: 0, receiving: 4 }]);
    // valueDb doubles the source lining in the stub, so the receiving-side placement is lower.
    expect(result.walls[0]!.result).toMatchObject({ valueDb: 59 });
    expect(result.oneSidedLining).toBe(true);
  });

  // A is a common hallway, B a living room in a dwelling, across a corridor wall; the slab under the storey carries a screed.
  const hallway = (patch: Partial<InteriorAssemblyInput> = {}) => input({
    rooms: [{ ...input().rooms[0]!, spaceType: "common_corridor" }, { ...input().rooms[1]!, spaceType: "apartment", apartmentUnit: "1", use: "living" }],
    walls: input().walls.map(wall => wall.id === "W" ? { ...wall, role: "corridor_partition" } : wall),
    floorId: "F", floorScreed: { type: value("mortar"), mass: value(90), stiffness: value(20) },
    elements: new Map([...input().elements, ["F", massive("F", 450, 58, "ceiling")]]),
    hallwayFloorRequirement: { lnwMaxDb: 50, ref: "row 11" },
    impactOther: request => ({ status: "calculated", lnEq0Db: 0, deltaLwDb: 0, kTDb: 0, lnwPrimeDb: request.position === "beside" ? 40 : 42, uncertaintyDb: 3, maxDb: request.maxDb, marginDb: 0, meets: true, refs: [], edition: "" }),
    ...patch,
  });

  test("impact sound from a common hallway into the dwelling beside it, and diagonally from the hallway above", () => {
    const requests: unknown[] = [];
    const run = (patch: Partial<InteriorAssemblyInput>) => assembleInteriorSound(hallway({ impactOther: request => { requests.push(request); return hallway().impactOther!(request); }, ...patch })).impacts;
    const beside = run({});
    expect(beside.map(check => [check.position, check.source.id, check.room.id, check.slab?.id, check.gaps])).toEqual([["beside", "A", "B", "F", []]]);
    expect(requests[0]).toEqual({ slabMassKgM2: 450, screed: { type: "mortar", massKgM2: 90, stiffnessMNm3: 20 }, position: "beside", wallMassKgM2: 400, maxDb: 50 });
    const both = run({ roomsAbove: [{ id: "A2", name: "A2", polygon: rect(0, 0, 4, 5), spaceType: "common_corridor" }] });
    expect(both.map(check => [check.position, check.slab?.id])).toEqual([["beside", "F"], ["diagonal_below", "C"]]);
    // A room of unknown use is checked once its use is known; a non-protected one is not.
    expect(run({ rooms: [hallway().rooms[0]!, { ...hallway().rooms[1]!, use: null }] })[0]!.gaps).toEqual([{ code: "room_use" }]);
    expect(run({ rooms: [hallway().rooms[0]!, { ...hallway().rooms[1]!, use: "not_protected" }] })).toEqual([]);
  });

  test("a stair in a stairwell room is checked into the protected room behind the stairwell wall", () => {
    const requests: unknown[] = [];
    const result = assembleInteriorSound(hallway({
      walls: input().walls.map(wall => wall.id === "W" ? { ...wall, role: "stairwell" } : wall),
      stairs: [{ id: "T", name: "T", roomId: "A", stairCase: value("landing_rigid"), deltaLw: null }], stairsRequirement: { lnwMaxDb: 53, ref: "row 12" },
      stair: request => { requests.push(request); return { status: "unsupported", reason: "wall_too_light" }; },
    }));
    expect(result.stairs.map(check => [check.stair.id, check.room?.id, check.wall?.id, check.gaps])).toEqual([["T", "B", "W", []]]);
    expect(requests[0]).toEqual({ stairCase: "landing_rigid", coveringDeltaLwDb: null, wallMassKgM2: 400, maxDb: 53, requirementRef: "row 12" });
    const open = assembleInteriorSound(hallway({ walls: input().walls.map(wall => wall.id === "W" ? { ...wall, role: "stairwell" } : wall),
      stairs: [{ id: "T", name: "T", roomId: "A", stairCase: null, deltaLw: null }], stairsRequirement: null }));
    expect(open.stairs[0]!.gaps).toEqual([{ code: "stair_case" }, { code: "no_requirement" }]);
    // A stair in a room without a stairwell wall still shows, with what it lacks.
    expect(assembleInteriorSound(hallway({ stairs: [{ id: "T", name: "T", roomId: "A", stairCase: null, deltaLw: null }] })).stairs)
      .toMatchObject([{ stair: { id: "T" }, room: null, gaps: [{ code: "stair_wall" }] }]);
  });

  test("an installation on a wall bordering another unit's protected room fails the reference wall; a level is compared with the room use's requirement", () => {
    const requests: ServiceInput[] = [];
    const installation = { id: "I", name: "I", roomId: "A", wallId: "W", kind: value("sanitary"), proof: value("reference_wall"), level: null, basis: null, receivingUse: null,
      buildUpConfirmed: null, conditionsConfirmed: value(true) };
    const run = (patch: Partial<NonNullable<InteriorAssemblyInput["installations"]>[number]>) => assembleInteriorSound(hallway({ installations: [{ ...installation, ...patch }],
      service: request => { requests.push(request); return { status: "unsupported", reason: "method_missing" }; },
      serviceRequirement: (kind, use) => use === "work" ? { maxDb: 35, ref: "work" } : { maxDb: 30, ref: "living" } })).services[0]!;
    expect(run({}).borders).toEqual([{ id: "B", name: "B" }]);
    expect(requests[0]).toEqual({ method: "reference_wall", kind: "sanitary", wall: { massive: true, massKgM2: 400 }, bordersProtectedRoom: true, conditionsConfirmed: true });
    expect(run({ proof: value("level"), level: value(28), receivingUse: value("work") }).requirement).toEqual({ maxDb: 35, ref: "work" });
    expect(requests[1]).toEqual({ method: "level", valueDb: 28, requirement: { maxDb: 35, ref: "work" } });
    expect(run({ proof: value("level") }).gaps).toEqual([{ code: "service_level" }]);
  });
});
