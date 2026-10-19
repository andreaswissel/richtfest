import { createHash } from "node:crypto";
import type { PlanBarrierLine, PlanFootprint } from "./plan-footprints";
import { runsOnGrid, type WallRun } from "./plan-wall-runs";

type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

export const outlineWallMethod = "outline_wall_body_v1";

/** A stroked straight segment of the plan, page-normalised, with its pen colour. */
export type PenSegment = { a: Point; b: Point; colour: string | null };

/**
 * The pens that draw walls on a plan without layers. Doors are drawn with the
 * wall pen, so the colour of most door swings is the wall pen. A second colour
 * counts too when its segments often end where wall-pen segments end (existing
 * walls joining new ones); dimension lines, furniture and hatching rarely do.
 */
export function wallPens(segments: PenSegment[], doorSwingColours: Array<string | null>) {
  const counts = new Map<string, number>();
  for (const colour of doorSwingColours) if (colour) counts.set(colour, (counts.get(colour) ?? 0) + 1);
  const primary = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!primary) return [];
  const cell = .0004, key = (p: Point) => `${Math.round(p.x / cell)},${Math.round(p.y / cell)}`;
  const ends = new Set<string>();
  for (const s of segments) if (s.colour === primary) for (const p of [s.a, s.b]) ends.add(key(p));
  const near = (p: Point) => { const x = Math.round(p.x / cell), y = Math.round(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (ends.has(`${x + dx},${y + dy}`)) return true; return false; };
  const touching = new Map<string, { n: number; total: number }>();
  for (const s of segments) {
    if (!s.colour || s.colour === primary) continue;
    const entry = touching.get(s.colour) ?? { n: 0, total: 0 }; entry.total++;
    if (near(s.a) || near(s.b)) entry.n++;
    touching.set(s.colour, entry);
  }
  const secondary = [...touching.entries()].filter(([, v]) => v.n >= 20 && v.n / v.total >= .05).map(([colour]) => colour);
  return [primary, ...secondary];
}

export type OutlineWall = WallRun & { componentPixels: number };

/**
 * Walls of a plan whose walls are drawn as outlines (a flattened print, no
 * construction layer). The wall pen's segments are rastered; each enclosed
 * region between them that is thin and splits cleanly into straight runs, and
 * that borders a room (a labelled region, or an enclosed one of room size), is a wall body. Its runs are the walls.
 * Rooms, door swings, stair flights and dimension strips fail one of the
 * tests: too wide, not rectilinear, or bordering no room. Page-normalised in
 * and out; thicknesses in page heights.
 */
