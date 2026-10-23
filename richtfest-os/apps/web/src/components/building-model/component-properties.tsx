import { Link } from "react-router-dom";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { bebauungsplanSchema, ceilingRoleSchema, doorLeafTypeSchema, doorRoleSchema, installationKindSchema, installationProofSchema, liningSidesSchema, liningTypeSchema, screedInsulationSchema, screedTypeSchema, stairCaseSchema, timberCeilingUndersideSchema, timberWallLiningSchema, windowFrameSchema, windowOpeningSchema, componentConstructionSchema, exteriorNoiseRoomKinds, fireClosureSchema, fireRatingSchema, fireRoomRoleSchema, fireSpecialUseSchema, garageEnclosureSchema, stairwellSmokeVentSchema, fullStoreySchema, componentInputGaps, proposeExteriorNoiseRoom, componentTypeSchema, elementComponentType, federalStateSchema, soundInsulationLevelSchema, spaceTypeSchema, wallRoleSchema, type ComponentType } from "@richtfest/shared";
import { ChevronDown, X } from "lucide-react";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge } from "../ui/primitives";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useApi } from "../../query";
import type { BuildingAddressStateSuggestion, LightweightCatalogueOption } from "@richtfest/shared";
import type { BuildingComponentPropertyState, BuildingRegion } from "./types";
import { InputSourceHelp } from "./input-sources";

type T = ReturnType<typeof useT>;
// Statements rather than values: shown in full.
const longText = new Set(["bebauungsplanNoise", "bebauungsplanGrz", "bebauungsplanHeight", "fireResistanceBasis"]);
type Key = Parameters<T>[0];
export type ComponentPropertySave = { key: string; value: string | number | boolean | null; unit: string | null; evidence?: import("@richtfest/shared").BuildingEvidence[] };

const enumOptions: Record<string, readonly string[]> = {
  componentType: componentTypeSchema.options, construction: componentConstructionSchema.options,
  wallRole: wallRoleSchema.options, spaceType: spaceTypeSchema.options, soundInsulationLevel: soundInsulationLevelSchema.options,
  federalState: federalStateSchema.options, bebauungsplan: bebauungsplanSchema.options, fullStorey: fullStoreySchema.options,
  storeyInventory: ["complete", "incomplete"], gfzCountingBasis: ["full_storeys_only", "include_other_storeys"],
  exteriorNoiseRoom: exteriorNoiseRoomKinds, exteriorNoiseApplicability: ["standard_exterior_noise", "special_assessment_required"],
  exteriorNoiseFlanking: ["negligible", "required"], exteriorSurfacesComplete: ["true", "false"],
  ceilingRole: ceilingRoleSchema.options, screedType: screedTypeSchema.options, doorRole: doorRoleSchema.options,
  windowFrame: windowFrameSchema.options, windowOpening: windowOpeningSchema.options, glazingBars: ["true", "false"],
  doorLeafType: doorLeafTypeSchema.options, liningType: liningTypeSchema.options, liningSides: liningSidesSchema.options, timberWallLining: timberWallLiningSchema.options,
  timberCeilingUnderside: timberCeilingUndersideSchema.options, screedInsulation: screedInsulationSchema.options, stairCase: stairCaseSchema.options,
  installationKind: installationKindSchema.options, installationProof: installationProofSchema.options, serviceReceivingUse: ["living", "work"],
  referenceBuildUpConfirmed: ["true", "false"], installationConditionsConfirmed: ["true", "false"],
  fireDetached: ["true", "false"], loadBearing: ["true", "false"], fireSpecialUse: fireSpecialUseSchema.options, garageEnclosure: garageEnclosureSchema.options,
  stairwellSmokeVent: stairwellSmokeVentSchema.options, fireRoomRole: fireRoomRoleSchema.options, fireResistance: fireRatingSchema.options, fireClosure: fireClosureSchema.options,
};
// Yes/no properties are stored as booleans and edited as a two-option select.
const booleanKeys = new Set(["exteriorSurfacesComplete", "glazingBars", "referenceBuildUpConfirmed", "installationConditionsConfirmed", "fireDetached", "loadBearing"]);
// Unitless numbers, such as how many of a small element sit in a wall.
const countKeys = new Set(["elementCount", "rebateSeals", "fireDwellings", "fireOtherUnits"]);
// Numbers where zero is a meaningful entry rather than a typo.
const zeroAllowed = new Set(["countableFloorArea", "soundReductionIndex", "fireDwellings", "fireOtherUnits", "garageArea"]);
const units: Record<string, string> = { thickness: "cm", bulkDensity: "kg/m³", parcelArea: "m²", footprintArea: "m²", grossFloorArea: "m²", countableFloorArea: "m²",
  soundReductionIndex: "dB", openingArea: "m²", surfaceArea: "m²", normalizedLevelDifference: "dB", clearRoomHeight: "m", screedMass: "kg/m²", screedStiffness: "MN/m³", flankingLevelDifference: "dB",
  glassSoundReduction: "dB", frameShare: "%", openingWidth: "m", openingHeight: "m", liningMass: "kg/m²", liningStiffness: "MN/m³", liningCavity: "cm", impactSoundReduction: "dB",
  serviceSoundLevel: "dB", doorLeafSoundReduction: "dB", rebateSealSoundReduction: "dB", floorSealSoundReduction: "dB",
  fireHeight: "m", fireUsableArea: "m²", fireLargestUnitArea: "m²", fireUnitsGrossArea: "m²", garageArea: "m²" };
