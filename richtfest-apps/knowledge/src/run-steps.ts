import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AppDeps } from "./deps";
import { agentRunSteps } from "./schema";

// JSONB may reorder object keys. Hash semantic JSON, not insertion order.
export function stepHash(value: unknown): string {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
      : value;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export async function savedStep(d: AppDeps, runId: string, kind: string, stepKey: string, inputHash?: string, tx = d.db) {
  const [step] = await tx.select().from(agentRunSteps).where(and(
    eq(agentRunSteps.tenantId, d.tenantId), eq(agentRunSteps.runId, runId),
    eq(agentRunSteps.version, 1), eq(agentRunSteps.kind, kind), eq(agentRunSteps.stepKey, stepKey),
    eq(agentRunSteps.status, "completed"), inputHash ? eq(agentRunSteps.inputHash, inputHash) : undefined,
  )).orderBy(desc(agentRunSteps.createdAt)).limit(1);
  return step;
}

export async function recordStep(d: AppDeps, tx: any, run: { id: string; correlationId: string; generation?: number },
  step: { kind: string; stepKey: string; inputHash: string; input: unknown; output?: unknown; status: string;
    attemptId?: string; reusedFromStepId?: string; generation?: number }) {
  const [row] = await tx.insert(agentRunSteps).values({
    tenantId: d.tenantId, runId: run.id, generation: run.generation ?? 0, ...step,
  }).returning();
  await d.auditRun(tx, "knowledge.agent_run.step_recorded", "agent_run_step", row.id, run.id, run.correlationId,
    { kind: step.kind, stepKey: step.stepKey, status: step.status, reusedFromStepId: step.reusedFromStepId });
  return row;
}
