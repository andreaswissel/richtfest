import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { exteriorNoiseRoomKinds, type ExteriorNoiseProof, type ProofFacade, type ProofGap, type ProofRoom, type ProofSuggestion, type ProofValue, type ProofWindow } from "@richtfest/shared";
import { api, ApiError } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { FormPanel, Section, Subsection } from "../layout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";
import { Badge, Callout, Empty, Field, Table } from "../ui/primitives";
import { fieldLabel, optionLabel } from "../building-model/component-properties";

type T = ReturnType<typeof useT>;
type Key = Parameters<T>[0];
type Proof = Extract<ExteriorNoiseProof, { available: true }>;

const db = (value: number) => value.toFixed(1);
const m = (value: number) => value.toFixed(2);
const parseNumber = (text: string) => { const value = Number(text.trim().replace(",", ".")); return text.trim() && Number.isFinite(value) ? value : null; };
export const invalidate = (projectId: string) => queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith(`/projects/${projectId}/`) });
export const errorText = (error: unknown, t: T) => error instanceof ApiError && error.status === 409 ? t("proofConflict") : error instanceof Error ? error.message : String(error);

const kindKeys: Record<string, Key> = {
  sleeping: "proofKindSleeping", living: "proofKindLiving", office: "proofKindOffice", hospital_bedroom: "proofKindHospital", not_protected: "proofKindNotProtected",
};
const gapKeys: Record<ProofGap, Key> = {
  room_kind: "proofGapRoomKind", floor_area: "proofGapFloorArea", clear_height: "proofGapClearHeight", facade_level: "proofGapFacadeLevel",
  wall_rw: "proofGapWallRw", wall_construction: "proofGapWallConstruction", window_area: "proofGapWindowArea", window_rw: "proofGapWindowRw",
  openings_exceed_facade: "proofGapOpeningsExceed", surfaces_unconfirmed: "proofGapSurfaces", applicability: "proofGapApplicability", flanking: "proofGapFlanking",
  no_facade: "proofGapNoFacade", small_element_dnew: "proofGapSmallElementDnew", roof_area: "proofGapRoofArea", roof_rw: "proofGapRoofRw", roof_construction: "proofGapRoofConstruction",
};
const unavailableKeys: Record<string, Key> = {
  norm_pack_missing: "facadeLevelsNoPack", location_missing: "facadeLevelsNoLocation", placement_missing: "facadeLevelsNoPlacement",
  exterior_walls_missing: "facadeLevelsNoExterior", model_missing: "proofNoModel",
};

// Every model write raises its revision. Consecutive saves (a value and its basis) continue from the
// revision the previous save returned instead of the one last read, which the server would reject.
const latestRevision = new Map<string, number>();
export const baseRevision = (projectId: string, proof: { modelRevision: number }) => Math.max(proof.modelRevision, latestRevision.get(projectId) ?? 0);
export const noteRevision = (projectId: string, result: unknown) => {
  const revision = (result as { revision?: unknown } | null)?.revision;
  if (typeof revision === "number") latestRevision.set(projectId, Math.max(revision, latestRevision.get(projectId) ?? 0));
};

/** Saves one building-model property as a manual, unreviewed value. */
export function useSaveProperty(projectId: string, proof: { modelRevision: number }) {
  return useMutation({
    mutationFn: (input: { entityType: "building" | "storey" | "room" | "element"; entityId: string; propertyKey: string; value: unknown; unit?: string | null }) =>
      api(`/projects/${projectId}/building-model/properties`, { baseRevision: baseRevision(projectId, proof), provenance: "manual", evidence: [], unit: null, ...input }),
    onSuccess: (result) => { noteRevision(projectId, result); return invalidate(projectId); },
  });
}