const elementKeys = ["componentType", "construction", "material", "thickness", "bulkDensity", "wallRole"];
const acousticKeys = ["soundReductionIndex", "soundReductionIndexBasis"];
// Windows and doors are rated as a whole: area and Rw instead of a build-up.
const openingKeys = ["componentType", "openingWidth", "openingHeight", "openingArea", ...acousticKeys];
// Without a tested Rw, a window's build-up gives its catalogue Rw.
const windowKeys = [...openingKeys, "glazing", "glassSoundReduction", "windowFrame", "rebateSeals", "windowOpening", "frameShare", "glazingBars"];
const roomKeys = ["apartmentUnit", "spaceType", "exteriorNoiseRoom", "exteriorSurfacesComplete"];
// Interior sound: a ceiling's requirement and floating screed; a lightweight wall's Dn,f,w when it flanks a separating element.
const ceilingKeys = ["ceilingRole", "screedType", "screedMass", "screedStiffness", "screedInsulation"];
// Massive walls and ceilings: a lining (a ceiling's is its suspended ceiling); lightweight ones: their catalogue row, a timber wall's lining, a timber ceiling's underside.
const liningKeys = ["liningType", "liningMass", "liningStiffness", "liningCavity"];
const lightweightConstruction = (construction: unknown) => construction === "drywall" || construction === "timber" || construction === "steel";
const keysFor = (componentType: ComponentType | null, construction: unknown = null) => componentType === "door"
    ? [...openingKeys, "doorRole", "doorLeafSoundReduction", "doorLeafType", "rebateSealSoundReduction", "floorSealSoundReduction"] : componentType === "window" ? windowKeys
  : componentType === "small_element" ? ["componentType", "elementCount", "normalizedLevelDifference", "openingArea", "soundReductionIndexBasis"]
  : componentType === "stair" ? ["componentType", "stairCase", "impactSoundReduction"]
  : componentType === "installation" ? ["componentType", "installationKind", "installationProof", "serviceSoundLevel", "serviceSoundLevelBasis", "serviceReceivingUse", "referenceBuildUpConfirmed", "installationConditionsConfirmed"]
  : [...elementKeys.filter((key) => key !== "wallRole" || componentType === "wall"), ...(componentType === "wall" || componentType === "roof" ? acousticKeys : []),
    ...(componentType === "ceiling" ? ceilingKeys : []), ...(componentType === "roof" ? ["surfaceArea"] : []),
    ...(componentType === "wall" || componentType === "ceiling" ? lightweightConstruction(construction)
      ? ["lightweightCatalogueRow", ...(componentType === "wall" ? ["flankingLevelDifference", "timberWallLining"] : ["timberCeilingUnderside"])]
      : [...liningKeys, ...(componentType === "wall" ? ["liningSides"] : [])] : [])];
const camel = (value: string) => value.replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
export const fieldLabel = (key: string, t: T) => t(`buildingComponentField${camel(key)}` as Key);
export const optionLabel = (key: string, option: string, t: T) => t(`buildingComponent${camel(key)}${camel(option)}` as Key);

function ElementLink({ id, names, href }: { id: string; names?: Map<string, string>; href?: (id: string) => string }) {
  const name = names?.get(id) || id;
  return href ? <Link to={href(id)}>{name}</Link> : <>{name}</>;
}

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

