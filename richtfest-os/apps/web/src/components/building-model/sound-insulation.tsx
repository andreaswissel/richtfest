import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { componentDataRequest, developmentPlanZoningKeys, regulatoryBasisGaps, regulatoryBasisKeys, soundInsulationChecks, type BuildingComponentRecord, type ComponentRequestGroup, type DataRequestProgress } from "@richtfest/shared";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { Input } from "../ui/input";
import { fieldLabel, optionLabel, PropertyRow, regionComponentType, StatusLine, type ComponentPropertySave } from "./component-properties";
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
  : (level > 0 ? t("buildingStoreyUpper") : t("buildingStoreyBasement")).replace("{n}", String(Math.abs(level)));
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
          <dt>{storey.name || storey.id}</dt>
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

/**
 * Which law and editions apply, checked first: federal state, Bebauungsplan, Landesbauordnung, VVTB and DIN 4109. Approving a value confirms it.
 * When a plan applies, its Art und Maß der baulichen Nutzung follow; they are not part of the sound insulation basis and are not checked yet.
 */
export function RegulatoryBasis({ properties, t, pending, onSave, onReview }: { properties: Record<string, BuildingComponentPropertyState>; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void }) {
  const live = (key: string) => properties[key] && properties[key].reviewStatus !== "rejected" ? properties[key].value : null;
  const gaps = regulatoryBasisGaps(Object.fromEntries(Object.entries(properties).map(([key, state]) => [key, { value: state.value, reviewStatus: state.reviewStatus }])));
  return <>
    <dl className="building-model-component-rows">
      {regulatoryBasisKeys.filter((key) => key !== "bebauungsplanNoise" || live("bebauungsplan") === "applies").map((key) =>
        <PropertyRow key={key} propertyKey={key} state={properties[key]} t={t} pending={pending} onSave={onSave} onReview={(decision) => properties[key] && onReview(properties[key], decision)} />)}
    </dl>
    <p className="muted text-ui-2xs">{gaps.length ? `${t("buildingRegulatoryOpen")}: ${gaps.map((gap) => `${fieldLabel(gap.field, t)} (${gap.status === "missing" ? t("buildingComponentGapMissing") : t("buildingRegulatoryUnconfirmed")})`).join(", ")}` : t("buildingRegulatoryConfirmed")}</p>
    {live("bebauungsplan") === "applies" && <>
      <p className="text-ui-xs font-medium">{t("buildingZoningTitle")}</p>
      <dl className="building-model-component-rows">
        {developmentPlanZoningKeys.map((key) =>
          <PropertyRow key={key} propertyKey={key} state={properties[key]} t={t} pending={pending} onSave={onSave} onReview={(decision) => properties[key] && onReview(properties[key], decision)} />)}
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
