import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { PenSegment } from "./plan-outline-walls";

type Matrix = [number,number,number,number,number,number];
type Point = {x:number;y:number};
type Box = {x:number;y:number;width:number;height:number};
export type PlanFillRegion = {sourceKey:string;layerId:string;layerName:string;rings:Point[][];fillRule:"evenodd"|"nonzero"};
export type PlanFootprint = {sourceKey:string;entityType:"element";name:string;layerId:string;layerName:string;quote:string;fillColor?:string;
  geometry:{quality:"footprint";coordinateSpace:"normalized-page";polygon:Point[];rings?:Point[][];fillRule?:"evenodd"|"nonzero";curvesFlattened?:true;planRegion:{x:number;y:number;width:number;height:number};limitations:string}};
const identity:Matrix=[1,0,0,1,0,0];
export const multiplyPlanTransform=(a:Matrix,b:Matrix):Matrix=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
const point=(m:Matrix,x:number,y:number):Point=>({x:m[0]*x+m[2]*y+m[4],y:m[1]*x+m[3]*y+m[5]});
const same=(a:Point,b:Point)=>Math.abs(a.x-b.x)<1e-5&&Math.abs(a.y-b.y)<1e-5;
const bounds=(p:Point[])=>{const x=Math.min(...p.map(p=>p.x)),y=Math.min(...p.map(p=>p.y));return {x,y,width:Math.max(...p.map(p=>p.x))-x,height:Math.max(...p.map(p=>p.y))-y};};
const limitations="Observed filled PDF path in the construction layer; not a verified wall, material, construction state, physical measurement or room boundary. Curves are flattened to short segments and compound fills keep every ring; unsupported clipping and hidden layers are omitted.";
/** Existing/demolition layers are alternative construction states, never primary barriers, even when also named "Konstruktion". */
export const alternativeConstructionLayer=/Abbruch|Bestand/i;

/** PDF.js 5.7 DrawOPS numeric layout, pinned in package.json: 0 moveTo, 1 lineTo,
 * 2 curveTo (6 args), 3 quadraticCurveTo (4 args), 4 closePath. Curves are
 * flattened for barrier geometry; the flattening is recorded as approximate. */
type PathSegment = {ring:number;from:Point;c1:Point;c2:Point;to:Point};
function walkPath(path:ArrayLike<number>,transform:Matrix,maxPoints=5000) {
  const rings:Point[][]=[],curves:PathSegment[]=[];let ring:Point[]=[],closed:boolean[]=[],curved=false,current:Point|null=null,start:Point|null=null;
  const finish=(close:boolean)=>{if(ring.length){rings.push(ring);closed.push(close);}ring=[];};
  for(let i=0;i<path.length;){const op=path[i++];
    if(op===0){finish(false);current=start=point(transform,path[i++],path[i++]);ring.push(current);}
    else if(op===1){if(!current)return null;current=point(transform,path[i++],path[i++]);ring.push(current);}
    else if(op===2||op===3){if(!current)return null;curved=true;
      const from=current,c1=point(transform,path[i++],path[i++]),c2=op===2?point(transform,path[i++],path[i++]):c1,to=point(transform,path[i++],path[i++]);
      // A quadratic control point is promoted to the equivalent cubic controls.
      const [a,b]=op===3?[{x:from.x+2/3*(c1.x-from.x),y:from.y+2/3*(c1.y-from.y)},{x:to.x+2/3*(c1.x-to.x),y:to.y+2/3*(c1.y-to.y)}]:[c1,c2];
      curves.push({ring:rings.length,from,c1:a,c2:b,to});
      for(let s=1;s<=8;s++){const t=s/8,u=1-t;ring.push({x:u*u*u*from.x+3*u*u*t*a.x+3*u*t*t*b.x+t*t*t*to.x,y:u*u*u*from.y+3*u*u*t*a.y+3*u*t*t*b.y+t*t*t*to.y});}
      current=to;}
    else if(op===4){finish(true);current=start;}else return null;
    if(ring.length+rings.reduce((n,r)=>n+r.length,0)>maxPoints)return null;
  }
  finish(false);
  if(!rings.every(r=>r.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))))return null;
  return {rings:rings.map(r=>r.length>1&&same(r[0],r.at(-1)!)?r.slice(0,-1):r),closed,curved,curves};
}
/** Filled paths close implicitly in PDF; every subpath with an area is a fill ring. */
function ringsFromPath(path:ArrayLike<number>,transform:Matrix,maxPoints=5000) {
  const walked=walkPath(path,transform,maxPoints);if(!walked)return null;
  const rings=walked.rings.filter(r=>r.length>=3);
  return rings.length?{rings,curved:walked.curved}:null;
}
const ringArea=(ring:Point[])=>Math.abs(ring.reduce((sum,p,j)=>{const q=ring[(j+1)%ring.length];return sum+p.x*q.y-q.x*p.y;},0))/2;
const polygonFromPath=(path:ArrayLike<number>,transform:Matrix)=>{const r=ringsFromPath(path,transform);return r&&r.rings.length===1&&!r.curved?r.rings[0]:null;};

