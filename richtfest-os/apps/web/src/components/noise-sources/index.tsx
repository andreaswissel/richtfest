import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { noiseInputKeys, noiseInputUnit, requestableNoiseInputs, roadSurfaceTypes, type LocationState, type MappedNoiseSource, type NoiseInputValue, type NoiseSource, type NoiseSourceKind } from "@richtfest/shared";
import { api, ApiError, type RecordData } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input, Textarea } from "../ui/input";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";
import { Badge, Callout, Empty, Field, RowLink, Segmented, Table } from "../ui/primitives";
import { inquiryLink } from "../inquiries/types";
import { useSiteGeometry } from "../location/site-geometry";
import { FacadeDistanceRow } from "../location/site-workbench";
import { mappedClass, mappedDetails, mappedName } from "./labels";
import { FacadeLevels } from "./facade-levels";
import { ProofInputs } from "./proof-inputs";
import { noiseReasonText, noiseReferenceText, useNoiseSuggestions } from "./suggestions";
import "./noise-sources.css";

type T = ReturnType<typeof useT>;
type SurveyMapped = { fileId: string; connectorVersion: string; retrievedAt: string; address: string; roads: MappedNoiseSource[] | null; rail: MappedNoiseSource[] | null; incomplete: boolean; unavailable?: boolean; attribution?: string | null };
type NoiseData = { sources: NoiseSource[]; survey: SurveyMapped | null };

const MAPPED_ROWS = 12;
const invalidate = (projectId: string) => queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith(`/projects/${projectId}/`) });
const sourceLink = (projectId: string, sourceId: string) => `/projects/${projectId}?view=noise&source=${sourceId}`;
const formatDate = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(); };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const inputKeys = {
  dailyTraffic: "noiseInputDailyTraffic", heavyVehicleShare: "noiseInputHeavyVehicleShare", speedLimit: "noiseInputSpeedLimit", roadSurface: "noiseInputRoadSurface",
  distanceToFacade: "noiseInputDistanceToFacade", trafficBasis: "noiseInputTrafficBasis", trainVolumes: "noiseInputTrainVolumes", speed: "noiseInputSpeed", trackType: "noiseInputTrackType",
  surfaceType: "noiseInputSurfaceType", gradient: "noiseInputGradient", ratingLevelDay: "noiseInputRatingLevelDay", ratingLevelNight: "noiseInputRatingLevelNight",
} as const;
export const noiseInputLabel = (key: string, t: T) => key in inputKeys ? t(inputKeys[key as keyof typeof inputKeys]) : key;
const displayValue = (state: NoiseInputValue | undefined) => state ? `${state.value}${state.unit ? ` ${state.unit}` : ""}` : "";

/**
 * Exterior noise sources: which roads and railways reach the facades and the
 * inputs a road/rail emission calculation needs. Mapped objects come from the
 * environment survey; traffic data is entered with its basis or requested.
 */
