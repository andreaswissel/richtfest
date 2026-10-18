import { describe, expect, test } from "bun:test";
import { createEmptySiteAssessmentInput } from "./site-assessment";
import { calculateSiteGeometry, createDefaultSetbacks, type GeometryEvidence, type GeometryMultiPolygon } from "./site-geometry";
import type { SiteGeometryInput } from "./site-geometry-model";
import { bestMassing, inferBuildingForm, proposeEnvelope, referenceFrame, type NeighbourBuilding } from "./site-proposals";

const X = 392000, Y = 5820000;
const rect = (x: number, y: number, w: number, h: number): GeometryMultiPolygon => [[[[X + x, Y + y], [X + x + w, Y + y], [X + x + w, Y + y + h], [X + x, Y + y + h], [X + x, Y + y]]]];
const parcel: GeometryEvidence = { id: "parcel", label: "263/292", geometry: rect(0, 0, 20, 30), source: "ALKIS", sourceDate: "2026-10-18", reviewed: false };
const neighbour = (id: string, geometry: GeometryMultiPolygon): NeighbourBuilding => ({ id, label: id, polygons: geometry });
// Ring order (0,0)→(20,0)→(20,30)→(0,30): edge 0 south, 1 east, 2 north, 3 west.
const SOUTH = "edge-0-0-0", EAST = "edge-0-0-1", NORTH = "edge-0-0-2", WEST = "edge-0-0-3";

describe("building form from neighbouring footprints", () => {
  test("neighbours on both lateral boundaries propose closed form on exactly those edges", () => {
    const r = inferBuildingForm(parcel, [neighbour("w", rect(-12, 5, 12, 20)), neighbour("e", rect(20.3, 2, 10, 15))]);
    expect(r.form).toBe("closed");
    expect(r.builtTo.sort()).toEqual([EAST, WEST]);
    expect(r.edges.find((e) => e.id === WEST)!.contact).toBeCloseTo(20, 6);
    expect(r.edges.find((e) => e.id === EAST)!.contact).toBeCloseTo(15, 6);
  });
  test("neighbours keeping a distance propose open form", () => {
    const r = inferBuildingForm(parcel, [neighbour("w", rect(-16, 5, 12, 12)), neighbour("e", rect(24, 5, 10, 10))]);
    expect(r).toMatchObject({ form: "open", reason: "free_standing_neighbours", builtTo: [] });
    expect(r.edges.find((e) => e.id === WEST)!.distance).toBeCloseTo(4, 6);
  });
  test("one-sided contact and short garage corners stay unresolved", () => {
    expect(inferBuildingForm(parcel, [neighbour("w", rect(-12, 5, 12, 20)), neighbour("e", rect(24, 5, 10, 10))])).toMatchObject({ form: "unresolved", reason: "built_to_one_boundary", builtTo: [WEST] });
    expect(inferBuildingForm(parcel, [neighbour("garage", rect(-6, 5, 6, 2)), neighbour("e", rect(20, 10, 6, 2))]).form).toBe("open");
  });
  test("existing stock on the site is not a neighbour", () => {
    expect(inferBuildingForm(parcel, [neighbour("own", rect(-0.5, 2, 15, 20))])).toMatchObject({ form: "unresolved", reason: "no_neighbours", neighbours: 0 });
  });
});

