import { createHash } from "node:crypto";
import type { PlanBarrierLine, PlanDoorSwing, PlanFootprint, PlanFillRegion } from "./plan-footprints";
import type { PlanLabel, PlanWord } from "./plan-extraction";
import { wallRunMethod, wallRuns } from "./plan-wall-runs";

type Point = { x: number; y: number };
const box = (points: Point[]) => {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
};
const hash = (keys: string[]) => createHash("sha256").update([...keys].sort().join("|")).digest("hex");
const polygonArea = (polygon: Point[]) => Math.abs(polygon.reduce((sum, point, index) => {
  const next = polygon[(index + 1) % polygon.length]; return sum + point.x * next.y - point.y * next.x;
}, 0)) / 2;
const exactRectangle = (polygon: Point[]) => {
  if (polygon.length !== 4) return null;
  const bounds = box(polygon), corners = new Set([
    `${bounds.x},${bounds.y}`, `${bounds.x + bounds.width},${bounds.y}`,
    `${bounds.x + bounds.width},${bounds.y + bounds.height}`, `${bounds.x},${bounds.y + bounds.height}`,
  ]);
  return polygon.every(point => corners.has(`${point.x},${point.y}`)) && corners.size === 4 ? bounds : null;
};
const simplifyPolygon = (polygon: Point[]) => {
  const points = polygon.filter((point, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 1e-9;
  });
  if (points.length < 3) return points;
  return points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length], next = points[(index + 1) % points.length];
    const cross = (point.x - previous.x) * (next.y - point.y) - (point.y - previous.y) * (next.x - point.x);
    return Math.abs(cross) > 1e-9;
  });
};
const shapeMetrics = (polygon: Point[], holes: Point[][] = []) => {
  const outer = simplifyPolygon(polygon), inner = holes.map(simplifyPolygon), all = [outer, ...inner];
  const area = Math.max(0, polygonArea(outer) - inner.reduce((sum, hole) => sum + polygonArea(hole), 0));
  const bounds = outer.length ? box(outer) : { x: 0, y: 0, width: 0, height: 0 };
  const perimeter = all.reduce((sum, ring) => sum + ring.reduce((length, point, index) => {
    const next = ring[(index + 1) % ring.length]; return length + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0), 0);
  const axisAlignedLength = all.reduce((sum, ring) => sum + ring.reduce((length, point, index) => {
    const next = ring[(index + 1) % ring.length], edge = Math.hypot(next.x - point.x, next.y - point.y);
    return length + (Math.abs(next.x - point.x) <= 1e-9 || Math.abs(next.y - point.y) <= 1e-9 ? edge : 0);
  }, 0), 0);
  const points = outer.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const halfHull = (ordered: Point[]) => ordered.reduce<Point[]>((half, point) => {
    while (half.length >= 2 && cross(half[half.length - 2], half[half.length - 1], point) <= 1e-9) half.pop();
    half.push(point);
    return half;
  }, []);
  const lower = halfHull(points), upper = halfHull(points.slice().reverse());
  const convexHull = points.length > 1 ? [...lower.slice(0, -1), ...upper.slice(0, -1)] : points;
  const bboxArea = bounds.width * bounds.height;
  const edgeLengths = all.flatMap(ring => ring.map((point, index) => {
    const next = ring[(index + 1) % ring.length]; return Math.hypot(next.x - point.x, next.y - point.y);
  }).filter(length => length > 1e-9));
  const minEdgeToBboxRatio = edgeLengths.length && Math.max(bounds.width, bounds.height) > 0
    ? Math.min(...edgeLengths) / Math.max(bounds.width, bounds.height) : 0;
  const bboxFillRatio = bboxArea > 0 ? area / bboxArea : 0;
  const compactness = perimeter > 0 ? 4 * Math.PI * area / (perimeter * perimeter) : 0;
  const convexityRatio = area > 0 && convexHull.length >= 3 ? polygonArea(convexHull) / area : Infinity;
  const narrowLobeSignal = bboxFillRatio < .35 && convexityRatio > 1.45;
  const severeConcavity = convexityRatio > 2.5 || bboxFillRatio < .25;
  return { bboxFillRatio, compactness, rectilinearEdgeFraction: perimeter > 0 ? axisAlignedLength / perimeter : 0,
    convexityRatio, narrowLobeSignal, severeConcavity, minEdgeToBboxRatio, area, bbox: bounds };
};

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

/**
 * Construction state from a fill colour, after the DIN 1356-1 colours for alterations:
 * yellow is demolished; grey, on the existing/demolition layer only, is existing and retained.
 * Other colours say nothing about the state (null).
 */
export function fillState(colour: string | undefined, existingLayer: boolean): "retained" | "demolished" | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour ?? "");
  if (!match) return null;
  const [r, g, b] = match.slice(1).map(v => Number.parseInt(v, 16)) as [number, number, number];
  if (r >= 0xc0 && g >= 0xc0 && Math.abs(r - g) <= 0x30 && r - b >= 0x30) return "demolished";
  if (existingLayer && Math.max(r, g, b) - Math.min(r, g, b) <= 0x10 && r >= 0x50 && r <= 0xd8) return "retained";
  return null;
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
export function inferPlanTopology(labels: PlanLabel[], footprints: PlanFootprint[], words: PlanWord[] = [], resolution = 1200, supplementary: PlanFootprint[] = [], closeRadius = 0, fillRegions: PlanFillRegion[] = [], pageAspectRatio = 1, normalizedPageAreaM2?: number, options: { doorSwings?: PlanDoorSwing[]; metresPerPageHeight?: number | null; barrierLines?: PlanBarrierLine[]; straightSeams?: boolean } = {}) {
  const n = Math.max(64, Math.min(1600, Math.floor(resolution))), size = n * n;
  const horizontalCost = Number.isFinite(pageAspectRatio) && pageAspectRatio > 0 ? pageAspectRatio : 1;
  const wall = new Uint8Array(size), owner = new Int32Array(size).fill(-1);
  const adjacency = footprints.map(() => new Set<number>());
  const connect = (a: number, b: number) => { if (a === b) return; adjacency[a].add(b); adjacency[b].add(a); };
  // Scanline fill preserves source concavity; its grid approximation is never called exact.
  // Alternative construction states are evidence, never simultaneous barriers.
  // Even-odd scanline fill preserves source concavity and compound holes; every
  // source edge is also traced so walls thinner than one cell stay continuous.
  footprints.forEach((footprint, id) => {
    const rings = footprintRings(footprint), r = footprint.geometry.planRegion;
    const mark = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= n || y >= n) return;
      const p = y * n + x; if (owner[p] >= 0) connect(id, owner[p]); wall[p] = 1; owner[p] = id;
    };
    const nonzero = footprint.geometry.fillRule === "nonzero";
    for (let y = Math.max(0, Math.floor(r.y * n)); y <= Math.min(n - 1, Math.ceil((r.y + r.height) * n)); y++) {
      const py = (y + .5) / n, crossings: { x: number; direction: number }[] = [];
      for (const ring of rings) for (let j = 0; j < ring.length; j++) {
        const a = ring[j], b = ring[(j + 1) % ring.length];
        if ((a.y > py) !== (b.y > py)) crossings.push({ x: (a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y)) * n, direction: b.y > a.y ? 1 : -1 });
      }
      crossings.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let j = 0; j + 1 < crossings.length; j++) {
        winding += nonzero ? crossings[j].direction : 1;
        if (nonzero ? winding === 0 : winding % 2 === 0) continue;
        for (let x = Math.max(0, Math.ceil(crossings[j].x - .5)); x <= Math.min(n - 1, Math.floor(crossings[j + 1].x - .5)); x++) mark(x, y);
      }
    }
    for (const ring of rings) for (let j = 0; j < ring.length; j++) {
      const a = ring[j], b = ring[(j + 1) % ring.length], steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * n * 4));
      for (let t = 0; t <= steps; t++) mark(Math.min(n - 1, Math.floor((a.x + (b.x - a.x) * t / steps) * n)), Math.min(n - 1, Math.floor((a.y + (b.y - a.y) * t / steps) * n)));
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
  // Construction states by fill colour (DIN 1356-1 conventions): yellow is demolished on any layer;
  // grey on the existing/demolition layer is existing and retained. Everything else on the
  // construction layer is the proposed building. Demolished and retained walls are proposed
  // with their state, so the proposed building's checks leave demolished walls out.
  type WallSource = { footprint: PlanFootprint; index: number | null; state: "proposed" | "retained" | "demolished" };
  const sources: WallSource[] = [
    ...footprints.map((footprint, index) => ({ footprint, index, state: fillState(footprint.fillColor, false) === "demolished" ? "demolished" as const : "proposed" as const })),
    ...supplementary.flatMap(footprint => { const state = fillState(footprint.fillColor, true); return state ? [{ footprint, index: null, state }] : []; }),
  ];
  const contactsOf = (source: WallSource) => source.index === null ? 0 : adjacency[source.index].size;
  const aspect = Number.isFinite(pageAspectRatio) && pageAspectRatio > 0 ? pageAspectRatio : 1;
  const wallSources = new Set(sources.filter(source => draftWallEvidence(source.footprint, pageAspectRatio).wallLike && !collidesWithLabel(source.footprint)));
  const bandCounts = new Map<number, number>();
  for (const source of wallSources) { const band = draftWallEvidence(source.footprint, pageAspectRatio).minorDimensionBand; bandCounts.set(band, (bandCounts.get(band) ?? 0) + 1); }
  // Fills that are not one straight wall (an L, T or cross of walls, a wall with a step, a short
  // pier between windows) are split into straight runs. A short run counts only where its
  // thickness repeats among the walls or it comes from a fill that holds several runs.
  const rectCollides = (rect: { x: number; y: number; width: number; height: number }) => labels.some(label => {
    const b = label.geometry.planRegion; return rect.x < b.x+b.width && rect.x+rect.width > b.x && rect.y < b.y+b.height && rect.y+rect.height > b.y;
  });
  const splitSources = new Set<WallSource>();
  const runEntries = sources.flatMap(source => {
    if (wallSources.has(source)) return [];
    const split = wallRuns(footprintRings(source.footprint), aspect, .025, source.footprint.geometry.fillRule ?? "evenodd");
    if (!split) return [];
    const runs = split.runs.filter(run => run.thickness > 0 && run.length >= .005 && !rectCollides(run.rect)).map(run => ({ source, run, band: Math.round(run.thickness / .0005) * .0005 }));
    const accepted = runs.filter(entry => entry.run.length / entry.run.thickness >= 4
      || entry.run.length / entry.run.thickness >= 1.5 && (split.runs.length > 1 || (bandCounts.get(entry.band) ?? 0) >= 3));
    // Fully explained: every run is a wall, or a stub shorter than the shortest wall (a reveal or notch).
    if (accepted.length && !split.leftover && split.runs.every(run => accepted.some(entry => entry.run === run) || run.length < .005)) splitSources.add(source);
    return accepted;
  });
  for (const entry of runEntries) bandCounts.set(entry.band, (bandCounts.get(entry.band) ?? 0) + 1);
  const stateEvidence = (source: WallSource) => ({ state: source.state, method: source.state === "proposed" && !source.footprint.fillColor ? "source_layer_role" as const : "source_layer_and_fill_colour" as const,
    layerId: source.footprint.layerId, layerName: source.footprint.layerName, ...(source.footprint.fillColor ? { fillColor: source.footprint.fillColor } : {}), status: "unreviewed" as const });
  const walls = [
    ...[...wallSources].map(source => {
      const footprint = source.footprint, classification = draftWallEvidence(footprint, pageAspectRatio), thicknessBandCount = bandCounts.get(classification.minorDimensionBand) ?? 1, contacts = contactsOf(source);
      return { sourceKey: `draft-wall:${hash([footprint.sourceKey])}`, quote: "Exact elongated rectangular fill from source construction layer", source, polygon: footprint.geometry.polygon, planRegion: footprint.geometry.planRegion,
        classification: { ...classification, thicknessBandCount, contextualContactCount: contacts, evidenceTier: thicknessBandCount >= 3 && contacts >= 2 ? "high" as const : "medium" as const },
        limitations: "Unreviewed wall-like source construction fill selected by conservative shape and label-collision checks. High evidence additionally requires a repeated thickness band and at least two source contacts. Exact source polygon is preserved. Bands and contacts are page-relative evidence, not a measured thickness or verified continuity. Material, construction state, physical scale, openings and completeness are not established." };
    }),
    ...runEntries.map(({ source, run, band }) => {
      const { x, y, width, height } = run.rect, thicknessBandCount = bandCounts.get(band) ?? 1;
      return { sourceKey: `draft-wall:${hash([source.footprint.sourceKey, `${x.toFixed(7)},${y.toFixed(7)},${width.toFixed(7)},${height.toFixed(7)}`])}`, quote: "Straight run of a source construction fill", source,
        polygon: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], planRegion: run.rect,
        classification: { wallLike: true, method: wallRunMethod, sourcePolygonExact: false as const, pageAspectRatio: aspect, physicalAspectRatio: run.length / run.thickness,
          rectangularity: 1, pageRelativeMinorDimension: run.thickness, minorDimensionBand: band, thicknessBandCount, contextualContactCount: contactsOf(source),
          evidenceTier: thicknessBandCount >= 3 ? "high" as const : "medium" as const },
        limitations: "Unreviewed straight run cut from a source construction fill that is not one rectangle (corner, junction, step or short pier). Corners and junctions are given to the longer or through-running wall. Thickness is page-relative evidence, not a measurement; material, construction state, openings and completeness are not established." };
    }),
  ].map((wall, i) => ({ sourceKey: wall.sourceKey, entityType: "element" as const, name: `Draft wall ${i + 1}`, quote: wall.quote,
    layerId: wall.source.footprint.layerId, layerName: wall.source.footprint.layerName,
    geometry: { quality: "draft_wall" as const, semanticKind: "draft_wall" as const, constructionState: wall.source.state, phaseEvidence: stateEvidence(wall.source),
      coordinateSpace: "normalized-page" as const, polygon: wall.polygon, sourceFootprintKeys: [wall.source.footprint.sourceKey], planRegion: wall.planRegion,
      classification: wall.classification, limitations: wall.limitations } }));
  // Unsupported construction fills are grouped only through direct contact with
  // each other. A wall-like polygon may not bridge unrelated fragments into a
  // false assembly. Demolished fills are not part of the proposed building.
  const handled = new Set([...wallSources, ...splitSources].flatMap(source => source.index === null ? [] : [source.index]));
  const demolishedIndexes = new Set(sources.flatMap(source => source.index !== null && source.state === "demolished" ? [source.index] : []));
  const fragmentIndexes = footprints.map((_, index) => index).filter(index => !handled.has(index) && !demolishedIndexes.has(index));
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
  const constructionWall = wall.slice();
  // Stroked construction outlines (partitions, door leaves, window frames) are
  // segmentation barriers only. Jamb detection keeps using the filled raster.
  const drawLine = (target: Uint8Array, a: Point, b: Point) => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * n * 4));
    for (let t = 0; t <= steps; t++) {
      const x = Math.floor((a.x + (b.x - a.x) * t / steps) * n), y = Math.floor((a.y + (b.y - a.y) * t / steps) * n);
      if (x >= 0 && y >= 0 && x < n && y < n) target[y * n + x] = 1;
    }
  };
  for (const line of options.barrierLines ?? []) for (let i = 0; i + 1 < line.points.length + (line.closed ? 1 : 0); i++)
    drawLine(wall, line.points[i], line.points[(i + 1) % line.points.length]);
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
  let furnitureGapCount = 0;
  const adopted = new Uint8Array(size);
  // Magic selection separates source construction (hard) from "outside the floor fill" (soft).
  let structural: Uint8Array | null = null, filled: Uint8Array | null = null;
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
    // Floor fills leave holes and notches for furniture and fittings. Small gaps
    // bounded only by floor fill and construction belong to the room around them;
    // larger ones (common corridors, stairwells, outdoor space) stay outside.
    const mpp = options.metresPerPageHeight && options.metresPerPageHeight > 0 ? options.metresPerPageHeight : null;
    if (mpp) {
      const maxCells = 8 / ((mpp / n) ** 2 * horizontalCost), seen = new Uint8Array(size), stack: number[] = [];
      // Floor fills usually stop a few centimetres short of the stroked wall face; growing
      // the fill by up to 10 cm (never into walls) cuts those slivers so notches become enclosed.
      for (let step = 0, steps = Math.min(3, Math.max(1, Math.round(.1 / (mpp / n)))); step < steps; step++) {
        const grown: number[] = [];
        for (let p = 0; p < size; p++) if (!interior[p] && !wall[p]) {
          const x = p % n;
          if ((x > 0 && interior[p - 1]) || (x < n - 1 && interior[p + 1]) || (p >= n && interior[p - n]) || (p < size - n && interior[p + n])) grown.push(p);
        }
        for (const p of grown) { interior[p] = 1; adopted[p] = 1; }
      }
      for (let start = 0; start < size; start++) {
        if (seen[start] || interior[start] || wall[start]) continue;
        const cells: number[] = [];let edge = false, touchesFill = false;
        seen[start] = 1; stack.push(start);
        while (stack.length) {
          const p = stack.pop()!, x = p % n, y = (p - x) / n; cells.push(p);
          if (x === 0 || y === 0 || x === n - 1 || y === n - 1) edge = true;
          for (const q of [x > 0 ? p - 1 : -1, x < n - 1 ? p + 1 : -1, y > 0 ? p - n : -1, y < n - 1 ? p + n : -1]) {
            if (q < 0 || seen[q]) continue;
            if (interior[q]) { touchesFill = true; continue; }
            if (wall[q]) continue;
            seen[q] = 1; stack.push(q);
          }
        }
        if (!edge && touchesFill && cells.length <= maxCells) { furnitureGapCount++; for (const p of cells) { interior[p] = 1; adopted[p] = 1; } }
      }
    }
    structural = wall.slice(); filled = interior;
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
  // Adopted furniture gaps and wall-face slivers join the apartment they border.
  if (unitFills.length) {
    let frontier: number[] = [];
    for (let p = 0; p < size; p++) if (apartmentOwner[p] >= 0) frontier.push(p);
    while (frontier.length) {
      const next: number[] = [];
      for (const p of frontier) { const x = p % n;
        for (const q of [x > 0 ? p - 1 : -1, x < n - 1 ? p + 1 : -1, p - n, p + n]) if (q >= 0 && q < size && adopted[q] && !wall[q] && apartmentOwner[q] < 0) { apartmentOwner[q] = apartmentOwner[p]; next.push(q); } }
      frontier = next;
    }
  }
  // Wall thickness in grid cells along the axis that crosses the wall: the grid
  // is n×n over a possibly non-square page, so x and y cells differ in size.
  const thicknesses=[...wallSources].filter(source=>source.index!==null&&source.state==="proposed").map(({footprint})=>{const r=footprint.geometry.planRegion;return (r.width*horizontalCost<r.height?r.width:r.height)*n;}).sort((a,b)=>a-b);
  closeRadius=closeRadius || (thicknesses.length>=3&&(unitFills.length>0||labels.length<=2)?Math.min(4,Math.max(1,Math.round(thicknesses[Math.floor(thicknesses.length/2)]))):0);
  // Openings (doors, windows, passages) are gaps between facing wall ends. They
  // are closed in the segmentation grid only, so rooms do not leak into each
  // other; exact source polygons stay untouched and no door is claimed.
  const openings = detectOpenings(footprints, options.doorSwings ?? [], constructionWall, n, horizontalCost, options.metresPerPageHeight ?? null);
  for (const opening of openings) {
    const r = opening.closure;
    for (let y = Math.max(0, Math.floor(r.y * n)); y <= Math.min(n - 1, Math.ceil((r.y + r.height) * n) - 1); y++)
      for (let x = Math.max(0, Math.floor(r.x * n)); x <= Math.min(n - 1, Math.ceil((r.x + r.width) * n) - 1); x++) wall[y * n + x] = 1;
  }
  openings.push(...strokeDoorways(options.doorSwings?.filter(swing => !openings.some(o => o.doorSwingKey === swing.sourceKey)) ?? [], wall, n, horizontalCost, options.metresPerPageHeight ?? null, drawLine));
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
  // Barrier flags for magic selection: 2 = construction, closed opening or apartment boundary;
  // 1 = only outside the floor fill; 4 (added below) = seam between rooms sharing an open space.
  const selectionCells = new Uint8Array(size);
  for (let p = 0; p < size; p++) {
    if (wall[p]) { selectionCells[p] = !structural || structural[p] || filled![p] ? 2 : 1; continue; }
    const x = p % n, unit = apartmentOwner[p];
    if ((x < n - 1 && !wall[p + 1] && apartmentOwner[p + 1] !== unit) || (p + n < size && !wall[p + n] && apartmentOwner[p + n] !== unit)) selectionCells[p] = 2;
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
  // Open-plan seams: a geodesic split draws staircase diagonals that no plan has.
  // Where a straight wall-to-wall cut separates the seeds, use it instead.
  let chordSeamCount=0;
  if(options.straightSeams!==false)regions.forEach((region,id)=>{
    if(region.exterior||region.seeds.length<2)return;
    const result=straightSeamPartition(component,id,region,labels,n,horizontalCost,options.metresPerPageHeight??null,observations);
    if(!result)return;
    chordSeamCount+=result.cuts;
    for(const [p,owner] of result.owners)partition[p]=owner;
  });
  for (let p = 0; p < size; p++) if (partition[p] >= 0) {
    const x = p % n;
    if ((x < n - 1 && partition[p + 1] >= 0 && partition[p + 1] !== partition[p]) || (p + n < size && partition[p + n] >= 0 && partition[p + n] !== partition[p])) selectionCells[p] |= 4;
  }
  const counts = { enclosed: 0, exterior: 0, conflicting: 0, obstructed: 0, outside_source_fill:0, oversized_unresolved:0,area_ratio_outlier:0,shape_outlier:0,trace_failed:0 };
  const metresPerPageHeight = options.metresPerPageHeight && Number.isFinite(options.metresPerPageHeight) && options.metresPerPageHeight > 0 ? options.metresPerPageHeight : null;
  // Each opening records which seeded partition (room) lies on either side.
  const sideOwner = (point: Point) => {
    const x = Math.floor(point.x * n), y = Math.floor(point.y * n);
    if (x < 0 || y < 0 || x >= n || y >= n) return "exterior" as const;
    const p = y * n + x, c = component[p];
    return partition[p] >= 0 ? partition[p] : c >= 0 && regions[c].exterior ? "exterior" as const : "unassigned" as const;
  };
  const openingSides = openings.map(opening => opening.sideProbes.map(probe => sideOwner(probe)));
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
    const traceFailed = (status === "enclosed" || status === "conflicting") && !contour;
    const candidatePolygon=contour?.polygon;
    const candidateBounds=candidatePolygon?box(candidatePolygon):null;
    // Whole-apartment/sheet regions are not room proposals merely because a
    // single source label survived. The threshold is page-relative, not a
    // physical measurement, and deliberately leaves large spaces unresolved.
    // With a printed scale the guard is physical (generous, unreviewed); otherwise page-relative.
    const physical=(area:number)=>area*horizontalCost*metresPerPageHeight!**2;
    const oversized=Boolean(candidatePolygon&&candidateBounds&&(metresPerPageHeight
      ?physical(candidateBounds.width*candidateBounds.height)>400||physical(polygonArea(candidatePolygon))>200
      :candidateBounds.width*candidateBounds.height>.08||polygonArea(candidatePolygon)>.06));
    const finalStatus=traceFailed?"trace_failed":oversized?"oversized_unresolved":status;
    counts[finalStatus]++;
    const polygon=oversized?undefined:candidatePolygon;
    const roomApartmentOwner=unitId>=0?unitFills[unitId].sourceKey:null;
    const roomOpenings=openings.flatMap((opening,o)=>{const sides=openingSides[o],side=sides.indexOf(i);if(side<0)return [];
      const other=sides[1-side];return [{openingKey:opening.sourceKey,kind:opening.kind,connectsTo:typeof other==="number"?`topology-v5:${labels[other].sourceKey}`:other,status:"unreviewed" as const}];});
    // The "topology-v5:" key prefix is the stable candidate identity across extractor
    // upgrades: a refresh updates the same unreviewed candidate instead of duplicating it.
    return { ...label, sourceKey:`topology-v5:${label.sourceKey}`, geometry: { ...label.geometry,
      ...(polygon ? { quality: status==="conflicting"?"approximate_partition" as const:"enclosed_region" as const, polygon, holes:contour?.holes, planRegion: box(polygon), labelRegion: label.geometry.planRegion } : {}),
      topology: { status:finalStatus, componentId:id>=0?id:null, method:oversized?"oversized_region_guard":status==="conflicting"?"wall_constrained_geodesic_partition":"enclosed_component", competingSourceKeys: region?.seeds.filter(j => j !== i).map(j => `topology-v5:${labels[j].sourceKey}`) ?? [], resolution: n, closeRadius,pageAspectRatio:horizontalCost, partitionWeight:"sqrt_printed_area", barrierScenario:"primary", ignoredAlternativeBarrierCount:supplementary.length, apartmentOwner:roomApartmentOwner, gapClosing:closeRadius||roomOpenings.length?"inferred_segmentation_only":null, openings:roomOpenings,
        ...(contour?.detachedPartCount?{detachedPartCount:contour.detachedPartCount}:{}) },
      sourceFillEvidence:containingFills.map(f=>({sourceKey:f.sourceKey,layerId:f.layerId,layerName:f.layerName})),
      ...(containingFills.length===1&&groupLabels.length===1?{groupLabel:groupLabels[0],groupSourceKey:containingFills[0].sourceKey,
        groupAssociationMethod:fallbackUnitFills.has(containingFills[0].sourceKey)?"bbox_summary_plus_exact_area_closure":"contained_unit_marker",
        groupObservation:units.filter(u=>u.text===groupLabels[0]&&insideFill({x:u.x+u.width/2,y:u.y+u.height/2},containingFills[0])).map(u=>({quote:u.text,planRegion:{x:u.x,y:u.y,width:u.width,height:u.height},provenance:"inferred"}))}:{}),
      ...(observations.has(label.sourceKey) ? { printedArea: observations.get(label.sourceKey) } : {}),
      limitations: traceFailed ? "Source label only: the free-space region could not be traced into a single boundary. Room boundary remains unresolved." : polygon ? `Approximate raster region seeded by source text, constrained by primary construction fills and apartment ownership. ${status==="conflicting"?"Shared free space is divided by area-guided geodesic distance: partition seams are inferred, not source walls. ":""}Not a verified room boundary, physical area or opening; reviewer must confirm. Source holes are preserved.` : oversized ? "Source label only: the inferred region exceeded the conservative page-relative room-size guard and may represent multiple rooms or a whole apartment/sheet area. Room boundary remains unresolved." : `Source label only: ${status} free-space region. Room boundary is unresolved. Printed areas, if present, are unreviewed proximity associations.` } };
  });
  const shapeQcThresholds={minimumBboxFillRatio:.25,minimumCompactness:.1,maximumConvexityRatio:2.5};
  // Circulation spaces are legitimately long, L- or U-shaped; only extreme shapes are demoted there.
  const circulationQcThresholds={minimumBboxFillRatio:.12,minimumCompactness:0,maximumConvexityRatio:4};
  const circulation=/^(flur|diele|korridor|gang|eingang|windfang|treppenhaus|treppe|corridor|hall|stair)/i;
  type ShapeQc = ReturnType<typeof shapeMetrics> & { thresholds: typeof shapeQcThresholds; status: "unreviewed" | "severe"; method: "source_relative_rectilinear_shape_qc"; limitations: string };
  type ShapeCheckedRoom = (typeof preliminaryRooms)[number] & { geometry: (typeof preliminaryRooms)[number]["geometry"] & { polygon?: Point[]; holes?: Point[][]; labelRegion?: ReturnType<typeof box>; shapeQc?: ShapeQc } };
  const shapeCheckedRooms = preliminaryRooms.map(room => {
    if (!room.geometry.polygon) return room;
    const shape=shapeMetrics(room.geometry.polygon,room.geometry.holes??[]);
    const thresholds=circulation.test(room.name)?circulationQcThresholds:shapeQcThresholds;
    const shapeQc={...shape,thresholds,status:"unreviewed" as const,method:"source_relative_rectilinear_shape_qc" as const,
      limitations:"Source-relative polygon plausibility metrics only. They do not establish a physical measurement, room use or a verified source boundary."};
    const severe=shape.convexityRatio>thresholds.maximumConvexityRatio||shape.bboxFillRatio<thresholds.minimumBboxFillRatio
      ||(shape.narrowLobeSignal&&shape.compactness<thresholds.minimumCompactness);
    if(!severe)return {...room,geometry:{...room.geometry,shapeQc}};
    const previousStatus=room.geometry.topology.status as keyof typeof counts;
    if(previousStatus in counts)counts[previousStatus]=Math.max(0,counts[previousStatus]-1);
    counts.shape_outlier++;
    const {polygon:_polygon,holes:_holes,labelRegion,...remaining}=room.geometry;
    return {...room,geometry:{...remaining,quality:"anchor" as const,planRegion:labelRegion??room.geometry.planRegion,
      topology:{...room.geometry.topology,status:"shape_outlier" as const,method:"shape_qc_guard" as const},shapeQc:{...shapeQc,status:"severe" as const},
      limitations:"Source label only: the inferred polygon has a severe source-relative concavity or low compactness and was demoted to an unresolved anchor. Room boundary remains unresolved."}};
  }) as ShapeCheckedRoom[];
  const effectiveRoomArea=(geometry:{polygon?:Point[];holes?:Point[][]})=>geometry.polygon
    ?Math.max(0,polygonArea(geometry.polygon)-(geometry.holes??[]).reduce((sum,hole)=>sum+polygonArea(hole),0)):0;
  const ratios=shapeCheckedRooms.flatMap(room=>{const value=room.geometry.printedArea?.value;
    return room.geometry.polygon&&value!==undefined&&value>0?[effectiveRoomArea(room.geometry)/value]:[];}).sort((a,b)=>a-b);
  const areaRatioMedian=ratios.length?ratios.length%2?ratios[(ratios.length-1)/2]:(ratios[ratios.length/2-1]+ratios[ratios.length/2])/2:null;
  const rooms=shapeCheckedRooms.map(room=>{
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
  return { rooms, assemblies, selectionMask: { gridSize: n, cells: selectionCells }, coverage: { ...counts, approximateRegionCount:rooms.filter(r=>r.geometry.polygon).length, unresolvedRegionCount:rooms.filter(r=>!r.geometry.polygon).length,labelCount: labels.length, groupedRoomCount:rooms.filter(r=>r.geometry.groupLabel).length, fillRegionCount:supportedFills.length, assemblyCount: assemblies.length, wallCount:walls.length,
    retainedWallCount:walls.filter(w=>w.geometry.constructionState==="retained").length,demolishedWallCount:walls.filter(w=>w.geometry.constructionState==="demolished").length,splitFillCount:splitSources.size,highEvidenceWallCount:walls.filter(w=>w.geometry.classification.evidenceTier==="high").length,mediumEvidenceWallCount:walls.filter(w=>w.geometry.classification.evidenceTier==="medium").length,
    fragmentAssemblyCount:fragmentAssemblies.length, unsupportedFootprintCount:fragmentIndexes.length, sourceFootprintCount: footprints.length, supplementaryBarrierCount: 0, alternativeBarrierCount:supplementary.length, barrierScenario:"primary", apartmentDomainCount:unitFills.length, printedAreaCount: observations.size,
    areaRatioSampleCount:ratios.length,areaRatioMedian, resolution: n, closeRadius, openingCount:openings.length, furnitureGapCount, straightSeamCount:chordSeamCount, barrierLineCount:options.barrierLines?.length??0, doorSwingCount:options.doorSwings?.length??0, doorSwingSupportedOpeningCount:openings.filter(o=>o.doorSwingKey).length,
    openingEvidence:openings.slice(0,500).map(({sideProbes:_probes,...opening},o)=>({...opening,sides:openingSides[o].map(side=>typeof side==="number"?`topology-v5:${labels[side].sourceKey}`:side)})),
    metresPerPageHeight, scaleUse:metresPerPageHeight?"unreviewed_printed_scale_bounds_only":null,
    shapeQcAuditedCount:rooms.filter(room=>room.geometry.shapeQc).length, shapeOutlierCount:counts.shape_outlier,
    alternativeBarrierEvidence:supplementary.map(f=>({sourceKey:f.sourceKey,layerId:f.layerId,layerName:f.layerName,polygon:f.geometry.polygon,state:"unresolved_alternative"})),
    relationships: "Inferred only: openings are gaps between facing source wall ends, optionally supported by a door-swing arc. They close room segmentation and record which rooms they join; they are unreviewed and not verified doors, windows or traversable adjacency.",
    limitations: "Only primary construction fills constrain the selected scenario; alternative layers retain unresolved state provenance. Substantial unit-bearing fills establish hard owner domains. Gap closure affects segmentation only. Shared components use inferred area-guided geodesic partitions; this does not establish doors or room adjacency. Printed-scale QC is unreviewed source evidence. Missing strokes and open gaps remain uncertainty; failed regions remain anchors." } };
}

function insideFill(p:Point,fill:PlanFillRegion) {
  let inside=false;
  for(const ring of fill.rings)for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}
  return inside;
}

