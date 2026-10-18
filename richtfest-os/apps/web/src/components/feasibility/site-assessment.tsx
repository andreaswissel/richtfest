import { useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  calculateSiteAssessment,
  siteAssessmentInputSchema,
  SITE_ASSESSMENT_CONSTRAINT_KEYS,
  SITE_ASSESSMENT_CHECK_KEYS,
  type SiteAssessmentInput,
  type LocationContext,
} from "@richtfest/shared";
import { api, ApiError } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input, Textarea } from "../ui/input";
import { Badge, Callout, Field, Modal, Segmented } from "../ui/primitives";
import "./site-assessment.css";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { Table, TableBody, TableCell, TableRow } from "../ui/table";
import { SiteCapacityVisual } from "./capacity-visual";
import { SiteReferencesPanel } from "./site-references-panel";
import { SiteEvidencePanel } from "./site-evidence-panel";
import { SiteDesignResult } from "./site-design-result";
import { SiteGeometryEditor } from "./site-geometry-editor";
import { createEmptySiteGeometryInput } from "@richtfest/shared/site-geometry-model";
import { BerlinContext } from "./berlin-context";

type Assessment = Omit<SiteAssessmentInput, "baseRevision"> & {
  revision: number;
  updatedAt: string | null;
};
type Response = { assessment: Assessment; canWrite: boolean };
type Evidence = SiteAssessmentInput["constraints"]["parcelArea"];

