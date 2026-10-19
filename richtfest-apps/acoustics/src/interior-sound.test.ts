import { describe, expect, test } from "bun:test";
import type { AcousticNormPack, AirborneInput, FlankElement } from "@richtfest/shared";
import { airborneSoundInsulation, impactSoundLevel } from "./interior-sound";

// Made-up coefficients: these tests check the method's structure, not normative values.
const screed = (massLog: number, stiffnessLog: number, massStiffnessLog: number, mass: number, constant: number, ref: string) =>
  ({ massLog, stiffnessLog, massStiffnessLog, mass, constant, minStiffness: 5, maxStiffness: 50, minMassKgM2: 10, maxMassKgM2: 150, ref });
const pack = {
  id: "synthetic", rls19: {} as AcousticNormPack["rls19"], din4109: {} as AcousticNormPack["din4109"],
  din4109_interior: {
    editions: { requirements: "R", method: "M", junctions: "J", screeds: "S" },
    requirements: { walls: { apartment_partition: { rwMinDb: 53, ref: "W" } }, ceilings: { apartment_separating: { rwMinDb: 54, lnwMaxDb: 50, ref: "C" } } },
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
const massive = (id: string, massKgM2: number, rwDb: number, areaM2 = 10): FlankElement => ({ kind: "massive", id, name: id, massKgM2, rwDb, areaM2 });
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
