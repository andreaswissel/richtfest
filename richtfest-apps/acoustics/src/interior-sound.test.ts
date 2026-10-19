import { describe, expect, test } from "bun:test";
import type { AcousticNormPack, AirborneInput, FlankElement } from "@richtfest/shared";
import { airborneSoundInsulation, doorCriteria, doorSoundInsulation, impactOtherDirections, impactSoundLevel, interiorRequirements, liningImprovement, serviceNoise, stairImpact, timberImpact } from "./interior-sound";

// Made-up coefficients: these tests check the method's structure, not normative values.
const screed = (massLog: number, stiffnessLog: number, massStiffnessLog: number, mass: number, constant: number, ref: string) =>
  ({ massLog, stiffnessLog, massStiffnessLog, mass, constant, minStiffness: 5, maxStiffness: 50, minMassKgM2: 10, maxMassKgM2: 150, ref });
const pack = {
  id: "synthetic", rls19: {} as AcousticNormPack["rls19"], din4109: {} as AcousticNormPack["din4109"],
  din4109_interior: {
    editions: { requirements: "R", method: "M", junctions: "J", screeds: "S" },
    requirements: { walls: { apartment_partition: { rwMinDb: 53, ref: "W" } }, ceilings: { apartment_separating: { rwMinDb: 54, lnwMaxDb: 50, ref: "C" } },
      doors: { to_dwelling_hallway: { rwMinDb: 30, ref: "D1" }, to_habitable_room: { rwMinDb: 40, ref: "D2" } }, wallWithDoor: { offsetDb: 12, ref: "WD" } },
    door: { uncertaintyDb: 4, ref: "DU" },
    airborne: {
      referenceLengthM: 1, referenceAbsorptionM2: 10, minSeparatingAreaM2: 10, labEdgeLengthM: { horizontal: 2, vertical: 4 },
      tJunction: { k12: { constant: 4, square: 6 }, k13: { breakM: 0.2, below: { constant: 6, linear: 10, square: 5 }, above: { constant: 7, linear: 5 } } },
      uncertaintyDb: 2, refs: { total: "T", direct: "D", flanking: "F", kijMin: "K", dnw: "N", lightweight: "L", junction: "J", uncertainty: "U" },
    },
    impact: {
      bareSlab: { constant: 160, slope: 30, minKgM2: 100, maxKgM2: 700, ref: "B" },
      flanking: { constant: 1, slope: 5, minSlabKgM2: 100, maxSlabKgM2: 900, minFlankingKgM2: 100, maxFlankingKgM2: 500, ref: "KF" },
      screeds: { mortar: screed(10, -10, 0, 0, 20, "SM"), prefab: screed(0, -5, -0.1, 0.5, 20, "SP") },
      uncertaintyDb: 3, refs: { total: "IT", uncertainty: "IU" },
    },
    roundingDecimals: 1,
  },
} as AcousticNormPack;

const lg = Math.log10;
const sum = (levels: number[]) => -10 * lg(levels.reduce((total, level) => total + 10 ** (-level / 10), 0));
const massive = (id: string, massKgM2: number, rwDb: number, areaM2 = 10): Extract<FlankElement, { kind: "massive" }> => ({ kind: "massive", id, name: id, massKgM2, rwDb, areaM2 });
const separating = { id: "sep", name: "sep", massKgM2: 400, rwDb: 50 };
const input = (patch: Partial<AirborneInput> = {}): AirborneInput => ({
  separating, separatingAreaM2: 10, transmission: "horizontal", requiredDb: 53,
  edges: [{ edge: "start", couplingLengthM: 2.5, source: massive("ext", 400, 50), receiving: massive("ext", 400, 50) }], ...patch,
});

