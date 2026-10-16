import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

type Matrix = [number,number,number,number,number,number];
type Point = {x:number;y:number};
type Box = {x:number;y:number;width:number;height:number};
export type PlanFillRegion = {sourceKey:string;layerId:string;layerName:string;rings:Point[][];fillRule:"evenodd"|"nonzero"};
export type PlanFootprint = {sourceKey:string;entityType:"element";name:string;layerId:string;layerName:string;quote:string;
  geometry:{quality:"footprint";coordinateSpace:"normalized-page";polygon:Point[];planRegion:{x:number;y:number;width:number;height:number};limitations:string}};
const identity:Matrix=[1,0,0,1,0,0];
export const multiplyPlanTransform=(a:Matrix,b:Matrix):Matrix=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
const point=(m:Matrix,x:number,y:number):Point=>({x:m[0]*x+m[2]*y+m[4],y:m[1]*x+m[3]*y+m[5]});
const same=(a:Point,b:Point)=>Math.abs(a.x-b.x)<1e-5&&Math.abs(a.y-b.y)<1e-5;
const bounds=(p:Point[])=>{const x=Math.min(...p.map(p=>p.x)),y=Math.min(...p.map(p=>p.y));return {x,y,width:Math.max(...p.map(p=>p.x))-x,height:Math.max(...p.map(p=>p.y))-y};};
const limitations="Observed closed filled PDF path in the construction layer; not a verified wall, material, construction state, physical measurement or room boundary. Open paths, curves, compound holes and unsupported clipping are omitted.";

/** PDF.js 5.7 DrawOPS numeric layout, pinned in package.json. Curves/compound fills fail closed. */
function polygonFromPath(path:ArrayLike<number>,transform:Matrix):Point[]|null {
  const result:Point[]=[];let closed=false;
  for(let i=0;i<path.length;){const op=path[i++];if(op===0){if(result.length)return null;result.push(point(transform,path[i++],path[i++]));}
    else if(op===1)result.push(point(transform,path[i++],path[i++]));else if(op===4)closed=true;else return null;
    if(result.length>64)return null;
  }
  if(result.length<3||!result.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)))return null;
  if(same(result[0],result.at(-1)!)){result.pop();closed=true;}
  return closed&&result.length>=3?result:null;
}

function ringsFromPath(path:ArrayLike<number>,transform:Matrix):Point[][]|null {
  const rings:Point[][]=[];let ring:Point[]=[];
  const finish=()=>{if(ring.length<3)return false;if(same(ring[0],ring.at(-1)!))ring.pop();rings.push(ring);ring=[];return true;};
  for(let i=0;i<path.length;){const op=path[i++];if(op===0){if(ring.length&&!finish())return null;ring.push(point(transform,path[i++],path[i++]));}
    else if(op===1)ring.push(point(transform,path[i++],path[i++]));else if(op===4){if(!finish())return null;}else return null;
    if(rings.length>500||ring.length>5000)return null;
  }
  if(ring.length&&!finish())return null;
  return rings.length&&rings.every(r=>r.length>=3&&r.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)))?rings:null;
}