const facadeLabel = (facade: ProofFacade) => `${facade.compass ? `${facade.compass} · ` : ""}${facade.wallName}`;
const reviewBadge = (value: ProofValue<unknown> | null, t: T) => value && <Badge variant="outline">{value.reviewStatus === "approved" ? t("proofReviewed")
  : value.provenance === "inferred" ? t("proofSuggested") : t("proofEntered")}</Badge>;

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
  const missingRw = canWrite && protectedRooms.some(room => room.facades.some(facade => !facade.rw || facade.windows.some(item => item.componentType === "window" && !item.rw)));
  return <Section title={t("proof")} meta={<Badge variant="outline">{t("facadeLevelsDraft")}</Badge>}>
    <p className="noise-intro muted text-ui-xs">{t("proofIntro").replace("{plans}", proof.storeys.map(storey => t("proofPlan").replace("{storey}", storey.name)
      .replace("{file}", storey.page.fileName ?? "—").replace("{page}", String(storey.page.page))).join(", "))}</p>
    <Subsection title={t("proofBuildingInputs")}>
      <BuildingInputs projectId={projectId} proof={proof} canWrite={canWrite} t={t} />
    </Subsection>
    {proof.suggestions.length > 0 && <Suggestions projectId={projectId} proof={proof} canWrite={canWrite} t={t} />}
    <Subsection title={t("proofRooms")} meta={t("proofRoomsCalculated").replace("{ready}", String(ready)).replace("{total}", String(protectedRooms.length))}>
    {missingRw && <CatalogueSuggestions projectId={projectId} t={t} />}
    {proof.rooms.length ? <Table headers={[t("proofRoom"), t("proofUse"), t("proofFloorArea"), t("proofFacades"), t("proofResult"), ""]}
      rows={proof.rooms.map(room => ({ id: room.id, sort: [room.label, room.kind?.value ?? "", String(room.floorAreaM2 ?? 0), String(room.facades.length), room.result?.status ?? room.gaps.join(), ""], cells: [
        <span>{room.label}{room.roomUse && <span className="muted text-ui-xs"> · {room.roomUse}</span>}</span>,
        <RoomKind projectId={projectId} proof={proof} room={room} canWrite={canWrite} t={t} />,
        <span className="text-ui-xs">{room.floorAreaM2 === null ? "—" : `${m(room.floorAreaM2)} m²`}</span>,
        <span className="proof-facades text-ui-xs muted">{[...room.facades.map(facade => `${facade.compass ?? "—"} ${m(facade.lengthM)} m${facade.la ? ` · La ${db(facade.la.dayDb)}/${db(facade.la.sleepingDb)}` : ""}`),
          ...room.roofs.map(roof => `${t("proofRoof")}${roof.area ? ` ${m(roof.area.value)} m²` : ""}`)].join("; ") || "—"}</span>,
        <RoomResult room={room} t={t} />,
        room.kind?.value !== "not_protected"
          ? <Button size="sm" variant={open === room.id ? "outline" : "ghost"} aria-expanded={open === room.id} onClick={() => setOpen(open === room.id ? null : room.id)}>
            {open === room.id ? t("proofCloseRoom") : t("proofEditRoom")}</Button> : null,
      ] }))} /> : <Empty>{t("proofNoRooms")}</Empty>}
    {selected && <RoomEditor key={selected.id} projectId={projectId} proof={proof} room={selected} canWrite={canWrite} t={t} onClose={() => setOpen(null)} />}
    </Subsection>
    <Subsection title={t("proofNachweis")}>
      <Callout>{t("proofLimitations")}</Callout>
      {canWrite && <CreateNachweis projectId={projectId} proof={proof} ready={ready} total={protectedRooms.length} t={t} />}
    </Subsection>
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

const enumKeys = new Set(["exteriorNoiseApplicability", "exteriorNoiseFlanking", "exteriorNoiseRoom", "construction", "wallRole", "ceilingRole", "screedType"]);
const suggestedValue = (item: ProofSuggestion, t: T) => typeof item.value === "boolean" ? t(item.value ? "proofYes" : "proofNo")
  : enumKeys.has(item.propertyKey) ? optionLabel(item.propertyKey, String(item.value), t) : `${String(item.value)}${item.unit ? ` ${item.unit}` : ""}`;