export type PlanBarrierLine={layerId:string;points:Point[];closed:boolean};
/** A door swing drawn as a polyline: every vertex on one circle around a hinge, sweeping about 90°. */
export function doorSwingFromPolyline(points:Point[]) {
  if(points.length<5)return null;
  const a=points[0],b=points[Math.floor(points.length/2)],c=points.at(-1)!;
  const d=2*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));if(Math.abs(d)<1e-9)return null;
  const sq=(p:Point)=>p.x*p.x+p.y*p.y;
  const hinge={x:(sq(a)*(b.y-c.y)+sq(b)*(c.y-a.y)+sq(c)*(a.y-b.y))/d,y:(sq(a)*(c.x-b.x)+sq(b)*(a.x-c.x)+sq(c)*(b.x-a.x))/d};
  const radius=Math.hypot(a.x-hinge.x,a.y-hinge.y);
  // Short, evenly bent chords: a few corners of a polygon can also lie on one circle.
  if(!(radius>0)||points.some(p=>Math.abs(Math.hypot(p.x-hinge.x,p.y-hinge.y)-radius)>radius*.06)
    ||points.some((p,i)=>i>0&&Math.hypot(p.x-points[i-1].x,p.y-points[i-1].y)>radius*.6))return null;
  const sweep=Math.acos(Math.max(-1,Math.min(1,((a.x-hinge.x)*(c.x-hinge.x)+(a.y-hinge.y)*(c.y-hinge.y))/(radius*Math.hypot(c.x-hinge.x,c.y-hinge.y)))))*180/Math.PI;
  return sweep<70||sweep>110?null:{hinge,start:a,end:c,radius,sweepDegrees:sweep};
}
/**
 * Chain single-segment strokes that share endpoints and bend gently in one
 * direction with similar lengths, as a flattened arc does. A door leaf or wall
 * line meeting the arc breaks the chain by its length or turn.
 */
