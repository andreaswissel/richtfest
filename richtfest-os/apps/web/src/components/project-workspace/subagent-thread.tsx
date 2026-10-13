import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  FileSearch,
  ListChecks,
  Network,
  Sparkles,
} from "lucide-react";
import { list, type RecordData } from "../../api";
import { useApi, useWrite } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Badge, Callout } from "../ui/primitives";
import { AgentRunReview, AgentRunReviews } from "../agent-run-review";
import { AgentRunRetryActions } from "../agent-run-retry-actions";
import { Message, MessageContent, MessageHeader } from "../ui/message";
import { Bubble, BubbleContent } from "../ui/bubble";
import { ChatMarkdown } from "../chat-markdown";
import { Marker, MarkerContent } from "../ui/marker";
import {
  agentName,
  runActivityLabel,
  providerActivityMetadata,
  providerActivityExplanation,
  terminalProviderFailure,
} from "./run-activity";
import {
  AgentThreadMessage,
  useAgentMessageEvents,
} from "./agent-thread-message";
import type { WorkspaceMessage } from "./types";
import { RunActivityFeed } from "./run-activity-feed";
import { CraneWorkingIndicator } from "./crane-working-indicator";
import { AgentRunMetrics, isAgentRunActive } from "../agent-run-metrics";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from "../ui/message-scroller";
import "./subagent-thread.css";

const runReasonPhases = {
  plan: "workspaceRunPhasePlan",
  specialist: "workspaceRunPhaseSpecialist",
  review: "workspaceRunPhaseReview",
  independent_review: "workspaceRunPhaseIndependentReview",
  provider: "workspaceRunPhaseProvider",
  execution: "workspaceRunPhaseExecution",
  source_resolution: "workspaceRunPhaseSourceResolution",
  tool_execution: "workspaceRunPhaseToolExecution",
  finalization: "workspaceRunPhaseFinalization",
  cancellation: "workspaceRunPhaseCancellation",
  approval: "workspaceRunPhaseApproval",
} as const;

const runReasonCategories = {
  provider: "workspaceRunCategoryProvider",
  timeout: "workspaceRunCategoryTimeout",
  permission: "workspaceRunCategoryPermission",
  validation: "workspaceRunCategoryValidation",
  source: "workspaceRunCategorySource",
  project: "workspaceRunCategoryProject",
  cancellation: "workspaceRunCategoryCancellation",
  execution: "workspaceRunCategoryExecution",
} as const;

const canonicalCategoryReasonPrefixes = {
  provider: "The provider call could not complete.",
  timeout: "The provider call exceeded its time limit.",
  permission: "A required permission is unavailable.",
  validation: "The run returned unsupported or invalid output.",
  source: "Required project source content is unavailable.",
  project: "The project is unavailable.",
  execution: "The run stopped unexpectedly before output could be approved.",
} as const;

const genericLegacyRunReasons = new Set([
  "Execution failed or returned unsupported output. Check the provider connection and retry. No output was approved.",
  "Execution was interrupted. Retry to start a new run.",
  "Supervisor stopped: provider, permission, or output validation failed. No output was approved.",
]);