/** Values Richtfest suggested with their cited page; the planner accepts or rejects each, or all at once. */
export function Suggestions({ projectId, proof, canWrite, t }: { projectId: string; proof: { modelRevision: number; suggestions: ProofSuggestion[] }; canWrite: boolean; t: T }) {
  const review = useMutation({
    mutationFn: (input: { decision: "approved" | "rejected"; items: ProofSuggestion[] }) => api(`/projects/${projectId}/building-model/properties/review`, {
      baseRevision: baseRevision(projectId, proof), decision: input.decision,
      items: input.items.map(item => ({ propertyId: item.propertyId, version: item.version, reviewRevision: item.reviewRevision })) }),
    onSuccess: (result) => { noteRevision(projectId, result); return invalidate(projectId); },
  });
  // Long lists stay scannable: the first rows, then all on request; Accept all still covers every suggestion.
  const [all, setAll] = useState(false);
  const shown = all ? proof.suggestions : proof.suggestions.slice(0, SUGGESTIONS_SHOWN);
  return <Subsection title={t("proofSuggestions")} meta={t("proofSuggestionsHint")}
    actions={canWrite && <Button size="sm" variant="outline" disabled={review.isPending} onClick={() => review.mutate({ decision: "approved", items: proof.suggestions })}>
      {t("proofAcceptAll").replace("{count}", String(proof.suggestions.length))}</Button>}>
    <Table headers={[t("proofSuggestionFor"), t("proofSuggestionField"), t("proofSuggestionValue"), t("proofSuggestionSource"), ""]}
      rows={shown.map(item => ({ id: `${item.propertyId}:${item.version}`, cells: [
        <span>{item.entityLabel || t("proofBuilding")}</span>,
        <span className="text-ui-xs">{fieldLabel(item.propertyKey, t)}</span>,
        <span className="text-ui-xs proof-value" title={suggestedValue(item, t)}>{suggestedValue(item, t)}</span>,
        <span className="text-ui-xs muted" title={item.evidence?.quote ?? undefined}>{item.evidence
          ? `${item.evidence.fileName ?? "—"}, ${t("proofPage").replace("{page}", String(item.evidence.page))}${item.evidence.quote ? ` · „${item.evidence.quote}“` : ""}` : "—"}</span>,
        canWrite ? <span className="proof-inline">
          <Button size="sm" variant="ghost" disabled={review.isPending} onClick={() => review.mutate({ decision: "approved", items: [item] })}>{t("proofAccept")}</Button>
          <Button size="sm" variant="ghost" disabled={review.isPending} onClick={() => review.mutate({ decision: "rejected", items: [item] })}>{t("proofReject")}</Button>
        </span> : null,
      ] }))} />
    {shown.length < proof.suggestions.length && <div><Button size="sm" variant="ghost" onClick={() => setAll(true)}>{t("proofShowAllSuggestions").replace("{count}", String(proof.suggestions.length))}</Button></div>}
    {review.isError && <Callout tone="error">{errorText(review.error, t)}</Callout>}
  </Subsection>;
}
const SUGGESTIONS_SHOWN = 6;

type CatalogueResult = { status: string; reason?: string; written: number; walls: Array<{ wallId: string; wall: string; status: string; rwDb: number | null; reason: string | null }>;
  windows?: Array<{ windowId: string; window: string; status: string; rwDb: number | null; reason: string | null }> };
const catalogueReasons: Record<string, Key> = {
  not_massive: "proofCatalogueNotMassive", material_unknown: "proofCatalogueMaterialUnknown", multi_leaf: "proofCatalogueMultiLeaf",
  thickness_missing: "proofCatalogueThicknessMissing", density_missing: "proofCatalogueDensityMissing", density_class_out_of_range: "proofCatalogueOutOfRange",
  perforated_not_homogeneous: "proofCataloguePerforated", mass_out_of_range: "proofCatalogueOutOfRange", catalogue_missing: "proofCatalogueMissing",
  entered_or_reviewed: "proofCatalogueEntered", rejected_before: "proofCatalogueRejected", already_suggested: "proofCatalogueAlready",
  glazing_missing: "proofCatalogueGlazingMissing", glazing_unreadable: "proofCatalogueGlazingUnreadable", below_catalogue: "proofCatalogueBelowCatalogue",
};

