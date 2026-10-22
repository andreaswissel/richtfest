import { describe, expect, test } from "bun:test";
import { assessFirePlan } from "@richtfest/shared/fire-plan";
import { assembleFireProtectionSnapshot } from "./fire-protection";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const building = id(1), storey = id(2), room = id(3), corridor = id(4), wall = id(5), door = id(6), ceiling = id(7);
const pdf = id(20), ifc = id(21), proposalSource = id(22);
const pageEvidence = [{ kind: "page", sourceVersionId: pdf, page: 3 }];
type Input = Parameters<typeof assembleFireProtectionSnapshot>[0];

function property(entityId: string, propertyKey: string, value: unknown) {
  const approved = { version: 2, value, provenance: "extracted", reviewStatus: "approved", evidence: pageEvidence };
  // readModel attaches the same version object as current and reviewed when no newer proposal exists.
  return { entityId, propertyKey, current: approved, reviewed: approved };
}

function fixture(): Input {
  const geometry = (polygon: Array<{ x: number; y: number }>) => ({ source: pageEvidence[0], polygon });
  return {
    model: { id: id(30), revision: 17 },
    buildings: [{ id: building, constructionState: "existing", geometry: { source: { kind: "ifc", sourceVersionId: ifc, expressId: 91, attribute: "Representation" } } }],
    storeys: [{ id: storey, buildingId: building, name: "EG", levelIndex: 0, constructionState: "existing" }],
    rooms: [
      { id: room, storeyId: storey, constructionState: "existing", geometry: geometry([{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.5 }, { x: 0.1, y: 0.5 }]) },
      { id: corridor, storeyId: storey, constructionState: "retained", geometry: geometry([{ x: 0.4, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.6, y: 0.8 }, { x: 0.4, y: 0.8 }]) },
    ],
    elements: [
      { id: wall, storeyId: storey, kind: "draft_wall", constructionState: "existing" },
      { id: ceiling, storeyId: storey, kind: "draft_ceiling", constructionState: "existing" },
      { id: door, storeyId: storey, kind: "door", roomId: room, constructionState: "existing", geometry: geometry([{ x: 0.38, y: 0.25 }, { x: 0.42, y: 0.25 }, { x: 0.42, y: 0.35 }, { x: 0.38, y: 0.35 }]) },
    ],
    properties: [
      property(building, "federalState", "BE"), property(building, "fireHeight", 6.5),
      property(building, "fireDetached", true), property(building, "fireDwellings", 2),
      property(building, "fireOtherUnits", 0), property(building, "fireUsableArea", 240),
      property(storey, "fullStorey", "full"), property(room, "fireRoomRole", "habitable"),
      property(room, "apartmentUnit", "WE-2"), property(corridor, "fireRoomRole", "necessary_corridor"),
      property(corridor, "spaceType", "common_corridor"), property(wall, "loadBearing", false),
    ],
    relationships: [
      { fromEntityId: wall, toEntityId: room, relationshipType: "separates", metadata: { side: 0 }, reviewStatus: "approved" },
      { fromEntityId: wall, toEntityId: corridor, relationshipType: "separates", metadata: { side: 1 }, reviewStatus: "approved" },
      { fromEntityId: door, toEntityId: wall, relationshipType: "opening_in", metadata: null, reviewStatus: "approved" },
    ],
    planSources: [{ storeyId: storey, sourceVersionId: pdf, page: 3, alignmentStatus: "reviewed" }],
    extractions: [{ sourceVersionId: pdf, page: 3, status: "complete", updatedAt: "2026-10-22T10:00:00Z",
      result: { pageScale: { pageAspectRatio: 2, metresPerPageHeight: 10 }, scaleObservation: { status: "confirmed" } } }],
    conflicts: [],
  };
}

function available(data: Input) {
  const result = assembleFireProtectionSnapshot(data);
  expect(result.available).toBe(true);
  if (!result.available) throw new Error(result.reason);
  return result;
}

