import {siteAssessmentInputSchema,calculateSiteAssessment,type SiteAssessmentInput} from "./site-assessment";
import {calculateSiteGeometry,geometryArea,unionGeometry,type SiteGeometryResult,type GeometryPoint,type GeometryMultiPolygon} from "./site-geometry";
export type SiteDesignCheck={id:string;actual:number|null;limit:number|null;status:"pass"|"exceeded"|"unresolved";buildingId?:string};
export type SiteDesignResult={method:"berlin_design_v1";status:"incomplete"|"indicative"|"reviewed";geometry:SiteGeometryResult|null;checks:SiteDesignCheck[];issues:string[]};
const evidence=(value:{reviewed:boolean;source:string;sourceDate:string|null}|undefined)=>!!value?.reviewed&&!!value.source.trim()&&!!value.sourceDate;
const tolerance=(area:number)=>Math.max(1,area*.005);
/** Combined geometric design check; reviewed means reviewed inputs and passed checks, not planning approval. */
export function calculateSiteDesign(raw:SiteAssessmentInput):SiteDesignResult {
 const result:SiteDesignResult={method:"berlin_design_v1",status:"incomplete",geometry:null,checks:[],issues:[]};
 const parsed=siteAssessmentInputSchema.safeParse(raw);if(!parsed.success){result.issues=parsed.error.issues.map(i=>`invalid_input:${i.path.join(".")}`);return result;}
 const input=parsed.data;if(!input.geometry){result.issues.push("missing_geometry");return result;}
 const geometry=calculateSiteGeometry(input.geometry);result.geometry=geometry;result.issues.push(...geometry.issues.map(i=>`geometry:${i.code}${i.id?`:${i.id}`:""}`));
 if(geometry.status==="incomplete"||!input.geometry.buildings.length){if(!input.geometry.buildings.length)result.issues.push("missing_buildings");return result;}
 const arithmetic=calculateSiteAssessment(input);if(arithmetic.status!=="reviewed")result.issues.push(...arithmetic.missing.map(id=>`unreviewed_assessment:${id}`));
 const add=(id:string,actual:number|null,limit:number|null,ready:boolean,buildingId?:string)=>{const check:SiteDesignCheck={id,actual,limit,status:!ready||actual===null||limit===null?"unresolved":actual<=limit+1e-6?"pass":"exceeded",...(buildingId?{buildingId}:{})};result.checks.push(check);return check;};
 const c=input.constraints,parcel=c.parcelArea.value,scalarReady=(key:keyof typeof c)=>evidence(c[key])&&c[key].value!==null;
 const footprint=geometryArea(unionGeometry(...input.geometry.buildings.map(b=>b.footprint.geometry))),gf=geometry.buildings.reduce((n,b)=>n+b.countableFloorArea,0);
 add("grz",parcel&&parcel>0?footprint/parcel:null,c.grz.value,scalarReady("parcelArea")&&scalarReady("grz"));
 add("gfz",parcel&&parcel>0?gf/parcel:null,c.gfz.value,scalarReady("parcelArea")&&scalarReady("gfz"));
 add("envelope",footprint,c.buildableFootprint.value,scalarReady("buildableFootprint"));
 const parcelMatch=add("parcel_area_consistency",parcel===null?null:Math.abs(parcel-geometry.parcelArea),tolerance(geometry.parcelArea),scalarReady("parcelArea"));
 if(parcelMatch.status==="exceeded")result.issues.push("scalar_parcel_disagrees_with_geometry");
 const envelopeMatch=add("envelope_area_consistency",c.buildableFootprint.value===null?null:Math.abs(c.buildableFootprint.value-geometry.usableArea),tolerance(geometry.usableArea),scalarReady("buildableFootprint"));
 if(envelopeMatch.status==="exceeded")result.issues.push("scalar_envelope_disagrees_with_geometry");
 const rules=input.designRules,rulesReviewed=evidence(rules);
 if(!rulesReviewed)result.issues.push("design_rules_unreviewed");
 const formReviewed=rulesReviewed&&input.checks.bauweise.status==="confirmed"&&!!input.checks.bauweise.source.trim()&&!!input.checks.bauweise.note.trim();
 for(const building of input.geometry.buildings){const metrics=geometry.buildings.find(b=>b.id===building.id)!;
  add("placement",metrics.validPlacement?0:1,0,true,building.id);
  add("full_storeys",metrics.classifiedFullStoreys,c.maxFullStoreys.value,scalarReady("maxFullStoreys")&&building.storeysReviewed,building.id);
  const height=Math.max(building.height??0,building.fullStoreys*building.storeyHeight+building.staffel.reduce((sum,s)=>sum+s.height,0));
  const heightCheck=add("height",height,rules?.maxHeight??null,rulesReviewed&&!rules?.heightNotSpecified,building.id);
  if(rulesReviewed&&rules?.heightNotSpecified&&rules.maxHeight===null)heightCheck.status="pass";
  if(rules?.heightNotSpecified&&rules.maxHeight!==null){heightCheck.status="unresolved";result.issues.push("contradictory_height_rule");}
 }
 const form:SiteDesignCheck={id:"building_form",actual:null,limit:null,status:"unresolved"};result.checks.push(form);
 if(rules?.buildingForm==="open"){
  // BauNVO §22(2): geometric screening of connected house forms, each max.50m.
  // Minimum-area oriented bounds avoid treating a rotated rectangle's diagonal as its length.
  const groups=unionGeometry(...input.geometry.buildings.map(b=>b.footprint.geometry));
  groups.forEach((polygon,index)=>add("open_length",orientedLength(polygon[0]!),50,formReviewed,`group-${index+1}`));
  form.status=formReviewed?"pass":"unresolved";
 }else if(rules?.buildingForm==="closed"){
  const parcelGeometry=input.geometry.parcel?.geometry;
  // The reviewed qualitative source identifies the relevant lateral boundary condition.
  // A neighbour or unrelated building cannot satisfy it on behalf of a detached building.
  const boundaryReviewed=!!parcelGeometry&&input.geometry.buildings.every(building=>input.geometry!.setbacks.some(edge=>edge.profile==="boundary_exception"&&edge.distance===0&&evidence(edge)&&boundaryContact(parcelGeometry[edge.polygonIndex]?.[edge.ringIndex],edge.edgeIndex,[building.footprint.geometry])));
  if(formReviewed&&boundaryReviewed)form.status="pass";else result.issues.push("closed_boundary_condition_unverified");
 }else if(rules?.buildingForm==="deviating"){
  // Bespoke form constraints have no universal numeric substitute: the reviewed qualitative check is required.
  form.status=formReviewed?"pass":"unresolved";
 }else result.issues.push("building_form_unresolved");
 result.status=geometry.status==="reviewed"&&arithmetic.status==="reviewed"&&rulesReviewed&&result.checks.every(c=>c.status==="pass")&&!result.issues.length?"reviewed":"indicative";
 return result;
}
function orientedLength(points:GeometryPoint[]):number {
 const sorted=[...points.slice(0,-1)].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const cross=(a:GeometryPoint,b:GeometryPoint,c:GeometryPoint)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
 const half=(items:GeometryPoint[])=>{const h:GeometryPoint[]=[];for(const p of items){while(h.length>1&&cross(h[h.length-2]!,h[h.length-1]!,p)<=0)h.pop();h.push(p);}return h;};const hull=[...half(sorted).slice(0,-1),...half([...sorted].reverse()).slice(0,-1)];let best=Infinity,length=Infinity;
 for(let i=0;i<hull.length;i++){const a=hull[i]!,b=hull[(i+1)%hull.length]!,angle=Math.atan2(b[1]-a[1],b[0]-a[0]),cos=Math.cos(angle),sin=Math.sin(angle);const rotated=hull.map(p=>[(p[0]-a[0])*cos+(p[1]-a[1])*sin,-(p[0]-a[0])*sin+(p[1]-a[1])*cos]);const w=Math.max(...rotated.map(p=>p[0]!))-Math.min(...rotated.map(p=>p[0]!)),h=Math.max(...rotated.map(p=>p[1]!))-Math.min(...rotated.map(p=>p[1]!));if(w*h<best){best=w*h;length=Math.max(w,h);}}
 return length;
}
function boundaryContact(ring:GeometryPoint[]|undefined,index:number,buildings:GeometryMultiPolygon[]):boolean {
 if(!ring||!ring[index+1])return false;const a=ring[index]!,b=ring[index+1]!,dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);if(len<.001)return false;
 for(const g of buildings)for(const polygon of g){const r=polygon[0]!;for(let i=0;i<r.length-1;i++){const p=r[i]!,q=r[i+1]!,distance=(p:GeometryPoint)=>Math.abs(dx*(p[1]-a[1])-dy*(p[0]-a[0]))/len,t=(p:GeometryPoint)=>((p[0]-a[0])*dx+(p[1]-a[1])*dy)/len;if(distance(p)<=.05&&distance(q)<=.05&&Math.min(len,Math.max(t(p),t(q)))-Math.max(0,Math.min(t(p),t(q)))>.05)return true;}}
 return false;
}
