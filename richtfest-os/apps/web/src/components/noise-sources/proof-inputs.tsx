import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { exteriorNoiseRoomKinds, type ExteriorNoiseProof, type ProofFacade, type ProofGap, type ProofRoom, type ProofValue } from "@richtfest/shared";
import { api, ApiError } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";
import { Badge, Callout, Empty, Field, Table } from "../ui/primitives";

type T = ReturnType<typeof useT>;
type Key = Parameters<T>[0];
type Proof = Extract<ExteriorNoiseProof, { available: true }>;

const db = (value: number) => value.toFixed(1);
const m = (value: number) => value.toFixed(2);
const parseNumber = (text: string) => { const value = Number(text.trim().replace(",", ".")); return text.trim() && Number.isFinite(value) ? value : null; };
const invalidate = (projectId: string) => queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith(`/projects/${projectId}/`) });
const errorText = (error: unknown, t: T) => error instanceof ApiError && error.status === 409 ? t("proofConflict") : error instanceof Error ? error.message : String(error);

const kindKeys: Record<string, Key> = {
  sleeping: "proofKindSleeping", living: "proofKindLiving", office: "proofKindOffice", hospital_bedroom: "proofKindHospital", not_protected: "proofKindNotProtected",
};
const gapKeys: Record<ProofGap, Key> = {
  room_kind: "proofGapRoomKind", floor_area: "proofGapFloorArea", clear_height: "proofGapClearHeight", facade_level: "proofGapFacadeLevel",
  wall_rw: "proofGapWallRw", wall_construction: "proofGapWallConstruction", window_area: "proofGapWindowArea", window_rw: "proofGapWindowRw",
  openings_exceed_facade: "proofGapOpeningsExceed", surfaces_unconfirmed: "proofGapSurfaces", applicability: "proofGapApplicability", flanking: "proofGapFlanking",
  no_facade: "proofGapNoFacade",
};
const unavailableKeys: Record<string, Key> = {
  norm_pack_missing: "facadeLevelsNoPack", location_missing: "facadeLevelsNoLocation", placement_missing: "facadeLevelsNoPlacement",
  exterior_walls_missing: "facadeLevelsNoExterior", model_missing: "proofNoModel",
};

// Every model write raises its revision. Consecutive saves (a value and its basis) continue from the
// revision the previous save returned instead of the one last read, which the server would reject.
const latestRevision = new Map<string, number>();
const baseRevision = (projectId: string, proof: Proof) => Math.max(proof.modelRevision, latestRevision.get(projectId) ?? 0);
const noteRevision = (projectId: string, result: unknown) => {
  const revision = (result as { revision?: unknown } | null)?.revision;
  if (typeof revision === "number") latestRevision.set(projectId, Math.max(revision, latestRevision.get(projectId) ?? 0));
};

/** Saves one building-model property as a manual, unreviewed value. */
function useSaveProperty(projectId: string, proof: Proof) {
  return useMutation({
    mutationFn: (input: { entityType: "building" | "storey" | "room" | "element"; entityId: string; propertyKey: string; value: unknown; unit?: string | null }) =>
      api(`/projects/${projectId}/building-model/properties`, { baseRevision: baseRevision(projectId, proof), provenance: "manual", evidence: [], unit: null, ...input }),
    onSuccess: (result) => { noteRevision(projectId, result); return invalidate(projectId); },
  });
}

const facadeLabel = (facade: ProofFacade) => `${facade.compass ? `${facade.compass} · ` : ""}${facade.wallName}`;
const reviewBadge = (value: ProofValue<unknown> | null, t: T) => value && <Badge variant="outline">{value.reviewStatus === "approved" ? t("proofReviewed") : t("proofEntered")}</Badge>;

/**
 * Exterior noise verification inputs per protected room, assembled from the
 * building model and the facade levels. People enter what the model lacks
 * (room use, clear height, wall and window Rw); rooms with every input are
 * calculated with the DIN 4109 exterior noise method right away.
 */