function formatPersistedRunReason(reason: string, t: ReturnType<typeof useT>) {
  if (genericLegacyRunReasons.has(reason))
    return t("workspaceRunNoSpecificReason");
  const match = /^phase=([^;]+);\s*category=([^;]+);\s*(.*)$/s.exec(reason);
  if (!match) return t("workspaceRunNoSpecificReason");
  const phaseKey = runReasonPhases[match[1] as keyof typeof runReasonPhases];
  const categoryKey =
    runReasonCategories[match[2] as keyof typeof runReasonCategories];
  if (!phaseKey || !categoryKey) return t("workspaceRunNoSpecificReason");
  const phase = t(phaseKey);
  const category = /(?:^|;)\s*provider_http_status=429(?:;|$)/.test(reason)
    ? t("workspaceFailureRateLimit")
    : t(categoryKey);
  const cause = match[3];
  const childCauseKey = cause.startsWith("The supervisor failed during")
    ? "workspaceRunChildCauseSupervisorFailed"
    : cause.startsWith("The supervisor was cancelled during")
      ? "workspaceRunChildCauseSupervisorCancelled"
      : cause.startsWith(
            "The supervisor was steered with new instructions during",
          )
        ? "workspaceRunChildCauseSupervisorSteered"
        : undefined;
  if (childCauseKey)
    return `${t("workspaceRunChildCancelledDuring")} ${phase}: ${category} ${t("workspaceRunCauseLabel")}: ${t(childCauseKey)}`;
  if (cause.startsWith("Output was rejected during human review"))
    return t("workspaceRunReviewRejected");
  if (
    match[2] === "cancellation" &&
    !cause.startsWith("The run was cancelled by a user")
  )
    return t("workspaceRunNoSpecificReason");
  if (
    match[2] !== "cancellation" &&
    !(
      match[2] === "timeout" &&
      cause.startsWith("The model call exceeded its configured time limit.")
    ) &&
    !cause.startsWith(
      canonicalCategoryReasonPrefixes[
        match[2] as keyof typeof canonicalCategoryReasonPrefixes
      ],
    )
  )
    return t("workspaceRunNoSpecificReason");
  return `${t(
    match[2] === "cancellation"
      ? "workspaceRunCancelledDuring"
      : "workspaceRunFailedDuring",
  )} ${phase}: ${category}`;
}

function terminalRunReason(run: RecordData, t: ReturnType<typeof useT>) {
  if (run.status !== "failed" && run.status !== "cancelled") return undefined;
  const persistedReason = [run.error, run.failureReason].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (persistedReason)
    return formatPersistedRunReason(persistedReason.trim(), t);
  return run.status === "failed"
    ? t("workspaceRunFailedNoReason")
    : t("workspaceRunCancelledNoReason");
}

function AgentIcon({
  role,
  supervisor,
}: {
  role?: string;
  supervisor?: boolean;
}) {
  const Icon = supervisor
    ? Network
    : role === "source_reviewer"
      ? FileSearch
      : role === "requirements_reviewer"
        ? ListChecks
        : Sparkles;
  return <Icon className="size-icon" aria-hidden="true" />;
}

const sourceVersionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function SubagentList({
  projectId,
  conversationId,
  runs,
}: {
  projectId: string;
  conversationId?: string;
  runs: RecordData[];
}) {
  const t = useT();
  const [params] = useSearchParams();
  const relevant = runs.filter(
    (run) =>
      (run.parentRunId || run.isSupervisor) &&
      (!conversationId || run.conversationId === conversationId),
  );
  const current = relevant.filter(
    (run) => !run.parentRunId || run.status !== "cancelled",
  );
  const previous = relevant.filter(
    (run) => run.parentRunId && run.status === "cancelled",
  );
  const preparing = relevant.some(
    (run) => !run.parentRunId && ["queued", "running"].includes(run.status),
  );
  const row = (run: RecordData) => {
    const next = new URLSearchParams(params);
    next.set("agentRun", run.id);
    if (conversationId || run.conversationId)
      next.set("conversation", conversationId || run.conversationId);
    next.delete("message");
    const reason = terminalRunReason(run, t);
    return (
      <Link
        key={run.id}
        className="subagent-row"
        to={`/projects/${projectId}?${next}`}
        aria-current={params.get("agentRun") === run.id ? "page" : undefined}
      >
        <span className="subagent-icon">
          <AgentIcon
            role={run.specialistRole}
            supervisor={Boolean(run.isSupervisor)}
          />
        </span>
        <span className="subagent-label">
          <strong>{agentName(run, t)}</strong>
          {run.isSupervisor && run.goal && (
            <span className="truncate" title={run.goal}>
              {run.goal}
            </span>
          )}
          <span>
            {t(`run_${run.status}` as Parameters<typeof t>[0]) || run.status}
          </span>
          {reason && (
            <span className="subagent-run-reason" title={reason}>
              <span className="subagent-run-reason-label">
                {t("workspaceRunReason")}:
              </span>{" "}
              {reason}
            </span>
          )}
          <AgentRunMetrics run={run} />
        </span>
        <ArrowUpRight className="size-icon-sm muted" aria-hidden="true" />
      </Link>
    );
  };
  return (
    <div className="subagent-list" aria-label={t("agentThreadList")}>
      {current.length > 0 && (
        <SubagentSection
          title={t("agentRunsActive")}
          runs={current.filter(isAgentRunActive)}
          row={row}
        />
      )}
      {current.length > 0 && (
        <SubagentSection
          title={t("agentRunsDone")}
          runs={current.filter((run) => !isAgentRunActive(run))}
          row={row}
        />
      )}
      {!current.length && (
        <p className="subagent-empty">
          {preparing ? t("agentThreadPreparing") : t("agentThreadEmpty")}
        </p>
      )}
      {previous.length > 0 && (
        <details className="subagent-history">
          <summary>
            {t("agentThreadPrevious")} · {previous.length}
          </summary>
          {previous.map(row)}
        </details>
      )}
    </div>
  );
}

