import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Circle, X } from "lucide-react";
import type { ProjectPlanning, ProjectPlanningItem, SiteAssessmentInput, SiteAssessmentResult } from "@richtfest/shared";
import { deviationScenarios, limitEffects, siteTaskProposals, type LimitEffect, type SiteTaskKey } from "@richtfest/shared/planning-review";
import { api, ApiError } from "../../api";
import { queryClient, useApi } from "../../query";
import type { PdfEvidenceRenderer } from "../building-model/pdf-evidence-renderer";
import { Button } from "../ui/button";
import { Badge, Callout, Segmented } from "../ui/primitives";
import { evidenceStatus, reviewItemId, EMPTY_RULES, type ReviewItem } from "./site-review-panel";
import type { EvidenceSource } from "./site-evidence-panel";
import { SiteMiniPlan, type MiniPlanFocus } from "./site-mini-plan";
import { bnpMapUrl } from "./plan-regime-panel";

type Draft = Omit<SiteAssessmentInput, "baseRevision">;
type Constraints = Draft["constraints"];
type Group = "capacity" | "check";
type Row = { item: ReviewItem; id: string; group: Group; name: string; value: string | null; done: boolean; status: string; source: string; effect: LimitEffect | undefined; order: number };
type Evidence = "auto" | "plan" | "map";

const EMPTY_LAYERS: Record<string, boolean> = {};
/** Limits whose evidence is a place on the site rather than a line of plan text. */
const MAP_FOCUS: Partial<Record<string, MiniPlanFocus>> = {
  "constraint:parcelArea": "building_land",
  "constraint:buildableFootprint": "envelope",
  "check:setbacks": "boundary",
  "check:bauweise": "boundary",
  "rules:designRules": "buildings",
};

/** Proposals adopted from a plan carry `sourceVersion=…&page=…` and the quote after the proposal id. */
export function planReference(source: string): { versionId: string; page: number; quote: string } | null {
  const match = /sourceVersion=([0-9a-f-]{36})&page=(\d+)/i.exec(source);
  if (!match) return null;
  const quote = / · proposal [0-9a-f-]{36} · (.*)$/is.exec(source)?.[1]?.trim() ?? "";
  return { versionId: match[1]!, page: Number(match[2]), quote };
}

/** Figures proposed from the Baunutzungsplan building class; their evidence is the plan map at the site. */
const isBuildingClassSource = (source: string, assessment: Draft) => assessment.planRegime?.regime === "baunutzungsplan" && source.includes("BO 58 building class");

