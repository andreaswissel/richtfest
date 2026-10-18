import type { LocationBuilding, LocationTree, LocationTreeDetection } from "@richtfest/shared";

/** Deterministic single-tree detection from an airborne LiDAR canopy height model.
 * Version the method id whenever thresholds change so stored detections stay explainable. */
export const TREE_DETECTION_METHOD = "lidar-chm-maxima-v1";
const VEGETATION = new Set([3, 4, 5]);
const CELL = 1, MIN_CANOPY = 2, MIN_TREE = 3, MIN_ROUGHNESS = 0.35, BUILDING_BUFFER = 1, MIN_CROWN_AREA = 7, MAX_TREES = 400;

/** Streaming 1 m grid over the site crop: local ground (class 2) and vegetation-labelled returns
 * (3/4/5). Berlin ALS 2021 labels roofs as class 5 too, hence the footprint mask and roughness gate. */
export class CanopyGrid {
  readonly size: number;
  readonly groundSum: Float64Array; readonly groundCount: Uint32Array;
  readonly top: Float64Array; readonly sum: Float64Array; readonly sumSq: Float64Array; readonly count: Uint32Array;
  constructor(readonly radius: number) {
    this.size = Math.ceil((2 * radius) / CELL);
    const n = this.size * this.size;
    this.groundSum = new Float64Array(n); this.groundCount = new Uint32Array(n);
    this.top = new Float64Array(n).fill(-Infinity); this.sum = new Float64Array(n); this.sumSq = new Float64Array(n); this.count = new Uint32Array(n);
  }
  index(x: number, z: number) {
    const i = Math.floor((x + this.radius) / CELL), j = Math.floor((z + this.radius) / CELL);
    return i < 0 || j < 0 || i >= this.size || j >= this.size ? -1 : j * this.size + i;
  }
  centre(index: number): [number, number] {
    return [(index % this.size + 0.5) * CELL - this.radius, (Math.floor(index / this.size) + 0.5) * CELL - this.radius];
  }
  /** Local X/Z metres and absolute elevation, same frame as the point cloud crop. */
  add(x: number, z: number, elevation: number, classification: number) {
    const c = this.index(x, z);
    if (c < 0) return;
    if (classification === 2) { this.groundSum[c]! += elevation; this.groundCount[c]!++; return; }
    if (!VEGETATION.has(classification)) return;
    if (elevation > this.top[c]!) this.top[c] = elevation;
    this.sum[c]! += elevation; this.sumSq[c]! += elevation * elevation; this.count[c]!++;
  }
}

/** Ground per cell, holes (under roofs, dense crowns) filled from neighbours, then the global median. */
function groundModel(grid: CanopyGrid) {
  const { size } = grid, n = size * size, ground = new Float64Array(n).fill(NaN);
  const known: number[] = [];
  for (let c = 0; c < n; c++) if (grid.groundCount[c]) { ground[c] = grid.groundSum[c]! / grid.groundCount[c]!; known.push(ground[c]!); }
  if (!known.length) return null;
  known.sort((a, b) => a - b);
  for (let pass = 0; pass < 40; pass++) {
    const next = ground.slice();
    let missing = 0;
    for (let c = 0; c < n; c++) {
      if (!Number.isNaN(ground[c]!)) continue;
      const i = c % size, j = Math.floor(c / size);
      let s = 0, k = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
        const v = ground[jj * size + ii]!;
        if (!Number.isNaN(v)) { s += v; k++; }
      }
      if (k) next[c] = s / k; else missing++;
    }
    ground.set(next);
    if (!missing) break;
  }
  const median = known[Math.floor(known.length / 2)]!;
  for (let c = 0; c < n; c++) if (Number.isNaN(ground[c]!)) ground[c] = median;
  return ground;
}

function insideRing(x: number, z: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!, [xj, zj] = ring[j]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function edgeDistance(x: number, z: number, ring: [number, number][]) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j]!, [bx, bz] = ring[i]!, dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz;
    const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}
