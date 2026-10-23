import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { componentDataRequest, developmentPlanZoningKeys, regulatoryBasisGaps, regulatoryBasisKeys, soundInsulationChecks, type BuildingComponentRecord, type ComponentRequestGroup, type DataRequestProgress } from "@richtfest/shared";
import { BUILDING_CODES, type Bundesland } from "@richtfest/shared/building-codes";
import type { BuildingAddressStateSuggestion, SiteAssessmentInput } from "@richtfest/shared";
import { ArrowUpRight, Check, CircleDashed } from "lucide-react";
import { useT } from "../../i18n";
import { useApi } from "../../query";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { fieldLabel, optionLabel, PropertyRow, regionComponentType, StatusLine, type ComponentPropertySave } from "./component-properties";
import { InputSourceHelp } from "./input-sources";
import type { BuildingComponentPropertyState, BuildingRegion } from "./types";
import { inquiryLink, type InquirySummary } from "../inquiries/types";
import { inquiryStatusLabel } from "../inquiries/labels";

const formatDate = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(); };

type T = ReturnType<typeof useT>;

export const componentRecord = (region: BuildingRegion): BuildingComponentRecord => ({
  id: region.id, componentType: regionComponentType(region),
  properties: Object.fromEntries(Object.entries(region.componentProperties ?? {}).map(([key, state]) => [key, { value: state.value, unit: state.unit, reviewStatus: state.reviewStatus, provenance: state.provenance, evidenceQuote: state.evidenceQuote, evidenceKind: state.evidenceKind }])),
});

const groupLabel = (group: ComponentRequestGroup, t: T) => group.componentType === "ceiling" ? t("buildingSoundCeilings")
  : group.wallRole ? optionLabel("wallRole", group.wallRole, t) : t("buildingSoundWallsWithoutRole");
const countLabel = (componentType: "wall" | "ceiling", count: number, t: T) => count === 1 ? t(componentType === "ceiling" ? "buildingSoundCeilingOne" : "buildingSoundWallOne")
  : (componentType === "ceiling" ? t("buildingSoundCeilingCount") : t("buildingComponentWallCount")).replace("{count}", String(count));
const groupCount = (group: ComponentRequestGroup, t: T) => countLabel(group.componentType, group.count, t);
const valueText = (field: string, value: unknown, unit: string | null, t: T) => field === "construction" ? optionLabel(field, String(value), t) : `${String(value)}${unit ? ` ${unit}` : ""}`;

/** One line per thing to ask: what to provide, and which values to confirm. */
export function requestLines(group: ComponentRequestGroup, t: T) {
  const missing = group.fields.filter((field) => field.missing > 0);
  const confirm = group.fields.flatMap((field) => field.unconfirmed.map((entry) => `${fieldLabel(field.field, t)} ${valueText(field.field, entry.value, entry.unit, t)}`
    + ` (${entry.origin === "plan" ? `${t("buildingSoundFromPlan")}, ` : entry.origin === "document" ? `${t("buildingSoundFromDocument")}, ` : entry.origin === "correspondence" ? `${t("buildingSoundFromReply")}, ` : ""}${countLabel(group.componentType, entry.count, t)})`));
  return [
    ...(missing.length ? [`${t("buildingSoundProvide")}: ${missing.map((field) => `${fieldLabel(field.field, t)}${field.missing < group.count ? ` (${field.missing}/${group.count})` : ""}`).join(", ")}`] : []),
    ...(confirm.length ? [`${t("buildingSoundConfirm")}: ${confirm.join("; ")}`] : []),
  ];
}

/** Plain text for an email to the architect or client, grouped the way they answer. */
export function dataRequestText(groups: ComponentRequestGroup[], t: T, intro = t("buildingSoundRequestIntro")) {
  return [intro, ...groups.map((group) => [`${groupLabel(group, t)} (${groupCount(group, t)})`, ...requestLines(group, t).map((line) => `- ${line}`)].join("\n"))].join("\n\n");
}

/**
 * Model-level sound insulation preparation: the agreed requirement level, the
 * separating components to verify and what to ask the architect. It never
 * calculates; the verification needs a validated DIN 4109-2 tool.
 */
