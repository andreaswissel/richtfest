import { Router, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  AGENT_MAX_OUTPUT_TOKENS,
  agentEffortSchema, agentProviderSchema, agentPresetConfigSchema, specialistRoleSchema,
  type AgentEffort, type AgentProvider, type AgentPresetConfig, type AgentPresetSnapshot, ok,
} from "@richtfest/shared";
import { agentPresets } from "./db/schema";
import type { Database } from "./db/client";
import { HttpError, type Actor } from "./middleware/auth";
import { recordAudit } from "./audit";
import { env } from "./env";
import { withProviderCredential } from "./ai-connections";
import { z } from "zod";

type Provider = AgentProvider;
export const isGatewayModelId = (modelId: string) => /^[^/\s]+\/[^/\s]+$/.test(modelId);
export const isConfiguredPreset = (provider: Provider, config: AgentPresetConfig) => {
  const structurallyValid = agentPresetConfigSchema.safeParse(config).success;
  const gatewayModelsValid = provider !== "vercel" || [config.supervisor, ...Object.values(config.specialists)].every(role => !role || isGatewayModelId(role.modelId));
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
    independentReviewEnabled: false,
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

const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), display_name: z.string().optional() })),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
});

export async function listProviderModels(db: Database, current: Actor, provider: Provider) {
  // Gateway's /v1/models is public, not an account-access discovery API.
  if (provider === "vercel") throw new HttpError(409, "provider_models_unsupported", "Vercel AI Gateway does not provide a credential-backed account model catalog. Enter a provider/model ID manually.");
  const models = await withProviderCredential(db, current.tenantId, current.id, provider, async key => {
    const signal = AbortSignal.timeout(10_000);
    const result = new Map<string, { id: string; name: string }>();
    const cursors = new Set<string>();
    let after: string | undefined;
    try {
      do {
        const url = new URL(provider === "openai" ? "https://api.openai.com/v1/models" : "https://api.anthropic.com/v1/models");
        if (provider === "anthropic") {
          url.searchParams.set("limit", "1000");
          if (after) url.searchParams.set("after_id", after);
        }
        const response = await fetch(url, {
          headers: provider === "openai" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key, "anthropic-version": "2023-06-01" },
          signal,
          redirect: "error",
        });
        if (!response.ok) {
          // Provider bodies and raw fetch errors may contain secrets.
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) throw new HttpError(502, "provider_models_unauthorized", "The selected provider connection cannot list models. Check its API key and permissions.");
          throw new HttpError(502, "provider_models_unavailable", "The provider could not list models. Try again later.");
        }
        const page = modelListSchema.parse(await response.json());
        for (const model of page.data) result.set(model.id, { id: model.id, name: model.display_name || model.id });
        after = provider === "anthropic" && page.has_more ? page.last_id ?? undefined : undefined;
        if (provider === "anthropic" && page.has_more && (!after || cursors.has(after))) throw new HttpError(502, "provider_models_unavailable", "The provider returned an incomplete model catalog. Try again later.");
        if (after) cursors.add(after);
      } while (after);
      return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (signal.aborted) throw new HttpError(504, "provider_models_timeout", "The provider took too long to list models. Try again.");
      throw new HttpError(502, "provider_models_unavailable", "The provider could not list models. Try again later.");
    }
  });
  if (models === null) throw new HttpError(409, "provider_unconfigured", "Connect a personal or workspace API key for this provider to list models.");
  return models;
}

export function createAgentPresetsRouter(db: Database) {
  const router = Router();
  const actor = (req: Request) => (req as any).actor as Actor;
  router.get("/agent/models", async (req, res, next) => {
    try {
      const current = actor(req);
      const provider = agentProviderSchema.parse(req.query.provider ?? "openai");
      res.setHeader("Cache-Control", "private, no-store");
      res.json(ok({ provider, models: await listProviderModels(db, current, provider) }));
    } catch (error) { next(error); }
  });
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
      if (provider === "vercel" && config && [config.supervisor, ...Object.values(config.specialists)].some(role => role && !isGatewayModelId(role.modelId))) {
        throw new HttpError(400, "invalid_gateway_model", "Vercel AI Gateway models must use provider/model form.");
      }
      if (provider === "anthropic" && config && [config.supervisor, ...Object.values(config.specialists)].some(role => role?.reasoningEffort)) {
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
  router.patch("/agent/presets/:provider/:effort/output-limit", async (req, res, next) => {
    try {
      const current = actor(req);
      if (!current.permissions.has("access:manage")) throw new HttpError(403, "forbidden", "Workspace administration access is required.");
      const provider = agentProviderSchema.parse(req.params.provider);
      const effort = agentEffortSchema.parse(req.params.effort);
      const input = z.object({
        role: z.enum(["supervisor", ...specialistRoleSchema.options]),
        expectedVersion: z.number().int().positive(),
        expectedModelId: z.string().min(1),
        expectedMaxOutputTokens: z.number().int().min(256).max(AGENT_MAX_OUTPUT_TOKENS),
      }).strict().parse(req.body);
      await db.transaction(async tx => {
        // Materialize vendor defaults, then lock the unique preset row. A concurrent
        // full save/reset takes the same row lock; every guard is checked inside it.
        await tx.insert(agentPresets).values({ tenantId: current.tenantId, provider, effort, config: null, updatedBy: current.id }).onConflictDoNothing();
        const [row] = await tx.select().from(agentPresets).where(and(eq(agentPresets.tenantId, current.tenantId), eq(agentPresets.provider, provider), eq(agentPresets.effort, effort))).for("update");
        const config = row.config ? agentPresetConfigSchema.parse(row.config) : vendorPreset(provider, effort);
        const role = input.role === "supervisor" ? config.supervisor : config.specialists[input.role];
        if (!role || !isConfiguredPreset(provider, config) || row.version !== input.expectedVersion || role.modelId !== input.expectedModelId || role.maxOutputTokens !== input.expectedMaxOutputTokens || role.maxOutputTokens >= AGENT_MAX_OUTPUT_TOKENS) {
          throw new HttpError(409, "agent_preset_conflict", "The workspace preset changed or cannot be increased. Reopen the action to check its current settings.");
        }
        const previousLimit = role.maxOutputTokens;
        role.maxOutputTokens = Math.min(previousLimit * 2, AGENT_MAX_OUTPUT_TOKENS);
        await tx.update(agentPresets).set({ config, version: row.version + 1, updatedBy: current.id, updatedAt: new Date() }).where(eq(agentPresets.id, row.id));
        await recordAudit(tx, current.id, current.tenantId, "agent.preset.updated", "agent_preset", row.id, { provider, effort, role: input.role, version: row.version + 1, previousMaxOutputTokens: previousLimit, maxOutputTokens: role.maxOutputTokens });
      });
      res.json(ok((await listAgentPresets(db, current.tenantId, provider)).find(item => item.effort === effort)));
    } catch (error) { next(error); }
  });
  return router;
}
