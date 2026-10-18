import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useBlocker, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Download, Save } from "lucide-react";
import {
  calculateSiteAssessment,
  siteAssessmentInputSchema,
  SITE_ASSESSMENT_CONSTRAINT_KEYS,
  SITE_ASSESSMENT_CHECK_KEYS,
  type SiteAssessmentInput,
  type SiteAssessmentConstraint,
  type LocationContext,
  type SiteReference,
} from "@richtfest/shared";
import type * as Proposals from "@richtfest/shared/site-proposals";
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
import { BuildingCodePanel } from "./building-code-panel";
import { EMPTY_RULES, EvidenceEditor, ReviewStatusBadge, SiteReviewPanel, evidenceStatus, type ReviewItem } from "./site-review-panel";
import { berlinContextQuery, discoveryContext, siteDiscoveryQuery, type BerlinParcel } from "./site-lookups";
import { extractPlanFigures, planToRead, type PlanProvider } from "./plan-extraction";
import { applySiteSummary, massingOptions, proposeFrameFigures, proposeGrz2Default, type SummaryStep, type SummaryStepId } from "./site-summary";
import { SiteSummaryPanel } from "./site-summary-panel";
import { applyTrace } from "./plan-lines";
import { PlanRegimePanel } from "./plan-regime-panel";

/** Centre of the parcel's outer ring bounds, for maps around the site. */
const parcelCentre = (geometry: [number, number][][][] | undefined): [number, number] | null => {
  const ring = geometry?.[0]?.[0];
  if (!ring?.length) return null;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};
type Assessment = Omit<SiteAssessmentInput, "baseRevision"> & { revision: number; updatedAt: string | null };
type Response = { assessment: Assessment; canWrite: boolean };
type Step = "site" | "limits" | "design" | "result";
const STEPS: Step[] = ["site", "limits", "design", "result"];
/** Required constraints with the optional GRZ 2 next to GRZ, in reading order. */
const CONSTRAINT_ROWS = SITE_ASSESSMENT_CONSTRAINT_KEYS.flatMap((key) => (key === "grz" ? (["grz", "grz2"] as const) : ([key] as const)));
const EMPTY_CONSTRAINT = { value: null, source: "", sourceDate: null, kind: "assessment" as const, reviewed: false };
/** Older assessments have no GRZ 2; show it as an empty optional input instead of a missing field. */
const withOptional = (a: Assessment): Assessment => (a.constraints.grz2 ? a : { ...a, constraints: { ...a.constraints, grz2: EMPTY_CONSTRAINT } });
type RuleTopic = "landUse" | "buildingForm" | "height" | "roofForm" | "setbacks" | "encroachments";
/** Plan rules grouped per topic, so the plan text, the design rule and the check for one topic sit together. */
const RULE_TOPICS: { topic: RuleTopic; items: ReviewItem[] }[] = [
  { topic: "landUse", items: [{ kind: "fact", key: "landUse" }] },
  { topic: "buildingForm", items: [{ kind: "fact", key: "buildingForm" }, { kind: "rules", key: "designRules" }, { kind: "check", key: "bauweise" }] },
  { topic: "height", items: [{ kind: "fact", key: "heightRule" }, { kind: "rules", key: "designRules" }, { kind: "check", key: "height" }] },
  { topic: "roofForm", items: [{ kind: "fact", key: "roofForm" }] },
  { topic: "setbacks", items: [{ kind: "check", key: "setbacks" }] },
  { topic: "encroachments", items: [{ kind: "fact", key: "encroachments" }] },
];
const OTHER_CHECKS = ["planningBasis", "rights", "heritage"] as const;
/** Review panel order follows the screen: figures, plan rules per topic, other checks. */
const REVIEW_ITEMS: ReviewItem[] = [
  ...CONSTRAINT_ROWS.map((key) => ({ kind: "constraint" as const, key })),
  ...RULE_TOPICS.flatMap((t) => t.items).filter((item, i, all) => all.findIndex((o) => o.kind === item.kind && o.key === item.key) === i),
  ...OTHER_CHECKS.map((key) => ({ kind: "check" as const, key })),
];