export function SoundInsulationOverview({ components, level, t, pending, onLevel, onReviewLevel, derive }: {
  components: BuildingRegion[]; level?: BuildingComponentPropertyState; t: T; pending: boolean;
  onLevel?: (save: ComponentPropertySave) => void; onReviewLevel: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void;
  derive: { pending: boolean; result?: { walls: number; ceilings?: number; roles: number }; onDerive: () => void };
}) {
  const records = components.map(componentRecord);
  const checks = soundInsulationChecks(records);
  const byKind = new Map<string, number>();
  for (const check of checks) { const key = check.componentType === "ceiling" ? t("buildingSoundCeilings") : optionLabel("wallRole", check.wallRole!, t); byKind.set(key, (byKind.get(key) ?? 0) + 1); }
  return <>
    <dl className="building-model-component-rows">
      {onLevel && <PropertyRow propertyKey="soundInsulationLevel" state={level} t={t} pending={pending} onSave={onLevel} onReview={(decision) => level && onReviewLevel(level, decision)} />}
      <dt>{t("buildingSoundChecks")}</dt>
      <dd className="building-model-stack">
        <span>{t("buildingSoundChecksSummary").replace("{total}", String(checks.length)).replace("{ready}", String(checks.filter((check) => check.ready).length))}</span>
        {byKind.size > 0 && <span className="muted text-ui-2xs">{[...byKind].map(([label, count]) => `${label} ${count}`).join(" · ")}</span>}
      </dd>
      <dt>{t("buildingSoundCalculation")}</dt>
      <dd className="muted">{t("buildingSoundCalculationUnavailable")}</dd>
    </dl>
    <div className="building-model-component-derive">
      <Button size="xs" variant="outline" disabled={derive.pending} onClick={derive.onDerive}>{t("buildingComponentDeriveWallRoles")}</Button>
      <p className="muted text-ui-2xs" role="status">{derive.result ? t("buildingSoundDeriveResult").replace("{walls}", String(derive.result.walls)).replace("{roles}", String(derive.result.roles)).replace("{ceilings}", String(derive.result.ceilings ?? 0))
        : t("buildingSoundDeriveHint")}</p>
    </div>
  </>;
}

/** What still has to be asked of the architect or client, per wall type and for ceilings, ready to paste into an email. */
/** What to ask the architect, copied as text or opened as an inquiry that tracks replies until every item is answered. */
export function DataRequest({ projectId, components, inquiries, t, pending, onCreate }: { projectId: string; components: BuildingRegion[]; inquiries: InquirySummary[]; t: T; pending: boolean;
  onCreate: (counterpart: string, body: string) => void }) {
  const [counterpart, setCounterpart] = useState("");
  const groups = componentDataRequest(components.map(componentRecord));
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(dataRequestText(groups, t)); setCopied(true); };
  const open = inquiries.filter((inquiry) => inquiry.kind === "component_data" && inquiry.status !== "closed");
  return <>
    {groups.length ? <>
      <dl className="building-model-component-rows">
        {groups.map((group) => <Fragment key={`${group.componentType}:${group.wallRole}`}>
          <dt className="building-model-request-group">{groupLabel(group, t)}<span className="muted text-ui-2xs">{groupCount(group, t)}</span></dt>
          <dd className="building-model-stack">{requestLines(group, t).map((line) => <span key={line}>{line}</span>)}</dd>
        </Fragment>)}
      </dl>
      <div className="building-model-component-derive">
        <Button size="xs" variant="outline" onClick={() => void copy()}>{t("buildingSoundCopyRequest")}</Button>
        <p className="muted text-ui-2xs" role="status">{copied ? t("buildingSoundCopied") : t("buildingSoundRequestHint")}</p>
      </div>
      <form className="building-model-description-row" onSubmit={(event) => { event.preventDefault(); if (counterpart.trim()) { onCreate(counterpart.trim(), dataRequestText(groups, t)); setCounterpart(""); } }}>
        <Input aria-label={t("buildingRequestRecipient")} placeholder={t("buildingRequestRecipient")} value={counterpart} disabled={pending} onChange={(event) => setCounterpart(event.target.value)} />
        <Button size="xs" variant="outline" type="submit" disabled={pending || !counterpart.trim()}>{t("buildingRequestCreate")}</Button>
      </form>
    </> : <p className="muted text-ui-2xs">{t("buildingSoundNothingToRequest")}</p>}
    {open.length > 0 && <dl className="building-model-component-rows">
      {open.map((inquiry) => <Fragment key={inquiry.id}>
        <dt className="building-model-request-group"><Link to={inquiryLink(projectId, inquiry.id)}>{inquiry.counterpart}</Link><span className="muted text-ui-2xs">{inquiryStatusLabel(inquiry.status, t)} · {formatDate(inquiry.updatedAt)}</span></dt>
        <dd className="building-model-stack">
          {inquiry.progress && <span>{t("buildingRequestProgress").replace("{answered}", String(inquiry.progress.answered)).replace("{total}", String(inquiry.progress.total))}</span>}
          {(inquiry.progress as DataRequestProgress | null)?.outstanding.map((group) => <span key={`${group.componentType}:${group.wallRole}`} className="muted text-ui-2xs">{groupLabel(group, t)}: {group.fields.map((field) => fieldLabel(field.field, t)).join(", ")}</span>)}
        </dd>
      </Fragment>)}
    </dl>}
  </>;
}