export const footprintRings = (footprint: PlanFootprint) => footprint.geometry.rings?.length ? footprint.geometry.rings : [footprint.geometry.polygon];

type Jamb = { footprint: number; vertical: boolean; at: number; from: number; to: number; facing: 1 | -1 };
export type PlanOpening = {
  sourceKey: string; kind: "jamb_pair" | "door_swing_jamb" | "door_swing_doorway"; wallAxis: "horizontal" | "vertical" | "oblique";
  sourceKeys: string[]; doorSwingKey: string | null; width: number; jambLength: number; widthToJamb: number;
  physicalWidthM: number | null; midpoint: Point; closure: ReturnType<typeof box>; sideProbes: [Point, Point];
  method: "facing_wall_ends" | "door_swing_geometry"; segmentationOnly: true; sourcePolygonsExact: true; status: "unreviewed";
};

/**
 * Find openings as gaps between two facing wall ends ("jambs") of any source
 * construction polygon, or between one jamb and the far side of a door-swing
 * arc hinged on it. Geometry is evaluated in page-height units (x scaled by the
 * page aspect ratio) so horizontal and vertical gaps are compared alike.
 */
export function detectOpenings(footprints: PlanFootprint[], doorSwings: PlanDoorSwing[], wall: Uint8Array, n: number, aspect: number, metresPerPageHeight: number | null): PlanOpening[] {
  const rings = footprints.map(f => footprintRings(f).map(ring => ring.map(p => ({ x: p.x * aspect, y: p.y }))));
  const inside = (index: number, x: number, y: number) => {
    let winding = 0, parity = false;
    for (const ring of rings[index]) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) { parity = !parity; winding += a.y > b.y ? 1 : -1; }
    }
    return footprints[index].geometry.fillRule === "nonzero" ? winding !== 0 : parity;
  };
  const bounds = rings.map(r => box(r.flat()));
  const minJamb = .0008, maxJamb = .03, jambs: Jamb[] = [];
  rings.forEach((footprintRings, index) => {
    for (const ring of footprintRings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], vertical = Math.abs(a.x - b.x) < 1e-7, horizontal = Math.abs(a.y - b.y) < 1e-7;
      if (vertical === horizontal) continue;
      const at = vertical ? a.x : a.y, from = Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x), to = Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x), length = to - from;
      if (length < minJamb || length > maxJamb) continue;
      const probe = (along: number, across: number) => vertical ? inside(index, along, across) : inside(index, across, along);
      const mid = (from + to) / 2, delta = Math.min(length * .25, .0005);
      const plus = probe(at + delta, mid), minus = probe(at - delta, mid);
      if (plus === minus) continue;
      const facing: 1 | -1 = plus ? -1 : 1, body = at - facing * Math.min(length * .5, .004);
      // A wall end: the body behind the edge spans the full jamb and continues for at least one wall thickness.
      if (!probe(body, from + length * .15) || !probe(body, to - length * .15) || !probe(at - facing * length, mid)) continue;
      // A wall that butts into another construction fill (a T-junction) is not a free end.
      const outside = vertical ? { x: at + facing * delta, y: mid } : { x: mid, y: at + facing * delta };
      if (bounds.some((b, other) => other !== index && outside.x >= b.x && outside.x <= b.x + b.width && outside.y >= b.y && outside.y <= b.y + b.height && inside(other, outside.x, outside.y))) continue;
      jambs.push({ footprint: index, vertical, at, from, to, facing });
    }
  });
  const free = (rect: ReturnType<typeof box>) => {
    let total = 0, blocked = 0;
    const x0 = Math.ceil(rect.x / aspect * n), x1 = Math.floor((rect.x + rect.width) / aspect * n) - 1, y0 = Math.ceil(rect.y * n), y1 = Math.floor((rect.y + rect.height) * n) - 1;
    for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) { total++; blocked += wall[y * n + x]; }
    return total === 0 || blocked / total <= .2;
  };
  const maxWidth = (jamb: number) => metresPerPageHeight ? Math.min(3.2 / metresPerPageHeight, jamb * 14) : Math.min(.12, jamb * 14);
  const pairs: { a: Jamb; b: Jamb; gap: number; ratio: number; from: number; to: number }[] = [];
  for (const a of jambs) if (a.facing === 1) for (const b of jambs) {
    if (b.facing !== -1 || b.vertical !== a.vertical || b.at <= a.at) continue;
    const la = a.to - a.from, lb = b.to - b.from, lmin = Math.min(la, lb), lmax = Math.max(la, lb);
    const from = Math.max(a.from, b.from), to = Math.min(a.to, b.to), gap = b.at - a.at;
    if (lmax / lmin > 1.35 || to - from < lmin * .8 || gap > maxWidth(lmax)) continue;
    pairs.push({ a, b, gap, ratio: gap / lmin, from, to });
  }
  pairs.sort((p, q) => p.ratio - q.ratio || p.gap - q.gap);
  const used = new Set<Jamb>(), openings: PlanOpening[] = [];
  const swingFor = (jamb: Jamb, spanEnd: number) => doorSwings.find(swing => {
    const hinge = { x: swing.hinge.x * aspect, y: swing.hinge.y }, along = jamb.vertical ? hinge.x : hinge.y, across = jamb.vertical ? hinge.y : hinge.x;
    const thickness = jamb.to - jamb.from, tolerance = Math.max(thickness, .002), width = Math.abs(spanEnd - jamb.at);
    return Math.abs(along - jamb.at) <= tolerance && across >= jamb.from - tolerance && across <= jamb.to + tolerance
      && swing.radius >= width * .75 && swing.radius <= width * 1.25;
  });
  const make = (kind: PlanOpening["kind"], jamb: Jamb, end: number, from: number, to: number, others: Jamb[], swing: PlanDoorSwing | undefined): PlanOpening => {
    const low = Math.min(jamb.at, end), high = Math.max(jamb.at, end), width = high - low, thickness = to - from, middle = (from + to) / 2;
    const rect = jamb.vertical ? { x: low / aspect, y: from, width: width / aspect, height: thickness } : { x: from / aspect, y: low, width: thickness / aspect, height: width };
    const midpoint = jamb.vertical ? { x: (low + high) / 2 / aspect, y: middle } : { x: middle / aspect, y: (low + high) / 2 };
    const reach = thickness / 2 + 2 / n;
    const sideProbes: [Point, Point] = jamb.vertical ? [{ x: midpoint.x, y: middle - reach }, { x: midpoint.x, y: middle + reach }]
      : [{ x: (middle - reach * aspect) / aspect, y: midpoint.y }, { x: (middle + reach * aspect) / aspect, y: midpoint.y }];
    const sourceKeys = [...new Set([jamb, ...others].map(j => footprints[j.footprint].sourceKey))];
    return { sourceKey: `opening:${hash([...sourceKeys, `${midpoint.x.toFixed(6)},${midpoint.y.toFixed(6)}`])}`, kind,
      wallAxis: jamb.vertical ? "horizontal" : "vertical", sourceKeys, doorSwingKey: swing?.sourceKey ?? null, width, jambLength: thickness,
      widthToJamb: width / thickness, physicalWidthM: metresPerPageHeight ? width * metresPerPageHeight : null, midpoint, closure: rect, sideProbes,
      method: "facing_wall_ends", segmentationOnly: true, sourcePolygonsExact: true, status: "unreviewed" };
  };
  for (const pair of pairs) {
    if (used.has(pair.a) || used.has(pair.b)) continue;
    const rect = pair.a.vertical ? { x: pair.a.at, y: pair.from, width: pair.gap, height: pair.to - pair.from } : { x: pair.from, y: pair.a.at, width: pair.to - pair.from, height: pair.gap };
    if (!free(rect)) continue;
    used.add(pair.a); used.add(pair.b);
    openings.push(make("jamb_pair", pair.a, pair.b.at, pair.from, pair.to, [pair.b], swingFor(pair.a, pair.b.at) ?? swingFor(pair.b, pair.a.at)));
  }
  // A door hinged on a wall end whose far side meets a perpendicular wall face
  // has only one jamb. The arc radius bounds the gap; the grid finds its end.
  for (const swing of doorSwings) {
    if (openings.some(opening => opening.doorSwingKey === swing.sourceKey)) continue;
    const hinge = { x: swing.hinge.x * aspect, y: swing.hinge.y };
    for (const jamb of jambs) {
      if (used.has(jamb)) continue;
      const along = jamb.vertical ? hinge.x : hinge.y, across = jamb.vertical ? hinge.y : hinge.x, thickness = jamb.to - jamb.from, tolerance = Math.max(thickness, .002);
      if (Math.abs(along - jamb.at) > tolerance || across < jamb.from - tolerance || across > jamb.to + tolerance) continue;
      const ends = [swing.start, swing.end].map(p => ({ x: p.x * aspect, y: p.y }));
      if (!ends.some(end => Math.abs((jamb.vertical ? end.y : end.x) - across) < swing.radius * .2 && Math.sign((jamb.vertical ? end.x : end.y) - jamb.at) === jamb.facing)) continue;
      let end = jamb.at + jamb.facing * swing.radius;
      for (let step = .8; step <= 1.3; step += .5 / n / swing.radius) {
        const probe = jamb.at + jamb.facing * swing.radius * step, middle = (jamb.from + jamb.to) / 2;
        const x = Math.floor((jamb.vertical ? probe : middle) / aspect * n), y = Math.floor((jamb.vertical ? middle : probe) * n);
        if (x >= 0 && y >= 0 && x < n && y < n && wall[y * n + x]) { end = probe; break; }
      }
      const rect = jamb.vertical ? { x: Math.min(jamb.at, end), y: jamb.from, width: Math.abs(end - jamb.at), height: thickness } : { x: jamb.from, y: Math.min(jamb.at, end), width: thickness, height: Math.abs(end - jamb.at) };
      if (!free({ ...rect, ...(jamb.vertical ? { width: rect.width * .9, x: rect.x + (jamb.facing > 0 ? 0 : rect.width * .1) } : { height: rect.height * .9, y: rect.y + (jamb.facing > 0 ? 0 : rect.height * .1) }) })) continue;
      used.add(jamb);
      openings.push(make("door_swing_jamb", jamb, end, jamb.from, jamb.to, [], swing));
      break;
    }
  }
  return openings;
}

