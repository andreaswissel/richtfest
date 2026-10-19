import { describe, expect, test } from "bun:test";
import { parseGlazing, type AcousticNormPack, type WindowRwInput } from "@richtfest/shared";
import { catalogueWindowRw } from "./window";

// Made-up rows and corrections: these tests check the method's structure, not normative values.
const none = { frameShare: 0, twinSash: 0, fixedGlazing: 0, smallWindow: 0, glazingBars: 0 };
const pack = {
  id: "synthetic", rls19: {} as AcousticNormPack["rls19"], din4109: {} as AcousticNormPack["din4109"],
  din4109_35: {
    edition: "synthetic", equationRef: "Eq",
    insulatingGlass: [
      { rwDb: 20, ref: "R1", glassRwMinDb: 22, buildUp: { totalMinMm: 6, cavityMinMm: 8 }, seals: 0, woodSeals: 0, corrections: none },
      { rwDb: 30, ref: "R2", glassRwMinDb: 31, buildUp: { panesMinMm: [6, 4] as [number, number], cavityMinMm: 14 }, seals: 1, woodSeals: 1,
        corrections: { frameShare: -3, twinSash: -1, fixedGlazing: -2, smallWindow: -1, glazingBars: 0 } },
      { rwDb: 40, ref: "R3", glassRwMinDb: 45, buildUp: null, seals: 2, woodSeals: 1,
        corrections: { frameShare: 0, twinSash: -2, fixedGlazing: 2, smallWindow: -1, glazingBars: -3 } },
    ],
    woodAluminiumDb: -1, largePaneDb: -2, largePaneM2: 3, smallWindowM2: 1.5, frameSharePct: 30,
  },
} as AcousticNormPack;
const known: WindowRwInput = { glassRwDb: null, glazing: null, frame: "plastic", seals: 2, opening: "casement", frameSharePct: 35, glazingBars: false, areaM2: 2 };

describe("window Rw from the window catalogue", () => {
  test("reads glazing build-ups as schedules write them", () => {
    expect(parseGlazing("6/16/4")).toEqual({ panesMm: [6, 4], cavitiesMm: [16] });
    expect(parseGlazing("4 / 12 Ar / 4 / 12 / 44.2 VSG")).toEqual({ panesMm: [4, 4, 8], cavitiesMm: [12, 12] });
    expect(parseGlazing("6,5/16/4")).toEqual({ panesMm: [6.5, 4], cavitiesMm: [16] });
    expect(parseGlazing("6/16")).toBeNull();
    expect(parseGlazing("Schallschutzglas")).toBeNull();
  });

  test("the highest row the glass and the seals meet decides", () => {
    // The glass alone would reach R3; one seal on a plastic frame stops at R2.
    expect(catalogueWindowRw(pack, { ...known, glassRwDb: 46, seals: 1 })).toMatchObject({ status: "calculated", ref: "R2", rwDb: 30 });
    // A wood frame needs fewer seals for R3, and fixed glazing there raises the value.
    expect(catalogueWindowRw(pack, { ...known, glassRwDb: 46, seals: 1, frame: "wood", opening: "fixed" })).toMatchObject({ ref: "R3", rwDb: 42 });
    // Build-up instead of a declared glass Rw: both outer panes and the cavity count, in either orientation.
    expect(catalogueWindowRw(pack, { ...known, glazing: parseGlazing("4/16/6") })).toMatchObject({ ref: "R2", rwDb: 30 });
    expect(catalogueWindowRw(pack, { ...known, glazing: parseGlazing("4/16/4") })).toMatchObject({ ref: "R1", rwDb: 20 });
    expect(catalogueWindowRw(pack, { ...known, glazing: parseGlazing("6/12/4") })).toMatchObject({ ref: "R1" });
    expect(catalogueWindowRw(pack, { ...known, glazing: parseGlazing("2/6/2") })).toEqual({ status: "unavailable", reason: "below_catalogue" });
    expect(catalogueWindowRw(pack, known)).toEqual({ status: "unavailable", reason: "glazing_missing" });
  });

  test("known conditions apply their correction; unknown ones only when they lower the value", () => {
    const small = catalogueWindowRw(pack, { ...known, glassRwDb: 31, frameSharePct: 25, opening: "twin_sash", areaM2: 1.2, frame: "wood_aluminium" });
    expect(small).toMatchObject({ ref: "R2", rwDb: 30 - 1 - 3 - 1 - 1 });
    if (small.status === "calculated") expect(small.corrections.every(item => !item.assumed)).toBe(true);
    // Nothing known: the frame share, the lower of twin sash and fixed glazing, small window and large pane are assumed.
    const unknown = catalogueWindowRw(pack, { glassRwDb: 31, glazing: null, frame: null, seals: null, opening: null, frameSharePct: null, glazingBars: null, areaM2: null });
    expect(unknown).toMatchObject({ ref: "R2", rwDb: 30 - 3 - 2 - 1 - 2, assumptions: ["insulating_glass_single_window", "seals_assumed", "frame_unknown"] });
    if (unknown.status === "calculated") expect(unknown.corrections.map(item => [item.kind, item.assumed])).toEqual([["frame_share", true], ["fixed_glazing", true], ["small_window", true], ["large_pane", true]]);
    // Fixed glazing never takes the frame-share correction; a positive correction is never assumed.
    expect(catalogueWindowRw(pack, { ...known, glassRwDb: 31, opening: "fixed", frameSharePct: 10 })).toMatchObject({ rwDb: 28 });
    expect(catalogueWindowRw(pack, { ...known, glassRwDb: 46, opening: null })).toMatchObject({ ref: "R3", rwDb: 38 });
    // A large window takes the large-pane correction as an assumption.
    expect(catalogueWindowRw(pack, { ...known, glassRwDb: 46, areaM2: 4 })).toMatchObject({ rwDb: 38, corrections: [{ kind: "large_pane", db: -2, assumed: true }] });
  });
});
