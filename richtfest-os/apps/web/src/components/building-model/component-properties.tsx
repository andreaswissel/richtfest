import { Fragment, useEffect, useState } from "react";
import { bebauungsplanSchema, componentConstructionSchema, fullStoreySchema, componentInputGaps, componentTypeSchema, elementComponentType, federalStateSchema, soundInsulationLevelSchema, spaceTypeSchema, wallRoleSchema, type ComponentType } from "@richtfest/shared";
import { X } from "lucide-react";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge } from "../ui/primitives";
import type { BuildingComponentPropertyState, BuildingRegion } from "./types";

type T = ReturnType<typeof useT>;
// Statements rather than values: shown in full.
const longText = new Set(["bebauungsplanNoise", "bebauungsplanGrz", "bebauungsplanHeight"]);
type Key = Parameters<T>[0];
export type ComponentPropertySave = { key: string; value: string | number | null; unit: string | null };

const enumOptions: Record<string, readonly string[]> = {
  componentType: componentTypeSchema.options, construction: componentConstructionSchema.options,
  wallRole: wallRoleSchema.options, spaceType: spaceTypeSchema.options, soundInsulationLevel: soundInsulationLevelSchema.options,
  federalState: federalStateSchema.options, bebauungsplan: bebauungsplanSchema.options, fullStorey: fullStoreySchema.options,
  storeyInventory: ["complete", "incomplete"], gfzCountingBasis: ["full_storeys_only", "include_other_storeys"],
};
const units: Record<string, string> = { thickness: "cm", bulkDensity: "kg/m³", parcelArea: "m²", footprintArea: "m²", grossFloorArea: "m²", countableFloorArea: "m²" };
const elementKeys = ["componentType", "construction", "material", "thickness", "bulkDensity", "wallRole"];
const roomKeys = ["apartmentUnit", "spaceType"];
const camel = (value: string) => value.replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
export const fieldLabel = (key: string, t: T) => t(`buildingComponentField${camel(key)}` as Key);
export const optionLabel = (key: string, option: string, t: T) => t(`buildingComponent${camel(key)}${camel(option)}` as Key);

/** The element's component type: an entered value, otherwise implied by an accepted draft wall or a derived ceiling. */
export function regionComponentType(region: BuildingRegion): ComponentType | null {
  return elementComponentType(region.elementKind, region.componentProperties?.componentType?.value);
}

/** Current wall role: the latest non-rejected value, else the last approved one; "none" when unset. */
export const wallRoleOf = (region: BuildingRegion) => {
  const state = region.componentProperties?.wallRole;
  const value = state && state.reviewStatus !== "rejected" ? state.value : state?.reviewedValue;
  return typeof value === "string" ? value : "none";
};

export function StatusLine({ state, t, pending, onReview }: { state?: BuildingComponentPropertyState; t: T; pending: boolean; onReview: (decision: "approved" | "rejected") => void }) {
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

export function PropertyRow({ propertyKey, state, placeholder, t, pending, onSave, onReview }: { propertyKey: string; state?: BuildingComponentPropertyState; placeholder?: string; t: T; pending: boolean;
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
    if (typeof value === "number" && !(Number.isFinite(value) && (propertyKey === "countableFloorArea" ? value >= 0 : value > 0))) { setDraft(text); return; }
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
        : longText.has(propertyKey) ? <Textarea aria-label={label} rows={propertyKey === "bebauungsplanNoise" ? 3 : 2} value={draft} placeholder={placeholder || t("buildingModelUnknownValue")} disabled={pending} title={state?.evidenceQuote ?? undefined}
            onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) commit(event.currentTarget.value); }} />
        : <Input aria-label={label} value={draft} inputMode={unit ? "decimal" : undefined} placeholder={placeholder || t("buildingModelUnknownValue")} disabled={pending} title={state?.evidenceQuote ?? undefined}
            onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); }} />}
      <StatusLine state={state} t={t} pending={pending} onReview={onReview} />
    </dd>
  </>;
}

