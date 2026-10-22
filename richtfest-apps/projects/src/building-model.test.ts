import { describe, expect, test } from "bun:test";
import { buildingDeepLink, buildingEvidenceSchema, buildingPropertyValueSchema, resolveRoomHeight, validateBuildingComponentProperty } from "@richtfest/shared";

const sourceVersionId = "00000000-0000-4000-8000-000000000001";
const entityId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";

describe("Building Model V1 contracts", () => {
  test("room height inherits without inventing engineering inputs and keeps override review separate", () => {
    const storey = { value: 3.1, provenance: "extracted", reviewStatus: "approved" };
    const room = { value: 2.7, provenance: "inferred", reviewStatus: "unreviewed" };
    expect(resolveRoomHeight()).toMatchObject({ value: 2.6, scope: "default", property: null, calculationValue: null });
    expect(resolveRoomHeight(null, storey)).toMatchObject({ value: 3.1, scope: "storey", calculationValue: 3.1 });
    expect(resolveRoomHeight(room, storey)).toMatchObject({ value: 2.7, scope: "room", calculationValue: null });
    expect(resolveRoomHeight({ ...room, reviewStatus: "approved" }, storey)).toMatchObject({ value: 2.7, calculationValue: 2.7, property: { provenance: "inferred" } });
    for (const cleared of [{ ...room, value: null }, { ...room, reviewStatus: "rejected" }, { ...room, reviewStatus: "superseded" }])
      expect(resolveRoomHeight(cleared, storey)).toMatchObject({ value: 3.1, scope: "storey" });
    expect(validateBuildingComponentProperty("room", "clearRoomHeight", 2.7, "m")).toBeNull();
    expect(validateBuildingComponentProperty("room", "clearRoomHeight", 2.7, "cm")).not.toBeNull();
    expect(validateBuildingComponentProperty("room", "clearRoomHeight", 1.49, "m")).not.toBeNull();
  });

  test("deep links address the shared project workspace and retain stable entity type", () => {
    expect(buildingDeepLink(projectId, "room", entityId)).toBe(`/projects/${projectId}?view=building-model&entity=room:${entityId}`);
  });

  test("page evidence retains source revision, region and page-local layer metadata", () => {
    expect(buildingEvidenceSchema.parse({ kind: "page", sourceVersionId, page: 3,
      region: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 }, layerId: "ocg-7", layerName: "Bestand" })).toMatchObject({ layerId: "ocg-7", layerName: "Bestand" });
    expect(buildingEvidenceSchema.safeParse({ kind: "page", sourceVersionId, page: 3, region: { x: 0, y: 0, width: 0, height: 1 } }).success).toBe(false);
  });

  test("property values are bounded to JSON-like reviewed claims", () => {
    expect(buildingPropertyValueSchema.parse({ roomUse: "unknown" })).toEqual({ roomUse: "unknown" });
    expect(buildingPropertyValueSchema.safeParse(Symbol("not-json")).success).toBe(false);
  });
});
