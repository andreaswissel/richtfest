import { describe, expect, test } from "bun:test";
import { createEmptySiteAssessmentInput, SITE_ASSESSMENT_CONSTRAINT_KEYS, type SiteAssessmentInput } from "./site-assessment";
import { deviationScenarios, limitEffects, siteTaskProposals } from "./planning-review";

/** Parcel, GRZ, GFZ, footprint, storeys, additional gross and countable area. */
function site(values: [number, number, number, number, number, number, number], basis: SiteAssessmentInput["planningBasis"] = "b_plan"): SiteAssessmentInput {
  const input = createEmptySiteAssessmentInput();
  input.planningBasis = basis;
  SITE_ASSESSMENT_CONSTRAINT_KEYS.forEach((key, i) => (input.constraints[key] = { value: values[i]!, source: "plan", sourceDate: "2026-10-18", kind: "official", reviewed: true }));
  return input;
}

describe("limit effects", () => {
  test("GFZ binding: lifting it reaches the storey envelope; footprint limits report room at the storeys built", () => {
    // 1,000 m², GRZ 0.4 → 400 m² footprint × 4 storeys = 1,600; GFZ 1.2 → 1,200 decides.
    const effects = limitEffects(site([1000, 0.4, 1.2, 500, 4, 0, 0]));
    expect(effects.gfz).toEqual({ kind: "binding", cost: 400 });
    expect(effects.grz).toEqual({ kind: "reserve", reserve: 400 });
    expect(effects.buildableFootprint).toEqual({ kind: "reserve", reserve: 800 });
    expect(effects.maxFullStoreys).toEqual({ kind: "reserve", reserve: 400 });
  });
  test("GRZ and storeys bind together; each reports what lifting it alone adds", () => {
    const effects = limitEffects(site([1000, 0.4, 2, 500, 3, 0, 0]));
    expect(effects.grz).toEqual({ kind: "binding", cost: 300 }); // footprint 500 from the Baugrenze × 3
    expect(effects.maxFullStoreys).toEqual({ kind: "binding", cost: 800 }); // up to GFZ 2.0
    expect(effects.gfz).toEqual({ kind: "reserve", reserve: 800 });
  });
  test("street land: the drawn parcel's extra area is priced at the binding density", () => {
    const effects = limitEffects(site([1000, 0.4, 1.2, 500, 4, 0, 0]), 1100);
    expect(effects.parcelArea).toEqual({ kind: "street_land", cost: 120, area: 100 });
    expect(limitEffects(site([1000, 0.4, 1.2, 500, 4, 0, 0]), 1000.2).parcelArea).toBeUndefined();
  });
  test("no effects without a complete baseline", () => {
    const input = site([1000, 0.4, 1.2, 500, 4, 0, 0]);
    input.constraints.gfz.value = null;
    expect(limitEffects(input)).toEqual({});
  });
});

describe("deviation scenarios", () => {
  test("GFZ binding: a minor overrun, then storeys with the density they need", () => {
    const scenarios = deviationScenarios(site([1000, 0.4, 1.2, 500, 4, 0, 0]));
    expect(scenarios.map((s) => [s.route, s.change, Math.round(s.gain)])).toEqual([
      ["exemption_31_2", { gfz: 1.32 }, 120],
      ["housing_exemption_31_3", { maxFullStoreys: 5, gfz: 2 }, 800],
      ["housing_turbo_246e", { maxFullStoreys: 6, gfz: 2.4 }, 1200],
    ]);
  });
  test("GRZ binding: the minor overrun applies to GRZ and keeps the GFZ that already suffices", () => {
    const [minor, housing] = deviationScenarios(site([1000, 0.4, 2, 500, 3, 0, 0]));
    expect(minor).toMatchObject({ route: "exemption_31_2", change: { grz: 0.44 } });
    expect(Math.round(minor!.gain)).toBe(120);
    expect(housing).toMatchObject({ route: "housing_exemption_31_3", change: { maxFullStoreys: 4, gfz: 2 } });
    expect(Math.round(housing!.gain)).toBe(400);
  });
  test("only the Baugrenze binds: no density or storey route helps", () => {
    // Footprint 300 < GRZ 400; 300 × 4 = 1,200 < GFZ 2,000: the Baugrenze and the storeys bind, so storeys still help.
    const routes = deviationScenarios(site([1000, 0.4, 2, 300, 4, 0, 0])).map((s) => s.route);
    expect(routes).toEqual(["housing_exemption_31_3", "housing_turbo_246e"]);
  });
  test("not offered outside a B-Plan", () => {
    expect(deviationScenarios(site([1000, 0.4, 1.2, 500, 4, 0, 0], "section34"))).toEqual([]);
  });
});

describe("site task proposals", () => {
  test("closed building form asks for the Baulasten because of boundary building", () => {
    const input = site([1000, 0.4, 1.2, 500, 4, 0, 0]);
    input.designRules = { maxHeight: null, heightNotSpecified: false, buildingForm: "closed", source: "", sourceDate: null, reviewed: false };
    expect(siteTaskProposals(input)).toEqual([
      { key: "encumbrances_register", reason: "boundary_building" },
      { key: "land_register_section_2", reason: "rights_open" },
    ]);
  });
  test("nothing before a parcel is known", () => {
    expect(siteTaskProposals(createEmptySiteAssessmentInput())).toEqual([]);
  });
});
