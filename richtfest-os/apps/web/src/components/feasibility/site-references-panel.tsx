import "./messages";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { compareSiteReferences, SITE_REFERENCE_METRICS, type SiteReference, type SiteReferenceMetric, type SiteAssessmentInput, type LocationContext } from "@richtfest/shared";
import { api } from "../../api";
import { discoveryContext, useSiteDiscovery } from "./site-lookups";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Badge, Callout, Field } from "../ui/primitives";
import { Input, Textarea } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { DateInput } from "../ui/date-input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../ui/dialog";
import { NativeSelect } from "../ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

type Locator = NonNullable<SiteAssessmentInput["siteLocator"]>;
const PAGE = 10;

/** Distance from the address point to the footprint's vertex centre, for orientation only. */
const distanceTo = (origin: [number, number], reference: SiteReference) => {
  const points = reference.polygons?.[0]?.[0];
  if (!points?.length) return null;
  const x = points.reduce((s, p) => s + p[0], 0) / points.length, y = points.reduce((s, p) => s + p[1], 0) / points.length;
  return Math.hypot(x - origin[0], y - origin[1]);
};

export function SiteReferencesPanel({ projectId, siteLocator, references, onLocator, onReferences, onContext, disabled = false }: {
  projectId: string; siteLocator?: Locator; references: SiteReference[]; onLocator: (locator: Locator) => void; onReferences: (refs: SiteReference[]) => void; onContext: (context: LocationContext | null) => void; disabled?: boolean;
}) {
  const t = useT(), language = usePreferences(s => s.language), label = (key: string) => t(`siteReference${key}` as Parameters<typeof t>[0]);
  const [selected, setSelected] = useState<string>(), [field, setField] = useState<SiteReferenceMetric>("footprint");
  const [page, setPage] = useState(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const locations = useMutation({ mutationFn: () => api<{ requestedAddress: string; candidates: { id: string; label: string; origin: [number, number]; sourceUrl: string; exactMatch: boolean }[] }>(`/feasibility/projects/${projectId}/site-locations`) });
  const locationKey = JSON.stringify([projectId, siteLocator?.origin, siteLocator?.label]);
  const previousLocation = useRef(locationKey);
  // Keyed by project and locator, so a changed location never shows another site's buildings.
  const discovery = useSiteDiscovery(projectId, siteLocator);
  const discovered = discovery.data;
  useEffect(() => { setPage(0); onContext(discovered ? discoveryContext(projectId, discovered, label("PublicSource")) : null); }, [discovery.dataUpdatedAt, locationKey]);
  useEffect(() => { if (previousLocation.current !== locationKey) { previousLocation.current = locationKey; locations.reset(); } }, [locationKey]);
  const candidates = discovered ? [...discovered.references].map(r => ({ reference: r, distance: distanceTo(discovered.origin, r) })).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity)) : [];
  const ref = references.find(r => r.id === selected), measurement = ref?.metrics?.[field];
  const update = (patch: Partial<SiteReference>) => { if (ref) onReferences(references.map(r => r.id === ref.id ? { ...ref, ...patch } : r)); };
  const updateMetric = (patch: Partial<NonNullable<NonNullable<SiteReference["metrics"]>[SiteReferenceMetric]>>) => update({ metrics: { ...ref?.metrics, [field]: { value: null, source: "", sourceDate: null, kind: "assessment", reviewed: false, ...measurement, ...patch } } });
  const format = (n: number | null | undefined, digits = 2) => n == null ? "–" : n.toLocaleString(language === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: digits });
  const comparison = compareSiteReferences(references);
  const pages = Math.max(1, Math.ceil(candidates.length / PAGE));
  return <Section title={label("Title")} meta={<div className="inline-actions">
    <Button variant="outline" size="sm" disabled={locations.isPending} onClick={() => locations.mutate()}>{label("FindAddress")}</Button>
    <Button variant="outline" size="sm" disabled={discovery.isFetching} onClick={() => void discovery.refetch()}>{discovery.isFetching ? label("Loading") : label("Discover")}</Button>
    {!disabled && <Button variant="ghost" size="sm" disabled={references.length >= 100} onClick={event => { const id = crypto.randomUUID(); opener.current = event.currentTarget; onReferences([...references, { id, label: "", source: "", note: "" }]); setSelected(id); }}>{label("AddManual")}</Button>}
  </div>}>
    {siteLocator && <p className="text-ui-xs">{label("Locator")}: {siteLocator.label} · {label(siteLocator.reviewed ? "Reviewed" : "Unreviewed")}</p>}
    {(locations.error || discovery.error) && <Callout tone="error">{(locations.error || discovery.error)?.message}</Callout>}
    {locations.data && <div className="site-address-candidates">
      <p className="text-ui-xs muted">{label("AddressHint")}</p>
      {locations.data.candidates.length === 0 && <Callout>{label("NoAddress")}</Callout>}
      <div className="inline-actions">{locations.data.candidates.map(c => <Button key={c.id} size="sm" variant="outline" disabled={disabled} onClick={() => { onLocator({ origin: c.origin, label: c.label, source: c.sourceUrl, reviewed: false }); locations.reset(); }}>{c.label} · {label(c.exactMatch ? "Exact" : "Alternative")}</Button>)}</div>
    </div>}
    {discovered?.status.some(s => s !== "available") && <Callout>{label("Partial")}</Callout>}
    {discovered && <>
      <p className="text-ui-xs muted">{label("CandidateHint")}</p>
      <Table className="site-reference-table">
        <TableHeader><TableRow>
          <TableHead>{label("Building")}</TableHead>
          <TableHead className="text-right">{label("Distance")}</TableHead>
          <TableHead className="text-right">{label("footprint")}</TableHead>
          <TableHead className="text-right">{label("storeys")}</TableHead>
          <TableHead className="text-right">{label("GrzGfz")}</TableHead>
          <TableHead><span className="sr-only">{label("Add")}</span></TableHead>
        </TableRow></TableHeader>
        <TableBody>{candidates.slice(page * PAGE, (page + 1) * PAGE).map(({ reference: candidate, distance }) => {
          const added = references.some(r => r.id === candidate.id);
          return <TableRow key={candidate.id}>
            <TableCell>{candidate.label}<div className="text-ui-2xs muted">{candidate.parcelId ?? label("ParcelUnknown")}</div></TableCell>
            <TableCell className="text-right tabular-nums">{distance === null ? "–" : `${format(distance, 0)} m`}</TableCell>
            <TableCell className="text-right tabular-nums">{format(candidate.metrics?.footprint?.value)} m²</TableCell>
            <TableCell className="text-right tabular-nums">{format(candidate.metrics?.storeys?.value)}</TableCell>
            <TableCell className="text-right tabular-nums">{format(candidate.metrics?.grz?.value)} / {format(candidate.metrics?.gfz?.value)}</TableCell>
            <TableCell className="text-right">{added ? <Badge variant="outline">{label("Added")}</Badge> : <Button size="sm" variant="outline" disabled={disabled || references.length >= 100} onClick={event => { opener.current = event.currentTarget; onReferences([...references, candidate]); setSelected(candidate.id); }}>{label("Add")}</Button>}</TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
      {pages > 1 && <div className="inline-actions"><Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(p => p - 1)}>{label("Previous")}</Button><span className="text-ui-xs">{page + 1} / {pages}</span><Button size="sm" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}>{label("Next")}</Button></div>}
    </>}
    {references.length > 0 && <>
      <h3 className="text-ui-sm font-medium">{label("Selected")} · {references.length}</h3>
      <Table>
        <TableHeader><TableRow><TableHead>{label("Building")}</TableHead><TableHead className="text-right">{label("footprint")}</TableHead><TableHead>{t("status")}</TableHead><TableHead><span className="sr-only">{label("Review")}</span></TableHead></TableRow></TableHeader>
        <TableBody>{references.map(r => {
          const complete = !!r.note.trim() && !!r.source.trim();
          return <TableRow key={r.id}>
            <TableCell>{r.label || label("Unnamed")}</TableCell>
            <TableCell className="text-right tabular-nums">{format(r.metrics?.footprint?.value)} m²</TableCell>
            <TableCell><Badge variant="outline">{label(complete ? "ReasonGiven" : "ReasonMissing")}</Badge></TableCell>
            <TableCell className="text-right"><Button variant="ghost" size="sm" onClick={event => { opener.current = event.currentTarget; setSelected(r.id); }}>{label("Review")}</Button><Button variant="ghost" size="sm" disabled={disabled} onClick={() => onReferences(references.filter(v => v.id !== r.id))}>{label("Remove")}</Button></TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
      <details className="site-secondary"><summary className="text-ui-sm">{label("Comparison")}</summary><p className="text-ui-xs muted">{label("ComparisonHint")}</p><Table><TableHeader><TableRow><TableHead>{label("Metric")}</TableHead><TableHead className="text-right">{label("MeanMax")}</TableHead><TableHead>{label("Observations")}</TableHead></TableRow></TableHeader><TableBody>{SITE_REFERENCE_METRICS.map(key => { const m = comparison[key]; return m && <TableRow key={key}><TableCell>{label(key)}</TableCell><TableCell className="text-right tabular-nums">{format(m.mean)} → {format(m.max)}</TableCell><TableCell>{m.count} · {label(m.reviewed ? "Reviewed" : "Unreviewed")}</TableCell></TableRow>; })}</TableBody></Table></details>
    </>}
    <Dialog open={!!ref} onOpenChange={open => { if (!open) setSelected(undefined); }}><DialogContent className="site-editor-panel" onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}><DialogTitle>{ref?.label || label("Review")}</DialogTitle><DialogDescription>{label("ReviewHint")}</DialogDescription>{ref && <>
      <Field label={label("Name")}><Input disabled={disabled} maxLength={300} value={ref.label} onChange={e => update({ label: e.target.value })} /></Field>
      <Field label={label("ReferenceSource")}><Input disabled={disabled} maxLength={2000} value={ref.source} onChange={e => update({ source: e.target.value })} /></Field>
      <Field label={label("Reason")}><Textarea disabled={disabled} value={ref.note} onChange={e => update({ note: e.target.value })} /></Field>
      <Field label={label("Measurement")}><NativeSelect value={field} onChange={e => setField(e.target.value as SiteReferenceMetric)}>{SITE_REFERENCE_METRICS.map(key => <option key={key} value={key}>{label(key)}</option>)}</NativeSelect></Field>
      <Field label={label(field)}><Input disabled={disabled} type="number" min="0" step="any" value={measurement?.value ?? ""} onChange={e => updateMetric({ value: e.target.value === "" ? null : Number(e.target.value), kind: "assessment", reviewed: false })} /></Field>
      <Field label={label("Source")}><Input disabled={disabled} value={measurement?.source ?? ""} onChange={e => updateMetric({ source: e.target.value, kind: "assessment", reviewed: false })} /></Field>
      <Field label={label("Date")}><DateInput disabled={disabled} value={measurement?.sourceDate ?? null} onValueChange={sourceDate => updateMetric({ sourceDate, kind: "assessment", reviewed: false })} /></Field>
      <span className="text-ui-xs"><Badge variant="outline">{t(`siteAssessment${measurement?.kind ?? "assessment"}` as Parameters<typeof t>[0])}</Badge></span>
      <label className="site-review text-ui-xs"><Checkbox disabled={disabled || measurement?.value == null || !measurement?.source || !measurement?.sourceDate} checked={measurement?.reviewed ?? false} onCheckedChange={v => updateMetric({ reviewed: v === true })} />{label("Reviewed")}</label>
      {!measurement?.reviewed && (measurement?.value == null || !measurement?.source || !measurement?.sourceDate) && <small className="muted text-ui-2xs">{t("siteAssessmentReviewNeeds").replace("{items}", [measurement?.value == null && label(field), !measurement?.source && label("Source"), !measurement?.sourceDate && label("Date")].filter(Boolean).join(", "))}</small>}
      <Field label={label("BuildingForm")}><Input disabled={disabled} value={ref.buildingForm?.value ?? ""} onChange={e => update({ buildingForm: { value: e.target.value, source: ref.buildingForm?.source ?? ref.source, sourceDate: ref.buildingForm?.sourceDate ?? null, reviewed: false } })} /></Field>
      {ref.buildingForm && <fieldset className="grid gap-stack"><Field label={label("Source")}><Input disabled={disabled} value={ref.buildingForm.source} onChange={e => update({ buildingForm: { ...ref.buildingForm!, source: e.target.value, reviewed: false } })} /></Field><Field label={label("Date")}><DateInput disabled={disabled} value={ref.buildingForm.sourceDate} onValueChange={sourceDate => update({ buildingForm: { ...ref.buildingForm!, sourceDate, reviewed: false } })} /></Field><label className="site-review text-ui-xs"><Checkbox disabled={disabled || !ref.buildingForm.value.trim() || !ref.buildingForm.source.trim() || !ref.buildingForm.sourceDate} checked={ref.buildingForm.reviewed} onCheckedChange={v => update({ buildingForm: { ...ref.buildingForm!, reviewed: v === true } })} />{label("Reviewed")}</label></fieldset>}
      <Button variant="outline" onClick={() => setSelected(undefined)}>{label("Close")}</Button>
    </>}</DialogContent></Dialog>
  </Section>;
}