/** "EG", "1. OG", "UG" style label for a storey level. */
export const storeyLevelLabel = (level: number, t: T) => level === 0 ? t("buildingStoreyGround")
  : (level > 0 ? t("buildingStoreyUpper") : t("buildingStoreyBasement")).replaceAll("{n}", String(Math.abs(level)));
const levelOptions = Array.from({ length: 16 }, (_, index) => index - 3);

/** Storey levels: read from each plan's title, set by a person when the title does not say. Ceilings use them to find the storey above. */
export function StoreyLevels({ storeys, t, pending, onSave, onReview }: {
  storeys: Array<{ id: string; name?: string; levelIndex?: number | null; componentProperties?: Record<string, BuildingComponentPropertyState> }>; t: T; pending: boolean;
  onSave: (storeyId: string, level: number | null) => void; onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void;
}) {
  if (!storeys.length) return null;
  return <>
    <dl className="building-model-component-rows">
      {storeys.map((storey) => {
        const state = storey.componentProperties?.level;
        const value = state && state.reviewStatus !== "rejected" && typeof state.value === "number" ? state.value : state?.reviewedValue ?? storey.levelIndex ?? null;
        return <Fragment key={storey.id}>
          <dt><span>{storey.name || storey.id}</span>{value === null && <InputSourceHelp field="level" label={`${t("buildingStoreyLevel")}: ${storey.name || storey.id}`} t={t} />}</dt>
          <dd>
            <NativeSelect aria-label={`${t("buildingStoreyLevel")}: ${storey.name || storey.id}`} value={value === null ? "" : String(value)} disabled={pending}
              onChange={(event) => onSave(storey.id, event.target.value === "" ? null : Number(event.target.value))}>
              <option value="">{t("buildingModelUnknownValue")}</option>
              {levelOptions.map((level) => <option key={level} value={level}>{storeyLevelLabel(level, t)}</option>)}
            </NativeSelect>
            <StatusLine state={state} t={t} pending={pending} onReview={(decision) => state && onReview(state, decision)} />
          </dd>
        </Fragment>;
      })}
    </dl>
    <p className="muted text-ui-2xs">{t("buildingStoreyLevelsHint")}</p>
  </>;
}