describe("envelope proposal", () => {
  const input = (storeys: number | null) => {
    const base = createEmptySiteAssessmentInput();
    base.constraints.maxFullStoreys.value = storeys;
    return { ...base, geometry: { ...base.geometry!, ...emptyGeometry(), parcel } };
  };
  const emptyGeometry = (): SiteGeometryInput => ({ version: 1 as const, crs: "EPSG:25833" as const, parcel: null, envelope: null, exclusions: [], exclusionsReviewed: false, setbacks: [], buildings: [], mandatoryLines: [], planOverlay: null });

  test("open form insets every edge by 0.4 H from the full storeys", () => {
    const r = proposeEnvelope(input(4), null);
    if (!r.ok) throw new Error(r.reason);
    // H = 4 × 3 m = 12 m → 4.8 m on all sides; capsule overcut is at most 1 mm.
    expect(r.usableArea).toBeLessThanOrEqual(10.4 * 20.4 + 1e-6);
    expect(r.usableArea).toBeGreaterThan(10.4 * 20.4 - 0.1);
    expect(r).toMatchObject({ height: 12, heightBasis: "full_storeys", envelopeBasis: "parcel" });
    expect(r.geometry.setbacks.every((e) => !e.reviewed && e.profile === "standard" && e.assessmentHeight === 12)).toBe(true);
  });
  test("closed form puts the building on the built-to boundaries only", () => {
    const form = inferBuildingForm(parcel, [neighbour("w", rect(-12, 5, 12, 20)), neighbour("e", rect(20, 2, 10, 15))]);
    const r = proposeEnvelope(input(4), form);
    if (!r.ok) throw new Error(r.reason);
    expect(r.usableArea).toBeGreaterThan(20 * 20.4 - 0.1);
    expect(r.usableArea).toBeLessThanOrEqual(20 * 20.4 + 1e-6);
    expect(r.geometry.setbacks.filter((e) => e.profile === "boundary_exception").map((e) => e.id).sort()).toEqual([EAST, WEST]);
  });
  test("a confirmed maximum height wins and the 3 m minimum applies", () => {
    const tall = { ...input(4), designRules: { maxHeight: 9, heightNotSpecified: false, buildingForm: "unresolved" as const, source: "B-Plan", sourceDate: null, reviewed: false } };
    const r = proposeEnvelope(tall, null);
    if (!r.ok) throw new Error(r.reason);
    expect(r).toMatchObject({ height: 9, heightBasis: "max_height" });
    expect(r.usableArea).toBeCloseTo((20 - 7.2) * (30 - 7.2), 0);
    const low = proposeEnvelope(input(2), null);
    if (!low.ok) throw new Error(low.reason);
    // 0.4 × 6 m = 2.4 m, so the 3 m minimum governs.
    expect(low.usableArea).toBeCloseTo(14 * 24, 0);
  });
  test("reviewed setbacks and a traced Baugrenze are kept", () => {
    const traced = input(4);
    traced.geometry.envelope = { id: "baugrenze", label: "Baugrenze", geometry: rect(2, 2, 16, 26), source: "Plan IV-2c", sourceDate: "2025-04-03", reviewed: true };
    const reviewedEdge = { ...createDefaultSetbacks(parcel, 1)[0]!, source: "Reviewed", sourceDate: "2026-10-18", reviewed: true };
    traced.geometry.setbacks = [reviewedEdge];
    const r = proposeEnvelope(traced, null);
    if (!r.ok) throw new Error(r.reason);
    expect(r.envelopeBasis).toBe("traced");
    expect(r.geometry.envelope!.id).toBe("baugrenze");
    expect(r.geometry.setbacks.find((e) => e.id === SOUTH)).toEqual(reviewedEdge);
    expect(r.geometry.setbacks.find((e) => e.id === NORTH)!.reviewed).toBe(false);
  });
  test("missing parcel or height is reported instead of guessed", () => {
    expect(proposeEnvelope(input(null), null)).toEqual({ ok: false, reason: "needs_height" });
    expect(proposeEnvelope({ ...input(4), geometry: null }, null)).toEqual({ ok: false, reason: "needs_parcel" });
  });
  test("best massing stays inside the proposed hull", () => {
    const r = proposeEnvelope(input(4), null);
    if (!r.ok) throw new Error(r.reason);
    const massing = bestMassing(r.geometry, { grz: 0.4, gfz: 1.2, maxFullStoreys: 4, storeyHeight: 3 });
    expect(massing).not.toBeNull();
    const check = calculateSiteGeometry({ ...r.geometry, buildings: [massing!.building] });
    expect(check.buildings[0]!.outsideArea).toBeLessThan(0.001);
  });
});

test("§ 34 frame spans mean to maximum of the selected references", () => {
  const metric = (value: number) => ({ value, source: "ALKIS", sourceDate: null, kind: "calculated" as const, reviewed: false });
  const frame = referenceFrame([
    { id: "a", label: "Flurstück 9", source: "s", note: "", metrics: { grz: metric(0.3), gfz: metric(1.1), storeys: metric(3) } },
    { id: "b", label: "Falkenberger Straße 145", source: "s", note: "", metrics: { grz: metric(0.46), gfz: metric(1.46) } },
  ]);
  expect(frame.grz).toEqual({ mean: 0.38, max: 0.46, count: 2 });
  expect(frame.gfz!.mean).toBeCloseTo(1.28, 10);
  expect(frame.storeys).toEqual({ mean: 3, max: 3, count: 1 });
});
