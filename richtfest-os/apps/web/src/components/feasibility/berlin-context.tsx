import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { GeometryEvidence, GeometryPoint, PlanOverlay } from "@richtfest/shared/site-geometry-model";
import { api } from "../../api";
import { queryClient } from "../../query";
import { SitePlanAlignment, usePlanRaster } from "./site-plan-overlay";
import type { TracedLines } from "./plan-lines";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Badge, Callout } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { compareSiteReferences, type SiteAssessmentConstraint, type SiteAssessmentInput, type SiteReference } from "@richtfest/shared";

import { protectionAt, useBerlinContext, useSiteDiscovery, type BerlinHint, type BerlinParcel as Parcel } from "./site-lookups";
import { SiteParcelMap } from "./site-parcel-map";
import { correctReferenceStoreys, parcelReference, storeysFromHeight } from "./site-summary";
const VISIBLE_PARCELS = 5;

export function BerlinContext({ projectId, disabled, onAdopt, onParcel, onDesign, siteLocator, adopted, references = [], onReferences, active = true, plan: alignment }: {
  projectId: string;
  disabled: boolean;
  siteLocator?: SiteAssessmentInput["siteLocator"];
  onParcel?: (parcel: Parcel) => void;
  onAdopt: (value: SiteAssessmentConstraint, parcel: Parcel) => void;
  /** Opens the Design step on the parcel; called after adopting it when it is not the site yet. */
  onDesign?: () => void;
  /** The parcel already in the assessment draft. */
  adopted?: { id: string; label: string; area: number | null; reviewed: boolean } | null;
  /** § 34 references; parcels picked on the map join them with their observed GRZ, GFZ and storeys. */
  references?: SiteReference[];
  onReferences?: (references: SiteReference[]) => void;
  /** The Site step is shown: the lookup then runs on its own, so the aerial map with its data is always there. */
  active?: boolean;
  /** Plan overlay of the assessment geometry, aligned here on the aerial map with three points. */
  plan?: { overlay: PlanOverlay | null; parcel: GeometryEvidence | null; envelopeReviewed: boolean; onChange: (overlay: PlanOverlay | null) => void; onTrace: (traced: TracedLines) => void };
}) {
  const t = useT(), language = usePreferences(s => s.language);
  const label = (key: string) => t(`berlinContext${key}` as Parameters<typeof t>[0]);
  const locale = language === "de" ? "de-DE" : "en-GB";
  const [selected, setSelected] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const [justAdopted, setJustAdopted] = useState<string>();
  const lookup = useBerlinContext(projectId, siteLocator);
  const context = lookup.data;
  // Discovery is only read from the cache here; its references add observed GRZ/GFZ and footprints to the map.
  const discoveryQuery = useSiteDiscovery(projectId, siteLocator);
  const discovery = discoveryQuery.data;
  // Neighbour GRZ/GFZ and storeys come from the nearby-buildings lookup; run it with the parcel lookup so the map shows them.
  useEffect(() => {
    if (context && !discoveryQuery.data && !discoveryQuery.isFetching && !discoveryQuery.isError) void discoveryQuery.refetch();
  }, [lookup.dataUpdatedAt]);
  useEffect(() => {
    if (active && !lookup.data && !lookup.isFetching && !lookup.error) void lookup.refetch();
  }, [active, lookup.data, lookup.error]);
  // Plan overlay: import the covering B-Plan PDF into project sources, then align it on this map.
  const [picking, setPicking] = useState(false), [pickedSite, setPickedSite] = useState<GeometryPoint | null>(null);
  const [focusSource, setFocusSource] = useState<{ versionId: string; at: number } | null>(null);
  const [engine, setEngine] = useState<typeof import("@richtfest/shared/site-geometry")>();
  useEffect(() => { if (alignment?.overlay) void import("@richtfest/shared/site-geometry").then(setEngine); }, [!!alignment?.overlay]);
  const planImage = usePlanRaster(projectId, alignment?.overlay ?? null);
  const affine = alignment?.overlay && engine?.affineFromControlPoints(alignment.overlay.controlPoints);
  const importPlan = useMutation({
    mutationFn: (url: string) => api<{ versionId: string }>(`/feasibility/projects/${projectId}/evidence/import`, { url, ...(siteLocator ? { mapOrigin: siteLocator.origin, mapLabel: siteLocator.label } : {}) }, "POST"),
    onSuccess: async (source) => {
      await queryClient.invalidateQueries({ queryKey: [`/feasibility/projects/${projectId}/evidence`] });
      setFocusSource({ versionId: source.versionId, at: Date.now() });
    },
  });
  useEffect(() => {
    if (!context) return;
    setSelected(context.parcels.find(p => p.containsAddress)?.id);
    setShowAll(false);
    setJustAdopted(undefined);
  }, [lookup.dataUpdatedAt]);
  const parcels = [...(context?.parcels ?? [])].sort((a, b) => Number(b.containsAddress) - Number(a.containsAddress));
  const visible = showAll ? parcels : parcels.slice(0, VISIBLE_PARCELS);
  // Keep a parcel chosen on the preview visible in the table.
  if (!showAll && selected && !visible.some(p => p.id === selected)) visible.push(parcels.find(p => p.id === selected)!);
  const num = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 });
  const range = (r: { mean: number; max: number } | null) => r ? `${r.mean.toLocaleString(locale, { maximumFractionDigits: 2 })} – ${r.max.toLocaleString(locale, { maximumFractionDigits: 2 })}` : "–";
  const area = (n: number | null) => n === null ? "–" : `${n.toLocaleString(locale)} m²`;
  const referenceIds = new Set(references.flatMap(r => r.parcelId ? [r.parcelId] : []));
  const frame = compareSiteReferences(references);
  const toggleReference = (parcel: Parcel, storeys?: number) => {
    if (!onReferences || !discovery) return;
    const kept = references.filter(r => r.parcelId !== parcel.id);
    if (referenceIds.has(parcel.id) && storeys === undefined) return onReferences(kept);
    const existing = references.find(r => r.id === `parcel:${parcel.id}`), proposed = existing ?? parcelReference(parcel, discovery);
    if (!proposed) return;
    const height = proposed.metrics?.ridgeHeight?.value;
    onReferences([...kept, storeys === undefined ? proposed : correctReferenceStoreys(proposed, storeys, `${label("HeightStoreysSource").replace("{height}", num(height ?? 0))} · ${proposed.metrics?.ridgeHeight?.source ?? ""}`.slice(0, 2000))]);
  };
  const adopt = (parcel: Parcel) => {
    setSelected(parcel.id);
    setJustAdopted(parcel.id);
    onParcel?.(parcel);
    onAdopt({ value: parcel.area, source: `${parcel.sourceUrl} · ${parcel.id} · retrieved ${context!.retrievedAt}`, sourceDate: parcel.sourceDate, kind: "official", reviewed: false }, parcel);
  };
  return <Section title={label("Title")} meta={<Button size="sm" variant="outline" disabled={lookup.isFetching} onClick={() => void lookup.refetch()}>
    <Search className="size-icon-sm" aria-hidden="true" />{lookup.isFetching ? label("Loading") : label(adopted || context ? "LoadAgain" : "Load")}
  </Button>}>
    {adopted && <div className="site-adopted text-ui-xs" role="status">
      <span className="muted">{label("AdoptedParcel")}</span>
      <strong>{adopted.label}</strong>
      <span>{area(adopted.area)}</span>
      <Badge variant="outline">{t(adopted.reviewed ? "siteAssessmentReviewedShort" : "siteAssessmentUnreviewed")}</Badge>
    </div>}
    <p className="muted text-ui-xs">{label(adopted ? "HintAdopted" : "Hint")}</p>
    {lookup.error && !lookup.isFetching && <Callout tone="error">
      <p>{lookup.error.message}</p>
      <Link className="underline" to={`/projects/${projectId}?view=details`}>{t("projectDetails")} ↗</Link>
    </Callout>}
    {justAdopted && <Callout tone="success">{label("AdoptedNotice").replace("{parcel}", parcels.find(p => p.id === justAdopted)?.label ?? "")}</Callout>}
    {context && <>
      <p className="text-ui-xs">{context.address} · {label("Retrieved")} {new Date(context.retrievedAt).toLocaleString(locale)}</p>
      {context.parcelStatus !== "available" && <Callout>{label("ParcelsUnavailable")}</Callout>}
      {onReferences && references.length > 0 && <p className="site-reference-frame text-ui-xs" role="status">
        <strong>{label("ReferencesChosen").replace("{count}", String(references.length))}</strong>
        <span>GRZ {range(frame.grz)}</span><span>GFZ {range(frame.gfz)}</span><span>{label("Storeys")} {range(frame.storeys)}</span>
        <span className="muted">{label("ReferencesFrameHint")}</span>
      </p>}
      {parcels.length > 0 ? <div className="berlin-parcels">
        <SiteParcelMap projectId={projectId} context={context} discovery={discovery} selected={selected} adoptedId={adopted?.id} referenceIds={referenceIds} onSelect={setSelected}
          planOverlay={planImage && affine && alignment?.overlay ? { image: planImage, affine, opacity: alignment.overlay.opacity } : null}
          picking={picking} onPick={(point) => { setPickedSite(point); setPicking(false); }}
          renderPanel={(parcel, facts) => <>
            <dl className="site-map-facts text-ui-xs">
              <dt>{label("Area")}</dt><dd className="tabular-nums">{area(parcel.area)}</dd>
              <dt>{label("Relation")}</dt><dd>{parcel.containsAddress ? <Badge variant="outline">{label("Contains")}</Badge> : label("Nearby")}</dd>
              <dt>{label("LastChange")}</dt><dd>{parcel.sourceDate ? new Date(parcel.sourceDate).toLocaleDateString(locale) : "–"}</dd>
              <dt>GRZ 1</dt><dd className="tabular-nums">{facts.grz != null ? num(facts.grz) : <span className="muted">{label(discovery ? "NoRatios" : discoveryQuery.isFetching ? "RatiosLoading" : "RatiosAfterDiscovery")}</span>}</dd>
              {facts.grz != null && <><dt>GRZ 2</dt><dd className="tabular-nums">{facts.grz2 != null ? `≥ ${num(facts.grz2)}` : "–"}</dd>
              <dt>GFZ</dt><dd className="tabular-nums">{facts.gfz != null ? num(facts.gfz) : "–"}</dd>
              <dt>{label("Storeys")}</dt><dd className="tabular-nums">{facts.storeys != null ? facts.storeys : "–"}</dd></>}
            </dl>
            {facts.grz != null && <p className="muted text-ui-2xs">{label("RatiosHint")}</p>}
            {(() => {
              // Reference plot: observed figures plus a height cross-check, since reported storeys can be wrong.
              const own = adopted?.id === parcel.id || parcel.containsAddress;
              const chosen = references.find(r => r.parcelId === parcel.id && r.id === `parcel:${parcel.id}`) ?? references.find(r => r.parcelId === parcel.id);
              // Footprint and height always describe the whole parcel; storeys and GFZ follow the chosen reference, which may be corrected.
              const observed = discovery ? parcelReference(parcel, discovery) : null, ref = chosen ?? observed;
              if (own || !ref || !onReferences) return null;
              const height = observed?.metrics?.ridgeHeight?.value ?? ref.metrics?.ridgeHeight?.value ?? null, estimate = storeysFromHeight(height), reported = ref.metrics?.storeys?.value ?? null;
              const built = observed?.metrics?.footprint?.value ?? ref.metrics?.footprint?.value ?? null;
              return <div className="site-map-reference text-ui-xs">
                <dl className="site-map-facts">
                  <dt>{label("BuiltFootprint")}</dt><dd className="tabular-nums">{built === null ? "–" : `${built.toLocaleString(locale, { maximumFractionDigits: 0 })} m²`}</dd>
                  {chosen && <><dt>GFZ</dt><dd className="tabular-nums">{ref.metrics?.gfz?.value != null ? num(ref.metrics.gfz.value) : "–"}</dd>
                  <dt>{label("Storeys")}</dt><dd className="tabular-nums">{reported ?? "–"}</dd></>}
                  {height != null && <><dt>{label("MeasuredHeight")}</dt><dd className="tabular-nums">{label("HeightStoreys").replace("{height}", num(height)).replace("{n}", String(estimate))}</dd></>}
                </dl>
                {estimate != null && reported != null && estimate !== reported && <div className="site-map-reference-check" role="status">
                  <span>{label("StoreysMismatch").replace("{reported}", String(reported)).replace("{n}", String(estimate))}</span>
                  <Button size="sm" variant="outline" disabled={disabled || !discovery} onClick={() => toggleReference(parcel, estimate)}>{label("UseHeightStoreys").replace("{n}", String(estimate))}</Button>
                </div>}
                <Button size="sm" variant={chosen ? "outline" : "default"} disabled={disabled || !discovery} aria-pressed={!!chosen} onClick={() => toggleReference(parcel)}>
                  {label(chosen ? "RemoveReference" : "AddReference")}
                </Button>
              </div>;
            })()}
            {(() => {
              // Heritage and preservation areas are always checked, also when none applies: absence is shown as a result, not left blank.
              const p = protectionAt(context, parcel);
              const item = (h: BerlinHint) => <span key={`${h.kind}:${h.id}`}>{h.detailUrl ? <a className="underline" href={h.detailUrl} target="_blank" rel="noreferrer">{h.type && h.type !== h.label ? `${h.type} ${h.label}` : h.label}</a> : h.label}{h.effectiveDate ? <span className="muted"> · {label("InForceSince")} {h.effectiveDate}</span> : null}</span>;
              const rows: [string, BerlinHint[]][] = [["HeritageOn", p.heritageOn], ["HeritageNear", p.heritageNear], ["SocialPreservation", p.social], ["UrbanPreservation", p.urban]];
              return <dl className="site-map-facts text-ui-xs" aria-label={label("Protection")}>
                {rows.map(([key, items]) => <div key={key} className="contents">
                  <dt>{label(key)}</dt>
                  <dd className="site-map-protections">{items.length ? items.map(item) : <span className="muted">{label(p.known ? "ProtectionNone" : "ProtectionUnknown")}</span>}</dd>
                </div>)}
              </dl>;
            })()}
            {facts.law && <div className="site-map-basis text-ui-xs" data-law={facts.law.kind}>
              <p className="muted text-ui-2xs">{label("PlanningLaw")}</p>
              <p className="text-ui-sm font-semibold">{label(`Law_${facts.law.kind}`)}</p>
              {facts.law.plans.map(plan => <div key={plan.id}>
                <p className="font-medium">{plan.name}{plan.status === "adopted" ? (plan.effectiveDate ? ` · ${label("Adopted")} ${plan.effectiveDate}` : "") : ` · ${label("InProgress")}`}</p>
                <p className="site-map-links">
                  {plan.documentUrl && <a href={plan.documentUrl} target="_blank" rel="noreferrer">{label("PlanPdf")}</a>}
                  {plan.explanationUrl && <a href={plan.explanationUrl} target="_blank" rel="noreferrer">{label("Explanation")}</a>}
                  {!plan.documentUrl && !plan.explanationUrl && <span className="muted">{label("PlanNoDocuments")}</span>}
                </p>
                {plan.documentUrl && alignment && <Button size="sm" variant="outline" disabled={disabled || importPlan.isPending} onClick={() => importPlan.mutate(plan.documentUrl!)}>
                  {label(importPlan.isPending ? "PlanImporting" : "PlanOverlay")}
                </Button>}
              </div>)}
              {facts.law.landUse && <p><span className="muted">{label("LandUse")}: </span>{facts.law.landUse.label}</p>}
              <p className="muted">{label(`LawHint_${facts.law.kind}`)}</p>
            </div>}
            <details className="site-map-frame text-ui-xs" open={facts.law?.kind !== "b_plan"}>
              <summary className="font-medium">{label("Section34Values")}</summary>
              {facts.frame.count ? <dl className="site-map-facts">
                <dt>GRZ 1</dt><dd className="tabular-nums">{range(facts.frame.grz)}</dd>
                <dt>GRZ 2</dt><dd className="tabular-nums">{range(facts.frame.grz2)}</dd>
                <dt>GFZ</dt><dd className="tabular-nums">{range(facts.frame.gfz)}</dd>
                <dt>{label("Storeys")}</dt><dd className="tabular-nums">{range(facts.frame.storeys)}</dd>
                <dt>{label("Section34Basis")}</dt><dd>{label("Section34Count").replace("{count}", String(facts.frame.count))}</dd>
              </dl> : <p className="muted">{label(discovery ? "NoRatios" : discoveryQuery.isFetching ? "RatiosLoading" : "RatiosAfterDiscovery")}</p>}
            </details>
            <div className="site-map-panel-actions">
              {adopted?.id === parcel.id ? <Badge variant="outline">{label("AdoptedShort")}</Badge>
                : <Button size="sm" disabled={disabled || parcel.area === null} onClick={() => adopt(parcel)}>{label("UseArea")}</Button>}
              {onDesign && (adopted?.id === parcel.id
                ? <Button size="sm" variant="outline" onClick={onDesign}>{label("OpenDesign")}</Button>
                : <Button size="sm" variant="outline" disabled={disabled || parcel.area === null} onClick={() => { adopt(parcel); onDesign(); }}>{label("DesignHere")}</Button>)}
              <a className="text-ui-xs underline" href={parcel.sourceUrl} target="_blank" rel="noreferrer">{label("Source")} ↗</a>
            </div>
          </>} />
        <p className="muted text-ui-2xs">{label(picking ? "PickOnMap" : "PreviewHint")}</p>
        {alignment && <SitePlanAlignment projectId={projectId} overlay={alignment.overlay} disabled={disabled} pickedSite={pickedSite} onRequestSite={() => setPicking(true)}
          onChange={alignment.onChange} parcel={alignment.parcel} envelopeReviewed={alignment.envelopeReviewed} onTrace={alignment.onTrace} focusSource={focusSource} />}
        {importPlan.error && <Callout tone="error">{importPlan.error.message}</Callout>}
        <div className="berlin-parcel-table">
          <Table aria-label={label("Candidates")}>
            <TableHeader><TableRow><TableHead>{label("Parcel")}</TableHead><TableHead className="text-right">{label("Area")}</TableHead><TableHead>{label("Relation")}</TableHead><TableHead><span className="sr-only">{label("Actions")}</span></TableHead></TableRow></TableHeader>
            <TableBody>{visible.map(parcel => <TableRow key={parcel.id} data-state={selected === parcel.id ? "selected" : undefined} className="cursor-pointer" onClick={() => setSelected(parcel.id)}>
              <TableCell><button type="button" className="berlin-parcel-name" aria-pressed={selected === parcel.id} onClick={() => setSelected(parcel.id)}>{parcel.label}</button></TableCell>
              <TableCell className="text-right tabular-nums">{area(parcel.area)}</TableCell>
              <TableCell>{parcel.containsAddress ? <Badge variant="outline">{label("Contains")}</Badge> : <span className="muted">{label("Nearby")}</span>}</TableCell>
              <TableCell className="berlin-parcel-actions">
                <a href={parcel.sourceUrl} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>{label("Source")}</a>
                {adopted?.id === parcel.id ? <Badge variant="outline">{label("AdoptedShort")}</Badge>
                  : <Button variant="outline" size="sm" disabled={disabled || parcel.area === null} onClick={event => { event.stopPropagation(); adopt(parcel); }}>{label("UseArea")}</Button>}
              </TableCell>
            </TableRow>)}</TableBody>
          </Table>
          {parcels.length > VISIBLE_PARCELS && <Button variant="ghost" size="sm" onClick={() => setShowAll(v => !v)}>{showAll ? label("ShowFewer") : label("ShowAll").replace("{count}", String(parcels.length))}</Button>}
        </div>
      </div> : context.parcelStatus === "available" && <p className="muted text-ui-xs">{label("NoParcels")}</p>}
      <h3 className="berlin-subtitle text-ui-sm font-medium">{label("Plans")}</h3>
      {context.planStatus !== "available" && <Callout>{label("PlansUnavailable")}</Callout>}
      {context.plans.length > 0 ? <Table>
        <TableHeader><TableRow><TableHead>{label("Plan")}</TableHead><TableHead>{t("status")}</TableHead><TableHead>{label("Relation")}</TableHead><TableHead>{label("Documents")}</TableHead></TableRow></TableHeader>
        <TableBody>{context.plans.map(plan => <TableRow key={plan.id}>
          <TableCell className="font-medium">{plan.name}</TableCell>
          <TableCell>{label(plan.status === "adopted" ? "Adopted" : "InProgress")}</TableCell>
          <TableCell>{plan.containsAddress ? <Badge variant="outline">{label("Contains")}</Badge> : <span className="muted">{label("Nearby")}</span>}</TableCell>
          <TableCell className="berlin-parcel-actions">
            {plan.documentUrl && <a href={plan.documentUrl} target="_blank" rel="noreferrer">{label("PlanPdf")}</a>}
            {plan.explanationUrl && <a href={plan.explanationUrl} target="_blank" rel="noreferrer">{label("Explanation")}</a>}
            <a href={plan.sourceUrl} target="_blank" rel="noreferrer">{label("Source")}</a>
          </TableCell>
        </TableRow>)}</TableBody>
      </Table> : context.planStatus === "available" && <p className="muted text-ui-xs">{label("NoPlans")}</p>}
      <p className="muted text-ui-2xs">{label("PlanHint")}</p>
      <h3 className="berlin-subtitle text-ui-sm font-medium">{label("HeritageTitle")}</h3>
      {context.hintStatus === "unavailable" && <Callout>{label("HeritageUnavailable")}</Callout>}
      {context.hints?.length ? <ul className="berlin-hints text-ui-xs">{context.hints.map(hint => <li key={`${hint.kind}:${hint.id}`}>
        <span>{hint.label}</span>{hint.containsAddress ? <Badge variant="outline">{label("Contains")}</Badge> : <span className="muted">{label("Nearby")}</span>}
        <a href={hint.detailUrl ?? hint.sourceUrl} target="_blank" rel="noreferrer">{label("Source")}</a>
      </li>)}</ul> : context.hintStatus !== "unavailable" && <p className="muted text-ui-xs">{label("NoHeritage")}</p>}
      <p className="muted text-ui-2xs">{label("HeritageHint")}</p>
    </>}
    <p className="berlin-links text-ui-xs">
      <Link to={`/projects/${projectId}?view=location`}>{label("Location")} ↗</Link>
      <a href="https://www.berlin.de/sen/stadtentwicklung/planung/bebauungsplanverfahren/bebauungsplanverfahren-in-berlin/bebauungsplaene-online/" target="_blank" rel="noreferrer">{label("OfficialMap")} ↗</a>
    </p>
  </Section>;
}
