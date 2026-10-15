import { createHash } from "node:crypto";
import type { PlanFootprint, PlanFillRegion } from "./plan-footprints";
import type { PlanLabel, PlanWord } from "./plan-extraction";

type Point = { x: number; y: number };
const box = (points: Point[]) => {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
};
const hash = (keys: string[]) => createHash("sha256").update([...keys].sort().join("|")).digest("hex");

/** Printed areas remain observations: proximity is not a verified measurement or room use. */
export function printedAreaObservations(labels: PlanLabel[], words: PlanWord[]) {
  const ambiguous = new Set<string>();
  const observations = new Map<string, { value: number; unit: "m²"; quote: string; planRegion: ReturnType<typeof box>; provenance: "inferred"; status: "unreviewed" }>();
  for (const word of words) {
    if (!/^\d{1,4}[.,]\d{1,2}(?:\s*m[²2])?$/.test(word.text)) continue;
    const units = words.filter(w => /^m[²2]$/.test(w.text) && Math.abs(w.y - word.y) < word.height * .6 && w.x >= word.x + word.width && w.x - word.x - word.width < word.height * 2);
    if (!/m[²2]$/.test(word.text) && units.length !== 1) continue;
    if(words.some(w=>/^(?:Wfl\.?|GF:?|\(GF:?|zzgl\.?)$/i.test(w.text)&&Math.abs(w.y-word.y)<word.height*.7&&w.x<word.x&&word.x-w.x-w.width<word.height*4))continue;
    const ranked = labels.map(label => {
      const r = label.geometry.planRegion;
      const height=Math.max(word.height,r.height),aligned=Math.abs(r.x-word.x)<height*1.5&&word.y>=r.y+r.height*.5&&word.y-r.y<height*3;
      return { label, distance: aligned?Math.hypot((r.x - word.x), (r.y - word.y)) / height:Infinity };
    }).filter(r => r.distance < 4).sort((a, b) => a.distance - b.distance);
    if (!ranked.length || (ranked[1] && ranked[1].distance - ranked[0].distance < 1)) continue;
    const key = ranked[0].label.sourceKey;
    // More than one nearby area is ambiguous; do not pick a convenient one.
    if (observations.has(key)) { observations.delete(key); ambiguous.add(key); continue; }
    if (ambiguous.has(key)) continue;
    const last = units[0] ?? word;
    observations.set(key, { value: Number.parseFloat(word.text.replace(",", ".")), unit: "m²", quote: word.text + (units[0] ? ` ${units[0].text}` : ""), planRegion: { x: word.x, y: word.y, width: last.x + last.width - word.x, height: Math.max(word.height, last.height) }, provenance: "inferred", status: "unreviewed" });
  }
  return observations;
}

/** Conservative bounded raster topology. Only source polygons are barriers; exterior and
 * shared components remain anchors. No artificial nearest-label partitions or door claims. */
export function inferPlanTopology(labels: PlanLabel[], footprints: PlanFootprint[], words: PlanWord[] = [], resolution = 1200, supplementary: PlanFootprint[] = [], closeRadius = 0, fillRegions: PlanFillRegion[] = [], pageAspectRatio = 1) {
  const n = Math.max(64, Math.min(1600, Math.floor(resolution))), size = n * n;
  const wall = new Uint8Array(size), owner = new Int32Array(size).fill(-1);
  const parent = footprints.map((_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a: number, b: number) => { parent[root(a)] = root(b); };
  // Scanline fill preserves source concavity; its grid approximation is never called exact.
  [...footprints, ...supplementary].forEach((footprint, index) => {
    const id = index < footprints.length ? index : -1;
    const polygon = footprint.geometry.polygon;
    const r = footprint.geometry.planRegion;
    for (let y = Math.max(0, Math.floor(r.y * n)); y <= Math.min(n - 1, Math.ceil((r.y + r.height) * n)); y++) {
      const py = (y + .5) / n, intersections: number[] = [];
      for (let j = 0; j < polygon.length; j++) {
        const a = polygon[j], b = polygon[(j + 1) % polygon.length];
        if ((a.y > py) !== (b.y > py)) intersections.push((a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y)) * n);
      }
      intersections.sort((a, b) => a - b);
      for (let j = 0; j + 1 < intersections.length; j += 2) for (let x = Math.max(0, Math.ceil(intersections[j] - .5)); x <= Math.min(n - 1, Math.floor(intersections[j + 1] - .5)); x++) {
        const p = y * n + x;
        if (id >= 0 && owner[p] >= 0) join(id, owner[p]);
        wall[p] = 1; if (id >= 0) owner[p] = id;
      }
    }
  });
  for (let p = 0; p < size; p++) if (owner[p] >= 0) {
    if (p % n && owner[p - 1] >= 0) join(owner[p], owner[p - 1]);
    if (p >= n && owner[p - n] >= 0) join(owner[p], owner[p - n]);
  }
  const groups = new Map<number, PlanFootprint[]>();
  footprints.forEach((f, i) => { const key = root(i); groups.set(key, [...(groups.get(key) ?? []), f]); });
  const assemblies = [...groups.values()].map((members, i) => ({
    sourceKey: `assembly:${hash(members.map(m => m.sourceKey))}`, entityType: "element" as const,
    name: `Construction-fragment assembly ${i + 1}`, quote: `${members.length} connected closed source paths`,
    layerId: members[0].layerId, layerName: members[0].layerName,
    geometry: { quality: "assembly" as const, coordinateSpace: "normalized-page" as const,
      polygons: members.map(m => m.geometry.polygon), sourceFootprintKeys: members.map(m => m.sourceKey),
      planRegion: box(members.flatMap(m => m.geometry.polygon)),
      limitations: `Connectivity inferred on a ${n}×${n} grid (one-cell tolerance); member polygons are exact source footprints. Not a verified wall, material, state or physical measurement.` },
  }));
  const supportedFills = fillRegions.filter(f => f.fillRule === "evenodd");
  if (supportedFills.length) {
    const interior = new Uint8Array(size);
    for (const fill of supportedFills) {
      const r = box(fill.rings.flat());
      for (let y = Math.max(0, Math.floor(r.y * n)); y <= Math.min(n - 1, Math.ceil((r.y + r.height) * n)); y++) {
        const py = (y + .5) / n, crossings: number[] = [];
        for (const ring of fill.rings) for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          if ((a.y > py) !== (b.y > py)) crossings.push((a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y)) * n);
        }
        crossings.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crossings.length; i += 2) for (let x = Math.max(0, Math.ceil(crossings[i] - .5)); x <= Math.min(n - 1, Math.floor(crossings[i + 1] - .5)); x++) interior[y * n + x] = 1;
      }
    }
    for (let p = 0; p < size; p++) if (!interior[p]) wall[p] = 1;
  }
  // Optional morphological closing joins short gaps only, with the approximation recorded.
  // Sliding-window separable max/min keeps processing linear in page pixel count.
  if (closeRadius > 0) {
    const radius = Math.min(12, Math.max(1, Math.floor(closeRadius)));
    const pass = (input: Uint8Array, horizontal: boolean, dilate: boolean) => {
      const output = new Uint8Array(size);
      for (let line = 0; line < n; line++) {
        let sum = 0;
        const at = (p: number) => horizontal ? line * n + p : p * n + line;
        for (let p = 0; p <= radius; p++) sum += input[at(p)];
        for (let p = 0; p < n; p++) {
          output[at(p)] = dilate ? Number(sum > 0) : Number(sum === Math.min(n - 1, p + radius) - Math.max(0, p - radius) + 1);
          if (p - radius >= 0) sum -= input[at(p - radius)];
          if (p + radius + 1 < n) sum += input[at(p + radius + 1)];
        }
      }
      return output;
    };
    wall.set(pass(pass(pass(pass(wall, true, true), false, true), true, false), false, false));
  }
  const component = new Int32Array(size).fill(-1), queue = new Int32Array(size);
  const regions: { count: number; exterior: boolean; minX: number; minY: number; maxX: number; maxY: number; seeds: number[] }[] = [];
  for (let start = 0; start < size; start++) if (!wall[start] && component[start] < 0) {
    const id = regions.length, region = { count: 0, exterior: false, minX: n, minY: n, maxX: 0, maxY: 0, seeds: [] as number[] };
    let head = 0, tail = 1; queue[0] = start; component[start] = id;
    while (head < tail) {
      const p = queue[head++], x = p % n, y = Math.floor(p / n);
      region.count++; region.minX = Math.min(region.minX, x); region.maxX = Math.max(region.maxX, x); region.minY = Math.min(region.minY, y); region.maxY = Math.max(region.maxY, y);
      region.exterior ||= x === 0 || y === 0 || x === n - 1 || y === n - 1;
      const next = [x > 0 ? p - 1 : -1, x < n - 1 ? p + 1 : -1, y > 0 ? p - n : -1, y < n - 1 ? p + n : -1];
      for (const q of next) if (q >= 0 && !wall[q] && component[q] < 0) { component[q] = id; queue[tail++] = q; }
    }
    regions.push(region);
  }
  const seedRegions = labels.map((label, i) => {
    const r = label.geometry.planRegion, x = Math.min(n - 1, Math.floor((r.x + r.width / 2) * n)), y = Math.min(n - 1, Math.floor((r.y + r.height / 2) * n));
    const id = component[y * n + x]; if (id >= 0) regions[id].seeds.push(i); return id;
  });
  // Multi-source geodesic partition stays inside each source-filled connected component
  // and cannot cross retained walls. Its equal-distance seams are explicitly inferred.
  const partition = new Int32Array(size).fill(-1), distances = new Float64Array(size).fill(Infinity);
  const heap:{p:number;distance:number}[]=[];
  const push=(entry:{p:number;distance:number})=>{let i=heap.length;heap.push(entry);while(i>0){const parent=(i-1)>>1;if(heap[parent].distance<=entry.distance)break;heap[i]=heap[parent];i=parent;}heap[i]=entry;};
  const pop=()=>{const result=heap[0],last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].distance<heap[child].distance)child++;if(heap[child].distance>=last.distance)break;heap[i]=heap[child];i=child;}heap[i]=last;}return result;};
  labels.forEach((label,i)=>{
    if(seedRegions[i]<0||regions[seedRegions[i]].exterior)return;
    const r=label.geometry.planRegion,x=Math.min(n-1,Math.floor((r.x+r.width/2)*n)),y=Math.min(n-1,Math.floor((r.y+r.height/2)*n)),p=y*n+x;
    if(partition[p]>=0)return;partition[p]=i;distances[p]=0;push({p,distance:0});
  });
  const horizontalCost=Number.isFinite(pageAspectRatio)&&pageAspectRatio>0?pageAspectRatio:1;
  while(heap.length){const {p,distance}=pop();if(distance!==distances[p])continue;const x=p%n,y=Math.floor(p/n);
    for(const q of [x>0?p-1:-1,x<n-1?p+1:-1,y>0?p-n:-1,y<n-1?p+n:-1])if(q>=0&&component[q]===component[p]){const next=distance+(Math.abs(q-p)===1?horizontalCost:1);if(next<distances[q]){distances[q]=next;partition[q]=partition[p];push({p:q,distance:next});}}
  }
  const observations = printedAreaObservations(labels, words);
  const units = words.flatMap(word => {
    if (/^WE\s*\d{1,4}$/i.test(word.text)) return [{...word,text:word.text.replace(/\s+/g," ")}];
    if (!/^WE$/i.test(word.text)) return [];
    const numbers = words.filter(w => /^\d{1,4}$/.test(w.text) && Math.abs(w.y-word.y)<word.height*.5 && w.x>word.x && w.x-word.x-word.width<word.height*2);
    return numbers.length===1?[{...word,text:`WE ${numbers[0].text}`,width:numbers[0].x+numbers[0].width-word.x}]:[];
  });
  const unitForFill = new Map(supportedFills.map(f => [f.sourceKey, [...new Set(units.filter(u => insideFill({x:u.x+u.width/2,y:u.y+u.height/2},f)).map(u=>u.text))]]));
  const counts = { enclosed: 0, exterior: 0, conflicting: 0, obstructed: 0, outside_source_fill:0 };
  const rooms = labels.map((label, i) => {
    const lr=label.geometry.planRegion;
    const containingFills=supportedFills.filter(f=>insideFill({x:lr.x+lr.width/2,y:lr.y+lr.height/2},f));
    const groupLabels=[...new Set(containingFills.flatMap(f=>unitForFill.get(f.sourceKey)??[]))];
    const id = seedRegions[i], region = id >= 0 ? regions[id] : null;
    const status = supportedFills.length&&!containingFills.length?"outside_source_fill":!region ? "obstructed" : region.exterior ? "exterior" : region.seeds.length !== 1 ? "conflicting" : "enclosed";
    counts[status]++;
    // A bounding box alone must never masquerade as the traced room boundary.
    const contour = status === "enclosed" ? traceRegion(component, n, id, region!) : status === "conflicting" ? traceRegion(partition,n,i,region!) : null;
    const polygon=contour?.polygon;
    return { ...label, sourceKey:`topology-v3:${label.sourceKey}`, geometry: { ...label.geometry,
      ...(polygon ? { quality: status==="conflicting"?"approximate_partition" as const:"enclosed_region" as const, polygon, holes:contour?.holes, planRegion: box(polygon), labelRegion: label.geometry.planRegion } : {}),
      topology: { status, componentId:id>=0?id:null, method:status==="conflicting"?"wall_constrained_geodesic_partition":"enclosed_component", competingSourceKeys: region?.seeds.filter(j => j !== i).map(j => `topology-v3:${labels[j].sourceKey}`) ?? [], resolution: n, closeRadius,pageAspectRatio:horizontalCost },
      sourceFillEvidence:containingFills.map(f=>({sourceKey:f.sourceKey,layerId:f.layerId,layerName:f.layerName})),
      ...(containingFills.length===1&&groupLabels.length===1?{groupLabel:groupLabels[0],groupSourceKey:containingFills[0].sourceKey,
        groupObservation:units.filter(u=>u.text===groupLabels[0]&&insideFill({x:u.x+u.width/2,y:u.y+u.height/2},containingFills[0])).map(u=>({quote:u.text,planRegion:{x:u.x,y:u.y,width:u.width,height:u.height},provenance:"inferred"}))}:{}),
      ...(observations.has(label.sourceKey) ? { printedArea: observations.get(label.sourceKey) } : {}),
      limitations: polygon ? `Approximate raster region seeded by source text, constrained by construction/existing-layer fills and source fill outlines. ${status==="conflicting"?"Shared free space is divided by geodesic distance: partition seams are inferred, not source walls. ":""}Not a verified room boundary, physical area or opening; reviewer must confirm. Source holes are preserved.` : `Source label only: ${status} free-space region. Room boundary is unresolved. Printed areas, if present, are unreviewed proximity associations.` } };
  });
  return { rooms, assemblies, coverage: { ...counts, approximateRegionCount:rooms.filter(r=>r.geometry.polygon).length, unresolvedRegionCount:rooms.filter(r=>!r.geometry.polygon).length,labelCount: labels.length, groupedRoomCount:rooms.filter(r=>r.geometry.groupLabel).length, fillRegionCount:supportedFills.length, assemblyCount: assemblies.length, sourceFootprintCount: footprints.length, supplementaryBarrierCount: supplementary.length, printedAreaCount: observations.size, resolution: n, closeRadius,
    relationships: "Not established: source fills alone do not distinguish doors, openings or traversable adjacency.",
    limitations: "Source construction/existing-layer fills and even-odd filled regions constrain approximate topology. Shared components use inferred geodesic partitions; this does not establish doors or room adjacency. Missing strokes and open gaps remain uncertainty; outside/obstructed seeds remain anchors." } };
}