function segmentChains(segments:{a:Point;b:Point}[]) {
  const key=(p:Point)=>`${Math.round(p.x*20)},${Math.round(p.y*20)}`,at=new Map<string,number[]>();
  segments.forEach((s,i)=>{for(const p of [s.a,s.b])at.set(key(p),[...(at.get(key(p))??[]),i]);});
  const length=(s:{a:Point;b:Point})=>Math.hypot(s.b.x-s.a.x,s.b.y-s.a.y);
  const used=new Set<number>(),chains:{points:Point[];members:number[]}[]=[];
  const turn=(p:Point,q:Point,r:Point)=>{const a=Math.atan2(q.y-p.y,q.x-p.x),b=Math.atan2(r.y-q.y,r.x-q.x);let d=b-a;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;return d;};
  for(let i=0;i<segments.length;i++){
    if(used.has(i)||length(segments[i])===0)continue;
    used.add(i);let points=[segments[i].a,segments[i].b];const members=[i];let sign=0;
    for(const forward of [true,false]){
      for(;;){
        const end=forward?points.at(-1)!:points[0],before=forward?points.at(-2)!:points[1],last=forward?members.at(-1)!:members[0];
        const next=(at.get(key(end))??[]).filter(j=>!used.has(j)&&length(segments[j])>0).map(j=>{const s=segments[j],other=key(s.a)===key(end)?s.b:s.a;
          const t=forward?turn(before,end,other):turn(other,end,before);return {j,other,t};})
          .filter(({j,t})=>{const ratio=length(segments[j])/length(segments[last]);return ratio<2.5&&ratio>.4&&Math.abs(t)>.03&&Math.abs(t)<.7&&(sign===0||Math.sign(t)===sign);});
        if(next.length!==1)break;
        const {j,other,t}=next[0];sign=Math.sign(t);used.add(j);
        if(forward){points.push(other);members.push(j);}else{points.unshift(other);members.unshift(j);}
      }
    }
    if(members.length>=4)chains.push({points,members});
  }
  return chains;
}
export type PlanDoorSwing={sourceKey:string;layerId:string|null;layerName:string|null;strokeColor?:string|null;hinge:Point;start:Point;end:Point;radius:number;sweepDegrees:number};
/** A stroked cubic that is a circular arc of roughly 90° is the conventional
 * door swing symbol. Its centre (the hinge) is recovered from the end normals;
 * it is drawing evidence for an opening, not a verified door. */
export function doorSwingFromCurve({from,c1,c2,to}:Omit<PathSegment,"ring">) {
  const t0={x:c1.x-from.x,y:c1.y-from.y},t1={x:to.x-c2.x,y:to.y-c2.y};
  const n0={x:-t0.y,y:t0.x},n1={x:-t1.y,y:t1.x},det=n0.x*(-n1.y)-n0.y*(-n1.x);
  if(Math.abs(det)<1e-9)return null;
  const a=((to.x-from.x)*(-n1.y)-(to.y-from.y)*(-n1.x))/det,hinge={x:from.x+a*n0.x,y:from.y+a*n0.y};
  const r0=Math.hypot(from.x-hinge.x,from.y-hinge.y),r1=Math.hypot(to.x-hinge.x,to.y-hinge.y),radius=(r0+r1)/2;
  const mid={x:(from.x+3*c1.x+3*c2.x+to.x)/8,y:(from.y+3*c1.y+3*c2.y+to.y)/8},rm=Math.hypot(mid.x-hinge.x,mid.y-hinge.y);
  const sweep=Math.acos(Math.max(-1,Math.min(1,((from.x-hinge.x)*(to.x-hinge.x)+(from.y-hinge.y)*(to.y-hinge.y))/(r0*r1||1))))*180/Math.PI;
  if(!(radius>0)||Math.abs(r0-r1)>radius*.08||Math.abs(rm-radius)>radius*.08||sweep<70||sweep>110)return null;
  return {hinge,start:from,end:to,radius,sweepDegrees:sweep};
}

