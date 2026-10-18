import { useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  projectPhaseKeys,
  planningDisciplineKeys,
  planningModuleKeys,
  planningStatusKeys,
  planningKindKeys,
  projectPlanningInput,
  type ProjectPlanning,
  type ProjectPlanningItem,
  type ProjectPhase,
  type PlanningDiscipline,
} from "@richtfest/shared";
import { api, ApiError } from "../../api";
import { useT } from "../../i18n";
import { PageHeader, Section } from "../layout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { NativeSelect } from "../ui/native-select";
import {
  Badge,
  Callout,
  Field,
  Modal,
  RowLink,
  Segmented,
  Table,
} from "../ui/primitives";
import "./project-overview.css";

const labels = {
  plot: "planningPlot",
  brief: "planningBrief",
  concept: "planningConcept",
  design: "planningDesign",
  permit: "planningPermit",
  execution: "planningExecution",
  tender: "planningTender",
  handoff: "planningHandoff",
  coordination: "planningCoordination",
  architecture: "planningArchitecture",
  structure: "planningStructure",
  services: "planningServices",
  physics: "planningPhysics",
  fire: "planningFire",
  open: "planningOpen",
  in_progress: "planningInProgress",
  blocked: "planningBlocked",
  in_review: "planningInReview",
  done: "planningDone",
  deliverable: "planningDeliverable",
  decision: "planningDecision",
  milestone: "planningMilestone",
  workspace: "planningWorkspace",
  location: "planningLocation",
  "building-model": "planningBuildingModel",
  details: "planningDetails",
  sources: "planningSources",
  inquiries: "planningInquiries",
  noise: "planningNoise",
  feasibility: "planningFeasibility",
  knowledge: "planningKnowledge",
  analytics: "planningAnalytics",
} as const;

export function ProjectOverview({
  projectId,
  projectName,
  perspective,
}: {
  projectId: string;
  projectName: string;
  perspective: "coordinator" | "planner";
}) {
  // Remount local drafts when navigating between projects; never submit a previous project's snapshot.
  return (
    <Overview
      key={projectId}
      projectId={projectId}
      projectName={projectName}
      perspective={perspective}
    />
  );
}

