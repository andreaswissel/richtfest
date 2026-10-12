import { z } from "zod";
import { agentDocumentSchema } from "./agent-document";
import { agentExecutionLimitsSchema, specialistRoleSchema, type AgentExecutionLimits } from "./agent-policy";

/** The provider and domain validate the same snapshotted response limits. */
export function agentOutputSchemas(limits: AgentExecutionLimits = agentExecutionLimitsSchema.parse({})) {
  const specialist = z.object({
    summary: z.string().min(1).max(limits.summaryMaxCharacters),
    rationale: z.string().max(limits.rationaleMaxCharacters),
    citations: z.array(z.string().uuid()).max(100),
  });
  const revisions = z.array(z.object({
    taskId: z.string().uuid(),
    goal: z.string().min(1).max(2000),
  })).max(4);
  return {
    plan: z.object({ tasks: z.array(z.object({
      role: specialistRoleSchema,
      goal: z.string().min(1).max(2000),
      sourceVersionIds: z.array(z.string().uuid()).max(10),
    })).min(1).max(4) }),
    specialist,
    review: specialist.extend({
      document: agentDocumentSchema.extend({ content: z.string().trim().min(1).max(limits.documentMaxCharacters) }),
      decision: z.enum(["accept", "revise"]),
      revisions,
    }),
    independent_review: specialist.extend({
      decision: z.enum(["accept", "revise"]),
      findings: z.array(z.object({
        severity: z.enum(["blocking", "note"]),
        issue: z.string().min(1).max(2000),
        recommendation: z.string().min(1).max(2000),
        citations: z.array(z.string().uuid()).max(20),
      }).strict()).max(20),
      revisions: z.array(revisions.element.strict()).max(4),
    }).strict(),
  };
}
