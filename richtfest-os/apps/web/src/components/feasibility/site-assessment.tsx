import { useEffect, useMemo, useState } from "react";
import { Link, useBlocker } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Download, Save } from "lucide-react";
import {
  calculateSiteAssessment,
  siteAssessmentInputSchema,
  SITE_ASSESSMENT_CONSTRAINT_KEYS,
  SITE_ASSESSMENT_CHECK_KEYS,
  type SiteAssessmentInput,
  type LocationContext,
} from "@richtfest/shared";
import type { SiteDesignResult as DesignResult } from "@richtfest/shared/site-design";
import { createEmptySiteGeometryInput } from "@richtfest/shared/site-geometry-model";
import { api, ApiError } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/input";
import { Badge, Callout, Field, Modal, Segmented } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import "./site-assessment.css";
import { SiteCapacityVisual } from "./capacity-visual";
import { SiteReferencesPanel } from "./site-references-panel";
import { SiteEvidencePanel } from "./site-evidence-panel";
import { SiteDesignResult } from "./site-design-result";
import { SiteGeometryEditor } from "./site-geometry-editor";
import { BerlinContext } from "./berlin-context";
import { EMPTY_RULES, EvidenceEditor, ReviewStatusBadge, SiteReviewPanel, evidenceStatus, type ReviewItem } from "./site-review-panel";

type Assessment = Omit<SiteAssessmentInput, "baseRevision"> & { revision: number; updatedAt: string | null };
type Response = { assessment: Assessment; canWrite: boolean };
type Step = "site" | "limits" | "design" | "result";
const FACT_KEYS = ["landUse", "buildingForm", "roofForm", "heightRule", "encroachments"] as const;
const REVIEW_ITEMS: ReviewItem[] = [
  ...SITE_ASSESSMENT_CONSTRAINT_KEYS.map((key) => ({ kind: "constraint" as const, key })),
  ...SITE_ASSESSMENT_CHECK_KEYS.map((key) => ({ kind: "check" as const, key })),
  { kind: "rules", key: "designRules" },
  ...FACT_KEYS.map((key) => ({ kind: "fact" as const, key })),
];

/** The combined design check needs the geometry engine; load it only when the assessment has geometry. */
function useSiteDesign(input: SiteAssessmentInput | undefined) {
  const [calculate, setCalculate] = useState<(input: SiteAssessmentInput) => DesignResult>();
  const needed = !!input?.geometry;
  useEffect(() => {
    if (needed && !calculate) void import("@richtfest/shared/site-design").then((m) => setCalculate(() => m.calculateSiteDesign));
  }, [needed]);
  return useMemo(() => {
    if (!input?.geometry || !calculate) return null;
    try {
      return calculate(input);
    } catch {
      return null;
    }
  }, [calculate, input]);
}