/** Building-wide exterior noise inputs and each storey's clear room height; the exterior noise verification reads them. */
export function ExteriorNoiseBasis({ properties, storeys, storeyLabel, t, pending, onSaveBuilding, onSaveStorey, onReview }: { properties: Record<string, BuildingComponentPropertyState>;
  storeys: Array<{ id: string; componentProperties?: Record<string, BuildingComponentPropertyState> }>; storeyLabel: (storeyId: string) => string; t: T; pending: boolean;
  onSaveBuilding: (save: ComponentPropertySave) => void; onSaveStorey: (storeyId: string, save: ComponentPropertySave) => void; onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void }) {
  return <>
    <dl className="building-model-component-rows">
      {["exteriorNoiseApplicability", "exteriorNoiseFlanking"].map((key) =>
        <PropertyRow key={key} propertyKey={key} state={properties[key]} t={t} pending={pending} onSave={onSaveBuilding} onReview={(decision) => properties[key] && onReview(properties[key], decision)} />)}
    </dl>
    {storeys.length > 0 && <dl className="building-model-component-rows">
      {storeys.map((storey) => {
        const state = storey.componentProperties?.clearRoomHeight;
        return <Fragment key={storey.id}>
          <dt><span>{fieldLabel("clearRoomHeight", t)} · {storeyLabel(storey.id)}</span>{(!state || state.value == null || state.reviewStatus === "rejected") && <InputSourceHelp field="clearRoomHeight" label={fieldLabel("clearRoomHeight", t)} t={t} />}</dt>
          <dd><ClearHeight state={state} label={`${fieldLabel("clearRoomHeight", t)} (m): ${storeyLabel(storey.id)}`} t={t} pending={pending}
            onSave={(save) => onSaveStorey(storey.id, save)} onReview={(decision) => state && onReview(state, decision)} /></dd>
        </Fragment>;
      })}
    </dl>}
    <p className="muted text-ui-2xs">{t("buildingExteriorNoiseBasisHint")}</p>
  </>;
}

function ClearHeight({ state, label, t, pending, onSave, onReview }: { state?: BuildingComponentPropertyState; label: string; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (decision: "approved" | "rejected") => void }) {
  const text = state && state.reviewStatus !== "rejected" && state.value != null ? String(state.value) : "";
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const commit = (raw: string) => {
    const trimmed = raw.trim(); if (trimmed === text) return;
    const value = trimmed ? Number(trimmed.replace(",", ".")) : null;
    // Matches the property spec: a clear room height between 1.5 and 20 m.
    if (value !== null && !(Number.isFinite(value) && value >= 1.5 && value <= 20)) { setDraft(text); return; }
    onSave({ key: "clearRoomHeight", value, unit: value === null ? null : "m" });
  };
  return <>
    <Input aria-label={label} value={draft} inputMode="decimal" placeholder={t("buildingModelUnknownValue")} disabled={pending}
      onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); }} />
    <StatusLine state={state} t={t} pending={pending} onReview={onReview} />
  </>;
}

