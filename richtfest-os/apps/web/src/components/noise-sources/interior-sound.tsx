import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { buildingDeepLink, ceilingRoleSchema, screedTypeSchema, type AirborneResult, type ImpactResult, type InteriorCeilingCheck, type InteriorElementReason, type InteriorGap, type InteriorLimitation, type InteriorSoundProof } from "@richtfest/shared";
import { api } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";
import { Badge, Callout, Empty, Field, Table } from "../ui/primitives";
import { optionLabel } from "../building-model/component-properties";
import { errorText, StoreyHeight, Suggestions, useSaveProperty } from "./proof-inputs";

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
  return gaps.length ? <Badge variant="outline">{t("interiorInputsMissing")}</Badge> : <span className="text-ui-xs muted">—</span>;
}
/** What each check still needs, one line per check, below its table. */
function OpenInputs({ items, t }: { items: Array<{ id: string; label: string; gaps: InteriorGap[] }>; t: T }) {
  const open = items.filter(item => item.gaps.length);
  if (!open.length) return null;
  return <ul className="interior-open text-ui-xs">
    {open.map(item => <li key={item.id}><span className="font-medium">{item.label}</span><span className="muted"> · {t("proofMissing")}: {item.gaps.map(gap => gapText(gap, t)).join(", ")}</span></li>)}
  </ul>;
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
  const wallsDone = proof.walls.filter(check => check.result?.status === "calculated").length;
  const ceilingsDone = proof.ceilings.filter(check => check.airborne?.status === "calculated" || check.impact?.status === "calculated").length;
  return <Section title={t("interiorSound")} meta={<Badge variant="outline">{t("facadeLevelsDraft")}</Badge>}>
    <p className="muted text-ui-xs">{t("interiorIntro")}</p>
    {proof.level && proof.level !== "statutory_minimum" && <Callout>{t("interiorElevatedLevel")}</Callout>}
    <StoreyHeights projectId={projectId} proof={proof} canWrite={canWrite} t={t} />
    {proof.suggestions.length > 0 && <Suggestions projectId={projectId} proof={proof} canWrite={canWrite} t={t} />}
    <div className="noise-toolbar">
      <h3 className="site-section-title">{t("interiorWalls")}</h3>
      <span className="muted text-ui-xs">{t("interiorCalculated").replace("{ready}", String(wallsDone)).replace("{total}", String(proof.walls.length))}</span>
    </div>
    {proof.walls.length ? <Table headers={[t("interiorWall"), t("interiorRooms"), t("interiorArea"), t("interiorRequirement"), t("proofResult")]}
      rows={proof.walls.map(check => ({ id: check.id, cells: [
        <span><Link className="underline underline-offset-2" to={entityLink(projectId, check.wallId)}>{check.wallName}</Link>
          <span className="muted text-ui-xs"> · {optionLabel("wallRole", check.role, t)}</span></span>,
        <span className="text-ui-xs">{check.rooms.map(room => room.name).join(" / ")}</span>,
        <span className="text-ui-xs">{m2(check.areaM2)}</span>,
        <span className="text-ui-xs muted">{check.requirement ? `R'w ≥ ${check.requirement.rwMinDb} dB` : "—"}</span>,
        <AirborneCell result={check.result} gaps={check.gaps} t={t} />,
      ] }))} /> : <Empty>{t("interiorNoWalls")}</Empty>}
    <OpenInputs items={proof.walls.map(check => ({ id: check.id, label: `${check.wallName} (${check.rooms.map(room => room.name).join(" / ")})`, gaps: check.gaps }))} t={t} />
    <div className="noise-toolbar">
      <h3 className="site-section-title">{t("interiorCeilings")}</h3>
      <span className="muted text-ui-xs">{t("interiorCalculated").replace("{ready}", String(ceilingsDone)).replace("{total}", String(proof.ceilings.length))}</span>
    </div>
    {ceilingIds.map(check => <CeilingInputs key={check.ceilingId} projectId={projectId} proof={proof} check={check} canWrite={canWrite} t={t} />)}
    {proof.ceilings.length ? <Table headers={[t("interiorCeiling"), t("interiorRoomBelow"), t("interiorArea"), t("interiorRequirement"), t("interiorAirborne"), t("interiorImpact")]}
      rows={proof.ceilings.map(check => ({ id: check.id, cells: [
        <Link className="underline underline-offset-2" to={entityLink(projectId, check.ceilingId)}>{check.ceilingName}</Link>,
        <span className="text-ui-xs">{check.room.name}</span>,
        <span className="text-ui-xs">{m2(check.areaM2)}</span>,
        <span className="text-ui-xs muted">{check.requirement ? [check.requirement.rwMinDb != null && `R'w ≥ ${check.requirement.rwMinDb} dB`, check.requirement.lnwMaxDb != null && `L'n,w ≤ ${check.requirement.lnwMaxDb} dB`].filter(Boolean).join(" · ") : "—"}</span>,
        <AirborneCell result={check.airborne} gaps={check.gaps} t={t} />,
        check.impact || !check.gaps.length ? <ImpactCell result={check.impact} t={t} /> : <Badge variant="outline">{t("interiorInputsMissing")}</Badge>,
      ] }))} /> : <Empty>{t("interiorNoCeilings")}</Empty>}
    <OpenInputs items={proof.ceilings.map(check => ({ id: check.id, label: `${check.ceilingName} · ${check.room.name}`, gaps: check.gaps }))} t={t} />
    <h3 className="site-section-title">{t("interiorElements")}</h3>
    {proof.elements.length ? <Table headers={[t("interiorElement"), t("interiorConstruction"), t("interiorMass"), t("interiorElementValue"), t("interiorBasis")]}
      rows={proof.elements.map(element => ({ id: element.id, cells: [
        <Link className="underline underline-offset-2" to={entityLink(projectId, element.id)}>{element.name}</Link>,
        <span className="text-ui-xs">{element.construction ? optionLabel("construction", element.construction, t) : "—"}</span>,
        <span className="text-ui-xs">{element.massKgM2 === null ? "—" : `${element.massKgM2.toFixed(1)} kg/m²`}</span>,
        element.massive || !canWrite
          ? <span className="text-ui-xs">{element.rwDb !== null ? `Rw ${db(element.rwDb)} dB` : element.dnfwDb !== null ? `Dn,f,w ${db(element.dnfwDb)} dB` : "—"}</span>
          : <FlankingLevel projectId={projectId} proof={proof} elementId={element.id} value={element.dnfwDb} t={t} />,
        element.reason ? <Badge variant="outline">{t(reasonKeys[element.reason])}</Badge>
          : <span className="text-ui-xs muted interior-basis" title={element.basis ?? undefined}>{element.basis ?? t("interiorEntered")}</span>,
      ] }))} /> : <Empty>{t("interiorNoElements")}</Empty>}
    <Callout><ul className="interior-limitations">{proof.limitations.map(item => <li key={item}>{t(limitationKeys[item])}</li>)}</ul></Callout>
    {canWrite && <CreateNachweis projectId={projectId} ready={wallsDone + ceilingsDone} t={t} />}
  </Section>;
}