export function PropertyRow({ propertyKey, state, placeholder, addressSuggestion, suggestions, t, pending, onSave, onReview }: { propertyKey: string; state?: BuildingComponentPropertyState; placeholder?: string; addressSuggestion?: BuildingAddressStateSuggestion | null; suggestions?: readonly { value: string; label?: string }[]; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (decision: "approved" | "rejected") => void }) {
  const suggestionsId = useId();
  const current = state && state.reviewStatus !== "rejected" ? state.value : null;
  const text = current === null || current === undefined ? "" : String(current);
  const [draft, setDraft] = useState(text);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // Enter and the blur that follows commit the same entry once, even before the saved value reloads.
  const committed = useRef(text);
  useEffect(() => { setDraft(text); committed.current = text; }, [text]);
  const unit = units[propertyKey] ?? null;
  const label = unit ? `${fieldLabel(propertyKey, t)} (${unit})` : fieldLabel(propertyKey, t);
  const options = enumOptions[propertyKey];
  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === committed.current) return;
    const value = !trimmed ? null : booleanKeys.has(propertyKey) ? trimmed === "true" : unit || countKeys.has(propertyKey) ? Number(trimmed.replace(",", ".")) : trimmed;
    if (typeof value === "number" && !(Number.isFinite(value) && (zeroAllowed.has(propertyKey) ? value >= 0 : value > 0))) { setDraft(text); return; }
    committed.current = trimmed;
    onSave({ key: propertyKey, value, unit: value === null ? null : unit,
      ...(value === addressSuggestion?.value ? { evidence: [addressSuggestion.evidence] } : {}) });
  };
  // Fields stay editable while a save runs: saves queue, so quick consecutive entries all land.
  return <>
    <dt><span>{label}</span>{!text && !addressSuggestion && <InputSourceHelp field={propertyKey} label={label} t={t} />}</dt>
    <dd>
      {options
        ? <NativeSelect aria-label={label} value={draft} onChange={(event) => { setDraft(event.target.value); commit(event.target.value); }}>
            <option value="">{addressSuggestion ? `${optionLabel(propertyKey, addressSuggestion.value, t)} · ${t("buildingAddressSuggestion")}` : placeholder ? `${t("buildingComponentInferredPrefix")} ${optionLabel(propertyKey, placeholder, t)}` : t("buildingModelUnknownValue")}</option>
            {options.map((option) => <option key={option} value={option}>{optionLabel(propertyKey, option, t)}</option>)}
          </NativeSelect>
        : longText.has(propertyKey) ? <Textarea aria-label={label} rows={propertyKey === "bebauungsplanNoise" ? 3 : 2} value={draft} placeholder={placeholder || t("buildingModelUnknownValue")} title={state?.evidenceQuote ?? undefined}
            onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) commit(event.currentTarget.value); }} />
        : <div className="relative"><Input className={suggestions?.length ? "pr-8" : undefined} aria-label={label} list={suggestions?.length ? suggestionsId : undefined} value={draft} inputMode={unit ? "decimal" : countKeys.has(propertyKey) ? "numeric" : undefined} placeholder={placeholder || t("buildingModelUnknownValue")} title={state?.evidenceQuote ?? undefined}
            onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget.value); }} />
          {Boolean(suggestions?.length) && <Popover open={suggestionsOpen} onOpenChange={setSuggestionsOpen}>
            <PopoverTrigger asChild><Button className="absolute right-1 top-1/2 -translate-y-1/2" variant="ghost" size="icon-xs" aria-label={`${t("buildingPropertySuggestions")}: ${label}`} title={t("buildingPropertySuggestions")}><ChevronDown className="size-icon-sm" /></Button></PopoverTrigger>
            <PopoverContent align="end" className="building-model-property-suggestions">
              {suggestions!.map((suggestion) => <button type="button" key={suggestion.value} onClick={() => { setDraft(suggestion.value); commit(suggestion.value); setSuggestionsOpen(false); }}>
                <span>{suggestion.value}</span>{suggestion.label && <small>{suggestion.label}</small>}
              </button>)}
            </PopoverContent>
          </Popover>}
        </div>}
      {suggestions && <datalist id={suggestionsId}>{suggestions.map((suggestion) => <option key={suggestion.value} value={suggestion.value}>{suggestion.label}</option>)}</datalist>}
      {addressSuggestion && !text && <Button variant="ghost" size="xs" disabled={pending} title={addressSuggestion.evidence.quote}
        onClick={() => { setDraft(addressSuggestion.value); commit(addressSuggestion.value); }}>{t("buildingAddressUse")}</Button>}
      <StatusLine state={state} t={t} pending={pending} onReview={onReview} />
    </dd>
  </>;
}

