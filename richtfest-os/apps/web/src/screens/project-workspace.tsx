import { useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { formatProjectAddress } from "@richtfest/shared";
import { api, list } from "../api";
import { queryClient, useApi, useWrite } from "../query";
import { projectStatusLabel, useT } from "../i18n";
import { Page, PageHeader } from "../components/layout";
import { Button } from "../components/ui/button";
import { Input, Textarea } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { Badge, Callout, Field } from "../components/ui/primitives";
import { ThreadRail } from "../components/project-workspace/thread-rail";
import { LoadState, Sources, Knowledge } from "./foundation";
import { Transcript } from "../components/project-workspace/transcript";
import { ArtifactPanel } from "../components/project-workspace/artifacts";
import { LiveRun } from "../components/project-workspace/live-run";
import { SubagentThread } from "../components/project-workspace/subagent-thread";
import { ProjectAnalytics } from "../components/project-workspace/analytics";
import { LocationMode } from "../components/location/mode";
import { AddressSelect } from "../components/address-select";
import { ArrowUp } from "lucide-react";

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
  const view = params.get("view") || "workspace";
  const [editingDetails, setEditingDetails] = useState(false);
  const [initialMessage, setInitialMessage] = useState<string>();
  const [initialMessageDraft, setInitialMessageDraft] = useState("");
  const project = useApi(`/projects/${id}`),
    workspace = useApi(
      `/knowledge/workspaces/${id}`,
      view !== "location" && view !== "analytics",
    ),
    customers = useApi("/crm/customers", view === "details" || editingDetails);
  const conversations = list(workspace.data?.conversations);
  const selected =
    conversations.find((c) => c.id === params.get("conversation")) ||
    conversations.find((conversation) => !conversation.archivedAt);
  const threadArtifacts = list(workspace.data?.artifacts).filter(
    (artifact) => selected && artifact.conversationId === selected.id,
  );
  const threadTasks = list(workspace.data?.tasks).filter(
    (task) => selected && task.conversationId === selected.id,
  );
  const agentRunId = params.get("agentRun");
  const selectedRun = list(workspace.data?.runs).find(
    (run) => run.id === agentRunId,
  );
  const activeRuns = list(workspace.data?.runs).filter((run) =>
    ["queued", "running"].includes(run.status),
  );
  const transcriptLiveRunIds = new Set(
    !agentRunId && selected
      ? activeRuns
          .filter(
            (run) => !run.parentRunId && run.conversationId === selected.id,
          )
          .map((run) => run.id)
      : [],
  );
  const create = useWrite("/knowledge/conversations", (data) => {
    const next = new URLSearchParams(params);
    next.set("conversation", data.id);
    next.delete("message");
    next.delete("agentRun");
    for (const key of ["artifact", "revision", "file", "sourceVersion", "page"])
      next.delete(key);
    setParams(next);
  });
  const updateProject = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/projects/${id}`, body, "PATCH"),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [`/projects/${id}`] });
      await queryClient.invalidateQueries({ queryKey: ["/projects"] });
      setEditingDetails(false);
    },
  });
  const [width, setWidth] = useState(38);
  const details = project.data?.project || project.data || {};
  const title = details.name || t("project");
  if (view === "sharedWork") {
    const next = new URLSearchParams(params);
    next.delete("view");
    next.set("panel", "tasks");
    return <Navigate replace to={`?${next}`} />;
  }
  return (
    <Page>
      <PageHeader
        title={title}
        titleAside={<Badge>{projectStatusLabel(details.status, t)}</Badge>}
        eyebrow={project.data?.customerName}
        actions={
          view === "details" && (
            <Button
              variant="outline"
              onClick={() => {
                updateProject.reset();
                setEditingDetails(true);
              }}
            >
              {t("editProject")}
            </Button>
          )
        }
      />
      <nav className="workspace-view-links" aria-label={t("projectDetails")}>
        {[
          "workspace",
          "location",
          "details",
          "sources",
          "knowledge",
          "analytics",
        ].map((key) => (
          <Link
            key={key}
            aria-current={view === key ? "page" : undefined}
            to={`/projects/${id}${key === "workspace" ? "" : `?view=${key}`}`}
          >
            {key === "workspace"
              ? t("workspaceConversation")
              : key === "location"
                ? t("locationEditor")
                : key === "details"
                  ? t("projectDetails")
                  : t(key as "sources")}
          </Link>
        ))}
      </nav>
      <LoadState query={project} />
      {view === "location" && project.isSuccess && (
        <LocationMode projectId={id!} address={details} />
      )}
      {view === "analytics" && project.isSuccess && (
        <ProjectAnalytics key={id} projectId={id!} />
      )}
      {view === "workspace" && (
        <>
          <LoadState query={workspace} />
          <div className="project-workspace-content">
            <div className="project-thread-layout">
              <ThreadRail
                projectId={id!}
                conversations={conversations}
                selectedId={selected?.id}
                artifactCount={threadArtifacts.length}
                taskCount={threadTasks.length}
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
                  for (const key of [
                    "artifact",
                    "revision",
                    "file",
                    "sourceVersion",
                    "page",
                  ])
                    next.delete(key);
                  setParams(next, { replace: true });
                }}
              />
              <div className="project-thread-main">
                {create.error && (
                  <Callout tone="error">{create.error.message}</Callout>
                )}
                {activeRuns
                  .filter((run) => !transcriptLiveRunIds.has(run.id))
                  .map((run) => (
                    <LiveRun key={run.id} run={run} projectId={id!} silent />
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
                      conversationTitle={selected.title}
                      readState={selected.readState}
                      initialMessage={initialMessage}
                      onInitialMessageSent={() => {
                        setInitialMessage(undefined);
                        setInitialMessageDraft("");
                      }}
                      runs={list(workspace.data?.runs).filter(
                        (run) =>
                          run.conversationId === selected.id &&
                          !run.parentRunId,
                      )}
                    />
                  ) : (
                    <div className="project-conversation workspace-empty-thread">
                      <div className="workspace-empty-prompt">
                        <p>{t("workspaceStart")}</p>
                      </div>
                      <form
                        className="workspace-composer"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          const body = initialMessageDraft.trim();
                          if (
                            !body ||
                            create.isPending ||
                            initialMessage !== undefined ||
                            !workspace.isSuccess
                          )
                            return;
                          setInitialMessage(body);
                          try {
                            await create.mutateAsync({
                              projectId: id,
                              title: `${t("threadRailThread")} ${conversations.length + 1}`,
                              assigneeType: "user",
                            });
                          } catch {
                            setInitialMessage(undefined);
                          }
                        }}
                      >
                        <div className="workspace-composer-shell">
                          <div className="workspace-composer-input">
                            <Textarea
                              value={initialMessageDraft}
                              required
                              disabled={
                                !workspace.isSuccess ||
                                create.isPending ||
                                initialMessage !== undefined
                              }
                              aria-label={t("message")}
                              placeholder={t("workspaceUiComposerPlaceholder")}
                              onChange={(event) =>
                                setInitialMessageDraft(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Enter" &&
                                  !event.shiftKey &&
                                  !event.nativeEvent.isComposing
                                ) {
                                  event.preventDefault();
                                  event.currentTarget.form?.requestSubmit();
                                }
                              }}
                            />
                          </div>
                          <div className="workspace-composer-controls">
                            <span className="workspace-composer-status" />
                            <Button
                              type="submit"
                              size="icon"
                              className="workspace-send-button"
                              aria-label={t("workspaceUiSendMessage")}
                              title={t("workspaceUiSendShortcut")}
                              disabled={
                                !workspace.isSuccess ||
                                create.isPending ||
                                initialMessage !== undefined ||
                                !initialMessageDraft.trim()
                              }
                            >
                              <ArrowUp aria-hidden="true" />
                            </Button>
                          </div>
                        </div>
                      </form>
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
                    artifacts={threadArtifacts}
                    runs={list(workspace.data?.runs)}
                    tasks={threadTasks}
                    initialFiles={list(project.data?.files)}
                  />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
      {view === "details" &&
        (editingDetails ? (
          <form
            className="form project-details-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const values = Object.fromEntries(form.entries());
              const body: Record<string, unknown> = {
                name: values.name,
                status: values.status,
                street: values.street,
                postalCode: values.postalCode,
                city: values.city,
                country: values.country,
                addressReference: JSON.parse(
                  String(values.addressReference || "null"),
                ),
              };
              if (typeof values.customerId === "string")
                body.customerId = values.customerId || null;
              updateProject.mutate(body);
            }}
          >
            <Field label={t("name")}>
              <Input
                autoFocus
                required
                maxLength={200}
                name="name"
                defaultValue={details.name || ""}
              />
            </Field>
            <AddressSelect
              defaultValue={details}
              disabled={updateProject.isPending}
            />
            <Field label={t("customer")}>
              <NativeSelect
                name="customerId"
                defaultValue={details.customerId || ""}
                disabled={customers.isPending || customers.isError}
              >
                <option value="">{t("noCustomer")}</option>
                {details.customerId &&
                  !list(customers.data, "customers").some(
                    (customer) => customer.id === details.customerId,
                  ) && (
                    <option value={details.customerId}>
                      {project.data?.customerName || details.customerId}
                    </option>
                  )}
                {list(customers.data, "customers").map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {customers.isError && (
              <Callout tone="error">{customers.error.message}</Callout>
            )}
            <Field label={t("status")}>
              <NativeSelect
                name="status"
                defaultValue={details.status || "planning"}
              >
                {!(["planning", "active", "completed"] as string[]).includes(
                  details.status || "planning",
                ) && <option value={details.status}>{details.status}</option>}
                <option value="planning">{t("projectStatusPlanning")}</option>
                <option value="active">{t("projectStatusActive")}</option>
                <option value="completed">{t("projectStatusCompleted")}</option>
              </NativeSelect>
            </Field>
            {updateProject.error && (
              <Callout tone="error">{updateProject.error.message}</Callout>
            )}
            <div className="form-footer">
              <Button
                type="button"
                variant="outline"
                disabled={updateProject.isPending}
                onClick={() => {
                  updateProject.reset();
                  setEditingDetails(false);
                }}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={updateProject.isPending}>
                {updateProject.isPending ? t("saving") : t("save")}
              </Button>
            </div>
          </form>
        ) : (
          <dl className="project-details">
            <dt>{t("name")}</dt>
            <dd>{title}</dd>
            <dt>{t("address")}</dt>
            <dd>
              {formatProjectAddress(details) || "—"}
              {details.addressReference && (
                <p className="text-ui-xs text-muted-foreground">
                  <a
                    href="https://www.geoapify.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {details.addressReference.attribution}
                  </a>
                </p>
              )}
            </dd>
            <dt>{t("customer")}</dt>
            <dd>{project.data?.customerName || t("noCustomer")}</dd>
            <dt>{t("status")}</dt>
            <dd>{projectStatusLabel(details.status, t)}</dd>
          </dl>
        ))}
      {view === "sources" && (
        <Sources projectId={id!} initial={project.data || {}} />
      )}
      {view === "knowledge" && <Knowledge projectId={id!} />}
    </Page>
  );
}
