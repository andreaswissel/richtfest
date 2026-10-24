import { Fragment, useRef, useState, type ReactNode } from "react";
import {
  Link,
  Navigate,
  useOutletContext,
  useParams,
  useSearchParams,
  useNavigate,
} from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { formatProjectAddress } from "@richtfest/shared";
import { buildProjectViewPath } from "@richtfest/shared/project-view-context";
import { api, ApiError, list } from "../api";
import { queryClient, useApi, useWrite } from "../query";
import { projectStatusLabel, useT } from "../i18n";
import { Page } from "../components/layout";
import { AppUpdateButton } from "../components/app-update-button";
import { Button } from "../components/ui/button";
import { Input, Textarea } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { Badge, Callout, Field } from "../components/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { ThreadRail } from "../components/project-workspace/thread-rail";
import { LoadState, Sources, Knowledge } from "./foundation";
import { Transcript } from "../components/project-workspace/transcript";
import { ArtifactPanel } from "../components/project-workspace/artifacts";
import { LiveRun } from "../components/project-workspace/live-run";
import { SubagentThread } from "../components/project-workspace/subagent-thread";
import { ProjectAnalytics } from "../components/project-workspace/analytics";
import { LocationMode } from "../components/location/mode";
import { BuildingModelMode } from "../components/building-model";
import { Inquiries } from "../components/inquiries";
import { NoiseSources } from "../components/noise-sources";
import { Feasibility } from "../components/feasibility";
import { AddressSelect } from "../components/address-select";
import { ProjectOverview } from "../components/project-workspace/project-overview";
import { ProjectAssistant } from "../components/project-workspace/project-assistant";
import { ArrowUp, MessageCircle } from "lucide-react";

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
  const navigate = useNavigate();
  const perspective =
    params.get("perspective") === "coordinator"
      ? "coordinator"
      : params.get("perspective") === "planner"
        ? "planner"
        : "nerd";
  const view =
    params.get("view") === "overview" && perspective === "nerd"
      ? "workspace"
      : params.get("view") || "workspace";
  const assistantOpen = view !== "workspace" && params.get("assistant") === "1" && params.get("guide") !== "1";
  const assistantTrigger = useRef<HTMLButtonElement>(null);
  const sourceRef = buildProjectViewPath(
    id!,
    new URLSearchParams({
      ...Object.fromEntries(params),
      view,
    }),
  );
  const workspaceNavigation = useOutletContext<
    { workspaceNavigation: ReactNode } | undefined
  >()?.workspaceNavigation;
  const mobilePanel =
    ["panel", "artifact", "file", "sourceVersion"].some((key) =>
      params.has(key),
    ) &&
    !params.has("agentRun") &&
    !params.has("message")
      ? "resources"
      : "conversation";
  const resourcesParams = new URLSearchParams(params);
  resourcesParams.set("panel", params.get("panel") || "artifacts");
  resourcesParams.delete("agentRun");
  resourcesParams.delete("message");
  const [editingDetails, setEditingDetails] = useState(false);
  const [initialMessage, setInitialMessage] = useState<string>();
  const [initialMessageDraft, setInitialMessageDraft] = useState("");
  const project = useApi(`/projects/${id}`),
    workspace = useApi(
      `/knowledge/workspaces/${id}`,
      assistantOpen ||
        (view !== "overview" &&
          view !== "location" &&
          view !== "analytics" &&
          view !== "building-model" &&
          view !== "fire-protection" &&
          view !== "inquiries" &&
          view !== "noise" &&
          view !== "feasibility"),
    ),
    customers = useApi("/crm/customers", view === "details" || editingDetails);
  const conversations = list(workspace.data?.conversations);
  const selected =
    conversations.find((c) => c.id === params.get("conversation")) ||
    conversations.find((conversation) => !conversation.archivedAt);
  const threadArtifacts = list(workspace.data?.artifacts).filter(
    (artifact) => selected && artifact.conversationId === selected.id,
  );
  const threadTasks = list(workspace.data?.tasks);
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
    next.delete("panel");
    next.delete("message");
    next.delete("agentRun");
    for (const key of [
      "artifact",
      "revision",
      "file",
      "sourceVersion",
      "sourceSelection",
      "page",
    ])
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
  const me = useApi("/auth/me");
  const meUser = me.isError ? undefined : me.data?.user || me.data;
  const canWrite = (
    me.data?.permissions ||
    me.data?.user?.permissions ||
    []
  ).includes("projects:write");
  const permissions = me.data?.permissions || me.data?.user?.permissions || [];
  const canUseAssistant = permissions.includes("knowledge:read");
  const closeAssistant = () => {
    const next = new URLSearchParams(params);
    next.delete("assistant");
    setParams(next, { replace: true });
    assistantTrigger.current?.focus({ preventScroll: true });
  };
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteProject = useMutation({
    mutationFn: () => api(`/projects/${id}`, undefined, "DELETE"),
    onSuccess: async () => {
      setDeleteOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["/projects"] });
      await queryClient.invalidateQueries({ queryKey: ["/dashboard"] });
      const projectCacheFragments = [
        `/projects/${id}`,
        `/knowledge/workspaces/${id}`,
        `projectId=${id}`,
        `/feasibility/projects/${id}`,
      ];
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return (
            typeof key === "string" &&
            projectCacheFragments.some((fragment) => key.includes(fragment))
          );
        },
        refetchType: "none",
      });
      queryClient.removeQueries({ queryKey: [`/projects/${id}`] });
      navigate("/projects", { replace: true });
    },
  });
  const [width, setWidth] = useState(38);
  const details = project.data?.project || project.data || {};
  const title = details.name || t("project");
  const perspectiveLink = (next: typeof perspective) => {
    const search = new URLSearchParams(params);
    search.set("perspective", next);
    // A lens change inside an editor changes chrome only; the editor stays mounted.
    if (view === "overview" || view === "workspace") {
      search.set("view", next === "nerd" ? "workspace" : "overview");
    }
    return `/projects/${id}?${search}`;
  };
  const perspectiveNavigation = (
    <nav
      className="segmented project-perspectives"
      aria-label={t("planningPerspective")}
    >
      {(["coordinator", "planner", "nerd"] as const).map((key) => (
        <Button key={key} asChild variant="ghost" size="sm">
          <Link
            to={perspectiveLink(key)}
            data-state={perspective === key ? "on" : "off"}
            aria-current={perspective === key ? "true" : undefined}
          >
            {t(
              key === "coordinator"
                ? "planningViewCoordinator"
                : key === "planner"
                  ? "planningViewPlanner"
                  : "planningViewNerd",
            )}
          </Link>
        </Button>
      ))}
    </nav>
  );
  const moduleLink = (key: string) => {
    // Carry the overview lens, not stale source or editor selections, into another module.
    const search = new URLSearchParams();
    search.set("view", key);
    search.set("perspective", perspective);
    for (const context of ["phase", "discipline", "planningItem", "guide", "helpConversation"])
      if (params.has(context)) search.set(context, params.get(context)!);
    if (params.get("assistant") === "1") search.set("assistant", "1");
    if (selected) search.set("conversation", selected.id);
    return `/projects/${id}?${search}`;
  };
  const allModules = [
    "workspace",
    "location",
    "building-model",
    "fire-protection",
    "details",
    "sources",
    "inquiries",
    "noise",
    "feasibility",
    "knowledge",
    "analytics",
  ];
  const visibleModules =
    perspective === "nerd"
      ? allModules
      : [
          ...new Set([
            "overview",
            "workspace",
            "location",
            "building-model",
            "fire-protection",
            "sources",
            ...(perspective === "planner" ? ["inquiries"] : ["details"]),
            view,
          ]),
        ];
  const projectNavigation = (
    <nav className="workspace-view-links" aria-label={t("projectDetails")}>
      {visibleModules.map((key) => (
        <Link
          key={key}
          aria-current={view === key ? "page" : undefined}
          to={moduleLink(key)}
        >
          {key === "overview"
            ? t(
                perspective === "planner"
                  ? "planningPlannerOverview"
                  : "planningOverview",
              )
            : key === "workspace"
              ? t("workspaceConversation")
              : key === "location"
                ? t("locationEditor")
                : key === "building-model"
                  ? t("buildingModel")
                  : key === "fire-protection"
                    ? t("buildingFireProtection")
                    : key === "details"
                      ? t("projectDetails")
                      : key === "noise"
                        ? t("noiseNav")
                        : key === "feasibility"
                          ? t("feasibilityNav")
                          : t(key as "sources" | "inquiries")}
        </Link>
      ))}
      {perspective !== "nerd" && (
        <Link to={perspectiveLink("nerd")} className="project-all-modules">
          {t("planningAllModules")}
        </Link>
      )}
    </nav>
  );
  if (view === "sharedWork") {
    const next = new URLSearchParams(params);
    next.delete("view");
    next.set("panel", "tasks");
    return <Navigate replace to={`?${next}`} />;
  }
  return (
    <Page className="project-shell">
      <header className="project-bar">
        <Link to="/" className="project-bar-brand" aria-label="Richtfest">
          R
        </Link>
        <Link
          className="project-bar-back"
          to="/projects"
          aria-label={t("projects")}
        >
          ←<span className="project-bar-back-label"> {t("projects")}</span>
        </Link>
        <div className="project-bar-title">
          {project.data?.customerName && (
            <span className="project-bar-customer">
              {project.data.customerName}
            </span>
          )}
          <h1>{title}</h1>
          <Badge>{projectStatusLabel(details.status, t)}</Badge>
        </div>
        {perspectiveNavigation}
        <div className="project-bar-actions">
          {canUseAssistant && view !== "workspace" && (
            <Button
              ref={assistantTrigger}
              variant="outline"
              size="sm"
              aria-expanded={assistantOpen}
              aria-controls={assistantOpen ? "project-assistant" : undefined}
              onClick={() => {
                if (assistantOpen) closeAssistant();
                else {
                  const next = new URLSearchParams(params);
                  next.set("assistant", "1");
                  next.delete("guide");
                  setParams(next, { replace: true });
                }
              }}
            >
              <MessageCircle aria-hidden="true" />
              {t("projectAssistantAsk")}
            </Button>
          )}
          {meUser?.id && <AppUpdateButton className="h-control-sm" />}
          {meUser?.id && (
            <Link
              to="/settings/security"
              className="avatar"
              title={meUser.name}
              aria-label={meUser.name}
            >
              {meUser.name?.slice(0, 1) || "R"}
            </Link>
          )}
        </div>
      </header>
      <div className="project-module-bar">{projectNavigation}</div>
      <div key={view} className="project-module-content" data-view={view}>
        <LoadState query={project} />
        {view === "overview" && project.isSuccess && (
          <ProjectOverview
            projectId={id!}
            projectName={title}
            perspective={perspective === "planner" ? "planner" : "coordinator"}
          />
        )}
        {view === "location" && project.isSuccess && (
          <LocationMode projectId={id!} address={details} />
        )}
        {(view === "building-model" || view === "fire-protection") &&
          project.isSuccess && <BuildingModelMode projectId={id!} />}
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
                  mobileMenu={{
                    title,
                    subtitle:
                      mobilePanel === "resources"
                        ? t("workspaceResources")
                        : selected?.title || t("workspaceConversation"),
                    navigation: (
                      <>
                        <section>
                          <div className="flex items-center justify-between gap-stack">
                            <h2>{t("project")}</h2>
                            <Badge>
                              {projectStatusLabel(details.status, t)}
                            </Badge>
                          </div>
                          {perspectiveNavigation}
                          {projectNavigation}
                          <nav aria-label={t("workspaceResources")}>
                            <Link
                              to={`?${resourcesParams}`}
                              aria-current={
                                mobilePanel === "resources" ? "page" : undefined
                              }
                            >
                              {t("workspaceResources")}
                            </Link>
                          </nav>
                        </section>
                        <section>
                          <h2>{t("home")}</h2>
                          {workspaceNavigation}
                        </section>
                      </>
                    ),
                  }}
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
                    for (const key of [
                      "artifact",
                      "revision",
                      "file",
                      "sourceVersion",
                      "sourceSelection",
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
                    data-mobile-panel={mobilePanel}
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
                        sourceRef={sourceRef}
                        conversationId={selected.id}
                        conversationTitle={selected.title}
                        readState={selected.readState}
                        initialMessage={initialMessage}
                        onInitialMessageSent={() => {
                          setInitialMessage(undefined);
                          setInitialMessageDraft("");
                        }}
                        runs={list(workspace.data?.runs).filter(
                          (run) => run.conversationId === selected.id,
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
                                rows={1}
                                value={initialMessageDraft}
                                required
                                disabled={
                                  !workspace.isSuccess ||
                                  create.isPending ||
                                  initialMessage !== undefined
                                }
                                aria-label={t("message")}
                                placeholder={t(
                                  "workspaceUiComposerPlaceholder",
                                )}
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
        {view === "details" && !editingDetails && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                updateProject.reset();
                setEditingDetails(true);
              }}
            >
              {t("editProject")}
            </Button>
          </div>
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
                  leadId: values.leadId || null,
                  delegateId: values.delegateId || null,
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
              {(["lead", "delegate"] as const).map(role => (
                <Field key={role} label={t(role === "lead" ? "projectLead" : "projectDelegate")}>
                  <NativeSelect name={`${role}Id`} defaultValue={details[`${role}Id`] || ""}>
                    <option value="">{t("responsibilityUnassigned")}</option>
                    {list(details.responsibilityCandidates).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
                  </NativeSelect>
                </Field>
              ))}
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
                  <option value="completed">
                    {t("projectStatusCompleted")}
                  </option>
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
            <>
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
                {(["lead", "delegate"] as const).map(role => {
                  const userId = details[`${role}Id`];
                  return <Fragment key={role}><dt>{t(role === "lead" ? "projectLead" : "projectDelegate")}</dt><dd>{list(details.responsibilityCandidates).find(user => user.id === userId)?.name || t("responsibilityUnassigned")}</dd></Fragment>;
                })}
              </dl>
              {project.isSuccess && canWrite && (
                <div className="grid gap-stack border-t pt-3">
                  <div>
                    <strong className="text-ui-sm">{t("deleteProject")}</strong>
                    <p className="muted text-ui-sm">{t("deleteProjectHint")}</p>
                  </div>
                  <Dialog
                    open={deleteOpen}
                    onOpenChange={(next) => {
                      if (!deleteProject.isPending) {
                        setDeleteOpen(next);
                        if (!next) deleteProject.reset();
                      }
                    }}
                  >
                    <DialogTrigger asChild>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="w-fit"
                        aria-label={`${t("deleteProject")}: ${title}`}
                      >
                        {t("deleteProject")}
                      </Button>
                    </DialogTrigger>
                    <DialogContent showCloseButton={!deleteProject.isPending}>
                      <DialogHeader>
                        <DialogTitle>{t("deleteProject")}</DialogTitle>
                        <DialogDescription className="break-words">
                          {title}
                        </DialogDescription>
                      </DialogHeader>
                      <p className="text-ui-sm">{t("deleteProjectWarning")}</p>
                      {deleteProject.error && (
                        <Callout tone="error">
                          {deleteProject.error instanceof ApiError &&
                          deleteProject.error.code === "project_busy"
                            ? t("deleteProjectBusy")
                            : deleteProject.error instanceof ApiError &&
                                deleteProject.error.code ===
                                  "project_sources_in_use"
                              ? t("deleteProjectSourcesInUse")
                              : deleteProject.error.message}
                        </Callout>
                      )}
                      <DialogFooter>
                        <Button
                          variant="outline"
                          autoFocus
                          disabled={deleteProject.isPending}
                          onClick={() => setDeleteOpen(false)}
                        >
                          {t("cancel")}
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={deleteProject.isPending}
                          onClick={() => deleteProject.mutate()}
                        >
                          {deleteProject.isPending
                            ? t("deletingProject")
                            : t("deleteProject")}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              )}
            </>
          ))}
        {view === "sources" && (
          <Sources projectId={id!} initial={project.data || {}} />
        )}
        {view === "inquiries" && (
          <Inquiries projectId={id!} selectedId={params.get("inquiry")} />
        )}
        {view === "noise" && (
          <NoiseSources projectId={id!} selectedId={params.get("source")} />
        )}
        {view === "feasibility" && <Feasibility projectId={id!} />}
        {view === "knowledge" && <Knowledge projectId={id!} />}
      </div>
      {assistantOpen && canUseAssistant && project.isSuccess && (
        <ProjectAssistant
          key={id}
          projectId={id!}
          workspace={workspace}
          selected={
            selected?.archivedAt
              ? conversations.find((conversation) => !conversation.archivedAt)
              : selected
          }
          sourceRef={sourceRef}
          canWrite={permissions.includes("knowledge:write")}
          onSelect={(conversationId) => {
            const next = new URLSearchParams(params);
            next.set("conversation", conversationId);
            next.delete("message");
            next.delete("agentRun");
            setParams(next, { replace: true });
          }}
          onClose={closeAssistant}
        />
      )}
    </Page>
  );
}
