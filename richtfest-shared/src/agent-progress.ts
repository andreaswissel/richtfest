import { z } from "zod";

/** User-facing work facts, not provider reasoning, prompts or diagnostics. */
export const agentWorkProgressSchema = z.object({
  runId: z.string().uuid(),
  stage: z.enum([
    "resolving_sources", "reading_sources", "source_findings",
    "reviewing_findings", "independent_review", "revision_requested",
  ]),
  // Independent review can cover all four assignments of ten versions at once.
  sources: z.array(z.object({
    versionId: z.string().uuid(),
    name: z.string().optional(),
    version: z.number().int().positive().optional(),
  })).max(40).default([]),
  batch: z.number().int().positive().optional(),
  batchCount: z.number().int().positive().optional(),
  /** Excerpt of validated structured output; still requires human review. */
  summary: z.string().max(1000).optional(),
});
export type AgentWorkProgress = z.infer<typeof agentWorkProgressSchema>;
