import type { RecordData } from "../../api";
import type { useT } from "../../i18n";
import {
  agentBudgetDecisionSchema,
  agentWorkProgressSchema,
  type AgentWorkProgress,
} from "@richtfest/shared";

/** Bound serialized metadata before parsing, and validate only the shared contract. */
export function budgetDecision(value: unknown) {
  const parsed = agentBudgetDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function budgetActivityMetadata(event: RecordData) {
  if (
    !["budget_waiting", "budget_reserved", "budget_stopped"].includes(
      event.eventType,
    )
  )
    return;
  let value = event.paramsSummary;
  if (typeof value === "string") {
    if (value.length > 16384) return;
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const budget = budgetDecision(value.budget);
  if (budget && `budget_${budget.state}` !== event.eventType) return;
  if (
    !budget ||
    typeof value.runId !== "string" ||
    value.runId.length > 128 ||
    typeof value.callId !== "string" ||
    !value.callId ||
    value.callId.length > 128 ||
    !Number.isInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > 100
  )
    return;
  return {
    runId: value.runId as string,
    callId: value.callId as string,
    attempt: value.attempt as number,
    budget,
  };
}

export function budgetDescription(
  budget: NonNullable<ReturnType<typeof budgetDecision>>,
  t: ReturnType<typeof useT>,
) {
  const reasons = {
    pending_reservations: "budgetPendingReservations",
    spend_allowance: "budgetSpendAllowance",
    retry_allowance: "budgetRetryAllowance",
    unknown_usage: "budgetUnknownUsage",
    unpriced_call: "budgetUnpricedCall",
    wait_expired: "budgetWaitExpired",
    nested_reservation: "budgetNestedReservation",
  } as const;
  const money = (value: number) => `$${value} USD`;
  return [
    t(
      budget.state === "waiting"
        ? "budgetWaiting"
        : budget.state === "stopped"
          ? "budgetStopped"
          : "budgetReserved",
    ),
    budget.reason
      ? t(reasons[budget.reason as keyof typeof reasons])
      : undefined,
    budget.state === "waiting" ? t("budgetNotDispatched") : undefined,
    `${t("budgetRecorded")}: ${money(budget.recordedUsd)}`,
    `${t("budgetCommitted")}: ${money(budget.reservedUsd)}`,
    `${t("budgetLimit")}: ${money(budget.limitUsd)}`,
    budget.requestedUsd !== null
      ? `${t("budgetRequested")}: ${money(budget.requestedUsd)}`
      : undefined,
    `${t("budgetRetries")}: ${budget.retriesUsed}/${budget.retryLimit}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function waitingBudgetCalls(events: RecordData[]) {
  const waiting = new Map<
    string,
    NonNullable<ReturnType<typeof budgetActivityMetadata>>
  >();
  for (const event of events) {
    if (["resumed", "steered"].includes(event.eventType)) {
      waiting.clear();
      continue;
    }
    const metadata = budgetActivityMetadata(event);
    if (metadata) {
      const key = `${metadata.runId}:${metadata.callId}:${metadata.attempt}`;
      if (metadata.budget.state === "waiting") waiting.set(key, metadata);
      else waiting.delete(key);
    } else if (
      [
        "provider_call_started",
        "provider_call_completed",
        "provider_call_failed",
      ].includes(event.eventType)
    ) {
      const provider = providerActivityMetadata(event);
      for (const [key, call] of waiting) {
        if (
          call.callId === provider.callId &&
          (!provider.runId || call.runId === provider.runId) &&
          (!provider.attempt || call.attempt === provider.attempt)
        )
          waiting.delete(key);
      }
    } else if (
      [
        "failed",
        "supervisor_failed",
        "completed",
        "cancelled",
        "interrupted",
      ].includes(event.eventType)
    ) {
      for (const [key, call] of waiting)
        if (call.runId === event.runId) waiting.delete(key);
    }
  }
  return [...waiting.values()];
}

export function terminalBudgetDecision(
  run: RecordData,
  events: RecordData[] = [],
  attempts: RecordData[] = [],
) {
  if (run.status !== "failed") return;
  const category = /(?:^|;)\s*category=([a-z_]+)/.exec(
    String(run.error || run.failureReason || ""),
  )?.[1];
  if (category && category !== "budget") return;
  let resumed = -1;
  events.forEach((event, index) => {
    if (["resumed", "steered"].includes(event.eventType)) resumed = index;
  });
  const stopped = events
    .slice(resumed + 1)
    .map(budgetActivityMetadata)
    .filter(
      (value) =>
        value && value.runId === run.id && value.budget.state === "stopped",
    )
    .at(-1);
  if (stopped) return stopped.budget;
  const failureEvent =
    run.failureEvent && budgetActivityMetadata(run.failureEvent);
  if (failureEvent && failureEvent.budget.state === "stopped")
    return failureEvent.budget;
  const persisted = budgetDecision(
    run.budgetDecision ?? run.settings?.budgetDecision,
  );
  if (persisted?.state === "stopped") return persisted;
  const attempt = attempts
    .filter(
      (item) =>
        item.runId === run.id &&
        (run.generation === undefined || item.generation === run.generation) &&
        (resumed < 0 ||
          Date.parse(item.startedAt) >= Date.parse(events[resumed].createdAt)),
    )
    .at(-1);
  const decision = budgetDecision(attempt?.settings?.budgetDecision);
  return decision?.state === "stopped" ? decision : undefined;
}

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
  const waiting = waitingBudgetCalls(events);
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
  return (
    run.status !== "queued" && active.length
      ? waiting.some((call) => call.runId === run.id)
        ? [run, ...active]
        : active
      : [run]
  ).map((agent) => {
    const work = agent.status === "queued" ? undefined : progress.get(agent.id);
    const budgets = waiting.filter((call) => call.runId === agent.id);
    return {
      id: agent.id,
      name: `${agentName(agent, t)}${agent.status === "queued" ? ` · ${t("run_queued")}` : ""}`,
      text: budgets.length
        ? budgets.map((call) => budgetDescription(call.budget, t)).join(" · ")
        : work
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
      summary: budgets.length ? undefined : work?.summary,
      hasProgress: Boolean(work) || budgets.length > 0,
    };
  });
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
    editing_document: "workspaceWorkEditingDocument",
    checking_editorial: "workspaceWorkCheckingEditorial",
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
    if (raw.length > 16384) return {};
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
        issue.path[0] === "editorial",
    )
  )
    return t("workspaceFailureEditorial");
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
  const budget = budgetActivityMetadata(event);
  if (budget) return budgetDescription(budget.budget, t);
  if (
    ["budget_waiting", "budget_reserved", "budget_stopped"].includes(
      event.eventType,
    )
  )
    return undefined;
  const metadata = providerActivityMetadata(event);
  let explanation =
    providerFailureExplanation(metadata.diagnostics, t) ??
    (metadata.providerStatus === 429 ||
    /;\s*HTTP 429(?:;|$)/.test(event.resultSummary ?? "")
      ? t("workspaceFailureRateLimit")
      : undefined);
  const diagnostics = metadata.diagnostics;
  const details = [
    metadata.providerStatus ? `HTTP ${metadata.providerStatus}` : undefined,
    diagnostics?.providerMessage
      ? `${t("workspaceProviderReason")}: ${diagnostics.providerMessage}`
      : undefined,
    diagnostics?.providerCode ||
      diagnostics?.providerType ||
      diagnostics?.transportCode,
    diagnostics?.providerParam
      ? `${t("workspaceProviderParameter")}: ${diagnostics.providerParam}`
      : undefined,
    diagnostics?.providerRequestId
      ? `${t("workspaceProviderRequestId")}: ${diagnostics.providerRequestId}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  explanation = [explanation, details].filter(Boolean).join(" · ") || undefined;
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
  const budget = terminalBudgetDecision(run, events, attempts);
  if (budget) return budgetDescription(budget, t);
  if (
    /(?:^|;)\s*category=budget(?:;|$)/.test(
      String(run.error || run.failureReason || ""),
    )
  )
    return t("budgetStopped");
  // A persisted timeout is authoritative over diagnostics from earlier attempts.
  // In particular, a prior truncation must not suggest increasing output tokens.
  const reason = String(run.error || run.failureReason || "");
  if (/(?:^|;)\s*category=timeout(?:;|$)/.test(reason)) return undefined;
  const phase = /(?:^|;)\s*phase=([a-z_]+)/.exec(reason)?.[1];
  const candidates = events.filter((event) => {
    if (
      !["provider_call_failed", "provider_attempt_failed"].includes(
        event.eventType,
      )
    )
      return false;
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
  budget_waiting: "budgetWaiting",
  budget_reserved: "budgetReserved",
  budget_stopped: "budgetStopped",
  work_progress: "workspaceActivityStep",
  decision_routed: "decisionRoutingPlannerRetained",
  started: "workspaceActivityRunStarted",
  supervisor_started: "workspaceActivityStarted",
  provider_call_started: "workspaceActivityProviderCallStarted",
  provider_call_completed: "workspaceActivityProviderCallCompleted",
  provider_call_retrying: "workspaceActivityProviderCallRetrying",
  provider_call_failed: "workspaceActivityProviderCallFailed",
  provider_attempt_failed: "workspaceActivityProviderCallFailed",
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
  | "decisionRoutingSummarySelected"
  | "workspaceActivityTimedOut"
  | "workspaceFailureRateLimit";

export function runActivityLabel(
  event: RecordData,
): ActivityTranslationKey | undefined {
  if (event.eventType === "decision_routed")
    return event.resultSummary === "selected_source_summary"
      ? "decisionRoutingSummarySelected"
      : "decisionRoutingPlannerRetained";
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
