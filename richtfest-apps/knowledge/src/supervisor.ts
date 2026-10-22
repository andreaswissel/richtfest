import { formatSteering, steeringInstructions } from "./steering-context";
import { and, desc, eq, inArray, notInArray, or, isNull, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { agentDocumentSchema, agentPresetSnapshotSchema, agentWorkProgressSchema, prepareAgentDocument, requestedAcousticConcept, acousticConceptIdSchema, specialistRoleSchema, acousticInputReviewSchema, type AgentPresetSnapshot, type AgentWorkProgress, agentOutputSchemas, agentExecutionLimitsSchema, type AgentExecutionLimits, agentModelInputByteBudget } from "@richtfest/shared";
import { z } from "zod";
import type { AppDeps } from "./deps";
import { sanitizeProviderDiagnostics } from "./deps";
import { buildingContextForRun } from "./building-model-context";
import { batchSectionSources, batchSpecialistSources } from "./source-batches";
import {
  agentRuns,
  agentRunEvents,
  agentRunSteps,
  supervisorRuns,
  artifactRevisions,
  tasks,
  messages,
  annotations,
  artifacts,
} from "./schema";
import { snapshotAgentProfiles, defaultProfiles, type ProfileSnapshot } from "./agent-profiles";
import { conflict, missing, sources, createArtifact, artifactReviewContext } from "./workspace";
import { executeTrackedProvider, interruptProviderAttempts } from "./usage";
import { AGENT_MESSAGING_CONTEXT_BYTES, agentMessagingContext, deliverAgentMessage, validateAgentMessageTargets } from "./agent-messages";
import { resolveRunSource, resolveCompleteRunSource, sourceEvidencePackets, compactDocumentPackets, compactDocumentLayers, documentPacketDensityBytes, batchPreparedSourcePages } from "./source-evidence";
import { authorAcousticConcept } from "./acoustic-authoring";
import { prepareIndependentReview } from "./independent-review";
import { acousticCalculationSchema, acousticCalculationResultSchema, acousticInputProvenance, exteriorNoiseExtractionSchema, renderAcousticCalculationReceipts, acousticDatasetSchema, type AcousticCalculationReceipt } from "@richtfest/shared";
import { assembleExteriorNoiseInputs, exteriorNoiseIdentityDirectory, reconcileExteriorNoiseInputs, validateExteriorNoiseExtraction } from "./acoustic-extraction";
import { createAcousticInputReview } from "./acoustic-input-review";
import { createFireProtectionAssessment, type FireProtectionToolResult } from "./fire-protection-assessment";
import { recordStep, savedStep, stepHash } from "./run-steps";
import { companyKnowledgeSearchSchema, sourceVisualRequestSchema, type CompanyKnowledgeReceipt, type SourceVisual, type SourceVisualRequest } from "@richtfest/shared";
import { sourceImageQuerySchema, SOURCE_IMAGE_MODEL, SOURCE_IMAGE_QUERY_VERSION, type SourceImageReceipt } from "@richtfest/shared";
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

type VisualInspectionReceipt = {
  receiptId: string;
  versionId: string;
  page: number;
  crop: SourceVisualRequest["crop"] | null;
  imageHash: string;
};
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
  exteriorNoiseExtractionVersion?: 1 | 2;
  exteriorNoisePacketVersion?: 1 | 2;
  sourceIdentityContext?: { inputHash: string; batch: number; identities: ReturnType<typeof exteriorNoiseIdentityDirectory> };
  output?: z.infer<typeof specialistOutput>;
  calculationReceipts?: AcousticCalculationReceipt[];
  fireProtection?: FireProtectionToolResult;
  calculationEvidenceHash?: string;
  companyKnowledge?: CompanyKnowledgeReceipt[];
  visualReads?: { request: SourceVisualRequest; status: SourceVisual["status"]; receiptId: string }[];
  visualFollowup?: { requests: SourceVisualRequest[]; previousFindings: z.infer<typeof specialistOutput> };
  sourceProgress?: {
    inputHash: string;
    byteLimit?: number;
    completedBatches: number;
    output: z.infer<typeof specialistOutput>;
  };
};