describe("airborne sound insulation between rooms", () => {
  test("direct path plus Ff, Df and Fd per edge, summed energetically and compared less the allowance", () => {
    const result = airborneSoundInsulation(pack, input());
    if (result.status !== "calculated") throw new Error(result.reason);
    // Equal masses: M = 0, K13 = 6, K12 = 4; 10 lg(Ss / (l0 · lf)) = 10 lg 4.
    const ff = 25 + 25 + 6 + 10 * lg(4), df = 25 + 25 + 4 + 10 * lg(4);
    const expected = sum([50, ff, df, df]);
    expect(result.paths.map(path => [path.path, path.kijDb, path.rDb])).toEqual([["Ff", 6, Math.round(ff * 10) / 10], ["Df", 4, Math.round(df * 10) / 10], ["Fd", 4, Math.round(df * 10) / 10]]);
    expect(result.rwPrimeDb).toBe(Math.round(expected * 10) / 10);
    expect(result.quantity).toBe("R'w");
    expect(result.marginDb).toBe(Math.round((expected - 2 - 53) * 10) / 10);
    expect(result.meets).toBe(expected - 2 >= 53);
  });

  test("a heavier separating wall moves the junction past the break point; small flanking areas raise Kij to Kij,min", () => {
    const heavy = airborneSoundInsulation(pack, input({ separating: { ...separating, massKgM2: 800 } }));
    if (heavy.status !== "calculated") throw new Error(heavy.reason);
    const m = lg(2);
    expect(heavy.paths.map(path => path.kijDb)).toEqual([7 + 5 * m, 4 + 6 * m * m, 4 + 6 * m * m].map(value => Math.round(value * 10) / 10));
    const small = airborneSoundInsulation(pack, input({ edges: [{ edge: "start", couplingLengthM: 2.5, source: massive("ext", 400, 50, 0.5), receiving: massive("ext", 400, 50, 0.5) }] }));
    if (small.status !== "calculated") throw new Error(small.reason);
    // Ff: Kij,min = 10 lg(2.5 · (1/0.5 + 1/0.5)) = 10 dB above K13 = 6.
    expect(small.paths[0]).toMatchObject({ path: "Ff", kijDb: 10, kijMinApplied: true });
  });

  test("different flanking walls on the two sides take their mean mass for the junction", () => {
    const result = airborneSoundInsulation(pack, input({ edges: [{ edge: "start", couplingLengthM: 2.5, source: massive("a", 300, 48), receiving: massive("b", 500, 52) }] }));
    if (result.status !== "calculated") throw new Error(result.reason);
    // Mean 400 kg/m² against the 400 kg/m² separating wall: M = 0, so K13 = 6; each side keeps its own Rw.
    expect(result.paths[0]).toMatchObject({ kijDb: 6, rDb: Math.round((24 + 26 + 6 + 10 * lg(4)) * 10) / 10 });
  });

  test("below the minimum common area the requirement applies to Dn,w", () => {
    const result = airborneSoundInsulation(pack, input({ separatingAreaM2: 5 }));
    if (result.status !== "calculated") throw new Error(result.reason);
    expect(result.quantity).toBe("Dn,w");
    expect(result.valueDb).toBeCloseTo(result.rwPrimeDb + 10 * lg(2), 0);
    expect(result.refs).toContain("N");
  });

  test("lightweight flanking elements contribute only Ff from their Dn,f,w; mixed edges are not supported", () => {
    const light: FlankElement = { kind: "lightweight", id: "gk", name: "gk", dnfwDb: 60 };
    const result = airborneSoundInsulation(pack, input({ edges: [{ edge: "start", couplingLengthM: 2.5, source: light, receiving: light }] }));
    if (result.status !== "calculated") throw new Error(result.reason);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.rDb).toBe(Math.round((60 + 10 * lg(2 / 2.5) + 10 * lg(1)) * 10) / 10);
    expect(airborneSoundInsulation(pack, input({ edges: [{ edge: "start", couplingLengthM: 2.5, source: light, receiving: massive("ext", 400, 50) }] })))
      .toEqual({ status: "unsupported", reason: "mixed_flanking" });
    expect(airborneSoundInsulation({ ...pack, din4109_interior: undefined }, input())).toEqual({ status: "unsupported", reason: "method_missing" });
  });
});

