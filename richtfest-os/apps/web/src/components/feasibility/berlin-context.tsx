import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Badge, Callout } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import type { SiteAssessmentConstraint, SiteAssessmentInput } from "@richtfest/shared";

import { useBerlinContext, useSiteDiscovery, type BerlinParcel as Parcel } from "./site-lookups";
import { SiteParcelMap } from "./site-parcel-map";
const VISIBLE_PARCELS = 5;

export function BerlinContext({ projectId, disabled, onAdopt, onParcel, siteLocator, adopted }: {
  projectId: string;
  disabled: boolean;
  siteLocator?: SiteAssessmentInput["siteLocator"];
  onParcel?: (parcel: Parcel) => void;
  onAdopt: (value: SiteAssessmentConstraint, parcel: Parcel) => void;
  /** The parcel already in the assessment draft. */
  adopted?: { id: string; label: string; area: number | null; reviewed: boolean } | null;
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
  const discovery = useSiteDiscovery(projectId, siteLocator).data;
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
      {parcels.length > 0 ? <div className="berlin-parcels">
        <SiteParcelMap projectId={projectId} context={context} discovery={discovery} selected={selected} adoptedId={adopted?.id} onSelect={setSelected}
          renderPanel={(parcel, facts) => <>
            <dl className="site-map-facts text-ui-xs">
              <dt>{label("Area")}</dt><dd className="tabular-nums">{area(parcel.area)}</dd>
              <dt>{label("Relation")}</dt><dd>{parcel.containsAddress ? <Badge variant="outline">{label("Contains")}</Badge> : label("Nearby")}</dd>
              <dt>{label("LastChange")}</dt><dd>{parcel.sourceDate ? new Date(parcel.sourceDate).toLocaleDateString(locale) : "–"}</dd>
              <dt>GRZ 1</dt><dd className="tabular-nums">{facts.grz != null ? num(facts.grz) : <span className="muted">{label(discovery ? "NoRatios" : "RatiosAfterDiscovery")}</span>}</dd>
              {facts.grz != null && <><dt>GRZ 2</dt><dd className="tabular-nums">{facts.grz2 != null ? `≥ ${num(facts.grz2)}` : "–"}</dd>
              <dt>GFZ</dt><dd className="tabular-nums">{facts.gfz != null ? num(facts.gfz) : "–"}</dd></>}
            </dl>
            {facts.grz != null && <p className="muted text-ui-2xs">{label("RatiosHint")}</p>}
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
                <dt>{label("Section34Basis")}</dt><dd>{label("Section34Count").replace("{count}", String(facts.frame.count))}</dd>
              </dl> : <p className="muted">{label(discovery ? "NoRatios" : "RatiosAfterDiscovery")}</p>}
            </details>
            <div className="site-map-panel-actions">
              {adopted?.id === parcel.id ? <Badge variant="outline">{label("AdoptedShort")}</Badge>
                : <Button size="sm" disabled={disabled || parcel.area === null} onClick={() => adopt(parcel)}>{label("UseArea")}</Button>}
              <a className="text-ui-xs underline" href={parcel.sourceUrl} target="_blank" rel="noreferrer">{label("Source")} ↗</a>
            </div>
          </>} />
        <p className="muted text-ui-2xs">{label("PreviewHint")}</p>
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
