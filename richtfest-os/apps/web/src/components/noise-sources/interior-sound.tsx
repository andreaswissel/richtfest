import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  buildingDeepLink, ceilingRoleSchema, doorRoleSchema, installationKindSchema, installationProofSchema, screedTypeSchema, stairCaseSchema,
  type AirborneResult, type InteriorDoorCheck, type ImpactOtherResult, type ImpactResult, type InteriorCeilingCheck, type InteriorElement, type InteriorElementReason, type InteriorGap,
  type InteriorLimitation, type InteriorServiceCheck, type InteriorSoundProof, type InteriorStairCheck, type LightweightCatalogueOption, type StairResult, type TimberImpactResult,
} from "@richtfest/shared";
import { api } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { FormPanel, Section, Subsection } from "../layout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";
import { Badge, Callout, Empty, Field, Table } from "../ui/primitives";
import { optionLabel } from "../building-model/component-properties";
import { baseRevision, errorText, invalidate, noteRevision, StoreyHeight, Suggestions, useSaveProperty } from "./proof-inputs";

type T = ReturnType<typeof useT>;
type Key = Parameters<T>[0];
type Proof = Extract<InteriorSoundProof, { available: true }>;

const db = (value: number) => value.toFixed(1);
const m2 = (value: number | null) => value === null ? "—" : `${value.toFixed(2)} m²`;
const parseNumber = (text: string) => { const value = Number(text.trim().replace(",", ".")); return text.trim() && Number.isFinite(value) ? value : null; };
const entityLink = (projectId: string, id: string) => buildingDeepLink(projectId, "element", id);

const gapKeys: Record<Exclude<InteriorGap["code"], "element">, Key> = {
  clear_height: "interiorGapClearHeight", geometry: "interiorGapGeometry", ceiling_missing: "interiorGapCeilingMissing", ceiling_role: "interiorGapCeilingRole",
  screed: "interiorGapScreed", no_requirement: "interiorGapNoRequirement", flanking_missing: "interiorGapFlankingMissing",
  room_use: "interiorGapRoomUse", stair_case: "interiorGapStairCase", stair_wall: "interiorGapStairWall", installation_kind: "interiorGapInstallationKind",
  installation_proof: "interiorGapInstallationProof", installation_wall: "interiorGapInstallationWall", service_level: "interiorGapServiceLevel",
};
const reasonKeys: Record<InteriorElementReason, Key> = {
  construction_missing: "interiorReasonConstruction", material_unknown: "interiorReasonMaterial", multi_leaf: "interiorReasonMultiLeaf", thickness_missing: "interiorReasonThickness",
  density_missing: "interiorReasonDensity", density_class_out_of_range: "interiorReasonOutOfRange", perforated_not_homogeneous: "interiorReasonPerforated",
  mass_out_of_range: "interiorReasonOutOfRange", catalogue_missing: "interiorReasonCatalogue", flanking_level_difference_missing: "interiorReasonDnfw",
  lightweight_separating: "interiorReasonLightweight", catalogue_row_unknown: "interiorReasonCatalogueRow", timber_inputs_missing: "interiorReasonTimber",
};
const edgeKeys: Record<string, Key> = { start: "interiorEdgeStart", end: "interiorEdgeEnd", top: "interiorEdgeTop", bottom: "interiorEdgeBottom" };
const unsupportedKeys: Record<string, Key> = {
  method_missing: "interiorUnsupportedMethod", mixed_flanking: "interiorUnsupportedMixed", no_edges: "interiorUnsupportedGeometry", invalid_geometry: "interiorUnsupportedGeometry",
  slab_mass_out_of_range: "interiorUnsupportedRange", flanking_mass_out_of_range: "interiorUnsupportedRange", no_massive_flanking: "interiorUnsupportedNoMassive", screed_out_of_range: "interiorUnsupportedRange",
  wall_too_light: "interiorUnsupportedWallLight", case_missing: "interiorUnsupportedRange", wall_mass_missing: "interiorUnsupportedWallMass", no_requirement: "interiorGapNoRequirement",
};
const limitationKeys: Record<InteriorLimitation, Key> = {
  minimum_requirements_only: "interiorLimitMinimum", junction_types: "interiorLimitJunctions", linings_one_side: "interiorLimitLinings", doors_not_checked: "interiorLimitDoors",
  floor_like_ceiling: "interiorLimitFloor", walls_above_like_below: "interiorLimitWallsAbove", impact_hallways_only: "interiorLimitImpact", timber_impact_vertical: "interiorLimitTimber",
  stairs_room_behind_wall: "interiorLimitStairs", services_execution: "interiorLimitServices",
};
const gapText = (gap: InteriorGap, t: T) => gap.code === "element" ? `${gap.elementName}: ${t(reasonKeys[gap.reason])}`
  : gap.code === "flanking_missing" ? t("interiorGapFlankingMissing").replace("{edge}", t(edgeKeys[gap.edge] ?? "interiorEdgeStart")) : t(gapKeys[gap.code]);

function Verdict({ meets, t }: { meets: boolean; t: T }) {
  return <Badge variant={meets ? "outline" : "destructive"}>{meets ? t("proofMeets") : t("proofBelow")}</Badge>;
}
function AirborneCell({ result, gaps, t }: { result: AirborneResult | null; gaps: InteriorGap[]; t: T }) {
  if (result?.status === "calculated") return <span className="text-ui-xs"><Verdict meets={result.meets} t={t} />{" "}
    {t("interiorAirborneValue").replace("{quantity}", result.quantity).replace("{value}", db(result.valueDb)).replace("{allowance}", db(result.uncertaintyDb)).replace("{required}", db(result.requiredDb))
      .replace("{margin}", `${result.marginDb >= 0 ? "+" : ""}${db(result.marginDb)}`)}</span>;
  if (result) return <span className="text-ui-xs muted">{t(unsupportedKeys[result.reason] ?? "interiorUnsupportedMethod")}</span>;
  return gaps.length ? <Missing gaps={gaps} t={t} /> : <span className="text-ui-xs muted">—</span>;
}
/** What a check still needs, in its result cell. */
function Missing({ gaps, t }: { gaps: InteriorGap[]; t: T }) {
  return <span className="proof-gaps text-ui-xs muted">{t("proofMissing")}: {gaps.map(gap => gapText(gap, t)).join(", ")}</span>;
}
function ImpactCell({ result, t }: { result: ImpactResult | TimberImpactResult | ImpactOtherResult | StairResult | null; t: T }) {
  if (result?.status === "calculated") return <span className="text-ui-xs"><Verdict meets={result.meets} t={t} />{" "}
    {t("interiorImpactValue").replace("{value}", db(result.lnwPrimeDb)).replace("{allowance}", db(result.uncertaintyDb)).replace("{max}", db(result.maxDb)).replace("{margin}", `${result.marginDb >= 0 ? "+" : ""}${db(result.marginDb)}`)}</span>;
  if (result) return <span className="text-ui-xs muted">{t(unsupportedKeys[result.reason] ?? "interiorUnsupportedMethod")}</span>;
  return <span className="text-ui-xs muted">—</span>;
}