/** The planning basis stays owned by Feasibility. Only explicit, source-backed B-Plan facts are transferable. */
function PlanningContext({ projectId, properties, t, pending, onSave }: { projectId: string; properties: Record<string, BuildingComponentPropertyState>; t: T; pending: boolean; onSave: (save: ComponentPropertySave) => void }) {
  const query = useApi(`/feasibility/projects/${projectId}/site-assessment`);
  const assessment = (query.data as { assessment?: Omit<SiteAssessmentInput, "baseRevision"> & { revision: number } } | undefined)?.assessment;
  const href = `/projects/${projectId}?view=feasibility&study=site&step=limits`;
  const saved = assessment && assessment.revision > 0 ? assessment : undefined;
  const basis = saved?.planningBasis ?? "unresolved";
  const check = saved?.checks.planningBasis;
  const source = check?.source.trim() || saved?.planRegime?.source.trim() || "";
  const confirmed = basis !== "unresolved" && check?.status === "confirmed" && Boolean(check.source.trim() && check.note.trim());
  const basisLabel = t(({ b_plan: "buildingPlanningBPlan", section34: "buildingPlanningSection34", section35: "buildingPlanningSection35", unresolved: "buildingPlanningUnresolved" } as const)[basis]);
  const suggestions: Array<{ key: string; field: string; value: string | number; unit?: string; source: string; reviewed: boolean }> = [];
  const parcel = saved?.constraints.parcelArea;
  // The actual cadastral area is independent of planning basis; an estimated design polygon is not a substitute.
  if (parcel?.kind === "official" && parcel.source.trim() && parcel.value !== null && parcel.value > 0 && parcel.value <= 10_000_000)
    suggestions.push({ key: "parcelArea", field: "constraints.parcelArea", value: parcel.value, unit: "m²", source: [parcel.source, parcel.sourceDate].filter(Boolean).join(" · "), reviewed: parcel.reviewed });
  if (saved && basis === "b_plan") {
    if (source) suggestions.push({ key: "bebauungsplan", field: "planningBasis", value: "applies", source, reviewed: Boolean(confirmed) });
    for (const [key, field] of [["bebauungsplanAreaType", "landUse"], ["bebauungsplanBauweise", "buildingForm"], ["bebauungsplanHeight", "heightRule"]] as const) {
      const fact = saved.planningFacts?.[field];
      if (fact?.kind === "official" && fact.source.trim() && fact.value.trim() && fact.value.length <= 300)
        suggestions.push({ key, field: `planningFacts.${field}`, value: fact.value, source: [fact.source, fact.sourceDate].filter(Boolean).join(" · "), reviewed: fact.reviewed });
    }
    for (const [key, field] of [["bebauungsplanGrz", "grz"], ["bebauungsplanGfz", "gfz"], ["bebauungsplanStoreys", "maxFullStoreys"]] as const) {
      const fact = saved.constraints[field];
      // Neighbourhood comparisons and calculated/estimated design envelopes are not B-Plan limits.
      if (fact.kind === "official" && fact.source.trim() && fact.value !== null)
        suggestions.push({ key, field: `constraints.${field}`, value: String(fact.value), source: [fact.source, fact.sourceDate].filter(Boolean).join(" · "), reviewed: fact.reviewed });
    }
  }
  const current = (key: string) => properties[key]?.reviewStatus === "rejected" ? null : properties[key]?.value;
  return <section className="building-model-planning-context" aria-label={t("buildingPlanningContext")}>
    <div className="building-model-planning-heading">
      <Link to={href} title={source || t("buildingPlanningContext")}><strong>{basisLabel}</strong><ArrowUpRight className="size-icon-sm" /></Link>
      <Badge>{query.isPending ? t("loading") : query.isError ? t("buildingPlanningUnavailable") : confirmed ? t("buildingComponentReviewed") : t("buildingComponentUnreviewed")}</Badge>
    </div>
    <div className="building-model-planning-origin">
      <Link to={href}>{saved?.planRegime?.planName && basis === "b_plan" ? saved.planRegime.planName : t("buildingPlanningContext")}</Link>
      {saved && <span>r{saved.revision}</span>}
      {query.isError && <Button size="xs" variant="ghost" onClick={() => void query.refetch()}>{t("retry")}</Button>}
    </div>
    {suggestions.filter(item => item.key === "parcelArea" || item.key === "bebauungsplan" || current("bebauungsplan") !== "none").map(item => {
      const existing = current(item.key);
      const empty = existing === null || existing === undefined || existing === "";
      const matches = !empty && String(existing) === String(item.value);
      const label = fieldLabel(item.key, t);
      const display = item.key === "bebauungsplan" ? optionLabel(item.key, String(item.value), t) : `${item.value}${item.unit ? ` ${item.unit}` : ""}`;
      return <div className="building-model-planning-suggestion" key={item.key}>
        <span>{label}</span>
        <Link to={href} title={item.source} className="building-model-planning-value">{display}
          {item.reviewed ? <Check className="size-icon-sm" aria-label={t("buildingComponentReviewed")} /> : <CircleDashed className="size-icon-sm" aria-label={t("buildingComponentUnreviewed")} />}
        </Link>
        {empty ? <Button size="xs" variant="outline" disabled={pending} aria-label={`${t("buildingPlanningUse")}: ${label}`} onClick={() => onSave({ key: item.key, value: item.value, unit: item.unit ?? null,
          evidence: [{ kind: "site_assessment", revision: saved!.revision, field: item.field, quote: `r${saved!.revision} · ${item.field}: ${item.value}\n${item.source}`.slice(0, 4000) }] })}>{t("buildingPlanningUse")}</Button>
          : <Badge title={String(existing)}>{t(matches ? "buildingPlanningMatches" : "buildingPlanningDiffers")}</Badge>}
      </div>;
    })}
  </section>;
}

