import type { RecordData } from "../../api";
import type { useT } from "../../i18n";
import {
  agentWorkProgressSchema,
  type AgentWorkProgress,
} from "@richtfest/shared";

export function agentName(run: RecordData, t: ReturnType<typeof useT>) {
  if (run.specialistRole === "source_reviewer")
    return t("agentThreadSourceName");
  if (run.specialistRole === "requirements_reviewer")
    return t("agentThreadRequirementsName");
  if (run.specialistRole === "independent_reviewer")
    return t("supervisorIndependentReviewer");
  if (run.specialistRole === "sound_insulation")
    return t("supervisorSoundInsulation");
  if (run.specialistRole === "construction_law")
    return t("supervisorConstructionLaw");
  if (run.specialistRole === "cost_optimizer")
    return t("supervisorCostOptimizer");
  if (run.isSupervisor) return t("supervisorRole");
  if (!run.parentRunId) return t("agentThreadCoordinator");
  return (
    run.goal?.split(/[.!?\n]/)[0]?.slice(0, 72) || t("agentThreadSpecialist")
  );
}

export function currentRunTasks(
  run: RecordData,
  children: RecordData[],
  t: ReturnType<typeof useT>,
  events: RecordData[] = [],
) {
  const progress = new Map<string, AgentWorkProgress>();
  for (const event of events) {
    if (["resumed", "steered"].includes(event.eventType)) progress.clear();
    const work = workProgressMetadata(event);
    if (work) progress.set(work.runId, work);
  }
  const active = (run.isSupervisor ? children : [])
    .filter((child) => ["running", "queued"].includes(child.status))
    .sort(
      (a, b) => Number(a.status === "queued") - Number(b.status === "queued"),
    );
  return (run.status !== "queued" && active.length ? active : [run]).map(
    (agent) => {
      const work =
        agent.status === "queued" ? undefined : progress.get(agent.id);
      return {
        id: agent.id,
        name: `${agentName(agent, t)}${agent.status === "queued" ? ` · ${t("run_queued")}` : ""}`,
        text: work
          ? workProgressDescription(work, t)
          : agent.status === "queued"
            ? `${t("agentRunWaitingForWorker")} · ${agent.goal}`
            : agent.isSupervisor
              ? t(
                  children.length
                    ? "workspaceTaskReviewing"
                    : "workspaceTaskPlanning",
                )
              : agent.goal,
        summary: work?.summary,
        hasProgress: Boolean(work),
      };
    },
  );
}

export function workProgressMetadata(
  event: RecordData,
): AgentWorkProgress | undefined {
  if (event.eventType !== "work_progress") return;
  try {
    const parsed = agentWorkProgressSchema.safeParse(
      typeof event.paramsSummary === "string"
        ? JSON.parse(event.paramsSummary)
        : event.paramsSummary,
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}

export function workProgressDescription(
  work: AgentWorkProgress,
  t: ReturnType<typeof useT>,
) {
  const labels = {
    resolving_sources: "workspaceWorkResolving",
    reading_sources: work.sources.length
      ? "workspaceWorkReading"
      : "workspaceWorkNoSources",
    source_findings: "workspaceWorkFindingsSaved",
    reviewing_findings: "workspaceWorkReviewing",
    independent_review: "workspaceWorkIndependent",
    revision_requested: "workspaceWorkRevision",
  } as const;
  return [
    t(labels[work.stage]),
    work.batch && work.batchCount
      ? `${t("workspaceWorkBatch")} ${work.batch}/${work.batchCount}`
      : null,
    work.sources
      .map(
        (source) =>
          `${source.name || t("source")}${source.version ? ` (${t("version")} ${source.version})` : ""}`,
      )
      .join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
}

const phases = {
  plan: "workspaceRunPhasePlan",
  specialist: "workspaceRunPhaseSpecialist",
  review: "workspaceRunPhaseReview",
  independent_review: "workspaceRunPhaseIndependentReview",
  direct: "workspaceRunPhaseProvider",
  provider: "workspaceRunPhaseProvider",
  tool_followup: "workspaceRunPhaseToolExecution",
} as const;

/** Read only structural metadata. Never treat serialized diagnostics as a call id. */
export function providerActivityMetadata(event: RecordData) {
  const raw = event.paramsSummary;
  let value: RecordData = {};
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { callId: /^[0-9a-f-]{36}$/i.test(raw) ? raw : undefined };
    }
  } else if (raw && typeof raw === "object") value = raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    callId: typeof value.callId === "string" ? value.callId : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
    attempt:
      Number.isInteger(value.attempt) &&
      value.attempt > 0 &&
      value.attempt <= 100
        ? (value.attempt as number)
        : undefined,
    diagnostics:
      value.diagnostics && typeof value.diagnostics === "object"
        ? (value.diagnostics as RecordData)
        : undefined,
    providerStatus: Number.isInteger(value.providerStatus)
      ? (value.providerStatus as number)
      : undefined,
    delayMs:
      typeof value.delayMs === "number" &&
      Number.isFinite(value.delayMs) &&
      value.delayMs >= 0 &&
      value.delayMs <= 600000
        ? value.delayMs
        : undefined,
  };
}