/** One column layout for every Planning limits table, so values, sources and statuses line up across sections. */
function LimitsTable({ label, children }: { label: (key: string) => string; children: ReactNode }) {
  return (
    <Table className="site-limits-table">
      <colgroup><col className="site-limits-name" /><col className="site-limits-value" /><col /><col className="site-limits-status" /><col className="site-limits-action" /></colgroup>
      <TableHeader>
        <TableRow>
          <TableHead>{label("Item")}</TableHead>
          <TableHead>{label("Value")}</TableHead>
          <TableHead>{label("SourceColumn")}</TableHead>
          <TableHead>{label("Status")}</TableHead>
          <TableHead><span className="sr-only">{label("Edit")}</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function LimitRow({ name, value, numeric, source, status, action, sub }: { name: string; value: string | null; numeric?: boolean; source: string | undefined; status: ReactNode; action: ReactNode; sub?: boolean }) {
  return (
    <TableRow>
      <TableCell className={sub ? "site-limits-sub" : undefined}>{name}</TableCell>
      <TableCell className={numeric ? "tabular-nums" : "site-limits-text"} title={value ?? undefined}>{value || "–"}</TableCell>
      <TableCell className="site-limits-source muted" title={source || undefined}>{source || "–"}</TableCell>
      <TableCell>{status}</TableCell>
      <TableCell className="text-right">{action}</TableCell>
    </TableRow>
  );
}

type ProposalEngine = typeof import("@richtfest/shared/site-proposals");
const loadProposals = () => import("@richtfest/shared/site-proposals");

/** The exemption massing is generated, not stored: it follows the envelope, setbacks and the upside storeys. */
function useUpsideMassing(input: SiteAssessmentInput | undefined) {
  const [engine, setEngine] = useState<ProposalEngine>();
  const geometry = input?.geometry;
  const storeys = input?.upside?.maxFullStoreys.value ?? null;
  const options = input && storeys !== null ? massingOptions(input.constraints, storeys) : null;
  const needed = !!geometry?.parcel && !!options;
  useEffect(() => {
    if (needed && !engine) void loadProposals().then(setEngine);
  }, [needed]);
  // Moving or editing the design's own buildings must not regenerate the scenario.
  const key = needed ? JSON.stringify([{ ...geometry, buildings: [] }, options]) : "";
  return useMemo(() => {
    if (!needed || !engine || !geometry || !options) return needed ? null : undefined;
    try {
      const best = engine.bestMassing(geometry, options);
      return best ? { building: best.building, grossFloorArea: best.metrics.grossFloorArea, countableFloorArea: best.metrics.countableFloorArea } : null;
    } catch {
      return null;
    }
  }, [key, engine]);
}

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

export function SiteAssessment({ projectId, nav }: { projectId: string; nav?: ReactNode }) {
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
  // The step lives in the URL (?step=), so reloads and shared links return to it; without one the assessment opens on Site, in task order.
  const [params, setParams] = useSearchParams();
  const stepParam = params.get("step");
  const step: Step | undefined = STEPS.includes(stepParam as Step) ? (stepParam as Step) : undefined;
  const setStep = (next: Step | undefined) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next) updated.set("step", next);
      else updated.delete("step");
      return updated;
    }, { replace: true });
  const [scenario, setScenario] = useState<"baseline" | "upside">("baseline");
  const [summarySteps, setSummarySteps] = useState<SummaryStep[] | null>(null);
  const loaded = useMemo(() => data?.assessment && withOptional(data.assessment), [data?.assessment]);
  const assessment = draft ?? loaded;
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
        ...(assessment.planRegime ? { planRegime: assessment.planRegime } : {}),
      },
    [assessment],
  );
  const validation = useMemo(() => input && siteAssessmentInputSchema.safeParse(input), [input]);
  const valid = validation?.success;
  const result = useMemo(() => (input && valid ? calculateSiteAssessment(input) : null), [input, valid]);
  const design = useSiteDesign(valid ? input : undefined);
  const upsideMassing = useUpsideMassing(valid ? input : undefined);
  const [planProvider, setPlanProvider] = useState<PlanProvider>("openai");
  const summary = useMutation({
    mutationFn: async (base: Assessment) => {
      const locator = base.siteLocator;
      const [context, discovery, engine] = await Promise.allSettled([
        queryClient.fetchQuery(berlinContextQuery(projectId, locator)),
        queryClient.fetchQuery(siteDiscoveryQuery(projectId, locator)),
        loadProposals(),
      ]);
      if (engine.status === "rejected") throw engine.reason;
      const message = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? (r.reason as Error).message : undefined);
      const { revision, updatedAt, ...current } = base;
      const found = context.status === "fulfilled" ? context.value : null;
      // A covering B-Plan is read for its figures before the frame step; § 34 sites skip this.
      const readPlan = planToRead(current, found);
      const plan = readPlan ? await extractPlanFigures(projectId, locator, readPlan, planProvider, current) : null;
      const applied = applySiteSummary(current, { context: found, contextError: message(context), discovery: discovery.status === "fulfilled" ? discovery.value : null, discoveryError: message(discovery), plan }, engine.value, new Date().toISOString().slice(0, 10));
      if (plan) void queryClient.invalidateQueries({ queryKey: [`/feasibility/projects/${projectId}/evidence`] });
      return { ...applied, base: { revision, updatedAt } };
    },
    onSuccess: ({ draft: next, steps, base }) => {
      setDraft({ ...next, ...base });
      setSummarySteps(steps);
      setScenario("baseline");
      const parcel = steps.find((s) => s.id === "parcel");
      setStep(parcel && (parcel.status === "done" || parcel.status === "kept") ? "result" : "site");
    },
  });
  // Proposal engine for re-deriving the § 34 frame when references change; loaded off the boot path.
  const [proposals, setProposals] = useState<typeof Proposals>();
  useEffect(() => {
    void import("@richtfest/shared/site-proposals").then(setProposals);
  }, []);
  // Switching steps only changes ?step= and keeps the draft; any other navigation asks first.
  const withoutStep = (search: string) => { const p = new URLSearchParams(search); p.delete("step"); return p.toString(); };
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && (currentLocation.pathname !== nextLocation.pathname || withoutStep(currentLocation.search) !== withoutStep(nextLocation.search)));
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
  /** New reference selection; under § 34 (or an open basis) the unreviewed frame figures follow it, so Design measures against the chosen plots. */
  const setReferences = (references: SiteReference[]) => {
    if (!proposals || assessment.planningBasis === "b_plan" || assessment.planningBasis === "section35") return update({ references });
    const constraints = { ...assessment.constraints };
    proposeFrameFigures(constraints, references, proposals);
    proposeGrz2Default(constraints, proposals);
    update({ references, constraints });
  };
  const area = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "–" : `${n.toLocaleString(locale, { maximumFractionDigits: 2 })} m²`);
  const invalidKeys = new Set(validation && !validation.success ? validation.error.issues.flatMap((issue) => issue.path.map(String)) : []);
  const hasParcel = !!assessment.geometry?.parcel;
  const currentStep: Step = step ?? "site";
  const openReview = (item: ReviewItem) => setEditor(item);
  const openUpside = () => {
    setStep("limits");
    requestAnimationFrame(() => {
      const details = document.getElementById("site-upside") as HTMLDetailsElement | null;
      if (details) { details.open = true; details.scrollIntoView({ block: "center" }); }
    });
  };
  const openSummaryStep = (id: SummaryStepId) => {
    if (id === "parcel" || id === "references") return setStep("site");
    if (id === "basis") return setStep("limits");
    if (id === "frame") return openReview({ kind: "constraint", key: assessment.planningBasis === "b_plan" ? "maxFullStoreys" : "grz" });
    if (id === "form") return openReview({ kind: "rules", key: "designRules" });
    if (id === "upside") return openUpside();
    setScenario("baseline");
    setStep("design");
  };
  const summaryPanel = (
    <SiteSummaryPanel
      steps={summarySteps}
      running={summary.isPending}
      error={summary.error ? (summary.error as Error).message : null}
      disabled={!data.canWrite}
      primary={!hasParcel}
      onRun={() => summary.mutate(assessment)}
      onOpen={openSummaryStep}
      provider={planProvider}
      onProvider={setPlanProvider}
    />
  );

  // Open items, grouped by the step where they are resolved.
  type OpenItem = { id: string; step: Step; name: string; issue: string; open: () => void };
  const openItems: OpenItem[] = [];
  if (!hasParcel) openItems.push({ id: "parcel", step: "site", name: t("siteGeometryParcel"), issue: label("OpenParcel"), open: () => setStep("site") });
  const seen = new Set<string>();
  for (const key of result?.missing ?? []) {
    const [group, name] = key.split(".");
    if (group === "constraints" && name && !seen.has(key.replace(/\.(value|evidence)$/, ""))) {
      seen.add(key.replace(/\.(value|evidence)$/, ""));
      const k = name as (typeof CONSTRAINT_ROWS)[number];
      openItems.push({ id: `constraint:${k}`, step: "limits", name: label(k), issue: label(evidenceStatus(assessment.constraints[k] ?? EMPTY_CONSTRAINT, invalidKeys.has(k))), open: () => openReview({ kind: "constraint", key: k }) });
    } else if (group === "checks" && name) {
      const k = name as (typeof SITE_ASSESSMENT_CHECK_KEYS)[number];
      openItems.push({ id: `check:${k}`, step: "limits", name: label(k), issue: label("unresolved"), open: () => openReview({ kind: "check", key: k }) });
    } else if (key === "planningBasis.section35") {
      openItems.push({ id: key, step: "limits", name: label("PlanningBasis"), issue: label("OpenSection35"), open: () => setStep("limits") });
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

  /** One adoption path for the parcel map and the Design editor: the parcel becomes the site geometry and its area the unreviewed parcel area. */
  const adoptParcel = (value: SiteAssessmentConstraint, parcel: BerlinParcel) => {
    setRaw((current) => {
      const next = { ...current };
      delete next["baseline:parcelArea"];
      return next;
    });
    const current = assessment.geometry ?? createEmptySiteGeometryInput();
    // A different parcel invalidates the unreviewed envelope and building lines drawn for the previous one; reviewed ones stay for a person to judge.
    const moved = current.parcel?.id !== parcel.id;
    update({
      constraints: { ...assessment.constraints, parcelArea: value },
      geometry: {
        ...current,
        parcel: { id: parcel.id, label: parcel.label, geometry: parcel.polygons, source: parcel.sourceUrl, sourceDate: parcel.sourceDate, reviewed: false },
        setbacks: [],
        ...(moved ? { envelope: current.envelope?.reviewed ? current.envelope : null, mandatoryLines: (current.mandatoryLines ?? []).filter((l) => l.reviewed) } : {}),
      },
    });
  };
  const rules = assessment.designRules ?? EMPTY_RULES;
  const checkStatus = (check: Assessment["checks"][keyof Assessment["checks"]]) => (check.status === "unresolved" || !check.note || !check.source ? "unresolved" : check.status);
  const reviewButton = (item: ReviewItem) => (
    <Button size="sm" variant="ghost" aria-label={`${label(data.canWrite ? "Edit" : "ReviewEvidence")} ${label(item.key)}`} onClick={() => openReview(item)}>
      {label(data.canWrite ? "Edit" : "View")}
    </Button>
  );
  const ruleRow = (item: ReviewItem, name: string, sub: boolean, topic?: RuleTopic) => {
    const key = `${topic ?? "check"}:${item.kind}:${item.key}`;
    const row = { name, sub, action: reviewButton(item) };
    if (item.kind === "fact") {
      const fact = assessment.planningFacts?.[item.key as keyof NonNullable<Assessment["planningFacts"]>];
      return <LimitRow key={key} {...row} value={fact?.value || null} source={fact?.source} status={<Badge variant="outline">{label(!fact?.value ? "ValueMissing" : fact.reviewed ? "ReviewedShort" : "Unreviewed")}</Badge>} />;
    }
    if (item.kind === "check") {
      const check = assessment.checks[item.key as keyof Assessment["checks"]];
      return <LimitRow key={key} {...row} value={check.note || null} source={check.source} status={<Badge variant="outline">{label(checkStatus(check))}</Badge>} />;
    }
    const value = topic === "height"
      ? rules.heightNotSpecified ? label("HeightNotSpecified") : rules.maxHeight ? `${rules.maxHeight.toLocaleString(locale, { maximumFractionDigits: 1 })} m` : null
      : rules.buildingForm === "unresolved" ? null : label(rules.buildingForm);
    return <LimitRow key={key} {...row} value={value} source={rules.source} status={<Badge variant="outline">{label(rules.reviewed ? "ReviewedShort" : value === null ? "ValueMissing" : "Unreviewed")}</Badge>} />;
  };
  return (
    <div className={`feasibility site-assessment${currentStep === "design" ? " is-design" : ""}`}>
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
        {nav}
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
        <dl className="site-summary">
          <div><dt>{label("HeaderParcel")}</dt><dd>{area(assessment.constraints.parcelArea.value)}</dd></div>
          <div><dt>{label("HeaderBgf")}</dt><dd>{area(result?.baseline?.grossFloorArea)}</dd></div>
          <div><dt>{label("HeaderGf")}</dt><dd>{area(result?.baseline?.countableFloorArea)}</dd></div>
          <div><dt className="sr-only">{t("status")}</dt><dd><Badge variant="outline">{result ? label(result.status) : label("InvalidShort")}</Badge></dd></div>
          <div><dt className="sr-only">{label("OpenItemsTitle")}</dt><dd><Button variant="link" size="sm" className="site-open-link" onClick={() => setStep("result")}>{label("OpenItems").replace("{count}", String(openItems.length))}</Button></dd></div>
        </dl>
        <div className="site-header-actions">
          <span className="site-header-status muted text-ui-2xs" role="status" title={dirty ? label("UnsavedReport") : undefined}>
            {dirty ? t("feasibilityUnsaved") : assessment.revision ? `r${assessment.revision} · ${t("feasibilitySaved")}` : t("feasibilityNew")}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!canReport}
            aria-label={t("feasibilityReport")}
            title={canReport ? t("feasibilityReport") : label(dirty ? "ReportSaveFirst" : "ReportNotSaved")}
            onClick={() => {
              const a = document.createElement("a");
              a.href = `/api${path}/report.pdf?lang=${language}`;
              a.download = "";
              a.click();
            }}
          >
            <Download className="size-icon-sm" aria-hidden="true" />
            <span className="site-header-label">{t("feasibilityReport")}</span>
          </Button>
          {data.canWrite && (
            <Button size="sm" title={dirty ? label("UnsavedReport") : undefined} disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate()}>
              <Save className="size-icon-sm" aria-hidden="true" />
              {save.isPending ? t("saving") : label("Save")}
            </Button>
          )}
        </div>
      </header>
      {save.error && <Callout tone="error">{save.error instanceof ApiError && save.error.status === 409 ? t("feasibilityConflict") : save.error.message}</Callout>}
      {dirty && data.assessment.revision !== assessment.revision && <Callout>{t("feasibilityConflict")}</Callout>}
      {!valid && <Callout tone="error">{label("Invalid")}</Callout>}

      {/* Site and limits stay mounted so lookups and discovered buildings survive switching steps. */}
      <div className="site-step" hidden={currentStep !== "site"}>
        {summaryPanel}
        <BerlinContext
          siteLocator={assessment.siteLocator}
          projectId={projectId}
          disabled={disabled}
          onDesign={() => setStep("design")}
          adopted={assessment.geometry?.parcel ? { id: assessment.geometry.parcel.id, label: assessment.geometry.parcel.label, area: assessment.constraints.parcelArea.value, reviewed: assessment.geometry.parcel.reviewed && assessment.constraints.parcelArea.reviewed } : null}
          onAdopt={adoptParcel}
          references={assessment.references}
          onReferences={setReferences}
          active={currentStep === "site"}
          plan={{
            overlay: assessment.geometry?.planOverlay ?? null,
            parcel: assessment.geometry?.parcel ?? null,
            envelopeReviewed: !!assessment.geometry?.envelope?.reviewed,
            onChange: (planOverlay) => update({ geometry: { ...(assessment.geometry ?? createEmptySiteGeometryInput()), planOverlay } }),
            onTrace: (traced) => {
              const current = assessment.geometry ?? createEmptySiteGeometryInput();
              update({ geometry: { ...current, ...applyTrace(current, traced) } });
            },
          }}
        />
        <SiteReferencesPanel
          projectId={projectId}
          disabled={disabled}
          siteLocator={assessment.siteLocator}
          references={assessment.references}
          onLocator={(siteLocator) => update({ siteLocator })}
          onReferences={setReferences}
          onContext={setGeometryContext}
        />
      </div>

      <div className="site-step" hidden={currentStep !== "limits"}>
        <Section title={label("PlanningBasis")}>
          <Segmented
            value={assessment.planningBasis}
            onChange={(planningBasis) => update({ planningBasis: planningBasis as Assessment["planningBasis"], checks: { ...assessment.checks, planningBasis: { ...assessment.checks.planningBasis, status: "unresolved" } } })}
            items={["b_plan", "section34", "section35", "unresolved"].map((value) => ({ value, label: label(value), disabled }))}
          />
          {assessment.planningBasis === "b_plan" && (
            <PlanRegimePanel
              regime={assessment.planRegime}
              constraints={assessment.constraints}
              origin={assessment.siteLocator?.origin ?? parcelCentre(assessment.geometry?.parcel?.geometry) ?? null}
              disabled={disabled}
              label={label}
              onChange={({ planRegime, constraints }) => update({ planRegime, ...(constraints ? { constraints } : {}) })}
            />
          )}
          {assessment.planningBasis === "section35" && <Callout tone="warning">{label("Section35Hint")}</Callout>}
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
        <Section title={label("Figures")}>
          <LimitsTable label={label}>
            {CONSTRAINT_ROWS.map((key) => {
              const value = assessment.constraints[key] ?? EMPTY_CONSTRAINT;
              return (
                <LimitRow
                  key={key}
                  name={label(key === "grz2" ? "grz2Short" : key)}
                  value={value.value === null || !Number.isFinite(value.value) ? null : value.value.toLocaleString(locale, { maximumFractionDigits: 2 })}
                  numeric
                  source={value.source}
                  status={<ReviewStatusBadge status={evidenceStatus(value, invalidKeys.has(key))} />}
                  action={reviewButton({ kind: "constraint", key })}
                />
              );
            })}
          </LimitsTable>
        </Section>
        <Section title={label("PlanRules")}>
          <LimitsTable label={label}>
            {RULE_TOPICS.map(({ topic, items }) =>
              items.length === 1 ? (
                ruleRow(items[0]!, label(topic), false, topic)
              ) : (
                <Fragment key={topic}>
                  <TableRow className="site-limits-group"><TableCell colSpan={5}>{label(topic)}</TableCell></TableRow>
                  {items.map((item) => ruleRow(item, label(item.kind === "fact" ? "RulePlanText" : item.kind === "check" ? "RuleCheck" : "RuleDesign"), true, topic))}
                </Fragment>
              ),
            )}
          </LimitsTable>
        </Section>
        <Section title={label("OtherChecks")}>
          <LimitsTable label={label}>{OTHER_CHECKS.map((key) => ruleRow({ kind: "check", key }, label(key), false))}</LimitsTable>
        </Section>
        <BuildingCodePanel jurisdiction={assessment.jurisdiction} />
        <details className="site-secondary" id="site-upside">
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
        <div className="site-step is-workbench">
          <SiteGeometryEditor
            projectId={projectId}
            value={assessment.geometry ?? null}
            disabled={disabled}
            onChange={(geometry) => update({ geometry })}
            parcelArea={assessment.constraints.parcelArea.value}
            jurisdiction={assessment.jurisdiction}
            onAdoptParcel={(parcel) => adoptParcel({ value: parcel.area, source: `${parcel.sourceUrl} · ${parcel.id}`, sourceDate: parcel.sourceDate, kind: "official", reviewed: false }, parcel)}
            contextOverride={geometryContext}
            referenceBuildingIds={assessment.references.flatMap((r) => (r.buildingId ? [r.buildingId] : []))}
            emptyAction={data.canWrite ? <Button size="sm" disabled={summary.isPending} onClick={() => summary.mutate(assessment)}>{t("siteSummaryRun")}</Button> : <Button size="sm" variant="outline" onClick={() => setStep("site")}>{label("GoToSite")}</Button>}
            scenario={scenario}
            onScenario={setScenario}
            upsideMassing={upsideMassing}
            upsideStoreys={assessment.upside?.maxFullStoreys.value ?? null}
            onUseBuildingLand={(value) =>
              update({
                constraints: {
                  ...assessment.constraints,
                  parcelArea: { value, source: "berlin_geometry_v1 · parcel less non-building land (street, green) behind the street boundary line, § 19 (3) BauNVO", sourceDate: new Date().toISOString().slice(0, 10), kind: "calculated", reviewed: false },
                },
              })
            }
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
              setReferences([
                  ...assessment.references,
                  {
                    id: crypto.randomUUID(),
                    buildingId: building.id,
                    label: building.label,
                    source: context.sources.map((s) => s.url).join("; "),
                    note: "",
                    polygons: building.polygons.map((p) => p.map((r) => r.map(([x, z]) => [x + context.origin[0], context.origin[1] - z]))),
                  },
                ]);
            }}
            options={
              assessment.constraints.grz.value !== null && assessment.constraints.gfz.value !== null && assessment.constraints.maxFullStoreys.value !== null
                ? { grz: assessment.constraints.grz.value, gfz: assessment.constraints.gfz.value, maxFullStoreys: assessment.constraints.maxFullStoreys.value, storeyHeight: 3 }
                : null
            }
          />
        </div>
      )}

      {currentStep === "result" && (
        <div className="site-step" id="site-assessment-result">
          {/* The Design step is a full-window workbench; its detailed check table reads here with the capacity. */}
          <SiteDesignResult input={input} result={design} />
          {result?.baseline && (
            <Section title={label("RangeTitle")} meta={<Badge variant="outline">{label("indicative")}</Badge>}>
              <Table aria-label={label("RangeTitle")}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{label("Scenario")}</TableHead>
                    <TableHead className="text-right">{label("maxFullStoreys")}</TableHead>
                    <TableHead className="text-right">{label("RangeFootprint")}</TableHead>
                    <TableHead className="text-right">GF</TableHead>
                    <TableHead className="text-right">BGF</TableHead>
                    <TableHead>{label("RangeLimitedBy")}</TableHead>
                    <TableHead className="text-right">{label("RangeMassing")}</TableHead>
                    <TableHead><span className="sr-only">{label("Resolve")}</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    { id: "baseline" as const, name: label("RangeBaseline"), storeys: assessment.constraints.maxFullStoreys.value, capacity: result.baseline, massing: design?.geometry?.buildings.length ? design.geometry.buildings.reduce((n, b) => n + b.grossFloorArea, 0) : null },
                    ...(result.upside ? [{ id: "upside" as const, name: label("RangeUpside"), storeys: assessment.upside?.maxFullStoreys.value ?? null, capacity: result.upside, massing: upsideMassing?.grossFloorArea ?? null }] : []),
                  ].map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.storeys ?? "–"}</TableCell>
                      <TableCell className="text-right tabular-nums">{area(row.capacity.footprint)}</TableCell>
                      <TableCell className="text-right tabular-nums">{area(row.capacity.countableFloorArea)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{area(row.capacity.grossFloorArea)}</TableCell>
                      <TableCell>{row.capacity.bindingConstraints.map((key) => label(key)).join(", ")}</TableCell>
                      <TableCell className="text-right tabular-nums">{area(row.massing)}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" disabled={row.id === "upside" ? !upsideMassing : !hasParcel} onClick={() => { setScenario(row.id); setStep("design"); }}>{label("RangeShow")}</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {result.upside ? (
                <p className="muted text-ui-2xs">{label("RangeHint").replace("{diff}", area(result.upside.grossFloorArea - result.baseline.grossFloorArea))}</p>
              ) : (
                <p className="muted text-ui-xs">{label("RangeNoUpside")} <Button variant="link" size="sm" onClick={openUpside}>{label("RangeAddUpside")}</Button></p>
              )}
              {result.baseline.ancillaryAllowance !== null && <p className="text-ui-xs">{label("AncillaryAllowance")}: <strong className="tabular-nums">{area(result.baseline.ancillaryAllowance)}</strong></p>}
            </Section>
          )}
          <SiteCapacityVisual
            result={result}
            onEdit={(key) => openReview({ kind: "constraint", key })}
            empty={<><p className="text-ui-sm muted">{label("VisualEmpty")}</p><Button variant="outline" size="sm" onClick={() => setStep("limits")}>{label("GoToLimits")}</Button></>}
          />
          {summarySteps && summaryPanel}
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

