import { z } from "zod";

export const agentEffortSchema = z.enum(["low", "medium", "high", "ultra"]);
export type AgentEffort = z.infer<typeof agentEffortSchema>;
export const agentProviderSchema = z.enum(["openai", "anthropic", "vercel"]);
export type AgentProvider = z.infer<typeof agentProviderSchema>;
// GPT-6 models support up to 128K generated tokens. This is an output ceiling,
// distinct from their 1.05M-token context window.
export const AGENT_MAX_OUTPUT_TOKENS = 128_000;
export const agentModelConfigSchema = z.object({
  modelId: z.string().trim().min(1).max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:\/-]*$/),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  maxOutputTokens: z.number().int().min(256).max(AGENT_MAX_OUTPUT_TOKENS),
  maxSteps: z.number().int().min(1).max(8),
}).strict();
export type AgentModelConfig = z.infer<typeof agentModelConfigSchema>;
export const agentPresetConfigSchema = z.object({
  supervisor: agentModelConfigSchema,
  specialists: z.object({
    source_reviewer: agentModelConfigSchema,
    requirements_reviewer: agentModelConfigSchema,
  }).strict(),
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