export function providerFailureExplanation(
  diagnostics: RecordData | undefined,
  t: ReturnType<typeof useT>,
) {
  if (
    ["insufficient_quota", "billing_hard_limit_reached"].includes(
      diagnostics?.providerCode,
    )
  )
    return t("workspaceFailureQuota");
  if (
    ["rate_limit_exceeded", "rate_limit_error"].includes(
      diagnostics?.providerCode,
    )
  )
    return t("workspaceFailureThrottled");
  // A length finish reason is authoritative even if a partial object validated.
  if (diagnostics?.finishReason === "length")
    return t("workspaceFailureTruncated");
  if (
    Array.isArray(diagnostics?.issues) &&
    diagnostics.issues.some(
      (issue: RecordData) =>
        issue.code === "custom" &&
        Array.isArray(issue.path) &&
        issue.path.length === 1 &&
        issue.path[0] === "complete",
    )
  )
    return t("workspaceFailureIncomplete");
  const content =
    Array.isArray(diagnostics?.issues) &&
    diagnostics.issues.find((issue: RecordData) => {
      if (issue?.code !== "too_big" || !Array.isArray(issue.path)) return false;
      const path = issue.path;
      return (
        (path.length === 1 && path[0] === "content") ||
        (path.length === 2 &&
          path[0] === "document" &&
          path[1] === "content") ||
        (path.length === 3 &&
          path[0] === "document" &&
          path[1] === "template" &&
          typeof path[2] === "string")
      );
    });
  if (content) {
    const maximum = content.maximum;
    const limit =
      typeof maximum === "number" &&
      Number.isSafeInteger(maximum) &&
      maximum > 0
        ? ` (${maximum} ${t("workspaceFailureCharacters")})`
        : "";
    return `${t("workspaceFailureContentLimit")}${limit}. ${t("workspaceFailureContentAction")}`;
  }
  if (diagnostics?.errorId === "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED") {
    const summary =
      Array.isArray(diagnostics.issues) &&
      diagnostics.issues.find(
        (issue: RecordData) =>
          issue?.code === "too_big" &&
          Array.isArray(issue.path) &&
          issue.path.length === 1 &&
          issue.path[0] === "summary",
      );
    if (summary) {
      const maximum = summary.maximum;
      const limit =
        typeof maximum === "number" &&
        Number.isInteger(maximum) &&
        maximum > 0 &&
        maximum <= 100000
          ? ` (${maximum} ${t("workspaceFailureCharacters")})`
          : "";
      return `${t("workspaceFailureSummaryLimit")}${limit}. ${t("workspaceFailureSummaryAction")}`;
    }
    return t("workspaceFailureSchema");
  }
  return undefined;
}