/** Suggests the Rw of massive exterior walls and windows without one from the component catalogue; unclear ones say what is missing. */
function CatalogueSuggestions({ projectId, t }: { projectId: string; t: T }) {
  const suggest = useMutation({
    mutationFn: () => api<CatalogueResult>(`/projects/${projectId}/exterior-noise/proof/catalogue`, {}),
    onSuccess: (result) => { noteRevision(projectId, result); return invalidate(projectId); },
  });
  const result = suggest.data;
  const open = [...(result?.walls ?? []).map(wall => ({ name: wall.wall, status: wall.status, reason: wall.reason })),
    ...(result?.windows ?? []).map(item => ({ name: item.window, status: item.status, reason: item.reason }))].filter(item => item.status !== "suggested");
  return <div className="proof-catalogue">
    <Button size="sm" variant="outline" disabled={suggest.isPending} onClick={() => suggest.mutate()}>{suggest.isPending ? t("loading") : t("proofCatalogueSuggest")}</Button>
    {result && <span className="muted text-ui-xs" role="status">
      {result.status === "unavailable" ? t(catalogueReasons[result.reason ?? ""] ?? "proofCatalogueMissing")
        : [t("proofCatalogueResult").replace("{count}", String(result.written)),
          ...open.map(item => `${item.name}: ${item.reason ? t(catalogueReasons[item.reason] ?? "proofCatalogueMaterialUnknown") : "—"}`)].join(" · ")}
    </span>}
    {!result && !suggest.isPending && <span className="muted text-ui-xs">{t("proofCatalogueHint")}</span>}
    {suggest.isError && <small className="noise-input-error">{errorText(suggest.error, t)}</small>}
  </div>;
}

function RoomResult({ room, t }: { room: ProofRoom; t: T }) {
  if (room.kind?.value === "not_protected") return <span className="muted text-ui-xs">{t("proofNotProtected")}</span>;
  if (room.result?.status === "calculated" && room.result.valueDb !== null && room.result.targetDb !== null && room.result.marginDb !== null)
    return <span className="text-ui-xs">
      <Badge variant={room.result.marginDb >= 0 ? "outline" : "destructive"}>{room.result.marginDb >= 0 ? t("proofMeets") : t("proofBelow")}</Badge>{" "}
      {t("proofValues").replace("{value}", db(room.result.valueDb)).replace("{target}", db(room.result.targetDb)).replace("{margin}", `${room.result.marginDb >= 0 ? "+" : ""}${db(room.result.marginDb)}`)}
    </span>;
  if (room.result?.reason) return <span className="proof-gaps text-ui-xs muted">{room.result.reason}</span>;
  return <span className="proof-gaps text-ui-xs muted">{t("proofMissing")}: {room.gaps.map(gap => t(gapKeys[gap])).join(", ")}</span>;
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
  return <div className="proof-building">
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
    {proof.storeys.map(storey => <StoreyHeight key={storey.id} projectId={projectId} proof={proof} storey={storey} canWrite={canWrite} t={t} />)}
    {save.isError && <Callout tone="error">{errorText(save.error, t)}</Callout>}
  </div>;
}