/**
 * Interior sound insulation per separating wall (room pairs) and ceiling (rooms
 * below), from the building model and the component catalogue. People enter
 * what the model lacks; complete checks are calculated with DIN 4109-2 right away.
 */
export function InteriorSound({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const t = useT();
  const query = useApi(`/projects/${projectId}/interior-sound/proof`);
  const proof = query.data as InteriorSoundProof | undefined;
  if (!proof) return null;
  if (!proof.available) return <Section title={t("interiorSound")}>
    <Callout>{t(proof.reason === "norm_pack_missing" ? "interiorUnavailablePack" : proof.reason === "plan_missing" ? "interiorUnavailablePlan" : "proofNoModel")}</Callout>
  </Section>;
  const ceilingIds = [...new Map(proof.ceilings.map(check => [check.ceilingId, check])).values()];
  const storey = storeyPrefix(proof);
  const wallsDone = proof.walls.filter(check => check.result?.status === "calculated").length;
  const ceilingsDone = proof.ceilings.filter(check => check.airborne?.status === "calculated" || check.impact?.status === "calculated").length;
  return <Section title={t("interiorSound")} meta={<Badge variant="outline">{t("facadeLevelsDraft")}</Badge>}>
    <p className="noise-intro muted text-ui-xs">{t("interiorIntro")}</p>
    {proof.requirementLevel === "elevated" ? <Callout>{t("interiorElevatedChecked")}</Callout>
      : proof.level && proof.level !== "statutory_minimum" && <Callout>{t("interiorElevatedLevel")}</Callout>}
    <Subsection title={t("proofBuildingInputs")}>
      <StoreyHeights projectId={projectId} proof={proof} canWrite={canWrite} t={t} />
    </Subsection>
    {proof.suggestions.length > 0 && <Suggestions projectId={projectId} proof={proof} canWrite={canWrite} t={t} />}
    <Subsection title={t("interiorWalls")} meta={t("interiorCalculated").replace("{ready}", String(wallsDone)).replace("{total}", String(proof.walls.length))}>
    {proof.walls.length ? <Table headers={[t("interiorWall"), t("interiorRooms"), t("interiorArea"), t("interiorRequirement"), t("proofResult")]}
      rows={proof.walls.map(check => ({ id: check.id, cells: [
        <span>{storey(check.storeyId)}<Link className="underline underline-offset-2" to={entityLink(projectId, check.wallId)}>{check.wallName}</Link>
          <span className="muted text-ui-xs"> · {optionLabel("wallRole", check.role, t)}</span></span>,
        <span className="text-ui-xs">{check.rooms.map(room => room.name).join(" / ")}</span>,
        <span className="text-ui-xs">{m2(check.areaM2)}</span>,
        <span className="text-ui-xs muted">{check.requirement ? `R'w ≥ ${check.requirement.rwMinDb} dB` : "—"}
          {check.requirement?.door && <span> · {t("interiorWallWithDoor").replace("{door}", check.requirement.door.name)}</span>}</span>,
        <AirborneCell result={check.result} gaps={check.gaps} t={t} />,
      ] }))} /> : <Empty>{t("interiorNoWalls")}</Empty>}
    </Subsection>
    <Doors projectId={projectId} proof={proof} canWrite={canWrite} t={t} />
    <Subsection title={t("interiorCeilings")} meta={t("interiorCalculated").replace("{ready}", String(ceilingsDone)).replace("{total}", String(proof.ceilings.length))}>
    {ceilingIds.length ? ceilingIds.map(first => <Ceiling key={first.ceilingId} projectId={projectId} proof={proof} first={first}
      checks={proof.ceilings.filter(check => check.ceilingId === first.ceilingId)} canWrite={canWrite} t={t} />) : <Empty>{t("interiorNoCeilings")}</Empty>}
    </Subsection>
    <Impacts projectId={projectId} proof={proof} t={t} />
    <Stairs projectId={projectId} proof={proof} canWrite={canWrite} t={t} />
    <Services projectId={projectId} proof={proof} canWrite={canWrite} t={t} />
    <Elements projectId={projectId} proof={proof} canWrite={canWrite} t={t} />
    <Subsection title={t("proofNachweis")}>
      <Callout><ul className="interior-limitations">{proof.limitations.map(item => <li key={item}>{t(limitationKeys[item])}</li>)}</ul></Callout>
      {canWrite && <CreateNachweis projectId={projectId} ready={wallsDone + ceilingsDone + proof.doors.filter(check => check.result).length
        + [...proof.impacts, ...proof.stairs, ...proof.services].filter(check => check.result?.status === "calculated").length} t={t} />}
    </Subsection>
  </Section>;
}

function StoreyHeights({ projectId, proof, canWrite, t }: { projectId: string; proof: Proof; canWrite: boolean; t: T }) {
  return <div className="proof-building">{proof.storeys.map(storey => <StoreyHeight key={storey.id} projectId={projectId} proof={proof} storey={storey} canWrite={canWrite} t={t} />)}</div>;
}
/** What each ceiling separates and its floating screed, one row per ceiling; a row's Save enters that ceiling. */
/**
 * One ceiling: its construction, then its check into each room below. What
 * every check lacks is said once for the ceiling; a row names only its own gaps.
 */
function Ceiling({ projectId, proof, first, checks, canWrite, t }: { projectId: string; proof: Proof; first: InteriorCeilingCheck; checks: InteriorCeilingCheck[]; canWrite: boolean; t: T }) {
  const texts = checks.map(check => check.gaps.map(gap => gapText(gap, t)));
  const shared = (texts[0] ?? []).filter(text => texts.every(list => list.includes(text)));
  const done = checks.filter(check => check.airborne?.status === "calculated" || check.impact?.status === "calculated").length;
  return <div className="interior-ceiling-block" role="group" aria-label={first.ceilingName}>
    <div className="interior-ceiling-heading">
      <h4>{storeyPrefix(proof)(first.storeyId)}<Link className="underline underline-offset-2" to={entityLink(projectId, first.ceilingId)}>{first.ceilingName}</Link></h4>
      <span className="muted text-ui-xs">{t("interiorCeilingMeta").replace("{count}", String(checks.length)).replace("{ready}", String(done))}</span>
    </div>
    <CeilingRow projectId={projectId} proof={proof} check={first} canWrite={canWrite} t={t} />
    {shared.length > 0 && <Callout>{t("interiorCeilingMissing").replace("{gaps}", shared.join(", "))}</Callout>}
    <Table headers={[t("interiorRoomBelow"), t("interiorArea"), t("interiorRequirement"), t("interiorAirborne"), t("interiorImpact")]}
      rows={checks.map(check => {
        const own = check.gaps.filter(gap => !shared.includes(gapText(gap, t)));
        return { id: check.id, cells: [
          <span>{check.room.name}</span>,
          <span className="text-ui-xs">{m2(check.areaM2)}</span>,
          <span className="text-ui-xs muted">{check.requirement ? [check.requirement.rwMinDb != null && `R'w ≥ ${check.requirement.rwMinDb} dB`, check.requirement.lnwMaxDb != null && `L'n,w ≤ ${check.requirement.lnwMaxDb} dB`].filter(Boolean).join(" · ") : "—"}</span>,
          !check.airborne && !own.length && check.gaps.length ? <span className="text-ui-xs muted">{t("interiorNeedsCeilingInputs")}</span> : <AirborneCell result={check.airborne} gaps={own} t={t} />,
          check.impact || !check.gaps.length ? <ImpactCell result={check.impact} t={t} /> : <span className="text-ui-xs muted">—</span>,
        ] };
      })} />
  </div>;
}

function CeilingRow({ projectId, proof, check, canWrite, t }: { projectId: string; proof: Proof; check: InteriorCeilingCheck; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const initial = { role: String(check.role?.value ?? ""), type: String(check.screed.type?.value ?? ""),
    mass: check.screed.mass ? String(check.screed.mass.value) : "", stiffness: check.screed.stiffness ? String(check.screed.stiffness.value) : "" };
  const [draft, setDraft] = useState(initial);
  const key = JSON.stringify(initial);
  useEffect(() => setDraft(initial), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const mass = parseNumber(draft.mass), stiffness = parseNumber(draft.stiffness);
  const changed = JSON.stringify(draft) !== key;
  const valid = (!draft.mass.trim() || mass !== null) && (!draft.stiffness.trim() || stiffness !== null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const write = (propertyKey: string, value: unknown, unit: string | null = null) => save.mutateAsync({ entityType: "element", entityId: check.ceilingId, propertyKey, value, unit });
    if (draft.role && draft.role !== initial.role) await write("ceilingRole", draft.role);
    if (draft.type && draft.type !== initial.type) await write("screedType", draft.type);
    if (mass !== null && draft.mass !== initial.mass) await write("screedMass", mass, "kg/m²");
    if (stiffness !== null && draft.stiffness !== initial.stiffness) await write("screedStiffness", stiffness, "MN/m³");
  };
  const floating = draft.type !== "none";
  const label = (text: string) => `${text} · ${check.ceilingName}`;
  return <form className="interior-ceiling" onSubmit={submit}>
    <Field label={t("interiorCeilingRole")}><NativeSelect size="sm" className="w-full" aria-label={label(t("interiorCeilingRole"))} value={draft.role} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, role: event.target.value })}>
      <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
      {ceilingRoleSchema.options.map(option => <NativeSelectOption key={option} value={option}>{optionLabel("ceilingRole", option, t)}</NativeSelectOption>)}
    </NativeSelect></Field>
    <Field label={t("interiorScreedType")}><NativeSelect size="sm" className="w-full" aria-label={label(t("interiorScreedType"))} value={draft.type} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
      <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
      {screedTypeSchema.options.map(option => <NativeSelectOption key={option} value={option}>{optionLabel("screedType", option, t)}</NativeSelectOption>)}
    </NativeSelect></Field>
    <Field label={t("interiorScreedMass")}><Input aria-label={label(t("interiorScreedMass"))} value={draft.mass} inputMode="decimal" disabled={!canWrite || !floating} onChange={(event) => setDraft({ ...draft, mass: event.target.value })} aria-invalid={Boolean(draft.mass.trim()) && mass === null} /></Field>
    <Field label={t("interiorScreedStiffness")}><Input aria-label={label(t("interiorScreedStiffness"))} value={draft.stiffness} inputMode="decimal" disabled={!canWrite || !floating} onChange={(event) => setDraft({ ...draft, stiffness: event.target.value })} aria-invalid={Boolean(draft.stiffness.trim()) && stiffness === null} /></Field>
    {canWrite && <Button type="submit" size="sm" variant="outline" disabled={!changed || !valid || save.isPending}>{t("noiseSave")}</Button>}
    {save.isError && <Callout tone="error">{errorText(save.error, t)}</Callout>}
  </form>;
}

