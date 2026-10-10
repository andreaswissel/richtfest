import { and, desc, eq, inArray, or, isNull, lt } from "drizzle-orm";
import { agentPresetSnapshotSchema } from "@richtfest/shared";
import { z } from "zod";
import type { AppDeps } from "./deps";
import { sanitizeProviderDiagnostics } from "./deps";
import {
  agentRuns,
  agentRunEvents,
  supervisorRuns,
  tasks,
  messages,
  annotations,
  artifacts,
} from "./schema";
import { snapshotAgentProfiles, defaultProfiles, type ProfileSnapshot } from "./agent-profiles";
import { conflict, sources, createArtifact } from "./workspace";
import { executeTrackedProvider } from "./usage";
import {
  classifyRunFailure,
  formatChildCancellationReason,
  formatRunFailureReason,
  type RunFailureCategory,
  type RunFailurePhase,
} from "./run-reasons";

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
export const independentReview = specialistOutput.extend({
  decision: z.enum(["accept", "revise"]),
  findings: z.array(z.object({
    severity: z.enum(["blocking", "note"]),
    issue: z.string().min(1).max(2000),
    recommendation: z.string().min(1).max(2000),
    citations: z.array(z.string().uuid()).max(20),
  }).strict()).max(20),
  revisions: z.array(
    z.object({
      taskId: z.string().uuid(),
      goal: z.string().min(1).max(2000),
    }).strict(),
  ).max(4),
}).strict();
export type Assignment = {
  taskId: string;
  runId: string;
  role: string;
  goal: string;
  sourceVersionIds: string[];
  output?: z.infer<typeof specialistOutput>;
};
export function assertIndependentReviewCitations(
  review: z.infer<typeof independentReview>,
  readableSourceIds: ReadonlySet<string>,
) {
  const citations = [
    ...review.citations,
    ...review.findings.flatMap((finding) => finding.citations),
  ];
  if (citations.some((versionId) => !readableSourceIds.has(versionId)))
    throw conflict("Independent review cited a source without readable resolved text");
}
export function assertIndependentReviewDecision(
  review: z.infer<typeof independentReview>,
  assignments: Assignment[],
) {
  if (review.decision === "accept" && (review.revisions.length || review.findings.some((finding) => finding.severity === "blocking")))
    throw conflict("Accepted independent review cannot contain blocking findings or request revisions");
  if (review.revisions.length)
    assertRevisionAssignments(review.revisions, assignments, review.decision === "revise");
}
export const INDEPENDENT_REVIEW_SOURCE_SLICE_SIZE = 3;
export function chunkSourceVersionIds(versionIds: string[], size = INDEPENDENT_REVIEW_SOURCE_SLICE_SIZE) {
  if (!Number.isInteger(size) || size < 1) throw new Error("Source slice size must be a positive integer");
  const unique = [...new Set(versionIds)];
  return Array.from({ length: Math.ceil(unique.length / size) }, (_, index) =>
    unique.slice(index * size, (index + 1) * size),
  );
}
export function aggregateIndependentReviews(
  results: { sourceVersionIds: string[]; output: z.infer<typeof independentReview> }[],
) {
  const findings = new Map<string, z.infer<typeof independentReview>["findings"][number]>();
  const revisions = new Map<string, { taskId: string; goal: string }>();
  for (const { output } of results) {
    for (const finding of output.findings)
      findings.set(JSON.stringify(finding), finding);
    for (const revision of output.revisions) {
      const previous = revisions.get(revision.taskId);
      const goals = [previous?.goal, revision.goal].filter((goal): goal is string => typeof goal === "string" && goal.length > 0);
      revisions.set(revision.taskId, {
        taskId: revision.taskId,
        goal: [...new Set(goals)].join("\nAdditional review guidance: ").slice(0, 2000),
      });
    }
  }
  const allFindings = [...findings.values()];
  const maxFindings = 20;
  const omittedFindings = Math.max(0, allFindings.length - maxFindings);
  const includedFindings = allFindings.slice(0, maxFindings);
  const summarize = (key: "summary" | "rationale", maxLength: number) => {
    let value = results.map(({ sourceVersionIds, output }, index) =>
      `Source slice ${index + 1} (${sourceVersionIds.length} versions): ${output[key]}`,
    ).join("\n\n");
    if (omittedFindings) value += `\n\n${omittedFindings} additional findings were omitted from the bounded result.`;
    return value.slice(0, maxLength);
  };
  return independentReview.parse({
    summary: summarize("summary", 10000) || "No readable assigned sources were available for independent review.",
    rationale: summarize("rationale", 2000) || "No review call could be made without readable source excerpts.",
    citations: [...new Set(results.flatMap(({ output }) => output.citations))],
    decision: results.some(({ output }) => output.decision === "revise") ? "revise" : "accept",
    findings: includedFindings,
    revisions: [...revisions.values()].slice(0, 4),
  });
}
export function assertRevisionAssignments(
  revisions: { taskId: string; goal: string }[],
  assignments: Assignment[],
  required = true,
) {
  if (
    (required && !revisions.length) ||
    new Set(revisions.map((revision) => revision.taskId)).size !== revisions.length ||
    revisions.some((revision) => !assignments.some((assignment) => assignment.taskId === revision.taskId))
  ) throw conflict("Invalid revision assignments");
}
async function log(
  d: AppDeps,
  tx: any,
  run: any,
  type: string,
  resultSummary?: string,
  paramsSummary?: string,
) {
  await tx.insert(agentRunEvents).values({
    tenantId: d.tenantId,
    runId: run.id,
    eventType: type,
    paramsSummary,
    resultSummary,
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
  const profileSnapshot = await snapshotAgentProfiles(d, tx);
  await tx
    .insert(supervisorRuns)
    .values({ runId: run.id, tenantId: d.tenantId, effort, modelPolicy, profileSnapshot });
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
  let failurePhase: RunFailurePhase =
    state.phase === "specialists" ? "specialist" : (state.phase as RunFailurePhase);
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
      phase: "plan" | "specialist" | "review" | "independent_review",
      goal: string,
      context: unknown,
      runId = id,
    ) => {
      const callId = crypto.randomUUID();
      failurePhase = phase;
      await assertActive();
      const started = await commit(d, run, token, async (tx) => {
        await log(d, tx, run, "provider_call_started", phase, callId);
      });
      if (!started) throw conflict("Supervisor no longer active");
      const maxAttempts = 3;
      const providerContext = {
        ...(context as object),
        workspaceGuidance: (() => {
          // Pre-existing runs retain original defaults rather than adopting later settings.
          const profiles: ProfileSnapshot[] = state.profileSnapshot?.length ? state.profileSnapshot : defaultProfiles().map(profile => ({ ...profile, knowledge: [] }));
          const role = phase === "specialist" || phase === "independent_review"
            ? (context as { role: string }).role
            : "supervisor";
          const profile = profiles.find(profile => profile.key === role) ?? (
            role === "independent_reviewer"
              ? { ...defaultProfiles().find(profile => profile.key === role)!, knowledge: [] }
              : undefined
          );
          return {
            profile,
            routingHints: phase === "plan" ? profiles.map(profile => ({ role: profile.key, triggerPhrases: profile.triggerPhrases })) : undefined,
          };
        })(),
        budgets: {
          maxTasks: state.modelPolicy?.maxTasks,
          maxRevisions: state.modelPolicy?.maxRevisions,
        },
      };
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await assertActive();
        if (phase === "review") {
          partialOutput = "";
          lastCheckpoint = 0;
          await onSummaryDelta("");
        }
        try {
          const response = await executeTrackedProvider(d, { ...run, id: runId }, {
            phase, operationId: callId, attemptNumber: attempt, generation: state.generation,
          }, telemetry => d.executeSupervisor!({
            ...telemetry,
            phase,
            provider: run.provider,
            runId,
            goal,
            context: providerContext,
            modelPolicy: state.modelPolicy,
            onSummaryDelta: phase === "review" ? onSummaryDelta : undefined,
          }));
          if (response.status !== "completed") throw conflict("Provider unavailable");
          const completed = await commit(d, run, token, async (tx) => {
            await log(d, tx, run, "provider_call_completed", phase, callId);
          });
          if (!completed) throw conflict("Supervisor no longer active");
          return response.output;
        } catch (error) {
          const metadata = typeof error === "object" && error !== null
            ? error as { retryable?: unknown; providerFailure?: unknown; providerStatus?: unknown; failureCategory?: unknown; retryAfterMs?: unknown; diagnostics?: unknown }
            : {};
          const attemptMetadata = JSON.stringify({ callId, attempt, runId, diagnostics: sanitizeProviderDiagnostics(metadata.diagnostics) });
          const providerFailureStatus = typeof metadata.providerStatus === "number" && Number.isInteger(metadata.providerStatus)
            && metadata.providerStatus >= 100 && metadata.providerStatus <= 599 ? metadata.providerStatus : undefined;
          const failureCategory: RunFailureCategory = metadata.providerFailure === true
            ? providerFailureStatus === 401 || providerFailureStatus === 403 ? "permission"
              : metadata.failureCategory === "validation" ? "validation" : "provider"
            : classifyRunFailure(error, phase);
          const cooldownExceedsBudget = typeof metadata.retryAfterMs === "number" && metadata.retryAfterMs > 300000;
          const shouldRetry = metadata.providerFailure === true && metadata.retryable === true
            && failureCategory !== "permission" && !cooldownExceedsBudget && attempt < maxAttempts;
          if (shouldRetry) {
            const fallbackMs = providerFailureStatus === 429 ? 5000 * attempt : attempt === 1 ? 350 : 800;
            const delayMs = typeof metadata.retryAfterMs === "number" && Number.isFinite(metadata.retryAfterMs)
              ? Math.min(300000, Math.max(fallbackMs, metadata.retryAfterMs)) : fallbackMs;
            const retryLogged = await commit(d, run, token, async (tx) => {
              await log(
                d,
                tx,
                run,
                "provider_call_retrying",
                `${phase}; attempt ${attempt} of ${maxAttempts}; retrying after transient provider failure`,
                attemptMetadata,
              );
            });
            if (!retryLogged) throw conflict("Supervisor no longer active");
            // Check persisted cancellation/steering while cooling down.
            const retryAt = Date.now() + delayMs;
            do {
              await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, retryAt - Date.now()))));
              await assertActive();
            } while (Date.now() < retryAt);
            continue;
          }
          // Provider errors are reduced to phase/category/attempt events only;
          // SDK messages and response bodies are never persisted.
          await commit(d, run, token, async (tx) => {
            await log(
              d,
              tx,
              run,
              "provider_call_failed",
              `${phase}${providerFailureStatus === undefined ? "" : `; HTTP ${providerFailureStatus}`}${cooldownExceedsBudget ? "; provider cooldown exceeds five-minute automatic retry budget" : ""}`,
              attemptMetadata,
            );
          });
          // Carry only this call's sanitized metadata: parallel siblings cannot overwrite it.
          throw Object.assign(new Error("Supervisor model execution failed."), {
            failurePhase: phase, failureCategory, providerStatus: providerFailureStatus,
          });
        }
      }
      throw new Error("Provider retry loop ended unexpectedly");
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
              const resolvedSources = assignment.sourceVersionIds.map(
                (versionId, index) => ({ versionId, excerpt: excerpts[index] as any }),
              );
              const readableSources = resolvedSources.filter(
                ({ versionId, excerpt }) =>
                  excerpt?.status === "resolved" &&
                  excerpt?.source?.versionId === versionId &&
                  excerpt?.content?.status === "available" &&
                  typeof excerpt.content.text === "string" &&
                  excerpt.content.text.trim().length > 0,
              );
              const readableSourceIds = new Set<string>(
                readableSources.map(({ versionId }) => versionId),
              );
              // Keep unreadable files visible as coverage gaps, but do not give
              // their version IDs to the model as possible citation targets.
              const unreadableSources = resolvedSources
                .filter(({ versionId, excerpt }) =>
                  !readableSourceIds.has(versionId) ||
                  excerpt?.source?.versionId !== versionId,
                )
                .map(({ versionId, excerpt }) => ({
                  name:
                    typeof excerpt?.source?.name === "string"
                      ? excerpt.source.name
                      : "Unnamed source",
                  reason:
                    typeof excerpt?.content?.reason === "string"
                      ? excerpt.content.reason
                      : typeof excerpt?.message === "string"
                        ? excerpt.message
                        : excerpt?.source?.versionId !== versionId
                          ? "Resolved source version did not match the assigned version."
                          : "Readable source text is unavailable.",
                }));
              const specialistSources = readableSources.map(
                ({ versionId, excerpt }) => ({
                  versionId,
                  name: excerpt.source.name,
                  version: excerpt.source.version,
                  mimeType: excerpt.source.mimeType,
                  text: excerpt.content.text,
                  truncated: excerpt.content.truncated,
                  coverage: excerpt.content.coverage,
                  extractionNotes: excerpt.content.reason,
                }),
              );
              const output = specialistOutput.parse(
                await call(
                  "specialist",
                  assignment.goal,
                  {
                    role: assignment.role,
                    sourceVersionIds: [...readableSourceIds],
                    sources: specialistSources,
                    unreadableSources,
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
        assertRevisionAssignments(review.revisions, state.assignments as Assignment[]);
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
      } else if (
        review.decision === "accept" &&
        state.modelPolicy?.independentReviewEnabled === true
      ) {
        await commit(d, run, token, async (tx) => {
          await tx
            .update(supervisorRuns)
            .set({
              phase: "independent_review",
              review,
              history: [
                ...state.history,
                { phase: "review", revision: state.revision, output: review },
              ],
            })
            .where(eq(supervisorRuns.runId, id));
          await log(d, tx, run, "supervisor_review_completed");
          await log(d, tx, run, "independent_review_started");
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
              openui: `root = ArtifactPdf(${JSON.stringify(resultReference.artifactId)}, ${JSON.stringify(resultReference.revisionId)})`,
              sourceVersionIds: review.citations,
            });
          await log(d, tx, run, "supervisor_review_completed");
        });
      }
    } else if (state.phase === "independent_review") {
      const assignments = state.assignments as Assignment[];
      const sourceVersionIds = [...new Set(assignments.flatMap((a) => a.sourceVersionIds))];
      await sources(d, run.projectId, sourceVersionIds);
      const resolvedExcerpts = await Promise.all(sourceVersionIds.map(async (versionId) => {
        await assertActive();
        return { versionId, resolution: await d.resolveSource(run.projectId, { versionId }) };
      }));
      const readableSourceIds = new Set(resolvedExcerpts.flatMap(({ versionId, resolution }: any) =>
        resolution?.status === "resolved" &&
        resolution?.source?.versionId === versionId &&
        resolution?.content?.status === "available" &&
        typeof resolution.content.text === "string" &&
        resolution.content.text.trim().length > 0
          ? [versionId]
          : [],
      ));
      const unreadableSources = resolvedExcerpts
        .filter(({ versionId }) => !readableSourceIds.has(versionId))
        .map(({ versionId, resolution }: any) => ({ versionId, name: resolution?.source?.name ?? null }));
      const coverageIncomplete = sourceVersionIds.length === 0 || unreadableSources.length > 0;
      const firstPassReview = state.review;
      const sourceSlices = chunkSourceVersionIds([...readableSourceIds]);
      const sliceResults: { sourceVersionIds: string[]; output: z.infer<typeof independentReview> }[] = [];
      for (let index = 0; index < sourceSlices.length; index++) {
        const sliceIds = sourceSlices[index];
        const sliceIdSet = new Set(sliceIds);
        const sourceExcerpts = resolvedExcerpts.filter(({ versionId }) => sliceIdSet.has(versionId));
        const sliceAssignments = assignments.filter((assignment) =>
          assignment.sourceVersionIds.some((versionId) => sliceIdSet.has(versionId)) ||
          (index === 0 && assignment.sourceVersionIds.length === 0),
        );
        const sliceReview = firstPassReview && typeof firstPassReview === "object"
          ? { ...firstPassReview, citations: Array.isArray((firstPassReview as any).citations) ? (firstPassReview as any).citations.filter((versionId: string) => sliceIdSet.has(versionId)) : [] }
          : firstPassReview;
        const output = independentReview.parse(await call("independent_review", goal, {
          role: "independent_reviewer",
          originalGoal: run.goal,
          assignments: sliceAssignments.map((assignment) => ({
            taskId: assignment.taskId,
            role: assignment.role,
            goal: assignment.goal,
            sourceVersionIds: assignment.sourceVersionIds.filter((versionId) => sliceIdSet.has(versionId)),
            result: assignment.output ? {
              ...assignment.output,
              citations: assignment.output.citations.filter((versionId) => sliceIdSet.has(versionId)),
            } : undefined,
          })),
          specialistResults: sliceAssignments.map((assignment) => ({
            taskId: assignment.taskId,
            role: assignment.role,
            goal: assignment.goal,
            sourceVersionIds: assignment.sourceVersionIds.filter((versionId) => sliceIdSet.has(versionId)),
            output: assignment.output ? {
              ...assignment.output,
              citations: assignment.output.citations.filter((versionId) => sliceIdSet.has(versionId)),
            } : undefined,
          })),
          firstPassReview: sliceReview,
          sourceExcerpts,
          sourceCoverage: {
            slice: index + 1,
            sliceCount: sourceSlices.length,
            assignedVersionCount: sourceVersionIds.length,
            readableVersionCount: readableSourceIds.size,
            sliceVersionIds: sliceIds,
            unreadableSources,
          },
          revision: state.revision,
        }));
        assertIndependentReviewCitations(output, sliceIdSet);
        sliceResults.push({ sourceVersionIds: sliceIds, output });
      }
      const aggregated = aggregateIndependentReviews(sliceResults);
      const output = independentReview.parse({
        ...aggregated,
        decision: coverageIncomplete ? "revise" : aggregated.decision,
        findings: coverageIncomplete
          ? [{
              severity: "blocking",
              issue: sourceVersionIds.length === 0
                ? "No source versions were assigned for independent review."
                : `Independent review could not reread ${unreadableSources.length} assigned source version(s): ${unreadableSources.map((source: any) => source.name ?? source.versionId).join(", ")}.`,
              recommendation: sourceVersionIds.length === 0
                ? "Assign the relevant immutable source versions and rerun independent review."
                : "Restore readable source content and rerun independent review before relying on complete source coverage.",
              citations: [],
            }, ...aggregated.findings].slice(0, 20)
          : aggregated.findings,
      });
      assertIndependentReviewCitations(output, readableSourceIds);
      assertIndependentReviewDecision(output, assignments);
      if (output.decision === "revise" && output.revisions.length && state.revision < policy.maxRevisions) {
        assertRevisionAssignments(output.revisions, assignments);
        await commit(d, run, token, async (tx) => {
          const revisedAssignments = assignments.map((assignment) => {
            const revision = output.revisions.find((item) => item.taskId === assignment.taskId);
            return revision ? { ...assignment, goal: revision.goal, output: undefined } : assignment;
          });
          for (const assignment of revisedAssignments.filter((item) => !item.output)) {
            await tx.update(agentRuns).set({
              status: "queued",
              goal: assignment.goal,
              outputSummary: null,
              updatedAt: new Date(),
            }).where(eq(agentRuns.id, assignment.runId));
            await tx.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, assignment.taskId));
          }
          await tx.update(supervisorRuns).set({
            assignments: revisedAssignments,
            phase: "specialists",
            revision: state.revision + 1,
            review: { firstPassReview, independentReview: output },
            history: [
              ...state.history,
              { phase: "independent_review", revision: state.revision, output },
            ],
          }).where(eq(supervisorRuns.runId, id));
          await log(d, tx, run, "independent_review_completed");
          await log(d, tx, run, "independent_review_revision_requested");
        });
      } else {
        await commit(d, run, token, async (tx) => {
          const unresolved = output.decision === "revise";
          const coverageNote = coverageIncomplete
            ? sourceVersionIds.length === 0
              ? "Independent review source coverage incomplete: no source versions were assigned."
              : `Independent review source coverage incomplete: ${unreadableSources.length} assigned source version(s) could not be reread (${unreadableSources.map((source: any) => source.name || source.versionId).join(", ")}).`
            : "Independent review source coverage complete for every assigned source version.";
          const findingsSummary = output.findings.map((finding) => `${finding.severity === "blocking" ? "Issue" : "Note"}: ${finding.issue} Recommendation: ${finding.recommendation}`);
          const summary = [
            firstPassReview?.summary,
            `Independent review: ${output.summary}`,
            ...findingsSummary,
            coverageNote,
            unresolved ? "Revision limit reached. Unresolved independent-review issues require human review." : "",
          ].filter(Boolean).join("\n\n");
          const rationale = [
            firstPassReview?.rationale,
            `Independent review rationale\n\n${output.rationale}`,
            findingsSummary.length ? `Independent review findings\n\n${findingsSummary.join("\n\n")}` : "",
            coverageNote,
          ].filter(Boolean).join("\n\n");
          const reviewCitations = [...new Set([
            ...output.citations,
            ...output.findings.flatMap((finding) => finding.citations),
          ])];
          d.requirePermission("knowledge:write");
          const resultArtifact = await createArtifact({
            ...d,
            audit: (tx, action, type, entityId, metadata) => d.auditRun(tx, action, type, entityId, id, run.correlationId, metadata),
          }, tx, {
            projectId: run.projectId,
            title: run.goal.slice(0, 200),
            type: "draft",
            content: `${summary}\n\n${rationale}`,
            payload: { kind: "summary", data: [{ summary, rationale }] },
            sourceVersionIds: reviewCitations,
          }, id);
          const resultReference = {
            kind: "supervisor_result",
            artifactId: resultArtifact.artifact.id,
            revisionId: resultArtifact.revision.id,
            generation: state.generation,
          };
          await tx.update(agentRuns).set({
            status: "needs_review",
            outputSummary: summary,
            partialOutput: summary,
            rationale,
            updatedAt: new Date(),
          }).where(eq(agentRuns.id, id));
          await tx.update(supervisorRuns).set({
            phase: "done",
            review: { ...output, firstPassReview, unresolved, result: resultReference },
            history: [
              ...state.history,
              { phase: "independent_review", revision: state.revision, generation: state.generation, output, result: resultReference },
            ],
          }).where(eq(supervisorRuns.runId, id));
          if (run.conversationId) await tx.insert(messages).values({
            tenantId: d.tenantId,
            conversationId: run.conversationId,
            authorId: d.actorId,
            actorKind: "agent",
            runId: id,
            parentMessageId: run.messageId,
            body: summary,
            openui: `root = ArtifactPdf(${JSON.stringify(resultReference.artifactId)}, ${JSON.stringify(resultReference.revisionId)})`,
            sourceVersionIds: reviewCitations,
          });
          await log(d, tx, run, "independent_review_completed");
        });
      }
    }
  } catch (error) {
    const metadata: { failurePhase?: RunFailurePhase; failureCategory?: RunFailureCategory; providerStatus?: number } = error instanceof Error
      ? error as Error & { failurePhase?: RunFailurePhase; failureCategory?: RunFailureCategory; providerStatus?: number }
      : {};
    const phase = metadata.failurePhase ?? failurePhase;
    const category = metadata.failureCategory ?? classifyRunFailure(error, phase);
    const providerFailureStatus = metadata.providerStatus;
    const failureReason = formatRunFailureReason(phase, category, providerFailureStatus);
    const childCancellationReason = formatChildCancellationReason(
      phase,
      category,
      "supervisor_failed",
    );
    await commit(d, run, token, async (tx) => {
      await tx
        .update(agentRuns)
        .set({
          status: "failed",
          error: failureReason,
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, id));
      const stopped = await tx
        .update(agentRuns)
        .set({ status: "cancelled", error: childCancellationReason, updatedAt: new Date() })
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
        await log(d, tx, child, "cancelled", undefined, childCancellationReason);
      }
      await log(d, tx, run, "supervisor_failed", undefined, failureReason);
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