/** One storey's clear room height; exterior and interior sound insulation share it. */
export function StoreyHeight({ projectId, proof, storey, canWrite, t }: { projectId: string; proof: { modelRevision: number }; storey: { id: string; name: string; clearHeight: ProofValue<number> | null }; canWrite: boolean; t: T }) {
  const save = useSaveProperty(projectId, proof);
  const initial = storey.clearHeight ? String(storey.clearHeight.value) : "";
  const [height, setHeight] = useState(initial);
  useEffect(() => setHeight(initial), [initial]);
  const value = parseNumber(height);
  const submit = (event: FormEvent) => { event.preventDefault();
    if (value !== null && height !== initial) save.mutate({ entityType: "storey", entityId: storey.id, propertyKey: "clearRoomHeight", value, unit: "m" }); };
  return <form onSubmit={submit}>
    <Field label={t("proofClearHeight").replace("{storey}", storey.name)}>
      <span className="proof-inline">
        <Input value={height} inputMode="decimal" disabled={!canWrite} onChange={(event) => setHeight(event.target.value)} aria-invalid={Boolean(height.trim()) && value === null} />
        {canWrite && <Button type="submit" size="sm" variant="outline" disabled={value === null || height === initial || save.isPending}>{t("noiseSave")}</Button>}
      </span>
    </Field>
    {save.isError && <Callout tone="error">{errorText(save.error, t)}</Callout>}
  </form>;
}


