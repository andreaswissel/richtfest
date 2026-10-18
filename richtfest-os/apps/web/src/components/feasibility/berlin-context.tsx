import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Callout } from "../ui/primitives";
import type { SiteAssessmentConstraint } from "@richtfest/shared";

type Point = [number, number];
type Parcel = { id: string; label: string; area: number | null; sourceDate: string | null; sourceUrl: string; polygons: Point[][][]; containsAddress: boolean };
type Context = { address: string; origin: Point; retrievedAt: string; parcelStatus: string; planStatus: string; parcels: Parcel[]; plans: { id: string; name: string; status: string; sourceUrl: string; documentUrl: string | null; explanationUrl: string | null; effectiveDate: string | null; containsAddress: boolean }[] };
export function BerlinContext({ projectId, disabled, onAdopt }: { projectId: string; disabled: boolean; onAdopt: (value: SiteAssessmentConstraint) => void }) {
  const t = useT(), language = usePreferences(s => s.language);
  const label = (key: string) => t(`berlinContext${key}` as Parameters<typeof t>[0]);
  const [selected, setSelected] = useState<string>();
  const lookup = useMutation({ mutationFn: () => api<Context>(`/feasibility/projects/${projectId}/berlin-context`, {}, "POST"), onSuccess: () => setSelected(undefined) });
  const context = lookup.data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const parcel of context?.parcels ?? []) for (const polygon of parcel.polygons) for (const ring of polygon) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, -y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, -y);
  }
  if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }
  const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY), pad = Math.max(width, height) * .05;
  return <Section title={label("Title")}>
    <div className="inline-actions"><Button variant="outline" size="sm" disabled={lookup.isPending} onClick={() => lookup.mutate()}>{lookup.isPending ? label("Loading") : label("Load")}</Button><Link to={`/projects/${projectId}?view=location`}>{label("Location")}</Link><a href="https://www.berlin.de/sen/stadtentwicklung/planung/bebauungsplanverfahren/bebauungsplanverfahren-in-berlin/bebauungsplaene-online/" target="_blank" rel="noreferrer">{label("OfficialMap")}</a></div>
    <p className="muted text-ui-xs">{label("Hint")}</p>
    {lookup.error && <Callout tone="error">{lookup.error.message}</Callout>}
    {context && <>
      <p className="text-ui-xs">{context.address} · {label("Retrieved")} {new Date(context.retrievedAt).toLocaleString(language === "de" ? "de-DE" : "en-GB")}</p>
      {context.parcelStatus !== "available" && <Callout>{label("ParcelsUnavailable")}</Callout>}
      {context.parcels.length > 0 ? <>
        <svg role="img" aria-label={label("Preview")} viewBox={`${minX-pad} ${minY-pad} ${width+pad*2} ${height+pad*2}`} style={{ width: "100%", height: "240px", background: "var(--muted)" }}>
          {context.parcels.map(parcel => <path key={parcel.id} d={parcel.polygons.map(polygon => polygon.map(ring => ring.map((point, index) => `${index ? "L" : "M"}${point[0]},${-point[1]}`).join(" ") + " Z").join(" ")).join(" ")} fillRule="evenodd" fill={selected === parcel.id ? "var(--foreground)" : "transparent"} fillOpacity={.12} stroke="var(--foreground)" strokeWidth={selected === parcel.id ? 2 : 1} vectorEffect="non-scaling-stroke"><title>{parcel.label}</title></path>)}
          <circle cx={context.origin[0]} cy={-context.origin[1]} r={Math.max(width,height)*.009} fill="var(--foreground)" />
        </svg>
        <p className="muted text-ui-xs">{label("PreviewHint")}</p>
        <ul className="grid gap-stack">{context.parcels.map(parcel => <li key={parcel.id} className="inline-actions text-ui-xs">
          <Button size="sm" variant="outline" aria-pressed={selected === parcel.id} onClick={() => setSelected(parcel.id)}>{parcel.label}</Button>
          <span>{parcel.area?.toLocaleString(language === "de" ? "de-DE" : "en-GB") ?? "–"} m² · {parcel.containsAddress ? label("Contains") : label("Nearby")}</span>
          <a href={parcel.sourceUrl} target="_blank" rel="noreferrer">{label("Source")}</a>
          <Button variant="outline" size="sm" disabled={disabled || parcel.area === null} onClick={() => { setSelected(parcel.id); onAdopt({ value: parcel.area, source: `${parcel.sourceUrl} · ${parcel.id} · retrieved ${context.retrievedAt}`, sourceDate: parcel.sourceDate, kind: "official", reviewed: false }); }}>{label("UseArea")}</Button>
        </li>)}</ul>
      </> : context.parcelStatus === "available" && <p className="muted text-ui-xs">{label("NoParcels")}</p>}
      <h3 className="text-ui-sm font-medium">{label("Plans")}</h3>
      {context.planStatus !== "available" && <Callout>{label("PlansUnavailable")}</Callout>}
      <ul className="grid gap-stack">{context.plans.map(plan => <li key={plan.id} className="inline-actions text-ui-xs"><strong>{plan.name}</strong><span>{label(plan.status === "adopted" ? "Adopted" : "InProgress")} · {plan.containsAddress ? label("Contains") : label("Nearby")}</span>{plan.documentUrl && <a href={plan.documentUrl} target="_blank" rel="noreferrer">{label("PlanPdf")}</a>}{plan.explanationUrl && <a href={plan.explanationUrl} target="_blank" rel="noreferrer">{label("Explanation")}</a>}<a href={plan.sourceUrl} target="_blank" rel="noreferrer">{label("Source")}</a></li>)}</ul>
      <Callout>{label("PlanHint")}</Callout>
    </>}
  </Section>;
}