export function ProofInputs({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const t = useT();
  const query = useApi(`/projects/${projectId}/exterior-noise/proof`);
  const proof = query.data as ExteriorNoiseProof | undefined;
  const [open, setOpen] = useState<string | null>(null);
  if (!proof) return null;
  if (!proof.available) return <Section title={t("proof")}>
    <Callout>{t(unavailableKeys[proof.reason]!)}{" "}
      {proof.reason !== "norm_pack_missing" && <Link className="underline underline-offset-2" to={`/projects/${projectId}?view=location`}>{t("facadeLevelsOpenLocation")}</Link>}
    </Callout>
  </Section>;
  const protectedRooms = proof.rooms.filter(room => room.kind?.value !== "not_protected");
  const ready = proof.rooms.filter(room => room.result?.status === "calculated").length;
  const selected = proof.rooms.find(room => room.id === open) ?? null;
  return <Section title={t("proof")} meta={<Badge variant="outline">{t("facadeLevelsDraft")}</Badge>}>
    <p className="muted text-ui-xs">{t("proofIntro").replace("{file}", proof.page.fileName ?? "—").replace("{file_page}", String(proof.page.page))}</p>
    <BuildingInputs projectId={projectId} proof={proof} canWrite={canWrite} t={t} />
    <div className="noise-toolbar">
      <h3 className="site-section-title">{t("proofRooms")}</h3>
      <span className="muted text-ui-xs">{t("proofRoomsCalculated").replace("{ready}", String(ready)).replace("{total}", String(protectedRooms.length))}</span>
    </div>
    {proof.rooms.length ? <Table headers={[t("proofRoom"), t("proofUse"), t("proofFloorArea"), t("proofFacades"), t("proofResult"), ""]}
      rows={proof.rooms.map(room => ({ id: room.id, sort: [room.name, room.kind?.value ?? "", String(room.floorAreaM2 ?? 0), String(room.facades.length), room.result?.status ?? room.gaps.join(), ""], cells: [
        <span>{room.name}{room.roomUse && <span className="muted text-ui-xs"> · {room.roomUse}</span>}</span>,
        <RoomKind projectId={projectId} proof={proof} room={room} canWrite={canWrite} t={t} />,
        <span className="text-ui-xs">{room.floorAreaM2 === null ? "—" : `${m(room.floorAreaM2)} m²`}</span>,
        <span className="text-ui-xs muted">{room.facades.map(facade => `${facade.compass ?? "—"} ${m(facade.lengthM)} m${facade.la ? ` · La ${db(facade.la.dayDb)}/${db(facade.la.sleepingDb)}` : ""}`).join("; ") || "—"}</span>,
        <RoomResult room={room} t={t} />,
        room.kind?.value !== "not_protected" && room.facades.length > 0
          ? <Button size="sm" variant={open === room.id ? "outline" : "ghost"} aria-expanded={open === room.id} onClick={() => setOpen(open === room.id ? null : room.id)}>
            {open === room.id ? t("proofCloseRoom") : t("proofEditRoom")}</Button> : null,
      ] }))} /> : <Empty>{t("proofNoRooms")}</Empty>}
    {selected && <RoomEditor key={selected.id} projectId={projectId} proof={proof} room={selected} canWrite={canWrite} t={t} />}
    <Callout>{t("proofLimitations")}</Callout>
    {canWrite && <CreateNachweis projectId={projectId} proof={proof} ready={ready} total={protectedRooms.length} t={t} />}
  </Section>;
}

/** Writes the draft Schallschutznachweis (report and PDF) from the current inputs; rooms with gaps stay listed as open. */
function CreateNachweis({ projectId, proof, ready, total, t }: { projectId: string; proof: Proof; ready: number; total: number; t: T }) {
  const create = useMutation({
    mutationFn: () => api<{ artifact: { id: string }; revision: { id: string }; complete: boolean }>(`/knowledge/projects/${projectId}/exterior-noise-nachweis`, {}),
    onSuccess: () => queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith("/knowledge/") }),
  });
  return <div className="proof-create">
    <Button disabled={!proof.calculation || create.isPending} onClick={() => create.mutate()}>{create.isPending ? t("loading") : t("proofCreate")}</Button>
    <span className="muted text-ui-xs">{proof.calculation ? (ready < total ? t("proofCreatePartial").replace("{ready}", String(ready)).replace("{total}", String(total)) : t("proofCreateHint")) : t("proofCreateNone")}</span>
    {create.data && <Link className="underline underline-offset-2 text-ui-sm" to={`/projects/${projectId}?panel=artifacts&artifact=${create.data.artifact.id}&revision=${create.data.revision.id}`}>
      {create.data.complete ? t("proofOpenNachweis") : t("proofOpenPartial")}</Link>}
    {create.isError && <Callout tone="error">{errorText(create.error, t)}</Callout>}
  </div>;
}