export function providerActivityExplanation(
  event: RecordData,
  t: ReturnType<typeof useT>,
) {
  const metadata = providerActivityMetadata(event);
  let explanation =
    providerFailureExplanation(metadata.diagnostics, t) ??
    (metadata.providerStatus === 429 ||
    /;\s*HTTP 429(?:;|$)/.test(event.resultSummary ?? "")
      ? t("workspaceFailureRateLimit")
      : undefined);
  if (!explanation) return undefined;
  if (metadata.delayMs !== undefined)
    explanation += ` ${t("workspaceRetryDelay")}: ${Math.ceil(metadata.delayMs / 1000)} ${t("workspaceRetrySeconds")}.`;
  const phase =
    typeof event.resultSummary === "string"
      ? event.resultSummary.split(";")[0]
      : "";
  const phaseKey = phases[phase as keyof typeof phases];
  const context = [
    phaseKey ? t(phaseKey) : undefined,
    metadata.attempt
      ? `${t("runExecutionAttempt")} ${metadata.attempt}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return context ? `${context}: ${explanation}` : explanation;
}

/** Own-run failures only: supervisor event rows can also contain sibling calls. */
export function terminalProviderFailure(
  run: RecordData,
  events: RecordData[],
  attempts: RecordData[],
  t: ReturnType<typeof useT>,
) {
  if (run.status !== "failed") return undefined;
  // A persisted timeout is authoritative over diagnostics from earlier attempts.
  // In particular, a prior truncation must not suggest increasing output tokens.
  const reason = String(run.error || run.failureReason || "");
  if (/(?:^|;)\s*category=timeout(?:;|$)/.test(reason)) return undefined;
  const phase = /(?:^|;)\s*phase=([a-z_]+)/.exec(reason)?.[1];
  const candidates = events.filter((event) => {
    if (event.eventType !== "provider_call_failed") return false;
    const metadata = providerActivityMetadata(event);
    const attempt = attempts.find(
      (item) =>
        metadata.callId !== undefined &&
        metadata.attempt !== undefined &&
        item.operationId === metadata.callId &&
        item.attemptNumber === metadata.attempt,
    );
    const owner = metadata.runId ?? attempt?.runId;
    return (
      owner === run.id &&
      (!phase ||
        (typeof event.resultSummary === "string" &&
          event.resultSummary.split(";")[0] === phase))
    );
  });
  const last = candidates.at(-1);
  return last ? providerActivityExplanation(last, t) : undefined;
}

const activityLabels = {
  work_progress: "workspaceActivityStep",
  started: "workspaceActivityRunStarted",
  supervisor_started: "workspaceActivityStarted",
  provider_call_started: "workspaceActivityProviderCallStarted",
  provider_call_completed: "workspaceActivityProviderCallCompleted",
  provider_call_retrying: "workspaceActivityProviderCallRetrying",
  provider_call_failed: "workspaceActivityProviderCallFailed",
  resumed: "workspaceActivityResumed",
  supervisor_planned: "workspaceActivityPlanned",
  specialist_completed: "workspaceActivitySpecialistCompleted",
  supervisor_revision_requested: "workspaceActivityRevision",
  supervisor_review_completed: "workspaceActivityReviewed",
  independent_review_started: "workspaceActivityIndependentReviewStarted",
  independent_review_checkpointed:
    "workspaceActivityIndependentReviewCheckpointed",
  independent_review_completed: "workspaceActivityIndependentReviewCompleted",
  independent_review_revision_requested:
    "workspaceActivityIndependentReviewRevision",
  tool_executed: "workspaceActivityTool",
  completed: "workspaceActivityCompleted",
  failed: "workspaceActivityFailed",
  supervisor_failed: "workspaceActivityFailed",
  cancelled: "workspaceActivityCancelled",
  interrupted: "workspaceActivityInterrupted",
  steered: "workspaceActivitySteered",
  unconfigured: "workspaceActivityUnconfigured",
  validated_tool_unavailable: "workspaceActivityCalculationUnavailable",
} as const;

const toolLabels = {
  resolve_project_source: "workspaceActivitySource",
  delegate_source_review: "workspaceActivityDelegated",
  create_draft: "workspaceActivityDraft",
  ask_missing_input: "workspaceActivityQuestion",
  validated_calculation: "workspaceActivityCalculationUnavailable",
} as const;

type ActivityTranslationKey =
  | (typeof activityLabels)[keyof typeof activityLabels]
  | (typeof toolLabels)[keyof typeof toolLabels]
  | "workspaceActivityTimedOut"
  | "workspaceFailureRateLimit";

export function runActivityLabel(
  event: RecordData,
): ActivityTranslationKey | undefined {
  if (
    ["failed", "supervisor_failed"].includes(event.eventType) &&
    typeof event.paramsSummary === "string" &&
    /(?:^|;)\s*category=timeout(?:;|$)/.test(event.paramsSummary)
  )
    return "workspaceActivityTimedOut";
  if (
    ["failed", "supervisor_failed"].includes(event.eventType) &&
    typeof event.paramsSummary === "string" &&
    /(?:^|;)\s*provider_http_status=429(?:;|$)/.test(event.paramsSummary)
  )
    return "workspaceFailureRateLimit";
  if (event.eventType === "tool_executed")
    return (
      toolLabels[event.toolName as keyof typeof toolLabels] ??
      activityLabels.tool_executed
    );
  return activityLabels[event.eventType as keyof typeof activityLabels];
}
