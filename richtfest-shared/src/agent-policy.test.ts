import { expect, test } from "bun:test";
import { agentPresetConfigSchema, agentPresetSnapshotSchema } from "./agent-policy";

const model = { modelId: "gpt-4.1-mini", maxOutputTokens: 3000, maxSteps: 4 };
const legacy = {
  supervisor: model,
  specialists: { source_reviewer: model, requirements_reviewer: model },
  maxParallel: 2, maxTasks: 3, maxRevisions: 1,
};

test("writer is opt-in and historical preset snapshots retain the supervisor unchanged", () => {
  const config = agentPresetConfigSchema.parse(legacy);
  expect(config).not.toHaveProperty("writer");
  expect(config.supervisor).toEqual(model);
  const snapshot = { ...legacy, effort: "medium", provider: "openai", version: 1, source: "workspace" };
  expect(agentPresetSnapshotSchema.parse(snapshot)).not.toHaveProperty("writer");
  const writer = { ...model, modelId: "writer-model", reasoningEffort: "low" as const };
  expect(agentPresetSnapshotSchema.parse({ ...snapshot, writer }).writer).toEqual(writer);
  expect(agentPresetConfigSchema.parse({ ...legacy, writer }).supervisor).toEqual(model);
});

test("writer uses the same strict model contract without becoming a specialist", () => {
  for (const writer of [null, {}, { ...model, modelId: "bad model" },
    { ...model, maxOutputTokens: 255 }, { ...model, maxOutputTokens: 128001 },
    { ...model, maxSteps: 9 }, { ...model, reasoningEffort: "ultra" }, { ...model, enabled: true }]) {
    expect(agentPresetConfigSchema.safeParse({ ...legacy, writer }).success).toBe(false);
  }
  expect(agentPresetConfigSchema.safeParse({ ...legacy, specialists: { ...legacy.specialists, writer: model } }).success).toBe(false);
});
