import { and, desc, eq, inArray, or, isNull, lt } from "drizzle-orm";
import { agentPresetSnapshotSchema } from "@richtfest/shared";
import { z } from "zod";
import type { AppDeps } from "./deps";
import {
  agentRuns,
  agentRunEvents,
  supervisorRuns,
  tasks,
  messages,
  annotations,
  artifacts,
} from "./schema";
import { conflict, sources, createArtifact } from "./workspace";

export const specialistOutput = z.object({
  summary: z.string().min(1).max(10000),
  rationale: z.string().max(2000),
  citations: z.array(z.string().uuid()).max(100),
});
export const supervisorPlan = z.object({
  tasks: z
    .array(
      z.object({
        role: z.enum(["source_reviewer", "requirements_reviewer"]),
        goal: z.string().min(1).max(2000),
        sourceVersionIds: z.array(z.string().uuid()).max(10),
      }),
    )
    .min(1)
    .max(4),
});
export const supervisorReview = specialistOutput.extend({
  decision: z.enum(["accept", "revise"]),
  revisions: z
    .array(
      z.object({
        taskId: z.string().uuid(),
        goal: z.string().min(1).max(2000),
      }),
    )
    .max(4),
});
export type Assignment = {
  taskId: string;
  runId: string;
  role: string;
  goal: string;
  sourceVersionIds: string[];
  output?: z.infer<typeof specialistOutput>;
};
async function log(d: AppDeps, tx: any, run: any, type: string) {
  await tx.insert(agentRunEvents).values({
    tenantId: d.tenantId,
    runId: run.id,
    eventType: type,
    createdBy: d.actorId,
  });
  await d.auditRun(
    tx,
    `knowledge.agent_run.${type}`,
    "agent_run",
    run.id,
    run.id,
    run.correlationId,
  );
}
export async function createSupervisor(
  d: AppDeps,
  tx: any,
  run: any,
  effort: string,
  modelPolicy: unknown,
) {
  await tx
    .insert(supervisorRuns)
    .values({ runId: run.id, tenantId: d.tenantId, effort, modelPolicy });
}
// All commits fence against both cancellation and replacement lease tokens.
async function commit(
  d: AppDeps,
  run: any,
  token: string,
  fn: (tx: any, state: any) => Promise<void>,
) {
  return d.db.transaction(async (tx: any) => {
    const [parent] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.tenantId, d.tenantId)))
      .for("update");
    const [state] = await tx
      .select()
      .from(supervisorRuns)
      .where(eq(supervisorRuns.runId, run.id))
      .for("update");
    if (parent?.status !== "running" || state?.leaseToken !== token)
      return false;
    await fn(tx, state);
    return true;
  });
}
export async function stepSupervisor(d: AppDeps, id: string) {
  let run: any;
  let state: any;
  const token = crypto.randomUUID();
  await d.db.transaction(async (tx: any) => {
    const [parent] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, id), eq(agentRuns.tenantId, d.tenantId)))
      .for("update");
    const [s] = await tx
      .select()
      .from(supervisorRuns)
      .where(eq(supervisorRuns.runId, id))
      .for("update");
    if (
      !s ||
      !["queued", "running"].includes(parent?.status) ||
      (s.leaseUntil && s.leaseUntil > new Date())
    )
      return;
    run = parent;
    state = s;
    await tx
      .update(supervisorRuns)
      .set({ leaseToken: token, leaseUntil: new Date(Date.now() + 120000) })
      .where(eq(supervisorRuns.runId, id));
    await tx
      .update(agentRuns)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(agentRuns.id, id));
    await log(d, tx, run, s.leaseToken ? "resumed" : "supervisor_started");
  });
  if (!run) return;
  const heartbeat = setInterval(() => {
    void commit(d, run, token, async (tx) => {
      await tx
        .update(supervisorRuns)
        .set({ leaseUntil: new Date(Date.now() + 120000) })
        .where(eq(supervisorRuns.runId, id));
    }).catch(() => undefined);
  }, 30000);
  try {
    d.requirePermission("projects:read");
    d.requirePermission("agent:run");
    d.requirePermission("knowledge:read");
    d.requirePermission("knowledge:write");
    if (!(await d.validateProject(run.projectId)))
      throw conflict("Project unavailable");
    if (!d.executeSupervisor) throw conflict("Supervisor unavailable");
    const assertActive = async () => {
      if (!(await commit(d, run, token, async () => {})))
        throw conflict("Supervisor no longer active");
    };
    let partialOutput = "";
    let lastCheckpoint = 0;
    const onSummaryDelta = async (delta: string) => {
      partialOutput = (partialOutput + delta).slice(0, 10000);
      if (Date.now() - lastCheckpoint < 150) return;
      lastCheckpoint = Date.now();
      const saved = await commit(d, run, token, async (tx) => {
        await tx
          .update(agentRuns)
          .set({ partialOutput, updatedAt: new Date() })
          .where(eq(agentRuns.id, id));
        await log(d, tx, run, "output_progress");
      });
      if (!saved) throw conflict("Supervisor no longer active");
    };
    const call = async (
      phase: "plan" | "specialist" | "review",
      goal: string,
      context: unknown,
      runId = id,
    ) => {
      await assertActive();
      const response = await d.executeSupervisor!({
        phase,
        provider: run.provider,
        runId,
        goal,
        context: {
          ...(context as object),
          budgets: {
            maxTasks: state.modelPolicy?.maxTasks,
            maxRevisions: state.modelPolicy?.maxRevisions,
          },
        },
        modelPolicy: state.modelPolicy,
        onSummaryDelta: phase === "review" ? onSummaryDelta : undefined,
      });
      if (response.status !== "completed")
        throw conflict("Provider unavailable");
      return response.output;
    };
    const policy = agentPresetSnapshotSchema.parse(state.modelPolicy);
    const goal = `${run.goal}${state.steering ? `\nHuman steering: ${state.steering}` : ""}`;
    if (state.phase === "plan") {
      const sourceInventory = await d.listProjectSources(run.projectId);
      const availableSourceIds = new Set<string>([
        ...run.sourceVersionIds,
        ...sourceInventory.sources.map((source) => source.versionId),
      ]);
      const history = run.conversationId
        ? await d.db
            .select({
              body: messages.body,
              actorKind: messages.actorKind,
              sourceVersionIds: messages.sourceVersionIds,
              annotation: {
                sourceVersionId: annotations.sourceVersionId,
                page: annotations.page,
                quote: annotations.quote,
              },
            })
            .from(messages)
            .leftJoin(
              annotations,
              and(
                eq(messages.annotationId, annotations.id),
                eq(annotations.tenantId, d.tenantId),
              ),
            )
            .where(
              and(
                eq(messages.tenantId, d.tenantId),
                eq(messages.conversationId, run.conversationId),
              ),
            )
            .orderBy(desc(messages.createdAt), desc(messages.id))
            .limit(20)
        : [];
      const recentArtifacts = await d.db
        .select({
          id: artifacts.id,
          title: artifacts.title,
          status: artifacts.status,
        })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.tenantId, d.tenantId),
            eq(artifacts.projectId, run.projectId),
          ),
        )
        .orderBy(desc(artifacts.createdAt))
        .limit(20);
      const plan = supervisorPlan.parse(
        await call("plan", goal, {
          projectId: run.projectId,
          sourceVersionIds: run.sourceVersionIds,
          sourceInventory,
          history: history
            .map((m: any) => ({ ...m, body: m.body.slice(0, 1000) }))
            .reverse(),
          artifacts: recentArtifacts,
        }),
      );
      if (plan.tasks.length > policy.maxTasks)
        throw conflict("Plan exceeds effort task budget");
      for (const task of plan.tasks) {
        if (
          task.sourceVersionIds.some((v) => !availableSourceIds.has(v))
        )
          throw conflict("Assignment exceeds source scope");
        await sources(d, run.projectId, task.sourceVersionIds);
      }
      await commit(d, run, token, async (tx) => {
        const assignments: Assignment[] = [];
        for (const item of plan.tasks) {
          const [task] = await tx
            .insert(tasks)
            .values({
              tenantId: d.tenantId,
              projectId: run.projectId,
              conversationId: run.conversationId,
              title: item.goal.slice(0, 300),
              assigneeType: "agent",
              status: "in_progress",
              createdBy: d.actorId,
            })
            .returning();
          const [child] = await tx
            .insert(agentRuns)
            .values({
              tenantId: d.tenantId,
              projectId: run.projectId,
              conversationId: run.conversationId,
              taskId: task.id,
              parentRunId: id,
              specialistRole: item.role,
              goal: item.goal,
              sourceVersionIds: item.sourceVersionIds,
              provider: run.provider,
              status: "queued",
              correlationId: run.correlationId,
              requestedBy: d.actorId,
            })
            .returning();
          assignments.push({ ...item, taskId: task.id, runId: child.id });
        }
        await tx
          .update(supervisorRuns)
          .set({ assignments, phase: "specialists" })
          .where(eq(supervisorRuns.runId, id));
        await log(d, tx, run, "supervisor_planned");
      });
    } else if (state.phase === "specialists") {
      const pending = (state.assignments as Assignment[]).filter(
        (a) => !a.output,
      );
      for (let start = 0; start < pending.length; start += policy.maxParallel)
        await Promise.all(
          pending
            .slice(start, start + policy.maxParallel)
            .map(async (assignment) => {
              const claimed = await commit(d, run, token, async (tx) => {
                await tx
                  .update(agentRuns)
                  .set({ status: "running", updatedAt: new Date() })
                  .where(eq(agentRuns.id, assignment.runId));
              });
              if (!claimed) return;
              await assertActive();
              await sources(d, run.projectId, assignment.sourceVersionIds);
              const excerpts = await Promise.all(
                assignment.sourceVersionIds.map(async (versionId) => {
                  await assertActive();
                  return d.resolveSource(run.projectId, { versionId });
                }),
              );
              const readableSourceIds = new Set(
                excerpts.flatMap((excerpt: any) =>
                  excerpt?.status === "resolved" &&
                  excerpt?.content?.status === "available" &&
                  typeof excerpt.content.text === "string" &&
                  excerpt.content.text.trim().length > 0
                    ? [excerpt.source?.versionId].filter(
                        (versionId: unknown): versionId is string =>
                          typeof versionId === "string",
                      )
                    : [],
                ),
              );
              const output = specialistOutput.parse(
                await call(
                  "specialist",
                  assignment.goal,
                  {
                    role: assignment.role,
                    sourceVersionIds: assignment.sourceVersionIds,
                    sources: excerpts,
                  },
                  assignment.runId,
                ),
              );
              if (
                output.citations.some(
                  (v) => !readableSourceIds.has(v),
                )
              )
                throw conflict("Citation has no readable source text");
              await commit(d, run, token, async (tx, current) => {
                const assignments = (current.assignments as Assignment[]).map(
                  (a) => (a.runId === assignment.runId ? { ...a, output } : a),
                );
                await tx
                  .update(supervisorRuns)
                  .set({
                    assignments,
                    history: [
                      ...current.history,
                      {
                        phase: "specialist",
                        runId: assignment.runId,
                        revision: current.revision,
                        output,
                      },
                    ],
                  })
                  .where(eq(supervisorRuns.runId, id));
                await tx
                  .update(agentRuns)
                  .set({
                    status: "needs_review",
                    outputSummary: output.summary,
                    rationale: output.rationale,
                    updatedAt: new Date(),
                  })
                  .where(eq(agentRuns.id, assignment.runId));
                await tx
                  .update(tasks)
                  .set({ status: "needs_review" })
                  .where(eq(tasks.id, assignment.taskId));
                await log(d, tx, run, "specialist_completed");
              });
            }),
        );
      await commit(d, run, token, async (tx) => {
        await tx
          .update(supervisorRuns)
          .set({ phase: "review" })
          .where(eq(supervisorRuns.runId, id));
      });
    } else if (state.phase === "review") {
      const review = supervisorReview.parse(
        await call("review", goal, {
          assignments: state.assignments,
          revision: state.revision,
        }),
      );
      await sources(d, run.projectId, review.citations);
      const allowedCitations = (state.assignments as Assignment[]).flatMap(
        (a) => a.output?.citations ?? [],
      );
      if (review.citations.some((v) => !allowedCitations.includes(v)))
        throw conflict("Review introduced unsupported citations");
      if (
        review.decision === "revise" &&
        state.revision < policy.maxRevisions
      ) {
        if (
          !review.revisions.length ||
          new Set(review.revisions.map((r) => r.taskId)).size !==
            review.revisions.length ||
          review.revisions.some(
            (r) =>
              !(state.assignments as Assignment[]).some(
                (a) => a.taskId === r.taskId,
              ),
          )
        )
          throw conflict("Invalid revision assignments");
        await commit(d, run, token, async (tx) => {
          const assignments = (state.assignments as Assignment[]).map((a) => {
            const revision = review.revisions.find(
              (r) => r.taskId === a.taskId,
            );
            return revision
              ? { ...a, goal: revision.goal, output: undefined }
              : a;
          });
          for (const a of assignments.filter((a) => !a.output)) {
            await tx
              .update(agentRuns)
              .set({
                status: "queued",
                goal: a.goal,
                outputSummary: null,
                updatedAt: new Date(),
              })
              .where(eq(agentRuns.id, a.runId));
            await tx
              .update(tasks)
              .set({ status: "in_progress" })
              .where(eq(tasks.id, a.taskId));
          }
          await tx
            .update(supervisorRuns)
            .set({
              assignments,
              phase: "specialists",
              revision: state.revision + 1,
              review,
              history: [
                ...state.history,
                { phase: "review", revision: state.revision, output: review },
              ],
            })
            .where(eq(supervisorRuns.runId, id));
          await log(d, tx, run, "supervisor_revision_requested");
        });
      } else {
        await commit(d, run, token, async (tx) => {
          const summary =
            review.decision === "revise"
              ? `${review.summary}\n\nRevision limit reached. Unresolved issues require human review.`
              : review.summary;
          d.requirePermission("knowledge:write");
          const resultArtifact = await createArtifact(
            {
              ...d,
              audit: (tx, action, type, entityId, metadata) =>
                d.auditRun(
                  tx,
                  action,
                  type,
                  entityId,
                  id,
                  run.correlationId,
                  metadata,
                ),
            },
            tx,
            {
              projectId: run.projectId,
              title: run.goal.slice(0, 200),
              type: "draft",
              content: `${summary}\n\nReview rationale\n\n${review.rationale}`,
              payload: {
                kind: "summary",
                data: [{ summary, rationale: review.rationale }],
              },
              sourceVersionIds: review.citations,
            },
            id,
          );
          const resultReference = {
            kind: "supervisor_result",
            artifactId: resultArtifact.artifact.id,
            revisionId: resultArtifact.revision.id,
            generation: state.generation,
          };
          await tx
            .update(agentRuns)
            .set({
              status: "needs_review",
              outputSummary: summary,
              partialOutput: summary,
              rationale: review.rationale,
              updatedAt: new Date(),
            })
            .where(eq(agentRuns.id, id));
          await tx
            .update(supervisorRuns)
            .set({
              phase: "done",
              review: { ...review, result: resultReference },
              history: [
                ...state.history,
                {
                  phase: "review",
                  revision: state.revision,
                  generation: state.generation,
                  output: review,
                  result: resultReference,
                },
              ],
            })
            .where(eq(supervisorRuns.runId, id));
          if (run.conversationId)
            await tx.insert(messages).values({
              tenantId: d.tenantId,
              conversationId: run.conversationId,
              authorId: d.actorId,
              actorKind: "agent",
              runId: id,
              parentMessageId: run.messageId,
              body: summary,
              openui: `root = ArtifactPreview(${JSON.stringify(resultReference.artifactId)}, ${JSON.stringify(resultReference.revisionId)})`,
              sourceVersionIds: review.citations,
            });
          await log(d, tx, run, "supervisor_review_completed");
        });
      }
    }
  } catch {
    await commit(d, run, token, async (tx) => {
      await tx
        .update(agentRuns)
        .set({
          status: "failed",
          error:
            "Supervisor stopped: provider, permission, or output validation failed. No output was approved.",
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, id));
      const stopped = await tx
        .update(agentRuns)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(agentRuns.parentRunId, id),
            inArray(agentRuns.status, ["queued", "running"]),
          ),
        )
        .returning();
      for (const child of stopped) {
        d.cancelExecution?.(child.id);
        if (child.taskId)
          await tx
            .update(tasks)
            .set({ status: "cancelled" })
            .where(eq(tasks.id, child.taskId));
      }
      await log(d, tx, run, "supervisor_failed");
    });
  } finally {
    clearInterval(heartbeat);
    await d.db
      .update(supervisorRuns)
      .set({ leaseToken: null, leaseUntil: null })
      .where(
        and(eq(supervisorRuns.runId, id), eq(supervisorRuns.leaseToken, token)),
      );
  }
}
export async function tickSupervisors(
  db: any,
  resolveDeps: (tenantId: string, actorId: string) => Promise<AppDeps>,
) {
  const rows = await db
    .select({ run: agentRuns })
    .from(agentRuns)
    .innerJoin(supervisorRuns, eq(agentRuns.id, supervisorRuns.runId))
    .where(
      and(
        inArray(agentRuns.status, ["queued", "running"]),
        or(
          isNull(supervisorRuns.leaseUntil),
          lt(supervisorRuns.leaseUntil, new Date()),
        ),
      ),
    )
    .limit(8);
  await Promise.allSettled(
    rows.map(async ({ run }: any) => {
      const d = await resolveDeps(run.tenantId, run.requestedBy);
      if (d.supervisorEnabled) await stepSupervisor(d, run.id);
    }),
  );
}