function Overview({
  projectId,
  projectName,
  perspective,
}: {
  projectId: string;
  projectName: string;
  perspective: "coordinator" | "planner";
}) {
  const t = useT();
  const label = (key: keyof typeof labels) => t(labels[key]);
  const client = useQueryClient();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const path = `/projects/${encodeURIComponent(projectId)}/planning`;
  const plan = useQuery({
    queryKey: [path],
    queryFn: () => api<ProjectPlanning>(path),
    staleTime: 30_000,
  });
  const me = useQuery({
    queryKey: ["/auth/me"],
    queryFn: () =>
      api<{ permissions?: string[]; user?: { permissions?: string[] } }>(
        "/auth/me",
      ),
    staleTime: 30_000,
  });
  const writable =
    !me.isError &&
    (me.data?.permissions ?? me.data?.user?.permissions ?? []).includes(
      "projects:write",
    );
  const phaseParam = params.get("phase");
  const phase = projectPhaseKeys.includes(phaseParam as ProjectPhase)
    ? (phaseParam as ProjectPhase)
    : (plan.data?.currentPhase ?? "plot");
  const domainParam = params.get("discipline");
  const discipline = planningDisciplineKeys.includes(
    domainParam as PlanningDiscipline,
  )
    ? (domainParam as PlanningDiscipline)
    : "physics";
  const filter = params.get("planningFilter") || "all";
  const [editor, setEditor] = useState<{
    snapshot: ProjectPlanning;
    item: ProjectPlanningItem | null;
    currentPhase: ProjectPhase | null;
  } | null>(null);
  const [error, setError] = useState<
    "planningInvalid" | "planningConflict" | "planningSaveError" | null
  >(null);
  const url = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    next.set("perspective", perspective);
    if (!next.has("phase")) next.set("phase", phase);
    if (!next.has("discipline")) next.set("discipline", discipline);
    for (const [key, value] of Object.entries(changes))
      value === null ? next.delete(key) : next.set(key, value);
    return `${location.pathname}?${next}`;
  };
  const switchScope = (key: string, value: string) => {
    // History can commit before React finishes its transition. Read it at the
    // input event so rapid phase/discipline changes compose with the latest URL.
    const next = new URLSearchParams(window.location.search);
    next.set(key, value);
    next.delete("planningItem");
    setParams(next);
  };
  const scoped = (plan.data?.items ?? []).filter(
    (item) => !item.archived && item.phase === phase,
  );
  const domainItems = scoped.filter((item) => item.discipline === discipline);
  const metrics = perspective === "planner" ? domainItems : scoped;
  const visible = domainItems.filter(
    (item) =>
      filter === "all" ||
      (filter === "review"
        ? item.status === "in_review"
        : item.status !== "done"),
  );
  const selected =
    visible.find((item) => item.id === params.get("planningItem")) ??
    (!params.has("planningItem") ? visible[0] : undefined);
  const byId = new Map((plan.data?.items ?? []).map((item) => [item.id, item]));
  const write = useMutation({
    mutationFn: (body: unknown) => api<ProjectPlanning>(path, body, "PUT"),
    onSuccess: (data) => {
      client.setQueryData([path], data);
      setEditor(null);
      setError(null);
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError && cause.status === 409
          ? "planningConflict"
          : "planningSaveError",
      ),
  });
  const openEditor = (
    item: ProjectPlanningItem | null,
    changePhase = false,
  ) => {
    if (!plan.data || !writable) return;
    setError(null);
    setEditor({
      snapshot: structuredClone(plan.data),
      currentPhase: plan.data.currentPhase,
      item: changePhase
        ? null
        : structuredClone(
            item ?? {
              id: crypto.randomUUID(),
              title: "",
              phase,
              discipline,
              kind: "deliverable",
              status: "open",
              owner: "",
              dueDate: null,
              notes: "",
              module: "workspace",
              dependsOn: [],
              archived: false,
            },
          ),
    });
  };
  const save = () => {
    if (!editor || !writable || write.isPending || error === "planningConflict")
      return;
    const item = editor.item && {
      ...editor.item,
      title:
        editor.item.title.trim() ||
        `${label(editor.item.phase)} · ${label(editor.item.discipline)} · ${label(editor.item.kind)}`,
    };
    const items = item
      ? [
          ...editor.snapshot.items.filter(
            (existing) => existing.id !== item.id,
          ),
          item,
        ]
      : editor.snapshot.items;
    const checked = projectPlanningInput.safeParse({
      expectedRevision: editor.snapshot.revision,
      currentPhase: editor.currentPhase,
      items,
    });
    if (!checked.success) {
      setError("planningInvalid");
      return;
    }
    setError(null);
    write.mutate(checked.data);
  };
  const dateLabel = (value: string | null) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      return t("planningUnassigned");
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
      ? t("planningUnassigned")
      : value;
  };
  const itemLink = (item: ProjectPlanningItem) => (
    <Link
      to={url({
        phase: item.phase,
        discipline: item.discipline,
        planningItem: item.id,
        planningFilter: null,
        view: "overview",
      })}
    >
      {item.title}
    </Link>
  );
  const itemList = (items: ProjectPlanningItem[]) =>
    items.length ? (
      <ul className="planning-list">
        {items.map((item) => (
          <li key={item.id}>
            <div>
              {itemLink(item)}{" "}
              <Badge variant="secondary">{label(item.status)}</Badge>
            </div>
            <div className="muted text-ui-xs">
              {label(item.discipline)} · {dateLabel(item.dueDate)} ·{" "}
              {item.owner || t("planningUnassigned")}
            </div>
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted">{t("planningEmpty")}</p>
    );
  const dependencies = (items: ProjectPlanningItem[]) => {
    const edges = items.flatMap((item) =>
      item.dependsOn.map((id) => ({ item, prerequisite: byId.get(id), id })),
    );
    return edges.length ? (
      <ul className="planning-list">
        {edges.map(({ item, prerequisite, id }) => (
          <li key={`${item.id}-${id}`}>
            <div>{itemLink(item)}</div>
            <div className="muted text-ui-xs">{t("planningRequires")}</div>
            {prerequisite ? (
              <>
                {itemLink(prerequisite)}{" "}
                <Badge variant="secondary">{label(prerequisite.status)}</Badge>
                <div className="muted text-ui-xs">
                  {label(prerequisite.phase)}
                  {prerequisite.archived ? ` · ${t("planningArchived")}` : ""}
                </div>
              </>
            ) : (
              t("planningMissingDependency")
            )}
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted">{t("planningNoDependencies")}</p>
    );
  };
  return (
    <div className="project-overview text-ui">
      <div className="planning-content">
        <PageHeader
          eyebrow={projectName}
          title={t(
            perspective === "coordinator"
              ? "planningOverview"
              : "planningPlannerOverview",
          )}
          actions={
            writable && plan.data ? (
              <Button onClick={() => openEditor(null)}>
                {t("planningAdd")}
              </Button>
            ) : undefined
          }
        />
        <nav className="planning-phases" aria-label={t("planningPhase")}>
          {projectPhaseKeys.map((key, index) => (
            <Link
              key={key}
              aria-current={phase === key ? "step" : undefined}
              to={url({ phase: key, planningItem: null })}
            >
              <span className="text-ui-xs muted">
                {index > 0 && index < 7
                  ? `LP ${index === 6 ? "6–7" : index}`
                  : index === 0
                    ? t("planningBeforeProject")
                    : t("planningMilestone")}
              </span>
              <strong>{label(key)}</strong>
            </Link>
          ))}
        </nav>
        <div className="planning-context">
          <span>
            {t("planningCurrentPhase")}:{" "}
            <strong>
              {plan.data?.currentPhase
                ? label(plan.data.currentPhase)
                : t("planningNotSet")}
            </strong>
          </span>
          {writable && plan.data && (
            <Button variant="outline" onClick={() => openEditor(null, true)}>
              {t("planningChangePhase")}
            </Button>
          )}
          <Field label={t("planningDiscipline")}>
            <NativeSelect
              value={discipline}
              onChange={(event) =>
                switchScope("discipline", event.target.value)
              }
            >
              {planningDisciplineKeys.map((key) => (
                <option key={key} value={key}>
                  {label(key)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        {plan.isPending ? (
          <p role="status">{t("planningLoading")}</p>
        ) : plan.isError ? (
          <Callout tone="error">
            {t("planningLoadError")}{" "}
            <Button variant="outline" onClick={() => void plan.refetch()}>
              {t("planningReload")}
            </Button>
          </Callout>
        ) : (
          <>
            <div className="planning-metrics">
              {(
                [
                  ["planningEntries", metrics.length],
                  [
                    "planningOpen",
                    metrics.filter((item) => item.status !== "done").length,
                  ],
                  [
                    "planningBlocked",
                    metrics.filter((item) => item.status === "blocked").length,
                  ],
                  [
                    "planningInReview",
                    metrics.filter((item) => item.status === "in_review")
                      .length,
                  ],
                ] as const
              ).map(([key, value]) => (
                <div key={key} className="metric-card">
                  <span>{t(key)}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            {!metrics.length && <Callout>{t("planningEmpty")}</Callout>}
            {perspective === "planner" && (
              <div className="planning-workbenches">
                {(["location", "building-model"] as const).map((module) => (
                  <Link key={module} to={url({ view: module })}>
                    <strong>{label(module)}</strong>
                    <span className="muted text-ui-sm">
                      {t(
                        module === "location"
                          ? "planningLocationHint"
                          : "planningModelHint",
                      )}
                    </span>
                  </Link>
                ))}
              </div>
            )}
            <div className="planning-grid">
              <div>
                {perspective === "coordinator" && (
                  <Section title={t("planningDisciplines")}>
                    <Table
                      headers={[
                        t("planningDiscipline"),
                        t("planningEntries"),
                        t("planningOpen"),
                        t("planningInReview"),
                      ]}
                      rows={planningDisciplineKeys.map((key) => {
                        const items = scoped.filter(
                          (item) => item.discipline === key,
                        );
                        return {
                          id: key,
                          cells: [
                            <span
                              aria-current={
                                discipline === key ? "true" : undefined
                              }
                            >
                              <RowLink
                                to={url({
                                  discipline: key,
                                  planningItem: null,
                                })}
                              >
                                {label(key)}
                              </RowLink>
                            </span>,
                            items.length,
                            items.filter((item) => item.status !== "done")
                              .length,
                            items.filter((item) => item.status === "in_review")
                              .length,
                          ],
                        };
                      })}
                    />
                  </Section>
                )}
                <Section
                  title={`${t("planningPackages")} · ${label(discipline)}`}
                  meta={
                    <Segmented
                      value={filter}
                      onChange={(value) => switchScope("planningFilter", value)}
                      items={[
                        { value: "all", label: t("planningAll") },
                        { value: "open", label: t("planningOpen") },
                        { value: "review", label: t("planningInReview") },
                      ]}
                    />
                  }
                >
                  {visible.length ? (
                    <Table
                      headers={[
                        t("planningTitle"),
                        t("planningKind"),
                        t("planningStatus"),
                        t("planningOwner"),
                        t("planningDate"),
                      ]}
                      rows={visible.map((item) => ({
                        id: item.id,
                        cells: [
                          <span
                            aria-current={
                              selected?.id === item.id ? "true" : undefined
                            }
                          >
                            <RowLink to={url({ planningItem: item.id })}>
                              {item.title}
                            </RowLink>
                          </span>,
                          label(item.kind),
                          <Badge variant="secondary">
                            {label(item.status)}
                          </Badge>,
                          item.owner || t("planningUnassigned"),
                          dateLabel(item.dueDate),
                        ],
                      }))}
                    />
                  ) : (
                    <p className="muted">{t("planningEmpty")}</p>
                  )}
                </Section>
                <Section title={t("planningDependencies")}>
                  {dependencies(metrics)}
                </Section>
              </div>
              <aside className="planning-sidebar">
                <Section title={selected?.title ?? label(discipline)}>
                  {selected ? (
                    <>
                      <Badge variant="secondary">
                        {label(selected.status)}
                      </Badge>
                      <dl className="planning-facts">
                        <dt>{t("planningKind")}</dt>
                        <dd>{label(selected.kind)}</dd>
                        <dt>{t("planningOwner")}</dt>
                        <dd>{selected.owner || t("planningUnassigned")}</dd>
                        <dt>{t("planningDate")}</dt>
                        <dd>{dateLabel(selected.dueDate)}</dd>
                      </dl>
                      {selected.notes && (
                        <p className="planning-notes">{selected.notes}</p>
                      )}
                      {planningModuleKeys.includes(selected.module) && (
                        <Button asChild variant="outline">
                          <Link to={url({ view: selected.module })}>
                            {t("planningOpenModule").replace(
                              "{module}",
                              label(selected.module),
                            )}
                          </Link>
                        </Button>
                      )}
                      {writable && (
                        <Button
                          variant="outline"
                          onClick={() => openEditor(selected)}
                        >
                          {t("planningEdit")}
                        </Button>
                      )}
                      {dependencies([selected])}
                    </>
                  ) : (
                    itemList(domainItems)
                  )}
                </Section>
                <Section title={t("planningDecisions")}>
                  {itemList(metrics.filter((item) => item.kind === "decision"))}
                </Section>
                <Section title={t("planningMilestones")}>
                  {itemList(
                    metrics
                      .filter((item) => item.kind === "milestone")
                      .sort((a, b) =>
                        (a.dueDate ?? "9999").localeCompare(
                          b.dueDate ?? "9999",
                        ),
                      ),
                  )}
                </Section>
              </aside>
            </div>
            <Callout>{t("planningNotApproval")}</Callout>
            {writable &&
              plan.data?.items.some(
                (item) =>
                  item.archived &&
                  item.phase === phase &&
                  item.discipline === discipline,
              ) && (
                <details>
                  <summary>{t("planningArchived")}</summary>
                  {plan.data.items
                    .filter(
                      (item) =>
                        item.archived &&
                        item.phase === phase &&
                        item.discipline === discipline,
                    )
                    .map((item) => (
                      <div key={item.id}>
                        <span>{item.title}</span>{" "}
                        <Button
                          variant="outline"
                          onClick={() => openEditor(item)}
                        >
                          {t("planningEdit")}
                        </Button>
                      </div>
                    ))}
                </details>
              )}
          </>
        )}
        {editor && (
          <Modal
            title={t(editor.item ? "planningEdit" : "planningChangePhase")}
            onClose={() => {
              if (!write.isPending) setEditor(null);
            }}
            wide
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
              className="planning-form"
            >
              <fieldset
                className="planning-form-content"
                disabled={write.isPending}
              >
                {editor.item ? (
                  <>
                    <Field label={t("planningTitleOptional")}>
                      <Input
                        value={editor.item.title}
                        maxLength={200}
                        placeholder={`${label(editor.item.phase)} · ${label(editor.item.discipline)} · ${label(editor.item.kind)}`}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            item: {
                              ...editor.item!,
                              title: event.target.value,
                            },
                          })
                        }
                      />
                    </Field>
                    <div className="planning-fields">
                      {(
                        [
                          ["phase", "planningPhase", projectPhaseKeys],
                          [
                            "discipline",
                            "planningDiscipline",
                            planningDisciplineKeys,
                          ],
                          ["kind", "planningKind", planningKindKeys],
                          ["status", "planningStatus", planningStatusKeys],
                          ["module", "planningModule", planningModuleKeys],
                        ] as const
                      ).map(([field, key, values]) => (
                        <Field key={field} label={t(key)}>
                          <NativeSelect
                            value={editor.item![field]}
                            onChange={(event) =>
                              setEditor({
                                ...editor,
                                item: {
                                  ...editor.item!,
                                  [field]: event.target.value,
                                },
                              })
                            }
                          >
                            {values.map((value) => (
                              <option key={value} value={value}>
                                {label(value)}
                              </option>
                            ))}
                          </NativeSelect>
                        </Field>
                      ))}
                      <Field label={t("planningOwner")}>
                        <Input
                          value={editor.item.owner}
                          maxLength={200}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              item: {
                                ...editor.item!,
                                owner: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                      <Field label={t("planningDate")}>
                        <Input
                          type="date"
                          value={editor.item.dueDate ?? ""}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              item: {
                                ...editor.item!,
                                dueDate: event.target.value || null,
                              },
                            })
                          }
                        />
                      </Field>
                    </div>
                    <Field label={t("planningNotes")}>
                      <Textarea
                        value={editor.item.notes}
                        maxLength={10000}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            item: {
                              ...editor.item!,
                              notes: event.target.value,
                            },
                          })
                        }
                      />
                    </Field>
                    <fieldset>
                      <legend>{t("planningDependencies")}</legend>
                      <div className="planning-dependency-options">
                        {editor.snapshot.items
                          .filter(
                            (item) =>
                              item.id !== editor.item!.id &&
                              (!item.archived ||
                                editor.item!.dependsOn.includes(item.id)),
                          )
                          .map((item) => (
                            <label key={item.id}>
                              <Checkbox
                                checked={editor.item!.dependsOn.includes(
                                  item.id,
                                )}
                                onCheckedChange={(checked) =>
                                  setEditor({
                                    ...editor,
                                    item: {
                                      ...editor.item!,
                                      dependsOn:
                                        checked === true
                                          ? [...editor.item!.dependsOn, item.id]
                                          : editor.item!.dependsOn.filter(
                                              (id) => id !== item.id,
                                            ),
                                    },
                                  })
                                }
                              />{" "}
                              {item.title} · {label(item.phase)}
                              {item.archived
                                ? ` · ${t("planningArchived")}`
                                : ""}
                            </label>
                          ))}
                      </div>
                    </fieldset>
                    <label>
                      <Checkbox
                        checked={editor.item.archived}
                        onCheckedChange={(checked) =>
                          setEditor({
                            ...editor,
                            item: {
                              ...editor.item!,
                              archived: checked === true,
                            },
                          })
                        }
                      />{" "}
                      {t("planningArchived")}
                    </label>
                  </>
                ) : (
                  <>
                    <Callout>{t("planningPhaseConfirmation")}</Callout>
                    <Field label={t("planningCurrentPhase")}>
                      <NativeSelect
                        value={editor.currentPhase ?? "_none"}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            currentPhase:
                              event.target.value === "_none"
                                ? null
                                : (event.target.value as ProjectPhase),
                          })
                        }
                      >
                        <option value="_none">{t("planningNotSet")}</option>
                        {projectPhaseKeys.map((key) => (
                          <option key={key} value={key}>
                            {label(key)}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  </>
                )}
                {error && <Callout tone="error">{t(error)}</Callout>}
                {error === "planningConflict" && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={plan.isFetching}
                    onClick={async () => {
                      const result = await plan.refetch();
                      if (result.isSuccess) {
                        setEditor(null);
                        setError(null);
                      }
                    }}
                  >
                    {t("planningDiscardReload")}
                  </Button>
                )}
                <div className="planning-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={write.isPending}
                    onClick={() => setEditor(null)}
                  >
                    {t("planningCancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      !writable ||
                      write.isPending ||
                      error === "planningConflict"
                    }
                  >
                    {t(write.isPending ? "planningSaving" : "planningSave")}
                  </Button>
                </div>
              </fieldset>
            </form>
          </Modal>
        )}
      </div>
    </div>
  );
}
