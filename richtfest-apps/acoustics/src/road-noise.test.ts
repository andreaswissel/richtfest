import { describe, expect, test } from "bun:test";
import type { AcousticNormPack, RoadNoiseSource } from "@richtfest/shared";
import { roadRatingLevels, sourceLines } from "./road-noise";
import { exteriorNoiseLevel } from "./exterior-noise-level";

// Made-up coefficients: these tests check the method's structure, not normative values.
const term = { fromPct: 0, gradientDivisor: 1, constant: 0, speedFactor: 0, speedCapKmh: null, speedDivisor: 1 };
const traffic = { day: { hourlyPerDailyTraffic: 0.1, truck1Pct: 2, truck2Pct: 2 }, night: { hourlyPerDailyTraffic: 0.01, truck1Pct: 2, truck2Pct: 2 } };
const flat = { kind: "by_vehicle" as const, splitKmh: 50, car: { low: 0, high: 0 }, truck: { low: 0, high: 0 } };
const pack: AcousticNormPack = {
  id: "synthetic",
  rls19: {
    edition: "synthetic", sourceHeightM: 1,
    emission: { car: { a: 80, b: 10, c: 2 }, truck1: { a: 90, b: 10, c: 2 }, truck2: { a: 95, b: 10, c: 2 } },
    speed: { minimumKmh: 20, unrestrictedCarKmh: 120, truckCapKmh: { motorway: 80, other: 70 } },
    standardTraffic: { motorway: traffic, federal: traffic, state_district: traffic, municipal: traffic },
    surfaces: { mastic_asphalt: flat, paving_other: { kind: "by_speed", columns: [{ fromKmh: 20, value: 4 }] } } as AcousticNormPack["rls19"]["surfaces"],
    referenceSurface: "mastic_asphalt",
    gradient: { clampPct: 10, car: { downhill: term, uphill: term }, truck1: { downhill: term, uphill: term }, truck2: { downhill: term, uphill: term } },
    sourceLineLanes: { offsets: [0.5, 1.5], manyLanesFromOuter: 1 },
    propagation: { divergenceConstantDb: 8, airAbsorptionDivisorM: 100, ground: { maxDb: 5, heightFactor: 30, distanceTermM: 500 } },
  },
  din4109: { edition: "synthetic", exteriorLevelAdditionDb: 2, nightSurchargeDb: 8, railReductionDb: 4, turnedAwayReductionDb: { open: 3, closed: 6 } },
};
const road = (patch: Partial<RoadNoiseSource> = {}): RoadNoiseSource => ({
  id: "road", roadClass: "municipal", dailyTraffic: 10_000, heavyVehicleSharePct: null, speedLimitKmh: 50,
  surface: null, gradientPct: null, lanes: 2, laneWidthM: 3, parts: [[[-500, 20], [500, 20]]], ...patch,
});

describe("road rating levels", () => {
  test("a facade turned away from the road receives nothing directly; one facing it does", () => {
    const [front, back] = roadRatingLevels(pack, [road()], [
      { id: "front", position: [0, 0, 4], normal: [0, 1] },
      { id: "back", position: [0, 0, 4], normal: [0, -1] },
    ]);
    expect(front!.ok && front!.dayDb).toBeGreaterThan(40);
    expect(back!.ok && back!.dayDb).toBeNull();
  });

  test("day and night differ by exactly the traffic ratio at equal truck shares", () => {
    const [level] = roadRatingLevels(pack, [road()], [{ id: "r", position: [0, 0, 4], normal: null }]);
    if (!level!.ok) throw new Error("expected a level");
    expect(level.dayDb! - level.nightDb!).toBeCloseTo(10, 6);
  });

  test("a road without traffic data or, off motorways, without a speed limit is not calculated", () => {
    const [noTraffic] = roadRatingLevels(pack, [road({ dailyTraffic: null })], [{ id: "r", position: [0, 0, 4], normal: null }]);
    const [noLimit] = roadRatingLevels(pack, [road({ speedLimitKmh: null })], [{ id: "r", position: [0, 0, 4], normal: null }]);
    const [motorway] = roadRatingLevels(pack, [road({ speedLimitKmh: null, roadClass: "motorway" })], [{ id: "r", position: [0, 0, 4], normal: null }]);
    expect(!noTraffic!.ok && noTraffic!.emission.issues).toEqual(["missing_daily_traffic"]);
    expect(!noLimit!.ok && noLimit!.emission.issues).toEqual(["missing_speed_limit"]);
    expect(motorway!.ok).toBe(true);
  });

  test("a louder surface raises the level by its correction", () => {
    const receivers = [{ id: "r", position: [0, 0, 4] as [number, number, number], normal: null }];
    const [plain] = roadRatingLevels(pack, [road()], receivers);
    const [paved] = roadRatingLevels(pack, [road({ surface: "paving_other" })], receivers);
    if (!plain!.ok || !paved!.ok) throw new Error("expected levels");
    expect(paved.dayDb! - plain.dayDb!).toBeCloseTo(4, 6);
  });

  test("an undivided road gets a line per direction; the carriageways of a divided road one each", () => {
    expect(sourceLines(pack.rls19, road()).lines).toHaveLength(2);
    const divided = road({ parts: [[[-500, 20], [500, 20]], [[500, 45], [-500, 45]]] });
    expect(sourceLines(pack.rls19, divided).lines).toHaveLength(2);
    // Consecutive pieces of one road ahead of each other are not twins.
    const chained = road({ parts: [[[-100, 20], [0, 20]], [[0, 20], [100, 20]]] });
    expect(sourceLines(pack.rls19, chained).lines).toHaveLength(4);
  });
});

describe("relevant exterior noise level", () => {
  test("adds once to the combined level, reduces rail and applies the night surcharge", () => {
    const level = exteriorNoiseLevel(pack, [
      { sourceId: "a", kind: "road", dayDb: 60, nightDb: 52 },
      { sourceId: "b", kind: "rail", dayDb: 64, nightDb: 60 },
    ])!;
    // Day: road 60 and rail 64 − 4 = 60 combine to 63.01, plus 2 once.
    expect(level.dayDb).toBeCloseTo(60 + 10 * Math.log10(2) + 2, 6);
    // Night: road 52 + 8 = 60 and rail 60 + 8 − 4 = 64.
    expect(level.nightDb).toBeCloseTo(10 * Math.log10(10 ** 6 + 10 ** 6.4) + 2, 6);
    expect(level.sleepingDb).toBe(level.nightDb);
  });
});