export async function supervisorProgress(d: AppDeps, id: string) {
  const [row] = await d.db
    .select({
      status: agentRuns.status,
      phase: supervisorRuns.phase,
      generation: supervisorRuns.generation,
    })
    .from(agentRuns)
    .innerJoin(supervisorRuns, eq(agentRuns.id, supervisorRuns.runId))
    .where(and(eq(agentRuns.id, id), eq(agentRuns.tenantId, d.tenantId)));
  if (!row) throw conflict("Supervisor not found");
  return row as { status: string; phase: string; generation: number };
}

export async function listPendingSupervisors(
  db: any,
  limit = 4,
): Promise<
  { runId: string; tenantId: string; actorId: string; generation: number }[]
> {
  return db
    .select({
      runId: agentRuns.id,
      tenantId: agentRuns.tenantId,
      actorId: agentRuns.requestedBy,
      generation: supervisorRuns.generation,
    })
    .from(agentRuns)
    .innerJoin(supervisorRuns, eq(agentRuns.id, supervisorRuns.runId))
    .where(
      and(
        inArray(agentRuns.status, ["queued", "running"]),
        or(
          isNull(supervisorRuns.leaseUntil),
          lt(supervisorRuns.leaseUntil, new Date()),
        ),
      ),
    )
    .orderBy(agentRuns.updatedAt)
    .limit(Math.max(1, Math.min(8, limit)));
}