export function NoiseSources({ projectId, selectedId }: { projectId: string; selectedId: string | null }) {
  const t = useT();
  const path = `/projects/${projectId}/noise-sources`;
  const query = useApi(path);
  const data = query.data as NoiseData | undefined;
  const session = useApi("/auth/me");
  const canWrite = (session.data?.permissions || session.data?.user?.permissions || []).includes("projects:write");
  const [adding, setAdding] = useState<NoiseSourceKind | null>(null);
  const sources = data?.sources ?? [];
  const selected = sources.find((source) => source.id === selectedId);
  return <div className="noise-sources">
    <Section title={t("noiseSources")} meta={canWrite && <div className="inline-actions">
      <Button size="sm" variant="outline" onClick={() => setAdding((value) => value === "road" ? null : "road")} aria-expanded={adding === "road"}>＋ {t("noiseAddRoad")}</Button>
      <Button size="sm" variant="outline" onClick={() => setAdding((value) => value === "rail" ? null : "rail")} aria-expanded={adding === "rail"}>＋ {t("noiseAddRail")}</Button>
    </div>}>
      <Callout>{t("noiseScopeHint")}</Callout>
      {adding && <AddSource projectId={projectId} kind={adding} t={t} onDone={() => setAdding(null)} />}
      {query.isError && <Callout tone="error">{errorText(query.error)}</Callout>}
      {sources.length ? <Table headers={[t("noiseSourceName"), t("noiseSourceKind"), t("noiseInputs"), t("noiseRequested")]}
        rows={sources.map((source) => {
          const total = noiseInputKeys(source.kind).length;
          return { id: source.id, sort: [source.name, source.kind, String(total - source.missing.length), source.inquiryId ?? ""], cells: [
            <RowLink to={sourceLink(projectId, source.id)}>{source.name}</RowLink>,
            <span className="text-ui-xs">{source.kind === "road" ? t("noiseKindRoad") : t("noiseKindRail")}{source.mapped ? ` · ${mappedClass(source.mapped, t)}` : ""}</span>,
            source.missing.length ? <span className="text-ui-xs">{t("noiseInputsOf").replace("{done}", String(total - source.missing.length)).replace("{total}", String(total))}</span>
              : <Badge variant="secondary">{t("noiseInputsComplete")}</Badge>,
            source.inquiryId ? <Link className="text-ui-xs underline underline-offset-2" to={inquiryLink(projectId, source.inquiryId)}>{t("noiseOpenInquiry")}</Link> : <span className="muted text-ui-xs">—</span>,
          ] };
        })} /> : !query.isPending && <Empty>{t("noiseSourcesEmpty")}</Empty>}
    </Section>
    {selected && <SourceInputs key={selected.id} projectId={projectId} source={selected} canWrite={canWrite} t={t} />}
    {selectedId && !selected && query.isSuccess && <Callout>{t("noiseSourceNotFound")}</Callout>}
    {data && <FacadeLevels projectId={projectId} />}
    {data && <ProofInputs projectId={projectId} canWrite={canWrite} />}
    {data && <SuggestedSources projectId={projectId} canWrite={canWrite} t={t} />}
    {data && <MappedSources projectId={projectId} survey={data.survey} sources={sources} canWrite={canWrite} t={t} />}
    {canWrite && sources.some((source) => source.missing.some((field) => (requestableNoiseInputs[source.kind] as readonly string[]).includes(field)))
      && <RequestData projectId={projectId} sources={sources} address={data?.survey?.address ?? null} t={t} />}
  </div>;
}

function AddSource({ projectId, kind, t, onDone }: { projectId: string; kind: NoiseSourceKind; t: T; onDone: () => void }) {
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api<RecordData>(`/projects/${projectId}/noise-sources`, { kind, name: name.trim() }),
    onSuccess: async () => { await invalidate(projectId); onDone(); },
  });
  return <form className="noise-form-row" onSubmit={(event) => { event.preventDefault(); if (name.trim()) add.mutate(); }}>
    <Field label={kind === "road" ? t("noiseRoadName") : t("noiseRailName")} hint={kind === "road" ? t("noiseRoadNameHint") : t("noiseRailNameHint")}>
      <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
    </Field>
    <Button type="submit" size="sm" disabled={add.isPending || !name.trim()}>{kind === "road" ? t("noiseAddRoad") : t("noiseAddRail")}</Button>
    {add.isError && <Callout tone="error">{errorText(add.error)}</Callout>}
  </form>;
}