describe("impact sound of massive ceilings", () => {
  const ceiling = { slabMassKgM2: 500, screed: { type: "mortar" as const, massKgM2: 100, stiffnessMNm3: 10 }, flankingMassesKgM2: [200, 300], maxDb: 50 };
  test("bare slab level less the screed improvement plus the flanking correction from the mean wall mass", () => {
    const result = impactSoundLevel(pack, ceiling);
    if (result.status !== "calculated") throw new Error(result.reason);
    const bare = 160 - 30 * lg(500), k = Math.round((1 + 5 * lg(500 / 250)) * 10) / 10;
    expect(result).toMatchObject({ deltaLwDb: 30, kDb: k, flankingMeanKgM2: 250, lnwPrimeDb: Math.round((bare - 30 + k) * 10) / 10 });
    expect(result.marginDb).toBe(Math.round((50 - (bare - 30 + k + 3)) * 10) / 10);
    expect(result.meets).toBe(false);
  });

  test("flanking walls heavier than the slab need no correction; the screed formula includes the mass-stiffness term", () => {
    expect(impactSoundLevel(pack, { ...ceiling, flankingMassesKgM2: [450, 450], slabMassKgM2: 400 })).toMatchObject({ kDb: 0 });
    const prefab = impactSoundLevel(pack, { ...ceiling, screed: { type: "prefab", massKgM2: 20, stiffnessMNm3: 20 } });
    expect(prefab).toMatchObject({ deltaLwDb: Math.round((-5 * lg(20) - 0.1 * 20 * lg(20) + 0.5 * 20 + 20) * 10) / 10 });
  });

  test("inputs outside the method's ranges are not calculated", () => {
    expect(impactSoundLevel(pack, { ...ceiling, screed: { ...ceiling.screed, stiffnessMNm3: 80 } })).toEqual({ status: "unsupported", reason: "screed_out_of_range" });
    expect(impactSoundLevel(pack, { ...ceiling, slabMassKgM2: 80 })).toEqual({ status: "unsupported", reason: "slab_mass_out_of_range" });
    expect(impactSoundLevel(pack, { ...ceiling, flankingMassesKgM2: [] })).toEqual({ status: "unsupported", reason: "no_massive_flanking" });
    expect(impactSoundLevel(pack, { ...ceiling, flankingMassesKgM2: [50, 60] })).toEqual({ status: "unsupported", reason: "flanking_mass_out_of_range" });
    // Heavier flanking walls than the range are capped at its upper limit: K from 500 kg/m², which is higher than from their actual 650.
    expect(impactSoundLevel(pack, { ...ceiling, slabMassKgM2: 700, flankingMassesKgM2: [600, 700] }))
      .toMatchObject({ flankingMeanKgM2: 650, flankingMassCapped: true, kDb: Math.round((1 + 5 * lg(700 / 500)) * 10) / 10 });
    expect(impactSoundLevel(pack, { ...ceiling, screed: null })).toMatchObject({ status: "calculated", deltaLwDb: 0 });
  });
});

