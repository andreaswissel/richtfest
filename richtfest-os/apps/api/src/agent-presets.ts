import { Router, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  agentEffortSchema, agentProviderSchema, agentPresetConfigSchema,
  type AgentEffort, type AgentProvider, type AgentPresetConfig, type AgentPresetSnapshot, ok,
} from "@richtfest/shared";
import { agentPresets } from "./db/schema";
import type { Database } from "./db/client";
import { HttpError, type Actor } from "./middleware/auth";
import { recordAudit } from "./audit";
import { env } from "./env";

type Provider = AgentProvider;
export const isGatewayModelId = (modelId: string) => /^[^/\s]+\/[^/\s]+$/.test(modelId);
export const isConfiguredPreset = (provider: Provider, config: AgentPresetConfig) => {
  const structurallyValid = agentPresetConfigSchema.safeParse(config).success;
  const gatewayModelsValid = provider !== "vercel" || [config.supervisor, ...Object.values(config.specialists)].every(role => isGatewayModelId(role.modelId));
  return structurallyValid && gatewayModelsValid;
};
// Provider model IDs are configured by the deployment owner or workspace admin.
// An empty ID is deliberately unconfigured, never silently replaced by another provider.
export function vendorPreset(provider: Provider, effort: AgentEffort): AgentPresetConfig {
  const directOpenAiModel = process.env.OPENAI_PROJECT_MODEL ?? "gpt-4.1-mini";
  const supervisorModel = provider === "openai" ? (env.OPENAI_SUPERVISOR_MODEL ?? directOpenAiModel) : provider === "anthropic" ? env.ANTHROPIC_SUPERVISOR_MODEL : env.VERCEL_SUPERVISOR_MODEL;
  const specialistModel = provider === "openai" ? (env.OPENAI_SPECIALIST_MODEL ?? directOpenAiModel) : provider === "anthropic" ? env.ANTHROPIC_SPECIALIST_MODEL : env.VERCEL_SPECIALIST_MODEL;
  const limits = {
    low: { maxOutputTokens: 1500, maxSteps: 2, maxParallel: 1, maxTasks: 2, maxRevisions: 0 },
    medium: { maxOutputTokens: 3000, maxSteps: 4, maxParallel: 2, maxTasks: 3, maxRevisions: 1 },
    high: { maxOutputTokens: 5000, maxSteps: 6, maxParallel: 3, maxTasks: 4, maxRevisions: 2 },
    ultra: { maxOutputTokens: 8000, maxSteps: 8, maxParallel: 3, maxTasks: 4, maxRevisions: 2 },
  }[effort];
  const model = (modelId: string) => ({ modelId, maxOutputTokens: limits.maxOutputTokens, maxSteps: limits.maxSteps, ...(effort === "ultra" && (provider === "openai" || provider === "vercel") ? { reasoningEffort: "xhigh" as const } : {}) });
  return {
    supervisor: model(supervisorModel ?? ""),
    specialists: { source_reviewer: model(specialistModel ?? ""), requirements_reviewer: model(specialistModel ?? "") },
    maxParallel: limits.maxParallel, maxTasks: limits.maxTasks, maxRevisions: limits.maxRevisions,
  };
}

export async function listAgentPresets(db: Database, tenantId: string, provider: Provider) {
  const rows = await db.select().from(agentPresets).where(and(eq(agentPresets.tenantId, tenantId), eq(agentPresets.provider, provider)));
  return agentEffortSchema.options.map(effort => {
    const row = rows.find(item => item.effort === effort);
    const config = row?.config ? agentPresetConfigSchema.parse(row.config) : vendorPreset(provider, effort);
    return { ...config, effort, provider, version: row?.version ?? 1, source: row?.config ? "workspace" as const : "vendor" as const, configured: isConfiguredPreset(provider, config) };
  });
}

export async function resolveAgentPreset(db: Database, tenantId: string, effort: AgentEffort, provider: Provider): Promise<AgentPresetSnapshot> {
  const preset = (await listAgentPresets(db, tenantId, provider)).find(item => item.effort === effort)!;
  if (!preset.configured) throw new HttpError(409, "agent_preset_unconfigured", "Configure supervisor and specialist models in Settings before starting this effort level.");
  const { configured, ...snapshot } = preset;
  return snapshot;
}

export function createAgentPresetsRouter(db: Database) {
  const router = Router();
  const actor = (req: Request) => (req as any).actor as Actor;
  router.get("/agent/presets", async (req, res, next) => {
    try {
      const current = actor(req);
      const provider = agentProviderSchema.parse(req.query.provider ?? "openai");
      res.json(ok({ enabled: env.AGENT_SUPERVISOR_ENABLED, provider, canManage: current.permissions.has("access:manage"), presets: await listAgentPresets(db, current.tenantId, provider) }));
    } catch (error) { next(error); }
  });
  const save = (reset: boolean) => async (req: Request, res: any, next: any) => {
    try {
      const current = actor(req);
      if (!current.permissions.has("access:manage")) throw new HttpError(403, "forbidden", "Workspace administration access is required.");
      const provider = agentProviderSchema.parse(req.params.provider);
      const effort = agentEffortSchema.parse(req.params.effort);
      const config = reset ? null : agentPresetConfigSchema.parse(req.body);
      if (provider === "vercel" && config && [config.supervisor, ...Object.values(config.specialists)].some(role => !isGatewayModelId(role.modelId))) {
        throw new HttpError(400, "invalid_gateway_model", "Vercel AI Gateway models must use provider/model form.");
      }
      if (provider === "anthropic" && config && [config.supervisor, ...Object.values(config.specialists)].some(role => role.reasoningEffort)) {
        throw new HttpError(400, "unsupported_reasoning_effort", "Use provider-default reasoning for Anthropic models.");
      }
      await db.transaction(async tx => {
        const [saved] = await tx.insert(agentPresets).values({ tenantId: current.tenantId, provider, effort, config, updatedBy: current.id })
          .onConflictDoUpdate({ target: [agentPresets.tenantId, agentPresets.provider, agentPresets.effort], set: { config, version: sql`${agentPresets.version} + 1`, updatedBy: current.id, updatedAt: new Date() } }).returning();
        await recordAudit(tx, current.id, current.tenantId, reset ? "agent.preset.reset" : "agent.preset.updated", "agent_preset", saved.id, { provider, effort, version: saved.version });
      });
      res.json(ok((await listAgentPresets(db, current.tenantId, provider)).find(item => item.effort === effort)));
    } catch (error) { next(error); }
  };
  router.put("/agent/presets/:provider/:effort", save(false));
  router.delete("/agent/presets/:provider/:effort", save(true));
  return router;
}
