import { expect, test } from "bun:test";
import { buildingDeepLink } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { validateTool } from "./runs";
import { buildingContextForRun, selectedBuildingObject } from "./building-model-context";

const projectId = "00000000-0000-4000-8000-000000000001";
const entityId = "00000000-0000-4000-8000-000000000002";
const sourceVersionId = "00000000-0000-4000-8000-000000000003";
const deepLink = buildingDeepLink(projectId, "room", entityId);
const evidence = [{ kind: "page" as const, sourceVersionId, page: 2, quote: "Besprechungsraum" }];

test("run context reads corrected reviewed room use and preserves its object identity and evidence", async () => {
  let read: unknown;
  const snapshot = { revision: 7, objects: [{ entityType: "room", entityId, deepLink,
    properties: [{ propertyKey: "use", value: "Meeting room", reviewStatus: "approved", evidence }] }] };
  const deps = { buildingModelContext: async (project: string, selection: unknown) => {
    read = { project, selection };
    return snapshot;
  } } as AppDeps;
  const context = await buildingContextForRun(deps, { projectId, goal: `Inspect [this room](${deepLink})` });
  expect(read).toEqual({ project: projectId, selection: { entityType: "room", entityId } });
  expect(context).toEqual(snapshot);
  const proposal = validateTool("propose_building_model_change", {
    entityType: "room", entityId, baseRevision: 7, propertyKey: "use", value: "Conference room",
    reason: "Clarify the reviewed room designation", evidence,
  });
  expect(proposal).toMatchObject({ entityId, baseRevision: 7, evidence });
});

test("selection never carries a different project's object into project context", () => {
  expect(selectedBuildingObject(projectId, buildingDeepLink(sourceVersionId, "room", entityId))).toBeUndefined();
  expect(selectedBuildingObject(projectId, `${deepLink}garbage`)).toBeUndefined();
});

test("agent proposals require revision and immutable evidence and expose no approval tool", () => {
  const proposal = { entityType: "room", entityId, baseRevision: 7, propertyKey: "use", value: "Meeting room", reason: "Correction", evidence };
  expect(() => validateTool("propose_building_model_change", { ...proposal, evidence: [] })).toThrow();
  expect(() => validateTool("propose_building_model_change", { ...proposal, baseRevision: undefined })).toThrow();
  expect(() => validateTool("propose_building_model_change", { ...proposal, status: "approved" })).toThrow();
  expect(() => validateTool("approve_building_model_change", proposal)).toThrow("not allowlisted");
  expect(() => validateTool("merge_building_objects", proposal)).toThrow("not allowlisted");
});

test("exterior noise suggestions need a cited page and a verification input key", () => {
  const value = { entityType: "element", entityId, propertyKey: "soundReductionIndex", value: 52, unit: "dB", reason: "Baubeschreibung states it", evidence };
  expect(validateTool("propose_exterior_noise_inputs", { values: [value] })).toMatchObject({ values: [value], openings: [] });
  expect(() => validateTool("propose_exterior_noise_inputs", { values: [{ ...value, evidence: [] }] })).toThrow();
  // Only inputs the verification reads; other building facts go through propose_building_model_change.
  expect(() => validateTool("propose_exterior_noise_inputs", { values: [{ ...value, propertyKey: "level" }] })).toThrow();
  expect(() => validateTool("propose_exterior_noise_inputs", {})).toThrow();
  const opening = { roomId: entityId, wallId: entityId, componentType: "window", name: "F 1.01", area: 2.4, reason: "Fensterliste", evidence };
  expect(validateTool("propose_exterior_noise_inputs", { openings: [opening] })).toMatchObject({ openings: [opening] });
  expect(() => validateTool("propose_exterior_noise_inputs", { openings: [{ ...opening, area: 0 }] })).toThrow();
  expect(validateTool("prepare_exterior_noise_nachweis", {})).toEqual({});
  expect(validateTool("suggest_catalogue_values", {})).toEqual({});
  expect(() => validateTool("suggest_catalogue_values", { rwDb: 60 })).toThrow();
});

test("interior sound suggestions take element inputs, never acoustic results", () => {
  const value = { entityType: "element", entityId, propertyKey: "screedStiffness", value: 20, unit: "MN/m³", reason: "Baubeschreibung states s'", evidence };
  expect(validateTool("propose_interior_sound_inputs", { values: [value] })).toMatchObject({ values: [value] });
  // Richtfest computes Rw itself from the element inputs.
  expect(() => validateTool("propose_interior_sound_inputs", { values: [{ ...value, propertyKey: "soundReductionIndex" }] })).toThrow();
  expect(() => validateTool("propose_interior_sound_inputs", { values: [] })).toThrow();
  // A door's tested Rw is the one acoustic value it may state, only with the door it belongs to.
  const door = { roomId: entityId, wallId: entityId, name: "T 0.01", role: "to_dwelling_hallway", rw: 32, basis: "Türliste", reason: "Türliste", evidence };
  expect(validateTool("propose_interior_sound_inputs", { doors: [door] })).toMatchObject({ values: [], doors: [door] });
  expect(() => validateTool("propose_interior_sound_inputs", { doors: [{ ...door, role: "fire_door" }] })).toThrow();
  expect(validateTool("prepare_interior_sound_nachweis", {})).toEqual({});
});
