type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

export const wallRunMethod = "construction_fill_run_v1";

/** A straight wall run cut from a source construction fill. Normalised page coordinates. */
export type WallRun = { rect: Rect; axis: "horizontal" | "vertical"; length: number; thickness: number };

/**
 * Splits a rectilinear construction fill (an L, T or cross of walls, or a wall
 * with a step) into straight wall runs. Coordinates are page-normalised;
 * `aspect` (page width / height) makes lengths physical, in page heights.
 *
 * The fill is cut into a grid at its own vertex coordinates. A cell belongs to
 * a horizontal run when the fill is thin across it vertically and longer
 * horizontally, and the other way round. A corner or junction cell (thin in
 * neither direction, but no larger than a wall's thickness either way) joins
 * the longest run touching it, so runs meet instead of overlapping. Thicker
 * blocks (columns, shafts) are left over. Fills with oblique edges are not
 * split: null. Corners within `snap` (page heights) of each other are taken as one.
 */
export function wallRuns(rings: Point[][], aspect: number, maxThickness: number, fillRule: "evenodd" | "nonzero" = "evenodd", snap = 2e-4) {
  // CAD exports place corners a few millimetres off; coordinates closer than `snap` are one.
  const snapped = (values: number[]) => {
    const sorted = [...new Set(values)].sort((a, b) => a - b), to = new Map<number, number>();
    for (let i = 0; i < sorted.length;) {
      let j = i; while (j + 1 < sorted.length && sorted[j + 1]! - sorted[j]! <= snap) j++;
      const mean = sorted.slice(i, j + 1).reduce((sum, v) => sum + v, 0) / (j - i + 1);
      for (let k = i; k <= j; k++) to.set(sorted[k]!, mean);
      i = j + 1;
    }
    return to;
  };
  const sx = snapped(rings.flat().map(p => p.x * aspect)), sy = snapped(rings.flat().map(p => p.y));
  const scaled = rings.map(ring => ring.map(p => ({ x: sx.get(p.x * aspect)!, y: sy.get(p.y)! })));
  const eps = 1e-9;
  for (const ring of scaled) for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    if (Math.abs(a.x - b.x) > eps && Math.abs(a.y - b.y) > eps) return null;
  }
  const unique = (values: number[]) => values.sort((a, b) => a - b).filter((v, i, all) => i === 0 || v - all[i - 1]! > eps);
  const xs = unique(scaled.flat().map(p => p.x)), ys = unique(scaled.flat().map(p => p.y));
  const columns = xs.length - 1, rows = ys.length - 1;
  if (columns < 1 || rows < 1 || columns * rows > 40000) return null;
  const insideAt = (px: number, py: number) => {
    let winding = 0, crossings = 0;
    for (const ring of scaled) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      if ((a.y > py) !== (b.y > py) && px < a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y)) { crossings++; winding += b.y > a.y ? 1 : -1; }
    }
    return fillRule === "nonzero" ? winding !== 0 : crossings % 2 === 1;
  };
  const inside: boolean[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) inside.push(insideAt((xs[i]! + xs[i + 1]!) / 2, (ys[j]! + ys[j + 1]!) / 2));
  return runsOnGrid(xs, ys, inside, maxThickness, aspect);
}

/**
 * The run decomposition behind `wallRuns`, on any grid: `xs` and `ys` are the cell
 * edges in physical units (page heights), `inside` the cells row by row. `aspect`
 * converts x back to page-normalised coordinates.
 */