function StoreyHeights({ projectId, proof, canWrite, t }: { projectId: string; proof: Proof; canWrite: boolean; t: T }) {
  return <div className="proof-building">{proof.storeys.map(storey => <StoreyHeight key={storey.id} projectId={projectId} proof={proof} storey={storey} canWrite={canWrite} t={t} />)}</div>;
}
/** What a ceiling separates and its floating screed; saved together, so one Save enters the ceiling. */
function CeilingInputs({ projectId, proof, check, canWrite, t }: { projectId: string; proof: Proof; check: InteriorCeilingCheck; canWrite: boolean; t: T }) {
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
  return <form className="interior-ceiling" onSubmit={submit}>
    <Field label={`${t("interiorCeilingRole")} · ${check.ceilingName}`}>
      <NativeSelect size="sm" className="w-full" value={draft.role} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, role: event.target.value })}>
        <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
        {ceilingRoleSchema.options.map(option => <NativeSelectOption key={option} value={option}>{optionLabel("ceilingRole", option, t)}</NativeSelectOption>)}
      </NativeSelect>
    </Field>
    <Field label={t("interiorScreedType")}>
      <NativeSelect size="sm" className="w-full" value={draft.type} disabled={!canWrite} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
        <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
        {screedTypeSchema.options.map(option => <NativeSelectOption key={option} value={option}>{optionLabel("screedType", option, t)}</NativeSelectOption>)}
      </NativeSelect>
    </Field>
    <Field label={t("interiorScreedMass")}><Input value={draft.mass} inputMode="decimal" disabled={!canWrite || !floating} onChange={(event) => setDraft({ ...draft, mass: event.target.value })} aria-invalid={Boolean(draft.mass.trim()) && mass === null} /></Field>
    <Field label={t("interiorScreedStiffness")}><Input value={draft.stiffness} inputMode="decimal" disabled={!canWrite || !floating} onChange={(event) => setDraft({ ...draft, stiffness: event.target.value })} aria-invalid={Boolean(draft.stiffness.trim()) && stiffness === null} /></Field>
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