export function constructionFootprints(ops:{fnArray:number[];argsArray:any[]},codes:Record<string,number>,layers:Map<string,string>,viewport:{transform:number[];width:number;height:number}, layerPattern = /\bKonstruktion\b/i, excludePattern:RegExp|null = alternativeConstructionLayer, hidden?:Set<string>) {
  let transform:Matrix=[...identity],clip:{x:number;y:number;width:number;height:number}|null=null,unsupportedClip=false,pendingClip=false;
  let dashed=false,fillColor:string|null=null,strokeColor:string|null=null;
  const saves:{transform:Matrix;clip:Box|null;unsupportedClip:boolean;dashed:boolean;fillColor:string|null;strokeColor:string|null}[]=[];const marked:(string|null)[]=[];
  const barrierLines:(PlanBarrierLine|null)[]=[];let barrierPoints=0;
  // Single-segment strokes, chained after the walk: CAD exports often draw an arc as many separate lines.
  const segments:{a:Point;b:Point;layerId:string|null;barrier:number;colour:string|null}[]=[];
  // A plan without layers (a flattened print) keeps its straight strokes with their pen colour: walls are drawn as outlines there.
  const collectPens=layers.size===0&&excludePattern!==null;const penSegments:PenSegment[]=[];
  const candidates:PlanFootprint[]=[];const seen=new Set<string>();
  const fillRegions:PlanFillRegion[]=[];
  const doorSwings:PlanDoorSwing[]=[];
  const stats={constructionFilledPaths:0,retainedFootprints:0,omittedSmall:0,omittedUnsupported:0,omittedDuplicate:0,omittedHiddenLayer:0,flattenedCurveFootprints:0,compoundFootprints:0,truncated:false,fillRegionsTruncated:false,barrierLineCount:0,omittedDashedLines:0,barrierLinesTruncated:false};
  const save=()=>saves.push({transform:[...transform],clip,unsupportedClip,dashed,fillColor,strokeColor});
  const restore=()=>{const s=saves.pop();if(s){transform=s.transform;clip=s.clip;unsupportedClip=s.unsupportedClip;dashed=s.dashed;fillColor=s.fillColor;strokeColor=s.strokeColor;}};
  const maxOps=500000;
  for(let i=0;i<Math.min(ops.fnArray.length,maxOps);i++) {
    const op=ops.fnArray[i],a=ops.argsArray[i]??[];
    if(op===codes.save)save();else if(op===codes.restore)restore();
    else if(op===codes.transform)transform=multiplyPlanTransform(transform,a as Matrix);
    else if(op===codes.paintFormXObjectBegin){save();if(a[0])transform=multiplyPlanTransform(transform,a[0]);
      // A form's BBox is a clip. Axis-aligned boxes intersect the tracked clip; anything rotated stays unsupported.
      const bbox=a[1],m=multiplyPlanTransform(viewport.transform as Matrix,transform);
      if(bbox&&bbox.length===4&&Math.abs(m[1])<1e-9&&Math.abs(m[2])<1e-9){const corners=[point(m,bbox[0],bbox[1]),point(m,bbox[2],bbox[3])],b=bounds(corners);
        if(clip){const x=Math.max(b.x,clip.x),y=Math.max(b.y,clip.y);clip={x,y,width:Math.min(b.x+b.width,clip.x+clip.width)-x,height:Math.min(b.y+b.height,clip.y+clip.height)-y};}else clip=b;}
      else unsupportedClip=true;}
    else if(op===codes.paintFormXObjectEnd)restore();
    else if(op===codes.beginMarkedContentProps)marked.push(a[0]==="OC"?(a[1]?.type==="OCG"?a[1].id:"unsupported-optional-content"):null);
    else if(op===codes.beginMarkedContent)marked.push(null);
    else if(op===codes.endMarkedContent)marked.pop();
    else if(op===codes.clip||op===codes.eoClip)pendingClip=true;
    // The fill colour tells construction states apart where one layer holds several (grey existing, yellow demolished).
    else if(op===codes.setStrokeRGBColor)strokeColor=typeof a[0]==="string"?a[0].toLowerCase():null;
    else if(op===codes.setStrokeCMYKColor||op===codes.setStrokeColorN||op===codes.setStrokeColor)strokeColor=null;
    else if(op===codes.setFillRGBColor)fillColor=typeof a[0]==="string"?a[0].toLowerCase():null;
    else if(op===codes.setFillGray)fillColor=typeof a[0]==="number"?`#${Math.round(a[0]*255).toString(16).padStart(2,"0").repeat(3)}`:null;
    else if(op===codes.setFillCMYKColor||op===codes.setFillColorN||op===codes.setFillColor)fillColor=null;
    else if(op===codes.setDash)dashed=Array.isArray(a[0])?a[0].some((v:number)=>v>0):Boolean(a[0]?.length);
    else if(op===codes.constructPath) {
      const matrix=multiplyPlanTransform(viewport.transform as Matrix,transform);
      const clipPolygon=pendingClip?polygonFromPath(a[1]?.[0]??[],matrix):null;
      if(pendingClip){
        pendingClip=false;
        if(clipPolygon?.length===4){const b=bounds(clipPolygon);const rectangular=clipPolygon.every(p=>(Math.abs(p.x-b.x)<1e-4||Math.abs(p.x-b.x-b.width)<1e-4)&&(Math.abs(p.y-b.y)<1e-4||Math.abs(p.y-b.y-b.height)<1e-4));
          if(rectangular){if(clip){const x=Math.max(b.x,clip.x),y=Math.max(b.y,clip.y);clip={x,y,width:Math.min(b.x+b.width,clip.x+clip.width)-x,height:Math.min(b.y+b.height,clip.y+clip.height)-y};}else clip=b;}else unsupportedClip=true;
        }else unsupportedClip=true;
      }
      const layerId=[...marked].reverse().find(id=>id!==null);
      const fillOps=[codes.fill,codes.eoFill,codes.fillStroke,codes.eoFillStroke,codes.closeFillStroke,codes.closeEOFillStroke];
      const strokeOps=[codes.stroke,codes.closeStroke,codes.fillStroke,codes.eoFillStroke,codes.closeFillStroke,codes.closeEOFillStroke];
      const evenOdd=[codes.eoFill,codes.eoFillStroke,codes.closeEOFillStroke].includes(a[0]);
      if(layerId&&/Füllflächen/i.test(layers.get(layerId)??"")&&!unsupportedClip&&fillOps.includes(a[0])) {
        const rings=ringsFromPath(a[1]?.[0]??[],matrix)?.rings;
        if(rings&&rings.every(r=>r.every(p=>p.x>=0&&p.y>=0&&p.x<=viewport.width&&p.y<=viewport.height&&(!clip||(p.x>=clip.x&&p.y>=clip.y&&p.x<=clip.x+clip.width&&p.y<=clip.y+clip.height))))) {
          const normalized=rings.map(r=>r.map(p=>({x:p.x/viewport.width,y:p.y/viewport.height})));
          const key=createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
          if(!fillRegions.some(r=>r.sourceKey===key)){if(fillRegions.length<100)fillRegions.push({sourceKey:key,layerId,layerName:layers.get(layerId)!,rings:normalized,fillRule:evenOdd?"evenodd":"nonzero"});else stats.fillRegionsTruncated=true;}
        }
      }
      const layerName=layers.get(layerId??"")??"";
      // Door swing arcs (Bézier curves or short polylines) are drawing evidence on any visible
      // layer except alternative construction states; they never become geometry claims themselves.
      const walked=strokeOps.includes(a[0])?walkPath(a[1]?.[0]??[],matrix):null;
      const arcRings=new Set<number>(),pendingSegments=new Map<number,number>();
      if(walked&&(!layerId||hidden?.has(layerId)!==true)&&!excludePattern?.test(layerName)&&doorSwings.length<1000) {
        const arcs=walked.rings.map((ring,r)=>{
          const curves=walked.curves.filter(c=>c.ring===r);
          const swing=curves.length?curves.map(doorSwingFromCurve).find(Boolean)??null:walked.closed[r]?null:doorSwingFromPolyline(ring);
          // A subpath that is only the arc (no leaf or wall segments) is not a barrier.
          if(swing&&(!curves.length||ring.length===curves.length*8+1))arcRings.add(r);
          if(!swing&&!curves.length&&!walked.closed[r]&&ring.length===2&&segments.length<100000)pendingSegments.set(r,segments.push({a:ring[0],b:ring[1],layerId:layerId??null,barrier:-1,colour:strokeColor})-1);
          return swing;
        });
        for(const swing of arcs){
          if(!swing||[swing.hinge,swing.start,swing.end].some(p=>p.x<0||p.y<0||p.x>viewport.width||p.y>viewport.height))continue;
          const norm=(p:Point)=>({x:p.x/viewport.width,y:p.y/viewport.height});
          const hinge=norm(swing.hinge),key=createHash("sha256").update(`${hinge.x.toFixed(6)},${hinge.y.toFixed(6)},${swing.radius.toFixed(3)}`).digest("hex");
          if(!doorSwings.some(d=>d.sourceKey===`door-swing:${key}`))doorSwings.push({sourceKey:`door-swing:${key}`,layerId:layerId??null,layerName:layerId?layers.get(layerId)??null:null,strokeColor,
            hinge,start:norm(swing.start),end:norm(swing.end),radius:swing.radius/viewport.height,sweepDegrees:swing.sweepDegrees});}
      }
      if(collectPens&&walked&&!dashed&&!unsupportedClip&&penSegments.length<200000)for(const [r,ring] of walked.rings.entries()){
        if(walked.curves.some(c=>c.ring===r))continue;
        const points=walked.closed[r]?[...ring,ring[0]]:ring;
        for(let k=0;k+1<points.length;k++){const p=points[k],q=points[k+1];
          if(p.x<0||p.y<0||p.x>viewport.width||p.y>viewport.height||q.x<0||q.y<0||q.x>viewport.width||q.y>viewport.height)continue;
          penSegments.push({a:{x:p.x/viewport.width,y:p.y/viewport.height},b:{x:q.x/viewport.width,y:q.y/viewport.height},colour:strokeColor});}
      }
      // Solid strokes on the primary construction layer outline walls, partitions, door leaves and
      // windows on many CAD exports. They are kept as barrier lines; dashed strokes mean overhead or hidden.
      if(layerId&&layerPattern.test(layerName)&&!excludePattern?.test(layerName)&&hidden?.has(layerId)!==true&&!unsupportedClip&&strokeOps.includes(a[0])) {
        if(dashed)stats.omittedDashedLines++;
        // Swing arcs are excluded: they would wall off the swept area as a separate region.
        else for(const [r,ring] of (walked?.rings??[]).entries()){
          if(arcRings.has(r)||ring.length<2||ring.some(p=>p.x<0||p.y<0||p.x>viewport.width||p.y>viewport.height))continue;
          if(barrierPoints+ring.length>200000){stats.barrierLinesTruncated=true;break;}
          barrierPoints+=ring.length;
          if(pendingSegments.has(r))segments[pendingSegments.get(r)!].barrier=barrierLines.length;
          const closed=[codes.closeStroke,codes.closeFillStroke,codes.closeEOFillStroke].includes(a[0])||walked!.closed[r];
          barrierLines.push({layerId,points:ring.map(p=>({x:p.x/viewport.width,y:p.y/viewport.height})),closed});
        }
      }
      if(!layerId||!layerPattern.test(layerName)||excludePattern?.test(layerName)||!fillOps.includes(a[0]))continue;
      stats.constructionFilledPaths++;
      if(hidden?.has(layerId)){stats.omittedHiddenLayer++;continue;}
      const parsed=ringsFromPath(a[1]?.[0]??[],matrix);
      if(!parsed||unsupportedClip){stats.omittedUnsupported++;continue;}
      const rings=parsed.rings.filter(r=>ringArea(r)>0).sort((x,y)=>ringArea(y)-ringArea(x));
      if(!rings.length){stats.omittedSmall++;continue;}
      const polygon=rings[0],all=rings.flat(),b=bounds(all);
      // Upper bound of the filled area; the topology raster applies the exact fill rule.
      const area=rings.reduce((s,r)=>s+ringArea(r),0);
      if(b.width<.5||b.height<.5||area<1){stats.omittedSmall++;continue;}
      if(b.x<0||b.y<0||b.x+b.width>viewport.width||b.y+b.height>viewport.height||area>viewport.width*viewport.height*.25||
        (clip&&(b.x<clip.x-1e-4||b.y<clip.y-1e-4||b.x+b.width>clip.x+clip.width+1e-4||b.y+b.height>clip.y+clip.height+1e-4))){stats.omittedUnsupported++;continue;}
      const normalize=(r:Point[])=>r.map(p=>({x:p.x/viewport.width,y:p.y/viewport.height}));
      const normalized=normalize(polygon),normalizedRings=rings.map(normalize);
      const canonical=(ring:Point[])=>{const ordered=ring.map(p=>`${p.x.toFixed(7)},${p.y.toFixed(7)}`);return [ordered,[...ordered].reverse()].flatMap(order=>order.map((_,j)=>[...order.slice(j),...order.slice(0,j)].join(";"))).sort()[0];};
      const key=createHash("sha256").update(`${layerId}:${normalizedRings.map(canonical).sort().join("|")}`).digest("hex");
      if(seen.has(key)){stats.omittedDuplicate++;continue;}seen.add(key);
      if(candidates.length>=500){stats.truncated=true;continue;}
      if(parsed.curved)stats.flattenedCurveFootprints++;if(rings.length>1)stats.compoundFootprints++;
      candidates.push({sourceKey:`footprint:${key}`,entityType:"element",name:`Construction footprint ${candidates.length+1}`,layerId,layerName,quote:"Closed filled source path",...(fillColor?{fillColor}:{}),
        geometry:{quality:"footprint",coordinateSpace:"normalized-page",polygon:normalized,...(rings.length>1?{rings:normalizedRings,fillRule:evenOdd?"evenodd" as const:"nonzero" as const}:{}),
          ...(parsed.curved?{curvesFlattened:true as const}:{}),planRegion:bounds(normalizedRings.flat()),limitations}});
    }
  }
  stats.truncated ||= ops.fnArray.length>maxOps;stats.retainedFootprints=candidates.length;
  for(const chain of segmentChains(segments)){
    if(doorSwings.length>=1000)break;
    const swing=doorSwingFromPolyline(chain.points);if(!swing||[swing.hinge,swing.start,swing.end].some(p=>p.x<0||p.y<0||p.x>viewport.width||p.y>viewport.height))continue;
    for(const index of chain.members)if(segments[index].barrier>=0)barrierLines[segments[index].barrier]=null;
    const layerId=segments[chain.members[0]].layerId;
    const norm=(p:Point)=>({x:p.x/viewport.width,y:p.y/viewport.height});
    const hinge=norm(swing.hinge),key=createHash("sha256").update(`${hinge.x.toFixed(6)},${hinge.y.toFixed(6)},${swing.radius.toFixed(3)}`).digest("hex");
    if(!doorSwings.some(d=>d.sourceKey===`door-swing:${key}`))doorSwings.push({sourceKey:`door-swing:${key}`,layerId,layerName:layerId?layers.get(layerId)??null:null,strokeColor:segments[chain.members[0]].colour,
      hinge,start:norm(swing.start),end:norm(swing.end),radius:swing.radius/viewport.height,sweepDegrees:swing.sweepDegrees});
  }
  const barriers=barrierLines.filter((line):line is PlanBarrierLine=>line!==null);
  stats.barrierLineCount=barriers.length;
  return {candidates,fillRegions,doorSwings,barrierLines:barriers,penSegments,...stats,limitations};
}

