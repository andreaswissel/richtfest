import polygonClipping from "polygon-clipping";
import { siteGeometryInputSchema, type GeometryPoint as Point, type GeometryMultiPolygon as Multi, type GeometryEvidence, type EdgeSetback, type SiteGeometryInput, type SiteGeometryResult, type MassingOptions, type MassingCandidate, type BuildingGeometry, type PlanOverlay } from "./site-geometry-model";
export * from "./site-geometry-model";
const EPS = 1e-7;
const MAX_GEOMETRY_WORK = 5_000_000;
const vertexCount=(g:Multi)=>g.reduce((n,p)=>n+p.reduce((n,r)=>n+r.length,0),0);
const clip = polygonClipping;
const intersection = (a:Multi,b:Multi):Multi => a.length&&b.length ? clip.intersection(a,b) : [];
const difference = (a:Multi,b:Multi):Multi => a.length&&b.length ? clip.difference(a,b) : a;
const signedArea = (ring:Point[]) => { const o=ring[0]!;return ring.slice(0,-1).reduce((sum,a,i)=>{const b=ring[i+1]!;return sum+(a[0]-o[0])*(b[1]-o[1])-(b[0]-o[0])*(a[1]-o[1]);},0)/2; };
export const geometryArea = (geometry:Multi):number => geometry.reduce((sum,p)=>sum+Math.abs(signedArea(p[0]!))-p.slice(1).reduce((s,r)=>s+Math.abs(signedArea(r)),0),0);
const cross=(a:Point,b:Point,c:Point)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const equal=(a:Point,b:Point)=>Math.hypot(a[0]-b[0],a[1]-b[1])<EPS;
function intersects(a:Point,b:Point,c:Point,d:Point):boolean {
 const on=(p:Point,q:Point,r:Point)=>Math.abs(cross(p,q,r))<EPS&&r[0]>=Math.min(p[0],q[0])-EPS&&r[0]<=Math.max(p[0],q[0])+EPS&&r[1]>=Math.min(p[1],q[1])-EPS&&r[1]<=Math.max(p[1],q[1])+EPS;
 const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);
 return (x*y<0&&z*w<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);
}
function inside(point:Point,ring:Point[]):boolean {let yes=false;for(let i=0,j=ring.length-2;i<ring.length-1;j=i++){const a=ring[i]!,b=ring[j]!;if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
function ringsCross(a:Point[],b:Point[]):boolean {for(let i=0;i<a.length-1;i++)for(let j=0;j<b.length-1;j++)if(intersects(a[i]!,a[i+1]!,b[j]!,b[j+1]!))return true;return false;}
/** Invalid topology is rejected rather than silently repaired into different source geometry. */
export function validateGeometry(geometry:Multi):string[] {
 if(vertexCount(geometry)**2>MAX_GEOMETRY_WORK)return ["geometry_too_complex"];
 const errors:string[]=[];
 for(const polygon of geometry){
  for(const ring of polygon){
   if(ring.length<4||!equal(ring[0]!,ring.at(-1)!)){errors.push("ring_not_closed");continue;}
   if(Math.abs(signedArea(ring))<EPS)errors.push("zero_area_ring");
   for(let i=0;i<ring.length-1;i++){
    if(equal(ring[i]!,ring[i+1]!))errors.push("duplicate_vertex");
    for(let j=i+1;j<ring.length-1;j++)if(j!==i+1&&!(i===0&&j===ring.length-2)&&intersects(ring[i]!,ring[i+1]!,ring[j]!,ring[j+1]!))errors.push("self_intersection");
   }
  }
  const outer=polygon[0];if(!outer)continue;
  for(let h=1;h<polygon.length;h++){const hole=polygon[h]!;if(!inside(hole[0]!,outer)||ringsCross(outer,hole))errors.push("invalid_hole");for(let j=1;j<h;j++)if(ringsCross(hole,polygon[j]!)||inside(hole[0]!,polygon[j]!)||inside(polygon[j]![0]!,hole))errors.push("overlapping_holes");}
 }
 if(!errors.length)for(let i=0;i<geometry.length;i++)for(let j=0;j<i;j++)if(geometryArea(intersection([geometry[i]!],[geometry[j]!]))>EPS)errors.push("overlapping_polygons");
 return [...new Set(errors)];
}
const reviewed=(e:{source:string;sourceDate:string|null;reviewed:boolean})=>e.reviewed&&!!e.source.trim()&&!!e.sourceDate;
export function createDefaultSetbacks(parcel:GeometryEvidence,distance:number|null=null):EdgeSetback[]{return parcel.geometry.flatMap((p,polygonIndex)=>p.flatMap((r,ringIndex)=>r.slice(0,-1).map((_,edgeIndex)=>({id:`edge-${polygonIndex}-${ringIndex}-${edgeIndex}`,polygonIndex,ringIndex,edgeIndex,distance,source:"",sourceDate:null,reviewed:false,profile:"manual" as const,heightSource:"manual" as const,assessmentHeight:null,reviewedHeight:null}))));}
/** H is the reviewed §6 wall/roof assessment height, not automatically total model height. */
export function deriveBerlinSetback(profile:"standard"|"commercial"|"low_class"|"boundary_exception",height:number):number|null {if(!Number.isFinite(height)||height<0)return null;if(profile==="boundary_exception")return null;return profile==="low_class"?3:Math.max(3,height*(profile==="commercial"?.2:.4));}
/** Berlin Abstandsfläche (§6 BauO Bln): one rectangle of depth `depth` in front of every wall, corners excluded, never over the building itself. */
export function berlinSetbackArea(footprint:Multi,depth:number):Multi {
 if(!(depth>0)||!footprint.length)return [];
 const strips:Multi=[];
 for(const polygon of footprint)for(const ring of polygon)for(let i=0;i<ring.length-1;i++){
  const a=ring[i]!,b=ring[i+1]!,length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(length<EPS)continue;
  // The wall faces away from the polygon interior; probing a centimetre beside its midpoint picks the side for any winding or hole.
  let nx=(b[1]-a[1])/length,ny=-(b[0]-a[0])/length;const mid:Point=[(a[0]+b[0])/2+nx*.01,(a[1]+b[1])/2+ny*.01];
  if(inside(mid,polygon[0]!)&&!polygon.slice(1).some(h=>inside(mid,h))){nx=-nx;ny=-ny;}
  strips.push([[a,b,[b[0]+nx*depth,b[1]+ny*depth],[a[0]+nx*depth,a[1]+ny*depth],a]]);
 }
 return strips.length?difference(clip.union(strips[0]!,...strips.slice(1)),footprint):[];
}
export type SetbackAreaCheck={id:string;height:number;depth:number;upperDepth:number|null;area:Multi;clear:Multi;conflict:Multi;outsideParcel:number;overlap:number;ok:boolean};
/**
 * Live Abstandsflächen check for draft massing (standard profile, 0.4 H, min 3 m): areas must stay on the parcel and must not
 * overlap the areas or footprints of other buildings. Indicative only; the reviewed per-edge setbacks remain the calculation.
 */
export function checkSetbackAreas(input:{parcel:Multi|null;buildings:{id:string;footprint:Multi;height:number;upper?:{footprint:Multi;height:number}[]}[];neighbours?:{footprint:Multi;area:Multi}[]}):SetbackAreaCheck[]{
 // Clipping runs relative to a local origin: raw UTM magnitudes make near-coincident edges fail in the sweep line.
 const o=input.parcel?.[0]?.[0]?.[0]??input.buildings[0]?.footprint[0]?.[0]?.[0]??[0,0] as Point;
 const shift=(g:Multi,dx:number,dy:number):Multi=>g.map(p=>p.map(r=>r.map(([x,y])=>[x+dx,y+dy] as Point)));
 const local=(g:Multi)=>shift(g,-o[0],-o[1]),site=(g:Multi)=>shift(g,o[0],o[1]);
 /** Unions piece by piece and skips a piece the sweep cannot resolve rather than losing the whole result. */
 const merge=(pieces:Multi[]):Multi=>pieces.reduce<Multi>((acc,g)=>{if(!acc.length)return g;try{return clip.union(acc,g);}catch{return acc;}},[]);
 const parcel=input.parcel&&local(input.parcel);
 const neighbours=(input.neighbours??[]).map(n=>({footprint:local(n.footprint),area:local(n.area)}));
 // A recessed Staffelgeschoss has its own walls: its area is measured from those walls with its top height, and only the part beyond the main footprint lies on the ground.
 const areas=input.buildings.map(b=>{const footprint=local(b.footprint),depth=deriveBerlinSetback("standard",b.height)??3,upper=(b.upper??[]).map(u=>({footprint:local(u.footprint),depth:deriveBerlinSetback("standard",u.height)??3})),upperDepth=upper.length?Math.max(...upper.map(u=>u.depth)):null;try{const area=merge([berlinSetbackArea(footprint,depth),...upper.map(u=>{try{return difference(berlinSetbackArea(u.footprint,u.depth),footprint);}catch{return [] as Multi;}})].filter(g=>g.length));return {...b,footprint,depth,upperDepth,area};}catch{return {...b,footprint,depth,upperDepth,area:[] as Multi};}});
 return areas.map(b=>{
  try{
   const outside=parcel?difference(b.area,parcel):b.area;
   const others=[...areas.filter(x=>x.id!==b.id).flatMap(x=>[x.area,x.footprint]),...neighbours.flatMap(n=>[n.area,n.footprint])].filter(g=>g.length);
   const overlaps=others.flatMap(g=>{try{const x=intersection(b.area,g);return geometryArea(x)>.01?[x]:[];}catch{return [];}});
   const overlap=merge(overlaps),outsideArea=geometryArea(outside);
   const conflict=merge([...(outsideArea>.01?[outside]:[]),...(overlap.length?[overlap]:[])]);
   let clear=b.area;try{if(conflict.length)clear=difference(b.area,conflict);}catch{/* keep the full area as drawn */}
   return {id:b.id,height:b.height,depth:b.depth,upperDepth:b.upperDepth,area:site(b.area),clear:site(clear),conflict:site(conflict),outsideParcel:outsideArea,overlap:geometryArea(overlap),ok:outsideArea<=.01&&geometryArea(overlap)<=.01};
  }catch{return {id:b.id,height:b.height,depth:b.depth,upperDepth:b.upperDepth,area:site(b.area),clear:site(b.area),conflict:[],outsideParcel:0,overlap:0,ok:false};}
 });
}
/**
 * Staffelgeschoss proposal: the footprint inset on every side, at least `minInset`, until it covers at most `maxShare` of the floor
 * below (2/3 is the Berlin full-storey threshold). Geometric proposal only; classification still needs the reviewed clear-height area.
 */
export function proposeStaffel(footprint:Multi,maxShare=2/3,minInset=1.5):Multi{
 const o=footprint[0]?.[0]?.[0];if(!o)return [];
 const shift=(g:Multi,dx:number,dy:number):Multi=>g.map(p=>p.map(r=>r.map(([x,y])=>[x+dx,y+dy] as Point)));
 const local=shift(footprint,-o[0],-o[1]),base=geometryArea(local);if(!(base>0))return [];
 const inset=(d:number):Multi=>{let g=local;for(const p of local)for(const r of p)for(let i=0;i<r.length-1;i++){g=difference(g,capsule(r[i]!,r[i+1]!,d));if(!g.length)return g;}return g;};
 let lo=minInset,hi=Math.sqrt(base),best=inset(lo);
 if(!best.length)return [];
 if(geometryArea(best)>base*maxShare){for(let n=0;n<24;n++){const mid=(lo+hi)/2,g=inset(mid);if(g.length&&geometryArea(g)<=base*maxShare){best=g;hi=mid;}else if(!g.length)hi=mid;else lo=mid;}}
 return geometryArea(best)>base*maxShare?[]:shift(best,o[0],o[1]);
}
/** Berlin BauO §2(12), current July 2026: equality at 2/3 qualifies; elevation must exceed 1.40m. */
export function classifyBerlinStorey(input:{areaAbove230:number|null;referenceArea:number;averageTopAboveTerrain:number|null;reviewed:boolean}):"full"|"not_full"|"unresolved" {
 if(!input.reviewed||input.areaAbove230===null||input.averageTopAboveTerrain===null||(!Number.isFinite(input.referenceArea)||input.referenceArea<=0)||input.areaAbove230<0||!Number.isFinite(input.areaAbove230)||!Number.isFinite(input.averageTopAboveTerrain))return "unresolved";
 return input.averageTopAboveTerrain>1.4&&input.areaAbove230+EPS>=input.referenceArea*2/3?"full":"not_full";
}
/** Circumscribed segment capsule: conservative clearance with <=1mm radial overcut. */
function capsule(a:Point,b:Point,d:number):Multi {
 const theta=Math.atan2(b[1]-a[1],b[0]-a[0]),half=Math.max(8,Math.ceil(Math.PI/Math.acos(d/(d+.001))/2)),step=Math.PI/half,r=d/Math.cos(step/2),ring:Point[]=[];
 for(let i=0;i<=half;i++){const t=theta-Math.PI/2+i*step;ring.push([b[0]+r*Math.cos(t),b[1]+r*Math.sin(t)]);}
 for(let i=0;i<=half;i++){const t=theta+Math.PI/2+i*step;ring.push([a[0]+r*Math.cos(t),a[1]+r*Math.sin(t)]);}
 ring.push(ring[0]!);return [[ring]];
}
export function calculateSiteGeometry(raw:SiteGeometryInput):SiteGeometryResult {
 const out:SiteGeometryResult={method:"berlin_geometry_v1",status:"incomplete",usableGeometry:[],parcelArea:0,envelopeArea:0,usableArea:0,excludedArea:0,buildings:[],issues:[],setbackApproximationMetres:.001};
 const parsed=siteGeometryInputSchema.safeParse(raw);if(!parsed.success){out.issues=parsed.error.issues.map(i=>({code:"invalid_input",id:i.path.join(".")}));return out;}const input=parsed.data;
 if(!input.parcel){out.issues.push({code:"missing_parcel"});return out;}
 if(input.planOverlay){if(!affineFromControlPoints(input.planOverlay.controlPoints))out.issues.push({code:"invalid_plan_alignment"});else if(!reviewed(input.planOverlay))out.issues.push({code:"unreviewed_plan_alignment"});}
 for(const line of input.mandatoryLines)if(!reviewed(line))out.issues.push({code:"unreviewed_mandatory_line",id:line.id});
 if(new Set(input.buildings.map(b=>b.id)).size!==input.buildings.length){out.issues.push({code:"duplicate_building_id"});return out;}
 const evidence=[input.parcel,...(input.envelope?[input.envelope]:[]),...input.exclusions,...input.buildings.flatMap(b=>[b.footprint,...b.staffel.map(s=>s.footprint)])];
 const vertices=evidence.reduce((n,e)=>n+vertexCount(e.geometry),0);
 // Conservative preflight bounds topology pairs, repeated clipping, and line/facade comparisons.
 // Capsule tessellation grows with clearance; use the maximum possible profile distance.
 const capsuleVertices=input.setbacks.reduce((n,e)=>{const d=Math.max(e.distance??0,e.assessmentHeight??0,...input.buildings.map(b=>Math.max(b.height??0,b.fullStoreys*b.storeyHeight+b.staffel.reduce((h,s)=>h+s.height,0))));return n+(d>0?2*Math.max(8,Math.ceil(Math.PI/Math.acos(d/(d+.001))/2))+3:0);},0);
 const lineVertices=input.mandatoryLines.reduce((n,l)=>n+l.line.length,0);
 if(vertices>10000||vertices**2+vertices*capsuleVertices+lineVertices*vertices>MAX_GEOMETRY_WORK){out.issues.push({code:"geometry_too_complex"});return out;}
 for(const e of evidence){for(const code of validateGeometry(e.geometry))out.issues.push({code,id:e.id});if(!reviewed(e))out.issues.push({code:"unreviewed_geometry",id:e.id});}
 if(out.issues.some(i=>!["unreviewed_geometry","unreviewed_plan_alignment","unreviewed_mandatory_line"].includes(i.code)))return out;
 try {
  const parcel=input.parcel.geometry;out.parcelArea=geometryArea(parcel);
  if(!input.envelope)out.issues.push({code:"missing_envelope"});
  let usable=input.envelope?intersection(parcel,input.envelope.geometry):parcel;out.envelopeArea=geometryArea(usable);
  if(!input.exclusionsReviewed)out.issues.push({code:"exclusions_unreviewed"});
  for(const e of input.exclusions)usable=difference(usable,e.geometry);
  const expected=createDefaultSetbacks(input.parcel),seen=new Set<string>();
  for(const edge of input.setbacks){const key=`${edge.polygonIndex}/${edge.ringIndex}/${edge.edgeIndex}`;if(seen.has(key)){out.issues.push({code:"duplicate_setback",id:edge.id});continue;}seen.add(key);const ring=parcel[edge.polygonIndex]?.[edge.ringIndex];if(!ring||edge.edgeIndex>=ring.length-1){out.issues.push({code:"invalid_setback_edge",id:edge.id});continue;}let distance=edge.distance;
   if(edge.profile!=="manual"&&edge.profile!=="boundary_exception"){
    const height=edge.heightSource==="buildings"?(input.buildings.length?Math.max(...input.buildings.map(b=>Math.max(b.height??0,b.fullStoreys*b.storeyHeight+b.staffel.reduce((h,s)=>h+s.height,0)))):null):edge.assessmentHeight;
    if(height===null){out.issues.push({code:"missing_setback_height",id:edge.id});continue;}
    let profile=edge.profile;
    if(profile==="low_class"&&input.buildings.some(b=>b.fullStoreys+b.staffel.length>3)){out.issues.push({code:"low_class_profile_unconfirmed",id:edge.id});profile="standard";}
    distance=deriveBerlinSetback(profile,height);
    if(edge.reviewedHeight===null||Math.abs(edge.reviewedHeight-height)>.001)out.issues.push({code:"setback_height_review_required",id:edge.id});
   }
   if(distance===null){out.issues.push({code:"missing_setback_distance",id:edge.id});continue;}if(!reviewed(edge))out.issues.push({code:"unreviewed_setback",id:edge.id});if(distance>0)usable=difference(usable,capsule(ring[edge.edgeIndex]!,ring[edge.edgeIndex+1]!,distance));}
  for(const e of expected)if(!seen.has(`${e.polygonIndex}/${e.ringIndex}/${e.edgeIndex}`))out.issues.push({code:"missing_setback",id:e.id});
  out.usableGeometry=usable;out.usableArea=Math.max(0,geometryArea(usable));out.excludedArea=out.envelopeArea-out.usableArea;
  for(const b of input.buildings){const footprintArea=geometryArea(b.footprint.geometry),outsideArea=geometryArea(difference(b.footprint.geometry,usable));let overlap:Multi=[];for(const other of input.buildings)if(other.id!==b.id){const x=intersection(b.footprint.geometry,other.footprint.geometry);if(x.length)overlap=overlap.length?clip.union(overlap,x):x;}const overlapArea=geometryArea(overlap);let staffelGrossArea=0,countableExtra=0,classified=b.fullStoreys,valid=outsideArea<.001&&overlapArea<.001;
   if(!b.storeysReviewed||!b.storeysSource.trim())out.issues.push({code:"unreviewed_storeys",id:b.id});
   let below=b.footprint.geometry;
   for(const s of b.staffel){const area=geometryArea(s.footprint.geometry);staffelGrossArea+=area;if(s.countable)countableExtra+=area;if(geometryArea(difference(s.footprint.geometry,below))>.001){valid=false;out.issues.push({code:"staffel_outside_below",id:s.footprint.id});}const classification=classifyBerlinStorey({areaAbove230:s.areaAbove230,referenceArea:geometryArea(below),averageTopAboveTerrain:s.averageTopAboveTerrain,reviewed:s.classificationReviewed});if(classification==="unresolved"){classified=NaN;out.issues.push({code:"storey_classification_unresolved",id:s.footprint.id});}else if(classification==="full"){classified++;if(!s.countable){countableExtra+=area;}if(!s.countable)out.issues.push({code:"full_storey_countability_review",id:s.footprint.id});}if(s.areaAbove230!==null&&s.areaAbove230>area+.001){valid=false;out.issues.push({code:"invalid_clear_height_area",id:s.footprint.id});}below=s.footprint.geometry;}
   if(outsideArea>=.001)out.issues.push({code:"building_outside_usable",id:b.id});if(overlapArea>=.001)out.issues.push({code:"building_overlap",id:b.id});const fullFloorArea=footprintArea*b.fullStoreys;out.buildings.push({id:b.id,footprintArea,outsideArea,overlapArea,fullFloorArea,staffelGrossArea,countableFloorArea:fullFloorArea+countableExtra,grossFloorArea:fullFloorArea+staffelGrossArea,validPlacement:valid,classifiedFullStoreys:Number.isFinite(classified)?classified:null});
  }
  for(const line of input.mandatoryLines)for(let i=0;i<line.line.length-1;i++){
   const a=line.line[i]!,b=line.line[i+1]!;
   if(equal(a,b)||!segmentWithinGeometry(a,b,parcel))out.issues.push({code:"invalid_mandatory_line",id:line.id});
   if(!facadeCoversSegment(a,b,input.buildings.map(b=>b.footprint.geometry)))out.issues.push({code:"mandatory_line_unmet",id:line.id});
  }
  if(out.issues.some(i=>i.code==="mandatory_line_unmet"||i.code==="invalid_mandatory_line"))out.buildings.forEach(b=>b.validPlacement=false);
  out.status=out.issues.length?"indicative":"reviewed";
 }catch{out.status="incomplete";out.issues.push({code:"geometry_operation_failed"});out.usableGeometry=[];out.usableArea=0;}
 return out;
}
const rect=(x:number,y:number,w:number,h:number):Multi=>[[[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]]];
function bounds(g:Multi){const p=g.flat(2);return {minX:Math.min(...p.map(p=>p[0])),minY:Math.min(...p.map(p=>p[1])),maxX:Math.max(...p.map(p=>p[0])),maxY:Math.max(...p.map(p=>p[1]))};}
/** Three deterministic, ranked design alternatives. Search is bounded, not a proof of global maximum. */
export function generateMassingCandidates(input:SiteGeometryInput,options:MassingOptions):MassingCandidate[]{
 if(![options.grz,options.gfz,options.maxFullStoreys,options.storeyHeight].every(Number.isFinite)||options.grz<=0||options.grz>1||options.gfz<=0||options.maxFullStoreys<1||options.maxFullStoreys>200||!Number.isInteger(options.maxFullStoreys)||options.storeyHeight<=0||options.storeyHeight>20||options.gfz>100||(options.staffelRatio!==undefined&&(!Number.isFinite(options.staffelRatio)||options.staffelRatio<0||options.staffelRatio>1)))return [];
 const height=options.storeyHeight*(options.maxFullStoreys+((options.staffelRatio??0)>0?1:0));
 const proposed:BuildingGeometry|undefined=input.parcel?{id:"generation-height",label:"Generation height",footprint:input.parcel,fullStoreys:options.maxFullStoreys,storeyHeight:options.storeyHeight,height,storeysSource:"Generation options",storeysReviewed:false,staffel:[]}:undefined;
 const result=calculateSiteGeometry({...input,buildings:proposed?[proposed]:[]});if(!result.usableGeometry.length)return [];
 const target=Math.min(result.usableArea,result.parcelArea*options.grz,result.parcelArea*options.gfz/(options.maxFullStoreys+(options.staffelRatio??0))),b=bounds(result.usableGeometry),w=b.maxX-b.minX,h=b.maxY-b.minY;const shapes:{strategy:MassingCandidate["strategy"];geometry:Multi}[]=[];
 for(const fraction of [1,.9])for(const direction of ["west_band","south_band","east_band","north_band"] as const){const x=direction==="west_band"||direction==="east_band";let lo=0,hi=x?w:h,best:Multi=[];for(let n=0;n<40;n++){const mid=(lo+hi)/2,rx=direction==="east_band"?b.maxX-mid:b.minX-1,ry=direction==="north_band"?b.maxY-mid:b.minY-1,g=intersection(result.usableGeometry,rect(rx,ry,x?mid+1:w+2,x?h+2:mid+1));if(geometryArea(g)<=target*fraction){best=g;lo=mid;}else hi=mid;}if(best.length)shapes.push({strategy:direction,geometry:best});}
 let best:Multi=[],bestArea=0;
 for(const ratio of [.5,1,2])for(let ix=1;ix<5;ix++)for(let iy=1;iy<5;iy++){const cx=b.minX+w*ix/5,cy=b.minY+h*iy/5;let lo=0,hi=Math.sqrt(target/ratio);for(let n=0;n<18;n++){const rh=(lo+hi)/2,rw=rh*ratio,g=rect(cx-rw/2,cy-rh/2,rw,rh);if(geometryArea(difference(g,result.usableGeometry))<EPS){lo=rh;if(rw*rh>bestArea){best=g;bestArea=rw*rh;}}else hi=rh;}}if(best.length)shapes.push({strategy:"compact_rectangle",geometry:best});
 const evaluatedCandidates=shapes.map((s,index)=>{const id=`candidate-${index+1}`,e:GeometryEvidence={id:`${id}-footprint`,label:s.strategy,geometry:s.geometry,source:"Deterministic bounded geometry proposal; requires review",sourceDate:null,reviewed:false},building:BuildingGeometry={id,label:`Variant ${index+1}`,footprint:e,fullStoreys:options.maxFullStoreys,storeyHeight:options.storeyHeight,height,storeysSource:"Requested design limit; requires review",storeysReviewed:false,staffel:[]};
 if(options.staffelRatio&&options.staffelRatio>0&&options.staffelRatio<=1){const sb=bounds(s.geometry);let lo=0,hi=sb.maxX-sb.minX,sg:Multi=[];for(let i=0;i<35;i++){const m=(lo+hi)/2,g=intersection(s.geometry,rect(sb.minX-1,sb.minY-1,m+1,sb.maxY-sb.minY+2));if(geometryArea(g)<=geometryArea(s.geometry)*options.staffelRatio){lo=m;sg=g;}else hi=m;}if(sg.length)building.staffel=[{footprint:{...e,id:`${id}-staffel`,geometry:sg},countable:true,height:options.storeyHeight,areaAbove230:null,averageTopAboveTerrain:null,classificationReviewed:false}];}
 const evaluated=calculateSiteGeometry({...input,buildings:[building]});const metrics=evaluated.buildings[0];if(!metrics)return null;const grz=metrics.footprintArea/result.parcelArea,gfz=metrics.countableFloorArea/result.parcelArea;return {id,strategy:s.strategy,building,metrics,grz,gfz,violations:[...(grz>options.grz+EPS?["grz_exceeded"]:[]),...(gfz>options.gfz+EPS?["gfz_exceeded"]:[]),...(!metrics.validPlacement?["placement_invalid"]:[]),...evaluated.issues.filter(i=>i.code==="mandatory_line_unmet").map(i=>i.code)]};}).filter((c):c is NonNullable<typeof c>=>c!==null&&!c.violations.length).sort((a,b)=>b.metrics.grossFloorArea-a.metrics.grossFloorArea);
 const unique:MassingCandidate[]=[];for(const candidate of evaluatedCandidates){if(unique.some(c=>Math.abs(c.metrics.footprintArea-candidate.metrics.footprintArea)<.001&&geometryArea(difference(c.building.footprint.geometry,candidate.building.footprint.geometry))<.001))continue;unique.push(candidate);if(unique.length===3)break;}return unique;
}

/** Affine image (normalised x/y) -> EPSG:25833, solved from three non-collinear controls. */
export function affineFromControlPoints(points:PlanOverlay["controlPoints"]):[number,number,number,number,number,number]|null {
 if(points.length!==3)return null;const [p,q,r]=points; if(!p||!q||!r)return null;
 const ax=q.image[0]-p.image[0],ay=q.image[1]-p.image[1],bx=r.image[0]-p.image[0],by=r.image[1]-p.image[1],det=ax*by-bx*ay;
 if(Math.abs(det)<1e-10||points.some(p=>p.image.some(v=>v<0||v>1)))return null;
 const solve=(index:0|1):[number,number,number]=>{const u=q.site[index]-p.site[index],v=r.site[index]-p.site[index],a=(u*by-v*ay)/det,b=(v*ax-u*bx)/det;return [a,b,p.site[index]-a*p.image[0]-b*p.image[1]];};const x=solve(0),y=solve(1);if(Math.abs(x[0]*y[1]-x[1]*y[0])<1e-8)return null;return [...x,...y];
}
export function transformPlanPoint(point:Point,matrix:[number,number,number,number,number,number]):Point {return [matrix[0]*point[0]+matrix[1]*point[1]+matrix[2],matrix[3]*point[0]+matrix[4]*point[1]+matrix[5]];}
/** Every point along the supplied segment must be covered by collinear facade edges (5cm tolerance). */
function facadeCoversSegment(a:Point,b:Point,buildings:Multi[]):boolean {
 const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);if(length<.001)return false;const intervals:[number,number][]=[];
 const projection=(p:Point)=>((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length;
 for(const g of buildings)for(const poly of g)for(const ring of poly.slice(0,1))for(let i=0;i<ring.length-1;i++){const p=ring[i]!,q=ring[i+1]!;if(Math.abs(cross(a,b,p))/length<=.05&&Math.abs(cross(a,b,q))/length<=.05){const v=projection(p),w=projection(q);intervals.push([Math.min(v,w),Math.max(v,w)]);}}
 intervals.sort((a,b)=>a[0]-b[0]);let end=0;for(const [lo,hi] of intervals){if(lo>end+.05)break;if(hi>end)end=hi;}return end>=length-.05;
}
export const polygonArea = geometryArea;
export const intersectGeometry = (...geometries:Multi[]):Multi => geometries.length ? geometries.slice(1).reduce((a,b)=>intersection(a,b),geometries[0]!) : [];
export const unionGeometry = (...geometries:Multi[]):Multi => {const nonempty=geometries.filter(g=>g.length);return nonempty.length?clip.union(nonempty[0]!,...nonempty.slice(1)):[];};

function segmentWithinGeometry(a:Point,b:Point,g:Multi):boolean {
 const dx=b[0]-a[0],dy=b[1]-a[1],ts=[0,1];
 for(const p of g)for(const r of p)for(let i=0;i<r.length-1;i++){const c=r[i]!,d=r[i+1]!,ex=d[0]-c[0],ey=d[1]-c[1],det=dx*ey-dy*ex;if(Math.abs(det)>EPS){const t=((c[0]-a[0])*ey-(c[1]-a[1])*ex)/det,u=((c[0]-a[0])*dy-(c[1]-a[1])*dx)/det;if(t>=0&&t<=1&&u>=0&&u<=1)ts.push(t);}}
 ts.sort((a,b)=>a-b);
 const contains=(pt:Point)=>g.some(p=>{const on=(r:Point[])=>r.slice(0,-1).some((c,i)=>{const d=r[i+1]!;return Math.abs(cross(c,d,pt))<EPS&&pt[0]>=Math.min(c[0],d[0])-EPS&&pt[0]<=Math.max(c[0],d[0])+EPS&&pt[1]>=Math.min(c[1],d[1])-EPS&&pt[1]<=Math.max(c[1],d[1])+EPS;});return (inside(pt,p[0]!)||on(p[0]!))&&!p.slice(1).some(r=>inside(pt,r)&&!on(r));});
 return ts.slice(0,-1).every((t,i)=>{const m=(t+ts[i+1]!)/2;return contains([a[0]+m*dx,a[1]+m*dy]);});
}
