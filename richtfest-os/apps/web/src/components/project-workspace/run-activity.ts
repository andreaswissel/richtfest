import type { RecordData } from "../../api";
import type { useT } from "../../i18n";

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
  };
}

export function providerFailureExplanation(
  diagnostics: RecordData | undefined,
  t: ReturnType<typeof useT>,
) {
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
        maximum <= 10000
          ? ` (${maximum} ${t("workspaceFailureCharacters")})`
          : "";
      return `${t("workspaceFailureSummaryLimit")}${limit}. ${t("workspaceFailureSummaryAction")}`;
    }
    return t("workspaceFailureSchema");
  }
  if (
    diagnostics?.errorId === "STRUCTURED_OUTPUT_TRUNCATED" &&
    diagnostics.finishReason === "length"
  )
    return t("workspaceFailureTruncated");
  return undefined;
}

export function providerActivityExplanation(
  event: RecordData,
  t: ReturnType<typeof useT>,
) {
  const metadata = providerActivityMetadata(event);
  const explanation = providerFailureExplanation(metadata.diagnostics, t);
  if (!explanation) return undefined;
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
  | "workspaceActivityTimedOut";

export function runActivityLabel(
  event: RecordData,
): ActivityTranslationKey | undefined {
  if (
    ["failed", "supervisor_failed"].includes(event.eventType) &&
    typeof event.paramsSummary === "string" &&
    /(?:^|;)\s*category=timeout(?:;|$)/.test(event.paramsSummary)
  )
    return "workspaceActivityTimedOut";
  if (event.eventType === "tool_executed")
    return (
      toolLabels[event.toolName as keyof typeof toolLabels] ??
      activityLabels.tool_executed
    );
  return activityLabels[event.eventType as keyof typeof activityLabels];
}