export type WallRoleDerivation = { pending: boolean; result?: { walls: number; exterior: number; roles: number; roleProposals: number; thicknessProposals: number; ceilings?: number }; onDerive: () => void };
export type WallTypeCopy = { pending: boolean; sameRoleCount: number; result?: { targets: number; updated: Record<string, number>; kept: number }; onCopy: (keys: string[]) => void };
const copyKeys = ["construction", "material", "thickness", "bulkDensity"];

/** Shared component data for a selected wall/ceiling or room, laid out as property rows. */
export function ComponentProperties({ region, roomNames, storeyNames, t, pending, onSave, onReview, derivation, copy }: { region: BuildingRegion; roomNames: Map<string, string>; storeyNames?: Map<string, string>; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void; derivation?: WallRoleDerivation; copy?: WallTypeCopy }) {
  const states = region.componentProperties ?? {};
  const isRoom = region.entityType === "room";
  const componentType = isRoom ? null : regionComponentType(region);
  const gaps = componentInputGaps(componentType, Object.fromEntries(Object.entries(states).map(([key, state]) => [key, { value: state.value, reviewStatus: state.reviewStatus }])));
  const keys = isRoom ? roomKeys : elementKeys.filter((key) => key !== "wallRole" || componentType === "wall");
  const placeholder = (key: string) => key === "componentType" && (region.elementKind === "draft_wall" || region.elementKind === "draft_ceiling") ? regionComponentType(region) ?? undefined
    : key === "apartmentUnit" ? region.groupLabel || undefined
    // Mirrors the server's inference: a room inside an apartment is an apartment room.
    : key === "spaceType" && (states.apartmentUnit?.value || region.groupLabel) ? "apartment" : undefined;
  const result = derivation?.result;
  const roleValue = states.wallRole && states.wallRole.reviewStatus !== "rejected" ? states.wallRole.value : null;
  const filledCopyKeys = copyKeys.filter((key) => { const state = states[key];
    return state && state.value !== null && ((state.reviewStatus !== "rejected" && state.provenance !== "inferred") || state.reviewStatus === "approved" || state.reviewedValue != null); });
  return <>
    <dl className="building-model-component-rows">
      {componentType === "wall" && <>
        {(region.separates?.length ? region.separates : [{ side: 0, roomIds: [] }, { side: 1, roomIds: [] }]).map((face) => <Fragment key={face.side}>
          <dt>{t("buildingComponentFace")} {face.side + 1}</dt>
          <dd className={face.roomIds.length || face.exterior ? undefined : "muted"}>{face.exterior ? t("buildingComponentOutside") : face.roomIds.length ? face.roomIds.map((id) => roomNames.get(id) || id).join(", ") : t("buildingModelUnknownValue")}</dd>
        </Fragment>)}
      </>}
      {componentType === "ceiling" && region.covers && <>
        <dt>{t("buildingComponentOverRooms")}</dt>
        <dd>{region.covers.map((id) => roomNames.get(id) || id).join(", ")}</dd>
        <dt>{t("buildingComponentStoreyAbove")}</dt>
        <dd className={region.underStorey ? undefined : "muted"}>{region.underStorey ? storeyNames?.get(region.underStorey) || region.underStorey : t("buildingComponentStoreyAboveUnknown")}</dd>
      </>}
      {keys.map((key) => <PropertyRow key={`${region.id}:${key}`} propertyKey={key} state={states[key]} placeholder={placeholder(key)} t={t} pending={pending}
        onSave={onSave} onReview={(decision) => states[key] && onReview(states[key], decision)} />)}
    </dl>
    {gaps.length > 0 && <p className="muted text-ui-2xs">{t("buildingComponentGaps")}: {gaps.map((gap) => `${fieldLabel(gap.field, t)} (${gap.status === "missing" ? t("buildingComponentGapMissing") : t("buildingComponentGapUnreviewed")})`).join(", ")}</p>}
    {componentType === "wall" && copy && typeof roleValue === "string" && copy.sameRoleCount > 0 && filledCopyKeys.length > 0 && <div className="building-model-component-derive">
      <Button size="xs" variant="outline" disabled={copy.pending} onClick={() => copy.onCopy(filledCopyKeys)}>
        {t("buildingComponentCopyToRole").replace("{count}", String(copy.sameRoleCount))}
      </Button>
      <p className="muted text-ui-2xs" role="status">{copy.result ? t("buildingComponentCopyResult").replace("{updated}", String(Object.values(copy.result.updated).reduce((sum, count) => sum + count, 0))).replace("{kept}", String(copy.result.kept))
        : t("buildingComponentCopyHint")}</p>
    </div>}
    {(componentType === "wall" || componentType === "ceiling") && derivation && <div className="building-model-component-derive">
      <Button size="xs" variant="outline" disabled={derivation.pending} onClick={derivation.onDerive}>{t("buildingComponentDeriveWallRoles")}</Button>
      <p className="muted text-ui-2xs" role="status">{result ? t("buildingComponentDeriveResult").replace("{walls}", String(result.walls)).replace("{exterior}", String(result.exterior))
        .replace("{roles}", String(result.roles)).replace("{proposals}", String(result.roleProposals)).replace("{thickness}", String(result.thicknessProposals)).replace("{ceilings}", String(result.ceilings ?? 0)) : t("buildingComponentWallRolesHint")}</p>
    </div>}
  </>;
}

