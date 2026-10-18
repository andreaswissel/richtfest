import { describe, expect, test } from "bun:test";
import { zoningChecks, zoningLimits } from "./building-components";

const approved = (value: unknown) => ({ value, reviewStatus: "approved" });
const limits = zoningLimits({ bebauungsplanGrz: approved("0,4"), bebauungsplanGfz: approved("1,2"), bebauungsplanStoreys: approved("höchstens III") });
const site = { id: "b1", properties: { parcelArea: approved(1000), footprintArea: approved(380), storeyInventory: approved("complete"), gfzCountingBasis: approved("full_storeys_only") } };
const storey = (id: string, full: string, area?: number) => ({ id, properties: { fullStorey: approved(full), ...(area ? { grossFloorArea: approved(area) } : {}) } });

describe("zoningChecks", () => {
  test("compares approved inputs with the approved limits", () => {
    const checks = zoningChecks({ limits, site, buildings: [site], storeys: [storey("eg", "full", 380), storey("og1", "full", 380), storey("og2", "full", 380), storey("dg", "not_full")] });
    expect(checks.find(check => check.key === "grz")).toMatchObject({ actual: 0.38, limit: 0.4, status: "within" });
    expect(checks.find(check => check.key === "gfz")).toMatchObject({ limit: 1.2, status: "within" });
    expect(checks.find(check => check.key === "gfz")!.actual).toBeCloseTo(1.14, 6);
    expect(checks.find(check => check.key === "fullStoreys")).toMatchObject({ actual: 3, limit: 3, status: "within" });
  });

  test("flags an exceeded limit and sums every building's Grundfläche", () => {
    const annex = { id: "b2", properties: { footprintArea: approved(60), storeyInventory: approved("complete") } };
    const checks = zoningChecks({ limits, site, buildings: [site, annex], storeys: [...[storey("eg", "full", 440), storey("og1", "full", 400), storey("og2", "full", 400), storey("og3", "full", 300)].map(floor => ({ ...floor, buildingId: site.id })), { ...storey("annex", "not_full"), buildingId: annex.id }] });
    expect(checks.find(check => check.key === "grz")).toMatchObject({ actual: 0.44, status: "exceeds" });
    expect(checks.find(check => check.key === "gfz")).toMatchObject({ status: "exceeds" });
    expect(checks.find(check => check.key === "fullStoreys")).toMatchObject({ actual: 4, status: "exceeds" });
  });

  test("counts Vollgeschosse per building", () => {
    const tall = (id: string, buildingId: string) => ({ ...storey(id, "full", 100), buildingId });
    const checks = zoningChecks({ limits, site, buildings: [{ ...site, id: "a" }, { ...site, id: "b" }], storeys: [tall("a1", "a"), tall("a2", "a"), tall("a3", "a"), tall("b1", "b"), tall("b2", "b")] });
    expect(checks.find(check => check.key === "fullStoreys")).toMatchObject({ actual: 3, status: "within" });
  });

  test("stays incomplete with unreviewed inputs, undecided storeys or no single limit", () => {
    const unreviewedSite = { id: "b1", properties: { ...site.properties, parcelArea: { value: 1000, reviewStatus: "unreviewed" } } };
    const checks = zoningChecks({ limits, site: unreviewedSite, buildings: [unreviewedSite], storeys: [storey("eg", "full", 380), { id: "og1", properties: {} }] });
    expect(checks.every(check => check.status === "incomplete")).toBe(true);
    expect(checks.find(check => check.key === "grz")!.gaps).toEqual([{ field: "parcelArea", entityType: "building", entityId: "b1", status: "unreviewed" }]);
    expect(checks.find(check => check.key === "fullStoreys")!.gaps).toEqual([{ field: "fullStorey", entityType: "storey", entityId: "og1", status: "missing" }]);
    const perField = zoningLimits({ bebauungsplanGrz: approved("0,4 (WA 1) · 0,35 (WA 2)") });
    expect(zoningChecks({ limits: perField, site, buildings: [site], storeys: [] })[0]).toMatchObject({ limit: null, actual: 0.38, status: "incomplete" });
  });

  test("every active building needs a reviewed complete inventory, independently of GRZ", () => {
    for (const inventory of [undefined, approved("incomplete"), approved("complete"), { value: "complete", reviewStatus: "unreviewed" }]) {
      const annex = { id: "annex", properties: { footprintArea: approved(10), storeyInventory: inventory } };
      const checks = zoningChecks({ limits, site, buildings: [site, annex], storeys: [{ ...storey("eg", "full", 380), buildingId: site.id }] });
      expect(checks[0].status).toBe("within");
      expect(checks.slice(1).every(check => check.status === "incomplete" && check.actual === null)).toBe(true);
      expect(checks[2].gaps[0]).toMatchObject({ entityId: "annex", field: "storeyInventory" });
    }
  });

  test("reviewed GFZ basis and countable other-storey areas control the boundary", () => {
    const input = { limits: { ...limits, gfz: 0.4 }, site, buildings: [site], storeys: [storey("eg", "full", 380), storey("dg", "not_full")] };
    expect(zoningChecks(input)[1]).toMatchObject({ actual: 0.38, status: "within" });
    const included = { ...site, properties: { ...site.properties, gfzCountingBasis: approved("include_other_storeys") } };
    const check = (area?: number, reviewStatus = "approved") => zoningChecks({ ...input, site: included, storeys: [input.storeys[0]!, { ...input.storeys[1]!, properties: { ...input.storeys[1]!.properties, ...(area === undefined ? {} : { countableFloorArea: { value: area, reviewStatus } }) } }] })[1];
    expect(check()).toMatchObject({ actual: null, status: "incomplete" });
    expect(check(0)).toMatchObject({ actual: 0.38, status: "within" });
    expect(check(20)).toMatchObject({ actual: 0.4, status: "within" });
    expect(check(21)).toMatchObject({ actual: 0.401, status: "exceeds" });
    expect(check(21, "unreviewed")).toMatchObject({ actual: null, status: "incomplete" });
    const undecided = { ...site, properties: { ...site.properties, gfzCountingBasis: { value: "full_storeys_only", reviewStatus: "unreviewed" } } };
    expect(zoningChecks({ ...input, site: undecided })[1].status).toBe("incomplete");
  });

  test("mandatory, minimum and ranged storeys are not treated as maxima", () => {
    for (const value of ["zwingend II", "mindestens II", "II–III", "II (WA 1)"]) {
      expect(zoningLimits({ bebauungsplanStoreys: approved(value) }).maxFullStoreys).toBeNull();
    }
  });

  test("unreviewed classification cannot silently remove a floor from GFZ", () => {
    for (const value of ["full", "not_full"]) {
      const checks = zoningChecks({ limits, site, buildings: [site], storeys: [storey("eg", "full", 380),
        { id: "dg", properties: { fullStorey: { value, reviewStatus: "unreviewed" }, grossFloorArea: approved(200) } }] });
      expect(checks[0].status).toBe("within");
      expect(checks[1]).toMatchObject({ actual: null, status: "incomplete" });
      expect(checks[2]).toMatchObject({ actual: null, status: "incomplete" });
    }
  });
});