describe("entrance doors", () => {
  const minimum = interiorRequirements(pack, "statutory_minimum")!;
  test("the tested Rw less the door allowance is compared with the role's requirement; the unrounded margin decides", () => {
    expect(doorSoundInsulation(pack, { rwDb: 34, requirement: minimum.door("to_dwelling_hallway") })).toEqual({ status: "calculated", method: "declared", valueDb: 34, uncertaintyDb: 4, requiredDb: 30, marginDb: 0, meets: true, refs: ["D1", "DU"] });
    expect(doorSoundInsulation(pack, { rwDb: 43.95, requirement: minimum.door("to_habitable_room") })).toMatchObject({ requiredDb: 40, marginDb: 0, meets: false });
    expect(doorSoundInsulation({ ...pack, din4109_interior: { ...pack.din4109_interior!, door: undefined } }, { rwDb: 40, requirement: minimum.door("to_habitable_room") })).toEqual({ status: "unsupported", reason: "method_missing" });
    expect(doorSoundInsulation(pack, { rwDb: 40, requirement: null })).toEqual({ status: "unsupported", reason: "no_requirement" });
  });
  test("without a declared Rw, leaf and seals must each reach the requirement plus their offset, up to the criteria's limit", () => {
    const withRules = { ...pack, din4109_35: { doors: { maxRequiredDb: 32, leafOffsetDb: { rebated: 3, flush: 5 }, sealOffsetDb: 9, ref: "T4" } } } as AcousticNormPack;
    const door = { leafRwDb: 33, leafType: "rebated" as const, rebateSealDb: 39, floorSealDb: 39, requirement: minimum.door("to_dwelling_hallway") };
    // Requirement 30: leaf ≥ 33 (rebated), seals ≥ 39; every part meets exactly.
    expect(doorCriteria(withRules, door)).toEqual({ status: "calculated", method: "criteria", requiredDb: 30, marginDb: 0, meets: true, refs: ["D1", "T4"], criteria: [
      { part: "leaf", valueDb: 33, requiredDb: 33, meets: true }, { part: "rebate_seal", valueDb: 39, requiredDb: 39, meets: true }, { part: "floor_seal", valueDb: 39, requiredDb: 39, meets: true }] });
    // A flush leaf needs the larger offset; the weakest part sets the margin.
    expect(doorCriteria(withRules, { ...door, leafType: "flush" })).toMatchObject({ meets: false, marginDb: -2 });
    // The requirement into a habitable room is above the criteria's limit.
    expect(doorCriteria(withRules, { ...door, requirement: minimum.door("to_habitable_room") })).toEqual({ status: "unsupported", reason: "criteria_not_applicable" });
    expect(doorCriteria(pack, door)).toEqual({ status: "unsupported", reason: "method_missing" });
  });
  test("a wall with an entrance door needs the door's requirement plus the offset", () => {
    expect(minimum.wallWithDoor("to_dwelling_hallway")).toEqual({ rwMinDb: 42, ref: "WD; D1" });
    expect(minimum.wallWithDoor("to_habitable_room")!.rwMinDb).toBe(52);
  });
});

describe("requirement levels", () => {
  const elevatedPack = { ...pack, din4109_5: { edition: "E", requirements: {
    walls: { apartment_partition: { rwMinDb: 56, ref: "EW" } }, doors: { to_habitable_room: { rwMinDb: 45, ref: "ED2" } } } } } as AcousticNormPack;
  test("an elevated row replaces the minimum; a role without an elevated row keeps the minimum", () => {
    const elevated = interiorRequirements(elevatedPack, "elevated")!;
    expect(elevated.level).toBe("elevated");
    expect(elevated.edition).toBe("E; R");
    expect(elevated.wall("apartment_partition")).toEqual({ rwMinDb: 56, ref: "EW" });
    expect(elevated.ceiling("apartment_separating")).toEqual({ rwMinDb: 54, lnwMaxDb: 50, ref: "C" });
    // The wall-with-door offset applies to the elevated door requirement.
    expect(elevated.wallWithDoor("to_habitable_room")).toEqual({ rwMinDb: 57, ref: "WD; ED2" });
    expect(elevated.door("to_dwelling_hallway")).toEqual({ rwMinDb: 30, ref: "D1" });
  });
  test("without an elevated table the elevated level is unavailable; the minimum still is", () => {
    expect(interiorRequirements(pack, "elevated")).toBeNull();
    expect(interiorRequirements(pack, "statutory_minimum")!.wall("apartment_partition")).toEqual({ rwMinDb: 53, ref: "W" });
  });
});