function insideFill(p:Point,fill:PlanFillRegion) {
  let inside=false;
  for(const ring of fill.rings)for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}
  return inside;
}

function traceRegion(grid: Int32Array, n: number, id: number, region: { minX: number; minY: number; maxX: number; maxY: number }) {
  const edges = new Map<number, number[]>(), key = (x: number, y: number) => y * (n + 1) + x;
  const add = (a: number, b: number) => edges.set(a, [...(edges.get(a) ?? []), b]);
  for (let y = region.minY; y <= region.maxY; y++) for (let x = region.minX; x <= region.maxX; x++) {
    const p = y * n + x; if (grid[p] !== id) continue;
    if (!y || grid[p - n] !== id) add(key(x, y), key(x + 1, y));
    if (x === n - 1 || grid[p + 1] !== id) add(key(x + 1, y), key(x + 1, y + 1));
    if (y === n - 1 || grid[p + n] !== id) add(key(x + 1, y + 1), key(x, y + 1));
    if (!x || grid[p - 1] !== id) add(key(x, y + 1), key(x, y));
  }
  const rings:Point[][]=[];
  while(edges.size){const start=edges.keys().next().value as number;
  const polygon: Point[] = []; let current = start;
  do {
    const next = edges.get(current); if (!next || next.length !== 1) return null;
    polygon.push({ x: (current % (n + 1)) / n, y: Math.floor(current / (n + 1)) / n });
    edges.delete(current); current = next[0];
  } while (current !== start && polygon.length <= n * n);
  if (current !== start) return null;
  rings.push(polygon.filter((p, i) => { const a = polygon[(i + polygon.length - 1) % polygon.length], b = polygon[(i + 1) % polygon.length]; return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y)); }));
  }
  if(!rings.length)return null;
  const area=(ring:Point[])=>Math.abs(ring.reduce((s,p,i)=>{const q=ring[(i+1)%ring.length];return s+p.x*q.y-p.y*q.x;},0));
  rings.sort((a,b)=>area(b)-area(a));
  return {polygon:rings[0],holes:rings.slice(1)};
}