/** Cells on or within BUILDING_BUFFER of an official building footprint (eaves, balconies, walls). */
function buildingMask(grid: CanopyGrid, buildings: LocationBuilding[]) {
  const mask = new Uint8Array(grid.size * grid.size);
  for (const building of buildings) for (const polygon of building.polygons) {
    const outer = polygon[0];
    if (!outer?.length) continue;
    const xs = outer.map(p => p[0]), zs = outer.map(p => p[1]);
    const [x0, x1, z0, z1] = [Math.min(...xs) - BUILDING_BUFFER, Math.max(...xs) + BUILDING_BUFFER, Math.min(...zs) - BUILDING_BUFFER, Math.max(...zs) + BUILDING_BUFFER];
    for (let z = Math.floor(z0) + 0.5; z <= z1; z += CELL) for (let x = Math.floor(x0) + 0.5; x <= x1; x += CELL) {
      const c = grid.index(x, z);
      if (c < 0 || mask[c]) continue;
      const inside = insideRing(x, z, outer) && !polygon.slice(1).some(hole => insideRing(x, z, hole) && edgeDistance(x, z, hole) > BUILDING_BUFFER);
      if (inside || polygon.some(ring => edgeDistance(x, z, ring) <= BUILDING_BUFFER)) mask[c] = 1;
    }
  }
  return mask;
}

/** Canopy height model -> local maxima seeds -> height-ordered crown growth. Trees whose crown
 * contains, or whose position is near, an official cadastre tree are dropped as duplicates. */