describe("assembleFireProtectionSnapshot", () => {
  test("assembles saved revision, asymmetric metre geometry, approved adjacency and source links without mutating the model", () => {
    const data = fixture(), before = structuredClone(data);
    const result = available(data), floor = result.plan.storeys[0]!;
    expect(result.modelId).toBe(id(30));
    expect(result.revision).toBe(17);
    expect(result.sourceVersionIds.sort()).toEqual([pdf, ifc].sort());
    expect(result.plan.building.evidence).toContainEqual({ kind: "ifc", sourceId: ifc, expressId: 91, attribute: "Representation" });
    expect(floor.evidence).toEqual([{ kind: "page", sourceId: pdf, page: 3 }]);
    expect(floor.geometryReviewed).toBe(true);
    expect(floor.rooms[0]).toMatchObject({ id: room, role: "habitable", unit: "WE-2", basement: false,
      polygon: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 5 }, { x: 2, y: 5 }] });
    expect(floor.walls[0]).toMatchObject({ id: wall, loadBearing: false, basement: false,
      faces: [{ exterior: false, roomIds: [room] }, { exterior: false, roomIds: [corridor] }] });
    expect(floor.doors[0]!.rooms).toEqual([room, corridor]);
    expect(floor.doors[0]!.point!.x).toBeCloseTo(8);
    expect(floor.doors[0]!.point!.y).toBeCloseTo(3);
    expect(result.plan.building.input.storeysAboveGround).toBe(1);
    expect(result.plan.building.fullStoreys).toBe(1);
    expect(result.blockers).toEqual([]);
    expect(data).toEqual(before);
  });

  test("keeps approved values and their evidence ahead of newer pending proposals", () => {
    const data = fixture();
    const height = data.properties.find(p => p.propertyKey === "fireHeight")!;
    height.current = { version: 3, value: 99, provenance: "inferred", reviewStatus: "proposed",
      evidence: [{ kind: "page", sourceVersionId: proposalSource, page: 9 }] };
    data.properties.push({ entityId: building, propertyKey: "garageArea", reviewed: null, current: height.current });
    const result = available(data);
    expect(result.plan.building.input.height).toBe(6.5);
    expect(result.plan.building.input.garageArea).toBeNull();
    expect(result.properties.find(p => p.key === "fireHeight")).toEqual({ entityId: building, key: "fireHeight",
      version: 2, reviewStatus: "approved", provenance: "extracted", evidence: pageEvidence });
    expect(result.properties.some(p => p.key === "garageArea")).toBe(false);
    expect(result.sourceVersionIds).not.toContain(proposalSource);
    expect(result.blockers).toContain(`${building}: fireHeight has an unaccepted proposal; not used.`);
    expect(result.blockers).toContain(`${building}: garageArea has an unaccepted proposal; not used.`);
  });

  test("unknown level stays unknown even when the storey name suggests a basement", () => {
    const data = fixture();
    Object.assign(data.storeys[0], { levelIndex: null, name: "Kellergeschoss / UG" });
    const result = available(data), floor = result.plan.storeys[0]!;
    expect(result.plan.building.input.storeysAboveGround).toBeNull();
    expect(floor.rooms.every(r => r.basement === null)).toBe(true);
    expect(floor.walls[0]!.basement).toBeNull();
    expect(floor.ceilings[0]!.basement).toBeNull();
  });

  test("uses an explicit negative saved level rather than guessing from the name", () => {
    const data = fixture();
    data.storeys[0]!.levelIndex = -1;
    const result = available(data);
    expect(result.plan.storeys[0]!.rooms[0]!.basement).toBe(true);
    expect(result.plan.building.input.storeysAboveGround).toBe(0);
  });

  for (const mode of ["missing host", "pending host", "missing side", "ambiguous host"] as const) {
    test(`does not infer door adjacency from geometry or roomId with ${mode}`, () => {
      const data = fixture();
      if (mode === "missing host") data.relationships.pop();
      if (mode === "pending host") data.relationships[2]!.reviewStatus = "proposed";
      if (mode === "missing side") data.relationships.splice(1, 1);
      if (mode === "ambiguous host") data.relationships.push({ ...data.relationships[2], toEntityId: ceiling });
      expect(available(data).plan.storeys[0]!.doors[0]!.rooms).toBeNull();
    });
  }

  test("distinguishes confirmed exterior from unknown adjacency", () => {
    const data = fixture();
    Object.assign(data.relationships[1], { relationshipType: "faces_exterior", toEntityId: building });
    expect(available(data).plan.storeys[0]!.doors[0]!.rooms).toEqual([room, null]);
  });

  test("missing scale leaves polygons and door positions unknown and blocks route review", () => {
    const data = fixture();
    delete data.extractions[0]!.result.pageScale;
    data.extractions[0]!.result.scaleObservation.status = "unknown";
    const result = available(data), floor = result.plan.storeys[0]!;
    expect(floor.rooms.every(r => r.polygon === null)).toBe(true);
    expect(floor.doors[0]!.point).toBeNull();
    expect(floor.geometryReviewed).toBe(false);
    expect(result.blockers).toContain(`${storey}: plan alignment/scale not confirmed; routes blocked.`);
  });

  test("a confirmation flag alone cannot mark geometry reviewed when the numeric scale is missing", () => {
    const data = fixture();
    delete data.extractions[0]!.result.pageScale;
    const result = available(data), floor = result.plan.storeys[0]!;
    expect(floor.rooms[0]!.polygon).toBeNull();
    expect(floor.doors[0]!.point).toBeNull();
    expect(floor.geometryReviewed).toBe(false);
    expect(result.blockers).toContain(`${storey}: plan alignment/scale not confirmed; routes blocked.`);
  });

  test("does not borrow scale for geometry linked to a different source revision", () => {
    const data = fixture();
    data.rooms[0]!.geometry.source = { ...pageEvidence[0], sourceVersionId: proposalSource };
    expect(available(data).plan.storeys[0]!.rooms[0]!.polygon).toBeNull();
  });

  test("refuses multiple active buildings but ignores a demolished building", () => {
    const data = fixture();
    data.buildings.push({ id: id(40), constructionState: "existing" });
    expect(assembleFireProtectionSnapshot(data)).toEqual({ available: false,
      reason: "A single active building is required; multiple buildings must not be combined." });
    data.buildings[1]!.constructionState = "demolished";
    expect(available(data).plan.storeys).toHaveLength(1);
  });

  test("preserves an unsupported federal state rather than defaulting to a supported jurisdiction", () => {
    const data = fixture();
    const state = data.properties.find(p => p.propertyKey === "federalState")!;
    state.current.value = state.reviewed.value = "BY";
    const result = available(data);
    expect(result.plan.building.input.state).toBe("BY");
    const assessment = assessFirePlan(result.plan);
    expect(assessment.observations.find(o => o.id === "building:class")!.outcome).toBe("unsupported");
    expect(assessment.concept).toBeNull();
  });

  test("conflicting inputs and unsupported holes cannot produce apparently complete calculations", () => {
    const data = fixture();
    data.properties.push(property(storey, "level", -1));
    data.conflicts.push({ entityId: storey, propertyKey: "level" }, { entityId: building, propertyKey: "fireHeight" });
    data.rooms[0]!.geometry.holes = [[{ x: 0.2, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.25, y: 0.4 }]];
    const result = available(data);
    expect(result.plan.building.input.height).toBeNull();
    expect(result.plan.storeys[0]!.rooms[0]).toMatchObject({ basement: null, polygon: null });
    expect(result.blockers).toContain(`${room}: routes through polygons with holes are unsupported.`);
    expect(assessFirePlan(result.plan).observations.find(o => o.id === `route:${storey}/${room}:length`))
      .toMatchObject({ value: null, outcome: "blocked" });
  });
});
