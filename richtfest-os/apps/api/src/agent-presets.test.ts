import { describe, expect, test } from "bun:test";
import { agentPresetConfigSchema, domainSpecialistRoles, specialistRoleSchema } from "@richtfest/shared";
import { isConfiguredPreset, isGatewayModelId, vendorPreset } from "./agent-presets";

describe("agent provider presets", () => {
  test("domain models are optional, strictly validated, and do not replace required generic roles", () => {
    const legacy = vendorPreset("openai", "medium");
    expect(agentPresetConfigSchema.parse(legacy).specialists).toEqual(legacy.specialists);
    for (const role of domainSpecialistRoles) {
      expect(specialistRoleSchema.parse(role)).toBe(role);
      const config = { ...legacy, specialists: { ...legacy.specialists, [role]: { ...legacy.supervisor, modelId: "domain-model" } } };
      expect(isConfiguredPreset("openai", config)).toBe(true);
      expect(isConfiguredPreset("vercel", { ...config, supervisor: { ...legacy.supervisor, modelId: "openai/model" }, specialists: { source_reviewer: { ...legacy.supervisor, modelId: "openai/model" }, requirements_reviewer: { ...legacy.supervisor, modelId: "openai/model" }, [role]: config.specialists[role] } })).toBe(false);
      expect(agentPresetConfigSchema.safeParse({ ...config, specialists: { ...config.specialists, [role]: { ...legacy.supervisor, enabled: true } } }).success).toBe(false);
    }
    expect(agentPresetConfigSchema.safeParse({ ...legacy, specialists: { sound_insulation: legacy.supervisor } }).success).toBe(false);
    expect(agentPresetConfigSchema.safeParse({ ...legacy, specialists: { ...legacy.specialists, unknown_role: legacy.supervisor } }).success).toBe(false);
  });

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
