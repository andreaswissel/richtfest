import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { list } from "../api";
import { useApi, useWrite } from "../query";
import { useT } from "../i18n";
import { Page, PageHeader } from "../components/layout";
import { Badge, Callout } from "../components/ui/primitives";
import { ThreadRail } from "../components/project-workspace/thread-rail";
import { LoadState, Sources, SharedWork, Knowledge } from "./foundation";
import { Transcript } from "../components/project-workspace/transcript";
import { ArtifactPanel } from "../components/project-workspace/artifacts";
import { LiveRun } from "../components/project-workspace/live-run";
import { SubagentThread } from "../components/project-workspace/subagent-thread";

const MIN_ARTIFACT_WIDTH = 25;
const MAX_ARTIFACT_WIDTH = 60;

function WorkspaceResizeHandle({
  width,
  onChange,
  label,
}: {
  width: number;
  onChange: (width: number) => void;
  label: string;
}) {
  const setFromClientX = (clientX: number, element: HTMLElement) => {
    const bounds = element.parentElement?.getBoundingClientRect();
    if (!bounds || !bounds.width) return;
    const next = ((bounds.right - clientX) / bounds.width) * 100;
    onChange(
      Math.round(
        Math.min(MAX_ARTIFACT_WIDTH, Math.max(MIN_ARTIFACT_WIDTH, next)),
      ),
    );
  };

  return (
    <button
      type="button"
      className="workspace-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={MIN_ARTIFACT_WIDTH}
      aria-valuemax={MAX_ARTIFACT_WIDTH}
      aria-valuenow={width}
      title={label}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const delta = event.key === "ArrowRight" ? 5 : -5;
          onChange(
            Math.min(
              MAX_ARTIFACT_WIDTH,
              Math.max(MIN_ARTIFACT_WIDTH, width + delta),
            ),
          );
        } else if (event.key === "Home") {
          event.preventDefault();
          onChange(MIN_ARTIFACT_WIDTH);
        } else if (event.key === "End") {
          event.preventDefault();
          onChange(MAX_ARTIFACT_WIDTH);
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const element = event.currentTarget;
        const move = (moveEvent: PointerEvent) =>
          setFromClientX(moveEvent.clientX, element);
        const stop = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop, { once: true });
      }}
    />
  );
}

export function ProjectWorkspace() {
  const { id } = useParams(),
    t = useT(),
    [params, setParams] = useSearchParams();
  const project = useApi(`/projects/${id}`),
    workspace = useApi(`/knowledge/workspaces/${id}`);
  const view = params.get("view") || "workspace";
  const conversations = list(workspace.data?.conversations);
  const selected =
    conversations.find((c) => c.id === params.get("conversation")) ||
    conversations.find((conversation) => !conversation.archivedAt);
  const agentRunId = params.get("agentRun");
  const selectedRun = list(workspace.data?.runs).find(
    (run) => run.id === agentRunId,
  );
  const activeRuns = list(workspace.data?.runs).filter((run) =>
    ["queued", "running"].includes(run.status),
  );
  const visibleLiveRunId =
    activeRuns.find(
      (run) => run.id === (selectedRun?.parentRunId || agentRunId),
    )?.id ||
    activeRuns.find(
      (run) => !run.parentRunId && run.conversationId === selected?.id,
    )?.id ||
    activeRuns.find((run) => !run.parentRunId)?.id;
  const create = useWrite("/knowledge/conversations", (data) => {
    const next = new URLSearchParams(params);
    next.set("conversation", data.id);
    next.delete("message");
    next.delete("agentRun");
    setParams(next);
  });
  const [width, setWidth] = useState(38);
  const title = (project.data?.project || project.data)?.name || t("project");
  return (
    <Page>
      <PageHeader
        title={title}
        eyebrow={project.data?.customerName}
        actions={
          <Badge>
            {(project.data?.project || project.data)?.status || t("active")}
          </Badge>
        }
      />
      <nav className="workspace-view-links" aria-label={t("projectDetails")}>
        {["workspace", "details", "sources", "sharedWork", "knowledge"].map(
          (key) => (
            <Link
              key={key}
              aria-current={view === key ? "page" : undefined}
              to={`/projects/${id}${key === "workspace" ? "" : `?view=${key}`}`}
            >
              {key === "workspace"
                ? t("workspaceConversation")
                : key === "details"
                  ? t("projectDetails")
                  : t(key as "sources")}
            </Link>
          ),
        )}
      </nav>
      <LoadState query={project} />
      {view === "workspace" && (
        <>
          <LoadState query={workspace} />
          <div className="project-workspace-content">
            <div className="project-thread-layout">
              <ThreadRail
                projectId={id!}
                conversations={conversations}
                selectedId={selected?.id}
                creating={create.isPending}
                onCreate={() =>
                  create.mutate({
                    projectId: id,
                    title: `${t("threadRailThread")} ${conversations.length + 1}`,
                    assigneeType: "user",
                  })
                }
                onArchived={(threadId, archived) => {
                  if (!archived || selected?.id !== threadId) return;
                  const nextThread = conversations.find(
                    (thread) => thread.id !== threadId && !thread.archivedAt,
                  );
                  const next = new URLSearchParams(params);
                  if (nextThread) next.set("conversation", nextThread.id);
                  else next.delete("conversation");
                  next.delete("message");
                  next.delete("agentRun");
                  setParams(next, { replace: true });
                }}
              />
              <div className="project-thread-main">
                {create.error && (
                  <Callout tone="error">{create.error.message}</Callout>
                )}
                {activeRuns.map((run) => (
                  <LiveRun
                    key={run.id}
                    run={run}
                    projectId={id!}
                    silent={run.id !== visibleLiveRunId}
                  />
                ))}
                <div
                  className="project-workspace-grid"
                  style={{
                    gridTemplateColumns: `minmax(0,${100 - width}fr) 8px minmax(0,${width}fr)`,
                  }}
                >
                  {agentRunId ? (
                    <SubagentThread
                      key={agentRunId}
                      projectId={id!}
                      runId={agentRunId}
                      conversationId={selected?.id}
                      initialRun={selectedRun}
                    />
                  ) : selected ? (
                    <Transcript
                      key={selected.id}
                      projectId={id!}
                      conversationId={selected.id}
                      readState={selected.readState}
                      runs={list(workspace.data?.runs).filter(
                        (run) =>
                          run.conversationId === selected.id &&
                          !run.parentRunId,
                      )}
                    />
                  ) : (
                    <div className="workspace-start">
                      <p>{t("workspaceStart")}</p>
                    </div>
                  )}
                  <WorkspaceResizeHandle
                    width={width}
                    onChange={setWidth}
                    label={t("workspacePanelWidth")}
                  />
                  <ArtifactPanel
                    projectId={id!}
                    conversationId={selected?.id}
                    artifacts={list(workspace.data?.artifacts)}
                    runs={list(workspace.data?.runs)}
                    tasks={list(workspace.data?.tasks)}
                    initialFiles={list(project.data?.files)}
                  />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
      {view === "details" && (
        <dl className="project-details">
          <dt>{t("name")}</dt>
          <dd>{title}</dd>
          <dt>{t("customer")}</dt>
          <dd>{project.data?.customerName || "—"}</dd>
          <dt>{t("status")}</dt>
          <dd>{(project.data?.project || project.data)?.status}</dd>
        </dl>
      )}
      {view === "sources" && (
        <Sources projectId={id!} initial={project.data || {}} />
      )}
      {view === "sharedWork" && <SharedWork projectId={id!} />}{" "}
      {view === "knowledge" && <Knowledge projectId={id!} />}
    </Page>
  );
}
