import { z } from "zod";

export const agentEffortSchema = z.enum(["low", "medium", "high", "ultra"]);
export type AgentEffort = z.infer<typeof agentEffortSchema>;
export const agentWorkflowModeSchema = z.enum(["chat", "team", "report", "calculation"]);
export type AgentWorkflowMode = z.infer<typeof agentWorkflowModeSchema>;
export const agentReportTemplateSchema = z.enum(["sound-insulation-review", "interior-noise-concept", "exterior-noise-concept"]);
export const agentWorkflowSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("chat") }).strict(),
  z.object({ mode: z.literal("team") }).strict(),
  z.object({ mode: z.literal("report"), reportTemplate: agentReportTemplateSchema }).strict(),
  z.object({ mode: z.literal("calculation") }).strict(),
]);
export type AgentWorkflow = z.infer<typeof agentWorkflowSchema>;
// Requests can leave the format to the application; persisted policies remain exact.
export const agentWorkflowRequestSchema = z.discriminatedUnion("mode", [
  agentWorkflowSchema.options[0],
  agentWorkflowSchema.options[1],
  agentWorkflowSchema.options[2].partial({ reportTemplate: true }),
  agentWorkflowSchema.options[3],
]);
export type AgentWorkflowRequest = z.infer<typeof agentWorkflowRequestSchema>;
export const agentModeRecommendationSchema = z.object({
  version: z.string(),
  outcome: z.enum(["classified", "unconfigured", "fallback", "context_limit"]),
  recommendation: z.enum(["chat", "team", "report", "uncertain"]).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});
export type AgentModeRecommendation = z.infer<typeof agentModeRecommendationSchema>;
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
export const agentDecisionRoutingSchema = z.object({
  mode: z.enum(["off", "shadow", "enabled"]).default("off"),
  minConfidence: z.number().min(0.9).max(1).default(0.99),
}).strict();
export type AgentDecisionRouting = z.infer<typeof agentDecisionRoutingSchema>;
export const agentPresetConfigSchema = z.object({
  supervisor: agentModelConfigSchema,
  // Report prose only; absent preserves the supervisor configuration unchanged.
  writer: agentModelConfigSchema.optional(),
  specialists: z.object({
    source_reviewer: agentModelConfigSchema,
    requirements_reviewer: agentModelConfigSchema,
    sound_insulation: agentModelConfigSchema.optional(),
    construction_law: agentModelConfigSchema.optional(),
    cost_optimizer: agentModelConfigSchema.optional(),
  }).strict(),
  // Opt-in to a fresh reviewer pass after the supervisor's own evidence review.
  independentReviewEnabled: z.boolean().default(false),
  // Missing on older snapshots means off; never change an in-flight run's policy.
  decisionRouting: agentDecisionRoutingSchema.optional(),
  knowledgeRerankingEnabled: z.boolean().default(false),
  executionLimits: agentExecutionLimitsSchema.default({}),
  maxParallel: z.number().int().min(1).max(3),
  maxTasks: z.number().int().min(1).max(4),
  maxRevisions: z.number().int().min(0).max(2),
}).strict();
export type AgentPresetConfig = z.infer<typeof agentPresetConfigSchema>;
// Each human authorization grants a bounded allowance; automatic retries never reset it.
export const agentRunBudgetSchema = z.object({
  maxCostUsd: z.number().min(0.01).max(1000).default(10),
  maxAutomaticRetries: z.number().int().min(0).max(10).default(3),
}).strict();
export const agentPresetSnapshotSchema = agentPresetConfigSchema.extend({
  effort: agentEffortSchema,
  provider: agentProviderSchema,
  version: z.number().int().positive(),
  source: z.enum(["vendor", "workspace"]),
  // Absent on historical runs: preserve their original orchestration behavior.
  workflow: agentWorkflowSchema.optional(),
  runBudget: agentRunBudgetSchema.extend({ authorizedAt: z.string().datetime() }).optional(),
});
export type AgentPresetSnapshot = z.infer<typeof agentPresetSnapshotSchema>;

/** Conservative UTF-8 input budget, not a tokenizer count. Unknown IDs stay unknown.
 * Verified 2026-10-13: developers.openai.com/api/docs/models and
 * platform.claude.com/docs/en/models/overview. No opt-in context extensions.
 */
export function agentModelInputByteBudget(provider: AgentProvider, modelId: string, maxOutputTokens: number): number | undefined {
  const model = provider === "vercel" ? modelId.split("/")[1] : modelId;
  const vendor = provider === "vercel" ? modelId.split("/")[0] : provider;
  if (!model || (provider === "vercel" && modelId.split("/").length !== 2)) return;
  const context = vendor === "openai"
    ? /^gpt-(?:6-(?:astra|sol|luna)|6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(model) ? 1_050_000
      : /^gpt-4\.1(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model) ? 1_047_576 : undefined
    : vendor === "anthropic" && /^claude-(?:fable-5-1|opus-5-5|sonnet-5-5|haiku-5-5)$/.test(model) ? 1_000_000 : undefined;
  // Budget one byte per token conservatively, reserving 20% for tokenizer/wire
  // overhead plus the full configured output budget (including reasoning).
  return context === undefined ? undefined : Math.max(0, Math.floor(context * 0.8) - maxOutputTokens);
}

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