export type WallRoleDerivation = { pending: boolean; result?: { walls: number; exterior: number; roles: number; roleProposals: number; thicknessProposals: number; ceilings?: number; windows?: number; doors?: number; adopted?: number; ambiguous?: number }; onDerive: () => void };
export type WallTypeCopy = { pending: boolean; sameRoleCount: number; result?: { targets: number; updated: Record<string, number>; kept: number }; onCopy: (keys: string[]) => void };
const copyKeys = ["construction", "material", "thickness", "bulkDensity"];

/** Shared component data for a selected wall/ceiling or room, laid out as property rows. */
export function ComponentProperties({ projectId, region, roomNames, elementNames, storeyNames, elementHref, t, pending, onSave, onReview, derivation, copy }: { projectId?: string; region: BuildingRegion; roomNames: Map<string, string>; elementNames?: Map<string, string>; storeyNames?: Map<string, string>;
  /** Link that selects another element, such as an opening in this wall or the wall an opening sits in. */
  elementHref?: (id: string) => string; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void; derivation?: WallRoleDerivation; copy?: WallTypeCopy }) {
  const states = region.componentProperties ?? {};
  const isRoom = region.entityType === "room";
  const componentType = isRoom ? null : regionComponentType(region);
  const gaps = componentInputGaps(componentType, Object.fromEntries(Object.entries(states).map(([key, state]) => [key, { value: state.value, reviewStatus: state.reviewStatus }])));
  const keys = isRoom ? roomKeys : keysFor(componentType, states.construction && states.construction.reviewStatus !== "rejected" ? states.construction.value : null);
  const catalogue = useApi(`/projects/${projectId}/interior-sound/catalogue`, Boolean(projectId && keys.includes("lightweightCatalogueRow")));
  const catalogueRows = (catalogue.data as { rows?: LightweightCatalogueOption[] } | undefined)?.rows ?? [];
  const catalogueSuggestions = catalogueRows.filter((row) => (componentType === "ceiling" ? ["ceiling", "flanking_ceiling"] : ["wall_separating", "flanking_wall"]).includes(row.kind))
    .map((row) => ({ value: row.key, label: `${row.ref} · ${row.description}` }));
  const placeholder = (key: string) => key === "componentType" && (region.elementKind === "draft_wall" || region.elementKind === "draft_ceiling") ? regionComponentType(region) ?? undefined
    : key === "apartmentUnit" ? region.groupLabel || undefined
    : key === "exteriorNoiseRoom" ? proposeExteriorNoiseRoom(region.label, region.roomUse ?? null) ?? undefined
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
      {componentType === "wall" && region.openings && <>
        <dt>{t("buildingComponentOpenings")}</dt>
        <dd><span>{region.openings.map((id, index) => <Fragment key={id}>{index > 0 && ", "}<ElementLink id={id} names={elementNames} href={elementHref} /></Fragment>)}</span></dd>
      </>}
      {region.inWall && <>
        <dt>{t("buildingComponentInWall")}</dt>
        <dd><ElementLink id={region.inWall} names={elementNames} href={elementHref} /></dd>
      </>}
      {componentType === "ceiling" && region.covers && <>
        <dt>{t("buildingComponentOverRooms")}</dt>
        <dd>{region.covers.map((id) => roomNames.get(id) || id).join(", ")}</dd>
        <dt>{t("buildingComponentStoreyAbove")}</dt>
        <dd className={region.underStorey ? undefined : "muted"}>{region.underStorey ? storeyNames?.get(region.underStorey) || region.underStorey : t("buildingComponentStoreyAboveUnknown")}</dd>
      </>}
      {keys.map((key) => <PropertyRow key={`${region.id}:${key}`} propertyKey={key} state={states[key]} placeholder={placeholder(key)} suggestions={key === "lightweightCatalogueRow" ? catalogueSuggestions : undefined} t={t} pending={pending}
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
        .replace("{roles}", String(result.roles)).replace("{proposals}", String(result.roleProposals)).replace("{thickness}", String(result.thicknessProposals)).replace("{ceilings}", String(result.ceilings ?? 0))
        .replace("{windows}", String(result.windows ?? 0)).replace("{doors}", String(result.doors ?? 0))
        .replace("{adopted}", String(result.adopted ?? 0)).replace("{ambiguous}", String(result.ambiguous ?? 0)) : t("buildingComponentWallRolesHint")}</p>
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
