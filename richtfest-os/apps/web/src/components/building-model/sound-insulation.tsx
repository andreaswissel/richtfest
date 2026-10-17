import { Fragment, useState } from "react";
import { componentDataRequest, soundInsulationChecks, type BuildingComponentRecord, type ComponentRequestGroup } from "@richtfest/shared";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { fieldLabel, optionLabel, PropertyRow, regionComponentType, type ComponentPropertySave } from "./component-properties";
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
