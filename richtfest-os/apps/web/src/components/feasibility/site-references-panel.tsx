import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { compareSiteReferences, SITE_REFERENCE_METRICS, type SiteReference, type SiteReferenceMetric, type SiteAssessmentInput, type LocationContext, type LocationBuilding } from "@richtfest/shared";
import { api } from "../../api";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Badge, Callout, Field } from "../ui/primitives";
import { Input, Textarea } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../ui/dialog";
import { NativeSelect } from "../ui/native-select";
import { Table, TableBody, TableRow, TableCell } from "../ui/table";
type Locator = NonNullable<SiteAssessmentInput["siteLocator"]>;
type Discovery = {address:string;origin:[number,number];longitude:number;latitude:number;retrievedAt:string;references:SiteReference[];buildings:LocationBuilding[];sources:string[];status:string[]};
export function SiteReferencesPanel({projectId,siteLocator,references,onLocator,onReferences,onContext,disabled=false}: {
 projectId:string;siteLocator?:Locator;references:SiteReference[];onLocator:(locator:Locator)=>void;onReferences:(refs:SiteReference[])=>void;onContext:(context:LocationContext|null)=>void;disabled?:boolean;
}) {
 const t=useT(),language=usePreferences(s=>s.language),label=(key:string)=>t(`siteReference${key}` as Parameters<typeof t>[0]);
 const [selected,setSelected]=useState<string>(),[field,setField]=useState<SiteReferenceMetric>("footprint");
 const [page,setPage]=useState(0);
 const opener=useRef<HTMLButtonElement|null>(null);
 const locations=useMutation({mutationFn:()=>api<{requestedAddress:string;candidates:{id:string;label:string;origin:[number,number];sourceUrl:string;exactMatch:boolean}[]}>(`/feasibility/projects/${projectId}/site-locations`)});
 const locationKey=JSON.stringify([projectId,siteLocator?.origin,siteLocator?.label]);
 const currentLocation=useRef(locationKey);currentLocation.current=locationKey;
 const previousLocation=useRef(locationKey);
 const discovery=useMutation({mutationFn:async()=>{const requestKey=locationKey;const data=await api<Discovery>(`/feasibility/projects/${projectId}/references/discover`,siteLocator?{mapOrigin:siteLocator.origin,mapLabel:siteLocator.label}:{},"POST");return {...data,requestKey};},onSuccess:data=>{
  if(data.requestKey!==currentLocation.current)return;
  setPage(0);onContext({siteId:`assessment:${projectId}`,address:data.address,origin:data.origin,longitude:data.longitude,latitude:data.latitude,crs:"EPSG:25833",radius:200,buildings:data.buildings,trees:[],sources:data.sources.map(url=>({label:label("PublicSource"),url,surveyedAt:null})),importedAt:data.retrievedAt});
 }});
 useEffect(()=>{if(previousLocation.current!==locationKey){previousLocation.current=locationKey;discovery.reset();locations.reset();setPage(0);onContext(null);}},[locationKey]);
 const discovered=discovery.data?.requestKey===locationKey?discovery.data:undefined;
 const ref=references.find(r=>r.id===selected),measurement=ref?.metrics?.[field];
 const update=(patch:Partial<SiteReference>)=>{if(ref)onReferences(references.map(r=>r.id===ref.id?{...ref,...patch}:r));};
 const updateMetric=(patch:Partial<NonNullable<NonNullable<SiteReference["metrics"]>[SiteReferenceMetric]>>)=>update({metrics:{...ref?.metrics,[field]:{value:null,source:"",sourceDate:null,kind:"assessment",reviewed:false,...measurement,...patch}}});
 const format=(n:number|null|undefined)=>n==null?"–":n.toLocaleString(language==="de"?"de-DE":"en-GB",{maximumFractionDigits:2});
 const comparison=compareSiteReferences(references);
 return <Section title={label("Title")}>
  <div className="inline-actions"><Button variant="outline" disabled={locations.isPending} onClick={()=>locations.mutate()}>{label("FindAddress")}</Button><Button variant="outline" disabled={discovery.isPending} onClick={()=>discovery.mutate()}>{discovery.isPending?label("Loading"):label("Discover")}</Button>{siteLocator&&<span className="text-ui-xs">{siteLocator.label} · {label(siteLocator.reviewed?"Reviewed":"Unreviewed")}</span>}</div>
  {(locations.error||discovery.error)&&<Callout tone="error">{(locations.error||discovery.error)?.message}</Callout>}
  {locations.data&&<div><p className="text-ui-xs muted">{label("AddressHint")}</p>{locations.data.candidates.length===0&&<Callout>{label("NoAddress")}</Callout>}{locations.data.candidates.map(c=><Button key={c.id} variant="outline" disabled={disabled} onClick={()=>{onLocator({origin:c.origin,label:c.label,source:c.sourceUrl,reviewed:false});locations.reset();}}>{c.label} · {label(c.exactMatch?"Exact":"Alternative")}</Button>)}</div>}
  {discovered?.status.some(s=>s!=="available")&&<Callout>{label("Partial")}</Callout>}
  {discovered&&<><p className="text-ui-xs muted">{label("CandidateHint")}</p><Table><TableBody>{discovered.references.slice(page*10,(page+1)*10).map(candidate=><TableRow key={candidate.id}><TableCell>{candidate.label}<div className="text-ui-2xs muted">{candidate.parcelId??label("ParcelUnknown")}</div></TableCell><TableCell>{format(candidate.metrics?.footprint?.value)} m²</TableCell><TableCell>{format(candidate.metrics?.storeys?.value)} {label("storeys")}</TableCell><TableCell>{format(candidate.metrics?.grz?.value)} / {format(candidate.metrics?.gfz?.value)}</TableCell><TableCell><Button size="sm" variant="outline" disabled={disabled||references.length>=100||references.some(r=>r.id===candidate.id)} onClick={event=>{opener.current=event.currentTarget;onReferences([...references,candidate]);setSelected(candidate.id);}}>{label("Add")}</Button></TableCell></TableRow>)}</TableBody></Table><div className="inline-actions"><Button variant="ghost" disabled={page===0} onClick={()=>setPage(p=>p-1)}>{label("Previous")}</Button><span className="text-ui-xs">{page+1} / {Math.max(1,Math.ceil(discovered.references.length/10))}</span><Button variant="ghost" disabled={(page+1)*10>=discovered.references.length} onClick={()=>setPage(p=>p+1)}>{label("Next")}</Button></div></>}
  {references.length>0&&<><Table><TableBody>{references.map(r=><TableRow key={r.id}><TableCell>{r.label}</TableCell><TableCell>{format(r.metrics?.footprint?.value)} m²</TableCell><TableCell><Button variant="ghost" size="sm" onClick={event=>{opener.current=event.currentTarget;setSelected(r.id);}}>{label("Review")}</Button><Button variant="ghost" size="sm" disabled={disabled} onClick={()=>onReferences(references.filter(v=>v.id!==r.id))}>{label("Remove")}</Button></TableCell></TableRow>)}</TableBody></Table><details><summary className="text-ui-sm">{label("Comparison")}</summary><p className="text-ui-xs muted">{label("ComparisonHint")}</p><Table><TableBody>{SITE_REFERENCE_METRICS.map(key=>{const m=comparison[key];return m&&<TableRow key={key}><TableCell>{label(key)}</TableCell><TableCell>{format(m.mean)} → {format(m.max)}</TableCell><TableCell>{m.count} · {label(m.reviewed?"Reviewed":"Unreviewed")}</TableCell></TableRow>;})}</TableBody></Table></details></>}
  <Dialog open={!!ref} onOpenChange={open=>{if(!open)setSelected(undefined);}}><DialogContent className="site-editor-panel" onCloseAutoFocus={event=>{event.preventDefault();opener.current?.focus();}}><DialogTitle>{ref?.label??label("Review")}</DialogTitle><DialogDescription>{label("ReviewHint")}</DialogDescription>{ref&&<>
   <Field label={label("Reason")}><Textarea disabled={disabled} value={ref.note} onChange={e=>update({note:e.target.value})}/></Field>
   <Field label={label("Measurement")}><NativeSelect value={field} onChange={e=>setField(e.target.value as SiteReferenceMetric)}>{SITE_REFERENCE_METRICS.map(key=><option key={key} value={key}>{label(key)}</option>)}</NativeSelect></Field>
   <Field label={label(field)}><Input disabled={disabled} type="number" min="0" step="any" value={measurement?.value??""} onChange={e=>updateMetric({value:e.target.value===""?null:Number(e.target.value),kind:"assessment",reviewed:false})}/></Field>
   <Field label={label("Source")}><Input disabled={disabled} value={measurement?.source??""} onChange={e=>updateMetric({source:e.target.value,kind:"assessment",reviewed:false})}/></Field>
   <Field label={label("Date")}><Input disabled={disabled} type="date" value={measurement?.sourceDate??""} onChange={e=>updateMetric({sourceDate:e.target.value||null,kind:"assessment",reviewed:false})}/></Field>
   <span className="text-ui-xs"><Badge variant="outline">{t(`siteAssessment${measurement?.kind??"assessment"}` as Parameters<typeof t>[0])}</Badge></span>
   <label className="site-review text-ui-xs"><Checkbox disabled={disabled||measurement?.value==null||!measurement?.source||!measurement?.sourceDate} checked={measurement?.reviewed??false} onCheckedChange={v=>updateMetric({reviewed:v===true})}/>{label("Reviewed")}</label>
   <Field label={label("BuildingForm")}><Input disabled={disabled} value={ref.buildingForm?.value??""} onChange={e=>update({buildingForm:{value:e.target.value,source:ref.buildingForm?.source??ref.source,sourceDate:ref.buildingForm?.sourceDate??null,reviewed:false}})}/></Field>
   {ref.buildingForm&&<fieldset className="grid gap-stack"><Field label={label("Source")}><Input disabled={disabled} value={ref.buildingForm.source} onChange={e=>update({buildingForm:{...ref.buildingForm!,source:e.target.value,reviewed:false}})}/></Field><Field label={label("Date")}><Input disabled={disabled} type="date" value={ref.buildingForm.sourceDate??""} onChange={e=>update({buildingForm:{...ref.buildingForm!,sourceDate:e.target.value||null,reviewed:false}})}/></Field><label className="site-review text-ui-xs"><Checkbox disabled={disabled||!ref.buildingForm.value.trim()||!ref.buildingForm.source.trim()||!ref.buildingForm.sourceDate} checked={ref.buildingForm.reviewed} onCheckedChange={v=>update({buildingForm:{...ref.buildingForm!,reviewed:v===true}})}/>{label("Reviewed")}</label></fieldset>}
   <Button variant="outline" onClick={()=>setSelected(undefined)}>{label("Close")}</Button>
  </>}</DialogContent></Dialog>
 </Section>;
}