function RoomEditor({ projectId, proof, room, canWrite, t, onClose }: { projectId: string; proof: Proof; room: ProofRoom; canWrite: boolean; t: T; onClose: () => void }) {
  const save = useSaveProperty(projectId, proof);
  return <div className="proof-room" role="region" aria-label={room.label}>
    <div className="proof-room-heading">
      <h4>{room.label}</h4>
      <span className="muted text-ui-xs">{t("proofRoomFacades").replace("{count}", String(room.facades.length))}</span>
      <Button size="sm" variant="ghost" onClick={onClose}>{t("proofCloseRoom")}</Button>
    </div>
    {room.facades.map(facade => <FacadeEditor key={facade.wallId} projectId={projectId} proof={proof} room={room} facade={facade} canWrite={canWrite} t={t} />)}
    <Roofs projectId={projectId} proof={proof} room={room} canWrite={canWrite} t={t} />
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
    <p className="proof-part-title"><strong>{facadeLabel(facade)}</strong>{" "}
      <span className="muted text-ui-xs">
        {facade.areaM2 === null ? t("proofFacadeLength").replace("{length}", m(facade.lengthM)) : t("proofFacadeArea").replace("{length}", m(facade.lengthM)).replace("{height}", String(proof.storeys.find(storey => storey.id === room.storeyId)?.clearHeight?.value ?? "")).replace("{area}", m(facade.areaM2))}
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
  type Kind = "window" | "door" | "small_element";
  const empty = { componentType: "window" as Kind, name: "", area: "", rw: "", basis: "", count: "1", glazing: "" };
  const [draft, setDraft] = useState(empty);
  const small = draft.componentType === "small_element";
  const add = useMutation({
    mutationFn: () => api(`/projects/${projectId}/exterior-noise/proof/openings`, {
      baseRevision: baseRevision(projectId, proof), roomId: room.id, wallId: facade.wallId, componentType: draft.componentType,
      name: draft.name.trim() || `${t(openingKeys[draft.componentType])} ${facade.windows.length + 1}`,
      area: parseNumber(draft.area), basis: draft.basis.trim() || null,
      ...(small ? { rw: null, dnew: parseNumber(draft.rw), count: parseNumber(draft.count) } : { rw: parseNumber(draft.rw) }),
      ...(draft.componentType === "window" && draft.glazing.trim() ? { glazing: draft.glazing.trim() } : {}) }),
    onSuccess: async (result) => { noteRevision(projectId, result); setDraft(empty); await invalidate(projectId); },
  });
  const remove = useRemoveElement(projectId, proof);
  const count = parseNumber(draft.count);
  const valid = (small ? count !== null && Number.isInteger(count) && count >= 1 && (!draft.area.trim() || parseNumber(draft.area) !== null) : parseNumber(draft.area) !== null)
    && (!draft.rw.trim() || parseNumber(draft.rw) !== null);
  return <div className="proof-openings">
    {facade.windows.length > 0 && <Table headers={[t("proofOpening"), t("proofOpeningArea"), t("proofOpeningRating"), t("noiseBasis"), " "]}
      rows={facade.windows.map(item => ({ id: item.id, cells: [
        <span>{item.name} <span className="muted text-ui-xs">· {t(openingKeys[item.componentType])}</span></span>,
        <span className="text-ui-xs">{item.componentType === "small_element"
          ? `${item.count?.value ?? 1} ×${item.area ? ` ${m(item.area.value)} m²` : ""}` : item.area ? `${m(item.area.value)} m²` : "—"}</span>,
        <span className="text-ui-xs">{item.componentType === "small_element"
          ? item.dnew ? `Dn,e,w ${db(item.dnew.value)} dB` : <Badge variant="outline">{t("noiseMissing")}</Badge>
          : item.rw ? `Rw ${db(item.rw.value)} dB` : <><Badge variant="outline">{t("noiseMissing")}</Badge>{item.glazing ? <span className="muted"> · {item.glazing.value}</span> : null}</>}</span>,
        <span className="text-ui-xs muted proof-basis" title={item.basis?.value}>{item.basis?.value ?? "—"}</span>,
        canWrite ? <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(item.id)}>{t("proofRemove")}</Button> : null,
      ] }))} />}
    {canWrite && <FormPanel title={t("proofAddOpeningTitle")}><form className={`proof-opening-row${draft.componentType === "window" ? " with-glazing" : ""}`} onSubmit={(event) => { event.preventDefault(); if (valid) add.mutate(); }}>
      <Field label={t("proofOpeningType")}>
        <NativeSelect size="sm" className="w-full" value={draft.componentType} onChange={(event) => setDraft({ ...draft, componentType: event.target.value as Kind })}>
          <NativeSelectOption value="window">{t("proofWindow")}</NativeSelectOption>
          <NativeSelectOption value="door">{t("proofDoor")}</NativeSelectOption>
          <NativeSelectOption value="small_element">{t("proofSmallElement")}</NativeSelectOption>
        </NativeSelect>
      </Field>
      <Field label={t("proofOpeningName")}><Input value={draft.name} placeholder={t("proofOptional")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
      {small
        ? <Field label={t("proofSmallElementCount")}><Input value={draft.count} inputMode="numeric" onChange={(event) => setDraft({ ...draft, count: event.target.value })} aria-invalid={count === null} /></Field>
        : <Field label={t("proofOpeningArea")}><Input value={draft.area} inputMode="decimal" onChange={(event) => setDraft({ ...draft, area: event.target.value })} /></Field>}
      <Field label={small ? t("proofSmallElementDnew") : t("proofOpeningRw")}><Input value={draft.rw} inputMode="decimal" onChange={(event) => setDraft({ ...draft, rw: event.target.value })} /></Field>
      <Field label={t("noiseBasis")}><Input value={draft.basis} placeholder={t("proofRwBasisPlaceholder")} onChange={(event) => setDraft({ ...draft, basis: event.target.value })} /></Field>
      {draft.componentType === "window" && <Field label={t("proofGlazing")}><Input value={draft.glazing} placeholder="6/16/4" title={t("proofGlazingHint")} onChange={(event) => setDraft({ ...draft, glazing: event.target.value })} /></Field>}
      <Button type="submit" size="sm" variant="outline" disabled={!valid || add.isPending}>{t(small ? "proofAddSmallElement" : "proofAddOpening")}</Button>
    </form></FormPanel>}
    {(add.isError || remove.isError) && <Callout tone="error">{errorText(add.error ?? remove.error, t)}</Callout>}
  </div>;
}

const openingKeys: Record<ProofWindow["componentType"], Key> = { window: "proofWindow", door: "proofDoor", small_element: "proofSmallElement" };

function useRemoveElement(projectId: string, proof: Proof) {
  return useMutation({
    mutationFn: (elementId: string) => api(`/projects/${projectId}/exterior-noise/proof/openings/${elementId}?baseRevision=${baseRevision(projectId, proof)}`, undefined, "DELETE"),
    onSuccess: (result) => { noteRevision(projectId, result); return invalidate(projectId); },
  });
}