// Made-up lining, junction and impact data, separate from the base pack so the tests above stay unchanged.
const extended = {
  ...pack,
  din4109_interior: {
    ...pack.din4109_interior!,
    requirements: { ...pack.din4109_interior!.requirements, stairs: { lnwMaxDb: 55, ref: "ST" },
      services: { sanitary: { living: { maxDb: 31, ref: "SL" }, work: { maxDb: 36, ref: "SW" } } } },
    airborne: { ...pack.din4109_interior!.airborne,
      crossJunction: { k12: { constant: 6, square: 10 }, k13: { breakM: 0.2, below: { constant: 9, linear: 10, square: 5 }, above: { constant: 10, linear: 5 } } } },
    impact: { ...pack.din4109_interior!.impact,
      otherDirections: { besideDb: 6, diagonalBelowDb: 4, minWallKgM2: 160, ref: "KT" },
      stairs: { ref: "TS", cases: { landing_rigid: { lnEq0Db: 60, lnwDb: 66, minWallKgM2: 350, ref: "S1" }, run_elastic_joint: { lnEq0Db: 30, lnwDb: 38, minWallKgM2: null, ref: "S6" } } },
      timber: { ref: "TB", k1: { gypsum_wood: { one_board_resilient: 2 }, wood_board: { one_board_resilient: 6 } },
        k2: { boarded: { mineral: { fromDb: 35, values: [9, 7, 5, 3, 1] } }, wood: { mineral: { fromDb: 35, values: [12, 10, 8, 6, 4] } } } },
    },
  },
  din4109_34: { edition: "L", lowBand: { minHz: 30, maxHz: 150, constant: 70, lgSlope: 18, rwFactor: 0.4 },
    points: [{ f0Hz: 200, deltaRwDb: -2 }, { f0Hz: 600, deltaRwDb: -8 }, { f0Hz: 1500, deltaRwDb: -8 }, { f0Hz: 1500, deltaRwDb: -4 }, { f0Hz: 4000, deltaRwDb: -4 }],
    f0Constant: 150, cavityFactor: 0.1, smallerFactor: 0.4, refs: { table: "LT", bonded: "LB", freeStanding: "LF", combination: "LC" } },
  din4109_36: { edition: "I", massiveMinKgM2: 200, lightweightSlabMinKgM2: 400, refs: { massive: "IM", lightweight: "IL" } },
} as AcousticNormPack;

describe("linings and junctions", () => {
  test("ΔRw from f0: the low-band formula, interpolation between points, and a step where a frequency repeats", () => {
    // Bonded: f0 = 150 · √(s' · (1/m'1 + 1/m'2)); s' = 10, m'1 = 20, m'2 = 380 → 150 · √(10 · 0.05263) ≈ 108.8 Hz.
    const bonded = liningImprovement(extended, { lining: { kind: "bonded", massKgM2: 20, stiffnessMNm3: 10 }, baseMassKgM2: 380, baseRwDb: 50 });
    const f0 = 150 * Math.sqrt(10 * (1 / 20 + 1 / 380));
    expect(bonded).toEqual({ f0Hz: Math.round(f0 * 10) / 10, deltaRwDb: Math.round((70 - 18 * lg(f0) - 20) * 10) / 10, refs: ["LT", "LB"] });
    // Free-standing with d = 0.1 m at m'1 = 10, m'2 = 90: f0 = 150 · √(1 · 0.1111) = 50 Hz.
    const free = liningImprovement(extended, { lining: { kind: "free_standing", massKgM2: 10, cavityM: 0.1 }, baseMassKgM2: 90, baseRwDb: 40 });
    expect(free.f0Hz).toBe(50);
    expect(free.deltaRwDb).toBe(Math.round((70 - 18 * lg(50) - 16) * 10) / 10);
    // Between 200 Hz (−2) and 600 Hz (−8): 400 Hz interpolates to −5. Find s' for f0 = 400 with m'1 = m'2 = 100: s' = (400/150)² / 0.02.
    const s400 = (400 / 150) ** 2 / 0.02;
    expect(liningImprovement(extended, { lining: { kind: "bonded", massKgM2: 100, stiffnessMNm3: s400 }, baseMassKgM2: 100, baseRwDb: 50 }).deltaRwDb).toBe(-5);
    // Above the step at 1500 Hz the later value applies; above the last point there is none.
    const at = (f: number) => liningImprovement(extended, { lining: { kind: "bonded", massKgM2: 100, stiffnessMNm3: (f / 150) ** 2 / 0.02 }, baseMassKgM2: 100, baseRwDb: 50 });
    expect([at(1400).deltaRwDb, at(2000).deltaRwDb, at(5000).deltaRwDb]).toEqual([-8, -4, null]);
    expect(liningImprovement(pack, { lining: { kind: "bonded", massKgM2: 100, stiffnessMNm3: 10 }, baseMassKgM2: 100, baseRwDb: 50 }).deltaRwDb).toBeNull();
  });

  test("linings raise the direct path by both faces combined and each flanking path by the faces it leaves and enters", () => {
    const result = airborneSoundInsulation(extended, input({
      separating: { ...separating, liningDb: { source: 8, receiving: 0 } },
      edges: [{ edge: "start", couplingLengthM: 2.5, source: { ...massive("ext", 400, 50), liningDb: 3 }, receiving: { ...massive("ext", 400, 50), liningDb: 5 } }],
    }));
    if (result.status !== "calculated") throw new Error(result.reason);
    expect(result.rDdDb).toBe(58);
    // Ff: F 3 and f 5 → 5 + 0.4 · 3; Df: D 8 and f 5 → 8 + 0.4 · 5; Fd: F 3 and d 0 → 3.
    expect(result.paths.map(path => path.liningDb)).toEqual([6.2, 10, 3]);
    expect(result.refs).toContain("LC");
  });

  test("a cross junction takes its own coefficients only where the pack has them", () => {
    const edge = { edge: "start", couplingLengthM: 2.5, source: massive("ext", 400, 50), receiving: massive("ext", 400, 50), junction: "cross" as const };
    const cross = airborneSoundInsulation(extended, input({ edges: [edge] }));
    const fallback = airborneSoundInsulation(pack, input({ edges: [edge] }));
    if (cross.status !== "calculated" || fallback.status !== "calculated") throw new Error("not calculated");
    expect(cross.paths.map(path => [path.junction, path.kijDb])).toEqual([["cross", 9], ["cross", 6], ["cross", 6]]);
    expect(fallback.paths.map(path => [path.junction, path.kijDb])).toEqual([["t", 6], ["t", 4], ["t", 4]]);
  });
});