/** Dn,f,w of a lightweight wall flanking a separating element, entered from its test certificate or catalogue. */
function FlankingLevel({ projectId, proof, elementId, value, t }: { projectId: string; proof: Proof; elementId: string; value: number | null; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const initial = value === null ? "" : String(value);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const parsed = parseNumber(text);
  return <form className="proof-inline" onSubmit={(event) => { event.preventDefault();
    if (parsed !== null && text !== initial) save.mutate({ entityType: "element", entityId: elementId, propertyKey: "flankingLevelDifference", value: parsed, unit: "dB" }); }}>
    <Input className="interior-dnfw" aria-label={t("interiorDnfw")} placeholder="dB" value={text} inputMode="decimal" onChange={(event) => setText(event.target.value)} aria-invalid={Boolean(text.trim()) && parsed === null} />
    <Button type="submit" size="sm" variant="outline" disabled={parsed === null || text === initial || save.isPending}>{t("noiseSave")}</Button>
  </form>;
}

/** Elements storey by storey, in the order of the storeys; the server sorts them by name. */
const elementsByStorey = (proof: Proof) => {
  const order = new Map(proof.storeys.map((storey, index) => [storey.id, index]));
  return proof.elements.map((element, index) => ({ element, index }))
    .sort((a, b) => (order.get(a.element.storeyId ?? "") ?? order.size) - (order.get(b.element.storeyId ?? "") ?? order.size) || a.index - b.index).map(item => item.element);
};

/** With several storeys, which storey a check is on, before its element. */
const storeyPrefix = (proof: Proof) => (storeyId: string) => proof.storeys.length > 1
  ? <span className="muted text-ui-xs">{proof.storeys.find(item => item.id === storeyId)?.name} · </span> : null;

const doorGapKeys: Record<InteriorDoorCheck["gaps"][number], Key> = { door_role: "interiorGapDoorRole", door_rw: "interiorGapDoorRw", no_requirement: "interiorGapNoRequirement",
  criteria_not_applicable: "interiorGapDoorCriteria" };

/**
 * Entrance doors from stairwells and common hallways: where each leads and its
 * tested Rw, checked against the requirement less the door allowance. Doors in
 * stairwell or corridor walls appear here; more can be added per wall and room.
 */
function Doors({ projectId, proof, canWrite, t }: { projectId: string; proof: Proof; canWrite: boolean; t: T }) {
  const done = proof.doors.filter(check => check.result).length;
  // Where a door can go: a stairwell or corridor wall and the room on either side it leads into.
  const places = proof.walls.filter(check => check.role === "stairwell" || check.role === "corridor_partition")
    .flatMap(check => check.rooms.map(room => ({ key: `${check.wallId}:${room.id}`, wallId: check.wallId, roomId: room.id, label: `${check.wallName} → ${room.name}` })))
    .filter((place, i, all) => all.findIndex(other => other.key === place.key) === i);
  if (!proof.doors.length && !places.length) return null;
  return <Subsection title={t("interiorDoors")} meta={t("interiorCalculated").replace("{ready}", String(done)).replace("{total}", String(proof.doors.length))}>
    {proof.doors.length ? <Table headers={[t("interiorDoor"), t("interiorDoorLeadsTo"), t("interiorDoorRole"), t("interiorDoorRw"), t("interiorRequirement"), t("proofResult")]}
      rows={proof.doors.map(check => ({ id: check.id, cells: [
        <span>{storeyPrefix(proof)(check.storeyId)}<Link className="underline underline-offset-2" to={entityLink(projectId, check.id)}>{check.name}</Link>
          {check.wall && <span className="muted text-ui-xs"> · {check.wall.name}</span>}</span>,
        <span className="text-ui-xs">{check.room?.name ?? "—"}</span>,
        <DoorRole projectId={projectId} proof={proof} check={check} canWrite={canWrite} t={t} />,
        <DoorRw projectId={projectId} proof={proof} check={check} canWrite={canWrite} t={t} />,
        <span className="text-ui-xs muted">{check.requirement ? `Rw ≥ ${check.requirement.rwMinDb} dB` : "—"}</span>,
        check.result ? <span className="text-ui-xs"><Verdict meets={check.result.meets} t={t} />{" "}
          {check.result.method === "declared"
            ? t("interiorDoorValue").replace("{value}", db(check.result.valueDb)).replace("{allowance}", db(check.result.uncertaintyDb)).replace("{required}", db(check.result.requiredDb))
              .replace("{margin}", `${check.result.marginDb >= 0 ? "+" : ""}${db(check.result.marginDb)}`)
            : t("interiorDoorCriteriaValue").replace("{margin}", `${check.result.marginDb >= 0 ? "+" : ""}${db(check.result.marginDb)}`)}</span>
          : <span className="proof-gaps text-ui-xs muted">{check.gaps.length ? `${t("proofMissing")}: ${check.gaps.map(gap => t(doorGapKeys[gap])).join(", ")}` : "—"}</span>,
      ] }))} /> : <Empty>{t("interiorNoDoors")}</Empty>}
    {canWrite && places.length > 0 && <AddDoor projectId={projectId} proof={proof} places={places} t={t} />}
  </Subsection>;
}

function DoorRole({ projectId, proof, check, canWrite, t }: { projectId: string; proof: Proof; check: InteriorDoorCheck; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  return <NativeSelect size="sm" className="interior-door-role" aria-label={t("interiorDoorRole")} value={String(check.role?.value ?? "")} disabled={!canWrite || save.isPending}
    onChange={(event) => event.target.value && save.mutate({ entityType: "element", entityId: check.id, propertyKey: "doorRole", value: event.target.value })}>
    <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
    {doorRoleSchema.options.map(option => <NativeSelectOption key={option} value={option}>{optionLabel("doorRole", option, t)}</NativeSelectOption>)}
  </NativeSelect>;
}

function DoorRw({ projectId, proof, check, canWrite, t }: { projectId: string; proof: Proof; check: InteriorDoorCheck; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const initial = check.rw ? String(check.rw.value) : "";
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const parsed = parseNumber(text);
  if (!canWrite) return <span className="text-ui-xs">{check.rw ? `${db(check.rw.value)} dB` : "—"}</span>;
  return <form className="proof-inline" title={check.basis?.value} onSubmit={(event) => { event.preventDefault();
    if (parsed !== null && text !== initial) save.mutate({ entityType: "element", entityId: check.id, propertyKey: "soundReductionIndex", value: parsed, unit: "dB" }); }}>
    <Input className="interior-dnfw" aria-label={t("interiorDoorRw")} placeholder="dB" value={text} inputMode="decimal" onChange={(event) => setText(event.target.value)} aria-invalid={Boolean(text.trim()) && parsed === null} />
    <Button type="submit" size="sm" variant="outline" disabled={parsed === null || text === initial || save.isPending}>{t("noiseSave")}</Button>
  </form>;
}

function AddDoor({ projectId, proof, places, t }: { projectId: string; proof: Proof; places: Array<{ key: string; wallId: string; roomId: string; label: string }>; t: T }) {
  const empty = { place: places[0]!.key, name: "", role: "to_dwelling_hallway", rw: "", basis: "" };
  const [draft, setDraft] = useState(empty);
  const place = places.find(item => item.key === draft.place) ?? places[0]!;
  const add = useMutation({
    mutationFn: () => api(`/projects/${projectId}/exterior-noise/proof/openings`, {
      baseRevision: baseRevision(projectId, proof), roomId: place.roomId, wallId: place.wallId, componentType: "door",
      name: draft.name.trim() || `${t("interiorDoor")} ${proof.doors.length + 1}`, area: null, rw: parseNumber(draft.rw), basis: draft.basis.trim() || null, doorRole: draft.role }),
    onSuccess: async (result) => { noteRevision(projectId, result); setDraft(empty); await invalidate(projectId); },
  });
  const valid = !draft.rw.trim() || parseNumber(draft.rw) !== null;
  return <FormPanel title={t("interiorAddDoor")}><form className="interior-door-row" onSubmit={(event) => { event.preventDefault(); if (valid) add.mutate(); }}>
    <Field label={t("interiorDoorPlace")}>
      <NativeSelect size="sm" className="w-full" value={draft.place} onChange={(event) => setDraft({ ...draft, place: event.target.value })}>
        {places.map(item => <NativeSelectOption key={item.key} value={item.key}>{item.label}</NativeSelectOption>)}
      </NativeSelect>
    </Field>
    <Field label={t("interiorDoorRole")}>
      <NativeSelect size="sm" className="w-full" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}>
        {doorRoleSchema.options.filter(option => option !== "internal").map(option => <NativeSelectOption key={option} value={option}>{optionLabel("doorRole", option, t)}</NativeSelectOption>)}
      </NativeSelect>
    </Field>
    <Field label={t("proofOpeningName")}><Input value={draft.name} placeholder={t("proofOptional")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
    <Field label={t("interiorDoorRw")}><Input value={draft.rw} inputMode="decimal" onChange={(event) => setDraft({ ...draft, rw: event.target.value })} aria-invalid={!valid} /></Field>
    <Field label={t("noiseBasis")}><Input value={draft.basis} placeholder={t("interiorDoorBasisPlaceholder")} onChange={(event) => setDraft({ ...draft, basis: event.target.value })} /></Field>
    <Button type="submit" size="sm" variant="outline" disabled={!valid || add.isPending}>{t("interiorAddDoor")}</Button>
    {add.isError && <Callout tone="error">{errorText(add.error, t)}</Callout>}
  </form></FormPanel>;
}

function CreateNachweis({ projectId, ready, t }: { projectId: string; ready: number; t: T }) {
  const create = useMutation({
    mutationFn: () => api<{ artifact: { id: string }; revision: { id: string }; complete: boolean }>(`/knowledge/projects/${projectId}/interior-sound-nachweis`, {}),
    onSuccess: () => queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith("/knowledge/") }),
  });
  return <div className="proof-create">
    <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>{create.isPending ? t("loading") : t("interiorCreate")}</Button>
    <span className="muted text-ui-xs">{ready ? t("interiorCreateHint") : t("interiorCreateNone")}</span>
    {create.data && <Link className="underline underline-offset-2 text-ui-sm" to={`/projects/${projectId}?panel=artifacts&artifact=${create.data.artifact.id}&revision=${create.data.revision.id}`}>
      {create.data.complete ? t("proofOpenNachweis") : t("proofOpenPartial")}</Link>}
    {create.isError && <Callout tone="error">{errorText(create.error, t)}</Callout>}
  </div>;
}

const signed = (value: number) => `${value >= 0 ? "+" : ""}${db(value)}`;
const stairRows = (checks: InteriorStairCheck[]) => [...new Map(checks.map(check => [check.stair.id, check])).values()];

/** Impact sound from common hallways into the protected rooms beside them, and diagonally from the hallway above; derived from room space types. */
function Impacts({ projectId, proof, t }: { projectId: string; proof: Proof; t: T }) {
  const done = proof.impacts.filter(check => check.result?.status === "calculated").length;
  return <Subsection title={t("interiorImpacts")} meta={t("interiorCalculated").replace("{ready}", String(done)).replace("{total}", String(proof.impacts.length))}>
    {proof.impacts.length ? <Table headers={[t("interiorImpactFrom"), t("interiorImpactPosition"), t("interiorImpactSlab"), t("interiorRequirement"), t("proofResult")]}
      rows={proof.impacts.map(check => ({ id: check.id, cells: [
        <span className="text-ui-xs">{storeyPrefix(proof)(check.storeyId)}{check.source.name} → {check.room.name}
          <span className="muted"> · <Link className="underline underline-offset-2" to={entityLink(projectId, check.wall.id)}>{check.wall.name}</Link></span></span>,
        <span className="text-ui-xs">{t(check.position === "beside" ? "interiorImpactBeside" : "interiorImpactDiagonal")}</span>,
        <span className="text-ui-xs">{check.slab ? <Link className="underline underline-offset-2" to={entityLink(projectId, check.slab.id)}>{check.slab.name}</Link> : "—"}</span>,
        <span className="text-ui-xs muted">{check.requirement ? `L'n,w ≤ ${check.requirement.lnwMaxDb} dB` : "—"}</span>,
        check.result?.status === "calculated" ? <span className="text-ui-xs"><Verdict meets={check.result.meets} t={t} />{" "}
          {t("interiorImpactOtherValue").replace("{value}", db(check.result.lnwPrimeDb)).replace("{kt}", db(check.result.kTDb)).replace("{allowance}", db(check.result.uncertaintyDb))
            .replace("{max}", db(check.result.maxDb)).replace("{margin}", signed(check.result.marginDb))}</span>
          : check.gaps.length ? <Missing gaps={check.gaps} t={t} /> : <ImpactCell result={check.result} t={t} />,
      ] }))} /> : <Empty>{t("interiorNoImpacts")}</Empty>}
  </Subsection>;
}

/** Stairs in stairwell rooms: their case and covering, then their check into each protected room behind the stairwell wall. */
function Stairs({ projectId, proof, canWrite, t }: { projectId: string; proof: Proof; canWrite: boolean; t: T }) {
  const done = proof.stairs.filter(check => check.result?.status === "calculated").length;
  return <Subsection title={t("interiorStairs")} meta={t("interiorCalculated").replace("{ready}", String(done)).replace("{total}", String(proof.stairs.length))}>
    {proof.stairs.length ? stairRows(proof.stairs).map(first => <div key={first.stair.id} className="interior-ceiling-block interior-stair-block" role="group" aria-label={first.stair.name}>
      <div className="interior-ceiling-heading">
        <h4>{storeyPrefix(proof)(first.storeyId)}<Link className="underline underline-offset-2" to={entityLink(projectId, first.stair.id)}>{first.stair.name}</Link></h4>
      </div>
      <StairForm projectId={projectId} proof={proof} check={first} canWrite={canWrite} t={t} />
      <Table headers={[t("interiorStairRoom"), t("interiorRequirement"), t("proofResult")]}
        rows={proof.stairs.filter(check => check.stair.id === first.stair.id).map(check => ({ id: check.id, cells: [
          <span className="text-ui-xs">{check.room?.name ?? "—"}{check.wall && <span className="muted"> · {check.wall.name}</span>}</span>,
          <span className="text-ui-xs muted">{check.requirement ? `L'n,w ≤ ${check.requirement.lnwMaxDb} dB` : "—"}</span>,
          check.gaps.length ? <Missing gaps={check.gaps} t={t} /> : <ImpactCell result={check.result} t={t} />,
        ] }))} />
    </div>) : <Empty>{t("interiorNoStairs")}</Empty>}
    {canWrite && <AddElement projectId={projectId} proof={proof} kind="stair" t={t} />}
  </Subsection>;
}

function StairForm({ projectId, proof, check, canWrite, t }: { projectId: string; proof: Proof; check: InteriorStairCheck; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const initial = { stairCase: String(check.stairCase?.value ?? ""), deltaLw: check.deltaLw ? String(check.deltaLw.value) : "" };
  const [draft, setDraft] = useState(initial);
  const key = JSON.stringify(initial);
  useEffect(() => setDraft(initial), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const deltaLw = parseNumber(draft.deltaLw);
  const valid = !draft.deltaLw.trim() || deltaLw !== null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const write = (propertyKey: string, value: unknown, unit: string | null = null) => save.mutateAsync({ entityType: "element", entityId: check.stair.id, propertyKey, value, unit });
    if (draft.stairCase && draft.stairCase !== initial.stairCase) await write("stairCase", draft.stairCase);
    if (deltaLw !== null && draft.deltaLw !== initial.deltaLw) await write("impactSoundReduction", deltaLw, "dB");
  };
  return <form className="interior-ceiling" onSubmit={submit}>
    <Field label={t("interiorStairCase")}><NativeSelect size="sm" className="w-full" value={draft.stairCase} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, stairCase: event.target.value })}>
      <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
      {stairCaseSchema.options.map(option => <NativeSelectOption key={option} value={option}>{optionLabel("stairCase", option, t)}</NativeSelectOption>)}
    </NativeSelect></Field>
    <Field label={t("interiorStairDeltaLw")}><Input value={draft.deltaLw} inputMode="decimal" placeholder={t("interiorStairNoCovering")} disabled={!canWrite}
      onChange={(event) => setDraft({ ...draft, deltaLw: event.target.value })} aria-invalid={!valid} /></Field>
    {canWrite && <Button type="submit" size="sm" variant="outline" disabled={JSON.stringify(draft) === key || !valid || save.isPending}>{t("noiseSave")}</Button>}
    {save.isError && <Callout tone="error">{errorText(save.error, t)}</Callout>}
  </form>;
}

