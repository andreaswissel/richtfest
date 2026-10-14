import { z } from "zod";

/** Admission estimates, not provider invoices. No prompts or credentials. */
export const agentBudgetDecisionSchema = z.object({
  state: z.enum(["waiting", "reserved", "stopped"]),
  reason: z.enum(["pending_reservations", "spend_allowance", "retry_allowance", "unknown_usage",
    "unpriced_call", "wait_expired", "nested_reservation"]).nullable(),
  limitUsd: z.number().finite().nonnegative(),
  recordedUsd: z.number().finite().nonnegative(),
  reservedUsd: z.number().finite().nonnegative(),
  requestedUsd: z.number().finite().nonnegative().nullable(),
  retriesUsed: z.number().int().nonnegative(),
  retryLimit: z.number().int().nonnegative(),
});
export type AgentBudgetDecision = z.infer<typeof agentBudgetDecisionSchema>;

/** User-facing work facts, not provider reasoning, prompts or diagnostics. */
export const agentWorkProgressSchema = z.object({
  runId: z.string().uuid(),
  stage: z.enum([
    "resolving_sources", "reading_sources", "source_findings",
    "reviewing_findings", "independent_review", "revision_requested",
    "editing_document", "checking_editorial",
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