/** Roads and railways the official topographic model maps around the address, nearest first. */
function SuggestedSources({ projectId, canWrite, t }: { projectId: string; canWrite: boolean; t: T }) {
  const { available, suggestions, reference, add } = useNoiseSuggestions(projectId);
  if (!available) return null;
  return <Section title={t("noiseSuggested")} meta={canWrite && suggestions.length > 1
    && <Button size="sm" variant="outline" disabled={add.isPending} onClick={() => add.mutate(suggestions.map((s) => s.item.ref))}>
      {add.isPending ? t("loading") : t("noiseSuggestedAddAll").replace("{count}", String(suggestions.length))}</Button>}>
    <p className="muted text-ui-xs">{t("noiseSuggestedHint")} {noiseReferenceText(reference, t)}</p>
    {add.isError && <Callout tone="error">{errorText(add.error)}</Callout>}
    {suggestions.length ? <Table headers={[t("noiseSourceName"), t("noiseClass"), t("noiseDistance"), t("noiseSuggestedReason"), ""]}
      rows={suggestions.map(({ item, distanceMeters, radiusMeters, addressDistanceMeters }) => ({ id: item.ref, sort: [mappedName(item, t), mappedClass(item, t), String(distanceMeters).padStart(5, "0"), String(radiusMeters).padStart(5, "0"), ""], cells: [
        mappedName(item, t),
        <span className="text-ui-xs">{mappedClass(item, t)}</span>,
        <span className="text-ui-xs">{distanceMeters} m</span>,
        <span className="text-ui-xs muted">{noiseReasonText(distanceMeters, radiusMeters, addressDistanceMeters, t)}</span>,
        canWrite ? <Button size="sm" variant="ghost" disabled={add.isPending} onClick={() => add.mutate([item.ref])}>{t("noiseAdd")}</Button> : null,
      ] }))} /> : <Empty>{t("noiseSuggestedEmpty")}</Empty>}
  </Section>;
}

function MappedSources({ projectId, survey, sources, canWrite, t }: { projectId: string; survey: SurveyMapped | null; sources: NoiseSource[]; canWrite: boolean; t: T }) {
  const [kind, setKind] = useState<NoiseSourceKind>("road");
  const [all, setAll] = useState(false);
  const added = new Set(sources.map((source) => source.mapped?.ref).filter(Boolean));
  const lookup = useMutation({
    // The location revision guards against a site moved meanwhile; the server resolves Hessen addresses itself.
    mutationFn: async () => {
      const location = await api<LocationState>(`/projects/${projectId}/location`).catch(() => null);
      return api(`/projects/${projectId}/environment`, { revision: location?.revision ?? 0, refresh: !!survey });
    },
    onSuccess: () => invalidate(projectId),
  });
  const add = useMutation({
    mutationFn: (mappedRef: string) => api<RecordData>(`/projects/${projectId}/noise-sources`, { mappedRef }),
    onSuccess: () => invalidate(projectId),
  });
  const items = (kind === "road" ? survey?.roads : survey?.rail) ?? [];
  const shown = all ? items : items.slice(0, MAPPED_ROWS);
  const mappedAvailable = survey && (survey.roads || survey.rail);
  return <Section title={t("noiseMapped")} meta={canWrite && <Button size="sm" variant="outline" disabled={lookup.isPending} onClick={() => lookup.mutate()}>
    {lookup.isPending ? t("loading") : survey ? t("noiseLookupRefresh") : t("noiseLookup")}</Button>}>
    {survey && <p className="muted text-ui-xs">{[survey.address, t("noiseLookupAt").replace("{date}", formatDate(survey.retrievedAt)),
      // Surveys saved before attributions came from the server fall back to the connector prefix; null means no road/rail source was connected.
      survey.attribution !== undefined ? survey.attribution : survey.connectorVersion.startsWith("he-") ? t("noiseAttributionHessen") : survey.connectorVersion.startsWith("be-") ? t("noiseAttributionBerlin") : t("noiseAttributionRlp")].filter(Boolean).join(" · ")}</p>}
    {lookup.isError && <Callout tone="error">{errorText(lookup.error)}</Callout>}
    {!survey && <Empty>{t("noiseLookupEmpty")}</Empty>}
    {survey && !mappedAvailable && <Callout>{t(survey.unavailable ? "noiseLookupUnavailable" : "noiseLookupOutdated")}</Callout>}
    {mappedAvailable && <>
      <div className="noise-toolbar">
        <Segmented items={[{ value: "road", label: `${t("noiseKindRoads")} · ${survey.roads?.length ?? 0}` }, { value: "rail", label: `${t("noiseKindRails")} · ${survey.rail?.length ?? 0}` }]}
          value={kind} onChange={(value) => { setKind(value as NoiseSourceKind); setAll(false); }} />
        <span className="muted text-ui-xs">{t("noiseDistanceHint")}</span>
      </div>
      {survey.incomplete && <Callout>{t("noiseLookupIncomplete")}</Callout>}
      {add.isError && <Callout tone="error">{errorText(add.error)}</Callout>}
      {items.length ? <Table headers={[t("noiseSourceName"), t("noiseClass"), t("noiseMappedDetails"), t("noiseDistance"), ""]}
        rows={shown.map((item) => ({ id: item.ref, sort: [mappedName(item, t), mappedClass(item, t), mappedDetails(item, t), String(item.distanceMeters ?? 99999).padStart(5, "0"), ""], cells: [
          mappedName(item, t),
          <span className="text-ui-xs">{mappedClass(item, t)}</span>,
          <span className="text-ui-xs muted">{mappedDetails(item, t) || "—"}</span>,
          <span className="text-ui-xs">{item.distanceMeters === null ? "—" : `${item.distanceMeters} m`}</span>,
          added.has(item.ref) ? <Badge variant="outline">{t("noiseAdded")}</Badge>
            : canWrite ? <Button size="sm" variant="ghost" disabled={add.isPending} onClick={() => add.mutate(item.ref)}>{t("noiseAdd")}</Button> : null,
        ] }))} /> : <Empty>{kind === "road" ? t("noiseNoRoads") : t("noiseNoRail")}</Empty>}
      {items.length > MAPPED_ROWS && <Button size="sm" variant="link" onClick={() => setAll((value) => !value)}>{all ? t("noiseShowNearest") : t("noiseShowAll").replace("{count}", String(items.length))}</Button>}
    </>}
  </Section>;
}

