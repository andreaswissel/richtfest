import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { buildingDeepLink, ceilingRoleSchema, doorRoleSchema, screedTypeSchema, type AirborneResult, type InteriorDoorCheck, type ImpactResult, type InteriorCeilingCheck, type InteriorElementReason, type InteriorGap, type InteriorLimitation, type InteriorSoundProof } from "@richtfest/shared";
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
};
const reasonKeys: Record<InteriorElementReason, Key> = {
  construction_missing: "interiorReasonConstruction", material_unknown: "interiorReasonMaterial", multi_leaf: "interiorReasonMultiLeaf", thickness_missing: "interiorReasonThickness",
  density_missing: "interiorReasonDensity", density_class_out_of_range: "interiorReasonOutOfRange", perforated_not_homogeneous: "interiorReasonPerforated",
  mass_out_of_range: "interiorReasonOutOfRange", catalogue_missing: "interiorReasonCatalogue", flanking_level_difference_missing: "interiorReasonDnfw",
  lightweight_separating: "interiorReasonLightweight",
};
const edgeKeys: Record<string, Key> = { start: "interiorEdgeStart", end: "interiorEdgeEnd", top: "interiorEdgeTop", bottom: "interiorEdgeBottom" };
const unsupportedKeys: Record<string, Key> = {
  method_missing: "interiorUnsupportedMethod", mixed_flanking: "interiorUnsupportedMixed", no_edges: "interiorUnsupportedGeometry", invalid_geometry: "interiorUnsupportedGeometry",
  slab_mass_out_of_range: "interiorUnsupportedRange", flanking_mass_out_of_range: "interiorUnsupportedRange", no_massive_flanking: "interiorUnsupportedNoMassive", screed_out_of_range: "interiorUnsupportedRange",
};
const limitationKeys: Record<InteriorLimitation, Key> = {
  minimum_requirements_only: "interiorLimitMinimum", t_junctions: "interiorLimitJunctions", without_linings: "interiorLimitLinings", doors_not_checked: "interiorLimitDoors",
  floor_like_ceiling: "interiorLimitFloor", walls_above_like_below: "interiorLimitWallsAbove", screed_not_credited_airborne: "interiorLimitScreedAirborne", impact_vertical_only: "interiorLimitImpact",
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
function ImpactCell({ result, t }: { result: ImpactResult | null; t: T }) {
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
    {proof.level && proof.level !== "statutory_minimum" && <Callout>{t("interiorElevatedLevel")}</Callout>}
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
    <Subsection title={t("interiorElements")} meta={t("interiorElementsHint")}>
    {proof.elements.length ? <Table headers={[t("interiorElement"), t("interiorConstruction"), t("interiorMass"), t("interiorElementValue"), t("interiorBasis")]}
      rows={elementsByStorey(proof).map(element => ({ id: element.id, cells: [
        <span>{element.storeyId && storey(element.storeyId)}<Link className="underline underline-offset-2" to={entityLink(projectId, element.id)}>{element.name}</Link></span>,
        <span className="text-ui-xs">{element.construction ? optionLabel("construction", element.construction, t) : "—"}</span>,
        <span className="text-ui-xs">{element.massKgM2 === null ? "—" : `${element.massKgM2.toFixed(1)} kg/m²`}</span>,
        element.massive || !canWrite
          ? <span className="text-ui-xs">{element.rwDb !== null ? `Rw ${db(element.rwDb)} dB` : element.dnfwDb !== null ? `Dn,f,w ${db(element.dnfwDb)} dB` : "—"}</span>
          : <FlankingLevel projectId={projectId} proof={proof} elementId={element.id} value={element.dnfwDb} t={t} />,
        element.reason ? <Badge variant="outline">{t(reasonKeys[element.reason])}</Badge>
          : <span className="text-ui-xs muted interior-basis" title={element.basis ?? undefined}>{element.basis ?? t("interiorEntered")}</span>,
      ] }))} /> : <Empty>{t("interiorNoElements")}</Empty>}
    </Subsection>
    <Subsection title={t("proofNachweis")}>
      <Callout><ul className="interior-limitations">{proof.limitations.map(item => <li key={item}>{t(limitationKeys[item])}</li>)}</ul></Callout>
      {canWrite && <CreateNachweis projectId={projectId} ready={wallsDone + ceilingsDone + proof.doors.filter(check => check.result).length} t={t} />}
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

const doorGapKeys: Record<InteriorDoorCheck["gaps"][number], Key> = { door_role: "interiorGapDoorRole", door_rw: "interiorGapDoorRw", no_requirement: "interiorGapNoRequirement" };

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
          {t("interiorDoorValue").replace("{value}", db(check.result.valueDb)).replace("{allowance}", db(check.result.uncertaintyDb)).replace("{required}", db(check.result.requiredDb))
            .replace("{margin}", `${check.result.marginDb >= 0 ? "+" : ""}${db(check.result.marginDb)}`)}</span>
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