type ReviewItem = { propertyId: string; version: number; reviewRevision: number };
export type WallTypeGroup = { value: unknown; unit: string | null; walls: number; approved: number; pending: ReviewItem[] };

/** Current values of one property across walls of one type, grouped by value so outliers stand out. */
export function wallTypeGroups(walls: BuildingRegion[], key: string) {
  const groups = new Map<string, WallTypeGroup>(); let missing = 0;
  for (const wall of walls) {
    const state = wall.componentProperties?.[key];
    if (!state || state.value === null || state.reviewStatus === "rejected") { missing++; continue; }
    const id = JSON.stringify([state.value, state.unit]);
    const group = groups.get(id) ?? { value: state.value, unit: state.unit, walls: 0, approved: 0, pending: [] };
    group.walls++;
    if (state.reviewStatus === "approved") group.approved++;
    else group.pending.push({ propertyId: state.propertyId, version: state.version, reviewRevision: state.reviewRevision });
    groups.set(id, group);
  }
  return { groups: [...groups.values()].sort((a, b) => b.walls - a.walls), missing };
}

const reviewKeys = ["wallRole", "construction", "material", "thickness", "bulkDensity"];

/** Approve one value for every wall of a type at once; walls with another value stay visible as outliers. */
export function WallTypeReview({ walls, t, pending, onApprove }: { walls: BuildingRegion[]; t: T; pending: boolean; onApprove: (items: ReviewItem[]) => void }) {
  const value = (key: string, group: WallTypeGroup) => enumOptions[key] ? optionLabel(key, String(group.value), t) : `${String(group.value)}${group.unit ? ` ${group.unit}` : ""}`;
  return <>
    <p className="muted text-ui-2xs">{t("buildingComponentTypeReviewHint").replace("{count}", String(walls.length))}</p>
    <dl className="building-model-component-rows">
      {reviewKeys.map((key) => {
        const { groups, missing } = wallTypeGroups(walls, key);
        return <Fragment key={key}>
          <dt>{fieldLabel(key, t)}</dt>
          <dd className="building-model-type-review">
            {groups.map((group) => <div key={JSON.stringify([group.value, group.unit])} className="building-model-type-review-row">
              <span><strong>{value(key, group)}</strong> · {t("buildingComponentWallCount").replace("{count}", String(group.walls))}{group.approved ? ` · ${t("buildingComponentApprovedCount").replace("{count}", String(group.approved))}` : ""}</span>
              {group.pending.length > 0 && <Button size="xs" variant="outline" disabled={pending} onClick={() => onApprove(group.pending)}>{t("buildingComponentApproveCount").replace("{count}", String(group.pending.length))}</Button>}
            </div>)}
            {groups.length > 1 && <span className="muted text-ui-2xs">{t("buildingComponentValuesDiffer")}</span>}
            {missing > 0 && <span className="muted text-ui-2xs">{t("buildingComponentMissingCount").replace("{count}", String(missing))}</span>}
          </dd>
        </Fragment>;
      })}
    </dl>
  </>;
}
