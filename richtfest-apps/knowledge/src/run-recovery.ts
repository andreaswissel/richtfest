import { and, eq, inArray, lt, notExists } from "drizzle-orm";
import type { AppDeps } from "./deps";
import { agentRuns, agentRunEvents, supervisorRuns } from "./schema";
import { formatRunFailureReason } from "./run-reasons";
/** Legacy executions cannot resume. Make their interruption visible on every run-reading surface. */
export async function repairLegacyRuns(
  d: AppDeps,
  filter: { projectId?: string; runId?: string },
) {
  const cutoff = new Date(Date.now() - 180000);
  await d.db.transaction(async (tx: any) => {
    const stale = await tx
      .update(agentRuns)
      .set({
        status: "failed",
        error: formatRunFailureReason("execution", "execution"),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentRuns.tenantId, d.tenantId),
          filter.projectId
            ? eq(agentRuns.projectId, filter.projectId)
            : undefined,
          filter.runId ? eq(agentRuns.id, filter.runId) : undefined,
          inArray(agentRuns.status, ["queued", "running"]),
          lt(agentRuns.updatedAt, cutoff),
          notExists(
            tx
              .select({ id: supervisorRuns.runId })
              .from(supervisorRuns)
              .where(eq(supervisorRuns.runId, agentRuns.id)),
          ),
          notExists(
            tx
              .select({ id: supervisorRuns.runId })
              .from(supervisorRuns)
              .where(eq(supervisorRuns.runId, agentRuns.parentRunId)),
          ),
        ),
      )
      .returning();
    for (const run of stale) {
      await tx.insert(agentRunEvents).values({
        tenantId: d.tenantId,
        runId: run.id,
        eventType: "interrupted",
        createdBy: d.actorId,
      });
      await d.auditRun(
        tx,
        "knowledge.agent_run.interrupted",
        "agent_run",
        run.id,
        run.id,
        run.correlationId,
      );
    }
  });
}