/**
 * Split one shared free-space region with straight, axis-aligned wall-to-wall
 * cuts (the way open-plan rooms are bounded on drawings: a line between two
 * wall ends). Cuts are chosen greedily by recursive bisection: each cut must
 * separate the remaining seeds, be at most 4.5 m long (or 6% of the page height
 * without a scale) and is scored by length plus deviation from printed areas.
 * Returns null when any group of seeds cannot be separated this way, so the
 * caller keeps the geodesic partition.
 */
function straightSeamPartition(component: Int32Array, id: number, region: { minX: number; minY: number; maxX: number; maxY: number; count: number; seeds: number[] },
  labels: PlanLabel[], n: number, aspect: number, metresPerPageHeight: number | null, observations: Map<string, { value: number }>) {
  const w = region.maxX - region.minX + 1, h = region.maxY - region.minY + 1;
  if (w * h > 250_000 || region.count > 120_000 || region.seeds.length > 12) return null;
  const local = (x: number, y: number) => (y - region.minY) * w + (x - region.minX);
  const inside = new Uint8Array(w * h);
  for (let y = region.minY; y <= region.maxY; y++) for (let x = region.minX; x <= region.maxX; x++) if (component[y * n + x] === id) inside[local(x, y)] = 1;
  const seedCell = (i: number) => { const r = labels[i].geometry.planRegion; return local(Math.min(n - 1, Math.floor((r.x + r.width / 2) * n)), Math.min(n - 1, Math.floor((r.y + r.height / 2) * n))); };
  const cellM = metresPerPageHeight ? metresPerPageHeight / n : null;
  const maxCells = (horizontal: boolean) => cellM ? 4.5 / (cellM * (horizontal ? aspect : 1)) : .06 * n / (horizontal ? aspect : 1);
  const minCells = (horizontal: boolean) => cellM ? .4 / (cellM * (horizontal ? aspect : 1)) : 3;
  const cellArea = cellM ? cellM * cellM * aspect : null;
  const printed = (i: number) => observations.get(labels[i].sourceKey)?.value;
  // Every maximal straight run of region cells bounded by non-region cells at both ends.
  const chords: { cells: number[]; length: number; horizontal: boolean }[] = [];
  for (const horizontal of [true, false]) {
    const lines = horizontal ? h : w, span = horizontal ? w : h;
    // Parallel runs with the same extent cut the region the same way; keep one every 4 cells.
    let previous = new Set<string>(), sinceKept = new Map<string, number>();
    for (let line = 0; line < lines; line++) {
      const current = new Set<string>();
      let start = -1;
      for (let t = 0; t <= span; t++) {
        const p = t < span ? (horizontal ? line * w + t : t * w + line) : -1, on = p >= 0 && inside[p] === 1;
        if (on && start < 0) start = t;
        if (!on && start >= 0) {
          const length = t - start;
          // The run must end at a real boundary inside the box, not at the box edge of an open region.
          const key = `${start}:${t}`; current.add(key);
          const repeat = previous.has(key) ? (sinceKept.get(key) ?? 0) + 1 : 0;
          if (repeat % 4 === 0 && length >= minCells(horizontal) && length <= maxCells(horizontal))
            chords.push({ cells: Array.from({ length }, (_, k) => horizontal ? line * w + start + k : (start + k) * w + line), length, horizontal });
          sinceKept.set(key, repeat);
          start = -1;
        }
      }
      previous = current;
    }
  }
  if (!chords.length || chords.length > 1500) return null;
  const owner = new Int32Array(w * h).fill(-1);
  const pieces = (cells: Uint8Array, cut: Set<number>) => {
    const piece = new Int32Array(w * h).fill(-1), sizes: number[] = [], stack: number[] = [];
    for (let start = 0; start < w * h; start++) {
      if (!cells[start] || cut.has(start) || piece[start] >= 0) continue;
      const k = sizes.length; let size = 0; piece[start] = k; stack.push(start);
      while (stack.length) { const p = stack.pop()!; size++; const x = p % w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < w * h && cells[q] && !cut.has(q) && piece[q] < 0) { piece[q] = k; stack.push(q); } }
      sizes.push(size);
    }
    return { piece, sizes };
  };
  let cuts = 0;
  const split = (cells: Uint8Array, seeds: number[]): boolean => {
    if (seeds.length === 1) { for (let p = 0; p < w * h; p++) if (cells[p]) owner[p] = seeds[0]; return true; }
    let best: { score: number; cut: Set<number>; piece: Int32Array; groups: number[][] } | null = null;
    for (const chord of chords) {
      if (!chord.cells.every(p => cells[p])) continue;
      const cut = new Set(chord.cells), { piece, sizes } = pieces(cells, cut);
      if (sizes.length < 2) continue;
      const groups = sizes.map(() => [] as number[]);
      if (seeds.some(i => cut.has(seedCell(i)) || piece[seedCell(i)] < 0)) continue;
      for (const i of seeds) groups[piece[seedCell(i)]].push(i);
      const seeded = groups.filter(g => g.length);
      if (seeded.length < 2) continue;
      // Area guidance: compare each side with the sum of its printed room areas.
      let areaError = 0;
      if (cellArea) for (let k = 0; k < sizes.length; k++) {
        if (!groups[k].length) continue;
        const values = groups[k].map(printed);
        if (values.every(v => v !== undefined)) { const target = values.reduce<number>((s, v) => s + v!, 0); areaError += Math.abs(sizes[k] * cellArea / target - 1); }
      }
      const lengthM = cellM ? chord.length * cellM * (chord.horizontal ? aspect : 1) : chord.length / n * 50;
      const score = lengthM + 4 * areaError;
      if (!best || score < best.score) best = { score, cut, piece, groups };
    }
    if (!best) return false;
    cuts++;
    // Seedless pockets and the cut line itself join the piece of the nearest seeded side.
    const seededPieces = best.groups.map((g, k) => g.length ? k : -1).filter(k => k >= 0);
    const assign = new Int32Array(w * h).fill(-1), queue: number[] = [];
    for (let p = 0; p < w * h; p++) if (cells[p] && best.piece[p] >= 0 && best.groups[best.piece[p]].length) { assign[p] = best.piece[p]; queue.push(p); }
    for (let head = 0; head < queue.length; head++) { const p = queue[head], x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < w * h && cells[q] && assign[q] < 0) { assign[q] = assign[p]; queue.push(q); } }
    return seededPieces.every(k => { const sub = new Uint8Array(w * h); for (let p = 0; p < w * h; p++) if (assign[p] === k) sub[p] = 1; return split(sub, best!.groups[k]); });
  };
  if (!split(inside, region.seeds.slice())) return null;
  // A straight cut that misses a printed room area badly is worse than the guided geodesic split.
  if (cellArea) for (const i of region.seeds) {
    const target = printed(i); if (target === undefined) continue;
    let cells = 0; for (let p = 0; p < w * h; p++) if (owner[p] === i) cells++;
    if (Math.abs(cells * cellArea / target - 1) > .3) return null;
  }
  const owners: [number, number][] = [];
  for (let p = 0; p < w * h; p++) if (owner[p] >= 0) owners.push([(region.minY + Math.floor(p / w)) * n + region.minX + p % w, owner[p]]);
  return { owners, cuts };
}

