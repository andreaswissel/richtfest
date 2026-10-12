import { z } from "zod";

export const agentEffortSchema = z.enum(["low", "medium", "high", "ultra"]);
export type AgentEffort = z.infer<typeof agentEffortSchema>;
export const agentProviderSchema = z.enum(["openai", "anthropic", "vercel"]);
export type AgentProvider = z.infer<typeof agentProviderSchema>;
// GPT-6 models support up to 128K generated tokens. This is an output ceiling,
// distinct from their 1.05M-token context window.
export const AGENT_MAX_OUTPUT_TOKENS = 128_000;
// Application response limits are separate from provider output-token budgets.
export const agentExecutionLimitsSchema = z.object({
  summaryMaxCharacters: z.number().int().min(1000).max(100000).default(10000),
  rationaleMaxCharacters: z.number().int().min(500).max(20000).default(2000),
  documentMaxCharacters: z.number().int().min(1000).max(200000).default(60000),
  timeoutSeconds: z.number().int().min(10).max(600).default(180),
}).strict();
export type AgentExecutionLimits = z.infer<typeof agentExecutionLimitsSchema>;
export const agentModelConfigSchema = z.object({
  modelId: z.string().trim().min(1).max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:\/-]*$/),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  maxOutputTokens: z.number().int().min(256).max(AGENT_MAX_OUTPUT_TOKENS),
  maxSteps: z.number().int().min(1).max(8),
}).strict();
export type AgentModelConfig = z.infer<typeof agentModelConfigSchema>;
export const domainSpecialistRoles = ["sound_insulation", "construction_law", "cost_optimizer"] as const;
export const specialistRoleSchema = z.enum(["source_reviewer", "requirements_reviewer", ...domainSpecialistRoles]);
export type SpecialistRole = z.infer<typeof specialistRoleSchema>;
export const agentPresetConfigSchema = z.object({
  supervisor: agentModelConfigSchema,
  specialists: z.object({
    source_reviewer: agentModelConfigSchema,
    requirements_reviewer: agentModelConfigSchema,
    sound_insulation: agentModelConfigSchema.optional(),
    construction_law: agentModelConfigSchema.optional(),
    cost_optimizer: agentModelConfigSchema.optional(),
  }).strict(),
  // Opt-in to a fresh reviewer pass after the supervisor's own evidence review.
  independentReviewEnabled: z.boolean().default(false),
  executionLimits: agentExecutionLimitsSchema.default({}),
  maxParallel: z.number().int().min(1).max(3),
  maxTasks: z.number().int().min(1).max(4),
  maxRevisions: z.number().int().min(0).max(2),
}).strict();
export type AgentPresetConfig = z.infer<typeof agentPresetConfigSchema>;
export const agentPresetSnapshotSchema = agentPresetConfigSchema.extend({
  effort: agentEffortSchema,
  provider: agentProviderSchema,
  version: z.number().int().positive(),
  source: z.enum(["vendor", "workspace"]),
});
export type AgentPresetSnapshot = z.infer<typeof agentPresetSnapshotSchema>;

/** Optional human evaluation, independent of approval; omitted scores are unknown. */
export const agentRunEvaluationSchema = z.object({
  correctness: z.number().int().min(1).max(5).optional(),
  completeness: z.number().int().min(1).max(5).optional(),
  usefulness: z.number().int().min(1).max(5).optional(),
  rework: z.enum(["none", "minor", "major", "unusable"]).optional(),
}).strict().refine((value) => Object.values(value).some((score) => score !== undefined), {
  message: "Choose at least one evaluation value",
});
export type AgentRunEvaluation = z.infer<typeof agentRunEvaluationSchema>;
