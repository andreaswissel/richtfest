import { describe, expect, test } from "bun:test";
import { createEmptySiteAssessmentInput } from "@richtfest/shared";
import * as engine from "@richtfest/shared/site-proposals";
import { applySiteSummary } from "../src/components/feasibility/site-summary";
import type { BerlinSiteContext, SiteDiscovery } from "../src/components/feasibility/site-lookups";

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
});