const serviceFailureKeys: Record<string, Key> = {
  wall_too_light: "interiorServiceWallLight", slab_too_light: "interiorServiceSlabLight", borders_protected_room: "interiorServiceBorders",
  build_up_unconfirmed: "interiorServiceBuildUp", conditions_unconfirmed: "interiorServiceConditions", not_sanitary: "interiorServiceNotSanitary",
};
function ServiceResultCell({ check, t }: { check: InteriorServiceCheck; t: T }) {
  const result = check.result;
  if (check.gaps.length) return <Missing gaps={check.gaps} t={t} />;
  if (!result) return <span className="text-ui-xs muted">—</span>;
  if (result.status !== "calculated") return <span className="text-ui-xs muted">{t(unsupportedKeys[result.reason] ?? "interiorUnsupportedMethod")}</span>;
  if (result.method === "level") return <span className="text-ui-xs"><Verdict meets={result.meets} t={t} />{" "}
    {t("interiorServiceLevelValue").replace("{value}", db(result.valueDb)).replace("{max}", db(result.maxDb)).replace("{margin}", signed(result.marginDb))}</span>;
  return result.meets ? <span className="text-ui-xs"><Verdict meets t={t} /> {t("interiorServiceReferenceMet")}</span>
    : <span className="proof-gaps text-ui-xs"><Badge variant="outline">{t("interiorServiceNotCovered")}</Badge> {result.failures.map(item => t(serviceFailureKeys[item] ?? "interiorUnsupportedMethod")).join(", ")}</span>;
}