export async function extractPlanFootprints(path:string,pageNumber:number,signal:AbortSignal) {
  // Parser memory budget only; the original upload remains unrestricted and available.
  if((await stat(path)).size>64*1024*1024)throw new Error("Native geometry parser memory budget exceeded");
  const {getDocument,OPS}=await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task=getDocument({data:new Uint8Array(await readFile(path)),verbosity:0,useSystemFonts:false});
  const abort=()=>{void task.destroy().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
  try{signal.throwIfAborted();const pdf=await task.promise;const page=await pdf.getPage(pageNumber);const config=await pdf.getOptionalContentConfig();
    const layers=new Map<string,string>(),hidden=new Set<string>();for(const [id,group]of config){if(typeof group.name==="string")layers.set(id,group.name.replace(/\0/g,"\\u0000"));if(group.visible===false)hidden.add(id);}
    const ops=await page.getOperatorList();signal.throwIfAborted();const viewport=page.getViewport({scale:1});return { ...constructionFootprints(ops,OPS,layers,viewport,undefined,undefined,hidden),pageAspectRatio:viewport.width/viewport.height,pageWidthPoints:viewport.width,pageHeightPoints:viewport.height,
      supplementaryBarriers: constructionFootprints(ops,OPS,layers,viewport,alternativeConstructionLayer,null,hidden).candidates };
  }finally{signal.removeEventListener("abort",abort);await task.destroy();}
}