export function SiteAssessment({ projectId }: { projectId: string }) {
  const t = useT(),
    language = usePreferences((s) => s.language);
  const label = (key: string) => t(`siteAssessment${key}` as Parameters<typeof t>[0]);
  const path = `/feasibility/projects/${projectId}/site-assessment`;
  const query = useApi(path),
    data = query.data as Response | undefined;
  const [draft, setDraft] = useState<Assessment>();
  const [geometryContext, setGeometryContext] = useState<LocationContext | null>(null);
  const [editor, setEditor] = useState<ReviewItem>();
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>();
  const assessment = draft ?? data?.assessment;
  const dirty = !!draft;
  const input = useMemo<SiteAssessmentInput | undefined>(
    () =>
      assessment && {
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
      },
    [assessment],
  );
  const validation = useMemo(() => input && siteAssessmentInputSchema.safeParse(input), [input]);
  const valid = validation?.success;
  const result = useMemo(() => (input && valid ? calculateSiteAssessment(input) : null), [input, valid]);
  const design = useSiteDesign(valid ? input : undefined);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    setDraft(undefined);
    setRaw({});
    setStep(undefined);
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
  if (query.isError) return <Callout tone="error">{(query.error as Error).message}</Callout>;
  if (!assessment || !data || !input) return null;
  const disabled = !data.canWrite || save.isPending;
  const locale = language === "de" ? "de-DE" : "en-GB";
  const update = (change: Partial<Assessment>) =>
    setDraft({
      ...assessment,
      ...change,
      ...(change.references && assessment.planningBasis === "section34"
        ? { checks: { ...assessment.checks, planningBasis: { ...assessment.checks.planningBasis, status: "unresolved" as const } } }
        : {}),
    });
  const area = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${n.toLocaleString(locale, { maximumFractionDigits: 2 })} m²`);
  const invalidKeys = new Set(validation && !validation.success ? validation.error.issues.flatMap((issue) => issue.path.map(String)) : []);
  const hasParcel = !!assessment.geometry?.parcel;
  const currentStep: Step = step ?? (!hasParcel ? "site" : SITE_ASSESSMENT_CONSTRAINT_KEYS.some((key) => assessment.constraints[key].value === null) ? "limits" : "design");
  const openReview = (item: ReviewItem) => setEditor(item);

  // Open items, grouped by the step where they are resolved.
  type OpenItem = { id: string; step: Step; name: string; issue: string; open: () => void };
  const openItems: OpenItem[] = [];
  if (!hasParcel) openItems.push({ id: "parcel", step: "site", name: t("siteGeometryParcel"), issue: label("OpenParcel"), open: () => setStep("site") });
  const seen = new Set<string>();
  for (const key of result?.missing ?? []) {
    const [group, name] = key.split(".");
    if (group === "constraints" && name && !seen.has(key.replace(/\.(value|evidence)$/, ""))) {
      seen.add(key.replace(/\.(value|evidence)$/, ""));
      const k = name as (typeof SITE_ASSESSMENT_CONSTRAINT_KEYS)[number];
      openItems.push({ id: `constraint:${k}`, step: "limits", name: label(k), issue: label(evidenceStatus(assessment.constraints[k], invalidKeys.has(k))), open: () => openReview({ kind: "constraint", key: k }) });
    } else if (group === "checks" && name) {
      const k = name as (typeof SITE_ASSESSMENT_CHECK_KEYS)[number];
      openItems.push({ id: `check:${k}`, step: "limits", name: label(k), issue: label("unresolved"), open: () => openReview({ kind: "check", key: k }) });
    } else if (key === "planningBasis") {
      openItems.push({ id: "planningBasis", step: "limits", name: label("PlanningBasis"), issue: label("OpenPlanningBasis"), open: () => setStep("limits") });
    } else if (group === "references") {
      const reference = name ? assessment.references[Number(name)] : undefined;
      openItems.push({ id: key, step: "site", name: reference ? reference.label || t("siteReferenceUnnamed") : label("References"), issue: label(reference ? "OpenReference" : "OpenReferences"), open: () => setStep("site") });
    }
  }
  const designIssues = design ? [...new Set(design.issues.filter((issue) => !issue.startsWith("unreviewed_assessment:")))] : [];
  if (hasParcel && designIssues.length) openItems.push({ id: "design", step: "design", name: label("DesignCheck"), issue: label("OpenDesign"), open: () => setStep("design") });
  if (hasParcel && !assessment.geometry?.buildings.length) openItems.push({ id: "buildings", step: "design", name: t("siteGeometryGroupDesign"), issue: t("siteDesignmissing_buildings"), open: () => setStep("design") });
  const count = (s: Step) => openItems.filter((item) => item.step === s).length;
  const stepLabel = (s: Step, key: string) => (count(s) ? `${label(key)} · ${count(s)}` : label(key));
  const canReport = !dirty && !!assessment.revision && !save.isPending;

  const constraintRows = SITE_ASSESSMENT_CONSTRAINT_KEYS.map((key) => {
    const value = assessment.constraints[key];
    return (
      <TableRow key={key}>
        <TableCell>{label(key)}</TableCell>
        <TableCell className="text-right tabular-nums">{value.value === null || !Number.isFinite(value.value) ? "–" : value.value.toLocaleString(locale, { maximumFractionDigits: 2 })}</TableCell>
        <TableCell><ReviewStatusBadge status={evidenceStatus(value, invalidKeys.has(key))} /></TableCell>
        <TableCell className="text-right">
          <Button size="sm" variant="ghost" aria-label={`${label(data.canWrite ? "Edit" : "ReviewEvidence")} ${label(key)}`} onClick={() => openReview({ kind: "constraint", key })}>
            {label(data.canWrite ? "Edit" : "View")}
          </Button>
        </TableCell>
      </TableRow>
    );
  });
  const rules = assessment.designRules ?? EMPTY_RULES;
  const checkStatus = (check: Assessment["checks"][keyof Assessment["checks"]]) => (check.status === "unresolved" || !check.note || !check.source ? "unresolved" : check.status);
  return (
    <div className="feasibility site-assessment">
      {blocker.state === "blocked" && (
        <Modal title={t("feasibilityUnsaved")} onClose={() => blocker.reset()}>
          <p>{t("feasibilityUnsavedHint")}</p>
          <div className="inline-actions">
            <Button variant="outline" onClick={() => blocker.proceed()}>{t("locationLeave")}</Button>
            <Button onClick={() => blocker.reset()}>{t("locationStay")}</Button>
          </div>
        </Modal>
      )}
      <header className="site-header">
        <dl className="site-summary">
          <div><dt>{label("parcelArea")}</dt><dd>{area(assessment.constraints.parcelArea.value)}</dd></div>
          <div><dt>{label("grossFloorArea")}</dt><dd>{area(result?.baseline?.grossFloorArea)}</dd></div>
          <div><dt>{label("countableFloorArea")}</dt><dd>{area(result?.baseline?.countableFloorArea)}</dd></div>
          <div><dt>{t("status")}</dt><dd><Badge variant="outline">{result ? label(result.status) : label("InvalidShort")}</Badge></dd></div>
          <div>
            <dt>{label("OpenItemsTitle")}</dt>
            <dd><Button variant="link" size="sm" className="site-open-link" onClick={() => setStep("result")}>{label("OpenItems").replace("{count}", String(openItems.length))}</Button></dd>
          </div>
        </dl>
        <div className="site-header-actions">
          <span className="muted text-ui-2xs" role="status">
            {dirty ? label("UnsavedReport") : assessment.revision ? `r${assessment.revision} · ${t("feasibilitySaved")}` : t("feasibilityNew")}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!canReport}
            title={canReport ? undefined : label(dirty ? "ReportSaveFirst" : "ReportNotSaved")}
            onClick={() => {
              const a = document.createElement("a");
              a.href = `/api${path}/report.pdf?lang=${language}`;
              a.download = "";
              a.click();
            }}
          >
            <Download className="size-icon-sm" aria-hidden="true" />
            {t("feasibilityReport")}
          </Button>
          {data.canWrite && (
            <Button size="sm" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate()}>
              <Save className="size-icon-sm" aria-hidden="true" />
              {save.isPending ? t("saving") : label("Save")}
            </Button>
          )}
        </div>
      </header>
      {save.error && <Callout tone="error">{save.error instanceof ApiError && save.error.status === 409 ? t("feasibilityConflict") : save.error.message}</Callout>}
      {dirty && data.assessment.revision !== assessment.revision && <Callout>{t("feasibilityConflict")}</Callout>}
      {!valid && <Callout tone="error">{label("Invalid")}</Callout>}
      <nav className="site-steps" aria-label={label("Steps")}>
        <Segmented
          value={currentStep}
          onChange={(value) => setStep(value as Step)}
          items={[
            { value: "site", label: stepLabel("site", "StepSite") },
            { value: "limits", label: stepLabel("limits", "StepLimits") },
            { value: "design", label: stepLabel("design", "StepDesign") },
            { value: "result", label: label("StepResult") },
          ]}
        />
      </nav>

      {/* Site and limits stay mounted so lookups and discovered buildings survive switching steps. */}
      <div className="site-step" hidden={currentStep !== "site"}>
        <BerlinContext
          siteLocator={assessment.siteLocator}
          projectId={projectId}
          disabled={disabled}
          adopted={assessment.geometry?.parcel ? { id: assessment.geometry.parcel.id, label: assessment.geometry.parcel.label, area: assessment.constraints.parcelArea.value, reviewed: assessment.geometry.parcel.reviewed && assessment.constraints.parcelArea.reviewed } : null}
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
                parcel: { id: parcel.id, label: parcel.label, geometry: parcel.polygons, source: parcel.sourceUrl, sourceDate: parcel.sourceDate, reviewed: false },
                setbacks: [],
              },
            });
          }}
        />
        <SiteReferencesPanel
          projectId={projectId}
          disabled={disabled}
          siteLocator={assessment.siteLocator}
          references={assessment.references}
          onLocator={(siteLocator) => update({ siteLocator })}
          onReferences={(references) => update({ references })}
          onContext={setGeometryContext}
        />
      </div>

      <div className="site-step" hidden={currentStep !== "limits"}>
        <Section title={label("PlanningBasis")}>
          <Segmented
            value={assessment.planningBasis}
            onChange={(planningBasis) => update({ planningBasis: planningBasis as Assessment["planningBasis"], checks: { ...assessment.checks, planningBasis: { ...assessment.checks.planningBasis, status: "unresolved" } } })}
            items={["b_plan", "section34", "unresolved"].map((value) => ({ value, label: label(value), disabled }))}
          />
          {assessment.planningBasis === "section34" && (
            <Callout>
              {label("Section34References").replace("{count}", String(assessment.references.length))}{" "}
              <Button variant="link" size="sm" onClick={() => setStep("site")}>{label("OpenReferencesStep")}</Button>
            </Callout>
          )}
          <details className="site-scope text-ui-xs">
            <summary>{label("ScopeTitle")}</summary>
            <p className="muted">{label("Scope")}</p>
          </details>
        </Section>
        <Section title={label("Constraints")}>
          <Table className="site-constraint-table">
            <TableHeader>
              <TableRow>
                <TableHead>{label("Constraint")}</TableHead>
                <TableHead className="text-right">{label("Value")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead><span className="sr-only">{label("Edit")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{constraintRows}</TableBody>
          </Table>
        </Section>
        <Section title={label("Checks")}>
          <Table className="site-constraint-table">
            <TableHeader>
              <TableRow>
                <TableHead>{label("Check")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead><span className="sr-only">{label("Edit")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SITE_ASSESSMENT_CHECK_KEYS.map((key) => (
                <TableRow key={key}>
                  <TableCell>{label(key)}</TableCell>
                  <TableCell><Badge variant="outline">{label(checkStatus(assessment.checks[key]))}</Badge></TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" aria-label={`${label(data.canWrite ? "Edit" : "ReviewEvidence")} ${label(key)}`} onClick={() => openReview({ kind: "check", key })}>
                      {label(data.canWrite ? "Edit" : "View")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell>{label("designRules")}</TableCell>
                <TableCell><Badge variant="outline">{label(rules.reviewed ? "ReviewedShort" : rules.buildingForm === "unresolved" ? "unresolved" : "Unreviewed")}</Badge></TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="ghost" aria-label={`${label(data.canWrite ? "Edit" : "ReviewEvidence")} ${label("designRules")}`} onClick={() => openReview({ kind: "rules", key: "designRules" })}>
                    {label(data.canWrite ? "Edit" : "View")}
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Section>
        <Section title={label("PlanningFacts")}>
          <Table className="site-constraint-table">
            <TableHeader>
              <TableRow>
                <TableHead>{label("Fact")}</TableHead>
                <TableHead>{label("Value")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead><span className="sr-only">{label("Edit")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {FACT_KEYS.map((key) => {
                const fact = assessment.planningFacts?.[key];
                return (
                  <TableRow key={key}>
                    <TableCell>{label(key)}</TableCell>
                    <TableCell className="site-fact-value">{fact?.value || "–"}</TableCell>
                    <TableCell><Badge variant="outline">{label(!fact?.value ? "ValueMissing" : fact.reviewed ? "ReviewedShort" : "Unreviewed")}</Badge></TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" aria-label={`${label(data.canWrite ? "Edit" : "ReviewEvidence")} ${label(key)}`} onClick={() => openReview({ kind: "fact", key })}>
                        {label(data.canWrite ? "Edit" : "View")}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>
        <SiteEvidencePanel
          projectId={projectId}
          disabled={disabled}
          onAdopt={(proposal) => {
            if (!proposal.constraint) return;
            const { key, value } = proposal.constraint;
            if (proposal.collection === "constraints") update({ constraints: { ...assessment.constraints, [key]: value } });
            else update({ planningFacts: { ...assessment.planningFacts, [key]: value } });
          }}
        />
        <details className="site-secondary">
          <summary className="text-ui-sm">{label("Upside")}{assessment.upside ? ` · ${label("UpsideOn")}` : ""}</summary>
          <div className="site-upside">
            <p className="muted text-ui-xs">{label("UpsideHint")}</p>
            <label className="site-review text-ui-xs">
              <Checkbox
                checked={!!assessment.upside}
                disabled={disabled}
                onCheckedChange={(checked) => update({ upside: checked ? { maxFullStoreys: { ...assessment.constraints.maxFullStoreys, reviewed: false }, note: "" } : null })}
              />
              {label("EnableUpside")}
            </label>
            {assessment.upside && (
              <>
                <EvidenceEditor
                  name={label("maxFullStoreys")}
                  value={assessment.upside.maxFullStoreys}
                  disabled={disabled}
                  invalid={false}
                  raw={raw["upside:maxFullStoreys"]}
                  onRaw={(text) => setRaw((current) => ({ ...current, "upside:maxFullStoreys": text }))}
                  change={(maxFullStoreys) => update({ upside: { ...assessment.upside!, maxFullStoreys } })}
                />
                <Field label={label("Note")}>
                  <Textarea rows={2} disabled={disabled} value={assessment.upside.note} onChange={(event) => update({ upside: { ...assessment.upside!, note: event.target.value } })} />
                </Field>
              </>
            )}
          </div>
        </details>
      </div>

      {currentStep === "design" && (
        <div className="site-step">
          <SiteGeometryEditor
            projectId={projectId}
            value={assessment.geometry ?? null}
            disabled={disabled}
            onChange={(geometry) => update({ geometry })}
            contextOverride={geometryContext}
            referenceBuildingIds={assessment.references.flatMap((r) => (r.buildingId ? [r.buildingId] : []))}
            emptyAction={<Button size="sm" onClick={() => setStep("site")}>{label("GoToSite")}</Button>}
            onUseArea={(value) =>
              update({
                constraints: {
                  ...assessment.constraints,
                  buildableFootprint: { value, source: "berlin_geometry_v1 · draft geometry calculation", sourceDate: new Date().toISOString().slice(0, 10), kind: "calculated", reviewed: false },
                },
              })
            }
            onReference={(building, context) => {
              if (assessment.references.some((r) => r.buildingId === building.id)) return;
              update({
                references: [
                  ...assessment.references,
                  {
                    id: crypto.randomUUID(),
                    buildingId: building.id,
                    label: building.label,
                    source: context.sources.map((s) => s.url).join("; "),
                    note: "",
                    polygons: building.polygons.map((p) => p.map((r) => r.map(([x, z]) => [x + context.origin[0], context.origin[1] - z]))),
                  },
                ],
              });
            }}
            options={
              assessment.constraints.grz.value !== null && assessment.constraints.gfz.value !== null && assessment.constraints.maxFullStoreys.value !== null
                ? { grz: assessment.constraints.grz.value, gfz: assessment.constraints.gfz.value, maxFullStoreys: assessment.constraints.maxFullStoreys.value, storeyHeight: 3 }
                : null
            }
          />
          <SiteDesignResult input={input} result={design} />
        </div>
      )}

      {currentStep === "result" && (
        <div className="site-step" id="site-assessment-result">
          <SiteCapacityVisual
            result={result}
            onEdit={(key) => openReview({ kind: "constraint", key })}
            empty={<><p className="text-ui-sm muted">{label("VisualEmpty")}</p><Button variant="outline" size="sm" onClick={() => setStep("limits")}>{label("GoToLimits")}</Button></>}
          />
          {result?.baseline && <p className="text-ui-xs muted">{label("FinancialHint")} <Link className="underline" to={`/projects/${projectId}?view=feasibility`}>{label("OpenFinancial")}</Link></p>}
          {result?.upside && (
            <Section title={label("Upside")} meta={<Badge variant="outline">{label("indicative")}</Badge>}>
              <p className="text-ui-xs">
                {label("Explanation")
                  .replace("{footprint}", area(result.upside.footprint))
                  .replace("{gf}", area(result.upside.countableFloorArea))
                  .replace("{unused}", area(result.upside.unusedGfzCapacity))
                  .replace("{limits}", result.upside.bindingConstraints.map((key) => label(key)).join(", "))}
              </p>
            </Section>
          )}
          <Section title={label("OpenItemsTitle")} meta={<Badge variant="outline">{result ? label(result.status) : label("InvalidShort")}</Badge>}>
            {openItems.length === 0 ? (
              <p className="text-ui-xs">{label("NoOpenItems")}</p>
            ) : (
              <Table className="site-constraint-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>{label("Item")}</TableHead>
                    <TableHead>{label("Issue")}</TableHead>
                    <TableHead>{label("Step")}</TableHead>
                    <TableHead><span className="sr-only">{label("Edit")}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.name}</TableCell>
                      <TableCell className="muted">{item.issue}</TableCell>
                      <TableCell className="muted">{label({ site: "StepSite", limits: "StepLimits", design: "StepDesign", result: "StepResult" }[item.step])}</TableCell>
                      <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={item.open}>{label("Resolve")}</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <ul className="site-limitations text-ui-2xs muted">
              {(result?.limitations ?? []).map((code) => <li key={code}>{label(code)}</li>)}
            </ul>
          </Section>
          <Section title={t("feasibilityNotes")}>
            <Textarea aria-label={t("feasibilityNotes")} rows={3} disabled={disabled} value={assessment.notes} onChange={(event) => update({ notes: event.target.value })} />
          </Section>
        </div>
      )}

      <SiteReviewPanel
        item={editor}
        items={REVIEW_ITEMS}
        assessment={assessment}
        disabled={disabled}
        canWrite={data.canWrite}
        invalidKeys={invalidKeys}
        raw={raw}
        onRaw={(key, text) => setRaw((current) => ({ ...current, [key]: text }))}
        onUpdate={update}
        onNavigate={setEditor}
        onClose={() => setEditor(undefined)}
      />
    </div>
  );
}