export function constructionFootprints(ops:{fnArray:number[];argsArray:any[]},codes:Record<string,number>,layers:Map<string,string>,viewport:{transform:number[];width:number;height:number}, layerPattern = /\bKonstruktion\b/i) {
  let transform:Matrix=[...identity],clip:{x:number;y:number;width:number;height:number}|null=null,unsupportedClip=false,pendingClip=false;
  const saves:{transform:Matrix;clip:Box|null;unsupportedClip:boolean}[]=[];const marked:(string|null)[]=[];
  const candidates:PlanFootprint[]=[];const seen=new Set<string>();
  const fillRegions:PlanFillRegion[]=[];
  const stats={constructionFilledPaths:0,retainedFootprints:0,omittedSmall:0,omittedUnsupported:0,omittedDuplicate:0,truncated:false};
  const save=()=>saves.push({transform:[...transform],clip,unsupportedClip});
  const restore=()=>{const s=saves.pop();if(s){transform=s.transform;clip=s.clip;unsupportedClip=s.unsupportedClip;}};
  const maxOps=300000;
  for(let i=0;i<Math.min(ops.fnArray.length,maxOps);i++) {
    const op=ops.fnArray[i],a=ops.argsArray[i]??[];
    if(op===codes.save)save();else if(op===codes.restore)restore();
    else if(op===codes.transform)transform=multiplyPlanTransform(transform,a as Matrix);
    else if(op===codes.paintFormXObjectBegin){save();if(a[0])transform=multiplyPlanTransform(transform,a[0]);unsupportedClip=true;}
    else if(op===codes.paintFormXObjectEnd)restore();
    else if(op===codes.beginMarkedContentProps)marked.push(a[0]==="OC"?(a[1]?.type==="OCG"?a[1].id:"unsupported-optional-content"):null);
    else if(op===codes.beginMarkedContent)marked.push(null);
    else if(op===codes.endMarkedContent)marked.pop();
    else if(op===codes.clip||op===codes.eoClip)pendingClip=true;
    else if(op===codes.constructPath) {
      const matrix=multiplyPlanTransform(viewport.transform as Matrix,transform);
      const polygon=polygonFromPath(a[1]?.[0]??[],matrix);
      if(pendingClip){
        pendingClip=false;
        if(polygon?.length===4){const b=bounds(polygon);const rectangular=polygon.every(p=>(Math.abs(p.x-b.x)<1e-4||Math.abs(p.x-b.x-b.width)<1e-4)&&(Math.abs(p.y-b.y)<1e-4||Math.abs(p.y-b.y-b.height)<1e-4));
          if(rectangular){if(clip){const x=Math.max(b.x,clip.x),y=Math.max(b.y,clip.y);clip={x,y,width:Math.min(b.x+b.width,clip.x+clip.width)-x,height:Math.min(b.y+b.height,clip.y+clip.height)-y};}else clip=b;}else unsupportedClip=true;
        }else unsupportedClip=true;
      }
      const layerId=[...marked].reverse().find(id=>id!==null);
      if(layerId&&/Füllflächen/i.test(layers.get(layerId)??"")&&!unsupportedClip&&[codes.fill,codes.eoFill,codes.fillStroke,codes.eoFillStroke,codes.closeFillStroke,codes.closeEOFillStroke].includes(a[0])) {
        const rings=ringsFromPath(a[1]?.[0]??[],matrix);
        if(rings&&rings.every(r=>r.every(p=>p.x>=0&&p.y>=0&&p.x<=viewport.width&&p.y<=viewport.height&&(!clip||(p.x>=clip.x&&p.y>=clip.y&&p.x<=clip.x+clip.width&&p.y<=clip.y+clip.height))))) {
          const normalized=rings.map(r=>r.map(p=>({x:p.x/viewport.width,y:p.y/viewport.height})));
          const key=createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
          if(!fillRegions.some(r=>r.sourceKey===key)&&fillRegions.length<100)fillRegions.push({sourceKey:key,layerId,layerName:layers.get(layerId)!,rings:normalized,fillRule:[codes.eoFill,codes.eoFillStroke,codes.closeEOFillStroke].includes(a[0])?"evenodd":"nonzero"});
        }
      }
      if(!layerId||!layerPattern.test(layers.get(layerId)??"")||![codes.fill,codes.eoFill,codes.fillStroke,codes.eoFillStroke,codes.closeFillStroke,codes.closeEOFillStroke].includes(a[0]))continue;
      stats.constructionFilledPaths++;
      if(!polygon||unsupportedClip){stats.omittedUnsupported++;continue;}
      const b=bounds(polygon),area=Math.abs(polygon.reduce((sum,p,j)=>{const q=polygon[(j+1)%polygon.length];return sum+p.x*q.y-q.x*p.y;},0))/2;
      if(b.width<.5||b.height<.5||area<1){stats.omittedSmall++;continue;}
      if(b.x<0||b.y<0||b.x+b.width>viewport.width||b.y+b.height>viewport.height||area>viewport.width*viewport.height*.25||
        (clip&&(b.x<clip.x-1e-4||b.y<clip.y-1e-4||b.x+b.width>clip.x+clip.width+1e-4||b.y+b.height>clip.y+clip.height+1e-4))){stats.omittedUnsupported++;continue;}
      const normalized=polygon.map(p=>({x:p.x/viewport.width,y:p.y/viewport.height}));
      const ordered=normalized.map(p=>`${p.x.toFixed(7)},${p.y.toFixed(7)}`);const rotations=[ordered,[...ordered].reverse()].flatMap(order=>order.map((_,j)=>[...order.slice(j),...order.slice(0,j)].join(";"))).sort();
      const key=createHash("sha256").update(`${layerId}:${rotations[0]}`).digest("hex");
      if(seen.has(key)){stats.omittedDuplicate++;continue;}seen.add(key);
      if(candidates.length>=500){stats.truncated=true;continue;}
      candidates.push({sourceKey:`footprint:${key}`,entityType:"element",name:`Construction footprint ${candidates.length+1}`,layerId,layerName:layers.get(layerId)!,quote:"Closed filled source path",
        geometry:{quality:"footprint",coordinateSpace:"normalized-page",polygon:normalized,planRegion:bounds(normalized),limitations}});
    }
  }
  stats.truncated ||= ops.fnArray.length>maxOps;stats.retainedFootprints=candidates.length;
  return {candidates,fillRegions,...stats,limitations};
}

export async function extractPlanFootprints(path:string,pageNumber:number,signal:AbortSignal) {
  // Parser memory budget only; the original upload remains unrestricted and available.
  if((await stat(path)).size>64*1024*1024)throw new Error("Native geometry parser memory budget exceeded");
  const {getDocument,OPS}=await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task=getDocument({data:new Uint8Array(await readFile(path)),verbosity:0,useSystemFonts:false});
  const abort=()=>{void task.destroy().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
  try{signal.throwIfAborted();const pdf=await task.promise;const page=await pdf.getPage(pageNumber);const config=await pdf.getOptionalContentConfig();
    const layers=new Map<string,string>();for(const [id,group]of config)if(typeof group.name==="string")layers.set(id,group.name.replace(/\0/g,"\\u0000"));
    const ops=await page.getOperatorList();signal.throwIfAborted();const viewport=page.getViewport({scale:1});return { ...constructionFootprints(ops,OPS,layers,viewport),pageAspectRatio:viewport.width/viewport.height,pageWidthPoints:viewport.width,pageHeightPoints:viewport.height,
      supplementaryBarriers: constructionFootprints(ops,OPS,layers,page.getViewport({scale:1}), /Abbruch|Bestand/i).candidates };
  }finally{signal.removeEventListener("abort",abort);await task.destroy();}
}
