import type { GeometryEvidence, GeometryMultiPolygon, GeometryPoint, PlanOverlay, SiteGeometryInput } from "@richtfest/shared/site-geometry-model";
import { api } from "../../api";
import type { PlanProvider } from "./plan-extraction";

type Matrix = [number, number, number, number, number, number];
type Crop = { x: number; y: number; width: number; height: number };
type MandatoryLine = SiteGeometryInput["mandatoryLines"][number];
type LinesProposal = {
  id: string;
  status: "completed" | "unconfigured" | "failed" | "running";
  error?: string | null;
  payload: { baugrenzen: { points: GeometryPoint[]; reason: string }[]; baulinien: { points: GeometryPoint[]; reason: string }[]; verkehrsflaechen?: { points: GeometryPoint[]; reason: string }[]; limitations: string[] } | null;
};
export type TracedLines = {
  status: "traced" | "empty" | "unconfigured" | "failed";
  envelope: GeometryEvidence | null;
  lines: MandatoryLine[];
  /** Public traffic areas on the parcel, as exclusions that are not building land (§ 19 (3) BauNVO). */
  nonBuildingLand: SiteGeometryInput["exclusions"];
  limitations: string[];
  message?: string;
};
/** Ids of lines placed by the tracer, so a new trace replaces them without touching lines a person drew. */
export const TRACED_LINE_PREFIX = "plan-line-";

/** Site (EPSG:25833) to plan image coordinates: the inverse of the three-point alignment. */
export function invertAffine([a, b, c, d, e, f]: Matrix): Matrix | null {
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) return null;
  return [e / det, -b / det, (b * f - e * c) / det, -d / det, a / det, (d * c - a * f) / det];
}
const apply = (m: Matrix, [x, y]: GeometryPoint): GeometryPoint => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];

/**
 * Page crop around the parcel: the parcel plus one parcel size on every side, so the whole building window and
 * neighbouring line segments are visible, at a resolution where dash-dot lines stay legible.
 */
export function cropAroundParcel(parcel: GeometryMultiPolygon, inverse: Matrix): Crop | null {
  const points = parcel.flatMap((p) => p[0] ?? []).map((p) => apply(inverse, p));
  if (!points.length) return null;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const margin = Math.max(maxX - minX, maxY - minY, 0.02);
  const x0 = Math.max(0, minX - margin), y0 = Math.max(0, minY - margin), x1 = Math.min(1, maxX + margin), y1 = Math.min(1, maxY + margin);
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const fromCrop = (crop: Crop, [x, y]: GeometryPoint): GeometryPoint => [crop.x + x * crop.width, crop.y + y * crop.height];
const toCrop = (crop: Crop, [x, y]: GeometryPoint): GeometryPoint => [(x - crop.x) / crop.width, (y - crop.y) / crop.height];

function insideRing([x, y]: GeometryPoint, ring: GeometryPoint[]) {
  let yes = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) yes = !yes;
  }
  return yes;
}
const insideParcel = (p: GeometryPoint, parcel: GeometryMultiPolygon) => parcel.some((poly) => insideRing(p, poly[0]!) && !poly.slice(1).some((hole) => insideRing(p, hole)));

/** Pieces of a polyline inside the parcel, pulled 1 cm inside the boundary so the line check accepts them. */
export function clipLineToParcel(line: GeometryPoint[], parcel: GeometryMultiPolygon): GeometryPoint[][] {
  const pieces: GeometryPoint[][] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!, b = line[i + 1]!, dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length < 0.05) continue;
    const ts = [0, 1];
    for (const poly of parcel)
      for (const ring of poly)
        for (let k = 0; k < ring.length - 1; k++) {
          const c = ring[k]!, d = ring[k + 1]!, ex = d[0] - c[0], ey = d[1] - c[1], det = dx * ey - dy * ex;
          if (Math.abs(det) < 1e-12) continue;
          const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / det, u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / det;
          if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
        }
    ts.sort((p, q) => p - q);
    const inset = 0.01 / length;
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k]!, t1 = ts[k + 1]!;
      if ((t1 - t0) * length < 0.5 || !insideParcel([a[0] + ((t0 + t1) / 2) * dx, a[1] + ((t0 + t1) / 2) * dy], parcel)) continue;
      const p: GeometryPoint = [a[0] + (t0 + inset) * dx, a[1] + (t0 + inset) * dy], q: GeometryPoint = [a[0] + (t1 - inset) * dx, a[1] + (t1 - inset) * dy];
      const last = pieces.at(-1);
      // Consecutive pieces that meet at a vertex stay one polyline.
      if (last && Math.hypot(last.at(-1)![0] - p[0], last.at(-1)![1] - p[1]) < 0.05) last.push(q);
      else pieces.push([p, q]);
    }
  }
  return pieces;
}

/**
 * Asks the explicitly selected provider to trace Baugrenzen and Baulinien on the aligned plan page, cropped on the
 * server around the parcel, and maps them onto the site. Windows that do not touch the parcel are dropped and lines
 * are clipped to it. Everything stays unreviewed: the traced corners are approximate until a person corrects them.
 */
