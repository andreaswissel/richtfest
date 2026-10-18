import { describe, expect, test } from "bun:test";
import { createEmptySiteAssessmentInput } from "@richtfest/shared";
import * as engine from "@richtfest/shared/site-proposals";
import { applySiteSummary, correctReferenceStoreys, mergePlanExtraction, suggestPlanningBasis, parcelReference, proposeFrameFigures, storeysFromHeight } from "../src/components/feasibility/site-summary";
import { planningLawAt, type BerlinSiteContext, type SiteDiscovery } from "../src/components/feasibility/site-lookups";

const X = 397000, Y = 5824000;
const ring = (x: number, y: number, w: number, h: number): [number, number][] => [[X + x, Y + y], [X + x + w, Y + y], [X + x + w, Y + y + h], [X + x, Y + y + h], [X + x, Y + y]];
const { baseRevision: _, ...empty } = createEmptySiteAssessmentInput();
const parcel = (id: string, x: number, containsAddress: boolean) => ({ id, label: `Weißensee · ${id}`, area: 600, sourceDate: "2026-09-01", sourceUrl: "https://gdi.berlin.de/alkis", polygons: [[ring(x, 0, 20, 30)]], containsAddress });
const context = (parcels = [parcel("263/292", 0, true), parcel("263/291", 20, false)], plans: BerlinSiteContext["plans"] = []): BerlinSiteContext =>
  ({ address: "Giersstraße 20", origin: [X + 10, Y + 15], retrievedAt: "2026-10-18T10:00:00Z", parcelStatus: "available", planStatus: "available", parcels, plans });
const metric = (value: number) => ({ value, source: "ALKIS", sourceDate: null, kind: "calculated" as const, reviewed: false });
// Local scene metres: x east of the origin, z south of it.
const local = (r: [number, number][]) => [[r.map(([x, y]) => [x - (X + 10), Y + 15 - y] as [number, number])]];
const discovery = (buildings: [number, number][][]): SiteDiscovery => ({
  address: "Giersstraße 20", origin: [X + 10, Y + 15], longitude: 13.4, latitude: 52.5, retrievedAt: "2026-10-18T10:00:00Z", sources: [], status: ["available"],
  buildings: buildings.map((r, i) => ({ id: `b${i}`, label: `B${i}`, polygons: local(r), height: 9, roof: null }) as SiteDiscovery["buildings"][number]),
  references: [
    { id: "own", label: "On site", source: "s", note: "", parcelId: "263/292", metrics: { grz: metric(0.9), gfz: metric(3) } },
    { id: "r1", label: "Flurstück 9", source: "s", note: "", parcelId: "9", metrics: { grz: metric(0.3), gfz: metric(1.1), storeys: metric(3) } },
    { id: "r2", label: "Falkenberger Straße 145", source: "s", note: "", parcelId: "145", metrics: { grz: metric(0.46), gfz: metric(1.46), storeys: metric(3.5) } },
    { id: "r3", label: "No coverage", source: "s", note: "", parcelId: "7", metrics: { storeys: metric(8) } },
  ],
});