/** Stable planning item id per project and task, so a proposed task is created once and found again (UUID v5 layout). */
async function taskId(projectId: string, key: SiteTaskKey) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`richtfest:feasibility-task:${projectId}:${key}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Planning limits as one review list sorted by what they do to capacity, with the evidence for the selected limit
 * beside it: the cited plan page, or the site plan for limits that are places (street land, Baufenster, boundary).
 * Below the list: deviation routes worth asking for and the land-register enquiries the plan cannot answer.
 */
export function LimitsReview({ projectId, assessment, input, result, grossParcelArea, origin, items, name, disabled, canWrite, locale, label, onUpdate, onEdit }: {
  projectId: string;
  assessment: Draft;
  input: SiteAssessmentInput;
  result: SiteAssessmentResult | null;
  grossParcelArea: number | null;
  /** Site centre in EPSG:25833, for the Baunutzungsplan map. */
  origin: [number, number] | null;
  items: ReviewItem[];
  name: (item: ReviewItem) => string;
  disabled: boolean;
  canWrite: boolean;
  locale: string;
  label: (key: string) => string;
  onUpdate: (change: Partial<Draft>) => void;
  onEdit: (item: ReviewItem) => void;
}) {
  const area = (n: number) => `${n.toLocaleString(locale, { maximumFractionDigits: 0 })} m²`;
  const number = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 });
  const effects = useMemo(() => limitEffects(input, grossParcelArea), [input, grossParcelArea]);
  const scenarios = useMemo(() => deviationScenarios(input), [input]);
  const rules = assessment.designRules ?? EMPTY_RULES;

  const rows: Row[] = items.map((item, index) => {
    const id = reviewItemId(item);
    if (item.kind === "constraint") {
      const c = assessment.constraints[item.key as keyof Constraints];
      const status = c ? evidenceStatus(c, false) : "ValueMissing";
      const unit = item.key === "parcelArea" || item.key === "buildableFootprint" || item.key.startsWith("additional") ? " m²" : "";
      return { item, id, group: "capacity", name: name(item), value: c?.value == null ? null : Number.isFinite(c.value) ? `${number(c.value)}${unit}` : label("InvalidShort"), done: status === "ReviewedShort", status, source: c?.source ?? "", effect: effects[item.key as keyof Constraints], order: index };
    }
    if (item.kind === "fact") {
      const fact = assessment.planningFacts?.[item.key as keyof NonNullable<Draft["planningFacts"]>];
      const status = !fact?.value ? "ValueMissing" : fact.reviewed ? "ReviewedShort" : "Unreviewed";
      return { item, id, group: "check", name: name(item), value: fact?.value || null, done: !!fact?.reviewed, status, source: fact?.source ?? "", effect: undefined, order: index };
    }
    if (item.kind === "check") {
      const check = assessment.checks[item.key as keyof Draft["checks"]];
      const done = check.status !== "unresolved" && !!check.note && !!check.source;
      return { item, id, group: "check", name: name(item), value: check.note || null, done, status: done ? check.status : "unresolved", source: check.source, effect: undefined, order: index };
    }
    const value = [rules.buildingForm !== "unresolved" ? label(rules.buildingForm) : "", rules.heightNotSpecified ? label("HeightNotSpecified") : rules.maxHeight ? `${number(rules.maxHeight)} m` : ""].filter(Boolean).join(" · ");
    return { item, id, group: "check", name: name(item), value: value || null, done: rules.reviewed, status: rules.reviewed ? "ReviewedShort" : value ? "Unreviewed" : "ValueMissing", source: rules.source, effect: undefined, order: index };
  });
  // What decides capacity first, then what costs area, then the room left; plan order within each.
  const rank = (row: Row) => (row.effect?.kind === "binding" ? 0 : row.effect?.kind === "street_land" ? 1 : row.effect?.kind === "reserve" ? 2 : 3);
  const sorted = (group: Group) =>
    rows.filter((r) => r.group === group).sort((a, b) => rank(a) - rank(b) || (a.effect?.kind === "reserve" && b.effect?.kind === "reserve" ? a.effect.reserve - b.effect.reserve : 0) || a.order - b.order);
  const [expanded, setExpanded] = useState<Record<Group, boolean>>({ capacity: false, check: false });
  const visible = (group: Group) => sorted(group).filter((r) => !r.done || expanded[group]);
  const navigable = [...visible("capacity"), ...visible("check")];
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const selected = rows.find((r) => r.id === selectedId) ?? navigable[0] ?? rows[0];
  const list = useRef<HTMLDivElement>(null);

  const advance = (from: Row) => {
    const order = navigable.filter((r) => r.id !== from.id);
    const next = order.find((r) => !r.done && navigable.indexOf(r) > navigable.indexOf(from)) ?? order.find((r) => !r.done);
    if (next) setSelectedId(next.id);
  };
  // A plan that names its adoption date dates the figures read from it, including the Baunutzungsplan's building class figures.
  const planDate = (source: string) => (planReference(source) || isBuildingClassSource(source, assessment) ? assessment.planRegime?.adoptedOn ?? null : null);
  /** Marks the row reviewed when its evidence is complete; otherwise opens the editor on what is missing. */
  const accept = (row: Row) => {
    if (disabled) return;
    const { item } = row;
    if (item.kind === "constraint") {
      const key = item.key as keyof Constraints;
      const c = assessment.constraints[key];
      const sourceDate = c?.sourceDate ?? (c ? planDate(c.source) : null);
      if (!c || c.value === null || !c.source.trim() || !sourceDate) return onEdit(item);
      onUpdate({ constraints: { ...assessment.constraints, [key]: { ...c, sourceDate, reviewed: true } } });
    } else if (item.kind === "fact") {
      const key = item.key as keyof NonNullable<Draft["planningFacts"]>;
      const fact = assessment.planningFacts?.[key];
      const sourceDate = fact?.sourceDate ?? (fact ? planDate(fact.source) : null);
      if (!fact?.value || !fact.source.trim() || !sourceDate) return onEdit(item);
      onUpdate({ planningFacts: { ...assessment.planningFacts, [key]: { ...fact, sourceDate, reviewed: true } } });
    } else if (item.kind === "rules") {
      if (rules.buildingForm === "unresolved" || (!rules.heightNotSpecified && !rules.maxHeight) || !rules.source || !rules.sourceDate) return onEdit(item);
      onUpdate({ designRules: { ...rules, reviewed: true } });
    } else {
      // A check needs a decision (confirmed or not applicable) and a note; that happens in the editor.
      return onEdit(item);
    }
    advance(row);
  };
  /** Removes a value read wrongly, so it is entered again instead of reviewed. */
  const reject = (row: Row) => {
    if (disabled) return;
    const { item } = row;
    if (item.kind === "constraint") {
      const key = item.key as keyof Constraints;
      onUpdate({ constraints: { ...assessment.constraints, [key]: { value: null, source: "", sourceDate: null, kind: "assessment", reviewed: false } } });
    } else if (item.kind === "fact") {
      const key = item.key as keyof NonNullable<Draft["planningFacts"]>;
      onUpdate({ planningFacts: { ...assessment.planningFacts, [key]: { value: "", source: "", sourceDate: null, kind: "assessment", reviewed: false } } });
    }
  };
  const canReject = (row: Row) => (row.item.kind === "constraint" || row.item.kind === "fact") && row.value !== null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || !selected) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]")) return;
    const index = navigable.findIndex((r) => r.id === selected.id);
    const move = (to: number) => { const row = navigable[Math.max(0, Math.min(navigable.length - 1, to))]; if (row) setSelectedId(row.id); };
    const key = event.key.toLowerCase();
    if (key === "j" || key === "arrowdown") move(index + 1);
    else if (key === "k" || key === "arrowup") move(index - 1);
    else if (key === "enter" && canWrite && !target.closest("button, a")) accept(selected);
    else if (key === "e") onEdit(selected.item);
    else if (key === "r" && canWrite && canReject(selected)) reject(selected);
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(selected?.id ?? "")}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  const effectText = (effect: LimitEffect | undefined): ReactNode => {
    if (!effect) return null;
    if (effect.kind === "binding") return <><Badge variant="secondary">{label("ReviewBinding")}</Badge>{effect.cost > 0.5 && <span className="tabular-nums" title={label("ReviewBindingCost").replace("{area}", area(effect.cost))}>−{area(effect.cost)}</span>}</>;
    if (effect.kind === "street_land") return <span className="tabular-nums" title={label("ReviewStreetCost").replace("{land}", area(effect.area)).replace("{area}", area(effect.cost))}>−{area(effect.cost)}</span>;
    if (effect.kind === "reserve") return <span className="muted tabular-nums">{label("ReviewReserve").replace("{area}", area(effect.reserve))}</span>;
    return <span className="muted tabular-nums">+{area(effect.area)}</span>;
  };
  const statusIcon = (row: Row) => (row.done ? <Check className="size-icon-sm site-review-done" aria-hidden="true" /> : <Circle className="size-icon-sm muted" aria-hidden="true" />);
  const section = (group: Group, title: string) => {
    const all = sorted(group), done = all.filter((r) => r.done);
    return (
      <section className="site-lr-group" aria-label={title}>
        <header className="site-lr-group-head text-ui-xs muted">
          <span>{title}</span>
          <span className="tabular-nums">{label("ReviewOpenCount").replace("{count}", String(all.length - done.length))}</span>
        </header>
        <ul role="listbox" aria-label={title}>
          {visible(group).map((row) => (
            <li key={row.id} id={`site-lr-${row.id}`} role="option" aria-selected={row.id === selected?.id} data-row={row.id} className="site-lr-row" data-done={row.done || undefined} onClick={() => setSelectedId(row.id)}>
              {statusIcon(row)}
              <span className="site-lr-name">{row.name}</span>
              <span className="site-lr-value muted" title={row.value ?? undefined}>{row.value ?? label(row.item.kind === "check" ? "unresolved" : "ValueMissing")}</span>
              <span className="site-lr-effect">{effectText(row.effect)}</span>
            </li>
          ))}
        </ul>
        {done.length > 0 && (
          <button type="button" className="site-lr-done text-ui-xs muted" aria-expanded={expanded[group]} onClick={() => setExpanded((e) => ({ ...e, [group]: !e[group] }))}>
            {expanded[group] ? <ChevronDown className="size-icon-sm" aria-hidden="true" /> : <ChevronRight className="size-icon-sm" aria-hidden="true" />}
            {label(expanded[group] ? "ReviewHideDone" : "ReviewShowDone").replace("{count}", String(done.length)).replace("{names}", done.map((r) => r.name).join(", "))}
          </button>
        )}
      </section>
    );
  };

  const baseline = result?.baseline;
  const total = rows.length, doneCount = rows.filter((r) => r.done).length;
  const bindingNames = baseline ? baseline.bindingConstraints.map((key) => label(key)).join(", ") : "";
  return (
    <div className="site-lr">
      <div className="site-lr-head">
        {baseline ? (
          <p className="site-lr-capacity">
            <strong className="tabular-nums">{area(baseline.grossFloorArea)} BGF</strong>{" "}
            <span className="muted">{label("ReviewCapacity").replace("{limits}", bindingNames)}</span>
          </p>
        ) : (
          <p className="site-lr-capacity muted">{label("ReviewCapacityOpen")}</p>
        )}
        <span className="site-lr-progress text-ui-xs muted tabular-nums">
          <meter min={0} max={total} value={doneCount} aria-label={label("ReviewProgress")} />
          {label("ReviewProgressText").replace("{done}", String(doneCount)).replace("{total}", String(total))}
        </span>
      </div>
      <div className="site-lr-body">
        {selected && <EvidencePane key={selected.id} projectId={projectId} origin={origin} row={selected} assessment={assessment} label={label} canReject={canReject(selected)} disabled={disabled} canWrite={canWrite} effect={effectText(selected.effect)} onAccept={() => accept(selected)} onEdit={() => onEdit(selected.item)} onReject={() => reject(selected)} />}
        <div className="site-lr-list" ref={list} tabIndex={0} onKeyDown={onKeyDown} aria-label={label("ReviewListLabel")} aria-activedescendant={selected ? `site-lr-${selected.id}` : undefined}>
          {section("capacity", label("ReviewGroupCapacity"))}
          {section("check", label("ReviewGroupCheck"))}
          {scenarios.length > 0 && <Scenarios scenarios={scenarios} area={area} number={number} label={label} />}
          <SiteTasks projectId={projectId} input={input} label={label} canWrite={canWrite} />
        </div>
      </div>
      <p className="site-lr-keys text-ui-2xs muted" aria-hidden="true">
        <span><kbd>J</kbd><kbd>K</kbd>{label("ReviewKeyMove")}</span>
        <span><kbd>↵</kbd>{label("ReviewAccept")}</span>
        <span><kbd>E</kbd>{label("ReviewEdit")}</span>
        <span><kbd>R</kbd>{label("ReviewReject")}</span>
      </p>
    </div>
  );
}

function EvidencePane({ projectId, origin: siteOrigin, row, assessment, label, canReject, disabled, canWrite, effect, onAccept, onEdit, onReject }: {
  projectId: string;
  origin: [number, number] | null;
  row: Row;
  assessment: Draft;
  label: (key: string) => string;
  canReject: boolean;
  disabled: boolean;
  canWrite: boolean;
  effect: ReactNode;
  onAccept: () => void;
  onEdit: () => void;
  onReject: () => void;
}) {
  const reference = planReference(row.source);
  const origin = assessment.planRegime?.regime === "baunutzungsplan" ? siteOrigin : null;
  const bnp = origin && isBuildingClassSource(row.source, assessment) ? bnpMapUrl(origin) : null;
  const overlay = assessment.geometry?.planOverlay;
  const page = reference ?? (overlay ? { versionId: overlay.fileVersionId, page: overlay.page, quote: "" } : null);
  const focus = MAP_FOCUS[row.id];
  const geometry = assessment.geometry?.parcel ? assessment.geometry : null;
  const [mode, setMode] = useState<Evidence>("auto");
  // The cited page proves a value read from the plan; places on the site read better on the site plan.
  const hasPlan = !!page || !!bnp;
  const shown: "plan" | "map" | null = mode === "plan" && hasPlan ? "plan" : mode === "map" && geometry ? "map" : reference || bnp ? "plan" : focus && geometry ? "map" : hasPlan ? "plan" : geometry ? "map" : null;
  const sourceText = reference ? null : row.source;
  return (
    <div className="site-lr-evidence">
      <Segmented
        value={mode}
        onChange={(value) => setMode(value as Evidence)}
        items={[
          { value: "auto", label: label("ReviewEvidenceAuto") },
          { value: "plan", label: label("ReviewEvidencePlan"), disabled: !hasPlan },
          { value: "map", label: label("ReviewEvidenceMap"), disabled: !geometry },
        ]}
      />
      <div className="site-lr-figure">
        {shown === "plan" && bnp && (
          <div className="site-regime-map-frame site-lr-bnp">
            <img src={bnp} alt={label("RegimeBnpMap")} width={600} height={400} />
            <span className="site-regime-marker" aria-hidden="true" />
          </div>
        )}
        {shown === "plan" && !bnp && page && <PlanPage projectId={projectId} versionId={page.versionId} page={page.page} label={label} />}
        {shown === "map" && geometry && <SiteMiniPlan geometry={geometry} focus={focus ?? "parcel"} label={label("ReviewEvidenceMap")} />}
        {!shown && <p className="muted text-ui-xs">{label("ReviewNoEvidence")}</p>}
      </div>
      <div className="site-lr-detail">
        <div className="site-lr-title">
          <h3 className="text-ui">{row.name}</h3>
          <Badge variant="outline">{label(row.status)}</Badge>
        </div>
        {reference?.quote && <blockquote className="site-lr-quote">„{reference.quote}“</blockquote>}
        {reference && <p className="muted text-ui-xs">{label("ReviewPage").replace("{page}", String(reference.page))}</p>}
        {sourceText && <p className="muted text-ui-xs site-lr-source" title={sourceText}>{sourceText}</p>}
        <dl className="site-lr-facts text-ui-sm">
          <div><dt className="muted text-ui-xs">{label("Value")}</dt><dd>{row.value ?? label("ValueMissing")}</dd></div>
          {effect && <div><dt className="muted text-ui-xs">{label("ReviewEffect")}</dt><dd className="site-lr-effect">{effect}</dd></div>}
        </dl>
        <div className="site-lr-actions">
          {canWrite ? (
            <>
              <Button size="sm" disabled={disabled} onClick={onAccept}>{label(row.item.kind === "check" ? "ReviewDecide" : "ReviewAccept")}<kbd>↵</kbd></Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={onEdit}>{label("ReviewEdit")}<kbd>E</kbd></Button>
              {canReject && <Button size="sm" variant="ghost" disabled={disabled} title={label("ReviewRejectHint")} onClick={onReject}><X className="size-icon-sm" aria-hidden="true" />{label("ReviewReject")}<kbd>R</kbd></Button>}
            </>
          ) : (
            // Read-only members open the same panel to read the evidence.
            <Button size="sm" variant="outline" onClick={onEdit}>{label("View")}<kbd>E</kbd></Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The cited plan page, rendered by the shared PDF viewer; PDF.js loads only when a page is shown. */
function PlanPage({ projectId, versionId, page, label }: { projectId: string; versionId: string; page: number; label: (key: string) => string }) {
  const sources = useApi(`/feasibility/projects/${projectId}/evidence`);
  const source = (sources.data as { sources: EvidenceSource[] } | undefined)?.sources?.find((s) => s.versionId === versionId);
  const [Renderer, setRenderer] = useState<typeof PdfEvidenceRenderer>();
  useEffect(() => {
    void import("../building-model/pdf-evidence-renderer").then((module) => setRenderer(() => module.PdfEvidenceRenderer));
  }, []);
  if (!source || !Renderer) return <p className="muted text-ui-xs">{label("ReviewPlanLoading")}</p>;
  return (
    <Renderer
      projectId={projectId}
      evidence={{ fileId: source.fileId, fileName: source.name, version: source.version, pageCount: source.pages }}
      page={page}
      regions={[]}
      layerVisibility={EMPTY_LAYERS}
      onLayers={() => {}}
      onSelect={() => {}}
      tool="pan"
      labels={{ empty: label("ReviewPlanLoading"), loading: label("ReviewPlanLoading"), region: label("ReviewEvidencePlan"), zoom: label("ReviewZoom"), zoomIn: label("ReviewZoomIn"), zoomOut: label("ReviewZoomOut"), fit: label("ReviewZoomFit") }}
    />
  );
}

function Scenarios({ scenarios, area, number, label }: { scenarios: ReturnType<typeof deviationScenarios>; area: (n: number) => string; number: (n: number) => string; label: (key: string) => string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="site-lr-group" aria-label={label("ReviewGroupDeviations")}>
      <header className="site-lr-group-head text-ui-xs muted"><span>{label("ReviewGroupDeviations")}</span><span>{label("ReviewDeviationGain")}</span></header>
      <ul>
        {scenarios.map((s) => {
          const change = [s.change.maxFullStoreys !== undefined && label("ReviewChangeStoreys").replace("{n}", String(s.change.maxFullStoreys)), s.change.gfz !== undefined && `GFZ ${number(s.change.gfz)}`, s.change.grz !== undefined && `GRZ ${number(s.change.grz)}`].filter(Boolean).join(", ");
          const expanded = open === s.route;
          return (
            <li key={s.route} className="site-lr-scenario">
              <button type="button" className="site-lr-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : s.route)}>
                {expanded ? <ChevronDown className="size-icon-sm muted" aria-hidden="true" /> : <ChevronRight className="size-icon-sm muted" aria-hidden="true" />}
                <span className="site-lr-name">{label(`ReviewRoute_${s.route}`)}</span>
                <span className="site-lr-value muted">{change}</span>
                <span className="site-lr-effect tabular-nums">+{area(s.gain)}</span>
              </button>
              {expanded && (
                <div className="site-lr-scenario-detail text-ui-xs">
                  <p>
                    <Badge variant="outline">{label(`ReviewOutlook_${s.outlook}`)}</Badge>{" "}
                    <span className="muted">{label("ReviewMonths").replace("{from}", String(s.months[0])).replace("{to}", String(s.months[1]))} · {area(s.grossFloorArea)} BGF · {s.citation}</span>
                  </p>
                  <ul className="site-lr-conditions">{s.conditions.map((c) => <li key={c}>{label(`ReviewCondition_${c}`)}</li>)}</ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted text-ui-2xs">{label("ReviewDeviationHint")}</p>
    </section>
  );
}

/** Land-register enquiries as project planning items in the Plot phase; created once per project and task. */
function SiteTasks({ projectId, input, label, canWrite }: { projectId: string; input: SiteAssessmentInput; label: (key: string) => string; canWrite: boolean }) {
  const proposals = siteTaskProposals(input);
  const path = `/projects/${encodeURIComponent(projectId)}/planning`;
  // Same query key as the project overview, so a created task shows there without another request.
  const plan = useQuery({ queryKey: [path], queryFn: () => api<ProjectPlanning>(path), staleTime: 30_000, enabled: proposals.length > 0 });
  const [ids, setIds] = useState<Partial<Record<SiteTaskKey, string>>>({});
  useEffect(() => {
    let active = true;
    void Promise.all(proposals.map(async (p) => [p.key, await taskId(projectId, p.key)] as const)).then((pairs) => active && setIds(Object.fromEntries(pairs)));
    return () => { active = false; };
  }, [projectId, proposals.map((p) => p.key).join()]);
  const create = useMutation({
    mutationFn: async (key: SiteTaskKey) => {
      const current = await queryClient.fetchQuery({ queryKey: [path], queryFn: () => api<ProjectPlanning>(path), staleTime: 0 });
      const id = ids[key]!;
      if (current.items.some((item) => item.id === id)) return current;
      const proposal = proposals.find((p) => p.key === key)!;
      const item: ProjectPlanningItem = {
        id, title: label(`ReviewTask_${key}`), phase: "plot", discipline: "coordination", kind: "deliverable", status: "open", owner: "", dueDate: null,
        notes: `${label(`ReviewTaskReason_${proposal.reason}`)}\n\n${label("ReviewTaskOrigin")}`, module: "feasibility", dependsOn: [], archived: false,
      };
      return api<ProjectPlanning>(path, { expectedRevision: current.revision, currentPhase: current.currentPhase, items: [...current.items, item] }, "PUT");
    },
    onSuccess: (data) => queryClient.setQueryData([path], data),
  });
  if (!proposals.length) return null;
  const existing = new Map((plan.data?.items ?? []).map((item) => [item.id, item]));
  return (
    <section className="site-lr-group" aria-label={label("ReviewGroupTasks")}>
      <header className="site-lr-group-head text-ui-xs muted"><span>{label("ReviewGroupTasks")}</span></header>
      <ul>
        {proposals.map((p) => {
          const id = ids[p.key], item = id ? existing.get(id) : undefined;
          return (
            <li key={p.key} className="site-lr-task">
              <div>
                <span className="text-ui-sm">{label(`ReviewTask_${p.key}`)}</span>
                <span className="muted text-ui-xs">{label(`ReviewTaskReason_${p.reason}`)}</span>
              </div>
              {item ? (
                <Link className="text-ui-xs" to={`/projects/${projectId}?view=overview&phase=plot&discipline=coordination&planningItem=${item.id}`}>
                  <Badge variant="outline">{label(item.status === "done" ? "ReviewTaskDone" : "ReviewTaskCreated")}</Badge>
                </Link>
              ) : canWrite ? (
                <Button size="sm" variant="outline" disabled={!id || !plan.data || create.isPending} onClick={() => create.mutate(p.key)}>{label("ReviewTaskCreate")}</Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {create.error && <Callout tone="error">{create.error instanceof ApiError && create.error.status === 409 ? label("ReviewTaskConflict") : (create.error as Error).message}</Callout>}
    </section>
  );
}
