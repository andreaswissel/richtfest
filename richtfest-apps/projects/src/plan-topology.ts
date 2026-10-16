import { createHash } from "node:crypto";
import type { PlanFootprint, PlanFillRegion } from "./plan-footprints";
import type { PlanLabel, PlanWord } from "./plan-extraction";

type Point = { x: number; y: number };
const box = (points: Point[]) => {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
};
const hash = (keys: string[]) => createHash("sha256").update([...keys].sort().join("|")).digest("hex");
const polygonArea = (polygon: Point[]) => Math.abs(polygon.reduce((sum, point, index) => {
  const next = polygon[(index + 1) % polygon.length]; return sum + point.x * next.y - point.y * next.x;
}, 0)) / 2;

/**
 * A semantic wall proposal needs stronger evidence than mere connectivity.
 * We accept only exact, nearly rectangular source construction fills whose
 * page-aspect-corrected shape is clearly elongated. This deliberately misses
 * L-shaped, curved, thick or ambiguous wall geometry instead of guessing.
 */
export function draftWallEvidence(footprint: PlanFootprint, pageAspectRatio = 1) {
  const polygon = footprint.geometry.polygon, region = footprint.geometry.planRegion;
  const aspect = Number.isFinite(pageAspectRatio) && pageAspectRatio > 0 ? pageAspectRatio : 1;
  const width = region.width * aspect, height = region.height;
  const longSide = Math.max(width, height), shortSide = Math.min(width, height);
  const physicalAspectRatio = shortSide > 0 ? longSide / shortSide : Infinity;
  const boundingArea = region.width * region.height;
  const rectangularity = boundingArea > 0 ? polygonArea(polygon) / boundingArea : 0;
  const wallLike = polygon.length === 4 && physicalAspectRatio >= 4 && rectangularity >= .9
    && longSide >= .005 && shortSide > 0 && shortSide <= .025;
  const minorDimensionBand = Math.round(shortSide / .0005) * .0005;
  return { wallLike, method: "elongated_rectangular_construction_fill" as const, sourcePolygonExact: true as const,
    pageAspectRatio: aspect, physicalAspectRatio, rectangularity, pageRelativeMinorDimension: shortSide, minorDimensionBand };
}

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

/** Bounded raster topology with one construction scenario, hard unit ownership,
 * inferred gap closure and printed-area-guided partitions. No door claims. */