describe("impact sound beyond the room below", () => {
  test("beside and diagonally below: bare slab less ΔLw less K_T, only with heavy enough walls between", () => {
    const base = { slabMassKgM2: 400, screed: { type: "mortar" as const, massKgM2: 80, stiffnessMNm3: 20 }, wallMassKgM2: 300, maxDb: 50 };
    const beside = impactOtherDirections(extended, { ...base, position: "beside" });
    const diagonal = impactOtherDirections(extended, { ...base, position: "diagonal_below" });
    if (beside.status !== "calculated" || diagonal.status !== "calculated") throw new Error("not calculated");
    const lnEq0 = 160 - 30 * lg(400), deltaLw = Math.round((10 * lg(80) - 10 * lg(20) + 20) * 10) / 10;
    expect(beside.lnwPrimeDb).toBe(Math.round((lnEq0 - deltaLw - 6) * 10) / 10);
    expect(diagonal.lnwPrimeDb).toBe(Math.round((lnEq0 - deltaLw - 4) * 10) / 10);
    expect(beside.marginDb).toBe(Math.round((50 - (lnEq0 - deltaLw - 6 + 3)) * 10) / 10);
    expect(impactOtherDirections(extended, { ...base, wallMassKgM2: 150, position: "beside" })).toEqual({ status: "unsupported", reason: "wall_too_light" });
    expect(impactOtherDirections(pack, { ...base, position: "beside" })).toEqual({ status: "unsupported", reason: "method_missing" });
  });

  test("stairs: the tabled L'n,w without a covering, Ln,eq,0,w less ΔLw with one; a case's wall mass condition holds", () => {
    const bare = stairImpact(extended, { stairCase: "landing_rigid", coveringDeltaLwDb: null, wallMassKgM2: 400, maxDb: 55, requirementRef: "ST" });
    const covered = stairImpact(extended, { stairCase: "landing_rigid", coveringDeltaLwDb: 25, wallMassKgM2: 400, maxDb: 55, requirementRef: "ST" });
    if (bare.status !== "calculated" || covered.status !== "calculated") throw new Error("not calculated");
    expect([bare.quantity, bare.lnwPrimeDb, bare.marginDb, bare.meets]).toEqual(["L'n,w", 66, -14, false]);
    expect([covered.quantity, covered.lnwPrimeDb, covered.marginDb, covered.meets]).toEqual(["Ln,eq,0,w", 35, 17, true]);
    expect(stairImpact(extended, { stairCase: "landing_rigid", coveringDeltaLwDb: null, wallMassKgM2: 300, maxDb: 55, requirementRef: "ST" }).status).toBe("unsupported");
    expect(stairImpact(extended, { stairCase: "run_elastic_joint", coveringDeltaLwDb: null, wallMassKgM2: null, maxDb: 55, requirementRef: "ST" }).status).toBe("calculated");
    expect(stairImpact(extended, { stairCase: "run_rigid", coveringDeltaLwDb: null, wallMassKgM2: 400, maxDb: 55, requirementRef: "ST" })).toEqual({ status: "unsupported", reason: "case_missing" });
  });

  test("timber ceilings: Ln,w plus the largest K1 of the room's walls plus K2 looked up at Ln,w + K1", () => {
    const one = timberImpact(extended, { lnwDb: 36, underside: "one_board_resilient", wallLinings: ["gypsum_wood"], screed: "mineral", maxDb: 53 });
    if (one.status !== "calculated") throw new Error(one.reason);
    // K1 = 2 → 38 → index 3 of the boarded row → K2 = 3.
    expect([one.k1Db, one.k2Db, one.lnwPrimeDb]).toEqual([2, 3, 41]);
    // A wood-board wall raises K1 to 6 → 42, beyond the row's end → last values 1 (boarded) and 4 (wood): the larger counts.
    const mixed = timberImpact(extended, { lnwDb: 36, underside: "one_board_resilient", wallLinings: ["gypsum_wood", "wood_board"], screed: "mineral", maxDb: 53 });
    if (mixed.status !== "calculated") throw new Error(mixed.reason);
    expect([mixed.k1Db, mixed.k2Db, mixed.lnwPrimeDb]).toEqual([6, 4, 46]);
    expect(timberImpact(extended, { lnwDb: 36, underside: "open_beams", wallLinings: ["gypsum_wood"], screed: "mineral", maxDb: 53 }).status).toBe("unsupported");
  });
});

