import { describe, expect, test } from "bun:test";
import express from "express";
import { agentPresetConfigSchema, domainSpecialistRoles, specialistRoleSchema } from "@richtfest/shared";
import { createAgentPresetsRouter, isConfiguredPreset, isGatewayModelId, vendorPreset } from "./agent-presets";

describe("agent provider presets", () => {
  test("vendor presets never enable a writer override and gateway validation includes writers", () => {
    for (const effort of ["low", "medium", "high", "ultra"] as const) {
      for (const provider of ["openai", "anthropic", "vercel"] as const) {
        expect(vendorPreset(provider, effort)).not.toHaveProperty("writer");
      }
    }
    const base = vendorPreset("openai", "medium");
    const model = { ...base.supervisor, modelId: "openai/gpt-4.1-mini" };
    const gateway = { ...base, supervisor: model, specialists: { source_reviewer: model, requirements_reviewer: model } };
    expect(isConfiguredPreset("vercel", { ...gateway, writer: model })).toBe(true);
    expect(isConfiguredPreset("vercel", { ...gateway, writer: base.supervisor })).toBe(false);
  });

  test("settings API rejects invalid writer provider settings before any database write", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { permissions: new Set(["access:manage"]) };
      next();
    });
    // No database or provider calls are needed for rejected settings.
    app.use(createAgentPresetsRouter({} as any));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.code }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const base = vendorPreset("openai", "medium");
    const model = { ...base.supervisor, modelId: "openai/gpt-4.1-mini" };
    try {
      for (const [provider, config, code] of [
        ["vercel", { ...base, supervisor: model, specialists: { source_reviewer: model, requirements_reviewer: model }, writer: base.supervisor }, "invalid_gateway_model"],
        ["anthropic", { ...base, writer: { ...base.supervisor, reasoningEffort: "high" } }, "unsupported_reasoning_effort"],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${port}/agent/presets/${provider}/medium`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(code);
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

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

  test("legacy presets receive response defaults and enforce inclusive execution bounds", () => {
    const { executionLimits: _, ...legacy } = vendorPreset("openai", "medium");
    expect(agentPresetConfigSchema.parse(legacy).executionLimits).toEqual({
      summaryMaxCharacters: 10000, rationaleMaxCharacters: 2000, documentMaxCharacters: 60000, timeoutSeconds: 180,
    });
    for (const [field, min, max] of [
      ["summaryMaxCharacters", 1000, 100000], ["rationaleMaxCharacters", 500, 20000],
      ["documentMaxCharacters", 1000, 200000], ["timeoutSeconds", 10, 600],
    ] as const) {
      for (const value of [min, max]) expect(agentPresetConfigSchema.safeParse({ ...legacy, executionLimits: { [field]: value } }).success).toBe(true);
      for (const value of [min - 1, max + 1, min + 0.5]) expect(agentPresetConfigSchema.safeParse({ ...legacy, executionLimits: { [field]: value } }).success).toBe(false);
    }
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
  test("defaults OpenAI tiers to Luna, Sol and Astra when the env model is unset", () => {
    const previous = process.env.OPENAI_PROJECT_MODEL;
    delete process.env.OPENAI_PROJECT_MODEL;
    try {
      for (const [effort, modelId] of [["low", "gpt-6-luna"], ["medium", "gpt-6-sol"], ["high", "gpt-6-astra"], ["ultra", "gpt-6-astra"]] as const) {
        const preset = vendorPreset("openai", effort);
        expect(preset.supervisor.modelId).toBe(modelId);
        expect(preset.specialists.source_reviewer.modelId).toBe(modelId);
        expect(preset.specialists.requirements_reviewer.modelId).toBe(modelId);
        expect(isConfiguredPreset("openai", preset)).toBe(true);
      }
    } finally {
      if (previous !== undefined) process.env.OPENAI_PROJECT_MODEL = previous;
    }
  });
});
