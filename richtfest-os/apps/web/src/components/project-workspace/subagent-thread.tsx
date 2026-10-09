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
        ...query.data.run,
        ...initialRun,
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
  const running = ["queued", "running"].includes(streamStatus ?? run.status);
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
            {t(`run_${run.status}` as Parameters<typeof t>[0]) || run.status}
          </Badge>
          <AgentRunMetrics run={run} />
        </div>
      </header>
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
                          {running ? (
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