function RoomResult({ room, t }: { room: ProofRoom; t: T }) {
  if (room.kind?.value === "not_protected") return <span className="muted text-ui-xs">{t("proofNotProtected")}</span>;
  if (room.result?.status === "calculated" && room.result.valueDb !== null && room.result.targetDb !== null && room.result.marginDb !== null)
    return <span className="text-ui-xs">
      <Badge variant={room.result.marginDb >= 0 ? "outline" : "destructive"}>{room.result.marginDb >= 0 ? t("proofMeets") : t("proofBelow")}</Badge>{" "}
      {t("proofValues").replace("{value}", db(room.result.valueDb)).replace("{target}", db(room.result.targetDb)).replace("{margin}", `${room.result.marginDb >= 0 ? "+" : ""}${db(room.result.marginDb)}`)}
    </span>;
  if (room.result?.reason) return <span className="text-ui-xs muted">{room.result.reason}</span>;
  return <span className="text-ui-xs muted">{t("proofMissing")}: {room.gaps.map(gap => t(gapKeys[gap])).join(", ")}</span>;
}

function RoomKind({ projectId, proof, room, canWrite, t }: { projectId: string; proof: Proof; room: ProofRoom; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const current = room.kind?.value ?? "";
  return <span className="proof-kind">
    <NativeSelect size="sm" value={current} disabled={!canWrite || save.isPending} aria-label={t("proofUse")}
      onChange={(event) => event.target.value && save.mutate({ entityType: "room", entityId: room.id, propertyKey: "exteriorNoiseRoom", value: event.target.value })}>
      <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
      {exteriorNoiseRoomKinds.map(kind => <NativeSelectOption key={kind} value={kind}>{t(kindKeys[kind]!)}</NativeSelectOption>)}
    </NativeSelect>
    {!room.kind && room.proposedKind && canWrite && <Button size="sm" variant="ghost" disabled={save.isPending}
      onClick={() => save.mutate({ entityType: "room", entityId: room.id, propertyKey: "exteriorNoiseRoom", value: room.proposedKind })}>
      {t("proofUseProposal").replace("{kind}", t(kindKeys[room.proposedKind]!))}</Button>}
    {save.isError && <small className="noise-input-error">{errorText(save.error, t)}</small>}
  </span>;
}

/** Inputs that hold for the whole storey or building: applicability, flanking and clear room height. */
function BuildingInputs({ projectId, proof, canWrite, t }: { projectId: string; proof: Proof; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const initialHeight = proof.clearHeight ? String(proof.clearHeight.value) : "";
  const [height, setHeight] = useState(initialHeight);
  useEffect(() => setHeight(initialHeight), [initialHeight]);
  const heightValue = parseNumber(height);
  const submitHeight = (event: FormEvent) => { event.preventDefault();
    if (heightValue !== null && height !== initialHeight) save.mutate({ entityType: "storey", entityId: proof.storey.id, propertyKey: "clearRoomHeight", value: heightValue, unit: "m" }); };
  return <form className="proof-building" onSubmit={submitHeight}>
    <Field label={t("proofApplicability")}>
      <NativeSelect size="sm" className="w-full" value={proof.applicability?.value ?? ""} disabled={!canWrite || save.isPending}
        onChange={(event) => event.target.value && save.mutate({ entityType: "building", entityId: proof.buildingId, propertyKey: "exteriorNoiseApplicability", value: event.target.value })}>
        <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
        <NativeSelectOption value="standard_exterior_noise">{t("proofApplicabilityStandard")}</NativeSelectOption>
        <NativeSelectOption value="special_assessment_required">{t("proofApplicabilitySpecial")}</NativeSelectOption>
      </NativeSelect>
    </Field>
    <Field label={t("proofFlanking")}>
      <NativeSelect size="sm" className="w-full" value={proof.flanking?.value ?? ""} disabled={!canWrite || save.isPending}
        onChange={(event) => event.target.value && save.mutate({ entityType: "building", entityId: proof.buildingId, propertyKey: "exteriorNoiseFlanking", value: event.target.value })}>
        <NativeSelectOption value="">{t("proofChoose")}</NativeSelectOption>
        <NativeSelectOption value="negligible">{t("proofFlankingNegligible")}</NativeSelectOption>
        <NativeSelectOption value="required">{t("proofFlankingRequired")}</NativeSelectOption>
      </NativeSelect>
    </Field>
    <Field label={t("proofClearHeight").replace("{storey}", proof.storey.name)}>
      <span className="proof-inline">
        <Input value={height} inputMode="decimal" disabled={!canWrite} onChange={(event) => setHeight(event.target.value)} aria-invalid={Boolean(height.trim()) && heightValue === null} />
        {canWrite && <Button type="submit" size="sm" variant="outline" disabled={heightValue === null || height === initialHeight || save.isPending}>{t("noiseSave")}</Button>}
      </span>
    </Field>
    {save.isError && <Callout tone="error">{errorText(save.error, t)}</Callout>}
  </form>;
}

function RoomEditor({ projectId, proof, room, canWrite, t }: { projectId: string; proof: Proof; room: ProofRoom; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  return <div className="proof-room">
    <h3 className="site-section-title">{room.name}</h3>
    {room.facades.map(facade => <FacadeEditor key={facade.wallId} projectId={projectId} proof={proof} room={room} facade={facade} canWrite={canWrite} t={t} />)}
    <label className="proof-confirm text-ui-sm">
      <Checkbox checked={room.surfacesComplete?.value === true} disabled={!canWrite || save.isPending}
        onCheckedChange={(checked) => save.mutate({ entityType: "room", entityId: room.id, propertyKey: "exteriorSurfacesComplete", value: checked === true })} />
      {t("proofSurfacesComplete")}
    </label>
    {save.isError && <Callout tone="error">{errorText(save.error, t)}</Callout>}
  </div>;
}

function FacadeEditor({ projectId, proof, room, facade, canWrite, t }: { projectId: string; proof: Proof; room: ProofRoom; facade: ProofFacade; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const initialRw = facade.rw ? String(facade.rw.value) : "", initialBasis = facade.rwBasis?.value ?? "";
  const [rw, setRw] = useState(initialRw), [basis, setBasis] = useState(initialBasis);
  useEffect(() => { setRw(initialRw); setBasis(initialBasis); }, [initialRw, initialBasis]);
  const rwValue = parseNumber(rw);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (rwValue !== null && rw !== initialRw) await save.mutateAsync({ entityType: "element", entityId: facade.wallId, propertyKey: "soundReductionIndex", value: rwValue, unit: "dB" });
    if (basis.trim() && basis !== initialBasis) await save.mutateAsync({ entityType: "element", entityId: facade.wallId, propertyKey: "soundReductionIndexBasis", value: basis.trim() });
  };
  const kind = room.kind?.value;
  const la = facade.la && (kind === "sleeping" || kind === "hospital_bedroom" ? facade.la.sleepingDb : facade.la.dayDb);
  return <div className="proof-facade">
    <p className="text-ui-sm"><strong>{facadeLabel(facade)}</strong>{" "}
      <span className="muted text-ui-xs">
        {facade.areaM2 === null ? t("proofFacadeLength").replace("{length}", m(facade.lengthM)) : t("proofFacadeArea").replace("{length}", m(facade.lengthM)).replace("{height}", String(proof.clearHeight?.value ?? "")).replace("{area}", m(facade.areaM2))}
        {" · "}{la === null || la === undefined ? t("proofGapFacadeLevel") : `La ${db(la)} dB`}
        {" · "}{facade.construction === "unknown" ? t("proofConstructionUnknown") : t(facade.construction === "massive" ? "proofConstructionMassive" : "proofConstructionLightweight")}
      </span>
    </p>
    <form className="proof-row" onSubmit={submit}>
      <Field label={t("proofWallRw")}><Input value={rw} inputMode="decimal" disabled={!canWrite} onChange={(event) => setRw(event.target.value)} aria-invalid={Boolean(rw.trim()) && rwValue === null} /></Field>
      <Field label={t("noiseBasis")}><Input value={basis} placeholder={t("proofRwBasisPlaceholder")} disabled={!canWrite} onChange={(event) => setBasis(event.target.value)} /></Field>
      <div className="noise-input-status">
        {canWrite && <Button type="submit" size="sm" variant="outline" disabled={(rw === initialRw && basis === initialBasis) || (Boolean(rw.trim()) && rwValue === null) || save.isPending}>{t("noiseSave")}</Button>}
        {reviewBadge(facade.rw, t)}
        {facade.opaqueAreaM2 !== null && <span className="muted text-ui-2xs">{t("proofOpaqueArea").replace("{area}", m(facade.opaqueAreaM2))}</span>}
      </div>
    </form>
    {save.isError && <Callout tone="error">{errorText(save.error, t)}</Callout>}
    <Openings projectId={projectId} proof={proof} room={room} facade={facade} canWrite={canWrite} t={t} />
  </div>;
}

/** Windows and doors in one facade of a room; Enter in the last field adds the row. */
function Openings({ projectId, proof, room, facade, canWrite, t }: { projectId: string; proof: Proof; room: ProofRoom; facade: ProofFacade; canWrite: boolean; t: T }) {
  const empty = { componentType: "window" as "window" | "door", name: "", area: "", rw: "", basis: "" };
  const [draft, setDraft] = useState(empty);
  const add = useMutation({
    mutationFn: () => api(`/projects/${projectId}/exterior-noise/proof/openings`, {
      baseRevision: baseRevision(projectId, proof), roomId: room.id, wallId: facade.wallId, componentType: draft.componentType,
      name: draft.name.trim() || `${t(draft.componentType === "door" ? "proofDoor" : "proofWindow")} ${facade.windows.length + 1}`,
      area: parseNumber(draft.area), rw: parseNumber(draft.rw), basis: draft.basis.trim() || null }),
    onSuccess: async (result) => { noteRevision(projectId, result); setDraft(empty); await invalidate(projectId); },
  });
  const remove = useMutation({
    mutationFn: (elementId: string) => api(`/projects/${projectId}/exterior-noise/proof/openings/${elementId}?baseRevision=${baseRevision(projectId, proof)}`, undefined, "DELETE"),
    onSuccess: (result) => { noteRevision(projectId, result); return invalidate(projectId); },
  });
  const valid = parseNumber(draft.area) !== null && (!draft.rw.trim() || parseNumber(draft.rw) !== null);
  return <div className="proof-openings">
    {facade.windows.length > 0 && <Table headers={[t("proofOpening"), t("proofOpeningArea"), t("proofOpeningRw"), t("noiseBasis"), " "]}
      rows={facade.windows.map(item => ({ id: item.id, cells: [
        <span>{item.name} <span className="muted text-ui-xs">· {t(item.componentType === "door" ? "proofDoor" : "proofWindow")}</span></span>,
        <span className="text-ui-xs">{item.area ? `${m(item.area.value)} m²` : "—"}</span>,
        <span className="text-ui-xs">{item.rw ? `${db(item.rw.value)} dB` : <Badge variant="outline">{t("noiseMissing")}</Badge>}</span>,
        <span className="text-ui-xs muted">{item.basis?.value ?? "—"}</span>,
        canWrite ? <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(item.id)}>{t("proofRemove")}</Button> : null,
      ] }))} />}
    {canWrite && <form className="proof-opening-row" onSubmit={(event) => { event.preventDefault(); if (valid) add.mutate(); }}>
      <Field label={t("proofOpeningType")}>
        <NativeSelect size="sm" className="w-full" value={draft.componentType} onChange={(event) => setDraft({ ...draft, componentType: event.target.value as "window" | "door" })}>
          <NativeSelectOption value="window">{t("proofWindow")}</NativeSelectOption>
          <NativeSelectOption value="door">{t("proofDoor")}</NativeSelectOption>
        </NativeSelect>
      </Field>
      <Field label={t("proofOpeningName")}><Input value={draft.name} placeholder={t("proofOptional")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label={t("proofOpeningArea")}><Input value={draft.area} inputMode="decimal" onChange={(event) => setDraft({ ...draft, area: event.target.value })} /></Field>
      <Field label={t("proofOpeningRw")}><Input value={draft.rw} inputMode="decimal" onChange={(event) => setDraft({ ...draft, rw: event.target.value })} /></Field>
      <Field label={t("noiseBasis")}><Input value={draft.basis} placeholder={t("proofRwBasisPlaceholder")} onChange={(event) => setDraft({ ...draft, basis: event.target.value })} /></Field>
      <Button type="submit" size="sm" variant="outline" disabled={!valid || add.isPending}>{t("proofAddOpening")}</Button>
    </form>}
    {(add.isError || remove.isError) && <Callout tone="error">{errorText(add.error ?? remove.error, t)}</Callout>}
  </div>;
}