function SourceInputs({ projectId, source, canWrite, t }: { projectId: string; source: NoiseSource; canWrite: boolean; t: T }) {
  const remove = useMutation({
    mutationFn: () => api(`/projects/${projectId}/noise-sources/${source.id}`, undefined, "DELETE"),
    onSuccess: () => invalidate(projectId),
  });
  return <Section title={source.name} meta={<div className="inline-actions">
    {source.inquiryId && <Link className="text-ui-xs underline underline-offset-2" to={inquiryLink(projectId, source.inquiryId)}>{t("noiseOpenInquiry")}</Link>}
    {canWrite && <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => { if (window.confirm(t("noiseRemoveConfirm"))) remove.mutate(); }}>{t("noiseRemove")}</Button>}
  </div>}>
    {source.mapped && <p className="noise-mapped-note muted text-ui-xs">{t("noiseMappedAs")}: {mappedClass(source.mapped, t)}{mappedDetails(source.mapped, t) ? ` · ${mappedDetails(source.mapped, t)}` : ""}
      {source.mapped.distanceMeters !== null ? ` · ${t("noiseMappedDistance").replace("{distance}", String(source.mapped.distanceMeters))}` : ""}</p>}
    {remove.isError && <Callout tone="error">{errorText(remove.error)}</Callout>}
    <div className="noise-inputs">
      {noiseInputKeys(source.kind).map((key) => <div key={key} className="noise-input-group">
        <InputRow projectId={projectId} source={source} inputKey={key} canWrite={canWrite} t={t} />
        {key === "distanceToFacade" && <MeasuredDistance projectId={projectId} source={source} canWrite={canWrite} t={t} />}
      </div>)}
    </div>
  </Section>;
}