export function detectTrees(grid: CanopyGrid, context: { buildings: LocationBuilding[]; trees: LocationTree[] }): LocationTree[] {
  const ground = groundModel(grid);
  if (!ground) return [];
  const { size } = grid, n = size * size, mask = buildingMask(grid, context.buildings);
  const raw = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    const k = grid.count[c]!;
    if (!k || mask[c]) continue;
    const h = grid.top[c]! - ground[c]!;
    const mean = grid.sum[c]! / k, spread = Math.sqrt(Math.max(0, grid.sumSq[c]! / k - mean * mean));
    // Leaf-off crowns scatter returns through branches; roofs and slabs stay flat.
    if (h >= MIN_CANOPY && (k < 3 || spread >= MIN_ROUGHNESS)) raw[c] = h;
  }
  // Fill single-cell gaps inside sparse leaf-off crowns, then smooth with a 3x3 binomial kernel.
  const filled = raw.slice();
  for (let c = 0; c < n; c++) {
    if (raw[c] || mask[c]) continue;
    const i = c % size, j = Math.floor(c / size);
    let s = 0, k = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if ((di || dj) && ii >= 0 && jj >= 0 && ii < size && jj < size && raw[jj * size + ii]) { s += raw[jj * size + ii]!; k++; }
    }
    if (k >= 5) filled[c] = s / k;
  }
  const chm = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    if (!filled[c]) continue;
    const i = c % size, j = Math.floor(c / size);
    let s = 0, w = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
      const v = filled[jj * size + ii]!, weight = (2 - Math.abs(di)) * (2 - Math.abs(dj));
      if (v) { s += v * weight; w += weight; }
    }
    chm[c] = s / w;
  }
  // Seeds: strict local maxima within a height-dependent window (taller trees, wider crowns).
  const seeds: number[] = [];
  for (let c = 0; c < n; c++) {
    const h = chm[c]!;
    if (h < MIN_TREE) continue;
    const i = c % size, j = Math.floor(c / size), w = Math.min(5, Math.max(2, 1.5 + 0.1 * h)), r = Math.ceil(w / CELL);
    let peak = true;
    for (let dj = -r; dj <= r && peak; dj++) for (let di = -r; di <= r; di++) {
      if ((!di && !dj) || Math.hypot(di, dj) * CELL > w) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
      const v = chm[jj * size + ii]!, d = jj * size + ii;
      if (v > h || (v === h && d < c)) { peak = false; break; }
    }
    if (peak) seeds.push(c);
  }
  // Marker-controlled growth: highest cells first, each joins the neighbouring crown it drains to.
  const label = new Int32Array(n).fill(-1);
  seeds.forEach((c, k) => { label[c] = k; });
  const order = Array.from({ length: n }, (_, c) => c).filter(c => chm[c]! >= MIN_CANOPY && label[c] < 0).sort((a, b) => chm[b]! - chm[a]! || a - b);
  for (let changed = true, pass = 0; changed && pass < 50; pass++) {
    changed = false;
    for (const c of order) {
      if (label[c]! >= 0) continue;
      const i = c % size, j = Math.floor(c / size);
      let best = -1, bestHeight = -Infinity;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if ((!di && !dj) || ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
        const d = jj * size + ii, k = label[d]!;
        if (k < 0 || chm[d]! < chm[c]! - 0.5 || chm[d]! <= bestHeight) continue;
        const seed = seeds[k]!, peak = chm[seed]!, [sx, sz] = grid.centre(seed), [x, z] = grid.centre(c);
        if (chm[c]! < 0.35 * peak || Math.hypot(x - sx, z - sz) > Math.min(10, Math.max(2, 1.5 + 0.3 * peak))) continue;
        best = k; bestHeight = chm[d]!;
      }
      if (best >= 0) { label[c] = best; changed = true; }
    }
  }
  const crowns = seeds.map(() => ({ cells: [] as number[] }));
  for (let c = 0; c < n; c++) if (label[c]! >= 0) crowns[label[c]!]!.cells.push(c);
  const detected: LocationTree[] = [];
  for (const [k, crown] of crowns.entries()) {
    const height = Math.max(...crown.cells.map(c => raw[c]! || chm[c]!));
    const area = crown.cells.length * CELL * CELL;
    // Under ~3 m crown width the real Berlin data is mostly shrubs, posts and roof furniture.
    if (area < MIN_CROWN_AREA || height < MIN_TREE) continue;
    const points = crown.cells.map(c => grid.centre(c));
    const x = points.reduce((s, p) => s + p[0], 0) / points.length, z = points.reduce((s, p) => s + p[1], 0) / points.length;
    const reach = Math.max(...points.map(p => Math.hypot(p[0] - x, p[1] - z))) + CELL / 2;
    // Hedges and wall/fence slivers along footprints are elongated, not crown-shaped.
    if (area < 0.3 * Math.PI * reach * reach) continue;
    // Partly covered edge cells count whole, sparse leaf-off crown edges are missed: half a cell off.
    const diameter = 2 * Math.sqrt(area / Math.PI) - CELL / 2;
    const cells = new Set(crown.cells);
    const duplicate = context.trees.some(tree => {
      const c = grid.index(tree.position[0], tree.position[1]);
      return (c >= 0 && cells.has(c)) || Math.hypot(tree.position[0] - x, tree.position[1] - z) <= Math.max(3, 0.5 * Math.max(diameter, tree.crownDiameter ?? 0));
    });
    if (duplicate) continue;
    const position: [number, number] = [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
    const id = `lidar:${TREE_DETECTION_METHOD}:${position[0]}:${position[1]}`;
    detected.push({ id, sourceId: id, position, height: Math.round(height * 10) / 10, crownDiameter: Math.round(diameter * 10) / 10, species: "", provenance: "lidar-detected" });
  }
  return detected.sort((a, b) => b.height! - a.height! || a.id.localeCompare(b.id)).slice(0, MAX_TREES);
}

/** Re-applies cadastre dedupe after a public-data refresh changed the official tree list. */
export function withoutCadastreDuplicates(detection: LocationTreeDetection, cadastre: LocationTree[]): LocationTreeDetection {
  return { ...detection, trees: detection.trees.filter(tree => !cadastre.some(official =>
    Math.hypot(official.position[0] - tree.position[0], official.position[1] - tree.position[1]) <= Math.max(3, 0.5 * Math.max(tree.crownDiameter ?? 0, official.crownDiameter ?? 0)))) };
}
