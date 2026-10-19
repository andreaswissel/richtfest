import { describe, expect, test } from "bun:test";
import type { AcousticNormPack } from "@richtfest/shared";
import { massiveWallRw } from "./massive-wall";

// Made-up coefficients: these tests check the method's structure, not normative values.
const segment = (slope: number, intercept: number, minKgM2: number, maxKgM2: number, ref: string) => ({ slope, intercept, minKgM2, maxKgM2, minInclusive: true, maxInclusive: false, ref });
const pack = {
  id: "synthetic", rls19: {} as AcousticNormPack["rls19"], din4109: {} as AcousticNormPack["din4109"],
  din4109_32: {
    edition: "synthetic",
    masonryWallDensity: [
      { mortar: "normal" as const, factor: 1000, offset: 0, minRdk: 0.5, maxRdk: 2, minExclusive: false, ref: "N" },
      { mortar: "thin_bed" as const, factor: 1000, offset: -200, minRdk: 1, maxRdk: 2, minExclusive: true, ref: "T" },
    ],
    concreteDensityKgM3: { plain: 2000, reinforced: 2500 },
    massLaws: { dense: [segment(20, 0, 50, 1000, "D")], lightweight_concrete: [segment(20, 5, 50, 1000, "L")],
      aerated_concrete: [segment(10, 0, 10, 100, "A1"), segment(20, -10, 100, 400, "A2")] },
    perforated: { maxThicknessMm: 200, clayMinRdkAboveMaxThickness: 1.2, blockMinRdk: 0.9 },
    roundingDecimals: 1,
  },
} as AcousticNormPack;
const wall = { material: "dense" as const, form: "masonry" as const, perforated: "none" as const, thicknessCm: 25, densityKgM3: 1500 };

describe("massive wall Rw from the component catalogue", () => {
  test("masonry with an unknown mortar takes the lowest wall density any mortar allows", () => {
    const result = massiveWallRw(pack, wall);
    // Normal: 1500, thin bed: 1300 → m' = 0.25 · 1300 = 325 kg/m², Rw = 20 · lg 325.
    expect(result).toMatchObject({ status: "calculated", wallDensityKgM3: 1300, massKgM2: 325, refs: ["T", "D"] });
    if (result.status === "calculated") {
      expect(result.rwDb).toBe(Math.round(20 * Math.log10(325) * 10) / 10);
      expect(result.assumptions).toContain("mortar_unknown_lowest");
    }
    // Only one mortar applies at a low density class: no choice to make.
    expect(massiveWallRw(pack, { ...wall, densityKgM3: 800 })).toMatchObject({ wallDensityKgM3: 800, refs: ["N", "D"] });
  });

  test("the mass law segment follows the area mass; outside every segment there is no value", () => {
    const light = massiveWallRw(pack, { ...wall, material: "aerated_concrete", densityKgM3: 600, thicknessCm: 10 }); // 60 kg/m²
    const heavy = massiveWallRw(pack, { ...wall, material: "aerated_concrete", densityKgM3: 600, thicknessCm: 30 }); // 180 kg/m²
    expect(light).toMatchObject({ refs: ["N", "A1"], rwDb: Math.round(10 * Math.log10(60) * 10) / 10 });
    expect(heavy).toMatchObject({ refs: ["N", "A2"], rwDb: Math.round((20 * Math.log10(180) - 10) * 10) / 10 });
    expect(massiveWallRw(pack, { ...wall, material: "aerated_concrete", densityKgM3: 600, thicknessCm: 80 })).toEqual({ status: "unavailable", reason: "mass_out_of_range" });
  });

  test("concrete without a density uses the reinforced default and says so", () => {
    expect(massiveWallRw(pack, { ...wall, form: "concrete", densityKgM3: null, thicknessCm: 20 }))
      .toMatchObject({ status: "calculated", wallDensityKgM3: 2500, massKgM2: 500, assumptions: ["without_plaster", "reinforced_concrete_density"] });
    expect(massiveWallRw(pack, { ...wall, form: "concrete", material: "lightweight_concrete", densityKgM3: null })).toEqual({ status: "unavailable", reason: "density_missing" });
  });

  test("perforated units count as homogeneous only within the catalogue's limits", () => {
    expect(massiveWallRw(pack, { ...wall, perforated: "clay", thicknessCm: 30, densityKgM3: 1000 })).toEqual({ status: "unavailable", reason: "perforated_not_homogeneous" });
    expect(massiveWallRw(pack, { ...wall, perforated: "clay", thicknessCm: 30, densityKgM3: 1200 }).status).toBe("calculated");
    expect(massiveWallRw(pack, { ...wall, perforated: "clay", thicknessCm: 17.5, densityKgM3: 800 }).status).toBe("calculated");
    expect(massiveWallRw(pack, { ...wall, perforated: "block", thicknessCm: 17.5, densityKgM3: 800 })).toEqual({ status: "unavailable", reason: "perforated_not_homogeneous" });
  });

  test("missing inputs or catalogue are reported, never guessed", () => {
    expect(massiveWallRw(pack, { ...wall, densityKgM3: null })).toEqual({ status: "unavailable", reason: "density_missing" });
    expect(massiveWallRw(pack, { ...wall, thicknessCm: null })).toEqual({ status: "unavailable", reason: "thickness_missing" });
    expect(massiveWallRw(pack, { ...wall, densityKgM3: 3000 })).toEqual({ status: "unavailable", reason: "density_class_out_of_range" });
    expect(massiveWallRw({ ...pack, din4109_32: undefined }, wall)).toEqual({ status: "unavailable", reason: "catalogue_missing" });
  });
});
