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