export function outlineWalls(input: { segments: Array<{ a: Point; b: Point }>; aspect: number; roomLabels: Box[];
  resolution?: number; maxThickness?: number; minThickness?: number }) {
  const H = Math.max(500, Math.min(6000, Math.round(input.resolution ?? 3000))), aspect = input.aspect > 0 ? input.aspect : 1, W = Math.ceil(H * aspect);
  const maxT = (input.maxThickness ?? .025) * H, minT = (input.minThickness ?? .0012) * H;
  const line = new Uint8Array(W * H);
  for (const { a, b } of input.segments) {
    const ax = a.x * W, ay = a.y * H, bx = b.x * W, by = b.y * H, steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2));
    for (let t = 0; t <= steps; t++) {
      const x = Math.floor(ax + (bx - ax) * t / steps), y = Math.floor(ay + (by - ay) * t / steps);
      if (x >= 0 && y >= 0 && x < W && y < H) line[y * W + x] = 1;
    }
  }
  // Regions between the lines, 4-connected; one touching the page edge is outside.
  const region = new Int32Array(W * H).fill(-1), stack = new Int32Array(W * H);
  const regions: Array<{ pixels: number; minX: number; minY: number; maxX: number; maxY: number; outside: boolean }> = [];
  for (let p = 0; p < W * H; p++) {
    if (line[p] || region[p] >= 0) continue;
    const id = regions.length, r = { pixels: 0, minX: W, minY: H, maxX: 0, maxY: 0, outside: false }; regions.push(r);
    let sp = 0; stack[sp++] = p; region[p] = id;
    while (sp) {
      const q = stack[--sp]!, x = q % W, y = (q - x) / W; r.pixels++;
      if (x < r.minX) r.minX = x; if (x > r.maxX) r.maxX = x; if (y < r.minY) r.minY = y; if (y > r.maxY) r.maxY = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) r.outside = true;
      if (x > 0 && !line[q - 1] && region[q - 1]! < 0) { region[q - 1] = id; stack[sp++] = q - 1; }
      if (x < W - 1 && !line[q + 1] && region[q + 1]! < 0) { region[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0 && !line[q - W] && region[q - W]! < 0) { region[q - W] = id; stack[sp++] = q - W; }
      if (y < H - 1 && !line[q + W] && region[q + W]! < 0) { region[q + W] = id; stack[sp++] = q + W; }
    }
  }
  const rooms = new Set<number>();
  for (const label of input.roomLabels) {
    const x = Math.floor((label.x + label.width / 2) * W), y = Math.floor((label.y + label.height / 2) * H);
    const id = x >= 0 && y >= 0 && x < W && y < H ? region[y * W + x]! : -1;
    if (id >= 0 && !regions[id]!.outside) rooms.add(id);
  }
  // Unlabelled enclosed spaces of room size and compact shape count as rooms too (labels are often
  // missing on prints); a ring of walls around a building is large but not compact.
  for (const [id, r] of regions.entries()) if (!r.outside && Math.min(r.maxX - r.minX + 1, r.maxY - r.minY + 1) >= maxT * 1.5 && r.pixels >= maxT * maxT * 9
    && r.pixels >= (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1) * .3) rooms.add(id);
  const reach = 3;
  const walls: OutlineWall[] = [];
  let rejected = 0;
  for (const [id, r] of regions.entries()) {
    if (r.outside || rooms.has(id) || r.pixels < 4) continue;
    // Borders a labelled room across one outline.
    let bordersRoom = false;
    for (let y = r.minY; y <= r.maxY && !bordersRoom; y++) for (let x = r.minX; x <= r.maxX && !bordersRoom; x++) {
      if (region[y * W + x] !== id) continue;
      for (const [dx, dy] of [[reach, 0], [-reach, 0], [0, reach], [0, -reach]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && rooms.has(region[ny * W + nx]!)) { bordersRoom = true; break; }
      }
    }
    if (!bordersRoom) { rejected++; continue; }
    // Compress the region to a grid at the columns and rows where it starts or stops.
    const xsSet = new Set<number>([r.minX, r.maxX + 1]), ysSet = new Set<number>([r.minY, r.maxY + 1]);
    for (let y = r.minY; y <= r.maxY; y++) for (let x = r.minX; x <= r.maxX + 1; x++) {
      const here = x <= r.maxX && region[y * W + x] === id, before = x > r.minX && region[y * W + x - 1] === id;
      if (here !== before) xsSet.add(x);
    }
    for (let x = r.minX; x <= r.maxX; x++) for (let y = r.minY; y <= r.maxY + 1; y++) {
      const here = y <= r.maxY && region[y * W + x] === id, before = y > r.minY && region[(y - 1) * W + x] === id;
      if (here !== before) ysSet.add(y);
    }
    const xs = [...xsSet].sort((a, b) => a - b), ys = [...ysSet].sort((a, b) => a - b);
    if ((xs.length - 1) * (ys.length - 1) > 40000) { rejected++; continue; }
    const inside: boolean[] = [];
    for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) inside.push(region[ys[j]! * W + xs[i]!] === id);
    // Grid in pixels; the line itself belongs to the wall, so runs grow by one pixel all round.
    const split = runsOnGrid(xs, ys, inside, maxT, 1);
    const runs = split.runs.filter(run => run.thickness >= minT && run.length >= Math.max(1.5 * run.thickness, minT * 3));
    const covered = runs.reduce((sum, run) => sum + run.rect.width * run.rect.height, 0);
    if (!runs.length || covered < r.pixels * .85) { rejected++; continue; }
    for (const run of runs) {
      const x = run.rect.x - 1, y = run.rect.y - 1, w = run.rect.width + 2, h = run.rect.height + 2;
      walls.push({ axis: run.axis, componentPixels: r.pixels, rect: { x: x / W, y: y / H, width: w / W, height: h / H },
        length: (run.axis === "horizontal" ? w : h) / H, thickness: (run.axis === "horizontal" ? h : w) / H });
    }
  }
  return { walls, rejected, regions: regions.length, rooms: rooms.size };
}

/**
 * Walls of a flattened print as construction footprints, so the rest of the plan
 * trace (rooms, openings, draft walls) treats them like a layered plan's wall
 * fills. The wall pen's segments become segmentation barriers as well.
 */
export function outlineWallFootprints(input: { penSegments: PenSegment[]; doorSwings: Array<{ strokeColor?: string | null }>; aspect: number; roomLabels: Box[] }) {
  const pens = wallPens(input.penSegments, input.doorSwings.map(swing => swing.strokeColor ?? null));
  const segments = input.penSegments.filter(segment => segment.colour && pens.includes(segment.colour));
  if (!segments.length) return { footprints: [] as PlanFootprint[], barrierLines: [] as PlanBarrierLine[], stats: { pens, walls: 0 } };
  const result = outlineWalls({ segments, aspect: input.aspect, roomLabels: input.roomLabels });
  const layerName = "Wall outlines (plan without layers)";
  const footprints: PlanFootprint[] = result.walls.map((wall, i) => {
    const { x, y, width, height } = wall.rect;
    const key = createHash("sha256").update(`${x.toFixed(6)},${y.toFixed(6)},${width.toFixed(6)},${height.toFixed(6)}`).digest("hex");
    return { sourceKey: `outline-wall:${key}`, entityType: "element", name: `Outline wall ${i + 1}`, layerId: "wall-outline", layerName, quote: "Region between wall-pen outlines",
      geometry: { quality: "footprint", coordinateSpace: "normalized-page", polygon: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }],
        planRegion: wall.rect, limitations: "Read from a plan without layers: a thin region enclosed by strokes of the wall pen (the colour of the door swings), bordering a room. Not an exact source fill; the outline itself is counted to the wall." } };
  });
  const barrierLines: PlanBarrierLine[] = segments.map(segment => ({ layerId: "wall-outline", points: [segment.a, segment.b], closed: false }));
  return { footprints, barrierLines, stats: { pens, walls: footprints.length, method: outlineWallMethod, rejectedRegions: result.rejected, rooms: result.rooms } };
}