export function SiteAssessment({ projectId }: { projectId: string }) {
  const t = useT(),
    language = usePreferences((s) => s.language);
  const label = (key: string) =>
    t(`siteAssessment${key}` as Parameters<typeof t>[0]);
  const path = `/feasibility/projects/${projectId}/site-assessment`;
  const query = useApi(path),
    data = query.data as Response | undefined;
  const [draft, setDraft] = useState<Assessment>();
  const [geometryContext, setGeometryContext] =
    useState<LocationContext | null>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const [editor, setEditor] = useState<
    | { kind: "constraint"; key: keyof Assessment["constraints"] }
    | { kind: "check"; key: keyof Assessment["checks"] }
    | { kind: "fact"; key: keyof NonNullable<Assessment["planningFacts"]> }
  >();
  const [raw, setRaw] = useState<Record<string, string>>({});
  const openEditor = (value: NonNullable<typeof editor>) => {
    editorOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setEditor(value);
  };
  const assessment = draft ?? data?.assessment;
  const dirty = !!draft;
  const input = assessment && {
    baseRevision: assessment.revision,
    jurisdiction: assessment.jurisdiction,
    planningBasis: assessment.planningBasis,
    constraints: assessment.constraints,
    checks: assessment.checks,
    references: assessment.references,
    notes: assessment.notes,
    upside: assessment.upside,
    geometry: assessment.geometry,
    planningFacts: assessment.planningFacts,
    siteLocator: assessment.siteLocator,
    designRules: assessment.designRules,
  };
  const validation = input && siteAssessmentInputSchema.safeParse(input);
  const valid = validation?.success;
  const result = input && valid ? calculateSiteAssessment(input) : null;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    setDraft(undefined);
    setRaw({});
  }, [projectId]);
  useEffect(() => {
    if (!dirty) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  const save = useMutation({
    mutationFn: () => api<Response>(path, input, "PUT"),
    onSuccess: (response) => {
      queryClient.setQueryData([path], response);
      setDraft(undefined);
      setRaw({});
    },
  });
  if (query.isError)
    return <Callout tone="error">{(query.error as Error).message}</Callout>;
  if (!assessment || !data) return null;
  const disabled = !data.canWrite || save.isPending;
  const update = (change: Partial<Assessment>) =>
    setDraft({
      ...assessment,
      ...change,
      ...(change.references && assessment.planningBasis === "section34"
        ? {
            checks: {
              ...assessment.checks,
              planningBasis: {
                ...assessment.checks.planningBasis,
                status: "unresolved" as const,
              },
            },
          }
        : {}),
    });
  const format = (n: number | null) =>
    n === null || !Number.isFinite(n)
      ? "–"
      : `${n.toLocaleString(language === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: 2 })} m²`;
  const evidence = (
    key: string,
    value: Evidence,
    change: (v: Evidence) => void,
    scope = "baseline",
  ) => (
    <div className="site-evidence" key={key}>
      <Field label={label(key)}>
        <Input
          inputMode="decimal"
          disabled={disabled}
          aria-invalid={value.value !== null && !Number.isFinite(value.value)}
          value={
            raw[`${scope}:${key}`] ??
            (value.value === null
              ? ""
              : value.value.toLocaleString(
                  language === "de" ? "de-DE" : "en-GB",
                  { maximumFractionDigits: 10 },
                ))
          }
          onChange={(event) => {
            const text = event.target.value;
            setRaw((current) => ({ ...current, [`${scope}:${key}`]: text }));
            const pattern =
              language === "de"
                ? /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/
                : /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
            const next = !text.trim()
              ? null
              : !pattern.test(text.trim())
                ? NaN
                : Number(
                    language === "de"
                      ? text.replace(/\./g, "").replace(",", ".")
                      : text.replace(/,/g, ""),
                  );
            change({ ...value, value: next, reviewed: false });
          }}
        />
      </Field>
      <details className="site-evidence-detail" open>
        <summary className="text-ui-xs">
          <span>{label("ReviewEvidence")}</span>
          <Badge variant="outline">
            {validation &&
            !validation.success &&
            validation.error.issues.some((issue) => issue.path.includes(key))
              ? label("InvalidShort")
              : value.value === null || !value.source || !value.sourceDate
                ? label("MissingShort")
                : value.reviewed
                  ? label("Reviewed")
                  : label("Unreviewed")}
          </Badge>
        </summary>
        <div className="site-evidence-fields">
          <Field label={`${label(key)} · ${label("Source")}`}>
            <Input
              disabled={disabled}
              value={value.source}
              maxLength={2000}
              onChange={(event) =>
                change({
                  ...value,
                  source: event.target.value,
                  reviewed: false,
                })
              }
            />
          </Field>
          <Field label={`${label(key)} · ${label("Date")}`}>
            <Input
              type="date"
              disabled={disabled}
              value={value.sourceDate ?? ""}
              onChange={(event) =>
                change({
                  ...value,
                  sourceDate: event.target.value || null,
                  reviewed: false,
                })
              }
            />
          </Field>
          <div className="site-evidence-kind">
            <span className="text-ui-xs">{label("Kind")}</span>
            <Segmented
              value={value.kind}
              onChange={(kind) =>
                change({
                  ...value,
                  kind: kind as Evidence["kind"],
                  reviewed: false,
                })
              }
              items={["official", "calculated", "estimated", "assessment"].map(
                (kind) => ({ value: kind, label: label(kind), disabled }),
              )}
            />
          </div>
          <label className="site-review text-ui-xs">
            <Checkbox
              aria-label={`${label(key)} · ${label("Reviewed")}`}
              disabled={
                disabled ||
                !value.source.trim() ||
                !value.sourceDate ||
                value.value === null
              }
              checked={value.reviewed}
              onCheckedChange={(checked) =>
                change({ ...value, reviewed: checked === true })
              }
            />
            {label("Reviewed")}
          </label>
        </div>
      </details>
    </div>
  );
  const capacity = (
    value: NonNullable<ReturnType<typeof calculateSiteAssessment>["baseline"]>,
    title: string,
  ) => (
    <div>
      <h3 className="text-ui-sm font-medium">{title}</h3>
      <p className="text-ui-xs">
        {label("Explanation")
          .replace("{footprint}", format(value.footprint))
          .replace("{gf}", format(value.countableFloorArea))
          .replace("{unused}", format(value.unusedGfzCapacity))
          .replace(
            "{limits}",
            value.bindingConstraints.map((key) => label(key)).join(", "),
          )}
      </p>
      <dl className="feasibility-results">
        {(
          ["countableFloorArea", "grossFloorArea", "unusedGfzCapacity"] as const
        ).map((key) => (
          <div key={key}>
            <dt>{label(key)}</dt>
            <dd>{format(value[key])}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary className="text-ui-xs">{label("Limits")}</summary>
        <dl className="feasibility-results">
          {value.limits.map((limit) => (
            <div key={limit.id}>
              <dt>
                {label(limit.id)} · {label(limit.unit)}
                {value.bindingConstraints.includes(limit.id)
                  ? ` · ${label("Binding")}`
                  : ""}
              </dt>
              <dd>{format(limit.capacity)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
  return (
    <div className="feasibility site-assessment">
      {blocker.state === "blocked" && (
        <Modal title={t("feasibilityUnsaved")} onClose={() => blocker.reset()}>
          <p>{t("feasibilityUnsavedHint")}</p>
          <div className="inline-actions">
            <Button variant="outline" onClick={() => blocker.proceed()}>
              {t("locationLeave")}
            </Button>
            <Button onClick={() => blocker.reset()}>{t("locationStay")}</Button>
          </div>
        </Modal>
      )}
      <Section title={label("Basis")}>
        <div className="site-facts text-ui-xs">
          <span>
            {label("parcelArea")}:{" "}
            {assessment.constraints.parcelArea.value === null
              ? "–"
              : format(assessment.constraints.parcelArea.value)}
          </span>
          <Badge variant="outline">
            {result ? label(result.status) : label("InvalidShort")}
          </Badge>
          <span>
            {label("OpenItems").replace(
              "{count}",
              String(
                result?.missing.length ?? validation?.error?.issues.length ?? 0,
              ),
            )}
          </span>
        </div>
        <details className="site-scope text-ui-xs">
          <summary>{label("ScopeTitle")}</summary>
          <p className="muted">{label("Scope")}</p>
        </details>
        <a className="text-ui-xs underline" href="#site-assessment-result">
          {label("JumpToResult")}
        </a>
        <Segmented
          value={assessment.planningBasis}
          onChange={(planningBasis) =>
            update({
              planningBasis: planningBasis as Assessment["planningBasis"],
              checks: {
                ...assessment.checks,
                planningBasis: {
                  ...assessment.checks.planningBasis,
                  status: "unresolved",
                },
              },
            })
          }
          items={["b_plan", "section34", "unresolved"].map((value) => ({
            value,
            label: label(value),
            disabled,
          }))}
        />
      </Section>
      <details className="site-secondary">
        <summary className="text-ui-sm">{label("SourcesAndRules")}</summary>
        <SiteReferencesPanel
          projectId={projectId}
          disabled={disabled}
          siteLocator={assessment.siteLocator}
          references={assessment.references}
          onLocator={(siteLocator) => update({ siteLocator })}
          onReferences={(references) => update({ references })}
          onContext={setGeometryContext}
        />
        <SiteEvidencePanel
          projectId={projectId}
          disabled={disabled}
          onAdopt={(proposal) => {
            if (!proposal.constraint) return;
            const { key, value } = proposal.constraint;
            if (proposal.collection === "constraints") {
              update({
                constraints: { ...assessment.constraints, [key]: value },
              });
            } else
              update({
                planningFacts: { ...assessment.planningFacts, [key]: value },
              });
          }}
        />
        <BerlinContext
          siteLocator={assessment.siteLocator}
          projectId={projectId}
          disabled={disabled}
          onAdopt={(value, parcel) => {
            setRaw((current) => {
              const next = { ...current };
              delete next["baseline:parcelArea"];
              return next;
            });
            update({
              constraints: { ...assessment.constraints, parcelArea: value },
              geometry: {
                ...(assessment.geometry ?? createEmptySiteGeometryInput()),
                parcel: {
                  id: parcel.id,
                  label: parcel.label,
                  geometry: parcel.polygons,
                  source: parcel.sourceUrl,
                  sourceDate: parcel.sourceDate,
                  reviewed: false,
                },
                setbacks: [],
              },
            });
          }}
        />
        <details className="site-secondary">
          <summary className="text-ui-sm">{label("DesignRules")}</summary>
          {(() => {
            const rules = assessment.designRules ?? {
              maxHeight: null,
              heightNotSpecified: false,
              buildingForm: "unresolved" as const,
              source: "",
              sourceDate: null,
              reviewed: false,
            };
            const change = (patch: Partial<typeof rules>) =>
              update({ designRules: { ...rules, ...patch } });
            return (
              <div className="site-design-rules">
                <Field label={label("buildingForm")}>
                  <Segmented
                    value={rules.buildingForm}
                    onChange={(v) =>
                      change({
                        buildingForm: v as typeof rules.buildingForm,
                        reviewed: false,
                      })
                    }
                    items={["open", "closed", "deviating", "unresolved"].map(
                      (value) => ({ value, label: label(value), disabled }),
                    )}
                  />
                </Field>
                <Field label={label("MaxHeight")}>
                  <Input
                    type="number"
                    min={0.1}
                    step={0.1}
                    disabled={disabled || rules.heightNotSpecified}
                    value={rules.maxHeight ?? ""}
                    onChange={(e) =>
                      change({
                        maxHeight: Number.isFinite(e.target.valueAsNumber)
                          ? e.target.valueAsNumber
                          : null,
                        reviewed: false,
                      })
                    }
                  />
                </Field>
                <label className="site-review text-ui-xs">
                  <Checkbox
                    disabled={disabled}
                    checked={rules.heightNotSpecified}
                    onCheckedChange={(v) =>
                      change({
                        heightNotSpecified: v === true,
                        maxHeight: null,
                        reviewed: false,
                      })
                    }
                  />
                  {label("HeightNotSpecified")}
                </label>
                <Field label={label("Source")}>
                  <Input
                    disabled={disabled}
                    value={rules.source}
                    onChange={(e) =>
                      change({ source: e.target.value, reviewed: false })
                    }
                  />
                </Field>
                <Field label={label("Date")}>
                  <Input
                    type="date"
                    disabled={disabled}
                    value={rules.sourceDate ?? ""}
                    onChange={(e) =>
                      change({
                        sourceDate: e.target.value || null,
                        reviewed: false,
                      })
                    }
                  />
                </Field>
                <label className="site-review text-ui-xs">
                  <Checkbox
                    disabled={
                      disabled ||
                      !rules.source ||
                      !rules.sourceDate ||
                      rules.buildingForm === "unresolved" ||
                      (!rules.heightNotSpecified && !rules.maxHeight)
                    }
                    checked={rules.reviewed}
                    onCheckedChange={(v) => change({ reviewed: v === true })}
                  />
                  {label("Reviewed")}
                </label>
              </div>
            );
          })()}
        </details>
      </details>
      <SiteGeometryEditor
        onUseArea={(area) =>
          update({
            constraints: {
              ...assessment.constraints,
              buildableFootprint: {
                value: area,
                source: "berlin_geometry_v1 · draft geometry calculation",
                sourceDate: new Date().toISOString().slice(0, 10),
                kind: "calculated",
                reviewed: false,
              },
            },
          })
        }
        contextOverride={geometryContext}
        onReference={(building, context) => {
          if (assessment.references.some((r) => r.buildingId === building.id))
            return;
          update({
            references: [
              ...assessment.references,
              {
                id: crypto.randomUUID(),
                buildingId: building.id,
                label: building.label,
                source: context.sources.map((s) => s.url).join("; "),
                note: "",
                polygons: building.polygons.map((p) =>
                  p.map((r) =>
                    r.map(([x, z]) => [
                      x + context.origin[0],
                      context.origin[1] - z,
                    ]),
                  ),
                ),
              },
            ],
          });
        }}
        projectId={projectId}
        value={assessment.geometry ?? null}
        disabled={disabled}
        onChange={(geometry) => update({ geometry })}
        options={
          assessment.constraints.grz.value !== null &&
          assessment.constraints.gfz.value !== null &&
          assessment.constraints.maxFullStoreys.value !== null
            ? {
                grz: assessment.constraints.grz.value,
                gfz: assessment.constraints.gfz.value,
                maxFullStoreys: assessment.constraints.maxFullStoreys.value,
                storeyHeight: 3,
              }
            : null
        }
      />
      {input && <SiteDesignResult input={input} />}
      <SiteCapacityVisual
        result={result}
        onEdit={(key) => openEditor({ kind: "constraint", key })}
      />
      <Section title={label("Constraints")}>
        <Table className="site-constraint-table">
          <TableBody>
            {SITE_ASSESSMENT_CONSTRAINT_KEYS.map((key) => {
              const value = assessment.constraints[key];
              const status =
                validation &&
                !validation.success &&
                validation.error.issues.some((issue) =>
                  issue.path.includes(key),
                )
                  ? "InvalidShort"
                  : value.value === null || !value.source || !value.sourceDate
                    ? "MissingShort"
                    : value.reviewed
                      ? "Reviewed"
                      : "Unreviewed";
              return (
                <TableRow key={key}>
                  <TableCell>{label(key)}</TableCell>
                  <TableCell>
                    {value.value === null || !Number.isFinite(value.value)
                      ? "–"
                      : value.value.toLocaleString(
                          language === "de" ? "de-DE" : "en-GB",
                          { maximumFractionDigits: 2 },
                        )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{label(status)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${label(data.canWrite ? "Edit" : "ReviewEvidence")} ${label(key)}`}
                      onClick={() => openEditor({ kind: "constraint", key })}
                    >
                      {label(data.canWrite ? "Edit" : "View")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Section>
      <Section title={label("Checks")}>
        <Table className="site-constraint-table">
          <TableBody>
            {SITE_ASSESSMENT_CHECK_KEYS.map((key) => {
              const check = assessment.checks[key];
              return (
                <TableRow key={key}>
                  <TableCell>{label(key)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {label(
                        check.status === "unresolved" ||
                          !check.note ||
                          !check.source
                          ? "unresolved"
                          : check.status,
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${label(data.canWrite ? "Edit" : "ReviewEvidence")} ${label(key)}`}
                      onClick={() => openEditor({ kind: "check", key })}
                    >
                      {label(data.canWrite ? "Edit" : "View")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Section>
      <details className="site-secondary">
        <summary className="text-ui-sm">{label("PlanningFacts")}</summary>
        <Table>
          <TableBody>
            {(
              [
                "landUse",
                "buildingForm",
                "roofForm",
                "heightRule",
                "encroachments",
              ] as const
            ).map((key) => (
              <TableRow key={key}>
                <TableCell>{label(key)}</TableCell>
                <TableCell>
                  {assessment.planningFacts?.[key]?.value || "–"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {label(
                      assessment.planningFacts?.[key]?.reviewed
                        ? "Reviewed"
                        : "Unreviewed",
                    )}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openEditor({ kind: "fact", key })}
                  >
                    {label(data.canWrite ? "Edit" : "View")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>
      <Dialog
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(undefined);
        }}
      >
        <DialogContent
          className="site-editor-panel"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editorOpener.current?.focus();
          }}
        >
          <DialogTitle>{editor ? label(editor.key) : ""}</DialogTitle>
          <DialogDescription>{label("PanelHint")}</DialogDescription>
          {editor?.kind === "constraint" &&
            evidence(editor.key, assessment.constraints[editor.key], (value) =>
              update({
                constraints: { ...assessment.constraints, [editor.key]: value },
              }),
            )}
          {editor?.kind === "fact" &&
            (() => {
              const fact = assessment.planningFacts?.[editor.key] ?? {
                value: "",
                source: "",
                sourceDate: null,
                kind: "assessment" as const,
                reviewed: false,
              };
              const change = (patch: Partial<typeof fact>) =>
                update({
                  planningFacts: {
                    ...assessment.planningFacts,
                    [editor.key]: { ...fact, ...patch },
                  },
                });
              return (
                <>
                  <Field label={label(editor.key)}>
                    <Textarea
                      disabled={disabled}
                      value={fact.value}
                      onChange={(e) =>
                        change({ value: e.target.value, reviewed: false })
                      }
                    />
                  </Field>
                  <Field label={label("Source")}>
                    <Input
                      disabled={disabled}
                      value={fact.source}
                      onChange={(e) =>
                        change({ source: e.target.value, reviewed: false })
                      }
                    />
                  </Field>
                  <Field label={label("Date")}>
                    <Input
                      type="date"
                      disabled={disabled}
                      value={fact.sourceDate ?? ""}
                      onChange={(e) =>
                        change({
                          sourceDate: e.target.value || null,
                          reviewed: false,
                        })
                      }
                    />
                  </Field>
                  <label className="site-review text-ui-xs">
                    <Checkbox
                      disabled={
                        disabled ||
                        !fact.source ||
                        !fact.sourceDate ||
                        !fact.value
                      }
                      checked={fact.reviewed}
                      onCheckedChange={(v) => change({ reviewed: v === true })}
                    />
                    {label("Reviewed")}
                  </label>
                </>
              );
            })()}
          {editor?.kind === "check" &&
            (() => {
              const check = assessment.checks[editor.key];
              const change = (patch: Partial<typeof check>) =>
                update({
                  checks: {
                    ...assessment.checks,
                    [editor.key]: { ...check, ...patch },
                  },
                });
              return (
                <div className="site-check-fields">
                  <Segmented
                    value={check.status}
                    onChange={(status) =>
                      change({ status: status as typeof check.status })
                    }
                    items={["unresolved", "confirmed", "not_applicable"].map(
                      (value) => ({ value, label: label(value), disabled }),
                    )}
                  />
                  <Field label={`${label(editor.key)} · ${label("Source")}`}>
                    <Input
                      disabled={disabled}
                      value={check.source}
                      onChange={(event) =>
                        change({
                          source: event.target.value,
                          status: "unresolved",
                        })
                      }
                    />
                  </Field>
                  <Field label={`${label(editor.key)} · ${label("Note")}`}>
                    <Textarea
                      rows={2}
                      disabled={disabled}
                      value={check.note}
                      onChange={(event) =>
                        change({
                          note: event.target.value,
                          status: "unresolved",
                        })
                      }
                    />
                  </Field>
                </div>
              );
            })()}
          <Button variant="outline" onClick={() => setEditor(undefined)}>
            {label("Done")}
          </Button>
        </DialogContent>
      </Dialog>
      <details className="site-secondary">
        <summary className="text-ui-sm">
          {label("References")} · {assessment.references.length}
        </summary>
        <Section title={label("References")}>
          <div className="site-checks">
            {assessment.references.map((reference, index) => {
              const change = (patch: Partial<typeof reference>) =>
                update({
                  references: assessment.references.map((item, i) =>
                    i === index ? { ...item, ...patch } : item,
                  ),
                });
              return (
                <div className="site-check" key={reference.id}>
                  <Field label={label("ReferenceLabel")}>
                    <Input
                      value={reference.label}
                      disabled={disabled}
                      onChange={(event) =>
                        change({ label: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={label("Source")}>
                    <Input
                      value={reference.source}
                      disabled={disabled}
                      onChange={(event) =>
                        change({ source: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={label("Note")}>
                    <Textarea
                      rows={2}
                      value={reference.note}
                      disabled={disabled}
                      onChange={(event) => change({ note: event.target.value })}
                    />
                  </Field>
                  {data.canWrite && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        update({
                          references: assessment.references.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    >
                      {label("Remove")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {data.canWrite && (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                update({
                  references: [
                    ...assessment.references,
                    {
                      id: crypto.randomUUID(),
                      label: "",
                      source: "",
                      note: "",
                    },
                  ],
                })
              }
            >
              {label("AddReference")}
            </Button>
          )}
        </Section>
      </details>
      <details className="site-secondary">
        <summary className="text-ui-sm">{label("Upside")}</summary>
        <Section title={label("Upside")}>
          <label className="site-review text-ui-xs">
            <Checkbox
              checked={!!assessment.upside}
              disabled={disabled}
              onCheckedChange={(checked) =>
                update({
                  upside: checked
                    ? {
                        maxFullStoreys: {
                          ...assessment.constraints.maxFullStoreys,
                          reviewed: false,
                        },
                        note: "",
                      }
                    : null,
                })
              }
            />
            {label("EnableUpside")}
          </label>
          {assessment.upside && (
            <>
              {evidence(
                "maxFullStoreys",
                assessment.upside.maxFullStoreys,
                (maxFullStoreys) =>
                  update({ upside: { ...assessment.upside!, maxFullStoreys } }),
                "upside",
              )}
              <Field label={label("Note")}>
                <Textarea
                  rows={2}
                  disabled={disabled}
                  value={assessment.upside.note}
                  onChange={(event) =>
                    update({
                      upside: {
                        ...assessment.upside!,
                        note: event.target.value,
                      },
                    })
                  }
                />
              </Field>
            </>
          )}
        </Section>
      </details>
      <details className="site-secondary">
        <summary className="text-ui-sm">{t("feasibilityNotes")}</summary>
        <Field label={t("feasibilityNotes")}>
          <Textarea
            rows={3}
            disabled={disabled}
            value={assessment.notes}
            onChange={(event) => update({ notes: event.target.value })}
          />
        </Field>
      </details>
      <div id="site-assessment-result">
        <Section title={label("Result")}>
          {save.error && (
            <Callout tone="error">
              {save.error instanceof ApiError && save.error.status === 409
                ? t("feasibilityConflict")
                : save.error.message}
            </Callout>
          )}
          {dirty && data.assessment.revision !== assessment.revision && (
            <Callout>{t("feasibilityConflict")}</Callout>
          )}
          {!valid && <Callout tone="error">{label("Invalid")}</Callout>}
          {result && (
            <>
              <Badge variant="outline">{label(result.status)}</Badge>
              {result.missing.length > 0 && (
                <Callout>
                  {label("Missing")}:{" "}
                  {result.missing
                    .map((key) => {
                      const parts = key.split(".");
                      if (parts[0] === "references")
                        return `${label("References")}${parts[1] ? ` ${Number(parts[1]) + 1}` : ""}`;
                      return `${label(parts.length > 1 ? parts[1]! : key)}${parts[2] === "evidence" ? ` · ${label("Reviewed")}` : ""}`;
                    })
                    .join(", ")}
                </Callout>
              )}
              {result.baseline && capacity(result.baseline, label("Baseline"))}
              {result.upside && (
                <>
                  <Badge variant="outline">{label("indicative")}</Badge>
                  {capacity(result.upside, label("Upside"))}
                </>
              )}
              {result.limitations.map((code) => (
                <p key={code} className="muted text-ui-xs">
                  {label(code)}
                </p>
              ))}
            </>
          )}
        </Section>
      </div>
      <div className="site-save-bar">
        <Button
          size="sm"
          variant="outline"
          disabled={dirty || !assessment.revision || save.isPending}
          onClick={() => {
            const a = document.createElement("a");
            a.href = `/api${path}/report.pdf?lang=${language}`;
            a.download = "";
            a.click();
          }}
        >
          {t("feasibilityReport")}
        </Button>
        <span className="muted text-ui-2xs">
          {dirty
            ? t("feasibilityUnsaved")
            : assessment.revision
              ? `r${assessment.revision} · ${t("feasibilitySaved")}`
              : t("feasibilityNew")}
        </span>
        {data.canWrite && (
          <Button
            size="sm"
            disabled={!dirty || !valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t("saving") : label("Save")}
          </Button>
        )}
      </div>
    </div>
  );
}