function SubagentSection({
  title,
  runs,
  row,
}: {
  title: string;
  runs: RecordData[];
  row: (run: RecordData) => ReactNode;
}) {
  if (!runs.length) return null;
  return (
    <section className="subagent-section">
      <header className="subagent-section-header">
        <h3>{title}</h3>
        <span className="subagent-section-count">{runs.length}</span>
      </header>
      {runs.map(row)}
    </section>
  );
}

function timestampValue(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function eventTime(event: RecordData) {
  return timestampValue(event.createdAt ?? event.created_at);
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function providerCallId(event: RecordData, index: number) {
  const value = providerActivityMetadata(event).callId;
  return typeof value === "string" && value.trim()
    ? value.trim()
    : `legacy-provider-call-${index}`;
}

function activeProviderCalls(events: RecordData[]) {
  const calls = new Map<
    string,
    { startedAt?: number; active: boolean; phase?: string }
  >();
  events.forEach((event, index) => {
    if (event.eventType === "resumed") {
      for (const call of calls.values()) call.active = false;
      return;
    }
    if (event.eventType === "provider_call_started") {
      calls.set(providerCallId(event, index), {
        startedAt: eventTime(event),
        active: true,
        phase:
          typeof event.resultSummary === "string"
            ? event.resultSummary
            : undefined,
      });
      return;
    }
    if (
      !["provider_call_completed", "provider_call_failed"].includes(
        event.eventType,
      )
    )
      return;
    const id = providerActivityMetadata(event).callId;
    if (typeof id === "string" && id.trim()) {
      const call = calls.get(id.trim());
      if (call) call.active = false;
      return;
    }
    const active = [...calls.values()].filter((call) => call.active);
    if (active.length === 1) active[0].active = false;
  });
  return [...calls.values()].filter((call) => call.active);
}

const phaseTranslationKeys = {
  direct: "workspaceRunPhaseProvider",
  tool_followup: "workspaceRunPhaseToolExecution",
  plan: "agentRunPhasePlan",
  specialist: "agentRunPhaseSpecialists",
  specialists: "agentRunPhaseSpecialists",
  review: "agentRunPhaseReview",
  independent_review: "agentRunPhaseIndependentReview",
  done: "agentRunPhaseDone",
} as const;

function supervisorPhaseLabel(value: unknown, t: ReturnType<typeof useT>) {
  if (typeof value !== "string") return "";
  const key = phaseTranslationKeys[value as keyof typeof phaseTranslationKeys];
  return key ? t(key) : value;
}

function RunDiagnosis({
  status,
  phase,
  createdAt,
  events,
}: {
  status: string;
  phase?: string;
  createdAt?: unknown;
  events: RecordData[];
}) {
  const t = useT();
  const activeCalls = status === "running" ? activeProviderCalls(events) : [];
  const oldestActiveCall = activeCalls
    .filter((call) => call.startedAt !== undefined)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[0];
  const activeCallStartedAt = oldestActiveCall?.startedAt;
  const queuedAt = status === "queued" ? timestampValue(createdAt) : undefined;
  const [now, setNow] = useState(() => Date.now());
  const lastProgress = [...events]
    .map(eventTime)
    .filter((timestamp): timestamp is number => timestamp !== undefined)
    .pop();

  useEffect(() => {
    if (oldestActiveCall === undefined && queuedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeCallStartedAt, queuedAt]);

  const waitingForWorker = status === "queued" && events.length === 0;
  const phaseLabel = supervisorPhaseLabel(oldestActiveCall?.phase ?? phase, t);
  const queueWait = queuedAt === undefined ? undefined : now - queuedAt;
  const callElapsed =
    activeCallStartedAt === undefined ? undefined : now - activeCallStartedAt;

  return (
    <div
      className="border-b px-3 py-2 text-ui-xs text-muted-foreground"
      role="group"
      aria-label={t("agentRunDiagnosis")}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">
          {t("agentRunDiagnosis")}
        </span>
        {waitingForWorker ? (
          <span>
            {t("agentRunWaitingForWorker")}
            {queueWait !== undefined &&
              ` · ${t("agentRunQueueWait")}: ${formatElapsed(queueWait)}`}
          </span>
        ) : status === "queued" ? (
          <span>
            {t("agentRunQueuedWaiting")}
            {queueWait !== undefined &&
              ` · ${t("agentRunQueueWait")}: ${formatElapsed(queueWait)}`}
          </span>
        ) : status === "running" && events.length === 0 ? (
          <span>{t("agentRunAwaitingProgress")}</span>
        ) : phaseLabel ? (
          <span>
            {t("agentRunSupervisorPhase")}: {phaseLabel}
          </span>
        ) : null}
        {activeCalls.length > 0 && (
          <span>
            {t("agentRunProviderCalls")}: {activeCalls.length}
            {callElapsed !== undefined &&
              ` · ${t("agentRunOldestCall")}: ${formatElapsed(callElapsed)}`}
          </span>
        )}
        {lastProgress !== undefined && (
          <span>
            {t("agentRunLastProgress")}:{" "}
            {new Date(lastProgress).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>
    </div>
  );
}

export function SubagentThread({
  projectId,
  runId,
  conversationId,
  initialRun,
}: {
  projectId: string;
  runId: string;
  conversationId?: string;
  initialRun?: RecordData;
}) {
  const t = useT();
  const query = useApi(`/knowledge/runs/${runId}`);
  const [params] = useSearchParams();
  const [review, setReview] = useState(false);
  const [liveEvents, setLiveEvents] = useState<RecordData[]>([]);
  const [streamStatus, setStreamStatus] = useState<string | undefined>();
  const cancel = useWrite(`/knowledge/runs/${runId}/cancel`);
  const run = query.data?.run
    ? {
        ...initialRun,
        ...query.data.run,
        usage: query.data.usage ?? initialRun?.usage,
        isSupervisor: Boolean(
          initialRun?.isSupervisor || query.data.orchestration,
        ),
      }
    : initialRun;
  useAgentMessageEvents(run?.conversationId, runId);
  useEffect(() => {
    setLiveEvents([]);
    setStreamStatus(undefined);
  }, [runId, run?.generation, query.data?.orchestration?.generation]);
  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return;
    const stream = new EventSource(
      `/api/knowledge/runs/${runId}/events/stream`,
      { withCredentials: true },
    );
    stream.addEventListener("activity", (event) => {
      try {
        const activity = JSON.parse((event as MessageEvent).data);
        if (!activity?.id || !runActivityLabel(activity)) return;
        setLiveEvents((old) =>
          old.some((item) => item.id === activity.id)
            ? old
            : [...old, activity],
        );
        if (
          [
            "supervisor_planned",
            "provider_call_started",
            "work_progress",
            "specialist_completed",
            "supervisor_revision_requested",
          ].includes(activity.eventType)
        )
          void query.refetch();
      } catch {
        // Ignore malformed activity frames; the persisted run remains available.
      }
    });
    stream.addEventListener("status", (event) => {
      try {
        const status = JSON.parse((event as MessageEvent).data);
        if (typeof status.status === "string") {
          setStreamStatus(status.status);
          if (!["queued", "running"].includes(status.status)) {
            stream.close();
            void query.refetch();
          }
        }
      } catch {
        // Ignore malformed status frames; the persisted run remains available.
      }
    });
    return () => stream.close();
  }, [
    runId,
    run?.status,
    run?.generation,
    query.data?.orchestration?.generation,
    query.refetch,
  ]);
  const back = new URLSearchParams(params);
  back.delete("agentRun");
  back.delete("message");
  if (conversationId) back.set("conversation", conversationId);
  const mainHref = `/projects/${projectId}?${back}`;
  if (query.error)
    return (
      <div className="agent-thread">
        <Link to={mainHref}>{t("agentThreadBack")}</Link>
        <Callout tone="error">{query.error.message}</Callout>
      </div>
    );
  if (!run)
    return (
      <div className="agent-thread" role="status">
        {t("loading")}
      </div>
    );
  if (run.projectId !== projectId)
    return (
      <div className="agent-thread">
        <Callout>{t("agentThreadUnavailable")}</Callout>
        <Link to={mainHref}>{t("agentThreadBack")}</Link>
      </div>
    );
  const managed = Boolean(run.parentRunId);
  const output = run.outputSummary || run.partialOutput;
  const currentStatus = ["queued", "running"].includes(run.status)
    ? (streamStatus ?? run.status)
    : run.status;
  const running = ["queued", "running"].includes(currentStatus);
  const executing = currentStatus === "running";
  const persistedEvents = list(query.data?.events).filter((event) =>
    runActivityLabel(event),
  );
  const activityEvents = [...persistedEvents];
  for (const event of liveEvents) {
    if (!activityEvents.some((item) => item.id === event.id))
      activityEvents.push(event);
  }
  activityEvents.sort((a, b) =>
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
  );
  const sourceVersionIds: string[] = list(run.sourceVersionIds).flatMap(
    (value) => {
      const versionId = typeof value === "string" ? value : "";
      return sourceVersionIdPattern.test(versionId) ? [versionId] : [];
    },
  );
  const childRuns = list(query.data?.children);
  const reason =
    terminalProviderFailure(
      run,
      activityEvents,
      list(query.data?.attempts),
      t,
    ) ?? terminalRunReason(run, t);
  return (
    <section className="agent-thread" aria-label={agentName(run, t)}>
      <header className="agent-thread-header">
        <Link className="agent-thread-back" to={mainHref}>
          <ArrowLeft className="size-icon-sm" aria-hidden="true" />
          {t("agentThreadBack")}
        </Link>
        <div className="agent-thread-title">
          <AgentIcon
            role={run.specialistRole}
            supervisor={Boolean(run.isSupervisor)}
          />
          <h2>{agentName(run, t)}</h2>
          <Badge>
            {t(`run_${currentStatus}` as Parameters<typeof t>[0]) ||
              currentStatus}
          </Badge>
          <AgentRunMetrics run={run} />
        </div>
      </header>
      <RunDiagnosis
        status={currentStatus}
        phase={query.data?.orchestration?.phase}
        createdAt={run.createdAt ?? run.created_at}
        events={activityEvents}
      />
      <MessageScrollerProvider
        key={runId}
        autoScroll={false}
        defaultScrollPosition="start"
      >
        <MessageScroller className="agent-thread-scroll">
          <MessageScrollerViewport>
            <MessageScrollerContent className="p-page gap-stack">
              {list(query.data?.approvals).length > 0 && (
                <MessageScrollerItem messageId={`${runId}-reviews`}>
                  <AgentRunReviews approvals={list(query.data?.approvals)} />
                </MessageScrollerItem>
              )}
              {list(query.data?.attempts).length > 0 && (
                <MessageScrollerItem messageId={`${runId}-attempts`}>
                  <details className="agent-thread-details">
                    <summary>
                      {t("runExecutionAttempts")} ·{" "}
                      {list(query.data?.attempts).length}
                    </summary>
                    <div className="grid gap-stack text-ui-xs">
                      {list(query.data?.attempts).map((attempt) => (
                        <section key={attempt.id} className="grid gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span>
                              {supervisorPhaseLabel(attempt.phase, t)} ·{" "}
                              {t("runExecutionAttempt")} {attempt.attemptNumber}
                            </span>
                            <Badge>
                              {t(
                                `runAttemptStatus_${attempt.status}` as Parameters<
                                  typeof t
                                >[0],
                              ) || attempt.status}
                            </Badge>
                          </div>
                          <p>
                            {t("runExecutionModel")}:{" "}
                            {attempt.response?.modelId ||
                              attempt.settings?.modelId ||
                              t("runExecutionUnknown")}{" "}
                            · {t("runExecutionEffort")}:{" "}
                            {attempt.settings
                              ? attempt.settings.reasoningEffort ||
                                t("runExecutionProviderDefault")
                              : t("runExecutionUnknown")}
                          </p>
                          {attempt.runId !== runId && (
                            <p className="text-muted-foreground">
                              {t("runExecutionChild")}:{" "}
                              {agentName(
                                childRuns.find(
                                  (child) => child.id === attempt.runId,
                                ) || { id: attempt.runId },
                                t,
                              )}{" "}
                              · {attempt.runId}
                            </p>
                          )}
                          {attempt.usageStatus !== "reported" &&
                            attempt.usageStatus !== "not_applicable" && (
                              <p className="text-muted-foreground">
                                {t(
                                  attempt.usageStatus === "pending"
                                    ? "runExecutionUsagePending"
                                    : "runExecutionUsageMissing",
                                )}
                              </p>
                            )}
                          {attempt.failureCategory && (
                            <p>
                              {t("workspaceRunReason")}:{" "}
                              {providerActivityExplanation(
                                activityEvents.find((event) => {
                                  const metadata =
                                    providerActivityMetadata(event);
                                  return (
                                    [
                                      "provider_call_failed",
                                      "provider_call_retrying",
                                    ].includes(event.eventType) &&
                                    metadata.callId === attempt.operationId &&
                                    metadata.attempt ===
                                      attempt.attemptNumber &&
                                    metadata.runId === attempt.runId
                                  );
                                }) ?? {},
                                t,
                              ) ??
                                t(
                                  attempt.failureCategory === "timeout"
                                    ? "runExecutionTimeout"
                                    : (runReasonCategories[
                                        attempt.failureCategory as keyof typeof runReasonCategories
                                      ] ?? "runExecutionUnknown"),
                                )}
                              {Number.isInteger(attempt.providerStatus) &&
                                attempt.providerStatus >= 100 &&
                                attempt.providerStatus <= 599 &&
                                ` · ${t("workspaceRunProviderHttpStatus")}: ${attempt.providerStatus}`}
                            </p>
                          )}
                        </section>
                      ))}
                    </div>
                  </details>
                </MessageScrollerItem>
              )}
              <MessageScrollerItem
                messageId={`${runId}-assignment`}
                scrollAnchor
              >
                <Message>
                  <MessageContent>
                    <MessageHeader>{t("agentThreadAssignment")}</MessageHeader>
                    <Bubble variant="muted">
                      <BubbleContent className="whitespace-pre-wrap">
                        {run.goal}
                      </BubbleContent>
                    </Bubble>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
              {(
                query.data?.threadMessages as WorkspaceMessage[] | undefined
              )?.map((message) => (
                <MessageScrollerItem key={message.id} messageId={message.id}>
                  <AgentThreadMessage message={message} projectId={projectId} />
                </MessageScrollerItem>
              ))}
              <MessageScrollerItem messageId={`${runId}-result`}>
                <Message>
                  <MessageContent>
                    <MessageHeader>{agentName(run, t)}</MessageHeader>
                    {output ? (
                      <Bubble variant="ghost">
                        <BubbleContent>
                          <ChatMarkdown>{output}</ChatMarkdown>
                        </BubbleContent>
                      </Bubble>
                    ) : (
                      <Marker>
                        <MarkerContent>
                          {executing ? (
                            <CraneWorkingIndicator
                              label={t("agentThreadWorking")}
                            />
                          ) : (
                            t("agentThreadNoResult")
                          )}
                        </MarkerContent>
                      </Marker>
                    )}
                    <RunActivityFeed
                      events={activityEvents}
                      active={running}
                      status={currentStatus}
                      run={{ ...run, status: currentStatus }}
                      children={childRuns}
                    />
                    {run.rationale && (
                      <p className="agent-thread-rationale">{run.rationale}</p>
                    )}
                    {reason && (
                      <Callout
                        tone={run.status === "failed" ? "error" : undefined}
                      >
                        <span className="agent-thread-run-reason-label">
                          {t("workspaceRunReason")}:
                        </span>{" "}
                        {reason}
                      </Callout>
                    )}
                    {!managed && run.status === "needs_review" && (
                      <div>
                        <Button onClick={() => setReview(true)}>
                          {t("reviewRun")}
                        </Button>
                      </div>
                    )}
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
              {sourceVersionIds.length > 0 && (
                <MessageScrollerItem messageId={`${runId}-sources`}>
                  <details className="agent-thread-details">
                    <summary>{t("agentThreadSources")}</summary>
                    <div className="agent-thread-sources">
                      {sourceVersionIds.map((versionId, index) => {
                        const target = new URLSearchParams(params);
                        target.set("panel", "documents");
                        target.set("sourceVersion", versionId);
                        target.delete("file");
                        return (
                          <Link
                            key={versionId}
                            to={`/projects/${projectId}?${target}`}
                          >
                            {t("source")} {index + 1}
                            <ArrowUpRight
                              className="size-icon-sm"
                              aria-hidden="true"
                            />
                          </Link>
                        );
                      })}
                    </div>
                  </details>
                </MessageScrollerItem>
              )}
              {list(query.data?.children).length > 0 && (
                <MessageScrollerItem messageId={`${runId}-specialists`}>
                  <details className="agent-thread-details">
                    <summary>
                      {t("agentThreadSpecialists")} ·{" "}
                      {list(query.data?.children).length}
                    </summary>
                    <div className="agent-thread-specialists">
                      {list(query.data?.children).map((child) => {
                        if (
                          typeof child.id !== "string" ||
                          !sourceVersionIdPattern.test(child.id)
                        )
                          return null;
                        const target = new URLSearchParams(params);
                        target.set("agentRun", child.id);
                        if (conversationId || child.conversationId)
                          target.set(
                            "conversation",
                            conversationId || child.conversationId,
                          );
                        target.delete("message");
                        const reason = terminalRunReason(child, t);
                        return (
                          <Link
                            key={child.id}
                            to={`/projects/${projectId}?${target}`}
                          >
                            <span className="agent-thread-specialist-copy">
                              <span>{agentName(child, t)}</span>
                              {reason && (
                                <span
                                  className="agent-thread-specialist-reason"
                                  title={reason}
                                >
                                  <span className="agent-thread-run-reason-label">
                                    {t("workspaceRunReason")}:
                                  </span>{" "}
                                  {reason}
                                </span>
                              )}
                            </span>
                            <Badge>
                              {t(
                                `run_${child.status}` as Parameters<
                                  typeof t
                                >[0],
                              ) || child.status}
                            </Badge>
                            <ArrowUpRight
                              className="size-icon-sm"
                              aria-hidden="true"
                            />
                          </Link>
                        );
                      })}
                    </div>
                  </details>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
      <footer className="agent-thread-footer">
        <Link to={mainHref}>
          {t(managed ? "agentThreadGuide" : "agentThreadContinue")}
        </Link>
        {!managed && running && (
          <Button
            variant="ghost"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate({})}
          >
            {t("workspaceStop")}
          </Button>
        )}
        {cancel.error && <Callout tone="error">{cancel.error.message}</Callout>}
        <AgentRunRetryActions
          key={run.id}
          run={{ ...run, status: currentStatus }}
        />
      </footer>
      {review && !managed && (
        <AgentRunReview
          key={runId}
          run={run}
          onClose={() => setReview(false)}
        />
      )}
    </section>
  );
}
