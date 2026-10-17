import { deflateSync, inflateSync } from "node:zlib";
import { traceRegion } from "./plan-topology";

type Point = { x: number; y: number };
export type PageScale = { pageAspectRatio: number; metresPerPageHeight: number | null };
export const selectionMaskEncoding = "deflate-u8-v1";

export const encodeSelectionMask = (cells: Uint8Array) => deflateSync(cells, { level: 6 }).toString("base64");
export function decodeSelectionMask(data: string, gridSize: number) {
  const cells = new Uint8Array(inflateSync(Buffer.from(data, "base64")));
  if (cells.length !== gridSize * gridSize) throw new Error("Selection mask size mismatch");
  return cells;
}

const ringArea = (ring: Point[]) => Math.abs(ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
/** Area of an outline in m² at the page's printed scale, or null without a scale. */
export function outlineAreaM2(polygon: Point[], holes: Point[][], scale: PageScale) {
  if (!scale.metresPerPageHeight) return null;
  const normalized = ringArea(polygon) - holes.reduce((sum, hole) => sum + ringArea(hole), 0);
  return Math.round(normalized * scale.pageAspectRatio * scale.metresPerPageHeight ** 2 * 100) / 100;
}

/** Simplify a traced (rectilinear, corner-only) ring for editing. Shallow bumps such as
 * reveals, niches and door recesses leave two or three corners off the wall line; they are
 * removed together so no diagonal remains, then near-collinear corners (grid staircases on
 * slanted walls) collapse. Distances are in page-height units so x and y weigh the same. */
export function simplifyRing(ring: Point[], tolerance: number, aspect: number) {
  const distance = (p: Point, a: Point, b: Point) => {
    const ax = a.x * aspect, ay = a.y, bx = b.x * aspect, by = b.y, px = p.x * aspect, py = p.y;
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const result = [...ring];
  for (const [run, limit] of [[3, tolerance], [2, tolerance], [1, tolerance / 2]] as const)
    for (let changed = true; changed && result.length > run + 2;) {
      changed = false;
      for (let i = 0; i < result.length && result.length > run + 2; i++) {
        const previous = result[(i + result.length - 1) % result.length], next = result[(i + run) % result.length];
        // A bump must return to the same wall line; otherwise removing it would cut a diagonal.
        if (run > 1 && Math.abs(previous.x - next.x) * aspect > limit && Math.abs(previous.y - next.y) > limit) continue;
        if (!Array.from({ length: run }, (_, k) => result[(i + k) % result.length]).every(p => distance(p, previous, next) <= limit)) continue;
        for (let k = 0; k < run; k++) result.splice(i < result.length ? i : 0, 1);
        changed = true;
      }
    }
  return result.length >= 3 ? result : ring;
}

export type MagicOutline = { scope: "room" | "space" | "construction"; polygon: Point[]; holes: Point[][]; areaM2: number | null; cellCount: number };
export type MagicSelection = { status: "found"; options: MagicOutline[] } | { status: "on_barrier" | "not_enclosed" };

/** Flood-fill the outlines around a clicked point inside the stored segmentation barriers,
 * smallest first: the extractor's room (seams between rooms in one open space count),
 * the whole enclosed space (seams ignored), and, where the floor fill does not reach,
 * the space bounded by construction alone. Distinct results become options to choose from. */
export function magicSelection(cells: Uint8Array, n: number, point: Point, scale: PageScale): MagicSelection {
  const size = n * n, cx = Math.min(n - 1, Math.max(0, Math.floor(point.x * n))), cy = Math.min(n - 1, Math.max(0, Math.floor(point.y * n)));
  const maxCells = size * .25, options: MagicOutline[] = [];
  let blockedEverywhere = true;
  for (const [scope, flags] of [["room", 7], ["space", 3], ["construction", 2]] as const) {
    if (scope === "construction" && options.length) break;
    const blocked = (p: number) => (cells[p] & flags) !== 0;
    // Clicks on a thin wall or label stroke snap to the nearest free cell nearby.
    let start = -1;
    for (let r = 0; r <= 4 && start < 0; r++) for (let dy = -r; dy <= r && start < 0; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < n && y < n && !blocked(y * n + x)) { start = y * n + x; break; }
    }
    if (start < 0) continue;
    blockedEverywhere = false;
    const region = new Int32Array(size).fill(-1), stack = [start];
    region[start] = 1;
    let count = 0, leaked = false, minX = n, minY = n, maxX = 0, maxY = 0;
    while (stack.length) {
      const p = stack.pop()!, x = p % n, y = (p - x) / n;
      count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (x === 0 || y === 0 || x === n - 1 || y === n - 1 || count > maxCells) { leaked = true; break; }
      for (const q of [x > 0 ? p - 1 : -1, x < n - 1 ? p + 1 : -1, y > 0 ? p - n : -1, y < n - 1 ? p + n : -1])
        if (q >= 0 && region[q] < 0 && !blocked(q)) { region[q] = 1; stack.push(q); }
    }
    if (leaked || options.some(option => option.cellCount === count)) continue;
    // Close slits that door leaves and stray strokes cut into the room (up to 4 cells wide).
    const r = 2, box = { minX: Math.max(0, minX - r), minY: Math.max(0, minY - r), maxX: Math.min(n - 1, maxX + r), maxY: Math.min(n - 1, maxY + r) };
    closeRegion(region, n, box, r);
    const traced = traceRegion(region, n, 1, box);
    if (!traced) continue;
    // Drop reveals and niches shallower than ~15 cm so the outline keeps only real corners.
    const cellM = scale.metresPerPageHeight ? scale.metresPerPageHeight / n : null;
    const tolerance = Math.min(6, Math.max(1.5, cellM ? .15 / cellM : 2)) / n, outer = simplifyRing(traced.polygon, tolerance, scale.pageAspectRatio);
    const outerArea = ringArea(outer);
    // Columns and shafts stay as holes; label strokes and symbols are noise.
    const holes = traced.holes.filter(hole => ringArea(hole) >= outerArea * .005).map(hole => simplifyRing(hole, tolerance, scale.pageAspectRatio));
    options.push({ scope, polygon: outer, holes, areaM2: outlineAreaM2(outer, holes, scale), cellCount: count });
  }
  return options.length ? { status: "found", options } : { status: blockedEverywhere ? "on_barrier" : "not_enclosed" };
}

/** Morphological closing (dilate, then erode) of grid id 1 within a box, square radius r. */
function closeRegion(grid: Int32Array, n: number, box: { minX: number; minY: number; maxX: number; maxY: number }, r: number) {
  const w = box.maxX - box.minX + 1, h = box.maxY - box.minY + 1;
  let local = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) local[y * w + x] = grid[(y + box.minY) * n + x + box.minX] === 1 ? 1 : 0;
  const pass = (input: Uint8Array, horizontal: boolean, dilate: boolean) => {
    const output = new Uint8Array(w * h), lines = horizontal ? h : w, length = horizontal ? w : h;
    for (let line = 0; line < lines; line++) for (let i = 0; i < length; i++) {
      let any = 0, all = 1;
      for (let k = Math.max(0, i - r); k <= Math.min(length - 1, i + r); k++) { const v = input[horizontal ? line * w + k : k * w + line]; any |= v; all &= v; }
      output[horizontal ? line * w + i : i * w + line] = dilate ? any : all;
    }
    return output;
  };
  local = pass(pass(pass(pass(local, true, true), false, true), true, false), false, false);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (local[y * w + x]) grid[(y + box.minY) * n + x + box.minX] = 1;
}

/** An outline a planner may save: 3–1000 points on the page, positive area, no self-crossing edges. */
export function outlineProblem(polygon: Point[]) {
  if (polygon.length < 3) return "An outline needs at least three points";
  if (polygon.some(p => p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1)) return "Outline points must lie on the page";
  if (ringArea(polygon) < 1e-7) return "The outline has no area";
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const m = polygon.length;
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
    if (j === i + 1 || (i === 0 && j === m - 1)) continue;
    const a = polygon[i], b = polygon[(i + 1) % m], c = polygon[j], d = polygon[(j + 1) % m];
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return "Outline edges must not cross";
  }
  return null;
}