export function runsOnGrid(xs: number[], ys: number[], inside: boolean[], maxThickness: number, aspect: number) {
  const columns = xs.length - 1, rows = ys.length - 1;
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < columns && j < rows && inside[j * columns + i]!;
  // The contiguous inside span through each cell, across and along.
  const hSpan = (i: number, j: number) => { let a = i, b = i; while (at(a - 1, j)) a--; while (at(b + 1, j)) b++; return [a, b] as const; };
  const vSpan = (i: number, j: number) => { let a = j, b = j; while (at(i, a - 1)) a--; while (at(i, b + 1)) b++; return [a, b] as const; };
  const kind: Array<"h" | "v" | "junction" | "block" | null> = inside.map(() => null);
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
    if (!at(i, j)) continue;
    const [h0, h1] = hSpan(i, j), [v0, v1] = vSpan(i, j);
    const across = ys[v1 + 1]! - ys[v0]!, along = xs[h1 + 1]! - xs[h0]!;
    const cellWidth = xs[i + 1]! - xs[i]!, cellHeight = ys[j + 1]! - ys[j]!;
    kind[j * columns + i] = across <= maxThickness && along > across ? "h"
      : along <= maxThickness && across > along ? "v"
      : cellWidth <= maxThickness && cellHeight <= maxThickness ? "junction" : "block";
  }
  // Runs: cells of one direction that share the same span across, connected along the run.
  type Run = { axis: "horizontal" | "vertical"; cells: number[]; across: readonly [number, number]; from: number; to: number };
  const runOf = new Int32Array(inside.length).fill(-1), runs: Run[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
    const index = j * columns + i, k = kind[index];
    if ((k !== "h" && k !== "v") || runOf[index]! >= 0) continue;
    const horizontal = k === "h", across = horizontal ? vSpan(i, j) : hSpan(i, j);
    const run: Run = { axis: horizontal ? "horizontal" : "vertical", cells: [], across, from: horizontal ? i : j, to: horizontal ? i : j };
    // Walk along the run in both directions while cells keep the same kind and the same span across.
    for (const step of [-1, 1]) for (let t = horizontal ? i : j; ; t += step) {
      const ci = horizontal ? t : i, cj = horizontal ? j : t;
      if (!at(ci, cj)) break;
      const cell = cj * columns + ci;
      if (kind[cell] !== k || runOf[cell]! >= 0 && runOf[cell] !== runs.length) break;
      const span = horizontal ? vSpan(ci, cj) : hSpan(ci, cj);
      if (span[0] !== across[0] || span[1] !== across[1]) break;
      runOf[cell] = runs.length; run.from = Math.min(run.from, t); run.to = Math.max(run.to, t);
    }
    // Every cell across the run belongs to it.
    for (let t = run.from; t <= run.to; t++) for (let s = across[0]; s <= across[1]; s++) {
      const cell = horizontal ? s * columns + t : t * columns + s;
      if (kind[cell] === k) runOf[cell] = runs.length;
    }
    runs.push(run);
  }
  const lengthOf = (run: Run) => run.axis === "horizontal" ? xs[run.to + 1]! - xs[run.from]! : ys[run.to + 1]! - ys[run.from]!;
  // A junction cell joins a wall running through it (the same run on both sides merges into one),
  // else the longest run that ends next to it and spans it exactly.
  type Live = Run & { dead?: boolean };
  const runAt = (ci: number, cj: number): Live | null => at(ci, cj) && runOf[cj * columns + ci]! >= 0 ? runs[runOf[cj * columns + ci]!]! : null;
  const claim = (run: Run, t: number) => {
    run.from = Math.min(run.from, t); run.to = Math.max(run.to, t);
    for (let s = run.across[0]; s <= run.across[1]; s++) {
      const cell = run.axis === "horizontal" ? s * columns + t : t * columns + s;
      if (kind[cell] === "junction") { runOf[cell] = runs.indexOf(run); kind[cell] = null; }
    }
  };
  let leftover = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
    const index = j * columns + i;
    if (kind[index] !== "junction") continue;
    const ends = (run: Live | null, axis: Run["axis"], t: number, s: number, before: boolean) => run && !run.dead && run.axis === axis && run.across[0] <= s && run.across[1] >= s
      && (before ? run.to === t - 1 : run.from === t + 1) ? run : null;
    const left = ends(runAt(i - 1, j), "horizontal", i, j, true), right = ends(runAt(i + 1, j), "horizontal", i, j, false);
    const up = ends(runAt(i, j - 1), "vertical", j, i, true), down = ends(runAt(i, j + 1), "vertical", j, i, false);
    const through = left && right && left !== right && left.across[0] === right.across[0] && left.across[1] === right.across[1] ? [left, right, i] as const
      : up && down && up !== down && up.across[0] === down.across[0] && up.across[1] === down.across[1] ? [up, down, j] as const : null;
    if (through) {
      const [first, second, t] = through;
      claim(first, t);
      first.to = second.to; (second as Live).dead = true;
      runOf.forEach((value, cell) => { if (value === runs.indexOf(second)) runOf[cell] = runs.indexOf(first); });
      continue;
    }
    const run = [left, right, up, down].filter((item): item is Live => Boolean(item)).sort((a, b) => lengthOf(b) - lengthOf(a))[0];
    if (run) claim(run, run.axis === "horizontal" ? i : j);
  }
  for (const k of kind) if (k === "block" || k === "junction") leftover++;
  const result: WallRun[] = (runs as Array<Run & { dead?: boolean }>).filter(run => !run.dead).map(run => {
    const horizontal = run.axis === "horizontal";
    const x0 = horizontal ? xs[run.from]! : xs[run.across[0]]!, x1 = horizontal ? xs[run.to + 1]! : xs[run.across[1] + 1]!;
    const y0 = horizontal ? ys[run.across[0]]! : ys[run.from]!, y1 = horizontal ? ys[run.across[1] + 1]! : ys[run.to + 1]!;
    return { axis: run.axis, rect: { x: x0 / aspect, y: y0, width: (x1 - x0) / aspect, height: y1 - y0 },
      length: horizontal ? x1 - x0 : y1 - y0, thickness: horizontal ? y1 - y0 : x1 - x0 };
  });
  return { runs: result, leftover };
}