/**
 * Doors whose walls are drawn as outlines have no filled jambs. The swing arc
 * spans hinge → leaf end and hinge → closed end; the closed end lies across the
 * doorway, where the grid is free, while the leaf is drawn. Both radii are
 * closed in the segmentation grid (the leaf only protrudes into the room the
 * door swings into), and the doorway side records which rooms it joins.
 */
function strokeDoorways(swings: PlanDoorSwing[], wall: Uint8Array, n: number, aspect: number, metresPerPageHeight: number | null, drawLine: (target: Uint8Array, a: Point, b: Point) => void): PlanOpening[] {
  const blocked = (p: Point) => { const x = Math.floor(p.x * n), y = Math.floor(p.y * n); return x < 0 || y < 0 || x >= n || y >= n || wall[y * n + x] === 1; };
  const along = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const hits = (a: Point, b: Point) => [.2, .35, .5, .65, .8].filter(t => blocked(along(a, b, t))).length;
  const openings: PlanOpening[] = [];
  for (const swing of swings) {
    const widthM = metresPerPageHeight ? swing.radius * metresPerPageHeight : null;
    if (widthM !== null && (widthM < .5 || widthM > 1.6)) continue;
    const { hinge } = swing, [hs, he] = [hits(hinge, swing.start), hits(hinge, swing.end)];
    // A doorway needs a wall at the hinge: some barrier within two cells.
    let anchored = false;
    for (let dy = -2; dy <= 2 && !anchored; dy++) for (let dx = -2; dx <= 2 && !anchored; dx++) anchored = blocked({ x: hinge.x + dx / n, y: hinge.y + dy / n });
    if (!anchored) continue;
    // Closing both radii is safe: the leaf radius only protrudes into one room.
    const extend = (p: Point) => { const d = Math.hypot((p.x - hinge.x) * aspect, p.y - hinge.y) || 1; return along(hinge, p, 1 + 2 / n / d); };
    drawLine(wall, hinge, extend(swing.start)); drawLine(wall, hinge, extend(swing.end));
    if (hs === he) continue;
    const [doorway, leaf] = hs < he ? [swing.start, swing.end] : [swing.end, swing.start];
    const midpoint = along(hinge, doorway, .5), dx = (doorway.x - hinge.x) * aspect, dy = doorway.y - hinge.y, length = Math.hypot(dx, dy);
    // Unit normal in page-height units, pointing to the side the door swings into.
    let nx = -dy / length, ny = dx / length;
    if (nx * (leaf.x - hinge.x) * aspect + ny * (leaf.y - hinge.y) < 0) { nx = -nx; ny = -ny; }
    const offset = (d: number) => ({ x: midpoint.x + nx * d / aspect, y: midpoint.y + ny * d });
    let far = offset(-swing.radius * .4);
    for (let d = 2 / n; d <= swing.radius; d += .5 / n) if (!blocked(offset(-d))) { far = offset(-d); break; }
    const box0 = box([hinge, doorway]);
    const wallAxis = Math.abs(dx) < length * .05 ? "vertical" as const : Math.abs(dy) < length * .05 ? "horizontal" as const : "oblique" as const;
    openings.push({ sourceKey: `opening:${hash([swing.sourceKey])}`, kind: "door_swing_doorway", wallAxis, sourceKeys: [], doorSwingKey: swing.sourceKey,
      width: length, jambLength: 0, widthToJamb: 0, physicalWidthM: widthM, midpoint, closure: box0, sideProbes: [offset(swing.radius * .4), far],
      method: "door_swing_geometry", segmentationOnly: true, sourcePolygonsExact: true, status: "unreviewed" });
  }
  return openings;
}

