import { describe, expect, test } from "bun:test";
import { zoningChecks, zoningLimits } from "./building-components";

const approved = (value: unknown) => ({ value, reviewStatus: "approved" });
const limits = zoningLimits({ bebauungsplanGrz: approved("0,4"), bebauungsplanGfz: approved("1,2"), bebauungsplanStoreys: approved("höchstens III") });
const site = { id: "b1", properties: { parcelArea: approved(1000), footprintArea: approved(380) } };
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
    const annex = { id: "b2", properties: { footprintArea: approved(60) } };
    const checks = zoningChecks({ limits, site, buildings: [site, annex], storeys: [storey("eg", "full", 440), storey("og1", "full", 400), storey("og2", "full", 400), storey("og3", "full", 300)] });
    expect(checks.find(check => check.key === "grz")).toMatchObject({ actual: 0.44, status: "exceeds" });
    expect(checks.find(check => check.key === "gfz")).toMatchObject({ status: "exceeds" });
    expect(checks.find(check => check.key === "fullStoreys")).toMatchObject({ actual: 4, status: "exceeds" });
  });

  test("counts Vollgeschosse per building", () => {
    const tall = (id: string, buildingId: string) => ({ ...storey(id, "full", 100), buildingId });
    const checks = zoningChecks({ limits, site, buildings: [site], storeys: [tall("a1", "a"), tall("a2", "a"), tall("a3", "a"), tall("b1", "b"), tall("b2", "b")] });
    expect(checks.find(check => check.key === "fullStoreys")).toMatchObject({ actual: 3, status: "within" });
  });

  test("stays incomplete with unreviewed inputs, undecided storeys or no single limit", () => {
    const unreviewedSite = { id: "b1", properties: { parcelArea: { value: 1000, reviewStatus: "unreviewed" }, footprintArea: approved(380) } };
    const checks = zoningChecks({ limits, site: unreviewedSite, buildings: [unreviewedSite], storeys: [storey("eg", "full", 380), { id: "og1", properties: {} }] });
    expect(checks.every(check => check.status === "incomplete")).toBe(true);
    expect(checks.find(check => check.key === "grz")!.gaps).toEqual([{ field: "parcelArea", entityType: "building", entityId: "b1", status: "unreviewed" }]);
    expect(checks.find(check => check.key === "fullStoreys")!.gaps).toEqual([{ field: "fullStorey", entityType: "storey", entityId: "og1", status: "missing" }]);
    const perField = zoningLimits({ bebauungsplanGrz: approved("0,4 (WA 1) · 0,35 (WA 2)") });
    expect(zoningChecks({ limits: perField, site, buildings: [site], storeys: [] })[0]).toMatchObject({ limit: null, actual: 0.38, status: "incomplete" });
  });
});
