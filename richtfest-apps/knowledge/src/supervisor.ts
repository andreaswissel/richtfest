import { and, desc, eq, inArray, notInArray, or, isNull, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { agentDocumentSchema, agentPresetSnapshotSchema, agentWorkProgressSchema, prepareAgentDocument, requestedAcousticConcept, acousticConceptIdSchema, specialistRoleSchema, type AgentPresetSnapshot, type AgentWorkProgress, agentOutputSchemas, agentExecutionLimitsSchema, type AgentExecutionLimits, agentModelInputByteBudget } from "@richtfest/shared";
import { z } from "zod";
import type { AppDeps } from "./deps";
import { sanitizeProviderDiagnostics } from "./deps";
import { batchSectionSources, batchSpecialistSources } from "./source-batches";
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
import { conflict, sources, createArtifact, artifactReviewContext } from "./workspace";
import { executeTrackedProvider } from "./usage";
import { AGENT_MESSAGING_CONTEXT_BYTES, agentMessagingContext, deliverAgentMessage } from "./agent-messages";
import { resolveRunSource, resolveCompleteRunSource } from "./source-evidence";
import { authorAcousticConcept } from "./acoustic-authoring";
import { prepareIndependentReview } from "./independent-review";
import { acousticCalculationSchema, acousticCalculationResultSchema, acousticInputProvenance, type AcousticCalculationReceipt } from "@richtfest/shared";
import { recordStep, savedStep, stepHash } from "./run-steps";
import { companyKnowledgeSearchSchema, type CompanyKnowledgeReceipt } from "@richtfest/shared";
import { COMPANY_KNOWLEDGE_CONTEXT_BYTES, companyKnowledgeCategories, searchCompanyKnowledge, assertCompanyKnowledgeCurrent } from "./company-knowledge";
import { classifyRun, decisionRoutingVersion } from "./decision-routing";
import {
  classifyRunFailure,
  formatChildCancellationReason,
  formatRunFailureReason,
  type RunFailureCategory,
  type RunFailurePhase,
} from "./run-reasons";

const defaultSchemas = agentOutputSchemas();
export const specialistOutput = defaultSchemas.specialist;
export const supervisorPlan = defaultSchemas.plan;
export function assertConfiguredAssignments(plan: z.infer<typeof supervisorPlan>, policy: AgentPresetSnapshot) {
  for (const task of plan.tasks)
    if (!policy.specialists[task.role]) throw conflict("Assignment specialist is disabled in the snapshotted preset");
}

export function plannerRoles(policy: AgentPresetSnapshot, profiles: ProfileSnapshot[]) {
  const availableRoles = specialistRoleSchema.options.filter(role => !!policy.specialists[role]);
  return {
    availableRoles,
    routingHints: profiles.filter(profile => availableRoles.some(role => role === profile.key))
      .map(profile => ({ role: profile.key, triggerPhrases: profile.triggerPhrases })),
  };
}
export const supervisorReview = defaultSchemas.review.extend({
  // Older persisted runs and host fixtures contain only the conversational summary.
  document: defaultSchemas.review.shape.document.nullish(),
});
export const independentReview = defaultSchemas.independent_review;
export type Assignment = {
  taskId: string;
  runId: string;
  role: string;
  goal: string;
  sourceVersionIds: string[];
  // Absent on historical assignments: their saved batch identities stay unchanged.
  sourceInputByteBudget?: number;
  sourceBatchingVersion?: 2;
  output?: z.infer<typeof specialistOutput>;
  calculationReceipts?: AcousticCalculationReceipt[];
  calculationEvidenceHash?: string;
  companyKnowledge?: CompanyKnowledgeReceipt[];
  sourceProgress?: {
    inputHash: string;
    byteLimit?: number;
    completedBatches: number;
    output: z.infer<typeof specialistOutput>;
  };
};
export function assertDocumentCitations(
  document: z.infer<typeof agentDocumentSchema> | null | undefined,
  citations: string[],
) {
  const declared = new Set(citations.map((id) => id.toLowerCase()));
  const inline = document?.content.matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi) ?? [];
  for (const match of inline)
    if (!declared.has(match[1]!.toLowerCase()))
      throw conflict("Document introduced undeclared source citations");
}
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
  limits: AgentExecutionLimits = agentExecutionLimitsSchema.parse({}),
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
  return agentOutputSchemas(limits).independent_review.parse({
    summary: summarize("summary", limits.summaryMaxCharacters) || "No readable assigned sources were available for independent review.",
    rationale: summarize("rationale", limits.rationaleMaxCharacters) || "No review call could be made without readable source excerpts.",
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
async function logWorkProgress(d: AppDeps, tx: any, run: any, progress: AgentWorkProgress) {
  const data = agentWorkProgressSchema.parse({
    ...progress,
    summary: progress.summary && progress.summary.length > 1000
      ? `${progress.summary.slice(0, 999)}…` : progress.summary,
  });
  // Both conversations receive the same durable, permission-scoped work facts.
  // Do not copy source bodies or provider diagnostics into events/audit metadata.
  await log(d, tx, run, "work_progress", undefined, JSON.stringify(data));
  if (data.runId !== run.id)
    await log(d, tx, { ...run, id: data.runId }, "work_progress", undefined, JSON.stringify(data));
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
// jsonb reorders object keys on persistence; that must not invalidate recovery.
function checkpointHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item,
  )).digest("hex");
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
    const policy = agentPresetSnapshotSchema.parse(state.modelPolicy);
    const limits = policy.executionLimits;
    const schemas = agentOutputSchemas(limits);
    await assertCompanyKnowledgeCurrent(d, (state.assignments as Assignment[]).flatMap(a => a.companyKnowledge ?? []));
    const assertActive = async () => {
      if (!(await commit(d, run, token, async () => {})))
        throw conflict("Supervisor no longer active");
    };
    let partialOutput = "";
    let lastCheckpoint = 0;
    const onSummaryDelta = async (delta: string) => {
      partialOutput = (partialOutput + delta).slice(0, limits.summaryMaxCharacters);
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
      validate?: (output: unknown) => unknown,
    ) => {
      // Retry state lives in the existing durable phase history. A restart must
      // honor the saved deadline and attempt budget, not start a fresh burst.
      const callKey = checkpointHash({ phase, goal, context, runId, revision: state.revision });
      const [sender] = runId === run.id ? [run] : await d.db.select().from(agentRuns).where(and(
        eq(agentRuns.id, runId), eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.parentRunId, run.id),
      ));
      if (!sender) throw conflict("Message sender is not part of this execution");
      const checkpoint = state.history.findLast((entry: any) => entry.phase === "provider_retry" && entry.callKey === callKey);
      const sameGeneration = checkpoint?.generation === state.generation;
      const callId = sameGeneration ? checkpoint.callId : crypto.randomUUID();
      failurePhase = phase;
      // Section/outline responses have no summary. Concurrent pieces must not
      // reset or write the single conversational summary stream.
      const streamSummary = phase === "review" && !(context as { documentTask?: string }).documentTask;
      await assertActive();
      const started = await commit(d, run, token, async (tx) => {
        await log(d, tx, run, "provider_call_started", phase, callId);
      });
      if (!started) throw conflict("Supervisor no longer active");
      if (sameGeneration && checkpoint.terminal) throw Object.assign(new Error("Supervisor model execution failed."), {
        failurePhase: phase, failureCategory: checkpoint.failureCategory, providerStatus: checkpoint.providerStatus,
        diagnostics: sanitizeProviderDiagnostics(checkpoint.diagnostics),
      });
      // A deliberate resume gets a new attempt budget, but never skips a
      // provider cooldown that is still in effect.
      let retryAt = sameGeneration || checkpoint?.providerStatus === 429 ? checkpoint.retryAt : 0;
      let retryDeadline = sameGeneration ? checkpoint.retryDeadline : retryAt > Date.now() ? Date.now() + 600000 : undefined;
      const providerContext = {
        ...(context as object),
        companyKnowledge: (context as { companyKnowledge?: CompanyKnowledgeReceipt[] }).companyKnowledge ?? [],
        companyKnowledgeCategories: phase === "specialist" && (policy.specialists[(context as { role: keyof typeof policy.specialists }).role]?.maxSteps ?? 1) >= 2
          ? await companyKnowledgeCategories(d) : undefined,
        acousticToolsAvailable: !!d.calculateAcoustics && (policy.specialists.sound_insulation?.maxSteps ?? 0) >= 2,
        ...(!(context as { documentTask?: string }).documentTask ? { messaging: await agentMessagingContext(d, sender) } : {}),
        componentCatalog: await d.componentContext?.(run.goal),
        documentReview: await artifactReviewContext(d, run.conversationId),
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
            ...(phase === "plan" ? plannerRoles(agentPresetSnapshotSchema.parse(state.modelPolicy), profiles) : {}),
          };
        })(),
        budgets: {
          maxTasks: state.modelPolicy?.maxTasks,
          maxRevisions: state.modelPolicy?.maxRevisions,
        },
      };
      const searchKnowledge: Parameters<NonNullable<AppDeps["executeSupervisor"]>>[0]["searchCompanyKnowledge"] =
        phase === "specialist" && (policy.specialists[(context as { role: keyof typeof policy.specialists }).role]?.maxSteps ?? 1) >= 2
          ? async (raw, signal) => {
            signal?.throwIfAborted();
            const input = companyKnowledgeSearchSchema.parse(raw);
            const inputHash = stepHash(input);
            const stepKey = `company-knowledge:${state.revision}:${inputHash}`;
            await assertActive();
            const [snapshot] = await d.db.select({ assignments: supervisorRuns.assignments }).from(supervisorRuns)
              .where(and(eq(supervisorRuns.runId, id), eq(supervisorRuns.tenantId, d.tenantId)));
            const assignment = (snapshot?.assignments as Assignment[]).find(a => a.runId === runId);
            if (!assignment) throw conflict("Knowledge specialist unavailable");
            const known = assignment.companyKnowledge ?? [];
            // Full-text reads must not hold the shared checkpoint lock. This
            // snapshot only avoids redundant work; commit rechecks the budget.
            const candidate = known.length < 2 && !known.some(r => stepHash({ terms: r.terms, category: r.category }) === inputHash)
              ? await searchCompanyKnowledge(d, input, d.db, false, policy.knowledgeRerankingEnabled
                ? { runId, correlationId: run.correlationId, goal: assignment.goal, generation: state.generation, signal }
                : undefined) : undefined;
            let receipt: CompanyKnowledgeReceipt | undefined;
            const saved = await commit(d, run, token, async (tx, current) => {
              signal?.throwIfAborted();
              const assignment = (current.assignments as Assignment[]).find(a => a.runId === runId);
              if (!assignment) throw conflict("Knowledge specialist unavailable");
              const receipts = assignment.companyKnowledge ?? [];
              const matching = receipts.find(r => stepHash({ terms: r.terms, category: r.category }) === inputHash);
              if (matching) {
                await assertCompanyKnowledgeCurrent(d, [matching], tx);
                // Already present in this attempt's context or a preceding tool
                // response: return its identity, not another copy of the text.
                receipt = { ...matching, status: "already_retrieved", entries: [] };
                return;
              }
              const result = receipts.length >= 2
                ? await searchCompanyKnowledge(d, input, tx, true) : candidate!;
              // Approval/content may have changed while the read was in flight.
              await assertCompanyKnowledgeCurrent(d, [result], tx);
              const previous = await savedStep(d, runId, "tool", stepKey, stepHash({ input, result }), tx);
              const step = previous ?? await recordStep(d, tx, { ...run, id: runId, generation: state.generation }, {
                kind: "tool", stepKey, inputHash: stepHash({ input, result }),
                input: { name: "search_company_knowledge", input }, output: result, status: "completed",
              });
              receipt = { ...result, receiptId: step.id };
              signal?.throwIfAborted();
              if (result.status !== "limit_reached") await tx.update(supervisorRuns).set({
                assignments: (current.assignments as Assignment[]).map(a => a.runId !== runId ? a : {
                  ...a, companyKnowledge: [...receipts, receipt],
                }),
              }).where(eq(supervisorRuns.runId, id));
              if (!previous) await log(d, tx, { ...run, id: runId }, "tool_executed", "search_company_knowledge",
                `${result.status}: ${result.entries.length} approved company references retrieved`);
            });
            if (!saved) throw conflict("Supervisor no longer active");
            signal?.throwIfAborted();
            return receipt!;
          } : undefined;
      const calculateAcoustics: Parameters<NonNullable<AppDeps["executeSupervisor"]>>[0]["calculateAcoustics"] =
        phase === "specialist" && (context as { role?: string }).role === "sound_insulation" && providerContext.acousticToolsAvailable
          ? async (raw, signal) => {
            signal?.throwIfAborted();
            await assertActive();
            const input = acousticCalculationSchema.parse(raw);
            const allowed = new Set((context as { sourceVersionIds?: string[] }).sourceVersionIds ?? []);
            for (const provenance of acousticInputProvenance(input)) {
              if (provenance.kind === "source") {
                if (!allowed.has(provenance.versionId)) throw conflict("Calculation source is outside the current readable batch");
                const excerpt = (context as { sources: { versionId: string; text: string }[] }).sources
                  .find(source => source.versionId === provenance.versionId && source.text.includes(provenance.excerpt));
                if (!excerpt) throw conflict("Calculation quotation is absent from the current source text");
                await sources(d, run.projectId, [provenance.versionId]);
              }
            }
            const inputHash = stepHash({ engine: "richtfest-acoustics", version: 1, input });
            const stepKey = `acoustics:${callKey}:${inputHash}`;
            let receipt: AcousticCalculationReceipt | undefined;
            const saved = await commit(d, run, token, async (tx, current) => {
              signal?.throwIfAborted();
              const assignment = (current.assignments as Assignment[]).find(a => a.runId === runId);
              if (!assignment || assignment.role !== "sound_insulation") throw conflict("Calculation specialist unavailable");
              const previous = await savedStep(d, runId, "tool", stepKey, inputHash, tx);
              if ((assignment.calculationReceipts?.length ?? 0) >= 20 && !assignment.calculationReceipts?.some(r => r.receiptId === previous?.id))
                throw conflict("Specialist calculation limit reached");
              const result = acousticCalculationResultSchema.parse(previous?.output ?? d.calculateAcoustics!(input));
              signal?.throwIfAborted();
              const step = previous ?? await recordStep(d, tx, { ...run, id: runId, generation: state.generation }, {
                kind: "tool", stepKey, inputHash, input: { engine: "richtfest-acoustics", version: 1, input }, output: result, status: "completed",
              });
              receipt = { ...result, receiptId: step.id };
              await tx.update(supervisorRuns).set({ assignments: (current.assignments as Assignment[]).map(a => a.runId !== runId ? a : {
                ...a, calculationReceipts: [...(a.calculationReceipts ?? []).filter(r => r.receiptId !== step.id), receipt],
              }) }).where(eq(supervisorRuns.runId, id));
              if (!previous) await log(d, tx, { ...run, id: runId }, "tool_executed", input.method, `Calculation receipt ${step.id}; not reviewed`);
            });
            if (!saved) throw conflict("Supervisor no longer active");
            signal?.throwIfAborted();
            return receipt!;
          } : undefined;
      let outputValidationFeedback = sameGeneration && checkpoint.failureCategory === "validation"
        ? sanitizeProviderDiagnostics(checkpoint.diagnostics) : undefined;
      for (let attempt = (sameGeneration ? checkpoint.attempt : 0) + 1; attempt <= 5; attempt++) {
        await assertActive();
        if (retryDeadline && retryAt >= retryDeadline) throw Object.assign(new Error("Provider cooldown exceeds recovery window."), {
          failurePhase: phase, failureCategory: "provider", providerStatus: 429,
        });
        while (Date.now() < retryAt) {
          await new Promise(resolve => setTimeout(resolve, Math.min(1000, retryAt - Date.now())));
          await assertActive();
        }
        if (retryDeadline && Date.now() >= retryDeadline) throw Object.assign(new Error("Provider recovery window expired."), {
          failurePhase: phase, failureCategory: "provider", providerStatus: 429,
        });
        if (searchKnowledge) {
          const [current] = await d.db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, id));
          providerContext.companyKnowledge = (current.assignments as Assignment[]).find(a => a.runId === runId)?.companyKnowledge ?? [];
        }
        await assertCompanyKnowledgeCurrent(d, providerContext.companyKnowledge);
        if (streamSummary) {
          partialOutput = "";
          lastCheckpoint = 0;
          await onSummaryDelta("");
        }
        try {
          const response = await executeTrackedProvider(d, { ...run, id: runId }, {
            phase, operationId: callId, attemptNumber: attempt, generation: state.generation, assertActive,
          }, async telemetry => {
            const response = await d.executeSupervisor!({
            ...telemetry,
            phase,
            provider: run.provider,
            runId,
            goal,
            context: { ...providerContext, outputValidationFeedback },
            modelPolicy: state.modelPolicy,
            calculateAcoustics,
            searchCompanyKnowledge: searchKnowledge,
            onSummaryDelta: streamSummary ? onSummaryDelta : undefined,
            });
            if (response.status === "completed") {
              let receipts = (context as { companyKnowledge?: CompanyKnowledgeReceipt[] }).companyKnowledge ?? [];
              if (searchKnowledge) {
                const [current] = await d.db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, id));
                receipts = (current.assignments as Assignment[]).find(a => a.runId === runId)?.companyKnowledge ?? [];
              }
              await assertCompanyKnowledgeCurrent(d, receipts);
            }
            if (response.status === "completed" && validate) {
              try { response.output = validate(response.output); }
              catch (error) {
                if (!(error instanceof z.ZodError)) throw error;
                throw Object.assign(new Error("Document output validation failed."), {
                  providerFailure: true, retryable: true, failureCategory: "validation",
                  diagnostics: sanitizeProviderDiagnostics({ errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", issues: error.issues }),
                });
              }
            }
            return response;
          });
          if (response.status !== "completed") throw conflict("Provider unavailable");
          const completed = await commit(d, run, token, async (tx, current) => {
            // The stable phase key and receipt commit with delivery: replay cannot
            // publish an exchange twice, even if the phase checkpoint is retried.
            const outgoing = (response.output as { messages?: unknown[] }).messages ?? [];
            for (const [index, message] of outgoing.entries())
              await deliverAgentMessage(d, tx, sender, message, `supervisor:${callKey}:${index}`);
            await tx.update(supervisorRuns).set({ history: current.history.filter((entry: any) =>
              entry.phase !== "provider_retry" || entry.callKey !== callKey) }).where(eq(supervisorRuns.runId, id));
            await log(d, tx, run, "provider_call_completed", phase, callId);
          });
          if (!completed) throw conflict("Supervisor no longer active");
          return response.output;
        } catch (error) {
          const metadata = typeof error === "object" && error !== null
            ? error as { code?: unknown; retryable?: unknown; providerFailure?: unknown; providerStatus?: unknown; failureCategory?: unknown; retryAfterMs?: unknown; diagnostics?: unknown }
            : {};
          const diagnostics = sanitizeProviderDiagnostics(metadata.diagnostics);
          const providerFailureStatus = typeof metadata.providerStatus === "number" && Number.isInteger(metadata.providerStatus)
            && metadata.providerStatus >= 100 && metadata.providerStatus <= 599 ? metadata.providerStatus : undefined;
          const failureCategory: RunFailureCategory = metadata.code === "timeout" || metadata.failureCategory === "timeout" ? "timeout" : metadata.providerFailure === true
            ? providerFailureStatus === 401 || providerFailureStatus === 403 ? "permission"
              : metadata.failureCategory === "validation" ? "validation" : "provider"
            : classifyRunFailure(error, phase);
          const rateLimited = providerFailureStatus === 429;
          const quotaFailure = diagnostics.providerCode === "insufficient_quota" || diagnostics.providerCode === "billing_hard_limit_reached";
          const maxAttempts = rateLimited ? 5 : 3;
          if (rateLimited) retryDeadline ??= Date.now() + 600000;
          const fallbackMs = rateLimited ? Math.min(120000, 30000 * 2 ** (attempt - 1)) : attempt === 1 ? 350 : 800;
          const rateLimit = diagnostics.rateLimit;
          const delayMs = Math.max(fallbackMs,
            typeof metadata.retryAfterMs === "number" && Number.isFinite(metadata.retryAfterMs) ? metadata.retryAfterMs : 0,
            rateLimited && rateLimit?.remainingRequests === 0 ? rateLimit.resetRequestsMs ?? 0 : 0,
            rateLimited && rateLimit?.remainingTokens === 0 ? rateLimit.resetTokensMs ?? 0 : 0);
          const cooldownExceedsBudget = rateLimited ? Date.now() + delayMs >= retryDeadline! : delayMs > 300000;
          const splitTruncatedSection = phase === "review" && (context as { splitOnTruncation?: boolean }).splitOnTruncation === true
            && (diagnostics.finishReason === "length" || diagnostics.errorId === "STRUCTURED_OUTPUT_TRUNCATED");
          const shouldRetry = metadata.providerFailure === true && metadata.retryable === true
            && !splitTruncatedSection && !quotaFailure && failureCategory !== "permission" && failureCategory !== "timeout" && !cooldownExceedsBudget && attempt < maxAttempts;
          retryAt = Date.now() + delayMs;
          const attemptMetadata = JSON.stringify({ callId, attempt, runId, diagnostics, providerStatus: providerFailureStatus,
            ...(shouldRetry ? { delayMs, retryAt } : {}), recoveryExhausted: cooldownExceedsBudget });
          const saveRetry = async (tx: any, current: any) => {
            await tx.update(supervisorRuns).set({ history: [
              ...current.history.filter((entry: any) => entry.phase !== "provider_retry" || entry.callKey !== callKey),
              { phase: "provider_retry", callKey, callId, generation: state.generation, attempt, retryAt, retryDeadline, diagnostics,
                failureCategory, providerStatus: providerFailureStatus, terminal: !shouldRetry },
            ] }).where(eq(supervisorRuns.runId, id));
          };
          if (shouldRetry) {
            if (failureCategory === "validation")
              outputValidationFeedback = diagnostics;
            const retryLogged = await commit(d, run, token, async (tx, current) => {
              await saveRetry(tx, current);
              await log(
                d,
                tx,
                run,
                "provider_call_retrying",
                `${phase}; attempt ${attempt} of ${maxAttempts}; retrying after ${failureCategory === "validation" ? "output validation failure" : "transient provider failure"}`,
                attemptMetadata,
              );
            });
            if (!retryLogged) throw conflict("Supervisor no longer active");
            continue;
          }
          // Provider errors are reduced to phase/category/attempt events only;
          // SDK messages and response bodies are never persisted.
          await commit(d, run, token, async (tx, current) => {
            await saveRetry(tx, current);
            await log(
              d,
              tx,
              run,
              "provider_call_failed",
              `${phase}${providerFailureStatus === undefined ? "" : `; HTTP ${providerFailureStatus}`}${cooldownExceedsBudget ? "; provider cooldown exceeds automatic recovery window" : ""}`,
              attemptMetadata,
            );
          });
          // Carry only this call's sanitized metadata: parallel siblings cannot overwrite it.
          throw Object.assign(new Error("Supervisor model execution failed."), {
            failurePhase: phase, failureCategory, providerStatus: providerFailureStatus, diagnostics,
          });
        }
      }
      throw new Error("Provider retry loop ended unexpectedly");
    };
    const goal = `${run.goal}${state.steering ? `\nHuman steering: ${state.steering}` : ""}`;
    const plannedTemplate = state.history.findLast((entry: any) => entry.phase === "plan")?.output?.documentTemplate;
    const conceptId = requestedAcousticConcept(state.steering ?? "") ?? requestedAcousticConcept(run.goal)
      ?? acousticConceptIdSchema.safeParse(plannedTemplate).data;
    const readCompleteSources = !!conceptId || state.history.findLast((entry: any) => entry.phase === "plan")?.strategy === "selected_source_summary";
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
              agentMessage: messages.agentMessage,
              sourceVersionIds: messages.sourceVersionIds,
              annotation: {
                sourceVersionId: annotations.sourceVersionId,
                artifactRevisionId: annotations.artifactRevisionId,
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
            .limit(21)
        : [];
      const recentArtifacts = await d.db
        .select({
          id: artifacts.id,
          title: artifacts.title,
          status: artifacts.status,
        })
        .from(artifacts)
        .innerJoin(agentRuns, and(eq(artifacts.runId, agentRuns.id), eq(agentRuns.tenantId, d.tenantId)))
        .where(
          and(
            eq(artifacts.tenantId, d.tenantId),
            eq(artifacts.projectId, run.projectId),
            run.conversationId ? eq(agentRuns.conversationId, run.conversationId) : sql`false`,
          ),
        )
        .orderBy(desc(artifacts.createdAt))
        .limit(20);
      const planContext = {
        projectId: run.projectId,
        sourceVersionIds: run.sourceVersionIds,
        sourceInventory,
        history: history.slice(0, 20)
          .map((m: any) => ({ ...m, body: m.body.slice(0, 1000) })).reverse(),
        artifacts: recentArtifacts,
      };
      let fastSummary = false;
      const routing = policy.decisionRouting;
      if (routing && routing.mode !== "off") {
        // Do not bypass custom workspace planning instructions, artifact workflows,
        // annotations, steering or context that was clipped out of the classifier.
        let blocked = conceptId || run.intent === "calculation" ? "engineering_workflow"
          : state.steering ? "human_steering"
          : state.profileSnapshot?.some((p: ProfileSnapshot) => p.version > 0) ? "workspace_guidance"
          : recentArtifacts.length ? "existing_artifacts"
          : !run.sourceVersionIds.length || run.sourceVersionIds.length > 10 ? "source_selection"
          : goal.length > 2000 || history.length > 20 || history.some((m: any) => m.body.length > 1000) ? "context_limit"
          : history.some((m: any) => m.annotation?.sourceVersionId || m.annotation?.artifactRevisionId) ? "annotation_context"
          : null;
        const decisionState = { goal, selectedSourceCount: run.sourceVersionIds.length,
          history: planContext.history.map((m: any) => ({ body: m.body, actorKind: m.actorKind })) };
        if (Buffer.byteLength(JSON.stringify(decisionState), "utf8") > 16000) blocked = "context_limit";
        const inputHash = checkpointHash({ version: decisionRoutingVersion, decisionState,
          sourceVersionIds: run.sourceVersionIds, generation: state.generation, routing, blocked });
        const saved = state.history.findLast((entry: any) => entry.phase === "decision" && entry.inputHash === inputHash);
        await assertActive();
        // Validate before sending any context to another provider, including shadow mode.
        await sources(d, run.projectId, run.sourceVersionIds);
        const decision = saved?.output ?? (blocked
          ? { version: decisionRoutingVersion, outcome: "ineligible", eligible: false, elapsedMs: 0 }
          : await classifyRun(d, run, { state: decisionState, minConfidence: routing.minConfidence, generation: state.generation }));
        await assertActive();
        if (decision.eligible && !blocked) {
          for (const versionId of run.sourceVersionIds) {
            // This preflight never waits on extraction; an unavailable source keeps
            // the normal planner. The specialist will read complete saved pages.
            const source: any = await d.resolveSource(run.projectId, { versionId, pageStart: 1, pageEnd: 1 }).catch(() => null);
            await assertActive();
            if (source?.status !== "resolved" || source.source?.versionId !== versionId
              || source.content?.status !== "available" || !source.content.text?.trim()) {
              blocked = "source_unavailable";
              break;
            }
          }
        }
        fastSummary = routing.mode === "enabled" && decision.eligible && !blocked;
        const output = { ...decision, mode: routing.mode, minConfidence: routing.minConfidence,
          blocked, selectedRoute: fastSummary ? "selected_source_summary" : "supervisor" };
        const checkpointed = await commit(d, run, token, async (tx, current) => {
          await tx.update(supervisorRuns).set({ history: [
            ...current.history.filter((entry: any) => entry.phase !== "decision" || entry.inputHash !== inputHash),
            { phase: "decision", inputHash, generation: state.generation, output },
          ] }).where(eq(supervisorRuns.runId, id));
          await log(d, tx, run, "decision_routed", output.selectedRoute, JSON.stringify(output));
        });
        if (!checkpointed) throw conflict("Supervisor no longer active");
      }
      const plan = supervisorPlan.parse(fastSummary ? {
        tasks: [{ role: "source_reviewer", goal, sourceVersionIds: [...new Set(run.sourceVersionIds)] }],
      } : await call("plan", goal, planContext, id, raw => {
        const parsed = supervisorPlan.parse(raw);
        if (parsed.tasks.length > policy.maxTasks) throw conflict("Plan exceeds effort task budget");
        assertConfiguredAssignments(parsed, policy);
        if (parsed.tasks.some(task => task.sourceVersionIds.some(v => !availableSourceIds.has(v))))
          throw conflict("Assignment exceeds source scope");
        return parsed;
      }));
      if (plan.tasks.length > policy.maxTasks)
        throw conflict("Plan exceeds effort task budget");
      assertConfiguredAssignments(plan, policy);
      for (const task of plan.tasks) {
        if (task.sourceVersionIds.some(v => !availableSourceIds.has(v)))
          throw conflict("Assignment exceeds source scope");
        await sources(d, run.projectId, task.sourceVersionIds);
      }
      await commit(d, run, token, async (tx, current) => {
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
          const model = policy.specialists[item.role]!;
          assignments.push({ ...item, taskId: task.id, runId: child.id,
            sourceInputByteBudget: agentModelInputByteBudget(run.provider, model.modelId, model.maxOutputTokens),
            sourceBatchingVersion: 2,
          });
        }
        await tx
          .update(supervisorRuns)
          .set({ assignments, phase: "specialists", history: [...current.history,
            { phase: "plan", output: plan, strategy: fastSummary ? "selected_source_summary" : "supervisor" }] })
          .where(eq(supervisorRuns.runId, id));
        await log(d, tx, run, "supervisor_planned");
      });
    } else if (state.phase === "specialists") {
      const pending = (state.assignments as Assignment[]).filter(
        (a) => !a.output,
      );
      let nextAssignment = 0;
      let stopped = false;
      let failure: unknown;
      await Promise.allSettled(Array.from({ length: Math.min(policy.maxParallel, pending.length) }, async () => {
        try {
          while (!stopped && nextAssignment < pending.length) {
              const assignment = pending[nextAssignment++]!;
              const claimed = await commit(d, run, token, async (tx) => {
                await tx
                  .update(agentRuns)
                  .set({ status: "running", updatedAt: new Date() })
                  .where(eq(agentRuns.id, assignment.runId));
                await logWorkProgress(d, tx, run, {
                  runId: assignment.runId, stage: "resolving_sources", sources: [],
                });
              });
              if (!claimed) return;
              await assertActive();
              await sources(d, run.projectId, assignment.sourceVersionIds);
              const excerpts = await Promise.all(
                assignment.sourceVersionIds.map(async (versionId) => {
                  await assertActive();
                  return readCompleteSources
                    ? resolveCompleteRunSource(d, run.projectId, { versionId }, assertActive)
                    : resolveRunSource(d, run.projectId, { versionId, textQuery: assignment.goal }, assertActive);
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
                  text: excerpt.content.text as string,
                  truncated: excerpt.content.truncated,
                  coverage: excerpt.content.coverage,
                  retrieval: excerpt.content.retrieval,
                  model: excerpt.content.model,
                  extractionNotes: excerpt.content.reason,
                }),
              );
              // Reserve the maximum accumulated findings (including JSON escaping),
              // variable context and instructions/schema before packing whole pages.
              // Persist the chosen limit with progress so retries never repack saved work.
              const byteLimit = assignment.sourceProgress?.byteLimit ?? (assignment.sourceInputByteBudget === undefined
                ? assignment.sourceBatchingVersion === 2 ? 48 * 1024 : undefined
                : assignment.sourceInputByteBudget - 16384 - 6 * (limits.summaryMaxCharacters + limits.rationaleMaxCharacters) - 8000
                  // Five tool schemas currently serialize to ~18 KiB; leave headroom.
                  - (assignment.role === "sound_insulation" && d.calculateAcoustics ? 24576 : 0)
                  - AGENT_MESSAGING_CONTEXT_BYTES
                  - ((policy.specialists[assignment.role as keyof typeof policy.specialists]?.maxSteps ?? 1) >= 2 ? COMPANY_KNOWLEDGE_CONTEXT_BYTES : 0)
                  - Buffer.byteLength(JSON.stringify({ goal: assignment.goal, role: assignment.role, unreadableSources,
                    sourceVersionIds: assignment.sourceVersionIds,
                    documentReview: await artifactReviewContext(d, run.conversationId),
                    profiles: state.profileSnapshot?.length ? state.profileSnapshot : defaultProfiles().map(profile => ({ ...profile, knowledge: [] })),
                    budgets: { maxTasks: policy.maxTasks, maxRevisions: policy.maxRevisions },
                  }), "utf8"));
              if (byteLimit !== undefined && byteLimit < 1024) throw conflict("Specialist context exceeds the model input budget");
              const batches = byteLimit === undefined ? batchSpecialistSources(specialistSources) : batchSectionSources(specialistSources, byteLimit);
              // Checkpoints can only be reused for the same goal and extracted
              // evidence. A changed extraction or revision must be read again.
              const inputHash = createHash("sha256").update(JSON.stringify({
                goal: assignment.goal, batches, unreadableSources,
              })).digest("hex");
              const progress = assignment.sourceProgress?.inputHash === inputHash ? assignment.sourceProgress : undefined;
              if (assignment.role === "sound_insulation" && d.calculateAcoustics && assignment.calculationEvidenceHash !== inputHash) await commit(d, run, token, async (tx, current) => {
                await tx.update(supervisorRuns).set({ assignments: (current.assignments as Assignment[]).map(a => a.runId === assignment.runId
                  ? { ...a, calculationReceipts: undefined, calculationEvidenceHash: inputHash } : a) }).where(eq(supervisorRuns.runId, id));
              });
              let accumulated = progress?.output;
              for (let index = progress?.completedBatches ?? 0; index < batches.length; index++) {
                if (stopped) throw new Error("Specialist work stopped after a sibling failure.");
                const batch = batches[index]!;
                const batchIds = [...new Set(batch.map(source => source.versionId))];
                const allowedCitations = new Set([...batchIds, ...(accumulated?.citations ?? [])]);
                const workSources = [...new Map(batch.map(({ versionId, name, version }) => [versionId, { versionId, name, version }])).values()];
                const started = await commit(d, run, token, async (tx) => {
                  await logWorkProgress(d, tx, run, {
                    runId: assignment.runId, stage: "reading_sources", sources: workSources,
                    batch: index + 1, batchCount: batches.length, summary: accumulated?.summary,
                  });
                });
                if (!started) throw conflict("Supervisor no longer active");
                const result = schemas.specialist.parse(await call("specialist", assignment.goal, {
                  role: assignment.role,
                  sourceVersionIds: batchIds,
                  sources: batch,
                  unreadableSources,
                  previousFindings: accumulated,
                  documentTemplate: conceptId ? { id: conceptId, version: 1 } : undefined,
                  sourceCoverage: {
                    batch: index + 1,
                    batchCount: batches.length,
                    assignedVersionCount: assignment.sourceVersionIds.length,
                    readableVersionCount: readableSourceIds.size,
                  },
                }, assignment.runId, raw => {
                  const parsed = schemas.specialist.parse(raw);
                  const rejected = parsed.citations.flatMap((versionId, index) => allowedCitations.has(versionId) ? [] : [{ versionId, index }]);
                  if (rejected.length) throw Object.assign(new Error("Specialist citation validation failed."), {
                    providerFailure: true, retryable: true, failureCategory: "validation",
                    diagnostics: sanitizeProviderDiagnostics({ errorId: "SOURCE_CITATION_OUT_OF_SCOPE",
                      rejectedCitations: rejected.map(citation => citation.versionId),
                      issues: rejected.map(citation => ({ code: "custom", path: ["citations", citation.index] })),
                    }),
                  });
                  return parsed;
                }));
                const output = { ...result, citations: [...new Set([...(accumulated?.citations ?? []), ...result.citations])] };
                const saved = await commit(d, run, token, async (tx, current) => {
                  await tx.update(supervisorRuns).set({
                    assignments: (current.assignments as Assignment[]).map(a => a.runId === assignment.runId
                      ? { ...a, sourceProgress: { inputHash, byteLimit, completedBatches: index + 1, output } } : a),
                    history: [...current.history, {
                      phase: "specialist_batch", runId: assignment.runId, revision: current.revision,
                      batch: index + 1, batchCount: batches.length, sourceVersionIds: batchIds, output,
                      companyKnowledge: (current.assignments as Assignment[]).find(a => a.runId === assignment.runId)?.companyKnowledge,
                    }],
                  }).where(eq(supervisorRuns.runId, id));
                  await log(d, tx, run, "specialist_batch_completed", `${index + 1}/${batches.length}`, assignment.runId);
                  await logWorkProgress(d, tx, run, {
                    runId: assignment.runId, stage: "source_findings", sources: workSources,
                    batch: index + 1, batchCount: batches.length, summary: output.summary,
                  });
                });
                if (!saved) throw conflict("Supervisor no longer active");
                accumulated = output;
              }
              const output = specialistOutput.parse(accumulated);
              await commit(d, run, token, async (tx, current) => {
                const receipts = (current.assignments as Assignment[]).find(a => a.runId === assignment.runId)?.calculationReceipts ?? [];
                output.citations = [...new Set([...output.citations, ...receipts.flatMap(receipt =>
                  acousticInputProvenance(receipt.input).flatMap(p => p.kind === "source" ? [p.versionId] : []),
                )])];
                const assignments = (current.assignments as Assignment[]).map(
                  (a) => (a.runId === assignment.runId ? { ...a, output, sourceProgress: undefined } : a),
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
          }
        } catch (error) {
          if (!stopped) failure = error;
          stopped = true;
        }
      }));
      // Let in-flight calls save valid results before releasing the lease. Never
      // start another assignment/batch after the first terminal failure.
      if (stopped) throw failure;
      await commit(d, run, token, async (tx) => {
        await tx
          .update(supervisorRuns)
          .set({ phase: "review" })
          .where(eq(supervisorRuns.runId, id));
        await logWorkProgress(d, tx, run, {
          runId: id, stage: "reviewing_findings", sources: [],
        });
      });
    } else if (state.phase === "review") {
      await commit(d, run, token, async (tx) => {
        await logWorkProgress(d, tx, run, {
          runId: id, stage: "reviewing_findings", sources: [],
          summary: (state.assignments as Assignment[]).map(a => a.output?.summary).filter(Boolean).join("\n\n"),
        });
      });
      const requireSoundInsulation = (state.assignments as Assignment[]).some(a => a.role === "sound_insulation");
      // Only application-assembled concepts are exempt from the per-response cap.
      const reviewSchema = schemas.review.extend({
        document: (conceptId ? agentDocumentSchema : schemas.review.shape.document).nullish(),
      });
      const validateReview = (raw: unknown) => {
        const review = reviewSchema.parse(raw);
        review.document = prepareAgentDocument(review.document, conceptId ?? requireSoundInsulation, conceptId ? null : limits.documentMaxCharacters);
        const allowedCitations = (state.assignments as Assignment[]).flatMap(a => a.output?.citations ?? []);
        if (review.citations.some(v => !allowedCitations.includes(v))) throw conflict("Review introduced unsupported citations");
        assertDocumentCitations(review.document, review.citations);
        if (review.decision === "revise" && state.revision < policy.maxRevisions)
          assertRevisionAssignments(review.revisions, state.assignments as Assignment[]);
        return review;
      };
      const review = validateReview(
        conceptId ? await authorAcousticConcept({
          d, projectId: run.projectId, id: conceptId, goal, limits, maxOutputTokens: policy.supervisor.maxOutputTokens,
          maxParallel: policy.maxParallel,
          inputByteBudget: agentModelInputByteBudget(run.provider, policy.supervisor.modelId, policy.supervisor.maxOutputTokens),
          contextOverhead: {
            documentReview: await artifactReviewContext(d, run.conversationId),
            profiles: state.profileSnapshot?.length ? state.profileSnapshot : defaultProfiles().map(profile => ({ ...profile, knowledge: [] })),
            budgets: { maxTasks: policy.maxTasks, maxRevisions: policy.maxRevisions },
          },
          findings: state.history.filter((entry: any) => entry.phase === "specialist_batch" && entry.revision === state.revision)
            .map((entry: any) => ({ sourceVersionIds: entry.sourceVersionIds, output: entry.output })),
          calculationReceipts: (state.assignments as Assignment[]).flatMap(a => a.calculationReceipts ?? []),
          companyKnowledge: (state.assignments as Assignment[]).flatMap(a => a.companyKnowledge ?? []),
          sourceVersionIds: [...new Set<string>((state.assignments as Assignment[]).flatMap(a => a.output?.citations ?? []))],
          draft: state.review?.documentDraft,
          previousReview: state.review?.documentDraft?.previousReview ?? state.review,
          assertActive,
          call: (context, validate) => call("review", goal, context, id, validate),
          checkpoint: async (documentDraft, section, batch, batchCount) => {
            const saved = await commit(d, run, token, async tx => {
              await tx.update(supervisorRuns).set({ review: { documentDraft } }).where(eq(supervisorRuns.runId, id));
              const editorialStage = section === "editing_document" || section === "checking_editorial" ? section : undefined;
              await logWorkProgress(d, tx, run, { runId: id, stage: editorialStage ?? "reviewing_findings", sources: [],
                ...(!editorialStage ? {
                  ...(batch ? { batch, batchCount } : {}),
                  summary: `${documentDraft.outline.language === "de" ? "Berichtsabschnitt" : "Report section"}: ${section}`,
                } : {}) });
            });
            if (!saved) throw conflict("Supervisor no longer active");
          },
        }) : await call("review", goal, {
          assignments: state.assignments,
          companyKnowledge: (state.assignments as Assignment[]).flatMap(a => a.companyKnowledge ?? []),
          revision: state.revision,
          previousReview: state.review,
          documentTemplate: requireSoundInsulation ? { id: "sound-insulation-review", version: 1 } : undefined,
        }, id, validateReview),
      );
      await sources(d, run.projectId, review.citations);
      if (
        review.decision === "revise" &&
        state.revision < policy.maxRevisions
      ) {
        await commit(d, run, token, async (tx, current) => {
          const assignments = (state.assignments as Assignment[]).map((a) => {
            const revision = review.revisions.find(
              (r) => r.taskId === a.taskId,
            );
            return revision
              ? { ...a, goal: revision.goal, output: undefined, sourceProgress: undefined, calculationReceipts: undefined, companyKnowledge: undefined }
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
                ...current.history,
                { phase: "review", revision: state.revision, output: review },
              ],
            })
            .where(eq(supervisorRuns.runId, id));
          await log(d, tx, run, "supervisor_revision_requested");
          for (const a of assignments.filter((a) => !a.output))
            await logWorkProgress(d, tx, run, {
              runId: a.runId, stage: "revision_requested", sources: [], summary: a.goal,
            });
        });
      } else if (
        review.decision === "accept" &&
        state.modelPolicy?.independentReviewEnabled === true
      ) {
        await commit(d, run, token, async (tx, current) => {
          await tx
            .update(supervisorRuns)
            .set({
              phase: "independent_review",
              review,
              history: [
                ...current.history,
                { phase: "review", revision: state.revision, output: review },
              ],
            })
            .where(eq(supervisorRuns.runId, id));
          await log(d, tx, run, "supervisor_review_completed");
          await log(d, tx, run, "independent_review_started");
        });
      } else {
        await commit(d, run, token, async (tx, current) => {
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
              title: review.document?.title ?? run.goal.slice(0, 200),
              type: "draft",
              content: `${review.document?.content ?? review.summary}\n\nReview rationale\n\n${review.rationale}${review.decision === "revise" ? "\n\nRevision limit reached. Unresolved issues require human review." : ""}`,
              payload: {
                kind: "summary",
                data: [{ summary, rationale: review.rationale }],
                template: review.document?.template,
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
                ...current.history,
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
      await commit(d, run, token, async (tx) => {
        await logWorkProgress(d, tx, run, {
          runId: id, stage: "independent_review", sources: [],
        });
      });
      await sources(d, run.projectId, sourceVersionIds);
      const resolvedExcerpts = await Promise.all(sourceVersionIds.map(async (versionId) => {
        await assertActive();
        // Independent review retains broad evidence coverage, not just the
        // specialist's relevance selection, but never re-extracts the original.
        return { versionId, resolution: readCompleteSources
          ? await resolveCompleteRunSource(d, run.projectId, { versionId }, assertActive)
          : await resolveRunSource(d, run.projectId, { versionId, pageStart: 1 }, assertActive) };
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
        .filter(({ versionId, resolution }: any) => !readableSourceIds.has(versionId) || (readCompleteSources && resolution?.content?.truncated))
        .map(({ versionId, resolution }: any) => ({ versionId, name: resolution?.source?.name ?? null }));
      const coverageIncomplete = sourceVersionIds.length === 0 || unreadableSources.length > 0;
      const firstPassReview = state.review;
      const readableExcerpts = resolvedExcerpts.filter(({ versionId }) => readableSourceIds.has(versionId));
      const sliceResults: { sourceVersionIds: string[]; output: z.infer<typeof independentReview> }[] = [];
      // Reuse old completed slices, but repack their unfinished evidence. Deploying
      // a better batching strategy must not buy already-reviewed evidence again.
      const legacySlices = !state.history.some((entry: any) => entry.phase === "independent_review_slice") ? [] : readCompleteSources
        ? batchSpecialistSources(readableExcerpts.map(({ versionId, resolution }: any) => ({
          versionId, resolution, text: resolution.content.text, truncated: resolution.content.truncated,
        }))).map(batch => batch.map(({ versionId, resolution, text, textRange, truncated }) => ({ versionId,
          resolution: { ...resolution, content: { ...resolution.content, text, textRange, truncated } },
        })))
        : chunkSourceVersionIds([...readableSourceIds]).map(ids => readableExcerpts.filter(({ versionId }) => ids.includes(versionId)));
      const legacyHash = checkpointHash({ goal, assignments, firstPassReview,
        sourceSlices: legacySlices, modelPolicy: state.modelPolicy, profiles: state.profileSnapshot });
      const remaining = legacySlices.filter((slice, index) => {
        const saved = state.history.find((entry: any) => entry.phase === "independent_review_slice"
          && entry.inputHash === legacyHash && entry.index === index);
        if (!saved) return true;
        const ids = [...new Set(slice.map(source => source.versionId))];
        const output = schemas.independent_review.parse(saved.output);
        assertIndependentReviewCitations(output, new Set(ids));
        sliceResults.push({ sourceVersionIds: ids, output });
        return false;
      }).flat();
      const legacyCount = sliceResults.length;
      const contextOverhead = {
        goal, documentReview: await artifactReviewContext(d, run.conversationId),
        componentCatalog: await d.componentContext?.(run.goal),
        profiles: state.profileSnapshot?.length ? state.profileSnapshot : defaultProfiles().map(profile => ({ ...profile, knowledge: [] })),
        budgets: { maxTasks: policy.maxTasks, maxRevisions: policy.maxRevisions },
      };
      const modelBudget = agentModelInputByteBudget(run.provider, policy.supervisor.modelId, policy.supervisor.maxOutputTokens);
      const plan = prepareIndependentReview({ review: firstPassReview ?? {}, assignments,
        sources: legacyCount ? remaining as any : readableExcerpts as any,
        originalGoal: run.goal, revision: state.revision, assignedVersionCount: sourceVersionIds.length,
        readableSourceIds: [...readableSourceIds], unreadableSources, contextOverhead,
        inputByteBudget: modelBudget === undefined ? undefined : modelBudget - AGENT_MESSAGING_CONTEXT_BYTES,
      });
      const inputHash = checkpointHash({ version: 2, goal, assignments, firstPassReview, resolvedExcerpts,
        modelPolicy: state.modelPolicy, profiles: state.profileSnapshot, contextOverhead });
      const needsConsistency = legacyCount > 0 || plan.batches.some(batch => batch.reviewTask === "evidence");
      const batchCount = plan.batches.length + Number(needsConsistency);
      for (let index = 0; index < batchCount; index++) {
        const context = index < plan.batches.length ? plan.batches[index]!
          : plan.consistency(aggregateIndependentReviews(sliceResults, limits));
        context.sourceCoverage.slice = index + 1;
        context.sourceCoverage.sliceCount = batchCount;
        const sourceExcerpts = context.sourceExcerpts;
        const sliceIds = context.sourceCoverage.sliceVersionIds;
        const sliceIdSet = new Set(sliceIds);
        const savedSlice = state.history.find((entry: any) => entry.phase === "independent_review_batch"
          && entry.inputHash === inputHash && entry.index === index);
        if (savedSlice) {
          const output = schemas.independent_review.parse(savedSlice.output);
          assertIndependentReviewCitations(output, sliceIdSet);
          assertIndependentReviewDecision(output, assignments);
          sliceResults.push({ sourceVersionIds: sliceIds, output });
          continue;
        }
        const workSources = [...new Map(sourceExcerpts.map(({ versionId, resolution }: any) => [versionId, {
          versionId, name: resolution.source.name, version: resolution.source.version,
        }] as const)).values()];
        await commit(d, run, token, async (tx) => {
          await logWorkProgress(d, tx, run, {
            runId: id, stage: "independent_review", sources: workSources,
            batch: index + 1, batchCount,
          });
        });
        const output = schemas.independent_review.parse(await call("independent_review", goal, context, id, raw => {
          const parsed = schemas.independent_review.parse(raw);
          assertIndependentReviewCitations(parsed, sliceIdSet);
          assertIndependentReviewDecision(parsed, assignments);
          return parsed;
        }));
        const saved = await commit(d, run, token, async (tx, current) => {
          await tx.update(supervisorRuns).set({ history: [...current.history,
            { phase: "independent_review_batch", inputHash, index, output, sourceVersionIds: sliceIds },
          ] }).where(eq(supervisorRuns.runId, id));
          await logWorkProgress(d, tx, run, {
            runId: id, stage: "independent_review", sources: workSources,
            batch: index + 1, batchCount, summary: output.summary,
          });
          await log(d, tx, run, "independent_review_checkpointed", `${index + 1}/${batchCount}`);
        });
        if (!saved) throw conflict("Supervisor no longer active");
        sliceResults.push({ sourceVersionIds: sliceIds, output });
      }
      const aggregated = aggregateIndependentReviews(sliceResults, limits);
      const output = schemas.independent_review.parse({
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
        await commit(d, run, token, async (tx, current) => {
          const revisedAssignments = assignments.map((assignment) => {
            const revision = output.revisions.find((item) => item.taskId === assignment.taskId);
            return revision ? { ...assignment, goal: revision.goal, output: undefined, sourceProgress: undefined, calculationReceipts: undefined, companyKnowledge: undefined } : assignment;
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
              ...current.history,
              { phase: "independent_review", revision: state.revision, output },
            ],
          }).where(eq(supervisorRuns.runId, id));
          await log(d, tx, run, "independent_review_completed");
          await log(d, tx, run, "independent_review_revision_requested");
          for (const a of revisedAssignments.filter((a) => !a.output))
            await logWorkProgress(d, tx, run, {
              runId: a.runId, stage: "revision_requested", sources: [], summary: a.goal,
            });
        });
      } else {
        await commit(d, run, token, async (tx, current) => {
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
            unresolved ? "Revision limit reached. Unresolved independent-review issues require human review." : "",
          ].filter(Boolean).join("\n\n").slice(0, limits.summaryMaxCharacters);
          const rationale = [
            firstPassReview?.rationale,
            `Independent review rationale\n\n${output.rationale}`,
            findingsSummary.length ? `Independent review findings\n\n${findingsSummary.join("\n\n")}` : "",
            coverageNote,
          ].filter(Boolean).join("\n\n");
          const reviewCitations = [...new Set([
            ...(firstPassReview?.citations ?? []),
            ...output.citations,
            ...output.findings.flatMap((finding) => finding.citations),
          ])];
          d.requirePermission("knowledge:write");
          const resultArtifact = await createArtifact({
            ...d,
            audit: (tx, action, type, entityId, metadata) => d.auditRun(tx, action, type, entityId, id, run.correlationId, metadata),
          }, tx, {
            projectId: run.projectId,
            title: firstPassReview?.document?.title ?? run.goal.slice(0, 200),
            type: "draft",
            content: `${firstPassReview?.document?.content ?? firstPassReview?.summary ?? summary}\n\nReview rationale\n\n${rationale}${unresolved ? "\n\nRevision limit reached. Unresolved independent-review issues require human review." : ""}`,
            payload: { kind: "summary", data: [{ summary, rationale }], template: firstPassReview?.document?.template },
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
              ...current.history,
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
      if (error instanceof z.ZodError)
        await log(d, tx, run, "provider_call_failed", phase, JSON.stringify({ runId: id,
          diagnostics: sanitizeProviderDiagnostics({ errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", issues: error.issues }),
        }));
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
  activeRunIds: string[] = [],
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
        activeRunIds.length ? notInArray(agentRuns.id, activeRunIds) : undefined,
        or(
          isNull(supervisorRuns.leaseUntil),
          lt(supervisorRuns.leaseUntil, new Date()),
        ),
      ),
    )
    .orderBy(agentRuns.updatedAt)
    .limit(Math.max(1, Math.min(8, limit)));
}