describe("one-click site summary", () => {
  test("§ 34 site: adopts the address parcel, proposes frame, form, hull, upside and massing, all unreviewed", () => {
    const { draft, steps } = applySiteSummary(empty, { context: context(), discovery: discovery([ring(-12, 5, 12, 20), ring(20, 2, 10, 15)]) }, engine, "2026-10-18");
    expect(Object.fromEntries(steps.map((s) => [s.id, s.status]))).toEqual({ parcel: "done", basis: "done", references: "done", frame: "done", form: "done", envelope: "done", upside: "done", massing: "done" });
    expect(draft.geometry!.parcel!.id).toBe("263/292");
    expect(draft.planningBasis).toBe("section34");
    // The site's own parcel and buildings without coverage are not references.
    expect(draft.references.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(draft.references.every((r) => r.note === "")).toBe(true);
    expect(draft.constraints.grz).toMatchObject({ value: 0.46, kind: "estimated", reviewed: false });
    expect(draft.constraints.gfz.value).toBe(1.46);
    // § 19 (4) BauNVO default: 0.46 × 1.5 = 0.69, below the 0.8 cap.
    expect(draft.constraints.grz2).toMatchObject({ value: 0.69, kind: "assessment", reviewed: false });
    expect(draft.constraints.maxFullStoreys.value).toBe(3);
    expect(draft.designRules).toMatchObject({ buildingForm: "closed", reviewed: false });
    // Closed form: east and west on the boundary, north and south 0.4 × 9 m = 3.6 m.
    expect(draft.constraints.buildableFootprint.value).toBeCloseTo(20 * (30 - 7.2), 0);
    expect(draft.upside!.maxFullStoreys).toMatchObject({ value: 4, reviewed: false });
    expect(draft.geometry!.buildings).toHaveLength(1);
    expect(draft.geometry!.buildings[0]!.footprint.reviewed).toBe(false);
  });
  test("reviewed and entered values are never replaced", () => {
    const start = structuredClone(empty);
    start.constraints.grz = { value: 0.38, source: "Vorbescheid", sourceDate: "2026-05-01", kind: "official", reviewed: true };
    start.planningBasis = "section34";
    const { draft, steps } = applySiteSummary(start, { context: context(), discovery: discovery([]) }, engine, "2026-10-18");
    expect(draft.constraints.grz).toEqual(start.constraints.grz);
    expect(steps.find((s) => s.id === "basis")!.status).toBe("kept");
    expect(steps.find((s) => s.id === "form")).toMatchObject({ status: "needs_input", detail: "Form_no_neighbours" });
  });
  test("an ambiguous address stops before anything geometric is guessed", () => {
    const { draft, steps } = applySiteSummary(empty, { context: context([parcel("a", 0, true), parcel("b", 20, true)]), discovery: discovery([]) }, engine, "2026-10-18");
    expect(steps[0]).toMatchObject({ id: "parcel", status: "needs_input", detail: "ParcelAmbiguous" });
    expect(steps.slice(1).every((s) => s.status === "skipped")).toBe(true);
    expect(draft.geometry).toBeUndefined();
  });
  test("an adopted plan covering the address selects B-Plan and asks for its figures", () => {
    const plan = { id: "IV-2c", name: "IV-2c", status: "adopted", sourceUrl: "https://gdi.berlin.de/bplan", documentUrl: null, explanationUrl: null, effectiveDate: null, containsAddress: true };
    const { draft, steps } = applySiteSummary(empty, { context: context(undefined, [plan]), discovery: discovery([]) }, engine, "2026-10-18");
    expect(draft.planningBasis).toBe("b_plan");
    expect(draft.references).toEqual([]);
    expect(steps.find((s) => s.id === "frame")).toMatchObject({ status: "needs_input", detail: "FramePlanMissing" });
    expect(steps.find((s) => s.id === "envelope")).toMatchObject({ status: "needs_input", detail: "EnvelopeNeedsHeight" });
  });
  test("figures read from the covering B-Plan fill the frame, its Bauweise beats the neighbours, and nothing is reviewed", () => {
    const plan = { id: "IV-2c", name: "IV-2c", status: "adopted", sourceUrl: "https://gdi.berlin.de/bplan", documentUrl: "https://fbinter.stadt-berlin.de/iv-2c.pdf", explanationUrl: null, effectiveDate: null, containsAddress: true };
    const cited = (key: string, value: number | string) => ({ key, value: { value, source: `/projects/p?page=1 · proposal x · quote ${key}`, sourceDate: null, kind: "assessment" as const, reviewed: false as const } });
    const extraction = { plan: "IV-2c", status: "extracted" as const, constraints: [cited("grz", 0.4), cited("gfz", 1.2), cited("maxFullStoreys", 3)], facts: [cited("buildingForm", "o (offene Bauweise)")] };
    // Neighbours on both side boundaries would suggest closed form; the plan says open.
    const { draft, steps } = applySiteSummary(empty, { context: context(undefined, [plan]), discovery: discovery([ring(-12, 5, 12, 20), ring(20, 2, 10, 15)]), plan: extraction }, engine, "2026-10-18");
    expect(draft.planningBasis).toBe("b_plan");
    expect(steps.find((s) => s.id === "frame")).toMatchObject({ status: "done", detail: "FramePlanExtracted", values: { items: "grz, gfz, storeys", plan: "IV-2c" } });
    expect(draft.constraints.grz).toMatchObject({ value: 0.4, reviewed: false });
    expect(draft.constraints.maxFullStoreys.value).toBe(3);
    expect(draft.designRules).toMatchObject({ buildingForm: "open", reviewed: false });
    expect(steps.find((s) => s.id === "form")).toMatchObject({ status: "done", detail: "FormPlanOpen" });
    // Open form: every edge keeps max(3, 0.4 × 9 m) = 3.6 m.
    expect(draft.constraints.buildableFootprint.value).toBeCloseTo((20 - 7.2) * (30 - 7.2), 0);
    expect(draft.references).toEqual([]);
  });
  test("an unconfigured provider is reported instead of guessing plan figures", () => {
    const plan = { id: "IV-2c", name: "IV-2c", status: "adopted", sourceUrl: "s", documentUrl: "d", explanationUrl: null, effectiveDate: null, containsAddress: true };
    const { draft, steps } = applySiteSummary(empty, { context: context(undefined, [plan]), discovery: discovery([]), plan: { plan: "IV-2c", status: "unconfigured", constraints: [], facts: [] } }, engine, "2026-10-18");
    expect(steps.find((s) => s.id === "frame")).toMatchObject({ status: "needs_input", detail: "FramePlanUnconfigured" });
    expect(draft.constraints.grz.value).toBeNull();
  });
  test("a plan read on the Planning limits step fills only empty figures and rules, and the register suggests the basis without a parcel", () => {
    const cited = (key: string, value: number | string) => ({ key, value: { value, source: `page 1 · ${key}`, sourceDate: null, kind: "assessment" as const, reviewed: false as const } });
    const entered = { ...empty, planningBasis: "b_plan" as const, constraints: { ...empty.constraints, grz: { value: 0.3, source: "entered", sourceDate: null, kind: "official" as const, reviewed: false } } };
    const { draft, filled } = mergePlanExtraction(entered, { plan: "IV-2c", status: "extracted", constraints: [cited("grz", 0.4), cited("gfz", 1.2)], facts: [cited("roofForm", "Satteldach")] });
    expect(draft.constraints.grz.value).toBe(0.3);
    expect(draft.constraints.gfz).toMatchObject({ value: 1.2, reviewed: false });
    expect(draft.planningFacts?.roofForm?.value).toBe("Satteldach");
    expect(filled).toEqual(["gfz"]);
    expect(entered.constraints.gfz.value).toBeNull();
    const plan = { id: "IV-2c", name: "IV-2c", status: "in_progress", sourceUrl: "s", documentUrl: null, explanationUrl: null, effectiveDate: null, containsAddress: true };
    // Two parcels contain the address, so the summary stops; the basis suggestion still reads the register.
    expect(suggestPlanningBasis(context([parcel("a", 0, true), parcel("b", 20, true)], [plan]))).toMatchObject({ basis: null, detail: "BasisInProgress" });
    expect(suggestPlanningBasis(context([parcel("a", 0, true), parcel("b", 20, true)], [{ ...plan, status: "adopted" }]))).toMatchObject({ basis: "b_plan", values: { plan: "IV-2c" } });
    expect(suggestPlanningBasis({ ...context(), planStatus: "unavailable" })).toBeNull();
  });
  test("open land in the land-use plan stops at a likely § 35 instead of assuming § 34", () => {
    const forest = { id: "f", label: "Wald", purpose: null, category: "open" as const, sourceUrl: "fnp", polygons: [[ring(-100, -100, 300, 300)]], containsAddress: true };
    const { draft, steps } = applySiteSummary(empty, { context: { ...context(), landUse: [forest] }, discovery: discovery([]) }, engine, "2026-10-18");
    expect(steps.find((s) => s.id === "basis")).toMatchObject({ status: "needs_input", detail: "BasisSection35", values: { landUse: "Wald" } });
    // § 35 is proposed as the basis (unreviewed), and no figures or GRZ 2 default are invented for the outer area.
    expect(draft.planningBasis).toBe("section35");
    expect(steps.find((s) => s.id === "frame")).toMatchObject({ status: "needs_input", detail: "FrameSection35" });
    expect(draft.constraints.grz2).toBeUndefined();
    expect(draft.references).toEqual([]);
  });
  test("planning law is decided per point from plan outlines, not from the address flag", () => {
    // The plan covers only the eastern parcel, not the address point in the western one.
    const plan = { id: "IV-2c", name: "IV-2c", status: "adopted", sourceUrl: "s", documentUrl: null, explanationUrl: null, effectiveDate: null, containsAddress: false, polygons: [[ring(20, 0, 20, 30)]] };
    const housing = { id: "w", label: "Wohnbaufläche, W1", purpose: null, category: "building" as const, sourceUrl: "fnp", polygons: [[ring(-100, -100, 300, 300)]], containsAddress: true };
    const c = { ...context(undefined, [plan]), landUse: [housing] };
    expect(planningLawAt(c, [X + 30, Y + 15]).kind).toBe("b_plan");
    expect(planningLawAt(c, [X + 10, Y + 15])).toMatchObject({ kind: "section34", landUse: { label: "Wohnbaufläche, W1" } });
    expect(applySiteSummary(empty, { context: c, discovery: discovery([]) }, engine, "2026-10-18").draft.planningBasis).toBe("section34");
  });
  test("reference plots picked on the map drive the frame; a measured height corrects listed storeys and GFZ", () => {
    const d = discovery([]);
    // Two buildings on parcel 145: GRZ/GFZ are per parcel, storeys and height take the tallest building, footprints add up.
    d.references.push({ id: "r2b", label: "Falkenberger Straße 145 Hof", source: "s", note: "", parcelId: "145", metrics: { grz: metric(0.46), gfz: metric(1.46), storeys: metric(2), footprint: metric(80), ridgeHeight: metric(10.2) } });
    d.references[2]!.metrics!.footprint = metric(200);
    const plot = { ...parcel("145", 40, false) };
    const ref = parcelReference(plot, d)!;
    expect(ref).toMatchObject({ id: "parcel:145", parcelId: "145", metrics: { grz: { value: 0.46 }, storeys: { value: 3.5 }, footprint: { value: 280 }, ridgeHeight: { value: 10.2 } } });
    expect(parcelReference(parcel("7", 60, false), d)).toBeNull();
    // Listed 2 storeys but 10.2 m measured: about 3; GFZ observed as GRZ × storeys scales from 0.76 to 1.14.
    expect(storeysFromHeight(10.2)).toBe(3);
    const listed = { id: "parcel:9", label: "9", source: "s", note: "", parcelId: "9", metrics: { grz: metric(0.38), gfz: metric(0.76), storeys: metric(2) } };
    const corrected = correctReferenceStoreys(listed, 3, "height");
    expect(corrected.metrics).toMatchObject({ storeys: { value: 3, kind: "estimated", reviewed: false }, gfz: { value: 1.14 }, grz: { value: 0.38 } });

    const c = structuredClone(empty.constraints);
    c.gfz = { value: 1.0, source: "Vorbescheid", sourceDate: "2026-05-01", kind: "official", reviewed: false };
    proposeFrameFigures(c, [corrected], engine);
    expect(c.grz).toMatchObject({ value: 0.38, kind: "estimated", reviewed: false });
    expect(c.maxFullStoreys.value).toBe(3);
    // An entered figure is never replaced by the frame, even unreviewed.
    expect(c.gfz.value).toBe(1.0);
    // A changed selection replaces the earlier frame proposal; removing every reference clears it.
    proposeFrameFigures(c, [corrected, ref], engine);
    expect(c.grz.value).toBe(0.46);
    proposeFrameFigures(c, [], engine);
    expect(c.grz.value).toBeNull();
  });
});


describe("planning regime", () => {
  const plan = (effectiveDate: string, extra: Partial<BerlinSiteContext["plans"][number]> = {}) => ({ id: "IV-2c", name: "IV-2c", status: "adopted", sourceUrl: "https://gdi.berlin.de/bplan", documentUrl: "https://example.org/iv-2c.pdf", explanationUrl: null, effectiveDate, containsAddress: true, planType: "Qualifizierter B-Plan", ...extra });
  const cited = (key: string, value: number) => ({ key, value: { value, source: `/projects/p?page=1 · quote ${key}`, sourceDate: null, kind: "assessment" as const, reviewed: false as const } });
  const figures = { plan: "IV-2c", status: "extracted" as const, constraints: [cited("grz", 0.4), cited("gfz", 1.2), cited("maxFullStoreys", 4)], facts: [] };

  test("a plan adopted in 1985 follows BauNVO 1977: no GRZ 2 cap is proposed, and an earlier default is withdrawn", () => {
    const start = structuredClone(empty);
    start.constraints.grz2 = { value: 0.6, source: "berlin_proposals_v1: § 19 (4) BauNVO default (GRZ + 50 %, at most 0.8)", sourceDate: null, kind: "assessment", reviewed: false };
    const { draft } = applySiteSummary(start, { context: context(undefined, [plan("1985-03-12")]), discovery: discovery([]), plan: figures }, engine, "2026-10-18");
    expect(draft.planRegime).toMatchObject({ regime: "b_plan", planType: "qualified", adoptedOn: "1985-03-12", ordinance: "baunvo_1977", reviewed: false });
    expect(draft.constraints.grz2).toBeUndefined();
    expect(draft.constraints.additionalCountableArea.source).toContain("BauNVO 1977");
  });
  test("a plan adopted in 1995 keeps the § 19 (4) default; a court finding makes the basis need a person", () => {
    const { draft, steps } = applySiteSummary(empty, { context: context(undefined, [plan("1995-06-01", { courtReview: "teilunwirksam" })]), discovery: discovery([]), plan: figures }, engine, "2026-10-18");
    expect(draft.planRegime).toMatchObject({ ordinance: "baunvo_1990", courtReview: "teilunwirksam" });
    expect(draft.constraints.grz2).toMatchObject({ value: 0.6, reviewed: false });
    expect(steps.find((s) => s.id === "basis")).toMatchObject({ status: "needs_input", detail: "BasisBPlanCourtReview" });
  });
  test("a reviewed regime is never replaced by the register", () => {
    const start = structuredClone(empty);
    start.planningBasis = "b_plan";
    start.planRegime = { regime: "b_plan", planType: "qualified", planName: "IV-2c", adoptedOn: "1985-03-12", ordinance: "baunvo_1968", buildingClass: null, courtReview: null, source: "Begründung S. 4: öffentliche Auslegung 1976", sourceDate: "1985-03-12", reviewed: true };
    const { draft } = applySiteSummary(start, { context: context(undefined, [plan("1985-03-12")]), discovery: discovery([]), plan: figures }, engine, "2026-10-18");
    expect(draft.planRegime).toEqual(start.planRegime);
  });
  test("former West Berlin without a newer plan: Baunutzungsplan, figures and form from the building class", () => {
    const kreuzberg = { ...context(), locality: { name: "Kreuzberg", key: "110000020202", sourceUrl: "ortsteile" } };
    const first = applySiteSummary(empty, { context: kreuzberg, discovery: discovery([]) }, engine, "2026-10-18");
    expect(first.draft.planningBasis).toBe("b_plan");
    expect(first.draft.planRegime).toMatchObject({ regime: "baunutzungsplan", ordinance: "bo_58", buildingClass: null });
    expect(first.steps.find((s) => s.id === "basis")).toMatchObject({ status: "done", detail: "BasisBaunutzungsplan", values: { locality: "Kreuzberg" } });
    expect(first.steps.find((s) => s.id === "frame")).toMatchObject({ status: "needs_input", detail: "FrameBuildingClass" });
    expect(first.draft.constraints.grz2).toBeUndefined();
    // The person reads V/3 from the map; a second run proposes its figures and closed form.
    const start = { ...first.draft, planRegime: { ...first.draft.planRegime!, buildingClass: "V/3" as const } };
    const { draft } = applySiteSummary(start, { context: kreuzberg, discovery: discovery([]) }, engine, "2026-10-18");
    expect(draft.constraints.grz).toMatchObject({ value: 0.3, kind: "official", reviewed: false });
    expect(draft.constraints.gfz.value).toBe(1.5);
    expect(draft.constraints.maxFullStoreys.value).toBe(5);
    expect(draft.designRules).toMatchObject({ buildingForm: "closed", reviewed: false });
  });
  test("east of the former border, building land without a plan stays § 34", () => {
    const friedrichshain = { ...context(), locality: { name: "Friedrichshain", key: "110000020201", sourceUrl: "ortsteile" } };
    expect(planningLawAt(friedrichshain, friedrichshain.origin).kind).not.toBe("baunutzungsplan");
    const { draft } = applySiteSummary(empty, { context: friedrichshain, discovery: discovery([]) }, engine, "2026-10-18");
    expect(draft.planningBasis).toBe("section34");
    expect(draft.planRegime).toBeUndefined();
  });
});