/** Roof surfaces over the room: area and Rw. A roof takes the loudest La of the room's facades. */
function Roofs({ projectId, proof, room, canWrite, t }: { projectId: string; proof: Proof; room: ProofRoom; canWrite: boolean; t: T }) {
  const empty = { name: "", construction: "concrete", area: "", rw: "", basis: "" };
  const [draft, setDraft] = useState(empty);
  const add = useMutation({
    mutationFn: () => api(`/projects/${projectId}/exterior-noise/proof/openings`, {
      baseRevision: baseRevision(projectId, proof), roomId: room.id, wallId: null, componentType: "roof", construction: draft.construction,
      name: draft.name.trim() || `${t("proofRoof")} ${room.roofs.length + 1}`, area: parseNumber(draft.area), rw: parseNumber(draft.rw), basis: draft.basis.trim() || null }),
    onSuccess: async (result) => { noteRevision(projectId, result); setDraft(empty); await invalidate(projectId); },
  });
  const remove = useRemoveElement(projectId, proof);
  const valid = parseNumber(draft.area) !== null && (!draft.rw.trim() || parseNumber(draft.rw) !== null);
  if (!room.roofs.length && !canWrite) return null;
  return <div className="proof-facade">
    <p className="proof-part-title"><strong>{t("proofRoofs")}</strong> <span className="muted text-ui-xs">{t("proofRoofsHint")}</span></p>
    {room.roofs.length > 0 && <Table headers={[t("proofRoof"), t("proofRoofArea"), t("proofOpeningRating"), t("noiseBasis"), " "]}
      rows={room.roofs.map(roof => ({ id: roof.id, cells: [
        <span>{roof.name} <span className="muted text-ui-xs">· {t(roof.construction === "massive" ? "proofConstructionMassive" : roof.construction === "lightweight" ? "proofConstructionLightweight" : "proofConstructionUnknown")}</span></span>,
        <span className="text-ui-xs">{roof.area ? `${m(roof.area.value)} m²` : <Badge variant="outline">{t("noiseMissing")}</Badge>}</span>,
        <span className="text-ui-xs">{roof.rw ? `Rw ${db(roof.rw.value)} dB` : <Badge variant="outline">{t("noiseMissing")}</Badge>}</span>,
        <span className="text-ui-xs muted">{roof.basis?.value ?? "—"}</span>,
        canWrite ? <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(roof.id)}>{t("proofRemove")}</Button> : null,
      ] }))} />}
    {canWrite && <FormPanel title={t("proofAddRoof")}><form className="proof-opening-row" onSubmit={(event) => { event.preventDefault(); if (valid) add.mutate(); }}>
      <Field label={t("proofOpeningName")}><Input value={draft.name} placeholder={t("proofOptional")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label={t("proofRoofConstruction")}>
        <NativeSelect size="sm" className="w-full" value={draft.construction} onChange={(event) => setDraft({ ...draft, construction: event.target.value })}>
          {["concrete", "masonry", "timber", "steel", "drywall"].map(option => <NativeSelectOption key={option} value={option}>{optionLabel("construction", option, t)}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
      <Field label={t("proofRoofArea")}><Input value={draft.area} inputMode="decimal" onChange={(event) => setDraft({ ...draft, area: event.target.value })} /></Field>
      <Field label={t("proofOpeningRw")}><Input value={draft.rw} inputMode="decimal" onChange={(event) => setDraft({ ...draft, rw: event.target.value })} /></Field>
      <Field label={t("noiseBasis")}><Input value={draft.basis} placeholder={t("proofRwBasisPlaceholder")} onChange={(event) => setDraft({ ...draft, basis: event.target.value })} /></Field>
      <Button type="submit" size="sm" variant="outline" disabled={!valid || add.isPending}>{t("proofAddRoof")}</Button>
    </form></FormPanel>}
    {(add.isError || remove.isError) && <Callout tone="error">{errorText(add.error ?? remove.error, t)}</Callout>}
  </div>;
}