export async function traceBuildingLines(projectId: string, overlay: PlanOverlay, parcel: GeometryEvidence, provider: PlanProvider): Promise<TracedLines> {
  const result: TracedLines = { status: "empty", envelope: null, lines: [], nonBuildingLand: [], limitations: [] };
  const engine = await import("@richtfest/shared/site-geometry");
  const matrix = engine.affineFromControlPoints(overlay.controlPoints);
  const inverse = matrix && invertAffine(matrix);
  const crop = inverse && cropAroundParcel(parcel.geometry, inverse);
  if (!matrix || !inverse || !crop) return { ...result, status: "failed", message: "alignment" };
  const site = (parcel.geometry[0]?.[0] ?? []).slice(0, 200).map((p) => toCrop(crop, apply(inverse, p)));
  let proposal: LinesProposal;
  try {
    proposal = await api<LinesProposal>(`/feasibility/projects/${projectId}/evidence/lines`, { versionId: overlay.fileVersionId, page: overlay.page, provider, crop, site }, "POST");
  } catch (error) {
    return { ...result, status: "failed", message: (error as Error).message };
  }
  if (proposal.status === "unconfigured") return { ...result, status: "unconfigured" };
  if (proposal.status !== "completed" || !proposal.payload) return { ...result, status: "failed", message: proposal.error ?? undefined };
  const toSite = (p: GeometryPoint) => engine.transformPlanPoint(fromCrop(crop, p), matrix);
  const source = (kind: string, reason: string) => `${overlay.source} · ${kind} traced by ${provider} (proposal ${proposal.id}), approximate corners · ${reason}`.slice(0, 2000);
  const windows: GeometryMultiPolygon = [];
  const reasons: string[] = [];
  for (const window of proposal.payload.baugrenzen) {
    const ring = window.points.map(toSite);
    ring.push(ring[0]!);
    // Clockwise or not, a ring must be valid on its own and actually touch the parcel to matter here.
    if (engine.validateGeometry([[ring]]).length || engine.geometryArea(engine.intersectGeometry([[ring]], parcel.geometry)) < 0.5) continue;
    windows.push([ring]);
    reasons.push(window.reason);
  }
  const merged = windows.length ? engine.unionGeometry(...windows.map((w) => [w])) : [];
  if (merged.length && !engine.validateGeometry(merged).length)
    result.envelope = { id: "envelope", label: "Baugrenze (traced)", geometry: merged, source: source("Baugrenze", reasons.join("; ")), sourceDate: overlay.sourceDate, reviewed: false };
  for (const [index, line] of proposal.payload.baulinien.entries())
    for (const [part, piece] of clipLineToParcel(line.points.map(toSite), parcel.geometry).entries())
      result.lines.push({ id: `${TRACED_LINE_PREFIX}${proposal.id.slice(0, 8)}-${index}-${part}`, label: `Baulinie ${result.lines.length + 1} (traced)`, line: piece, source: source("Baulinie", line.reason), sourceDate: overlay.sourceDate, reviewed: false });
  for (const [index, area] of (proposal.payload.verkehrsflaechen ?? []).entries()) {
    const ring = area.points.map(toSite);
    ring.push(ring[0]!);
    if (engine.validateGeometry([[ring]]).length) continue;
    const onParcel = engine.intersectGeometry([[ring]], parcel.geometry);
    if (engine.geometryArea(onParcel) < 0.5) continue;
    result.nonBuildingLand.push({ id: `${TRACED_LINE_PREFIX}${proposal.id.slice(0, 8)}-street-${index}`, label: `Straßenland ${result.nonBuildingLand.length + 1} (traced)`, geometry: onParcel, source: source("Verkehrsfläche", area.reason), sourceDate: overlay.sourceDate, reviewed: false, nonBuildingLand: true });
  }
  result.limitations = proposal.payload.limitations;
  result.status = result.envelope || result.lines.length || result.nonBuildingLand.length ? "traced" : "empty";
  return result;
}

/** A new trace replaces earlier unreviewed traced lines and street areas; whatever a person drew or reviewed stays. */
export function applyTrace(geometry: SiteGeometryInput, traced: TracedLines): Pick<SiteGeometryInput, "envelope" | "mandatoryLines" | "exclusions" | "exclusionsReviewed"> {
  const keep = <T extends { id: string; reviewed: boolean }>(items: T[]) => items.filter((item) => item.reviewed || !item.id.startsWith(TRACED_LINE_PREFIX));
  const exclusions = [...keep(geometry.exclusions), ...traced.nonBuildingLand];
  return {
    envelope: traced.envelope ?? geometry.envelope,
    mandatoryLines: [...keep(geometry.mandatoryLines), ...traced.lines],
    exclusions,
    exclusionsReviewed: geometry.exclusionsReviewed && exclusions.length === geometry.exclusions.length && exclusions.every((e, i) => e === geometry.exclusions[i]),
  };
}