const VISUAL_READ_CONTEXT_LIMIT = 40;
function visualReadCoverage(assignments: Assignment[], limit = VISUAL_READ_CONTEXT_LIMIT) {
  // Reads are already replaced by exact request in each assignment. If sibling
  // assignments requested the same target, prefer a successful image receipt
  // over an earlier budget result; that receipt still says nothing about model
  // delivery or semantic inspection.
  const targets = new Map<string, { taskId: string; request: SourceVisualRequest; status: SourceVisual["status"]; receiptId: string }>();
  for (const assignment of assignments) for (const read of assignment.visualReads ?? []) {
    const request = { ...read.request, crop: read.request.crop ?? null } as SourceVisualRequest;
    const key = stepHash(request);
    const previous = targets.get(key);
    if (!previous || (read.status === "available" && previous.status !== "available"))
      targets.set(key, { taskId: assignment.taskId, ...read, request });
  }
  const all = [...targets.values()].sort((a, b) => stepHash(a.request).localeCompare(stepHash(b.request)));
  const entries = all.slice(0, limit).map(({ taskId, request, status, receiptId }) => ({
    taskId,
    versionId: request.versionId,
    page: request.page,
    crop: request.crop ?? null,
    status,
    receiptId,
  }));
  return {
    entries,
    total: all.length,
    included: entries.length,
    omitted: Math.max(0, all.length - entries.length),
    note: "A status of available proves the image tool returned that page/crop in a recorded call. It does not prove the provider received it or semantically inspected it. Omitted entries may exist; omission does not mean a target was not rendered.",
  };
}
async function assertPinnedInputReview(d: AppDeps, run: any, marker: any, tx: any) {
  const artifactId = marker?.inputReviewArtifactId;
  const expectedRevisionId = marker?.expectedInputReviewRevisionId;
  if (typeof artifactId !== "string" || typeof expectedRevisionId !== "string")
    throw conflict("Input reassessment has no pinned review artifact");
  const [artifact] = await tx.select({ id: artifacts.id }).from(artifacts).where(and(
    eq(artifacts.id, artifactId), eq(artifacts.tenantId, d.tenantId),
    eq(artifacts.projectId, run.projectId), eq(artifacts.runId, run.id),
  )).for("update");
  if (!artifact) throw conflict("The pinned acoustic input-review artifact is unavailable");
  const [revision] = await tx.select({ id: artifactRevisions.id, payload: artifactRevisions.payload })
    .from(artifactRevisions).where(and(eq(artifactRevisions.tenantId, d.tenantId),
      eq(artifactRevisions.artifactId, artifact.id))).orderBy(desc(artifactRevisions.version)).limit(1);
  if (!revision || revision.id !== expectedRevisionId)
    throw conflict("The acoustic input review changed during reassessment; generated progress was not published");
  const parsed = acousticInputReviewSchema.safeParse(revision.payload?.acousticInputReview);
  if (!parsed.success || parsed.data.conversationId !== run.conversationId
    || parsed.data.resolutions.length || parsed.data.visualMappings.length
    || parsed.data.visualAreaReviews.length || parsed.data.inventoryConfirmation)
    throw conflict("The pinned review is no longer decision-free; generated progress was not published");
}
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
    if (!(await d.validateProject(run.projectId, tx)))
      throw missing("Project not found");
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
  let orphaned = false;
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
    orphaned = (await interruptProviderAttempts(d, tx, id, "expired_supervisor_lease")) > 0;
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
    if (orphaned) throw Object.assign(new Error("Previous provider outcome unknown"), { code: "outcome_unknown" });
    d.requirePermission("projects:read");
    d.requirePermission("agent:run");
    d.requirePermission("knowledge:read");
    d.requirePermission("knowledge:write");
    if (!(await d.validateProject(run.projectId)))
      throw conflict("Project unavailable");
    if (!d.executeSupervisor) throw conflict("Supervisor unavailable");
    const policy = agentPresetSnapshotSchema.parse(state.modelPolicy);
    const inputReassessmentOnly = state.review?.inputReassessmentOnly === true;
    if (inputReassessmentOnly) {
      if (state.phase !== "review" || policy.workflow?.mode !== "calculation")
        throw conflict("Input reassessment is limited to the saved acoustic calculation review phase");
      if (!(state.assignments as Assignment[]).some(a => a.exteriorNoiseExtractionVersion === 2))
        throw conflict("Saved version-2 acoustic extraction is unavailable for input reassessment");
      await d.db.transaction((tx: any) => assertPinnedInputReview(d, run, state.review, tx));
    }
    const limits = policy.executionLimits;
    const schemas = agentOutputSchemas(limits);
    // A fresh report must not inherit earlier answers through quoted artifact feedback.
    const documentReview = policy.workflow?.mode === "report"
      ? { comments: [], documents: [] }
      : await artifactReviewContext(d, run.conversationId);
    await assertCompanyKnowledgeCurrent(d, (state.assignments as Assignment[]).flatMap(a => a.companyKnowledge ?? []));
    const assertActive = async () => {
      if (!(await commit(d, run, token, async () => {})))
        throw conflict("Supervisor no longer active");
    };
    const currentVisualReadCoverage = async (assignmentRunId?: string) => {
      const [current] = await d.db.select({ assignments: supervisorRuns.assignments })
        .from(supervisorRuns).where(and(eq(supervisorRuns.runId, id), eq(supervisorRuns.tenantId, d.tenantId)));
      const assignments = (current?.assignments ?? state.assignments) as Assignment[];
      return visualReadCoverage(assignmentRunId
        ? assignments.filter(assignment => assignment.runId === assignmentRunId)
        : assignments);
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
      validate?: (output: unknown, visualVersionIds?: string[], visualReceipts?: VisualInspectionReceipt[]) => unknown,
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
      const visualOnly = !!(context as { visualRequests?: SourceVisualRequest[] }).visualRequests;
      const appendixWriter = phase === "review" && (context as { inputMode?: string }).inputMode === "imported-calculation-evidence";
      const editorialPacket = phase === "review" && (context as { inputMode?: string }).inputMode === "editorial-packet";
      const consolidation = phase === "review" && ["editorial-consolidation", "patch-editorial-v1"].includes((context as { inputMode?: string }).inputMode ?? "");
      const evidenceIsolatedWorkflow = policy.workflow?.mode === "calculation" || policy.workflow?.mode === "report";
      const messagingScope = evidenceIsolatedWorkflow ? { familyRootRunId: id } : undefined;
      const fireRole = (context as { role?: keyof typeof policy.specialists }).role;
      const fireToolsAvailable = phase === "specialist" && !visualOnly && !(context as { extractExteriorNoise?: boolean }).extractExteriorNoise
        && (!policy.workflow || policy.workflow.mode === "team") && !!d.fireProtectionSnapshot
        && (fireRole === "requirements_reviewer" || fireRole === "construction_law") && (policy.specialists[fireRole]?.maxSteps ?? 1) >= 2;
      const providerContext = {
        ...(context as object),
        fireProtection: { toolAvailable: fireToolsAvailable, inputSource: "saved_building_model", draftOnly: true },
        buildingModel: visualOnly || appendixWriter || editorialPacket || consolidation ? undefined : await buildingContextForRun(d, run),
        buildingModelPolicy: "Read-only project context. Use current approved properties and stable object links; imported or proposed claims are not reviewed facts. No building-model mutation or approval is available in Team/Report. This context does not authorize engineering calculations.",
        companyKnowledge: (context as { companyKnowledge?: CompanyKnowledgeReceipt[] }).companyKnowledge ?? [],
        companyKnowledgeCategories: !visualOnly && phase === "specialist" && (policy.specialists[(context as { role: keyof typeof policy.specialists }).role]?.maxSteps ?? 1) >= 2
          ? await companyKnowledgeCategories(d) : undefined,
        acousticToolsAvailable: !visualOnly && !(context as { extractExteriorNoise?: boolean }).extractExteriorNoise
          && !!d.calculateAcoustics && (policy.specialists.sound_insulation?.maxSteps ?? 0) >= 2,
        ...(!(context as { documentTask?: string }).documentTask
          ? { messaging: await agentMessagingContext(d, sender, messagingScope) } : {}),
        componentCatalog: appendixWriter || editorialPacket || consolidation ? undefined : await d.componentContext?.(run.goal),
        documentReview,
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
      const visuallyInspected = new Set<string>();
      const visualInspectionReceipts = new Map<string, VisualInspectionReceipt>();
      if (d.inspectSource && phase !== "plan") {
        // A cached provider output may skip tool execution on resume. Only this
        // exact call's successful persisted visual receipts restore its citations.
        const previousReads = await d.db.select({ id: agentRunSteps.id, output: agentRunSteps.output }).from(agentRunSteps).where(and(
          eq(agentRunSteps.tenantId, d.tenantId), eq(agentRunSteps.runId, runId), eq(agentRunSteps.kind, "tool"),
          eq(agentRunSteps.status, "completed"), sql`${agentRunSteps.stepKey} like ${`visual:${callKey}:%`}`,
        ));
        for (const { id: receiptId, output } of previousReads) {
          const receipt = output as { status?: string; versionId?: string; page?: number; crop?: SourceVisualRequest["crop"]; imageHash?: string } | null;
          if (receipt?.status === "available" && receipt.versionId && receipt.page && receipt.imageHash) {
            visuallyInspected.add(receipt.versionId);
            const request = sourceVisualRequestSchema.parse({ versionId: receipt.versionId, page: receipt.page, crop: receipt.crop });
            visualInspectionReceipts.set(stepHash(request), { receiptId, versionId: request.versionId,
              page: request.page, crop: request.crop ?? null, imageHash: receipt.imageHash });
          }
        }
      }
      // Render only this call's source scope. Cache within inference, and persist
      // page/crop/hash receipts, never megabytes of image data in run checkpoints.
      const visualReads = new Map<string, Promise<SourceVisual>>();
      const inspectSource: Parameters<NonNullable<AppDeps["executeSupervisor"]>>[0]["inspectSource"] =
        d.inspectSource && phase !== "plan" ? async (raw, signal) => {
          signal?.throwIfAborted();
          await assertActive();
          const parsed = sourceVisualRequestSchema.parse(raw);
          const input = { ...parsed, crop: parsed.crop ?? undefined };
          const scope = context as { sourceVersionIds?: string[]; visualSourceVersionIds?: string[]; visualRequests?: SourceVisualRequest[]; sourceCoverage?: { sliceVersionIds?: string[] }; sourcePageScope?: { versionId: string; pages: number[] }[] };
          const allowed = new Set([...(scope.sourceVersionIds ?? scope.sourceCoverage?.sliceVersionIds ?? []), ...(scope.visualSourceVersionIds ?? [])]);
          if (!allowed.has(input.versionId)) throw conflict("Visual source is outside this call's source scope");
          const enforcedPageScope = policy.workflow?.mode === "report" || policy.workflow?.mode === "calculation"
            ? policy.workflow.sourcePageScope : undefined;
          const allowedPages = enforcedPageScope?.find(entry => entry.versionId === input.versionId)?.pages;
          if (enforcedPageScope && !allowedPages?.includes(input.page)) throw conflict("Visual page is outside this call's explicit page scope");
          const inputHash = stepHash(input);
          if (scope.visualRequests && !scope.visualRequests.some(request => stepHash(request) === inputHash))
            throw conflict("Visual request is outside this follow-up's exact page/crop scope");
          const cached = visualReads.get(inputHash);
          if (cached) return cached;
          const exhausted = visualReads.size >= 4;
          const read = (async () => {
            await sources(d, run.projectId, [input.versionId]);
            const result: SourceVisual = exhausted
              ? { ...input, status: "budget_exhausted", reason: "Not inspected: this call's four distinct visual reads are used. The application retains this exact request for bounded follow-up; this does not mean the source is unreadable." }
              : await d.inspectSource!(run.projectId!, input, signal);
            signal?.throwIfAborted();
            const { image, ...metadata } = result;
            const output = { ...metadata, ...(image ? { imageHash: createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex") } : {}) };
            const stepKey = `visual:${callKey}:${inputHash}`;
            let savedReceiptId: string | undefined;
            const saved = await commit(d, run, token, async (tx, current) => {
              const previous = await savedStep(d, runId, "tool", stepKey, inputHash, tx);
              // A failed render may recover on an explicit retry. Retain that
              // successful receipt too so cached model replay can cite it.
              const receipt = !previous || stepHash(previous.output) !== stepHash(output) ? await recordStep(d, tx, { ...run, id: runId, generation: state.generation }, {
                kind: "tool", stepKey, inputHash, input: { name: "inspect_project_source", input },
                output, status: "completed",
              }) : previous;
              savedReceiptId = receipt.id;
              if (phase === "specialist") await tx.update(supervisorRuns).set({
                assignments: (current.assignments as Assignment[]).map(a => a.runId !== runId ? a : {
                  ...a, visualReads: [...(a.visualReads ?? []).filter(read => stepHash(read.request) !== inputHash),
                    { request: input, status: result.status, receiptId: receipt.id }],
                }),
              }).where(eq(supervisorRuns.runId, id));
            });
            if (!saved) throw conflict("Supervisor no longer active");
            if (result.status === "available" && image && typeof output.imageHash === "string") {
              visuallyInspected.add(input.versionId);
              if (savedReceiptId) visualInspectionReceipts.set(inputHash, { receiptId: savedReceiptId,
                versionId: input.versionId, page: input.page, crop: input.crop ?? null, imageHash: output.imageHash });
            }
            return savedReceiptId ? { ...result, receiptId: savedReceiptId,
              ...(typeof output.imageHash === "string" ? { imageHash: output.imageHash } : {}) } : result;
          })();
          visualReads.set(inputHash, read);
          return read;
        } : undefined;
      const imageQueries = new Map<string, Promise<SourceImageReceipt>>();
      const querySourceImage: Parameters<NonNullable<AppDeps["executeSupervisor"]>>[0]["querySourceImage"] =
        !visualOnly && d.querySourceImage && d.executeImageDecision && (phase === "specialist" || phase === "independent_review")
          ? async (raw, signal) => {
            signal?.throwIfAborted();
            await assertActive();
            const input = sourceImageQuerySchema.parse(raw);
            const scope = context as { sourceVersionIds?: string[]; visualSourceVersionIds?: string[]; sourceCoverage?: { sliceVersionIds?: string[] }; sourcePageScope?: { versionId: string; pages: number[] }[] };
            const allowed = new Set([...(scope.sourceVersionIds ?? scope.sourceCoverage?.sliceVersionIds ?? []), ...(scope.visualSourceVersionIds ?? [])]);
            if (!allowed.has(input.versionId)) throw conflict("Image query is outside this call's source scope");
            const enforcedPageScope = policy.workflow?.mode === "report" || policy.workflow?.mode === "calculation"
              ? policy.workflow.sourcePageScope : undefined;
            const allowedPages = enforcedPageScope?.find(entry => entry.versionId === input.versionId)?.pages;
            if (enforcedPageScope && !allowedPages?.includes(input.page)) throw conflict("Image page is outside this call's explicit page scope");
            await sources(d, run.projectId, [input.versionId]);
            const inputHash = stepHash(input);
            const cached = imageQueries.get(inputHash);
            if (cached) return cached;
            const base = { versionId: input.versionId, page: input.page, crop: input.crop,
              provenance: "inferred" as const, semanticInspection: false as const,
              queryVersion: SOURCE_IMAGE_QUERY_VERSION, model: SOURCE_IMAGE_MODEL } as const;
            if (imageQueries.size >= 4) return { ...base, status: "limit_reached",
              reason: "Four distinct image queries used. Use direct visual inspection if needed; this is not evidence of absence." };
            const pending = (async (): Promise<SourceImageReceipt> => {
              let output: SourceImageReceipt;
              try {
                output = await d.querySourceImage!(run.projectId!, input, image => executeTrackedProvider(d,
                  { ...run, id: runId, provider: "typesafe" },
                  { phase: "image_query", generation: state.generation, rootRunId: id, leaseToken: token, assertActive },
                  telemetry => d.executeImageDecision!({ ...image, ...telemetry, runId })), signal);
              } catch (error) {
                signal?.throwIfAborted();
                if (["budget_exhausted", "outcome_unknown"].includes(String((error as { code?: unknown })?.code))) throw error;
                output = { ...base, status: "outcome_unknown",
                  reason: "Image question failed or its outcome is unknown. No absence or inspection is established; use direct vision if needed." };
              }
              await assertActive();
              const saved = await commit(d, run, token, async tx => {
                await recordStep(d, tx, { ...run, id: runId, generation: state.generation }, {
                  kind: "tool", stepKey: `image-query:${callKey}:${inputHash}`, inputHash,
                  input: { name: "query_source_image", input }, output, status: "completed",
                });
              });
              if (!saved) throw conflict("Supervisor no longer active");
              // Deliberately do not add to visuallyInspected or satisfy deferred visual reads.
              return output;
            })();
            imageQueries.set(inputHash, pending);
            return pending;
          } : undefined;
      let environmentResearch: Promise<import("@richtfest/shared").EnvironmentSurvey> | undefined;
      const researchProjectEnvironment = !visualOnly && phase === "specialist" && run.projectId
        && d.researchProjectEnvironment && ["source_reviewer", "requirements_reviewer", "sound_insulation"].includes((context as { role?: string }).role ?? "")
        && (policy.specialists[(context as { role: keyof typeof policy.specialists }).role]?.maxSteps ?? 1) >= 2
        ? (signal?: AbortSignal) => environmentResearch ??= (async () => {
          signal?.throwIfAborted();
          await assertActive();
          const output = await d.researchProjectEnvironment!(run.projectId!, signal);
          signal?.throwIfAborted();
          await assertActive();
          const input = { projectId: run.projectId, refresh: false };
          const inputHash = stepHash({ input, output });
          const saved = await commit(d, run, token, async tx => {
            await recordStep(d, tx, { ...run, id: runId, generation: state.generation }, {
              kind: "tool", stepKey: `environment-research:${callKey}:${inputHash}`, inputHash,
              input: { name: "research_project_environment", input }, output, status: "completed",
            });
            await log(d, tx, { ...run, id: runId }, "tool_executed", "research_project_environment", "Saved project environmental research receipt");
          });
          if (!saved) throw conflict("Supervisor no longer active");
          return output;
        })() : undefined;
      const searchKnowledge: Parameters<NonNullable<AppDeps["executeSupervisor"]>>[0]["searchCompanyKnowledge"] =
        !visualOnly && phase === "specialist" && (policy.specialists[(context as { role: keyof typeof policy.specialists }).role]?.maxSteps ?? 1) >= 2
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
                ? { runId, correlationId: run.correlationId, goal: assignment.goal, generation: state.generation, signal, rootRunId: id, leaseToken: token, assertActive }
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
            const calculationSourceIds = new Set<string>();
            for (const provenance of acousticInputProvenance(input)) {
              if (provenance.kind === "source") {
                if (!allowed.has(provenance.versionId)) throw conflict("Calculation source is outside the current readable batch");
                const excerpt = (context as { sources: { versionId: string; text: string }[] }).sources
                  .find(source => source.versionId === provenance.versionId && source.text.includes(provenance.excerpt));
                if (!excerpt) throw conflict("Calculation quotation is absent from the current source text");
                calculationSourceIds.add(provenance.versionId);
              }
            }
            if (calculationSourceIds.size) await sources(d, run.projectId, [...calculationSourceIds]);
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
      const prepareFireProtection: Parameters<NonNullable<AppDeps["executeSupervisor"]>>[0]["prepareFireProtection"] = fireToolsAvailable
        ? async signal => {
          signal?.throwIfAborted();
          await assertActive();
          const allowed = (context as { sourceVersionIds?: string[] }).sourceVersionIds ?? [];
          const inputHash = stepHash({ sourceVersionIds: allowed });
          const stepKey = `fire-protection:${callKey}`;
          let result: FireProtectionToolResult | undefined;
          const saved = await commit(d, run, token, async (tx, current) => {
            signal?.throwIfAborted();
            if (!(current.assignments as Assignment[]).some(a => a.runId === runId && a.role === fireRole))
              throw conflict("Fire assessment specialist unavailable");
            d.requirePermission("knowledge:write");
            d.requirePermission("projects:read");
            const previous = await savedStep(d, runId, "tool", stepKey, inputHash, tx);
            await sources(d, run.projectId, allowed);
            result = previous?.output as FireProtectionToolResult | undefined ?? await createFireProtectionAssessment({ ...d,
              audit: (inner, action, type, entityId, metadata) => d.auditRun(inner, action, type, entityId, runId, run.correlationId, metadata),
            }, run.projectId, tx, runId, allowed);
            signal?.throwIfAborted();
            if (!previous) await recordStep(d, tx, { ...run, id: runId, generation: state.generation }, {
              kind: "tool", stepKey, inputHash, input: { name: "prepare_fire_protection_assessment", input: {} }, output: result, status: "completed",
            });
            await tx.update(supervisorRuns).set({ assignments: (current.assignments as Assignment[]).map(a =>
              a.runId === runId ? { ...a, fireProtection: result } : a) }).where(eq(supervisorRuns.runId, id));
            if (!previous) await log(d, tx, { ...run, id: runId }, "tool_executed", "prepare_fire_protection_assessment", `${result.status}; human review required`);
          });
          if (!saved) throw conflict("Supervisor no longer active");
          signal?.throwIfAborted();
          return result!;
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
            phase, operationId: callId, attemptNumber: attempt, generation: state.generation, rootRunId: id, leaseToken: token, assertActive,
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
            prepareFireProtection,
            searchCompanyKnowledge: searchKnowledge,
            researchProjectEnvironment,
            inspectSource,
            querySourceImage,
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
            if (response.status === "completed") {
              try {
                validateAgentMessageTargets(response.output, providerContext.messaging);
                if (validate) response.output = validate(response.output, [...visuallyInspected], [...visualInspectionReceipts.values()]);
              }
              catch (error) {
                if (!(error instanceof z.ZodError)) throw error;
                throw Object.assign(new Error("Agent output validation failed."), {
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
              await deliverAgentMessage(d, tx, sender, message, `supervisor:${callKey}:${index}`, messagingScope);
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
          const splitIncompletePacket = editorialPacket && (context as { splitOnIncomplete?: boolean }).splitOnIncomplete === true
            && diagnostics.issues?.some(issue => issue.editorial?.reason === "incomplete");
          const shouldRetry = metadata.providerFailure === true && metadata.retryable === true
            && !splitTruncatedSection && !splitIncompletePacket && !quotaFailure && failureCategory !== "permission" && failureCategory !== "timeout" && !cooldownExceedsBudget && attempt < maxAttempts;
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
    const steering = formatSteering(state.steering);
    const goal = `${run.goal}${steering ? `\nHuman steering: ${steering}` : ""}`;
    const plannedTemplate = state.history.findLast((entry: any) => entry.phase === "plan")?.output?.documentTemplate;
    const workflow = policy.workflow;
    const calculationOnly = workflow?.mode === "calculation";
    const sourcePageScope = workflow?.mode === "report" || workflow?.mode === "calculation"
      ? workflow.sourcePageScope : undefined;
    const scopedPages = new Map<string, Set<number>>(sourcePageScope?.map(scope => [scope.versionId, new Set(scope.pages)] as const) ?? []);
    const conceptId = workflow
      ? workflow.mode === "report" ? acousticConceptIdSchema.safeParse(workflow.reportTemplate).data : undefined
      : steeringInstructions(state.steering).map(entry => requestedAcousticConcept(entry)).reverse().find(Boolean) ?? requestedAcousticConcept(run.goal)
        ?? acousticConceptIdSchema.safeParse(plannedTemplate).data;
    const readCompleteSources = calculationOnly || !!conceptId || state.history.findLast((entry: any) => entry.phase === "plan")?.strategy === "selected_source_summary";
    if (state.phase === "plan") {
      const sourceInventory = await d.listProjectSources(run.projectId);
      if (workflow?.mode === "report" || calculationOnly) {
        await sources(d, run.projectId, run.sourceVersionIds);
        // Report evidence is pinned at creation, not expanded by later uploads.
        sourceInventory.sources = sourceInventory.sources.filter(source => run.sourceVersionIds.includes(source.versionId));
      }
      let pageScopeCoverage: any[] | undefined;
      if (sourcePageScope) {
        pageScopeCoverage = await Promise.all(sourcePageScope.map(async scope => {
          const resolved = await resolveCompleteRunSource(d, run.projectId, { versionId: scope.versionId, preferDocumentModel: true }, assertActive);
          const totalPages = resolved?.content?.documentModel?.coverage?.totalPages;
          if (resolved?.status !== "resolved" || resolved.source?.versionId !== scope.versionId
            || resolved.content?.status !== "available" || typeof totalPages !== "number" || !Number.isInteger(totalPages) || totalPages < 1)
            throw conflict("Page-scoped reports require a complete original-page document model for every selected version");
          const modeledPages = new Set((resolved.content.documentModel.pages ?? []).map((page: any) => page.page));
          const missingPage = scope.pages.find(page => !modeledPages.has(page));
          if (missingPage !== undefined) throw conflict(`Requested original page ${missingPage} is missing from the saved page model`);
          const invalidPage = scope.pages.find(page => page > totalPages);
          if (invalidPage !== undefined) throw conflict(`Requested original page ${invalidPage} exceeds the source document's ${totalPages} pages`);
          return { versionId: scope.versionId, totalPages, requestedPages: [...scope.pages].sort((a, b) => a - b),
            completeDocumentCoverage: false, omittedPageCount: totalPages - scope.pages.length,
            note: "Only explicitly requested original pages are evaluated; omitted pages were not evaluated and are not evidence of absence." };
        }));
      }
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
        workflow,
        ...(sourcePageScope ? { sourcePageScope, sourceDocumentCoverage: pageScopeCoverage,
          sourceCoverage: { completeDocumentCoverage: false,
            note: "Only explicitly requested original pages are in scope; omitted pages were not evaluated and their absence is not established." } } : {}),
        sourceVersionIds: run.sourceVersionIds,
        sourceInventory,
        // New reports start from their request and evidence, not an earlier answer
        // or a quoted comparison report already present in conversation history.
        history: (workflow?.mode === "report" || calculationOnly ? [] : history).slice(0, 20)
          .map((m: any) => ({ ...m, body: m.body.slice(0, 1000) })).reverse(),
        artifacts: workflow?.mode === "report" || calculationOnly ? [] : recentArtifacts,
      };
      let fastSummary = false;
      const routing = policy.decisionRouting;
      if (!workflow && routing && routing.mode !== "off") {
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
          : await classifyRun(d, run, { state: decisionState, minConfidence: routing.minConfidence, generation: state.generation, leaseToken: token, assertActive }));
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
        if ((workflow?.mode === "report" || calculationOnly) && run.sourceVersionIds.some((versionId: string) =>
          !parsed.tasks.some(task => task.sourceVersionIds.includes(versionId))))
          throw conflict("Report plan must cover every selected source version");
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
            ...((conceptId ?? plan.documentTemplate) === "exterior-noise-concept" || calculationOnly
              ? { exteriorNoiseExtractionVersion: 2 as const, exteriorNoisePacketVersion: 2 as const } : {}),
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
              // A visual continuation reuses saved findings, not another OCR/text pass.
              const readingVersionIds = assignment.visualFollowup ? [] : assignment.sourceVersionIds;
              const excerpts = await Promise.all(
                readingVersionIds.map(async (versionId) => {
                  await assertActive();
                  return readCompleteSources
                    ? resolveCompleteRunSource(d, run.projectId, { versionId, preferDocumentModel: calculationOnly || !!conceptId }, assertActive)
                    : resolveRunSource(d, run.projectId, { versionId, textQuery: assignment.goal }, assertActive);
                }),
              );
              const resolvedSources = readingVersionIds.map(
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
              // Unreadable text is not unreadable imagery. These identifiers are
              // inspection candidates, never citation targets until a tool read succeeds.
              const unreadableSources = resolvedSources
                .filter(({ versionId, excerpt }) =>
                  !readableSourceIds.has(versionId) ||
                  excerpt?.source?.versionId !== versionId,
                )
                .map(({ versionId, excerpt }) => ({
                  ...(d.inspectSource ? { versionId } : {}),
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
              const evidencePacketSources = sourcePageScope
                ? resolvedSources.filter(({ versionId, excerpt }) => excerpt?.status === "resolved"
                  && excerpt?.source?.versionId === versionId && excerpt?.content?.status === "available"
                  && !!excerpt?.content?.documentModel)
                : readableSources;
              if (sourcePageScope && !assignment.visualFollowup && evidencePacketSources.length !== assignment.sourceVersionIds.length)
                throw conflict("Page-scoped reports require a page-addressable document model for every assigned source version");
              const evidencePacketSourceIds = new Set(evidencePacketSources.map(({ versionId }) => versionId));
              const specialistSources = evidencePacketSources.flatMap(
                ({ versionId, excerpt }) => sourceEvidencePackets(versionId, excerpt),
              );
              let scopedCoverage: any[] | undefined;
              if (sourcePageScope && !assignment.visualFollowup) {
                const beforeCount = specialistSources.length;
                const coverageByVersion = new Map<string, any>(evidencePacketSources.flatMap(({ versionId, excerpt }) => {
                  const totalPages = excerpt.content.documentModel?.coverage?.totalPages;
                  const pages = scopedPages.get(versionId);
                  return pages && typeof totalPages === "number" && Number.isInteger(totalPages) && totalPages > 0
                    ? [[versionId, { versionId, totalPages, requestedPages: [...pages].sort((a, b) => a - b),
                        completeDocumentCoverage: false, omittedPageCount: totalPages - pages.size,
                        note: "Only explicitly requested original pages are evaluated; omitted pages were not evaluated and are not evidence of absence." }] as const]
                    : [];
                }));
                for (const versionId of assignment.sourceVersionIds) {
                  if (!coverageByVersion.has(versionId) || !evidencePacketSourceIds.has(versionId))
                    throw conflict("Page-scoped reports require page-addressable evidence for every assigned source version");
                }
                const pageOf = (packet: any) => packet.sourcePage
                  ?? (packet.evidenceKind === "source_fact" && packet.sourceFact?.fact?.evidence?.kind === "text"
                    ? packet.sourceFact.fact.evidence.page : undefined);
                for (let index = specialistSources.length - 1; index >= 0; index--) {
                  const packet = specialistSources[index]!;
                  const allowedPages = scopedPages.get(packet.versionId);
                  const page = pageOf(packet);
                  if (!allowedPages || !Number.isInteger(page) || !allowedPages.has(page)) specialistSources.splice(index, 1);
                }
                scopedCoverage = [...coverageByVersion.values()].filter(entry => assignment.sourceVersionIds.includes(entry.versionId))
                  .map(entry => ({ ...entry,
                    suppliedPages: [...new Set(specialistSources.filter(packet => packet.versionId === entry.versionId).map(pageOf)
                      .filter((page: unknown): page is number => Number.isInteger(page)))].sort((a: number, b: number) => a - b),
                    filteredPacketCount: beforeCount - specialistSources.length,
                  }));
              }
              const sourceDocumentCoverage = evidencePacketSources.flatMap(({ versionId, excerpt }) =>
                excerpt.content.documentModel ? [{ versionId, ...excerpt.content.documentModel.coverage,
                  ...(sourcePageScope ? { layerMetadata: "Omitted because PDF layer names and paths have no verified association with the scoped original pages." }
                    : { layers: compactDocumentLayers(excerpt.content.documentModel.layers) }),
                  excludedRejectedClaims: excerpt.content.sourceClaims?.excludedRejectedCount ?? 0,
                  semanticClaimsCoverage: excerpt.content.sourceClaims?.coverage ?? "No saved semantic claims.",
                  evidencePolicy: excerpt.content.reason }] : []).map((coverage: any) => {
                    const scoped = scopedCoverage?.find(entry => entry.versionId === coverage.versionId);
                    return scoped ? { ...coverage, ...scoped } : coverage;
                  }).concat(sourcePageScope && assignment.visualFollowup
                    ? sourcePageScope.filter(entry => assignment.sourceVersionIds.includes(entry.versionId)).map(entry => ({
                        versionId: entry.versionId, requestedPages: entry.pages, completeDocumentCoverage: false,
                        note: "Visual follow-up is restricted to these original pages; omitted pages were not evaluated and their absence is not established.",
                      })) : []);
              const extractExteriorNoise = (conceptId === "exterior-noise-concept" || calculationOnly) && !!assignment.exteriorNoiseExtractionVersion;
              const boundedExtraction = extractExteriorNoise && assignment.exteriorNoiseExtractionVersion === 2 && !!assignment.exteriorNoisePacketVersion;
              const specialistSchema = extractExteriorNoise
                ? schemas.specialist.extend({ exteriorNoiseExtraction: exteriorNoiseExtractionSchema }) : schemas.specialist;
              // Reserve the maximum accumulated findings (including JSON escaping),
              // variable context and instructions/schema before packing whole pages.
              // Persist the chosen limit with progress so retries never repack saved work.
              const inputByteLimit = assignment.sourceInputByteBudget === undefined
                ? assignment.sourceBatchingVersion === 2 ? 48 * 1024 : undefined
                : assignment.sourceInputByteBudget - 16384 - 6 * (limits.summaryMaxCharacters + limits.rationaleMaxCharacters) - 8000
                  // Five tool schemas currently serialize to ~18 KiB; leave headroom.
                  - (assignment.role === "sound_insulation" && d.calculateAcoustics ? 24576 : 0)
                  - AGENT_MESSAGING_CONTEXT_BYTES
                  - ((policy.specialists[assignment.role as keyof typeof policy.specialists]?.maxSteps ?? 1) >= 2 ? COMPANY_KNOWLEDGE_CONTEXT_BYTES : 0)
                  - Buffer.byteLength(JSON.stringify({ goal: assignment.goal, role: assignment.role, unreadableSources, sourceDocumentCoverage,
                    sourceVersionIds: assignment.sourceVersionIds,
                    documentReview,
                    profiles: state.profileSnapshot?.length ? state.profileSnapshot : defaultProfiles().map(profile => ({ ...profile, knowledge: [] })),
                    budgets: { maxTasks: policy.maxTasks, maxRevisions: policy.maxRevisions },
                  }), "utf8");
              // Detailed field extraction expands evidence into many quoted records.
              // A large input context is not a suitable extraction-output budget.
              const extractionByteLimit = Math.max(1024, Math.min(16 * 1024,
                policy.specialists[assignment.role as keyof typeof policy.specialists]?.maxOutputTokens ?? 6000));
              const byteLimit = assignment.sourceProgress?.byteLimit ?? (boundedExtraction
                ? Math.min(inputByteLimit ?? 48 * 1024, extractionByteLimit) : inputByteLimit);
              if (byteLimit !== undefined && byteLimit < 1024) throw conflict("Specialist context exceeds the model input budget");
              // Plan-layout whitespace is not another room's worth of output. Weight
              // it only for packing; preserve every original character and byte range.
              // The separate raw ceiling reserves room for an equally large continuation.
              const rawByteLimit = Math.min(256 * 1024, Math.floor((inputByteLimit ?? 48 * 1024) / 2));
              const batchBytes = (batch: any[]) => Buffer.byteLength(JSON.stringify(compactDocumentPackets(batch)));
              const batches = byteLimit === undefined ? batchSpecialistSources(specialistSources)
                : batchPreparedSourcePages(specialistSources, byteLimit,
                  boundedExtraction && assignment.exteriorNoisePacketVersion === 2 ? batch => Math.max(
                    documentPacketDensityBytes(batch),
                    batchBytes(batch) * byteLimit / rawByteLimit,
                  ) : batchBytes, boundedExtraction);
              // Checkpoints can only be reused for the same goal and extracted
              // evidence. A changed extraction or revision must be read again.
              const inputHash = createHash("sha256").update(JSON.stringify({
                goal: assignment.goal, batches, unreadableSources, sourceDocumentCoverage,
                ...(extractExteriorNoise ? { extractionContract: `exterior-noise-v${assignment.exteriorNoiseExtractionVersion}` } : {}),
                ...(assignment.visualFollowup ? { visualFollowup: assignment.visualFollowup } : {}),
              })).digest("hex");
              const progress = assignment.sourceProgress?.inputHash === inputHash ? assignment.sourceProgress : undefined;
              if (!assignment.visualFollowup && assignment.role === "sound_insulation" && d.calculateAcoustics && assignment.calculationEvidenceHash !== inputHash) await commit(d, run, token, async (tx, current) => {
                await tx.update(supervisorRuns).set({ assignments: (current.assignments as Assignment[]).map(a => a.runId === assignment.runId
                  ? { ...a, calculationReceipts: undefined, calculationEvidenceHash: inputHash } : a) }).where(eq(supervisorRuns.runId, id));
              });
              let accumulated = progress?.output ?? assignment.visualFollowup?.previousFindings;
              for (let index = progress?.completedBatches ?? 0; index < batches.length; index++) {
                if (stopped) throw new Error("Specialist work stopped after a sibling failure.");
                const primary = batches[index]!;
                const preceding = boundedExtraction ? batches[index - 1]?.at(-1) : undefined;
                // A room's heading/geometry may be on the preceding page while its
                // component table continues here. Include one exact adjacent slice,
                // clearly marked as context rather than new source coverage.
                const continuation = preceding && primary[0]?.versionId === preceding.versionId
                  && primary[0].sourcePage === preceding.sourcePage
                  && primary[0].documentBlock?.id === preceding.documentBlock?.id
                  && primary[0].textRange.startByte === preceding.textRange.endByte ? preceding : undefined;
                const batch = compactDocumentPackets(continuation ? [{ ...continuation, continuation: true }, ...primary] : primary);
                const batchIds = [...new Set(batch.map(source => source.versionId))];
                const allowedCitations = new Set([...batchIds, ...(accumulated?.citations ?? [])]);
                const workSources = [...new Map(batch.map(({ versionId, name, version }) => [versionId, { versionId, name, version }])).values()];
                let extractionIdentities: ReturnType<typeof exteriorNoiseIdentityDirectory> = [];
                const started = await commit(d, run, token, async (tx, current) => {
                  if (boundedExtraction) {
                    const frozen = (current.assignments as Assignment[]).find(a => a.runId === assignment.runId)?.sourceIdentityContext;
                    if (frozen?.inputHash === inputHash && frozen.batch === index + 1) extractionIdentities = frozen.identities;
                    else {
                      const history = current.history.filter((entry: any) => entry.phase === "specialist_batch"
                        && entry.revision === current.revision && entry.output?.exteriorNoiseExtraction);
                      const latestHash = new Map(history.map((entry: any) => [entry.runId, entry.inputHash]));
                      latestHash.set(assignment.runId, inputHash);
                      extractionIdentities = exteriorNoiseIdentityDirectory(history
                        .filter((entry: any) => entry.inputHash === latestHash.get(entry.runId))
                        .map((entry: any) => entry.output.exteriorNoiseExtraction));
                      // Freeze before dispatch: sibling progress must not change a
                      // replay's call identity or purchase the same packet again.
                      await tx.update(supervisorRuns).set({ assignments: (current.assignments as Assignment[]).map(a => a.runId === assignment.runId
                        ? { ...a, sourceIdentityContext: { inputHash, batch: index + 1, identities: extractionIdentities } } : a),
                      }).where(eq(supervisorRuns.runId, id));
                    }
                  }
                  await logWorkProgress(d, tx, run, {
                    runId: assignment.runId, stage: "reading_sources", sources: workSources,
                    batch: index + 1, batchCount: batches.length, summary: accumulated?.summary,
                  });
                });
                if (!started) throw conflict("Supervisor no longer active");
                const result = specialistSchema.parse(await call("specialist", assignment.goal, {
                  role: assignment.role,
                  ...(extractExteriorNoise ? { extractExteriorNoise: true, extractionVersion: assignment.exteriorNoiseExtractionVersion } : {}),
                  ...(boundedExtraction ? { extractionIdentities } : {}),
                  sourceVersionIds: batchIds,
                  ...(d.inspectSource ? { visualSourceVersionIds: assignment.visualFollowup
                    ? [...new Set(assignment.visualFollowup.requests.map(request => request.versionId))] : assignment.sourceVersionIds } : {}),
                  ...(assignment.visualFollowup ? { visualRequests: assignment.visualFollowup.requests } : {}),
                  ...(sourcePageScope ? { sourcePageScope } : {}),
                  visualReadCoverage: await currentVisualReadCoverage(assignment.runId),
                  sources: batch,
                  sourceDocumentCoverage,
                  unreadableSources,
                  previousFindings: accumulated ? schemas.specialist.parse(accumulated) : undefined,
                  documentTemplate: conceptId ? { id: conceptId, version: 1 } : undefined,
                  sourceCoverage: {
                    batch: index + 1,
                    batchCount: batches.length,
                    assignedVersionCount: assignment.sourceVersionIds.length,
                    readableVersionCount: readableSourceIds.size,
                    ...(sourcePageScope ? { completeDocumentCoverage: false,
                      pageScope: scopedCoverage ?? sourcePageScope.filter(entry => assignment.sourceVersionIds.includes(entry.versionId)) } : {}),
                  },
                }, assignment.runId, (raw, visualVersionIds = [], visualReceipts = []) => {
                  const parsed = specialistSchema.parse(raw);
                  if (extractExteriorNoise) {
                    const rawExtraction = z.object({ exteriorNoiseExtraction: exteriorNoiseExtractionSchema }).parse(raw).exteriorNoiseExtraction;
                    if (assignment.visualFollowup && (rawExtraction.inventory.length > 0 || rawExtraction.rooms.length > 0
                      || (rawExtraction.facts?.length ?? 0) > 0)) {
                      throw new z.ZodError([{
                        code: "custom", path: ["exteriorNoiseExtraction"],
                        message: "Visual-only follow-ups cannot add structured inventory, room or fact inputs.",
                      }]);
                    }
                    const extraction = validateExteriorNoiseExtraction(rawExtraction,
                      batch, visualReceipts);
                    if ("exteriorNoiseExtraction" in parsed) parsed.exteriorNoiseExtraction = extraction;
                    const inputSources = [...extraction.inventory.map(r => r.provenance),
                      ...(extraction.facts ?? []).map(f => f.provenance),
                      ...extraction.rooms.flatMap(room => acousticInputProvenance({ ...room, method: "exterior_noise_facade" }))];
                    parsed.citations = [...new Set([...parsed.citations,
                      ...inputSources.flatMap(p => p.kind === "source" ? [p.versionId] : []),
                      ...(extraction.visualCandidates ?? []).map(candidate => candidate.provenance.versionId),
                    ])];
                  }
                  for (const versionId of visualVersionIds) allowedCitations.add(versionId);
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
                      ? { ...a, sourceIdentityContext: undefined, sourceProgress: { inputHash, byteLimit, completedBatches: index + 1, output } } : a),
                    history: [...current.history, {
                      phase: assignment.visualFollowup ? "specialist_visual_followup" : "specialist_batch",
                      runId: assignment.runId, revision: current.revision, inputHash,
                      batch: index + 1, batchCount: batches.length,
                      sourceVersionIds: assignment.visualFollowup ? output.citations : batchIds, output,
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
                  (a) => (a.runId === assignment.runId ? { ...a, output, sourceProgress: undefined, visualFollowup: undefined } : a),
                );
                await tx
                  .update(supervisorRuns)
                  .set({
                    assignments,
                    history: [
                      ...current.history,
                      {
                        phase: assignment.visualFollowup ? "specialist_visual_completed" : "specialist",
                        runId: assignment.runId,
                        revision: current.revision,
                        inputHash,
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
      const outstandingVisualReads = (state.assignments as Assignment[]).flatMap(a =>
        (a.visualReads ?? []).filter(read => read.status === "budget_exhausted").map(read => ({ taskId: a.taskId, ...read.request })));
      if (!inputReassessmentOnly && outstandingVisualReads.length && state.revision < policy.maxRevisions) {
        // Consume one shared revision round, not a fresh per-assignment budget.
        // Freeze targets and findings so a worker restart resumes the same call.
        await commit(d, run, token, async (tx, current) => {
          const assignments = (current.assignments as Assignment[]).map(a => {
            const requests = (a.visualReads ?? []).filter(read => read.status === "budget_exhausted")
              .map(read => read.request).sort((a, b) => stepHash(a).localeCompare(stepHash(b))).slice(0, 4);
            return requests.length && a.output ? { ...a, output: undefined,
              visualFollowup: { requests, previousFindings: a.output } } : a;
          });
          for (const a of assignments.filter(a => a.visualFollowup)) {
            await tx.update(agentRuns).set({ status: "queued", updatedAt: new Date() }).where(eq(agentRuns.id, a.runId));
            await tx.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, a.taskId));
            await logWorkProgress(d, tx, run, { runId: a.runId, stage: "revision_requested", sources: [],
              summary: "Continue only deferred visual inspections; retain completed findings." });
          }
          await tx.update(supervisorRuns).set({ assignments, phase: "specialists", revision: current.revision + 1,
            history: [...current.history, { phase: "visual_followup_scheduled", revision: current.revision + 1,
              tasks: assignments.filter(a => a.visualFollowup).map(a => ({ taskId: a.taskId, requests: a.visualFollowup!.requests })) }],
          }).where(eq(supervisorRuns.runId, id));
          await log(d, tx, run, "visual_followup_scheduled");
        });
        return;
      }
      await commit(d, run, token, async (tx) => {
        await logWorkProgress(d, tx, run, {
          runId: id, stage: "reviewing_findings", sources: [],
          summary: (state.assignments as Assignment[]).map(a => a.output?.summary).filter(Boolean).join("\n\n"),
        });
      });
      const requireSoundInsulation = calculationOnly ? false : workflow
        ? workflow.mode === "report" && workflow.reportTemplate === "sound-insulation-review"
        : (state.assignments as Assignment[]).some(a => a.role === "sound_insulation");
      // Only application-assembled concepts are exempt from the per-response cap.
      const reviewSchema = schemas.review.extend({
        document: (conceptId || calculationOnly ? agentDocumentSchema : schemas.review.shape.document).nullish(),
      });
      const validateReview = (raw: unknown) => {
        const review = reviewSchema.parse(raw);
        if (workflow?.mode === "team" && review.document)
          throw conflict("Team returns findings in chat, not a report artifact");
        if (workflow?.mode === "report" && review.document?.template?.id !== workflow.reportTemplate)
          throw conflict("Report must use the selected template");
        review.document = prepareAgentDocument(review.document, conceptId ?? requireSoundInsulation, conceptId || calculationOnly ? null : limits.documentMaxCharacters);
        const allowedCitations = (state.assignments as Assignment[]).flatMap(a => a.output?.citations ?? []);
        if (review.citations.some(v => !allowedCitations.includes(v))) throw conflict("Review introduced unsupported citations");
        assertDocumentCitations(review.document, review.citations);
        if (review.decision === "revise" && state.revision < policy.maxRevisions)
          assertRevisionAssignments(review.revisions, state.assignments as Assignment[]);
        return review;
      };
      // Writer and checker must both fit before buying prose. Unknown models
      // retain the conservative historical packing instead of borrowing capacity.
      const reportModels = [policy.supervisor, ...(policy.writer ? [policy.writer] : [])];
      const reportBudgets = reportModels.map(model => agentModelInputByteBudget(run.provider, model.modelId, model.maxOutputTokens));
      const calculationReceipts = (state.assignments as Assignment[]).flatMap(a => a.calculationReceipts ?? []);
      const reviewVisualReadCoverage = await currentVisualReadCoverage();
      let calculationBlockers: string[] = [];
      if ((conceptId === "exterior-noise-concept" || calculationOnly) && (state.assignments as Assignment[]).some(a => a.exteriorNoiseExtractionVersion)) {
        const extractionPackets = (state.assignments as Assignment[]).flatMap(a => {
          const completed = state.history.findLast((entry: any) => entry.runId === a.runId && entry.phase === "specialist");
          const originalPackets = state.history.filter((entry: any) => entry.runId === a.runId && entry.phase === "specialist_batch"
            && entry.inputHash === completed?.inputHash && entry.revision === completed?.revision);
          const visualFollowupPackets = state.history.filter((entry: any) => entry.runId === a.runId
            && entry.phase === "specialist_visual_followup" && entry.revision >= (completed?.revision ?? 0)
            && entry.revision <= state.revision);
          return [...originalPackets, ...visualFollowupPackets]
            .flatMap((entry: any) => entry.output?.exteriorNoiseExtraction ? [entry.output.exteriorNoiseExtraction] : []);
        });
        const reconcile = (state.assignments as Assignment[]).some(a => a.exteriorNoiseExtractionVersion === 2);
        if (inputReassessmentOnly && (!reconcile || !extractionPackets.length))
          throw conflict("Saved version-2 acoustic extraction is unavailable for input reassessment");
        const contract = reconcile ? "exterior-noise-v2" : "exterior-noise-v1";
        const assembled = reconcile ? reconcileExteriorNoiseInputs(extractionPackets)
          : { ...assembleExteriorNoiseInputs(extractionPackets), sourceNotes: [] };
        let needsInput = assembled.blockers.length > 0 || !d.calculateAcoustics;
        calculationBlockers = [...assembled.blockers, ...assembled.sourceNotes];
        const assigned = new Set((state.assignments as Assignment[]).flatMap(a => a.sourceVersionIds));
        if (!extractionPackets.length) calculationBlockers.push("No structured extraction checkpoint is available; a calculation-ready source pass is required.");
        if (assembled.input) {
          const inputSourceIds = [...new Set(acousticInputProvenance(assembled.input).flatMap(p => p.kind === "source" ? [p.versionId] : []))];
          if (inputSourceIds.some(v => !assigned.has(v))) throw conflict("Extracted calculation source is outside the assignment scope");
          await sources(d, run.projectId, inputSourceIds);
        }
        if (!d.calculateAcoustics) calculationBlockers.push("The deterministic acoustic calculator is unavailable.");
        if (inputReassessmentOnly && !needsInput)
          throw conflict("Saved extraction no longer has an input blocker; reassessment will not start report authoring");
        const inputHash = stepHash({ contract, extractionPackets, calculatorAvailable: !!d.calculateAcoustics });
        const stepKey = `exterior-calculation:${inputHash}`;
        const saved = await commit(d, run, token, async tx => {
          const previous = await savedStep(d, id, "tool", stepKey, inputHash, tx);
          const output = previous?.output ?? {
            result: assembled.input && d.calculateAcoustics ? acousticCalculationResultSchema.parse(d.calculateAcoustics(assembled.input)) : null,
            blockers: calculationBlockers,
            ...(reconcile ? { inputReviewArtifactId: await createAcousticInputReview(d, tx, run, extractionPackets) } : {}),
          };
          const step = previous ?? await recordStep(d, tx, { ...run, generation: state.generation }, {
            kind: "tool", stepKey, inputHash, input: { contract, extractionPackets }, output, status: "completed",
          });
          const savedOutput = output as { result: unknown; blockers: string[] };
          calculationBlockers = savedOutput.blockers;
          if (savedOutput.result) {
            const result = acousticCalculationResultSchema.parse(savedOutput.result);
            calculationReceipts.push({ ...result, receiptId: step.id });
            if (reconcile && !result.batch?.complete) {
              needsInput = true;
              calculationBlockers = [...new Set([...calculationBlockers, ...(result.batch?.issues ?? [])])];
            }
          }
          if (!previous) await log(d, tx, run, "tool_executed", "exterior_noise_batch", "Application-owned room calculation; not reviewed");
        });
        if (!saved) throw conflict("Supervisor no longer active");
        // Publish independent results before asking the model about dependencies.
        // A failed planning call must not hide work that is already complete.
        if (reconcile && needsInput) {
          const batchReceipt = calculationReceipts.find(r => r.method === "exterior_noise_batch");
          const calculatedRoomIds = batchReceipt?.batch?.rooms.filter(r => r.status === "calculated").map(r => r.roomId) ?? [];
          let partialArtifactId: string | undefined;
          if (calculatedRoomIds.length && batchReceipt) {
            const published = await commit(d, run, token, async tx => {
              const key = `exterior-partial:${inputHash}`;
              const previous = await savedStep(d, id, "tool", key, inputHash, tx);
              if (previous) {
                partialArtifactId = (previous.output as { artifactId: string }).artifactId;
                return;
              }
              const dataset = acousticDatasetSchema.parse({ version: 1, receipt: batchReceipt,
                blockers: calculationBlockers, basedOn: null });
              const sourceVersionIds = [...new Set(acousticInputProvenance(batchReceipt.input)
                .flatMap(p => p.kind === "source" ? [p.versionId] : []))];
              const partial = await createArtifact(d, tx, { projectId: run.projectId, type: "draft",
                title: "Schallschutznachweis · Außenlärm · Teilstand",
                content: "# Schallschutznachweis · Außenlärm · Teilstand\n\nNur die ausgewiesenen Räume sind berechnet. Offene Eingaben bleiben blockiert. Keine fachliche Freigabe und kein vollständiger Nachweis.\n\n"
                  + renderAcousticCalculationReceipts([batchReceipt], "de"), sourceVersionIds,
              }, run.id, dataset);
              partialArtifactId = partial.artifact.id;
              if (run.conversationId) await tx.insert(messages).values({ tenantId: d.tenantId, conversationId: run.conversationId,
                authorId: d.actorId, actorKind: "agent", runId: run.id, parentMessageId: run.messageId,
                body: "Berechenbare Räume sind als Teilstand gespeichert. Offene Räume und fachliche Freigabe bleiben ausstehend.",
                openui: `root = ArtifactPdf(${JSON.stringify(partial.artifact.id)}, ${JSON.stringify(partial.revision.id)})`, sourceVersionIds });
              await recordStep(d, tx, { ...run, generation: state.generation }, { kind: "tool", stepKey: key, inputHash,
                input: { receiptId: batchReceipt.receiptId }, output: { artifactId: partialArtifactId }, status: "completed" });
            });
            if (!published) throw conflict("Supervisor no longer active");
          }
          const declared = new Set(assembled.input?.inventory.map(r => r.roomId));
          const progressSchema = schemas.acousticProgress.superRefine((plan, ctx) => {
            plan.questions.forEach((question, i) => question.roomIds.forEach((roomId, j) => {
              if (!declared.has(roomId)) ctx.addIssue({ code: "custom", path: ["questions", i, "roomIds", j], message: "Use declared room IDs only." });
            }));
          });
          const visualCandidates = [...(assembled.visualCandidates ?? [])]
            .sort((a, b) => a.candidateKey.localeCompare(b.candidateKey));
          const visualCandidateObservations = {
            status: "visual_candidates_separate_from_inventory",
            total: visualCandidates.length,
            included: Math.min(60, visualCandidates.length),
            omitted: Math.max(0, visualCandidates.length - 60),
            printedAreaObservationCount: visualCandidates.filter(candidate => !!candidate.floorAreaObservation).length,
            note: "This sidecar preserves receipt-backed observations even when the text-backed room inventory is empty. Candidates remain separate from declared rooms, facts and calculation inputs; per-candidate review decisions are shown without changing that boundary. Printed floor areas remain typed unreviewed observations and must not be promoted, inferred or counted as rooms.",
            candidates: visualCandidates.slice(0, 60).map(candidate => {
              const reviewed = candidate as typeof candidate & { floorAreaObservationKey?: string | null; floorAreaDecision?: "approved" | "rejected" | null };
              return {
                candidateKey: candidate.candidateKey,
                apartmentLabel: candidate.apartmentLabel,
                roomLabel: candidate.roomLabel,
                mapping: candidate.mapping,
                reviewStatus: candidate.reviewStatus,
                mappingDecision: candidate.mappingDecision,
                confirmedRoomId: candidate.confirmedRoomId,
                ...(candidate.floorAreaObservation ? { floorAreaObservation: {
                  ...candidate.floorAreaObservation,
                  observationKey: reviewed.floorAreaObservationKey,
                  reviewDecision: reviewed.floorAreaDecision,
                } } : {}),
                provenance: { versionId: candidate.provenance.versionId, page: candidate.provenance.page,
                  crop: candidate.provenance.crop, receiptId: candidate.provenance.receiptId,
                  imageHash: candidate.provenance.imageHash },
              };
            }),
          };
          let progressPlan: z.infer<typeof progressSchema> | undefined;
          if ((state.assignments as Assignment[]).some(a => !!a.exteriorNoisePacketVersion)) {
            if (inputReassessmentOnly)
              await d.db.transaction((tx: any) => assertPinnedInputReview(d, run, state.review, tx));
            progressPlan = progressSchema.parse(await call("review", goal, {
              documentTask: "acoustic_progress", calculatedRoomIds, partialArtifactId,
              visualCandidateObservations,
              visualReadCoverage: await currentVisualReadCoverage(),
              rooms: (assembled.input?.inventory ?? []).map(room => ({ roomId: room.roomId,
                outcome: batchReceipt?.batch?.rooms.find(r => r.roomId === room.roomId)?.status ?? "missing_input",
                calculationLimitations: batchReceipt?.batch?.rooms.find(r => r.roomId === room.roomId)?.result?.limitations ?? [],
                unresolvedFields: "fields" in assembled ? assembled.fields.filter(f => f.roomId === room.roomId && f.value === null)
                  .map(f => ({ target: f.target, id: f.id, field: f.field, status: f.status })) : [],
              })),
              findings: (state.assignments as Assignment[]).map(a => ({ role: a.role, summary: a.output?.summary })),
              sourceNotes: assembled.sourceNotes,
            }, id, raw => progressSchema.parse(raw)));
          }
          if (inputReassessmentOnly && !progressPlan)
            throw conflict("Saved acoustic extraction cannot produce an input reassessment plan");
          await commit(d, run, token, async tx => {
            if (inputReassessmentOnly) await assertPinnedInputReview(d, run, state.review, tx);
            const summary = progressPlan?.summary ?? (run.conversationId
              ? "Berechnungseingaben benötigen Klärung im Gespräch. Kein weiterer KI-Aufruf gestartet."
              : "Berechnungseingaben benötigen Klärung. Kein weiterer KI-Aufruf gestartet.");
            if (progressPlan && run.conversationId) await tx.insert(messages).values({ tenantId: d.tenantId,
              conversationId: run.conversationId, authorId: d.actorId, actorKind: "agent", runId: run.id, parentMessageId: run.messageId,
              body: [progressPlan.summary, progressPlan.independentWork,
                ...progressPlan.questions.map((question, i) => `${i + 1}. ${question.question}`)].join("\n\n"), sourceVersionIds: [],
            });
            await tx.update(agentRuns).set({ status: "needs_review", outputSummary: summary,
              partialOutput: summary, updatedAt: new Date() }).where(eq(agentRuns.id, id));
            await tx.update(supervisorRuns).set({ phase: "done", review: { inputReviewRequired: true, calculationBlockers,
              partialArtifactId, ...(progressPlan ? { progressPlan } : {}),
              ...(inputReassessmentOnly ? { inputReassessmentOnly: false,
                inputReviewArtifactId: state.review.inputReviewArtifactId,
                expectedInputReviewRevisionId: state.review.expectedInputReviewRevisionId } : {}) } })
              .where(eq(supervisorRuns.runId, id));
            await log(d, tx, run, "acoustic_inputs_required");
          });
          return;
        }
      }
      const review = validateReview(
        calculationOnly ? {
          document: { title: "Schallschutznachweis · Außenlärm · Rechenblatt",
            content: ["# Schallschutznachweis · Außenlärm\n\nRechenblatt zur fachlichen Prüfung; keine Freigabe. Unterstützt werden die ausgewiesenen Außenlärm-Rechenfälle, kein allgemeiner Innenlärm- oder Flankennachweis.",
              renderAcousticCalculationReceipts(calculationReceipts, "de"),
              ...(calculationBlockers.length ? ["## Offene Berechnungseingaben\n\n" + calculationBlockers
                .map(reason => `- ${reason.replace(/[\\`*_{}<>#!|\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}`).join("\n")] : []),
            ].filter(Boolean).join("\n\n") },
          citations: [...new Set(calculationReceipts.flatMap(r => acousticInputProvenance(r.input).flatMap(p => p.kind === "source" ? [p.versionId] : [])))],
          decision: "accept", revisions: [],
          summary: "Rechenblatt mit Raumergebnissen und offenen Eingaben erstellt. Fachliche Prüfung und Freigabe stehen aus.",
          rationale: "Deterministisch aus gespeicherten Eingaben berechnet; keine Berichtserstellung oder redaktionelle Überarbeitung.",
        } : conceptId ? await authorAcousticConcept({
          d, projectId: run.projectId, id: conceptId, goal, limits,
          maxOutputTokens: Math.min(...reportModels.map(model => model.maxOutputTokens)),
          maxParallel: policy.maxParallel,
          inputByteBudget: reportBudgets.every(budget => budget !== undefined) ? Math.min(...reportBudgets as number[]) : undefined,
          ...(policy.writer ? { modelPolicy: { writer: policy.writer, supervisor: policy.supervisor } } : {}),
          contextOverhead: {
            documentReview,
            profiles: state.profileSnapshot?.length ? state.profileSnapshot : defaultProfiles().map(profile => ({ ...profile, knowledge: [] })),
            budgets: { maxTasks: policy.maxTasks, maxRevisions: policy.maxRevisions },
            visualReadCoverage: reviewVisualReadCoverage,
          },
          // Keep each assignment's latest full evidence pass plus its visual
          // supplements, including siblings unchanged by a later revision.
          findings: (state.assignments as Assignment[]).flatMap(a => {
            const entries = state.history.filter((entry: any) => entry.runId === a.runId);
            const completed = entries.findLast((entry: any) => entry.phase === "specialist");
            return entries.filter((entry: any) => entry.phase === "specialist_batch"
              ? entry.revision === (completed?.revision ?? state.revision) && (!completed?.inputHash || entry.inputHash === completed.inputHash)
              : entry.phase === "specialist_visual_followup" && entry.revision > (completed?.revision ?? -1))
              .map((entry: any) => ({ sourceVersionIds: entry.sourceVersionIds, output: { ...entry.output, exteriorNoiseExtraction: undefined } }));
          }),
          calculationReceipts,
          calculationBlockers,
          companyKnowledge: (state.assignments as Assignment[]).flatMap(a => a.companyKnowledge ?? []),
          sourceVersionIds: [...new Set<string>((state.assignments as Assignment[]).flatMap(a => a.output?.citations ?? []))],
          sourceDirectory: await d.sourceReferences(run.projectId,
            [...new Set<string>((state.assignments as Assignment[]).flatMap(a => a.output?.citations ?? []))]),
          visualReads: reviewVisualReadCoverage.entries.map(({ versionId, page, crop, status, receiptId }) => ({
            request: { versionId, page, crop }, status, receiptId,
          })),
          draft: state.review?.documentDraft,
          previousReview: state.review?.documentDraft?.previousReview ?? state.review,
          assertActive,
          // Coverage gaps are application-owned notices, not citation evidence
          // for every section (whose source scope can be much narrower).
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
          visualReadCoverage: reviewVisualReadCoverage,
          ...(outstandingVisualReads.length ? { outstandingVisualReads } : {}),
          companyKnowledge: (state.assignments as Assignment[]).flatMap(a => a.companyKnowledge ?? []),
          revision: state.revision,
          previousReview: state.review,
          documentTemplate: requireSoundInsulation ? { id: "sound-insulation-review", version: 1 } : undefined,
        }, id, validateReview),
      );
      const batchReceipt = calculationReceipts.find(r => r.method === "exterior_noise_batch");
      const acousticDataset = batchReceipt ? acousticDatasetSchema.parse({ version: 1,
        receipt: batchReceipt, blockers: calculationBlockers, basedOn: null }) : undefined;
      // Retained across independent review, but never sent as duplicate model context.
      if (acousticDataset) Object.assign(review, { acousticDataset });
      if (outstandingVisualReads.length) {
        // A model's "accept" cannot erase application-observed missing reads.
        review.decision = "revise";
        review.revisions = [];
        const notice = `${outstandingVisualReads.length} requested visual inspection(s) remain uninspected: the automatic revision budget is exhausted. This does not establish that the sources are unreadable. Human review or a focused follow-up is required.`;
        review.summary = `${notice}\n\n${review.summary}`.slice(0, limits.summaryMaxCharacters);
        review.rationale += `\n\n${notice}\n${JSON.stringify(outstandingVisualReads)}`;
        if (conceptId && review.document?.template) {
          const coverage = review.document.template.language === "de"
            ? `${outstandingVisualReads.length} angeforderte Sichtprüfungen sind noch offen: Das automatische Überarbeitungskontingent ist ausgeschöpft. Dies belegt keine Unlesbarkeit der Quellen. Fachliche Prüfung oder gezielte Nachprüfung erforderlich; die genauen Quellen, Seiten und Ausschnitte stehen in den Laufdetails.`
            : `${notice} Exact sources, pages and crops are retained in the run details.`;
          review.document = prepareAgentDocument({ ...review.document, template: {
            ...review.document.template, openIssues: `${review.document.template.openIssues}\n\n${coverage}`,
          } }, conceptId, null);
        }
      }
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
              ? { ...a, goal: revision.goal, output: undefined, sourceProgress: undefined, calculationReceipts: undefined, fireProtection: undefined, companyKnowledge: undefined, visualReads: undefined, visualFollowup: undefined }
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
          const resultArtifact = workflow?.mode === "team" ? null : await createArtifact(
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
            acousticDataset,
          );
          const resultReference = resultArtifact ? {
            kind: "supervisor_result",
            artifactId: resultArtifact.artifact.id,
            revisionId: resultArtifact.revision.id,
            generation: state.generation,
          } : undefined;
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
              review: { ...review, outstandingVisualReads, result: resultReference },
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
              openui: resultReference ? `root = ArtifactPdf(${JSON.stringify(resultReference.artifactId)}, ${JSON.stringify(resultReference.revisionId)})` : null,
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
          ? await resolveCompleteRunSource(d, run.projectId, { versionId, preferDocumentModel: calculationOnly || !!conceptId }, assertActive)
          : await resolveRunSource(d, run.projectId, { versionId, pageStart: 1 }, assertActive) };
      }));
      const readableSourceIds = new Set(resolvedExcerpts.flatMap(({ versionId, resolution }: any) =>
        resolution?.status === "resolved" &&
        resolution?.source?.versionId === versionId &&
        resolution?.content?.status === "available" &&
        (sourcePageScope
          ? !!resolution.content.documentModel && (scopedPages.get(versionId) ?? new Set()).size > 0
            && [...(scopedPages.get(versionId) ?? [])].every(page => resolution.content.documentModel.pages.some((entry: any) => entry.page === page))
          : typeof resolution.content.text === "string" && resolution.content.text.trim().length > 0)
          ? [versionId]
          : [],
      ));
      const unreadableSources = resolvedExcerpts
        .filter(({ versionId, resolution }: any) => !readableSourceIds.has(versionId)
          || (!sourcePageScope && readCompleteSources && resolution?.content?.truncated))
        .map(({ versionId, resolution }: any) => ({ versionId, name: resolution?.source?.name ?? null }));
      const coverageIncomplete = (sourceVersionIds.length === 0 && workflow?.mode !== "team") || unreadableSources.length > 0;
      const firstPassReview = state.review;
      const readableExcerpts = resolvedExcerpts.filter(({ versionId }) => readableSourceIds.has(versionId)).flatMap(({ versionId, resolution }: any) => {
        if (!resolution.content.documentModel) {
          if (sourcePageScope) throw conflict("Page-scoped independent review requires original-page document models");
          return [{ versionId, resolution }];
        }
        // Independent review also receives only local block metadata, never a
        // whole-document block list attached to every transport fragment.
        const requestedPages = scopedPages.get(versionId);
        const pageOf = (packet: any) => packet.sourcePage
          ?? (packet.evidenceKind === "source_fact" && packet.sourceFact?.fact?.evidence?.kind === "text"
            ? packet.sourceFact.fact.evidence.page : undefined);
        const packets = compactDocumentPackets(sourceEvidencePackets(versionId, resolution))
          .filter(packet => !requestedPages || requestedPages.has(pageOf(packet)));
        return packets.map((packet, index) => {
          const { documentBlocks, ...metadata } = packet;
          // Review has no structured input extraction. A single encoded literal
          // tuple view stays nonempty for its existing transport-fragment fallback.
          // Never copy both the full block array and its text representation.
          const content = documentBlocks ? { ...metadata, text: JSON.stringify(documentBlocks),
            textEncoding: "document-block-tuples-json",
            tupleFields: ["originalStartByte", "line", "column", "literalText", "optionalFragmentRange"],
            evidencePolicy: "Decoded literalText is source evidence; tuple syntax, offsets and IDs are metadata. This is a review presentation, not a new source quotation." } : metadata;
          return { versionId, resolution: { ...resolution, content: { ...content, status: "available",
            ...(index === 0 ? { documentCoverage: { ...resolution.content.documentModel.coverage,
              ...(requestedPages ? { completeDocumentCoverage: false, requestedPages: [...requestedPages].sort((a, b) => a - b),
                note: "Only explicitly requested original pages were evaluated; omitted pages were not evaluated and their absence is not established." } : {}) },
              ...(sourcePageScope ? { layerMetadata: "Omitted because PDF layer names and paths have no verified association with the scoped original pages." }
                : { documentLayers: compactDocumentLayers(resolution.content.documentModel.layers) }) } : {}) } } };
        });
      });
      const sliceResults: { sourceVersionIds: string[]; output: z.infer<typeof independentReview> }[] = [];
      // Older verdicts used the misleading assembled-length and slice-scope
      // contract. Preserve their history, but never reuse them as current checks.
      const contextOverhead = {
        goal, documentReview,
        ...(sourcePageScope ? { sourcePageScope, sourceCoverage: { completeDocumentCoverage: false } } : {}),
        componentCatalog: await d.componentContext?.(run.goal),
        profiles: state.profileSnapshot?.length ? state.profileSnapshot : defaultProfiles().map(profile => ({ ...profile, knowledge: [] })),
        budgets: { maxTasks: policy.maxTasks, maxRevisions: policy.maxRevisions },
      };
      const modelBudget = agentModelInputByteBudget(run.provider, policy.supervisor.modelId, policy.supervisor.maxOutputTokens);
      const plan = prepareIndependentReview({ review: firstPassReview ?? {}, assignments,
        sources: readableExcerpts as any,
        originalGoal: run.goal, revision: state.revision, assignedVersionCount: sourceVersionIds.length,
        readableSourceIds: [...readableSourceIds], unreadableSources, contextOverhead,
        ...(sourcePageScope ? { sourcePageScope } : {}),
        inputByteBudget: modelBudget === undefined ? undefined : modelBudget - AGENT_MESSAGING_CONTEXT_BYTES,
      });
      const inputHash = checkpointHash({ version: 3, goal, assignments, firstPassReview, resolvedExcerpts,
        modelPolicy: state.modelPolicy, profiles: state.profileSnapshot, contextOverhead });
      const needsConsistency = plan.batches.some(batch => batch.reviewTask === "evidence");
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
            return revision ? { ...assignment, goal: revision.goal, output: undefined, sourceProgress: undefined, calculationReceipts: undefined, fireProtection: undefined, companyKnowledge: undefined, visualReads: undefined, visualFollowup: undefined } : assignment;
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
          const resultArtifact = workflow?.mode === "team" ? null : await createArtifact({
            ...d,
            audit: (tx, action, type, entityId, metadata) => d.auditRun(tx, action, type, entityId, id, run.correlationId, metadata),
          }, tx, {
            projectId: run.projectId,
            title: firstPassReview?.document?.title ?? run.goal.slice(0, 200),
            type: "draft",
            content: `${firstPassReview?.document?.content ?? firstPassReview?.summary ?? summary}\n\nReview rationale\n\n${rationale}${unresolved ? "\n\nRevision limit reached. Unresolved independent-review issues require human review." : ""}`,
            payload: { kind: "summary", data: [{ summary, rationale }], template: firstPassReview?.document?.template },
            sourceVersionIds: reviewCitations,
          }, id, firstPassReview?.acousticDataset);
          const resultReference = resultArtifact ? {
            kind: "supervisor_result",
            artifactId: resultArtifact.artifact.id,
            revisionId: resultArtifact.revision.id,
            generation: state.generation,
          } : undefined;
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
            openui: resultReference ? `root = ArtifactPdf(${JSON.stringify(resultReference.artifactId)}, ${JSON.stringify(resultReference.revisionId)})` : null,
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
      await interruptProviderAttempts(d, tx, id, "supervisor_stopped");
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