/** Trace a grid region into rings. Pinch vertices (cells touching only at a
 * corner) take the right-hand turn, matching the 4-connected regions, so they
 * never break tracing. Outer rings are clockwise on the page (y down), holes
 * counter-clockwise; disconnected parts are counted, not merged. */
export function traceRegion(grid: Int32Array, n: number, id: number, region: { minX: number; minY: number; maxX: number; maxY: number }) {
  const edges = new Map<number, number[]>(), key = (x: number, y: number) => y * (n + 1) + x;
  const step = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const add = (x: number, y: number, dir: number) => { const k = key(x, y), list = edges.get(k); if (list) list.push(dir); else edges.set(k, [dir]); };
  for (let y = region.minY; y <= region.maxY; y++) for (let x = region.minX; x <= region.maxX; x++) {
    const p = y * n + x; if (grid[p] !== id) continue;
    if (!y || grid[p - n] !== id) add(x, y, 0);
    if (x === n - 1 || grid[p + 1] !== id) add(x + 1, y, 1);
    if (y === n - 1 || grid[p + n] !== id) add(x + 1, y + 1, 2);
    if (!x || grid[p - 1] !== id) add(x, y + 1, 3);
  }
  const rings: { points: Point[]; signedArea: number }[] = [];
  const take = (k: number, dir: number) => { const list = edges.get(k)!; list.splice(list.indexOf(dir), 1); if (!list.length) edges.delete(k); };
  while (edges.size) {
    let start = -1;
    for (const [k, list] of edges) if (list.length === 1) { start = k; break; }
    if (start < 0) start = edges.keys().next().value as number;
    let current = start, dir = edges.get(start)![0];
    const points: Point[] = [];
    for (let guard = 0; guard <= 4 * (n + 1) * (n + 1); guard++) {
      take(current, dir);
      const x = current % (n + 1), y = Math.floor(current / (n + 1));
      points.push({ x: x / n, y: y / n });
      current = key(x + step[dir][0], y + step[dir][1]);
      const options = edges.get(current);
      if (current === start && (!options || !options.includes((dir + 1) % 4) || options.length === 0)) break;
      if (!options) return null;
      const next = [(dir + 1) % 4, dir, (dir + 3) % 4].find(candidate => options.includes(candidate));
      if (next === undefined) return null;
      dir = next;
    }
    if (current !== start) return null;
    const simplified = points.filter((p, i) => { const a = points[(i + points.length - 1) % points.length], b = points[(i + 1) % points.length]; return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y)); });
    const signedArea = simplified.reduce((sum, p, i) => { const q = simplified[(i + 1) % simplified.length]; return sum + p.x * q.y - q.x * p.y; }, 0) / 2;
    rings.push({ points: simplified, signedArea });
  }
  const outers = rings.filter(ring => ring.signedArea > 0).sort((a, b) => b.signedArea - a.signedArea);
  if (!outers.length) return null;
  const polygon = outers[0].points, fill = { rings: [polygon] } as PlanFillRegion;
  const holes = rings.filter(ring => ring.signedArea < 0 && insideFill({ x: ring.points[0].x + 1e-9, y: ring.points[0].y + 1e-9 }, fill)).map(ring => ring.points);
  return { polygon, holes, detachedPartCount: outers.length - 1 };
}
