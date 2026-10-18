import { Fragment, useMemo } from "react";
import { zoningChecks, zoningLimits, type ZoningCheck as ZoningCheckResult, type ZoningInputGap } from "@richtfest/shared";
import { useT } from "../../i18n";
import { Badge } from "../ui/primitives";
import { fieldLabel, PropertyRow, type ComponentPropertySave } from "./component-properties";
import type { BuildingComponentPropertyState, BuildingModel } from "./types";

type T = ReturnType<typeof useT>;
type States = Record<string, BuildingComponentPropertyState>;
const plain = (states: States | undefined) => Object.fromEntries(Object.entries(states ?? {}).map(([key, state]) => [key, { value: state.value, reviewStatus: state.reviewStatus }]));
const ratio = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const checkValue = (check: ZoningCheckResult, value: number | null) => value === null ? "–" : check.key === "fullStoreys" ? String(value) : ratio(value);
const checkLabel = (check: ZoningCheckResult, t: T) => check.key === "grz" ? "GRZ" : check.key === "gfz" ? "GFZ" : t("buildingZoningFullStoreys");

/** Live checks from the model view, using the same shared arithmetic as the agent context. */
export function useZoningChecks(model: Pick<BuildingModel, "buildings" | "storeys">) {
  return useMemo(() => {
    const site = model.buildings[0];
    const buildings = model.buildings.filter((building) => building.constructionState !== "demolished");
    const active = new Set(buildings.map((building) => building.id));
    return zoningChecks({ limits: zoningLimits(plain(site?.componentProperties)), site: site ? { id: site.id, properties: plain(site.componentProperties) } : null,
      buildings: buildings.map((building) => ({ id: building.id, properties: plain(building.componentProperties) })),
      storeys: model.storeys.filter((storey) => !storey.buildingId || active.has(storey.buildingId)).map((storey) => ({ id: storey.id, buildingId: storey.buildingId, properties: plain(storey.componentProperties) })) });
  }, [model]);
}

/**
 * GRZ, GFZ and Vollgeschosse against the approved Bebauungsplan limits. Inputs
 * are entered and approved here; whether a storey is a Vollgeschoss is the
 * planner's call under the Landesbauordnung. Incomplete checks name what is missing.
 */
export function ZoningCheck({ model, storeyLabel, t, pending, onSaveBuilding, onSaveStorey, onReview }: {
  model: Pick<BuildingModel, "buildings" | "storeys">; storeyLabel: (storeyId: string) => string; t: T; pending: boolean;
  onSaveBuilding: (buildingId: string, save: ComponentPropertySave) => void; onSaveStorey: (storeyId: string, save: ComponentPropertySave) => void;
  onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void;
}) {
  const checks = useZoningChecks(model);
  const site = model.buildings[0];
  if (!site) return null;
  const buildings = model.buildings.filter((building) => building.constructionState !== "demolished");
  const active = new Set(buildings.map((building) => building.id));
  const storeys = model.storeys.filter((storey) => !storey.buildingId || active.has(storey.buildingId));
  const entityName = (gap: ZoningInputGap) => gap.entityType === "storey" ? storeyLabel(gap.entityId) : model.buildings.length > 1 ? model.buildings.find((building) => building.id === gap.entityId)?.name : null;
  const gapText = (gaps: ZoningInputGap[]) => gaps.slice(0, 4).map((gap) => `${fieldLabel(gap.field, t)}${entityName(gap) ? ` (${entityName(gap)})` : ""}`).join(", ") + (gaps.length > 4 ? ` +${gaps.length - 4}` : "");
  const row = (key: string, state: BuildingComponentPropertyState | undefined, onSave: (save: ComponentPropertySave) => void) =>
    <PropertyRow key={key} propertyKey={key} state={state} t={t} pending={pending} onSave={onSave} onReview={(decision) => state && onReview(state, decision)} />;
  return <>
    <dl className="building-model-component-rows">
      {row("parcelArea", site.componentProperties.parcelArea, (save) => onSaveBuilding(site.id, save))}
      {buildings.map((building) => <Fragment key={building.id}>
        {buildings.length > 1 && <><dt className="building-model-request-group">{building.name}</dt><dd /></>}
        {row("footprintArea", building.componentProperties.footprintArea, (save) => onSaveBuilding(building.id, save))}
      </Fragment>)}
      {storeys.map((storey) => <Fragment key={storey.id}>
        <dt className="building-model-request-group">{storeyLabel(storey.id)}</dt><dd />
        {row("fullStorey", storey.componentProperties?.fullStorey, (save) => onSaveStorey(storey.id, save))}
        {storey.componentProperties?.fullStorey?.value === "full" && row("grossFloorArea", storey.componentProperties?.grossFloorArea, (save) => onSaveStorey(storey.id, save))}
      </Fragment>)}
    </dl>
    <p className="muted text-ui-2xs">{t("buildingZoningHintCheck")}</p>
    <ul className="building-model-zoning-results" aria-label={t("buildingZoningCheck")}>
      {checks.map((check) => <li key={check.key} className="building-model-zoning-result">
        <span className="font-medium">{checkLabel(check, t)}</span>
        <span>{checkValue(check, check.actual)} / {check.limit === null ? t("buildingZoningNoLimit") : checkValue(check, check.limit)}</span>
        <Badge variant={check.status === "exceeds" ? "destructive" : check.status === "within" ? "secondary" : "outline"}>
          {check.status === "exceeds" ? t("buildingZoningExceeds") : check.status === "within" ? t("buildingZoningWithin") : t("buildingZoningIncomplete")}
        </Badge>
        {check.status === "incomplete" && <span className="muted text-ui-2xs">{check.limit === null ? t("buildingZoningApproveLimit") : `${t("buildingZoningOpen")}: ${gapText(check.gaps)}`}</span>}
      </li>)}
    </ul>
  </>;
}
