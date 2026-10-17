import { Fragment, useState } from "react";
import { componentDataRequest, regulatoryBasisGaps, regulatoryBasisKeys, soundInsulationChecks, type BuildingComponentRecord, type ComponentRequestGroup } from "@richtfest/shared";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { fieldLabel, optionLabel, PropertyRow, regionComponentType, StatusLine, type ComponentPropertySave } from "./component-properties";
import type { BuildingComponentPropertyState, BuildingRegion } from "./types";

type T = ReturnType<typeof useT>;

export const componentRecord = (region: BuildingRegion): BuildingComponentRecord => ({
  id: region.id, componentType: regionComponentType(region),
  properties: Object.fromEntries(Object.entries(region.componentProperties ?? {}).map(([key, state]) => [key, { value: state.value, unit: state.unit, reviewStatus: state.reviewStatus, provenance: state.provenance }])),
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
    + ` (${entry.inferred ? `${t("buildingSoundFromPlan")}, ` : ""}${countLabel(group.componentType, entry.count, t)})`));
  return [
    ...(missing.length ? [`${t("buildingSoundProvide")}: ${missing.map((field) => `${fieldLabel(field.field, t)}${field.missing < group.count ? ` (${field.missing}/${group.count})` : ""}`).join(", ")}`] : []),
    ...(confirm.length ? [`${t("buildingSoundConfirm")}: ${confirm.join("; ")}`] : []),
  ];
}

/** Plain text for an email to the architect or client, grouped the way they answer. */
export function dataRequestText(groups: ComponentRequestGroup[], t: T) {
  return [t("buildingSoundRequestIntro"), ...groups.map((group) => [`${groupLabel(group, t)} (${groupCount(group, t)})`, ...requestLines(group, t).map((line) => `- ${line}`)].join("\n"))].join("\n\n");
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
export function DataRequest({ components, t }: { components: BuildingRegion[]; t: T }) {
  const groups = componentDataRequest(components.map(componentRecord));
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(dataRequestText(groups, t)); setCopied(true); };
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
    </> : <p className="muted text-ui-2xs">{t("buildingSoundNothingToRequest")}</p>}
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

/** Which law and editions apply, checked first: federal state, Bebauungsplan, Landesbauordnung, VVTB and DIN 4109. Approving a value confirms it. */
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
  </>;
}
