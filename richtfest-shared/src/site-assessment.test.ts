import { describe, expect, test } from "bun:test";
import { calculateSiteAssessment, createEmptySiteAssessmentInput, siteAssessmentInputSchema, SITE_ASSESSMENT_CONSTRAINT_KEYS, type SiteAssessmentInput } from "./site-assessment";

function fixture(numbers: number[]): SiteAssessmentInput {
  const input = createEmptySiteAssessmentInput();
  input.planningBasis = "b_plan";
  SITE_ASSESSMENT_CONSTRAINT_KEYS.forEach((key, i) => { input.constraints[key] = { value: numbers[i]!, source: "Synthetic test assumption; not verified project evidence", sourceDate: "2026-10-18", kind: "assessment", reviewed: true }; });
  for (const key of Object.keys(input.checks) as (keyof typeof input.checks)[]) input.checks[key] = { status: "confirmed", note: "Synthetic check for arithmetic acceptance only", source: "Test fixture" };
  return input;
}
describe("Berlin arithmetic envelope capacity", () => {
  test("Giers: derived parcel assumption, GRZ footprint and non-countable additional storey", () => {
    const input = fixture([375 / .38, .38, 1.28, 400, 3, 348, 0]);
    input.planningBasis = "section34";
    input.references = ["Flurstück 9", "Falkenberger Straße 145"].map((label, i) => ({ id: `reported-${i}`, label, source: "User-reported comparison; synthetic acceptance fixture, not independently verified", note: "Illustrates the reported comparison only; no statutory GRZ/GFZ entitlement inferred" }));
    input.constraints.parcelArea.kind = "calculated";
    input.constraints.parcelArea.source = "Derived solely for fixture: reported 375 m² footprint / 0.38 GRZ; not surveyed parcel area";
    input.constraints.buildableFootprint.source = "Illustrative 400 m² envelope assumption; not project evidence";
    const result = calculateSiteAssessment(input);
    expect(result.status).toBe("reviewed");
    expect(result.limitations).toContain("section34_comparison_only");
    expect(result.baseline!.grossFloorArea).toBeCloseTo(1473);
    expect(result.baseline!.countableFloorArea).toBeCloseTo(1125);
    expect(result.baseline!.bindingConstraints).toEqual(["grz", "maxFullStoreys"]);
  });
  test("Eldena: envelope and four storeys control despite unused theoretical GFZ; five storeys separate", () => {
    const input = fixture([1041, .5, 1.6, 1041 * 1.27 / 4, 4, 0, 0]);
    input.constraints.buildableFootprint.kind = "calculated";
    input.constraints.buildableFootprint.source = "Derived for fixture from reported approved GFZ 1.27 / four storeys, not measured envelope";
    input.upside = { maxFullStoreys: { ...input.constraints.maxFullStoreys, value: 5, reviewed: false }, note: "Exception requires separate review" };
    const result = calculateSiteAssessment(input);
    expect(result.baseline!.grossFloorArea).toBeCloseTo(1322.07);
    expect(result.baseline!.gfzCapacity).toBeCloseTo(1665.6);
    expect(result.baseline!.unusedGfzCapacity).toBeCloseTo(343.53);
    expect(result.baseline!.bindingConstraints).toEqual(["buildableFootprint", "maxFullStoreys"]);
    expect(result.upside!.grossFloorArea).toBeCloseTo(1652.5875);
    expect(result.upsideStatus).toBe("indicative");
    expect(result.limitations).toContain("upside_requires_separate_review");
  });
  test("all tied limits retained with dimensional units", () => {
    const result = calculateSiteAssessment(fixture([1000, .4, 1.2, 400, 3, 0, 0]));
    expect(result.baseline!.bindingConstraints).toEqual(["grz", "buildableFootprint", "maxFullStoreys", "gfz"]);
    expect(result.baseline!.limits.map(l => l.unit)).toEqual(["footprint_m2", "footprint_m2", "full_floor_m2", "full_floor_m2"]);
  });
  test("countable additional area consumes GFZ while gross additional area remains separate", () => {
    const result = calculateSiteAssessment(fixture([1000, .5, 1, 500, 3, 300, 200]));
    expect(result.baseline!.fullFloorArea).toBe(800);
    expect(result.baseline!.countableFloorArea).toBe(1000);
    expect(result.baseline!.grossFloorArea).toBe(1100);
    expect(result.baseline!.bindingConstraints).toEqual(["gfz"]);
  });
  test("missing explicit zero prevents calculation", () => {
    const input = fixture([1000, .4, 1.2, 400, 3, 0, 0]);
    input.constraints.additionalGrossArea.value = null;
    expect(calculateSiteAssessment(input).baseline).toBeNull();
    expect(calculateSiteAssessment(input).status).toBe("incomplete");
  });
  test("unreviewed, undated or unsourced numeric evidence prevents reviewed status", () => {
    for (const change of [{ reviewed: false }, { source: " " }, { sourceDate: null }]) {
      const input = fixture([1000, .4, 1.2, 400, 3, 0, 0]);
      Object.assign(input.constraints.grz, change);
      expect(calculateSiteAssessment(input).status).toBe("indicative");
    }
  });
  test("unresolved or unevidenced checks prevent reviewed status", () => {
    for (const change of [{ status: "unresolved" }, { source: "" }, { note: "" }]) {
      const input = fixture([1000, .4, 1.2, 400, 3, 0, 0]);
      Object.assign(input.checks.height, change);
      expect(calculateSiteAssessment(input).status).toBe("indicative");
    }
  });
  test("section34 labels ratios as comparisons and unresolved basis cannot be reviewed", () => {
    const input = fixture([1000, .4, 1.2, 400, 3, 0, 0]); input.planningBasis = "section34";
    expect(calculateSiteAssessment(input).limitations).toContain("section34_comparison_only");
    expect(calculateSiteAssessment(input).status).toBe("indicative");
    input.references = [{ id: "ref", label: "Comparator", source: "", note: "Comparison assessment" }];
    expect(calculateSiteAssessment(input).status).toBe("indicative");
    input.references[0]!.source = "Synthetic comparator source";
    expect(calculateSiteAssessment(input).status).toBe("reviewed");
    input.planningBasis = "unresolved";
    expect(calculateSiteAssessment(input).status).toBe("indicative");
  });
  test("invalid values, dates and non-Berlin jurisdiction are rejected", () => {
    for (const [key, value] of [["grz", 1.1], ["parcelArea", 0], ["gfz", -1], ["maxFullStoreys", 2.5], ["additionalGrossArea", Infinity]] as const) {
      const input = fixture([1000, .4, 1.2, 400, 3, 0, 0]); input.constraints[key].value = value;
      expect(siteAssessmentInputSchema.safeParse(input).success).toBe(false);
      expect(calculateSiteAssessment(input).baseline).toBeNull();
    }
    const input = fixture([1000, .4, 1.2, 400, 3, 0, 0]); input.constraints.grz.sourceDate = "2026-02-30";
    expect(siteAssessmentInputSchema.safeParse(input).success).toBe(false);
    expect(siteAssessmentInputSchema.safeParse({ ...createEmptySiteAssessmentInput(), jurisdiction: "HH" }).success).toBe(false);
  });
  test("inconsistent additional area and negative remaining GFZ capacity cannot yield results", () => {
    expect(calculateSiteAssessment(fixture([1000, .4, 1, 400, 3, 100, 200])).limitations).toContain("inconsistent_extra_area");
    const result = calculateSiteAssessment(fixture([1000, .4, .1, 400, 3, 200, 200]));
    expect(result.baseline).toBeNull(); expect(result.limitations).toContain("extra_area_exceeds_gfz");
  });
});
