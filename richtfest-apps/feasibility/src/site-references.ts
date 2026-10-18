import { Router, type Request } from "express";
import { z } from "zod";
import { ok, toUtm, type SiteReference } from "@richtfest/shared";
import { polygonArea, intersectGeometry, unionGeometry, validateGeometry } from "@richtfest/shared/site-geometry";
import type { GeometryMultiPolygon as Multi, GeometryPoint as Point } from "@richtfest/shared/site-geometry-model";
import type { AppDeps } from "./deps";
import { features, polygonsOf, serviceUrl } from "./berlin-site-context";
import { resolveAssessmentLocation } from "./site-location";
const number=(v:unknown)=>{if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)&&n>0?n:null;};
const text=(v:unknown)=>typeof v==="string"?v.slice(0,1000):"";
const metric=(value:number|null,source:string,sourceDate:string|null,kind:"official"|"calculated"|"estimated"="calculated")=>({value,source,sourceDate,kind,reviewed:false});
function bbox(g:Multi){let x=Infinity,y=Infinity,X=-Infinity,Y=-Infinity;for(const p of g)for(const r of p)for(const a of r){x=Math.min(x,a[0]);y=Math.min(y,a[1]);X=Math.max(X,a[0]);Y=Math.max(Y,a[1]);}return{x,y,X,Y};}
function touches(a:ReturnType<typeof bbox>,b:ReturnType<typeof bbox>){return a.x<=b.X&&a.X>=b.x&&a.y<=b.Y&&a.Y>=b.y;}
const pointSegment=(p:Point,a:Point,b:Point)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);};
/** Minimum boundary distance, including concave parcel vertices and crossing segments. */
export function boundaryClearance(building:Multi,parcel:Multi):number {
 const edges=(g:Multi)=>g.flatMap(poly=>poly.flatMap(r=>r.slice(0,-1).map((a,i)=>[a,r[i+1]!] as const)));
 const cross=(a:Point,b:Point,c:Point)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
 let minimum=Infinity;
 for(const [a,b] of edges(building))for(const [c,d] of edges(parcel)){
  const overlappingBoxes=Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))&&Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]));
  if(overlappingBoxes&&cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0)return 0;
  minimum=Math.min(minimum,pointSegment(a,c,d),pointSegment(b,c,d),pointSegment(c,a,b),pointSegment(d,a,b));
 }
 return minimum;
}
/** Oriented bounding dimensions, labelled estimates rather than street-aligned façade measurements. */
export function referenceDimensions(g:Multi){const points=g.flat(2);let best={area:Infinity,depth:0,frontage:0};for(const poly of g)for(const r of poly)for(let i=0;i<r.length-1;i++){const a=r[i]!,b=r[i+1]!,angle=Math.atan2(b[1]-a[1],b[0]-a[0]),c=Math.cos(angle),s=Math.sin(angle);let x=Infinity,y=Infinity,X=-Infinity,Y=-Infinity;for(const p of points){const u=(p[0]-a[0])*c+(p[1]-a[1])*s,v=-(p[0]-a[0])*s+(p[1]-a[1])*c;x=Math.min(x,u);X=Math.max(X,u);y=Math.min(y,v);Y=Math.max(Y,v);}const w=X-x,h=Y-y;if(w*h<best.area)best={area:w*h,depth:Math.min(w,h),frontage:Math.max(w,h)};}return best;}
/** Invert the existing display projection; not a surveyed coordinate conversion. */
export function displayLonLat(origin:Point):Point {
 let lon=13.4,lat=52.5;
 for(let i=0;i<8;i++) {const p=toUtm(lon,lat,33),x=toUtm(lon+.00001,lat,33),y=toUtm(lon,lat+.00001,33);const a=(x[0]-p[0])/.00001,b=(y[0]-p[0])/.00001,c=(x[1]-p[1])/.00001,d=(y[1]-p[1])/.00001,det=a*d-b*c,ex=origin[0]-p[0],ey=origin[1]-p[1];lon+=(ex*d-b*ey)/det;lat+=(a*ey-ex*c)/det;}
 return [lon,lat];
}
export async function discoverSiteReferences(site:{address:string;origin:Point;sources:{label:string;url:string}[]},signal:AbortSignal){
 const radius=200,limit=1000;
 const urls=[serviceUrl("ua_gebaeudehoehen","gebaeudehoehen",site.origin,radius,limit),serviceUrl("alkis_flurstuecke","flurstuecke",site.origin,radius,limit),serviceUrl("alkis_gebaeude","gebaeude",site.origin,radius,limit)];
 const results=await Promise.allSettled(urls.map(url=>features(url,signal,limit)));
 const list=(i:number)=>results[i]?.status==="fulfilled"?(results[i] as PromiseFulfilledResult<Awaited<ReturnType<typeof features>>>).value:[];
 const vertices=(g:Multi)=>g.reduce((n,p)=>n+p.reduce((m,r)=>m+r.length,0),0);
 let operations=0;
 const consume=(amount:number)=>{signal.throwIfAborted();operations+=amount;if(operations>5_000_000)throw Object.assign(new Error("Reference geometry exceeds the lookup calculation budget; inspect the official source map"),{status:422,code:"reference_geometry_budget"});};
 const checked=(f:Parameters<typeof polygonsOf>[0])=>{const g=polygonsOf(f);const n=vertices(g);consume(n*n);return g.length&&!validateGeometry(g).length?g:[];};
 const intersection=(a:Multi,b:Multi)=>{consume(vertices(a)*vertices(b));return intersectGeometry(a,b);};
 const union=(...items:Multi[])=>{const n=items.reduce((sum,g)=>sum+vertices(g),0);consume(n*n);return unionGeometry(...items);};
 const buildings=list(0).flatMap(f=>{const g=checked(f);if(!g.length)return[];return[{f,g,area:polygonArea(g),box:bbox(g)}];});
 const parcels=list(1).flatMap(f=>{const g=checked(f);if(!g.length)return[];return[{f,g,area:number(f.properties.afl),box:bbox(g)}];});
 const cadastral=list(2).flatMap(f=>{const g=checked(f);return g.length?[{f,g,box:bbox(g)}]:[];});
 const parcelMetrics=new Map<string,{grz:number|null;gfz:number|null}>();
 const references:SiteReference[]=buildings.map(b=>{
  const p=b.f.properties,id=text(p.gml_id)||text(b.f.id),source=`${urls[0]} · ${id}`,rawDate=text(p.grundrissaktualitaet),date=/^\d{4}-\d{2}-\d{2}$/.test(rawDate)&&Number.isFinite(Date.parse(rawDate))&&new Date(rawDate).toISOString().slice(0,10)===rawDate?rawDate:null;
  const matches=parcels.filter(parcel=>touches(b.box,parcel.box)&&polygonArea(intersection(b.g,parcel.g))>=b.area-.05);
  const parcel=matches.length===1?matches[0]:undefined,parcelId=parcel?(text(parcel.f.properties.uuid)||text(parcel.f.id)):undefined;
  const cadastralMatches=cadastral.filter(c=>touches(b.box,c.box)&&polygonArea(intersection(b.g,c.g))/Math.max(b.area,polygonArea(c.g))>.95);
  const cad=cadastralMatches.length===1?cadastralMatches[0]:undefined;
  const rawStoreys=number(p.geschosse),storeys=rawStoreys&&Number.isInteger(rawStoreys)&&rawStoreys<=200?rawStoreys:null;
  consume(vertices(b.g)**2);const dimensions=referenceDimensions(b.g);
  let boundaryDistance:number|null=null;
  if(parcel){consume(vertices(b.g)*vertices(parcel.g));boundaryDistance=boundaryClearance(b.g,parcel.g);}
  if(parcel&&parcelId&&!parcelMetrics.has(parcelId)){
   const complete=buildings.length===list(0).length&&parcels.length===list(1).length&&results[0]?.status==="fulfilled"&&results[1]?.status==="fulfilled"&&parcel.box.x>site.origin[0]-radius&&parcel.box.X<site.origin[0]+radius&&parcel.box.y>site.origin[1]-radius&&parcel.box.Y<site.origin[1]+radius;
   const onParcel=buildings.filter(other=>touches(other.box,parcel.box)&&polygonArea(intersection(other.g,parcel.g))>.05);
   let grz:number|null=null,gfz:number|null=null;
   if(complete&&parcel.area){const occupied=union(...onParcel.map(other=>intersection(other.g,parcel.g)));grz=polygonArea(occupied)/parcel.area;
    const floors=onParcel.map(other=>number(other.f.properties.geschosse));
    if(floors.every(n=>n!==null&&Number.isInteger(n)&&n<=200)){let area=0;const max=Math.max(0,...floors as number[]);for(let level=1;level<=max;level++)area+=polygonArea(union(...onParcel.filter((_,i)=>floors[i]!>=level).map(other=>intersection(other.g,parcel.g))));gfz=area/parcel.area;}
   }parcelMetrics.set(parcelId,{grz,gfz});
  }
  const ratios=parcelId?parcelMetrics.get(parcelId):undefined;
  const ratioSource=`${source} · ${urls[1]} · ${parcelId??"unresolved parcel"} · coverage from observed footprints; GFZ assumes reported storeys are countable, not a legal full-storey determination`;
  return{id,buildingId:id,...(parcelId?{parcelId}:{}),label:referenceLabel(text(cad?.f.properties.namlag)||text(p.strasse),text(cad?.f.properties.hnr)||text(p.hnr))||text(p.name)||id,source,note:"Public context proposal. Select appropriate references and verify observed storeys, heights, façade alignment and planning relevance. Oriented bounding dimensions are estimates; not street-aligned surveyed dimensions.",polygons:b.g,
   metrics:{footprint:metric(b.area,source,date),storeys:metric(storeys,source,null,"official"),ridgeHeight:metric(number(p.hoehe),source,null,"official"),eaveHeight:metric(null,source,null,"estimated"),depth:metric(dimensions.depth,source,date,"estimated"),frontage:metric(dimensions.frontage,source,date,"estimated"),boundaryDistance:metric(boundaryDistance,`${source} · ${parcelId??""}`,null),buildingLineOffset:metric(null,source,null,"estimated"),grz:metric(ratios?.grz??null,ratioSource,null),gfz:metric(ratios?.gfz??null,ratioSource,null,"estimated")},
   ...(cad&&text(cad.f.properties.bezbaw)?{buildingForm:{value:text(cad.f.properties.bezbaw),source:`${urls[2]} · ${text(cad.f.properties.uuid)}`,sourceDate:null,reviewed:false}}:{})};
 });
 references.sort((a,b)=>{const ac=bbox(a.polygons!),bc=bbox(b.polygons!);return Math.hypot((ac.x+ac.X)/2-site.origin[0],(ac.y+ac.Y)/2-site.origin[1])-Math.hypot((bc.x+bc.X)/2-site.origin[0],(bc.y+bc.Y)/2-site.origin[1]);});
 return{address:site.address,origin:site.origin,longitude:displayLonLat(site.origin)[0],latitude:displayLonLat(site.origin)[1],retrievedAt:new Date().toISOString(),references,status:results.map((r,i)=>r.status==="fulfilled"&&[buildings,parcels,cadastral][i]!.length===list(i).length?"available":"unavailable"),sources:urls,
  buildings:buildings.map(b=>({id:text(b.f.properties.gml_id)||text(b.f.id),sourceId:text(b.f.id),polygons:b.g.map(p=>p.map(r=>r.map(point=>[point[0]-site.origin[0],site.origin[1]-point[1]] as Point))),height:number(b.f.properties.hoehe),label:references.find(r=>r.id===(text(b.f.properties.gml_id)||text(b.f.id)))?.label??"Building",roof:text(b.f.properties.dachart_txt)||null}))};
}
/** ALKIS `namlag` often already includes the house number ("Giersstraße 20"); avoid "Giersstraße 20 20". */
export function referenceLabel(street:string,houseNumber:string){if(!houseNumber)return street;const escaped=houseNumber.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");return new RegExp(`(^|\\s)${escaped}$`,"i").test(street)?street:[street,houseNumber].filter(Boolean).join(" ");}
export function createSiteReferencesRouter(getDeps:(req:Request)=>AppDeps){const router=Router();router.post("/projects/:projectId/references/discover",async(req,res,next)=>{try{const d=getDeps(req);d.requirePermission("projects:read");const id=z.string().uuid().parse(req.params.projectId);if(!await d.project(id))throw Object.assign(new Error("Project not found"),{status:404});const signal=AbortSignal.timeout(30000),site=await resolveAssessmentLocation(d,id,req.body,signal);res.json(ok(await discoverSiteReferences(site,signal)));}catch(e){next(e);}});return router;}
