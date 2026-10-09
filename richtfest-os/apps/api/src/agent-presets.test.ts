import { describe, expect, test } from "bun:test";
import { agentPresetConfigSchema } from "@richtfest/shared";
import { isConfiguredPreset, isGatewayModelId, vendorPreset } from "./agent-presets";

describe("agent provider presets", () => {
  test("requires provider/model IDs for the Vercel Gateway", () => {
    expect(isGatewayModelId("openai/gpt-4.1-mini")).toBe(true);
    expect(isGatewayModelId("gpt-4.1-mini")).toBe(false);
    expect(isGatewayModelId("/gpt-4.1-mini")).toBe(false);
  });

  test("keeps an empty Vercel vendor model deliberately unconfigured", () => {
    const preset = vendorPreset("vercel", "medium");
    expect(preset.supervisor.modelId).toBe("");
    expect(isGatewayModelId(preset.supervisor.modelId)).toBe(false);
  });

  test("uses the legacy OpenAI project model for both vendor roles", () => {
    const previous = process.env.OPENAI_PROJECT_MODEL;
    process.env.OPENAI_PROJECT_MODEL = "gpt-4.1-mini";
    try {
      const preset = vendorPreset("openai", "medium");
      expect(preset.supervisor.modelId).toBe("gpt-4.1-mini");
      expect(preset.specialists.source_reviewer.modelId).toBe("gpt-4.1-mini");
      expect(isConfiguredPreset("openai", preset)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_PROJECT_MODEL;
      else process.env.OPENAI_PROJECT_MODEL = previous;
    }
  });
  test("defaults legacy saved presets to independent review disabled", () => {
    const { independentReviewEnabled: _independentReviewEnabled, ...legacyPreset } = vendorPreset("openai", "medium");
    expect(agentPresetConfigSchema.parse(legacyPreset).independentReviewEnabled).toBe(false);
  });
  test("keeps the direct OpenAI default when the env model is unset", () => {
    const previous = process.env.OPENAI_PROJECT_MODEL;
    delete process.env.OPENAI_PROJECT_MODEL;
    try {
      const preset = vendorPreset("openai", "medium");
      expect(preset.supervisor.modelId).toBe("gpt-4.1-mini");
      expect(preset.specialists.requirements_reviewer.modelId).toBe("gpt-4.1-mini");
      expect(isConfiguredPreset("openai", preset)).toBe(true);
    } finally {
      if (previous !== undefined) process.env.OPENAI_PROJECT_MODEL = previous;
    }
  });
});