/** Law and editions are confirmed for this project separately from the linked planning assessment. */
export function RegulatoryBasis({ projectId, addressState, properties, t, pending, onSave, onReview }: { projectId?: string; addressState?: BuildingAddressStateSuggestion | null; properties: Record<string, BuildingComponentPropertyState>; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void }) {
  const live = (key: string) => properties[key] && properties[key].reviewStatus !== "rejected" ? properties[key].value : null;
  const state = live("federalState") || addressState?.value;
  const code = BUILDING_CODES[state as Bundesland];
  // Published references, not a claim that this edition applies to the project. Other editions remain enterable.
  // RP: https://www.landesrecht.rlp.de/bsrp/document/VVRP-VVRP000006177
  // BE: https://www.berlin.de/sen/stadt/_assets/service/rechtsvorschriften/bereich-bauen/vvtbblnlesefassung.pdf
  const vvtb = state === "RP" ? ["VV TB RP vom 02.10.2025"] : state === "BE" ? ["VV TB Bln vom 29.04.2026", "VV TB Bln vom 09.04.2025"] : [];
  const suggestions: Record<string, Array<{ value: string; label?: string }>> = {
    stateBuildingCodeEdition: code?.stand ? [{ value: `${code.abbreviation} · ${code.stand}` }] : [],
    vvtbEdition: vvtb.map((value) => ({ value })),
    // Edition cited by the supported exterior-noise methodology; not a default for the regulatory basis.
    din4109Edition: [{ value: "DIN 4109-1:2018-01" }],
    bebauungsplanAreaType: ["WS", "WR", "WA", "WB", "MDW", "MD", "MI", "MU", "MK", "GE", "GI", "SO"].map((value) => ({ value, label: t(`buildingZoningArea${value}` as Parameters<T>[0]) })),
    bebauungsplanBauweise: ["offene Bauweise", "geschlossene Bauweise", "abweichende Bauweise"].map((value, index) => ({ value, label: t((["buildingZoningOpen", "buildingZoningClosed", "buildingZoningDeviating"] as const)[index]!) })),
  };
  const gaps = regulatoryBasisGaps(Object.fromEntries(Object.entries(properties).map(([key, state]) => [key, { value: state.value, reviewStatus: state.reviewStatus }])));
  return <>
    {projectId && <PlanningContext projectId={projectId} properties={properties} t={t} pending={pending} onSave={onSave} />}
    <dl className="building-model-component-rows">
      {regulatoryBasisKeys.filter((key) => key !== "bebauungsplanNoise" || live("bebauungsplan") === "applies").map((key) =>
        <PropertyRow key={key} propertyKey={key} state={properties[key]} addressSuggestion={key === "federalState" ? addressState : undefined} suggestions={suggestions[key]} t={t} pending={pending} onSave={onSave} onReview={(decision) => properties[key] && onReview(properties[key], decision)} />)}
    </dl>
    <details className="muted text-ui-2xs"><summary>{t("buildingPlanningReferences")}</summary><p>{t("buildingRegulatorySuggestionsHint")}{code && <> <a href={code.sourceUrl} target="_blank" rel="noreferrer">{t("buildingRegulatoryCodeSource")}</a></>}</p></details>
    {gaps.length ? <details className="muted text-ui-2xs"><summary>{t("buildingRegulatoryOpen")} · {gaps.length}</summary><ul>{gaps.map(gap => <li key={gap.field}>{fieldLabel(gap.field, t)} · {t(gap.status === "missing" ? "buildingComponentGapMissing" : "buildingRegulatoryUnconfirmed")}</li>)}</ul></details> : <Badge>{t("buildingRegulatoryConfirmed")}</Badge>}
    {live("bebauungsplan") === "applies" && <>
      <p className="text-ui-xs font-medium">{t("buildingZoningTitle")}</p>
      <dl className="building-model-component-rows">
        {developmentPlanZoningKeys.map((key) =>
          <PropertyRow key={key} propertyKey={key} state={properties[key]} suggestions={suggestions[key]} t={t} pending={pending} onSave={onSave} onReview={(decision) => properties[key] && onReview(properties[key], decision)} />)}
      </dl>
      <p className="muted text-ui-2xs">{t("buildingZoningHint")}</p>
    </>}
  </>;
}

export type ComponentSourceDocument = { fileId: string; name: string; sourceVersionId: string; version: number; likelyConstructionDescription: boolean;
  documentType?: { documentType: string | null; provenance: "manual" | "inferred" | null } | null };
export type BebauungsplanReadResult = { statements: unknown[]; summary: string | null; proposals: number; zoning?: { statements: unknown[] } };

