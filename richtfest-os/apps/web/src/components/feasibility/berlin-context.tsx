import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { api } from "../../api";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Badge, Callout } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import type { SiteAssessmentConstraint } from "@richtfest/shared";

type Point = [number, number];
type Parcel = { id: string; label: string; area: number | null; sourceDate: string | null; sourceUrl: string; polygons: Point[][][]; containsAddress: boolean };
type Context = { hints?: { id: string; kind: string; label: string; sourceUrl: string; detailUrl: string | null; containsAddress: boolean }[]; hintStatus?: string; address: string; origin: Point; retrievedAt: string; parcelStatus: string; planStatus: string; parcels: Parcel[]; plans: { id: string; name: string; status: string; sourceUrl: string; documentUrl: string | null; explanationUrl: string | null; effectiveDate: string | null; containsAddress: boolean }[] };
const VISIBLE_PARCELS = 5;

export function BerlinContext({ projectId, disabled, onAdopt, onParcel, siteLocator, adopted }: {
  projectId: string;
  disabled: boolean;
  siteLocator?: { origin: [number, number]; label: string };
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
  const lookup = useMutation({
    mutationFn: () => api<Context>(`/feasibility/projects/${projectId}/berlin-context`, siteLocator ? { mapOrigin: siteLocator.origin, mapLabel: siteLocator.label } : {}, "POST"),
    onSuccess: (data) => { setSelected(data.parcels.find(p => p.containsAddress)?.id); setShowAll(false); setJustAdopted(undefined); },
  });
  const context = lookup.data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const parcel of context?.parcels ?? []) for (const polygon of parcel.polygons) for (const ring of polygon) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, -y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, -y);
  }
  if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }
  const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY), pad = Math.max(width, height) * .05;
  const parcels = [...(context?.parcels ?? [])].sort((a, b) => Number(b.containsAddress) - Number(a.containsAddress));
  const visible = showAll ? parcels : parcels.slice(0, VISIBLE_PARCELS);
  // Keep a parcel chosen on the preview visible in the table.
  if (!showAll && selected && !visible.some(p => p.id === selected)) visible.push(parcels.find(p => p.id === selected)!);
  const area = (n: number | null) => n === null ? "–" : `${n.toLocaleString(locale)} m²`;
  const adopt = (parcel: Parcel) => {
    setSelected(parcel.id);
    setJustAdopted(parcel.id);
    onParcel?.(parcel);
    onAdopt({ value: parcel.area, source: `${parcel.sourceUrl} · ${parcel.id} · retrieved ${context!.retrievedAt}`, sourceDate: parcel.sourceDate, kind: "official", reviewed: false }, parcel);
  };
  return <Section title={label("Title")} meta={<Button size="sm" variant={adopted ? "outline" : "default"} disabled={lookup.isPending} onClick={() => lookup.mutate()}>
    <Search className="size-icon-sm" aria-hidden="true" />{lookup.isPending ? label("Loading") : label(adopted || context ? "LoadAgain" : "Load")}
  </Button>}>
    {adopted && <div className="site-adopted text-ui-xs" role="status">
      <span className="muted">{label("AdoptedParcel")}</span>
      <strong>{adopted.label}</strong>
      <span>{area(adopted.area)}</span>
      <Badge variant="outline">{t(adopted.reviewed ? "siteAssessmentReviewedShort" : "siteAssessmentUnreviewed")}</Badge>
    </div>}
    <p className="muted text-ui-xs">{label(adopted ? "HintAdopted" : "Hint")}</p>
    {lookup.error && <Callout tone="error">
      <p>{lookup.error.message}</p>
      <Link className="underline" to={`/projects/${projectId}?view=details`}>{t("projectDetails")} ↗</Link>
    </Callout>}
    {justAdopted && <Callout tone="success">{label("AdoptedNotice").replace("{parcel}", parcels.find(p => p.id === justAdopted)?.label ?? "")}</Callout>}
    {context && <>
      <p className="text-ui-xs">{context.address} · {label("Retrieved")} {new Date(context.retrievedAt).toLocaleString(locale)}</p>
      {context.parcelStatus !== "available" && <Callout>{label("ParcelsUnavailable")}</Callout>}
      {parcels.length > 0 ? <div className="berlin-parcels">
        <figure className="berlin-parcel-preview">
          <svg role="img" aria-label={label("Preview")} viewBox={`${minX - pad} ${minY - pad} ${width + pad * 2} ${height + pad * 2}`}>
            {parcels.map(parcel => <path key={parcel.id} data-selected={selected === parcel.id} data-adopted={adopted?.id === parcel.id}
              d={parcel.polygons.map(polygon => polygon.map(ring => ring.map((point, index) => `${index ? "L" : "M"}${point[0]},${-point[1]}`).join(" ") + " Z").join(" ")).join(" ")}
              onClick={() => setSelected(parcel.id)}><title>{parcel.label} · {area(parcel.area)}</title></path>)}
            <circle cx={context.origin[0]} cy={-context.origin[1]} r={Math.max(width, height) * .009} />
          </svg>
          <figcaption className="muted text-ui-2xs">{label("PreviewHint")}</figcaption>
        </figure>
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