/** Building services: per installation its kind and how it is proven, then the result against the protected rooms of other units. */
function Services({ projectId, proof, canWrite, t }: { projectId: string; proof: Proof; canWrite: boolean; t: T }) {
  const done = proof.services.filter(check => check.result?.status === "calculated" && check.result.meets).length;
  return <Subsection title={t("interiorServices")} meta={t("interiorServicesMeta").replace("{ready}", String(done)).replace("{total}", String(proof.services.length))}>
    {proof.services.length ? proof.services.map(check => <div key={check.id} className="interior-ceiling-block" role="group" aria-label={check.name}>
      <div className="interior-ceiling-heading">
        <h4>{storeyPrefix(proof)(check.storeyId)}<Link className="underline underline-offset-2" to={entityLink(projectId, check.id)}>{check.name}</Link></h4>
        <span className="muted text-ui-xs">{[check.room?.name, check.wall?.name].filter(Boolean).join(" · ")}
          {check.borders.length > 0 && ` · ${t("interiorServiceBordersRooms").replace("{rooms}", check.borders.map(room => room.name).join(", "))}`}</span>
      </div>
      <ServiceForm projectId={projectId} proof={proof} check={check} canWrite={canWrite} t={t} />
      <div className="interior-service-result"><span className="muted text-ui-xs">{check.requirement ? `LAF,max,n ≤ ${check.requirement.maxDb} dB · ` : ""}</span><ServiceResultCell check={check} t={t} /></div>
    </div>) : <Empty>{t("interiorNoServices")}</Empty>}
    {canWrite && <AddElement projectId={projectId} proof={proof} kind="installation" t={t} />}
  </Subsection>;
}