export function inferPlanTopology(labels: PlanLabel[], footprints: PlanFootprint[], words: PlanWord[] = [], resolution = 1200, supplementary: PlanFootprint[] = [], closeRadius = 0, fillRegions: PlanFillRegion[] = [], pageAspectRatio = 1, normalizedPageAreaM2?: number) {
  const n = Math.max(64, Math.min(1600, Math.floor(resolution))), size = n * n;
  const wall = new Uint8Array(size), owner = new Int32Array(size).fill(-1);
  const adjacency = footprints.map(() => new Set<number>());
  const connect = (a: number, b: number) => { if (a === b) return; adjacency[a].add(b); adjacency[b].add(a); };
  // Scanline fill preserves source concavity; its grid approximation is never called exact.
  // Alternative construction states are evidence, never simultaneous barriers.
  footprints.forEach((footprint, index) => {
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
        if (id >= 0 && owner[p] >= 0) connect(id, owner[p]);
        wall[p] = 1; if (id >= 0) owner[p] = id;
      }
    }
  });
  for (let p = 0; p < size; p++) if (owner[p] >= 0) {
    if (p % n && owner[p - 1] >= 0) connect(owner[p], owner[p - 1]);
    if (p >= n && owner[p - n] >= 0) connect(owner[p], owner[p - n]);
  }
  const collidesWithLabel = (footprint: PlanFootprint) => labels.some(label => {
    const a = footprint.geometry.planRegion, b = label.geometry.planRegion;
    return a.x < b.x+b.width && a.x+a.width > b.x && a.y < b.y+b.height && a.y+a.height > b.y;
  });
  const wallIndexes = new Set(footprints.map((footprint, index) => draftWallEvidence(footprint, pageAspectRatio).wallLike && !collidesWithLabel(footprint) ? index : -1).filter(index => index >= 0));
  const wallEntries=[...wallIndexes].map(index=>({index,classification:draftWallEvidence(footprints[index],pageAspectRatio)}));
  const bandCounts=new Map<number,number>();
  for(const entry of wallEntries)bandCounts.set(entry.classification.minorDimensionBand,(bandCounts.get(entry.classification.minorDimensionBand)??0)+1);
  const walls = wallEntries.map(({index,classification}, i) => {
    const footprint = footprints[index],thicknessBandCount=bandCounts.get(classification.minorDimensionBand)??1;
    return { sourceKey: `draft-wall:${hash([footprint.sourceKey])}`, entityType: "element" as const,
      name: `Draft wall ${i + 1}`, quote: "Exact elongated rectangular fill from source construction layer",
      layerId: footprint.layerId, layerName: footprint.layerName,
      geometry: { quality: "draft_wall" as const, semanticKind: "draft_wall" as const,
        constructionState: "proposed" as const,
        phaseEvidence: { state: "proposed" as const, method: "source_layer_role" as const, layerId: footprint.layerId, layerName: footprint.layerName, status: "unreviewed" as const },
        coordinateSpace: "normalized-page" as const, polygon: footprint.geometry.polygon,
        sourceFootprintKeys: [footprint.sourceKey], planRegion: footprint.geometry.planRegion,
        classification:{...classification,thicknessBandCount,contextualContactCount:adjacency[index].size,evidenceTier:thicknessBandCount>=3&&adjacency[index].size>=2?"high" as const:"medium" as const},
        limitations: "Unreviewed wall-like source construction fill selected by conservative shape and label-collision checks. High evidence additionally requires a repeated thickness band and at least two source contacts. Exact source polygon is preserved. Bands and contacts are page-relative evidence, not a measured thickness or verified continuity. Material, construction state, physical scale, openings and completeness are not established." } };
  });
  // Unsupported construction fills are grouped only through direct contact with
  // each other. A wall-like polygon may not bridge unrelated fragments into a
  // false assembly.
  const fragmentIndexes = footprints.map((_, index) => index).filter(index => !wallIndexes.has(index));
  const fragmentParent = new Map(fragmentIndexes.map(index => [index, index]));
  const fragmentRoot = (index: number): number => { let p = fragmentParent.get(index)!; while (p !== fragmentParent.get(p)) p = fragmentParent.get(p)!; return p; };
  for (const index of fragmentIndexes) for (const neighbor of adjacency[index]) if (fragmentParent.has(neighbor))
    fragmentParent.set(fragmentRoot(index), fragmentRoot(neighbor));
  const groups = new Map<number, PlanFootprint[]>();
  for (const index of fragmentIndexes) { const key = fragmentRoot(index); groups.set(key, [...(groups.get(key) ?? []), footprints[index]]); }
  const fragmentAssemblies = [...groups.values()].map((members, i) => ({
    sourceKey: `assembly:${hash(members.map(m => m.sourceKey))}`, entityType: "element" as const,
    name: `Unsupported construction fragment ${i + 1}`, quote: `${members.length} connected non-wall source construction fills`,
    layerId: members[0].layerId, layerName: members[0].layerName,
    geometry: { quality: "construction_fragment_assembly" as const, semanticKind: "construction_fragment" as const,
      constructionState: "proposed" as const,
      phaseEvidence: { state: "proposed" as const, method: "source_layer_role" as const, layerIds: [...new Set(members.map(m => m.layerId))], layerNames: [...new Set(members.map(m => m.layerName))], status: "unreviewed" as const },
      coordinateSpace: "normalized-page" as const,
      polygons: members.map(m => m.geometry.polygon), sourceFootprintKeys: members.map(m => m.sourceKey),
      planRegion: box(members.flatMap(m => m.geometry.polygon)),
      limitations: `Did not meet the conservative draft-wall shape test. Direct fragment connectivity is inferred on a ${n}×${n} grid; exact member polygons are preserved. Not a verified wall, material, state or physical measurement.` },
  }));
  const assemblies = [...walls, ...fragmentAssemblies];
  const supportedFills = fillRegions.filter(f => f.fillRule === "evenodd");
  const observations = printedAreaObservations(labels, words);
  const units = words.flatMap(word => {
    if (/^WE\s*\d{1,4}$/i.test(word.text)) return [{...word,text:word.text.replace(/\s+/g," ")}];
    if (!/^WE$/i.test(word.text)) return [];
    const numbers = words.filter(w => /^\d{1,4}$/.test(w.text) && ((Math.abs(w.y-word.y)<word.height*.5 && w.x>word.x && w.x-word.x-word.width<word.height*2)||(Math.abs(w.x-word.x)<word.width*.5&&w.y<word.y&&word.y-w.y-w.height<word.width*2)));
    return numbers.length===1?[{...word,text:`WE ${numbers[0].text}`,width:numbers[0].x+numbers[0].width-word.x}]:[];
  });
  const unitForFill = new Map(supportedFills.map(f => [f.sourceKey, [...new Set(units.filter(u => insideFill({x:u.x+u.width/2,y:u.y+u.height/2},f)).map(u=>u.text))]]));
  // CAD unit markers sometimes occupy a hole just outside the floor fill. Only
  // an unassigned, unique nearby marker may associate with a substantial compound fill.
  const assignedUnits=new Set([...unitForFill.values()].filter(v=>v.length===1).flat());
  const fallbackUnitFills=new Set<string>();
  for(const f of supportedFills)if(!unitForFill.get(f.sourceKey)?.length&&f.rings.length>1) {
    const r=box(f.rings.flat());
    const within=(w:PlanWord)=>w.x+w.width/2>=r.x&&w.x+w.width/2<=r.x+r.width&&w.y+w.height/2>=r.y&&w.y+w.height/2<=r.y+r.height;
    const nearby=[...new Set(units.filter(u=>within(u)).map(u=>u.text))];
    const roomAreas=labels.filter(l=>{const b=l.geometry.planRegion;return insideFill({x:b.x+b.width/2,y:b.y+b.height/2},f);}).map(l=>observations.get(l.sourceKey)?.value);
    const sum=roomAreas.length>=2&&roomAreas.every(v=>v!==undefined)?roomAreas.reduce<number>((s,v)=>s+v!,0):null;
    const summaries=words.filter(w=>within(w)&&/^Wfl\.:?$/i.test(w.text));
    const closure=sum!==null&&summaries.some(s=>words.some(w=>within(w)&&/^\d+[.,]\d{2}(?:m[²2])?$/.test(w.text)&&Math.abs(w.y-s.y)<s.height*.5&&w.x>s.x&&w.x-s.x-s.width<s.height*2&&Math.abs(Number.parseFloat(w.text.replace(",","."))-sum)<.011));
    if(nearby.length===1&&!assignedUnits.has(nearby[0])&&closure){unitForFill.set(f.sourceKey,nearby);fallbackUnitFills.add(f.sourceKey);}
  }
  const unitFills = supportedFills.filter(f => unitForFill.get(f.sourceKey)?.length === 1 && labels.filter(l => {
    const r=l.geometry.planRegion; return insideFill({x:r.x+r.width/2,y:r.y+r.height/2},f);
  }).length >= 2).sort((a,b)=>polygonArea(b.rings[0])-polygonArea(a.rings[0]));
  const apartmentOwner = new Int32Array(size).fill(-1);
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
  // Largest substantial unit fill wins overlaps; decorative fills cannot own cells.
  for (let id=0;id<unitFills.length;id++) {
    const fill=unitFills[id],r=box(fill.rings.flat());
    for(let y=Math.max(0,Math.floor(r.y*n));y<Math.min(n,Math.ceil((r.y+r.height)*n));y++)
      for(let x=Math.max(0,Math.floor(r.x*n));x<Math.min(n,Math.ceil((r.x+r.width)*n));x++) {
        const p=y*n+x;if(apartmentOwner[p]<0&&insideFill({x:(x+.5)/n,y:(y+.5)/n},fill))apartmentOwner[p]=id;
      }
  }
  const thicknesses=wallEntries.map(e=>e.classification.pageRelativeMinorDimension*n).sort((a,b)=>a-b);
  closeRadius=closeRadius || (thicknesses.length>=3&&(unitFills.length>0||labels.length<=2)?Math.min(4,Math.max(1,Math.round(thicknesses[Math.floor(thicknesses.length/2)]))):0);
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
      for (const q of next) if (q >= 0 && !wall[q] && component[q] < 0 && apartmentOwner[q]===apartmentOwner[p]) { component[q] = id; queue[tail++] = q; }
    }
    regions.push(region);
  }
  const seedRegions = labels.map((label, i) => {
    const r = label.geometry.planRegion, x = Math.min(n - 1, Math.floor((r.x + r.width / 2) * n)), y = Math.min(n - 1, Math.floor((r.y + r.height / 2) * n));
    const id = component[y * n + x]; if (id >= 0) regions[id].seeds.push(i); return id;
  });
  // Multi-source geodesic partition stays inside each source-filled connected component
  // and cannot cross retained walls or apartment owners. Its capacity-guided seams are inferred.
  const partition = new Int32Array(size).fill(-1), distances = new Float64Array(size).fill(Infinity);
  const heap:{p:number;distance:number}[]=[];
  const push=(entry:{p:number;distance:number})=>{let i=heap.length;heap.push(entry);while(i>0){const parent=(i-1)>>1;if(heap[parent].distance<=entry.distance)break;heap[i]=heap[parent];i=parent;}heap[i]=entry;};
  const pop=()=>{const result=heap[0],last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].distance<heap[child].distance)child++;if(heap[child].distance>=last.distance)break;heap[i]=heap[child];i=child;}heap[i]=last;}return result;};
  const capacityEnabled=unitFills.length>0||footprints.length===0;
  const weights=labels.map(l=>capacityEnabled?Math.sqrt(observations.get(l.sourceKey)?.value||1):1);
  const horizontalCost=Number.isFinite(pageAspectRatio)&&pageAspectRatio>0?pageAspectRatio:1;
  for(let iteration=0;iteration<6;iteration++) {
  partition.fill(-1);distances.fill(Infinity);
  labels.forEach((label,i)=>{
    if(seedRegions[i]<0||regions[seedRegions[i]].exterior)return;
    const r=label.geometry.planRegion,x=Math.min(n-1,Math.floor((r.x+r.width/2)*n)),y=Math.min(n-1,Math.floor((r.y+r.height/2)*n)),p=y*n+x;
    if(partition[p]>=0)return;partition[p]=i;distances[p]=0;push({p,distance:0});
  });
  while(heap.length){const {p,distance}=pop();if(distance!==distances[p])continue;const x=p%n,y=Math.floor(p/n);
    for(const q of [x>0?p-1:-1,x<n-1?p+1:-1,y>0?p-n:-1,y<n-1?p+n:-1])if(q>=0&&component[q]===component[p]){const next=distance+(Math.abs(q-p)===1?horizontalCost:1)/weights[partition[p]];if(next<distances[q]){distances[q]=next;partition[q]=partition[p];push({p:q,distance:next});}}
  }
  const capacities=new Int32Array(labels.length);for(let p=0;p<size;p++)if(partition[p]>=0)capacities[partition[p]]++;
  let needsRefinement=false;
  for(const region of regions) {
    const values=region.seeds.map(i=>observations.get(labels[i].sourceKey)?.value);
    if(!capacityEnabled||region.seeds.length<2||!values.every(v=>v!==undefined&&v>0))continue;
    const total=values.reduce<number>((s,v)=>s+v!,0);
    region.seeds.forEach((i,j)=>{const target=region.count*values[j]!/total,actual=capacities[i];
      if(actual&&Math.abs(actual/target-1)>.12){weights[i]*=Math.max(.7,Math.min(1.4,Math.sqrt(target/actual)));needsRefinement=true;}
    });
  }
  if(!needsRefinement)break;
  }
  const counts = { enclosed: 0, exterior: 0, conflicting: 0, obstructed: 0, outside_source_fill:0, oversized_unresolved:0,area_ratio_outlier:0 };
  const preliminaryRooms = labels.map((label, i) => {
    const lr=label.geometry.planRegion;
    const seedX=Math.min(n-1,Math.floor((lr.x+lr.width/2)*n)),seedY=Math.min(n-1,Math.floor((lr.y+lr.height/2)*n));
    const unitId=apartmentOwner[seedY*n+seedX];
    const containingFills=unitId>=0?[unitFills[unitId]]:supportedFills.filter(f=>insideFill({x:lr.x+lr.width/2,y:lr.y+lr.height/2},f));
    const groupLabels=[...new Set(containingFills.flatMap(f=>unitForFill.get(f.sourceKey)??[]))];
    const id = seedRegions[i], region = id >= 0 ? regions[id] : null;
    const status = supportedFills.length&&!containingFills.length?"outside_source_fill":!region ? "obstructed" : region.exterior ? "exterior" : region.seeds.length !== 1 ? "conflicting" : "enclosed";
    // A bounding box alone must never masquerade as the traced room boundary.
    const contour = status === "enclosed" ? traceRegion(component, n, id, region!) : status === "conflicting" ? traceRegion(partition,n,i,region!) : null;
    const candidatePolygon=contour?.polygon;
    const candidateBounds=candidatePolygon?box(candidatePolygon):null;
    // Whole-apartment/sheet regions are not room proposals merely because a
    // single source label survived. The threshold is page-relative, not a
    // physical measurement, and deliberately leaves large spaces unresolved.
    const oversized=Boolean(candidatePolygon&&candidateBounds&&
      (candidateBounds.width*candidateBounds.height>.08||polygonArea(candidatePolygon)>.06));
    const finalStatus=oversized?"oversized_unresolved":status;
    counts[finalStatus]++;
    const polygon=oversized?undefined:candidatePolygon;
    return { ...label, sourceKey:`topology-v4:${label.sourceKey}`, geometry: { ...label.geometry,
      ...(polygon ? { quality: status==="conflicting"?"approximate_partition" as const:"enclosed_region" as const, polygon, holes:contour?.holes, planRegion: box(polygon), labelRegion: label.geometry.planRegion } : {}),
      topology: { status:finalStatus, componentId:id>=0?id:null, method:oversized?"oversized_region_guard":status==="conflicting"?"wall_constrained_geodesic_partition":"enclosed_component", competingSourceKeys: region?.seeds.filter(j => j !== i).map(j => `topology-v4:${labels[j].sourceKey}`) ?? [], resolution: n, closeRadius,pageAspectRatio:horizontalCost, partitionWeight:"sqrt_printed_area", barrierScenario:"primary", ignoredAlternativeBarrierCount:supplementary.length, apartmentOwner:unitId>=0?unitFills[unitId].sourceKey:null, gapClosing:closeRadius?"inferred_segmentation_only":null },
      sourceFillEvidence:containingFills.map(f=>({sourceKey:f.sourceKey,layerId:f.layerId,layerName:f.layerName})),
      ...(containingFills.length===1&&groupLabels.length===1?{groupLabel:groupLabels[0],groupSourceKey:containingFills[0].sourceKey,
        groupAssociationMethod:fallbackUnitFills.has(containingFills[0].sourceKey)?"bbox_summary_plus_exact_area_closure":"contained_unit_marker",
        groupObservation:units.filter(u=>u.text===groupLabels[0]&&insideFill({x:u.x+u.width/2,y:u.y+u.height/2},containingFills[0])).map(u=>({quote:u.text,planRegion:{x:u.x,y:u.y,width:u.width,height:u.height},provenance:"inferred"}))}:{}),
      ...(observations.has(label.sourceKey) ? { printedArea: observations.get(label.sourceKey) } : {}),
      limitations: polygon ? `Approximate raster region seeded by source text, constrained by primary construction fills and apartment ownership. ${status==="conflicting"?"Shared free space is divided by area-guided geodesic distance: partition seams are inferred, not source walls. ":""}Not a verified room boundary, physical area or opening; reviewer must confirm. Source holes are preserved.` : oversized ? "Source label only: the inferred region exceeded the conservative page-relative room-size guard and may represent multiple rooms or a whole apartment/sheet area. Room boundary remains unresolved." : `Source label only: ${status} free-space region. Room boundary is unresolved. Printed areas, if present, are unreviewed proximity associations.` } };
  });
  const effectiveRoomArea=(geometry:{polygon?:Point[];holes?:Point[][]})=>geometry.polygon
    ?Math.max(0,polygonArea(geometry.polygon)-(geometry.holes??[]).reduce((sum,hole)=>sum+polygonArea(hole),0)):0;
  const ratios=preliminaryRooms.flatMap(room=>{const value=room.geometry.printedArea?.value;
    return room.geometry.polygon&&value!==undefined&&value>0?[effectiveRoomArea(room.geometry)/value]:[];}).sort((a,b)=>a-b);
  const areaRatioMedian=ratios.length?ratios.length%2?ratios[(ratios.length-1)/2]:(ratios[ratios.length/2-1]+ratios[ratios.length/2])/2:null;
  const rooms=preliminaryRooms.map(room=>{
    const printedArea=room.geometry.printedArea?.value;
    if(!room.geometry.polygon||!printedArea||!areaRatioMedian||ratios.length<5)return room;
    const normalizedPolygonArea=effectiveRoomArea(room.geometry),ratio=normalizedPolygonArea/printedArea,relativeToMedian=ratio/areaRatioMedian;
    const areaRatioQc={status:"unreviewed" as const,method:"page_local_polygon_to_printed_area_ratio" as const,
      normalizedPolygonArea,printedArea,ratio,pageMedianRatio:areaRatioMedian,relativeToMedian,sampleCount:ratios.length,
      limitations:"Page-local relative consistency check only. It does not establish scale, physical area or correctness of the printed-area association."};
    if(relativeToMedian>=.5&&relativeToMedian<=2)return {...room,geometry:{...room.geometry,areaRatioQc}};
    const previousStatus=room.geometry.topology.status as keyof typeof counts;
    if(previousStatus in counts)counts[previousStatus]=Math.max(0,counts[previousStatus]-1);
    counts.area_ratio_outlier++;
    const {polygon:_polygon,holes:_holes,labelRegion,...remaining}=room.geometry;
    return {...room,geometry:{...remaining,quality:"anchor" as const,planRegion:labelRegion??room.geometry.planRegion,
      topology:{...room.geometry.topology,status:"area_ratio_outlier" as const,method:"area_ratio_outlier_guard" as const},areaRatioQc,
      limitations:"Source label only: the inferred polygon-to-printed-area ratio was outside 0.5×–2× of this page's robust median. This relative QC flags a likely merge, split or area-association mismatch; it is not a scale or area validation. Room boundary remains unresolved."}};
  });
  for (let i=0;i<rooms.length;i++) {
    const room=rooms[i],g=room.geometry,region=seedRegions[i]>=0?regions[seedRegions[i]]:null;
    const siblings=rooms.filter(r=>g.groupSourceKey&&r.geometry.groupSourceKey===g.groupSourceKey);
    const duplicateLiving=siblings.filter(r=>/^Wo\./i.test(r.name)).length>1;
    Object.assign(g,{semanticQc:{status:duplicateLiving?"group_conflict":"unreviewed",duplicateLivingKitchen:duplicateLiving}});
    if(!g.polygon)continue;
    const containsOther=labels.some((l,j)=>j!==i&&insideFill({x:l.geometry.planRegion.x+l.geometry.planRegion.width/2,y:l.geometry.planRegion.y+l.geometry.planRegion.height/2},{rings:[g.polygon!,...(g.holes??[])]} as PlanFillRegion));
    const printed=g.printedArea?.value;
    const allAreas=region?.seeds.map(j=>observations.get(labels[j].sourceKey)?.value);
    const total=allAreas?.every(a=>a!==undefined&&a>0)?allAreas.reduce<number>((s,a)=>s+a!,0):null;
    const target=capacityEnabled&&printed&&total&&region&&region.seeds.length>1?region.count/(n*n)*printed/total:null;
    const relative=target?effectiveRoomArea(g)/target:null;
    const estimatedArea=normalizedPageAreaM2&&printed?effectiveRoomArea(g)*normalizedPageAreaM2:null;
    const physicalConflict=estimatedArea!==null&&printed!==undefined&&Math.abs(estimatedArea-printed)>Math.max(.5,printed*.1);
    const inconsistent=(relative!==null&&(relative<.6||relative>1.4))||physicalConflict;
    Object.assign(g,{printedScaleQc:estimatedArea!==null?{estimatedArea,printedArea:printed,toleranceM2:Math.max(.5,printed!*.1),status:physicalConflict?"conflict":"unreviewed",limitations:"Uses the source printed scale as unreviewed evidence, not a verified physical measurement."}:null});
    Object.assign(g,{capacityQc:{relativeToPrintedTarget:relative,tolerance:.4,status:inconsistent?"conflict":"unreviewed"}});
    if(containsOther||inconsistent){
      const prior=g.topology.status as keyof typeof counts;if(prior in counts)counts[prior]=Math.max(0,counts[prior]-1);
      counts.area_ratio_outlier++;
      g.planRegion=g.labelRegion??g.planRegion;g.quality="anchor";
      delete g.polygon;delete g.holes;delete g.labelRegion;
      g.topology.status="area_ratio_outlier";
      g.limitations=containsOther?"Source label only: candidate contained another room label center.":physicalConflict?"Source label only: polygon area at the printed source scale differs from the room annotation by more than 10% or 0.5 m². Scale, association and boundary require review.":"Source label only: constrained region differs by more than 40% from its printed-area capacity target. Association and boundary require review.";
    }
  }
  return { rooms, assemblies, coverage: { ...counts, approximateRegionCount:rooms.filter(r=>r.geometry.polygon).length, unresolvedRegionCount:rooms.filter(r=>!r.geometry.polygon).length,labelCount: labels.length, groupedRoomCount:rooms.filter(r=>r.geometry.groupLabel).length, fillRegionCount:supportedFills.length, assemblyCount: assemblies.length, wallCount:walls.length,
    highEvidenceWallCount:walls.filter(w=>w.geometry.classification.evidenceTier==="high").length,mediumEvidenceWallCount:walls.filter(w=>w.geometry.classification.evidenceTier==="medium").length,
    fragmentAssemblyCount:fragmentAssemblies.length, unsupportedFootprintCount:fragmentIndexes.length, sourceFootprintCount: footprints.length, supplementaryBarrierCount: 0, alternativeBarrierCount:supplementary.length, barrierScenario:"primary", apartmentDomainCount:unitFills.length, printedAreaCount: observations.size,
    areaRatioSampleCount:ratios.length,areaRatioMedian, resolution: n, closeRadius,
    alternativeBarrierEvidence:supplementary.map(f=>({sourceKey:f.sourceKey,layerId:f.layerId,layerName:f.layerName,polygon:f.geometry.polygon,state:"unresolved_alternative"})),
    relationships: "Not established: source fills alone do not distinguish doors, openings or traversable adjacency.",
    limitations: "Only primary construction fills constrain the selected scenario; alternative layers retain unresolved state provenance. Substantial unit-bearing fills establish hard owner domains. Gap closure affects segmentation only. Shared components use inferred area-guided geodesic partitions; this does not establish doors or room adjacency. Printed-scale QC is unreviewed source evidence. Missing strokes and open gaps remain uncertainty; failed regions remain anchors." } };
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
