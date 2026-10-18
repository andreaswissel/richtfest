import { describe, expect, test } from "bun:test";
import { calculateFeasibility, feasibilityMethod } from "@richtfest/shared";
import { initialStudy } from "./defaults";
import { studyReportPdf } from "./report-pdf";

describe("feasibility defaults", () => {
  test("start from approved building model figures and marked standards", () => {
    const study = initialStudy({ parcelArea: 1000, grz: 0.4, gfz: 1.2, existingGrossFloorArea: 450 });
    expect(study.site.parcelArea).toMatchObject({ value: 1000, source: "building_model", reviewed: false });
    const [existing, densify, newBuild] = study.scenarios;
    expect(newBuild!.values.newGrossFloorArea).toMatchObject({ value: 1200, source: "building_model" });
    expect(densify!.values.newGrossFloorArea).toMatchObject({ value: 750 });
    expect(existing!.values.constructionCost).toBeUndefined();
    expect(newBuild!.values.constructionCost).toMatchObject({ value: 3000, source: "standard", reviewed: false });
  });

  test("leave floor areas empty without an approved GFZ or parcel area", () => {
    const study = initialStudy({ parcelArea: null, grz: null, gfz: null, existingGrossFloorArea: null });
    expect(study.site.parcelArea).toBeUndefined();
    expect(study.scenarios.every(scenario => !scenario.values.newGrossFloorArea)).toBe(true);
  });

  test("fall back to the saved site assessment parcel area, unreviewed, and prefer the building model", () => {
    const assessment = { revision: 2, parcelArea: 995, parcelAreaReviewed: true, countableFloorArea: 1592, status: "indicative" as const };
    const empty = { parcelArea: null, grz: null, gfz: null, existingGrossFloorArea: null };
    expect(initialStudy(empty, assessment).site.parcelArea).toEqual({ value: 995, source: "site_assessment", note: "Grundstücksprüfung r2", reviewed: false });
    expect(initialStudy({ ...empty, parcelArea: 1000 }, assessment).site.parcelArea?.source).toBe("building_model");
  });
});

describe("feasibility report", () => {
  test("renders a PDF for complete and incomplete scenarios", async () => {
    const study = { ...initialStudy({ parcelArea: 1000, grz: 0.4, gfz: 1.2, existingGrossFloorArea: null }), revision: 3, updatedAt: "2026-10-18T10:00:00Z" };
    study.site.acquisitionCostRate = { value: 8, source: "entered", note: null, reviewed: true };
    study.scenarios[2]!.values = { ...study.scenarios[2]!.values, livingAreaRatio: { value: 0.75, source: "entered", note: null, reviewed: true }, salePrice: { value: 7500, source: "entered", note: null, reviewed: true },
      financingRate: { value: 5, source: "entered", note: null, reviewed: true }, marketingRate: { value: 3, source: "entered", note: null, reviewed: true }, profitRate: { value: 15, source: "entered", note: null, reviewed: true } };
    const results = study.scenarios.map(scenario => calculateFeasibility(study.site, scenario));
    expect(results[2]!.status).toBe("complete");
    const pdf = await studyReportPdf({ project: { name: "Giersstraße 20", address: "Giersstraße 20, 14193 Berlin" }, study, results,
      method: feasibilityMethod, language: "de" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5000);
  });
});
