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
import { Input } from "../ui/input";
import { Badge, Callout, Field, Form, Modal } from "../ui/primitives";
import { Message, MessageContent, MessageHeader } from "../ui/message";
import { Bubble, BubbleContent } from "../ui/bubble";
import { Marker, MarkerContent } from "../ui/marker";
import { runActivityLabel } from "./run-activity";
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

function agentName(run: RecordData, t: ReturnType<typeof useT>) {
  if (run.specialistRole === "source_reviewer")
    return t("agentThreadSourceName");
  if (run.specialistRole === "requirements_reviewer")
    return t("agentThreadRequirementsName");
  if (run.specialistRole === "independent_reviewer")
    return t("supervisorIndependentReviewer");
  if (run.isSupervisor) return t("supervisorRole");
  if (!run.parentRunId) return t("agentThreadCoordinator");
  return (
    run.goal?.split(/[.!?\n]/)[0]?.slice(0, 72) || t("agentThreadSpecialist")
  );
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
  const value = event.paramsSummary;
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
    const id = event.paramsSummary;
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
  const phaseLabel = supervisorPhaseLabel(
    oldestActiveCall?.phase ?? phase,
    t,
  );
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
            {t("agentRunLastProgress")}: {new Date(lastProgress).toLocaleTimeString(
              undefined,
              { hour: "2-digit", minute: "2-digit" },
            )}
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
  const approve = useWrite(`/knowledge/runs/${runId}/approve`, () =>
    setReview(false),
  );
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
  useEffect(() => {
    setLiveEvents([]);
    setStreamStatus(undefined);
  }, [runId]);
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
  }, [runId, run?.status, query.refetch]);
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
  const currentStatus = streamStatus ?? run.status;
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
  const activeChild = childRuns.find((child) =>
    ["queued", "running"].includes(child.status),
  );
  const currentTask = run.isSupervisor
    ? activeChild?.goal ||
      t(childRuns.length ? "workspaceTaskReviewing" : "workspaceTaskPlanning")
    : run.goal;
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
            {t(`run_${currentStatus}` as Parameters<typeof t>[0]) || currentStatus}
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
              <MessageScrollerItem messageId={`${runId}-result`}>
                <Message>
                  <MessageContent>
                    <MessageHeader>{agentName(run, t)}</MessageHeader>
                    {output ? (
                      <Bubble variant="ghost">
                        <BubbleContent className="whitespace-pre-wrap">
                          {output}
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
                      active={executing}
                      currentTask={currentTask}
                    />
                    {run.rationale && (
                      <p className="agent-thread-rationale">{run.rationale}</p>
                    )}
                    {run.error && <Callout tone="error">{run.error}</Callout>}
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
                      {t("agentThreadSpecialists")} · {list(query.data?.children).length}
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
                        return (
                          <Link
                            key={child.id}
                            to={`/projects/${projectId}?${target}`}
                          >
                            <span>{agentName(child, t)}</span>
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
      </footer>
      {review && !managed && (
        <Modal title={t("reviewRun")} onClose={() => setReview(false)}>
          <Form
            label={t("approveRun")}
            pending={approve.isPending}
            error={approve.error}
            onSubmit={(form) =>
              approve.mutate({ decision: "approved", note: form.get("note") })
            }
          >
            <Callout>{t("approvalBoundary")}</Callout>
            <p>{run.outputSummary}</p>
            <Field label={t("reviewNoteLabel")}>
              <Input name="note" />
            </Field>
            <Button
              type="button"
              variant="ghost"
              disabled={approve.isPending}
              onClick={() => approve.mutate({ decision: "rejected" })}
            >
              {t("rejectRun")}
            </Button>
          </Form>
        </Modal>
      )}
    </section>
  );
}
