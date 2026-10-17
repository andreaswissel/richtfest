import { Fragment, useEffect, useState } from "react";
import { componentConstructionSchema, componentInputGaps, componentTypeSchema, spaceTypeSchema, wallRoleSchema, type ComponentType } from "@richtfest/shared";
import { X } from "lucide-react";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge } from "../ui/primitives";
import type { BuildingComponentPropertyState, BuildingRegion } from "./types";

type T = ReturnType<typeof useT>;
type Key = Parameters<T>[0];
export type ComponentPropertySave = { key: string; value: string | number | null; unit: string | null };

const enumOptions: Record<string, readonly string[]> = {
  componentType: componentTypeSchema.options, construction: componentConstructionSchema.options,
  wallRole: wallRoleSchema.options, spaceType: spaceTypeSchema.options,
};
const units: Record<string, string> = { thickness: "cm", bulkDensity: "kg/m³" };
const elementKeys = ["componentType", "construction", "material", "thickness", "bulkDensity", "wallRole"];
const roomKeys = ["apartmentUnit", "spaceType"];
const camel = (value: string) => value.replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
const fieldLabel = (key: string, t: T) => t(`buildingComponentField${camel(key)}` as Key);
const optionLabel = (key: string, option: string, t: T) => t(`buildingComponent${camel(key)}${camel(option)}` as Key);

/** The element's component type: an entered value, otherwise implied by an accepted draft wall. */
export function regionComponentType(region: BuildingRegion): ComponentType | null {
  const declared = region.componentProperties?.componentType?.value;
  return typeof declared === "string" ? declared as ComponentType : region.elementKind === "draft_wall" ? "wall" : null;
}

function StatusLine({ state, t, pending, onReview }: { state?: BuildingComponentPropertyState; t: T; pending: boolean; onReview: (decision: "approved" | "rejected") => void }) {
  if (!state) return null;
  const label = state.reviewStatus === "approved" ? t("buildingComponentReviewed")
    : state.reviewStatus === "rejected" ? t("buildingComponentRejected")
    : state.provenance === "inferred" ? t("buildingComponentInferred") : t("buildingComponentUnreviewed");
  return (
    <div className="building-model-component-status">
      <Badge variant={state.reviewStatus === "approved" ? "secondary" : "outline"}>{label}</Badge>
      {state.reviewStatus !== "approved" && state.reviewStatus !== "rejected" && <>
        <Button size="xs" variant="outline" disabled={pending} onClick={() => onReview("approved")}>{t("buildingComponentApprove")}</Button>
        <Button size="icon-xs" variant="ghost" disabled={pending} onClick={() => onReview("rejected")} aria-label={t("buildingComponentReject")} title={t("buildingComponentReject")}><X aria-hidden="true" /></Button>
      </>}
    </div>
  );
}

function PropertyRow({ propertyKey, state, placeholder, t, pending, onSave, onReview }: { propertyKey: string; state?: BuildingComponentPropertyState; placeholder?: string; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (decision: "approved" | "rejected") => void }) {
  const current = state && state.reviewStatus !== "rejected" ? state.value : null;
  const text = current === null || current === undefined ? "" : String(current);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const unit = units[propertyKey] ?? null;
  const label = unit ? `${fieldLabel(propertyKey, t)} (${unit})` : fieldLabel(propertyKey, t);
  const options = enumOptions[propertyKey];
  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === text) return;
    const value = !trimmed ? null : unit ? Number(trimmed.replace(",", ".")) : trimmed;
    if (typeof value === "number" && !(Number.isFinite(value) && value > 0)) { setDraft(text); return; }
    onSave({ key: propertyKey, value, unit: value === null ? null : unit });
  };
  return <>
    <dt>{label}</dt>
    <dd>
      {options
        ? <NativeSelect aria-label={label} value={draft} disabled={pending} onChange={(event) => { setDraft(event.target.value); commit(event.target.value); }}>
            <option value="">{placeholder ? `${t("buildingComponentInferredPrefix")} ${optionLabel(propertyKey, placeholder, t)}` : t("buildingModelUnknownValue")}</option>
            {options.map((option) => <option key={option} value={option}>{optionLabel(propertyKey, option, t)}</option>)}
          </NativeSelect>
        : <Input aria-label={label} value={draft} inputMode={unit ? "decimal" : undefined} placeholder={placeholder || t("buildingModelUnknownValue")} disabled={pending}
            onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); }} />}
      <StatusLine state={state} t={t} pending={pending} onReview={onReview} />
    </dd>
  </>;
}

export type WallRoleDerivation = { pending: boolean; result?: { walls: number; bothSides: number; roles: number; roleProposals: number }; onDerive: () => void };

/** Shared component data for a selected wall/ceiling or room, laid out as property rows. */
export function ComponentProperties({ region, roomNames, t, pending, onSave, onReview, derivation }: { region: BuildingRegion; roomNames: Map<string, string>; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void; derivation?: WallRoleDerivation }) {
  const states = region.componentProperties ?? {};
  const isRoom = region.entityType === "room";
  const componentType = isRoom ? null : regionComponentType(region);
  const gaps = componentInputGaps(componentType, Object.fromEntries(Object.entries(states).map(([key, state]) => [key, { value: state.value, reviewStatus: state.reviewStatus }])));
  const keys = isRoom ? roomKeys : elementKeys.filter((key) => key !== "wallRole" || componentType === "wall");
  const placeholder = (key: string) => key === "componentType" && region.elementKind === "draft_wall" ? "wall"
    : key === "apartmentUnit" ? region.groupLabel || undefined
    // Mirrors the server's inference: a room inside an apartment is an apartment room.
    : key === "spaceType" && (states.apartmentUnit?.value || region.groupLabel) ? "apartment" : undefined;
  const result = derivation?.result;
  return <>
    <dl className="building-model-component-rows">
      {componentType === "wall" && <>
        {(region.separates?.length ? region.separates : [{ side: 0, roomIds: [] }, { side: 1, roomIds: [] }]).map((face) => <Fragment key={face.side}>
          <dt>{t("buildingComponentFace")} {face.side + 1}</dt>
          <dd className={face.roomIds.length ? undefined : "muted"}>{face.roomIds.length ? face.roomIds.map((id) => roomNames.get(id) || id).join(", ") : t("buildingModelUnknownValue")}</dd>
        </Fragment>)}
      </>}
      {keys.map((key) => <PropertyRow key={`${region.id}:${key}`} propertyKey={key} state={states[key]} placeholder={placeholder(key)} t={t} pending={pending}
        onSave={onSave} onReview={(decision) => states[key] && onReview(states[key], decision)} />)}
    </dl>
    {gaps.length > 0 && <p className="muted text-ui-2xs">{t("buildingComponentGaps")}: {gaps.map((gap) => `${fieldLabel(gap.field, t)} (${gap.status === "missing" ? t("buildingComponentGapMissing") : t("buildingComponentGapUnreviewed")})`).join(", ")}</p>}
    {componentType === "wall" && derivation && <div className="building-model-component-derive">
      <Button size="xs" variant="outline" disabled={derivation.pending} onClick={derivation.onDerive}>{t("buildingComponentDeriveWallRoles")}</Button>
      <p className="muted text-ui-2xs" role="status">{result ? t("buildingComponentDeriveResult").replace("{walls}", String(result.walls)).replace("{bothSides}", String(result.bothSides))
        .replace("{roles}", String(result.roles)).replace("{proposals}", String(result.roleProposals)) : t("buildingComponentWallRolesHint")}</p>
    </div>}
  </>;
}
