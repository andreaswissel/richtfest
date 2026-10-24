import { outlineProblem } from "./plan-selection";

/** Check coverage, NOT a calibrated probability. No OCR or room-use confidence is used. */
export const candidateReviewScoreVersion = "room-geometry-checks-v1";
export type CandidateReviewChecks = {
  enclosedRegion: boolean;
  unambiguousSource: boolean;
  shapeQc: boolean;
  printedScaleQc: boolean;
  areaRatioQc: boolean;
};
type Point = { x: number; y: number };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSegment = (p: Point, a: Point, b: Point) => Math.abs(cross(a, b, p)) < 1e-12
  && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
function intersects(a: Point, b: Point, c: Point, d: Point) {
  return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
    || onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
}
function inside(p: Point, ring: Point[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
function validRing(value: unknown): value is Point[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 1000
    || value.some(p => !p || !finite(p.x) || !finite(p.y)) || outlineProblem(value)) return false;
  // The shared validator handles proper crossings; also reject touching/overlapping
  // non-adjacent edges and zero-length edges, which cannot describe a simple ring.
  for (let i = 0; i < value.length; i++) {
    const a = value[i], b = value[(i + 1) % value.length];
    if (a.x === b.x && a.y === b.y) return false;
    const c = value[(i + 2) % value.length];
    if (onSegment(a, b, c) || onSegment(c, a, b)) return false;
    for (let j = i + 2; j < value.length; j++) {
      if (i === 0 && j === value.length - 1) continue;
      if (intersects(a, b, value[j], value[(j + 1) % value.length])) return false;
    }
  }
  return true;
}
function ringsTouch(a: Point[], b: Point[]) {
  return a.some((p, i) => b.some((q, j) => intersects(p, a[(i + 1) % a.length]!, q, b[(j + 1) % b.length]!)));
}
function validOutline(g: any) {
  if (!validRing(g.polygon)) return false;
  const holes = g.holes === undefined ? [] : g.holes;
  if (!Array.isArray(holes) || holes.length > 50 || holes.some(h => !validRing(h))) return false;
  return holes.every((h: Point[], i: number) => inside(h[0]!, g.polygon) && !ringsTouch(h, g.polygon)
    && holes.slice(i + 1).every((other: Point[]) => !ringsTouch(h, other) && !inside(h[0]!, other) && !inside(other[0]!, h)));
}
/** Deliberately conservative match-risk guard, not geometric reconciliation. */
export function candidateOutlinesOverlap(a: any, b: any) {
  const bounds = (g: any) => {
    if (!Array.isArray(g?.polygon) || !g.polygon.length) return null;
    const result = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    for (const p of g.polygon) {
      if (!p || !finite(p.x) || !finite(p.y)) return null;
      result.left = Math.min(result.left, p.x); result.right = Math.max(result.right, p.x);
      result.top = Math.min(result.top, p.y); result.bottom = Math.max(result.bottom, p.y);
    }
    return result;
  };
  const x = bounds(a), y = bounds(b);
  return Boolean(x && y && Math.min(x.right, y.right) > Math.max(x.left, y.left) && Math.min(x.bottom, y.bottom) > Math.max(x.top, y.top));
}

export function candidateReviewScore(candidate: { entityType: string; geometry: any }) {
  const g = candidate.geometry ?? {}, topology = g.topology, shape = g.shapeQc, scale = g.printedScaleQc, ratio = g.areaRatioQc;
  const checks: CandidateReviewChecks = {
    enclosedRegion: g.quality === "enclosed_region" && topology?.status === "enclosed",
    unambiguousSource: Array.isArray(topology?.competingSourceKeys) && topology.competingSourceKeys.length === 0
      && g.semanticQc?.status === "unreviewed" && !g.semanticQc?.duplicateLivingKitchen && !g.containsOtherLabel,
    shapeQc: shape?.status === "unreviewed",
    printedScaleQc: scale?.status === "unreviewed" && finite(scale.estimatedArea) && scale.estimatedArea > 0
      && finite(scale.printedArea) && scale.printedArea > 0 && finite(scale.toleranceM2) && scale.toleranceM2 >= 0
      && Math.abs(scale.estimatedArea - scale.printedArea) <= scale.toleranceM2,
    areaRatioQc: ratio?.status === "unreviewed" && Number.isInteger(ratio.sampleCount) && ratio.sampleCount >= 5
      && finite(ratio.relativeToMedian) && ratio.relativeToMedian >= .5 && ratio.relativeToMedian <= 2,
  };
  if (candidate.entityType !== "room" || !topology?.status || !shape?.status
    || !Array.isArray(topology.competingSourceKeys) || !g.semanticQc?.status)
    return { score: null, checks, blocked: false };
  // Scan geometry QC only: room-use proposals and OCR are unrelated evidence.
  const qcConflict = Object.entries(g).some(([key, value]: [string, any]) => (key === "topology" || key.endsWith("Qc"))
    && value?.status && /conflict|severe|outlier|reject/i.test(value.status));
  const blocked = !checks.enclosedRegion || !checks.unambiguousSource || !checks.shapeQc || !validOutline(g)
    || qcConflict || Boolean(g.outlineEdit || g.merge || g.openSpace || g.parts?.length || g.polygons?.length)
    || (topology.detachedPartCount != null && topology.detachedPartCount !== 0)
    || Boolean(shape.severeConcavity)
    || (scale != null && !checks.printedScaleQc)
    || (ratio != null && (!finite(ratio.relativeToMedian) || ratio.relativeToMedian < .5 || ratio.relativeToMedian > 2));
  return { score: Object.values(checks).filter(Boolean).length * 20, checks, blocked };
}