/** The facade distance measured from the placed plan, offered for adoption next to the input. */
function MeasuredDistance({ projectId, source, canWrite, t }: { projectId: string; source: NoiseSource; canWrite: boolean; t: T }) {
  const { geometry } = useSiteGeometry(projectId);
  const item = geometry?.stored ? geometry.distances.find((distance) => distance.sourceId === source.id) : undefined;
  if (!geometry || !item) return null;
  return <div className="noise-measured-distance">
    <span className="muted text-ui-xs">{t("siteMeasuredFromPlan")}</span>
    <FacadeDistanceRow projectId={projectId} geometry={geometry} item={item} canWrite={canWrite} compact />
  </div>;
}

const numericInputs = new Set(["dailyTraffic", "heavyVehicleShare", "speedLimit", "distanceToFacade", "speed", "gradient", "ratingLevelDay", "ratingLevelNight"]);
const surfaceLabel = (surface: string, t: T) => t(`noiseSurface_${surface}` as Parameters<T>[0]);

/** One input: its value with unit and the basis it comes from. Saving appends a version; the server rejects a stale edit. */
function InputRow({ projectId, source, inputKey, canWrite, t }: { projectId: string; source: NoiseSource; inputKey: string; canWrite: boolean; t: T }) {
  const state = source.inputs[inputKey];
  const numeric = numericInputs.has(inputKey);
  const initial = state ? String(state.value) : "", initialBasis = state?.basis ?? "";
  const [value, setValue] = useState(initial), [basis, setBasis] = useState(initialBasis);
  useEffect(() => { setValue(initial); setBasis(initialBasis); }, [initial, initialBasis]);
  const save = useMutation({
    mutationFn: (next: { value: string | number | null; basis: string | null }) =>
      api(`/projects/${projectId}/noise-sources/${source.id}/inputs/${inputKey}`, { ...next, expectedVersion: state?.version ?? 0 }, "PUT"),
    onSuccess: () => invalidate(projectId),
  });
  const parsed = !value.trim() ? null : numeric ? Number(value.replace(",", ".")) : value.trim();
  const valid = parsed === null || typeof parsed === "string" || Number.isFinite(parsed);
  const changed = value !== initial || basis !== initialBasis;
  const unit = noiseInputUnit(source.kind, inputKey);
  const long = inputKey === "trainVolumes";
  const label = `${noiseInputLabel(inputKey, t)}${unit ? ` (${unit})` : ""}`;
  return <form className="noise-input-row" onSubmit={(event) => { event.preventDefault(); if (changed && valid) save.mutate({ value: parsed, basis: basis.trim() || null }); }}>
    <Field label={label}>
      {inputKey === "surfaceType" ? <NativeSelect size="sm" className="w-full" value={value} disabled={!canWrite} onChange={(event) => setValue(event.target.value)}>
        <NativeSelectOption value="">{t("noiseSurfaceChoose")}</NativeSelectOption>
        {roadSurfaceTypes.map((surface) => <NativeSelectOption key={surface} value={surface}>{surfaceLabel(surface, t)}</NativeSelectOption>)}
      </NativeSelect>
        : long ? <Textarea rows={2} value={value} disabled={!canWrite} onChange={(event) => setValue(event.target.value)} />
        : <Input value={value} inputMode={numeric ? "decimal" : undefined} disabled={!canWrite} onChange={(event) => setValue(event.target.value)} />}
    </Field>
    <Field label={t("noiseBasis")}><Input value={basis} placeholder={t("noiseBasisPlaceholder")} disabled={!canWrite} onChange={(event) => setBasis(event.target.value)} /></Field>
    <div className="noise-input-status">
      {canWrite && <Button type="submit" size="sm" variant={changed ? "outline" : "ghost"} disabled={!changed || !valid || save.isPending}>{t("noiseSave")}</Button>}
      {state ? <span className="muted text-ui-2xs">{t("noiseEnteredAt").replace("{date}", formatDate(state.enteredAt))}</span> : <Badge variant="outline">{t("noiseMissing")}</Badge>}
    </div>
    {!valid && <small className="noise-input-error">{t("noiseInvalidNumber")}</small>}
    {save.isError && <Callout tone="error">{save.error instanceof ApiError && save.error.status === 409 ? t("noiseVersionConflict") : errorText(save.error)}</Callout>}
  </form>;
}