describe("building services", () => {
  test("a reference installation wall passes only when every rule holds; a level is compared without an allowance", () => {
    const wall = { massive: true as const, massKgM2: 250 };
    expect(serviceNoise(extended, { method: "reference_wall", kind: "sanitary", wall, bordersProtectedRoom: false, conditionsConfirmed: true }))
      .toMatchObject({ status: "calculated", meets: true, failures: [], refs: ["IM"] });
    expect(serviceNoise(extended, { method: "reference_wall", kind: "other", wall: { massive: true, massKgM2: 150 }, bordersProtectedRoom: true, conditionsConfirmed: false }))
      .toMatchObject({ meets: false, failures: ["not_sanitary", "wall_too_light", "borders_protected_room", "conditions_unconfirmed"] });
    expect(serviceNoise(extended, { method: "reference_wall", kind: "sanitary", wall: { massive: false, buildUpConfirmed: true, slabMassKgM2: 380 }, bordersProtectedRoom: false, conditionsConfirmed: true }))
      .toMatchObject({ meets: false, failures: ["slab_too_light"], refs: ["IL"] });
    const requirements = interiorRequirements(extended, "statutory_minimum")!;
    expect(serviceNoise(extended, { method: "level", valueDb: 31, requirement: requirements.service("sanitary", "living") })).toMatchObject({ meets: true, marginDb: 0 });
    expect(serviceNoise(extended, { method: "level", valueDb: 33, requirement: requirements.service("sanitary", "work") })).toMatchObject({ meets: true, marginDb: 3 });
    expect(requirements.service("other", "living")).toBeNull();
  });

  test("an elevated services table without a work column keeps the statutory work value", () => {
    const elevated = interiorRequirements({ ...extended, din4109_5: { edition: "E", requirements: { services: { sanitary: { living: { maxDb: 28, ref: "EL" } } }, stairs: { lnwMaxDb: 49, ref: "ES" } } } }, "elevated")!;
    expect([elevated.service("sanitary", "living")?.maxDb, elevated.service("sanitary", "work")?.maxDb, elevated.stairs?.lnwMaxDb]).toEqual([28, 36, 49]);
  });
});
