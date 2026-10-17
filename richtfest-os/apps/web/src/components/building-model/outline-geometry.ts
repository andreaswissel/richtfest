import type { BuildingPlanPoint } from "./types";

export type OutlineDraft = { polygon: BuildingPlanPoint[]; holes: BuildingPlanPoint[][] };
export type PageScale = { pageAspectRatio: number; metresPerPageHeight: number | null };
export type MagicOutline = { scope: "room" | "space" | "construction"; polygon: BuildingPlanPoint[]; holes: BuildingPlanPoint[][]; areaM2: number | null; cellCount: number };

const ringArea = (ring: BuildingPlanPoint[]) => Math.abs(ring.reduce((sum, point, index) => {
  const next = ring[(index + 1) % ring.length]!;
  return sum + point.x * next.y - next.x * point.y;
}, 0)) / 2;

/** Outline area at the page's printed scale (same formula as the server), or null without a scale. */
export function outlineAreaM2(draft: OutlineDraft, scale?: PageScale | null) {
  if (!scale?.metresPerPageHeight || draft.polygon.length < 3) return null;
  const normalized = ringArea(draft.polygon) - draft.holes.reduce((sum, hole) => sum + ringArea(hole), 0);
  return Math.round(normalized * scale.pageAspectRatio * scale.metresPerPageHeight ** 2 * 100) / 100;
}

export function pointInRing(point: BuildingPlanPoint, ring: BuildingPlanPoint[]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index]!, b = ring[previous]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The same check the server applies before saving: no two non-adjacent edges cross. */
export function outlineSelfIntersects(polygon: BuildingPlanPoint[]) {
  const cross = (a: BuildingPlanPoint, b: BuildingPlanPoint, c: BuildingPlanPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const count = polygon.length;
  for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
    if (j === i + 1 || (i === 0 && j === count - 1)) continue;
    const a = polygon[i]!, b = polygon[(i + 1) % count]!, c = polygon[j]!, d = polygon[(j + 1) % count]!;
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  }
  return false;
}

/** A starting outline for a room that has only a label: a rectangle around it. */
export function rectangleAround(box: { x: number; y: number; width: number; height: number }) {
  const padX = Math.max(box.width, .02), padY = Math.max(box.height * 2, .02);
  const x0 = Math.max(0, box.x - padX), y0 = Math.max(0, box.y - padY), x1 = Math.min(1, box.x + box.width + padX), y1 = Math.min(1, box.y + box.height + padY);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

/** Plan point in metres from the page's top-left corner at the printed scale. */
export function pointToMetres(point: BuildingPlanPoint, scale: PageScale) {
  const height = scale.metresPerPageHeight ?? 0;
  return { x: point.x * scale.pageAspectRatio * height, y: point.y * height };
}

export function metresToPoint(point: { x: number; y: number }, scale: PageScale) {
  const height = scale.metresPerPageHeight || 1;
  return { x: Math.min(1, Math.max(0, point.x / (scale.pageAspectRatio * height))), y: Math.min(1, Math.max(0, point.y / height)) };
}

/** Straight-line distance between two plan points in metres, or null without a scale. */
export function planDistanceM(a: BuildingPlanPoint, b: BuildingPlanPoint, scale?: PageScale | null) {
  if (!scale?.metresPerPageHeight) return null;
  return Math.hypot((b.x - a.x) * scale.pageAspectRatio * scale.metresPerPageHeight, (b.y - a.y) * scale.metresPerPageHeight);
}