/** Reads the noise requirements and the Art und Maß der baulichen Nutzung a Bebauungsplan's text states into the regulatory basis, as quoted proposals. */
export function BebauungsplanReader({ documents, t, pending, result, onRead }: { documents: ComponentSourceDocument[]; t: T; pending: boolean; result?: BebauungsplanReadResult; onRead: (sourceVersionId: string) => void }) {
  const plans = documents.filter((document) => document.documentType?.documentType === "development_plan");
  const [chosen, setChosen] = useState("");
  const selected = plans.find((document) => document.sourceVersionId === chosen) ?? plans[0];
  if (!plans.length) return <p className="muted text-ui-2xs">{t("buildingBebauungsplanNone")}</p>;
  return <div className="building-model-component-derive">
    <div className="building-model-description-row">
      <NativeSelect aria-label={t("buildingBebauungsplanDocument")} value={selected?.sourceVersionId ?? ""} disabled={pending} onChange={(event) => setChosen(event.target.value)}>
        {plans.map((document) => <option key={document.sourceVersionId} value={document.sourceVersionId}>{document.name}</option>)}
      </NativeSelect>
      <Button size="xs" variant="outline" disabled={pending || !selected} onClick={() => selected && onRead(selected.sourceVersionId)}>{t("buildingBebauungsplanRead")}</Button>
    </div>
    <p className="muted text-ui-2xs" role="status">{!result ? t("buildingBebauungsplanHint") : [
      t("buildingBebauungsplanResult").replace("{statements}", String(result.statements.length + (result.zoning?.statements.length ?? 0))).replace("{proposals}", String(result.proposals)),
      ...(result.summary ? [] : [t("buildingBebauungsplanNoNoise")]),
      ...(result.zoning?.statements.length ? [] : [t("buildingBebauungsplanNoZoning")]),
    ].join(" · ")}</p>
  </div>;
}
export type DescriptionReadResult = { statements: number; proposals: number; groups: Array<{ componentType: "wall" | "ceiling"; wallRole: string | null; conflicts: string[]; components: number; proposed: number }> };

/** Reads stated component data from a construction description into unreviewed proposals per wall type. */
export function DescriptionReader({ documents, t, pending, result, onRead }: { documents: ComponentSourceDocument[]; t: T; pending: boolean; result?: DescriptionReadResult; onRead: (sourceVersionId: string) => void }) {
  const [chosen, setChosen] = useState("");
  const selected = documents.find((document) => document.sourceVersionId === chosen) ?? documents[0];
  if (!documents.length) return <p className="muted text-ui-2xs">{t("buildingDescriptionNone")}</p>;
  const groupName = (group: DescriptionReadResult["groups"][number]) => group.componentType === "ceiling" ? t("buildingSoundCeilings") : group.wallRole ? optionLabel("wallRole", group.wallRole, t) : t("buildingSoundWallsWithoutRole");
  const conflicts = result?.groups.filter((group) => group.conflicts.length) ?? [];
  const unmatched = result?.groups.filter((group) => group.components === 0) ?? [];
  return <div className="building-model-component-derive">
    <div className="building-model-description-row">
      <NativeSelect aria-label={t("buildingDescriptionDocument")} value={selected?.sourceVersionId ?? ""} disabled={pending} onChange={(event) => setChosen(event.target.value)}>
        {documents.map((document) => <option key={document.sourceVersionId} value={document.sourceVersionId}>{document.name}{document.likelyConstructionDescription ? ` · ${t("buildingDescriptionLikely")}` : ""}</option>)}
      </NativeSelect>
      <Button size="xs" variant="outline" disabled={pending || !selected} onClick={() => selected && onRead(selected.sourceVersionId)}>{t("buildingDescriptionRead")}</Button>
    </div>
    <p className="muted text-ui-2xs" role="status">{result ? [
      t("buildingDescriptionResult").replace("{statements}", String(result.statements)).replace("{proposals}", String(result.proposals)),
      ...conflicts.map((group) => t("buildingDescriptionConflict").replace("{group}", groupName(group)).replace("{fields}", group.conflicts.map((field) => fieldLabel(field, t)).join(", "))),
      ...unmatched.map((group) => t("buildingDescriptionUnmatched").replace("{group}", groupName(group))),
    ].join(" · ") : t("buildingDescriptionHint")}</p>
  </div>;
}