function ServiceForm({ projectId, proof, check, canWrite, t }: { projectId: string; proof: Proof; check: InteriorServiceCheck; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const initial = { kind: String(check.kind?.value ?? ""), proof: String(check.proof?.value ?? ""), level: check.level ? String(check.level.value) : "",
    basis: String(check.basis?.value ?? ""), use: String(check.receivingUse?.value ?? "living"),
    buildUp: check.buildUpConfirmed?.value === true, conditions: check.conditionsConfirmed?.value === true };
  const [draft, setDraft] = useState(initial);
  const key = JSON.stringify(initial);
  useEffect(() => setDraft(initial), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const level = parseNumber(draft.level);
  const valid = !draft.level.trim() || level !== null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const write = (propertyKey: string, value: unknown, unit: string | null = null) => save.mutateAsync({ entityType: "element", entityId: check.id, propertyKey, value, unit });
    if (draft.kind && draft.kind !== initial.kind) await write("installationKind", draft.kind);
    if (draft.proof && draft.proof !== initial.proof) await write("installationProof", draft.proof);
    if (level !== null && draft.level !== initial.level) await write("serviceSoundLevel", level, "dB");
    if (draft.basis.trim() && draft.basis !== initial.basis) await write("serviceSoundLevelBasis", draft.basis.trim());
    if (draft.use !== initial.use) await write("serviceReceivingUse", draft.use);
    if (draft.buildUp !== initial.buildUp) await write("referenceBuildUpConfirmed", draft.buildUp);
    if (draft.conditions !== initial.conditions) await write("installationConditionsConfirmed", draft.conditions);
  };
  const reference = draft.proof === "reference_wall", measured = draft.proof === "level";
  return <form className="interior-ceiling interior-service" onSubmit={submit}>
    <Field label={t("interiorServiceKind")}><NativeSelect size="sm" className="w-full" value={draft.kind} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
      <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
      {installationKindSchema.options.map(option => <NativeSelectOption key={option} value={option}>{optionLabel("installationKind", option, t)}</NativeSelectOption>)}
    </NativeSelect></Field>
    <Field label={t("interiorServiceProof")}><NativeSelect size="sm" className="w-full" value={draft.proof} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, proof: event.target.value })}>
      <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
      {installationProofSchema.options.map(option => <NativeSelectOption key={option} value={option}>{optionLabel("installationProof", option, t)}</NativeSelectOption>)}
    </NativeSelect></Field>
    {measured && <>
      <Field label={t("interiorServiceLevel")}><Input value={draft.level} inputMode="decimal" disabled={!canWrite} onChange={(event) => setDraft({ ...draft, level: event.target.value })} aria-invalid={!valid} /></Field>
      <Field label={t("noiseBasis")}><Input value={draft.basis} placeholder={t("interiorServiceBasisPlaceholder")} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, basis: event.target.value })} /></Field>
      <Field label={t("interiorServiceUse")}><NativeSelect size="sm" className="w-full" value={draft.use} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, use: event.target.value })}>
        {(["living", "work"] as const).map(option => <NativeSelectOption key={option} value={option}>{optionLabel("serviceReceivingUse", option, t)}</NativeSelectOption>)}
      </NativeSelect></Field>
    </>}
    {reference && <div className="interior-service-checks">
      <label className="text-ui-sm"><input type="checkbox" checked={draft.conditions} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, conditions: event.target.checked })} /> {t("interiorServiceConditionsConfirm")}</label>
      <label className="text-ui-sm"><input type="checkbox" checked={draft.buildUp} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, buildUp: event.target.checked })} /> {t("interiorServiceBuildUpConfirm")}</label>
    </div>}
    {canWrite && <Button type="submit" size="sm" variant="outline" disabled={JSON.stringify(draft) === key || !valid || save.isPending}>{t("noiseSave")}</Button>}
    {save.isError && <Callout tone="error">{errorText(save.error, t)}</Callout>}
  </form>;
}