/** Text asking an authority or operator for the missing inputs, one line per source. */
export function noiseRequestText(items: Array<{ name: string; kind: NoiseSourceKind; fields: string[] }>, t: T, address: string | null) {
  const intro = address ? t("noiseRequestIntroAddress").replace("{address}", address) : t("noiseRequestIntro");
  return [intro, "", ...items.map((item) => `- ${item.name}: ${item.fields.map((field) => noiseInputLabel(field, t)).join(", ")}`), "", t("noiseRequestOutro")].join("\n");
}

function RequestData({ projectId, sources, address, t }: { projectId: string; sources: NoiseSource[]; address: string | null; t: T }) {
  const candidates = useMemo(() => sources.flatMap((source) => {
    const fields = (requestableNoiseInputs[source.kind] as readonly string[]).filter((field) => source.missing.includes(field));
    return fields.length ? [{ id: source.id, name: source.name, kind: source.kind, fields }] : [];
  }), [sources]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(candidates.filter((item) => !sources.find((source) => source.id === item.id)?.inquiryId).map((item) => item.id)));
  const [counterpart, setCounterpart] = useState("");
  const picked = candidates.filter((item) => chosen.has(item.id));
  const generated = noiseRequestText(picked, t, address);
  const [edited, setEdited] = useState<string | null>(null);
  const body = edited ?? generated;
  const create = useMutation({
    mutationFn: () => api<RecordData>(`/projects/${projectId}/noise-sources/request`, { sourceIds: picked.map((item) => item.id), title: t("noiseRequestTitle"), counterpart: counterpart.trim(),
      request: { subject: t("noiseRequestTitle"), body } }),
    onSuccess: async () => { setEdited(null); setChosen(new Set()); setCounterpart(""); await invalidate(projectId); },
  });
  return <Section title={t("noiseRequest")}>
    <p className="muted text-ui-xs">{t("noiseRequestHint")}</p>
    <div className="noise-request-sources" role="group" aria-label={t("noiseRequestSources")}>
      {candidates.map((item) => <label key={item.id} className="noise-request-source">
        <Checkbox checked={chosen.has(item.id)} onCheckedChange={(checked) => setChosen((current) => { const next = new Set(current); if (checked) next.add(item.id); else next.delete(item.id); return next; })} />
        <span>{item.name}</span><span className="muted text-ui-xs">{item.fields.map((field) => noiseInputLabel(field, t)).join(", ")}</span>
      </label>)}
    </div>
    <div className="noise-request-form">
    <div className="noise-form-row">
      <Field label={t("inquiryCounterpart")} hint={t("noiseRequestCounterpartHint")}><Input value={counterpart} onChange={(event) => setCounterpart(event.target.value)} /></Field>
    </div>
    <Field label={t("noiseRequestBody")} hint={edited !== null ? t("noiseRequestEdited") : undefined}>
      <Textarea rows={Math.min(14, 5 + picked.length)} value={body} onChange={(event) => setEdited(event.target.value)} />
    </Field>
    {create.isError && <Callout tone="error">{errorText(create.error)}</Callout>}
    {create.isSuccess && <Callout>{t("noiseRequestCreated")} <Link className="underline underline-offset-2" to={inquiryLink(projectId, String(create.data.id))}>{t("noiseOpenInquiry")}</Link></Callout>}
    <div className="inline-actions">
      <Button size="sm" disabled={create.isPending || !picked.length || !counterpart.trim()} onClick={() => create.mutate()}>{t("noiseRequestCreate")}</Button>
      {edited !== null && <Button size="sm" variant="ghost" onClick={() => setEdited(null)}>{t("noiseRequestReset")}</Button>}
    </div>
    </div>
  </Section>;
}