/** Adds a stair to a room (its stairwell) or an installation on a wall of a room. */
function AddElement({ projectId, proof, kind, t }: { projectId: string; proof: Proof; kind: "stair" | "installation"; t: T }) {
  const places = kind === "stair" ? proof.places.map(place => ({ key: place.roomId, roomId: place.roomId, wallId: null as string | null, label: place.roomName, storeyId: place.storeyId }))
    : proof.places.flatMap(place => place.walls.map(wall => ({ key: `${place.roomId}:${wall.id}`, roomId: place.roomId, wallId: wall.id as string | null, label: `${place.roomName} · ${wall.name}`, storeyId: place.storeyId })));
  const empty = { place: places[0]?.key ?? "", name: "" };
  const [draft, setDraft] = useState(empty);
  const place = places.find(item => item.key === draft.place) ?? places[0];
  const count = kind === "stair" ? stairRows(proof.stairs).length : proof.services.length;
  const add = useMutation({
    mutationFn: () => api(`/projects/${projectId}/exterior-noise/proof/openings`, {
      baseRevision: baseRevision(projectId, proof), roomId: place!.roomId, wallId: place!.wallId, componentType: kind,
      name: draft.name.trim() || `${t(kind === "stair" ? "interiorStair" : "interiorInstallation")} ${count + 1}`, area: null, rw: null, basis: null }),
    onSuccess: async (result) => { noteRevision(projectId, result); setDraft(empty); await invalidate(projectId); },
  });
  if (!places.length) return null;
  const storeyName = (id: string) => proof.storeys.length > 1 ? `${proof.storeys.find(item => item.id === id)?.name} · ` : "";
  return <FormPanel title={t(kind === "stair" ? "interiorAddStair" : "interiorAddInstallation")}><form className="interior-door-row interior-add-element" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
    <Field label={t(kind === "stair" ? "interiorStairPlace" : "interiorInstallationPlace")}>
      <NativeSelect size="sm" className="w-full" value={draft.place} onChange={(event) => setDraft({ ...draft, place: event.target.value })}>
        {places.map(item => <NativeSelectOption key={item.key} value={item.key}>{storeyName(item.storeyId)}{item.label}</NativeSelectOption>)}
      </NativeSelect>
    </Field>
    <Field label={t("proofOpeningName")}><Input value={draft.name} placeholder={t("proofOptional")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
    <Button type="submit" size="sm" variant="outline" disabled={add.isPending}>{t(kind === "stair" ? "interiorAddStair" : "interiorAddInstallation")}</Button>
    {add.isError && <Callout tone="error">{errorText(add.error, t)}</Callout>}
  </form></FormPanel>;
}

const liningText = (element: InteriorElement, t: T) => {
  const parts = [element.lining && [element.componentType === "ceiling" ? t("interiorSuspendedCeiling") : t("interiorLining"), element.lining] as const,
    element.screedLining && [t("interiorScreedAirborne"), element.screedLining] as const].filter(Boolean) as Array<readonly [string, NonNullable<InteriorElement["lining"]>]>;
  return parts.map(([label, lining]) => lining.deltaRwDb !== null ? `${label} ΔRw ${signed(lining.deltaRwDb)} dB` : `${label}: ${t(lining.reason === "incomplete" ? "interiorLiningIncomplete" : "interiorLiningOutOfRange")}`).join(" · ");
};

/** The separating and flanking elements with their catalogue values; lightweight ones pick their catalogue row or take an entered Dn,f,w. */
function Elements({ projectId, proof, canWrite, t }: { projectId: string; proof: Proof; canWrite: boolean; t: T }) {
  const storey = storeyPrefix(proof);
  const lightweight = proof.elements.some(element => !element.massive);
  const catalogue = useApi(`/projects/${projectId}/interior-sound/catalogue`, lightweight && canWrite);
  const rows = (catalogue.data as { rows: LightweightCatalogueOption[] } | undefined)?.rows ?? [];
  return <Subsection title={t("interiorElements")} meta={t("interiorElementsHint")}>
    {proof.elements.length ? <Table headers={[t("interiorElement"), t("interiorConstruction"), t("interiorMass"), t("interiorElementValue"), t("interiorBasis")]}
      rows={elementsByStorey(proof).map(element => ({ id: element.id, cells: [
        <span>{element.storeyId && storey(element.storeyId)}<Link className="underline underline-offset-2" to={entityLink(projectId, element.id)}>{element.name}</Link></span>,
        <span className="text-ui-xs">{element.construction ? optionLabel("construction", element.construction, t) : "—"}</span>,
        <span className="text-ui-xs">{element.massKgM2 === null ? "—" : `${element.massKgM2.toFixed(1)} kg/m²`}</span>,
        <span className="text-ui-xs">{[element.rwDb !== null && `Rw ${db(element.rwDb)} dB`, element.dnfwDb !== null && `Dn,f,w ${db(element.dnfwDb)} dB`, element.lnwDb != null && `Ln,w ${db(element.lnwDb)} dB`].filter(Boolean).join(" · ") || "—"}
          {(element.lining || element.screedLining) && <span className="muted"><br />{liningText(element, t)}</span>}</span>,
        element.massive || !canWrite
          ? element.reason ? <Badge variant="outline">{t(reasonKeys[element.reason])}</Badge>
            : <span className="text-ui-xs muted interior-basis" title={element.basis ?? undefined}>{element.basis ?? t("interiorEntered")}</span>
          : <div className="interior-lightweight">
            <CatalogueRow projectId={projectId} proof={proof} element={element} rows={rows} t={t} />
            <FlankingLevel projectId={projectId} proof={proof} elementId={element.id} value={element.catalogueRow ? null : element.dnfwDb} t={t} />
          </div>,
      ] }))} /> : <Empty>{t("interiorNoElements")}</Empty>}
  </Subsection>;
}

function CatalogueRow({ projectId, proof, element, rows, t }: { projectId: string; proof: Proof; element: InteriorElement; rows: LightweightCatalogueOption[]; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const kinds = element.componentType === "ceiling" ? ["ceiling", "flanking_ceiling"] : ["wall_separating", "flanking_wall"];
  const options = rows.filter(row => kinds.includes(row.kind));
  return <NativeSelect size="sm" className="interior-catalogue" aria-label={`${t("interiorCatalogueRow")} · ${element.name}`} value={element.catalogueRow ?? ""} disabled={save.isPending || !options.length}
    title={element.basis ?? undefined} onChange={(event) => event.target.value && save.mutate({ entityType: "element", entityId: element.id, propertyKey: "lightweightCatalogueRow", value: event.target.value })}>
    <NativeSelectOption value="">{t("interiorCatalogueRowChoose")}</NativeSelectOption>
    {options.map(row => <NativeSelectOption key={row.key} value={row.key}>{row.ref.replace(/^DIN 4109-33, /, "")} · {row.description.length > 90 ? `${row.description.slice(0, 90)}…` : row.description}</NativeSelectOption>)}
  </NativeSelect>;
}
