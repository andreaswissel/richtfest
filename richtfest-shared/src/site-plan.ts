/**
 * Plan-on-site geometry: projecting mapped axes into a location scene, placing
 * a scaled plan page on the site by two point pairs, and measuring facades
 * against noise source axes. Display and planning geometry only; neither the
 * projection nor a placement is a surveyed setting-out.
 */

import type { LocationContext } from "./location";

export type Point2 = [number, number];

/** WGS84 -> ETRS89 / UTM zone 32N or 33N. The WGS84/ETRS89 difference is immaterial
 * for this unsurveyed display; this must not be used for engineering clearance. */
export function toUtm(longitude: number, latitude: number, zone: 32 | 33): Point2 {
  const a = 6378137, e2 = 0.00669438002290, k = 0.9996;
  const p = latitude * Math.PI / 180, l = (longitude - (zone * 6 - 183)) * Math.PI / 180;
  const ep = e2 / (1 - e2), n = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  const t = Math.tan(p) ** 2, c = ep * Math.cos(p) ** 2, A = Math.cos(p) * l;
  const m = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * p)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * p)
    - 35 * e2 ** 3 / 3072 * Math.sin(6 * p));
  return [500000 + k * n * (A + (1 - t + c) * A ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep) * A ** 5 / 120),
    k * (m + n * Math.tan(p) * (A ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * A ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep) * A ** 6 / 720))];
}

/** ETRS89 / UTM zone 32N or 33N -> [longitude, latitude]; the inverse of toUtm with the same accuracy note. */
export function fromUtm(easting: number, northing: number, zone: 32 | 33): Point2 {
  const a = 6378137, e2 = 0.00669438002290, k0 = 0.9996, ep = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const mu = northing / k0 / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), t1 = Math.tan(p1) ** 2, c1 = ep * Math.cos(p1) ** 2;
  const r1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, d = (easting - 500000) / (n1 * k0);
  const latitude = p1 - (n1 * Math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep - 3 * c1 ** 2) * d ** 6 / 720);
  const longitude = (zone * 6 - 183) * Math.PI / 180 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep + 24 * t1 ** 2) * d ** 5 / 120) / Math.cos(p1);
  return [longitude * 180 / Math.PI, latitude * 180 / Math.PI];
}

/** Rail noise contours (EBA Lärmkartierung, Lden) are fetched for a square window of this half-width around the site. */
export const RAIL_NOISE_HALF_WIDTH_M = 1000;
export const railNoiseAttribution = "© Eisenbahn-Bundesamt, Lärmkartierung Schiene (Lden), dl-de/by-2-0";

/** Also versions HTTP-cache URLs, not just the viewer's in-memory query keys. */
export function locationImageVersion(context: Pick<LocationContext, "siteId" | "crs" | "origin" | "importedAt">) {
  return JSON.stringify(["wms-image-v1", context.siteId, context.crs ?? "EPSG:25833", context.origin, context.importedAt]);
}

/** Official orthophotos (DOP) around the site: a sharp near window loaded with the scene and a wide one loaded when zoomed out. */
export const AERIAL_HALF_WIDTH_M = { near: 250, far: 1500 } as const;
export type AerialExtent = keyof typeof AERIAL_HALF_WIDTH_M;
export type AerialSource = { id: "rlp-dop20" | "berlin-truedop"; attribution: string };
/** Aerial imagery by site register: Rheinland-Pfalz DOP20 and Berlin TrueDOP; other sites have none yet. */
export function aerialSourceFor(context: { siteId: string; crs?: string }): AerialSource | null {
  if (context.siteId.startsWith("rlp-") && context.crs === "EPSG:25832")
    return { id: "rlp-dop20", attribution: "©GeoBasis-DE / LVermGeoRP, dl-de/by-2-0, Digitale Orthophotos (DOP20)" };
  if (context.siteId.startsWith("berlin-") && (context.crs ?? "EPSG:25833") === "EPSG:25833")
    return { id: "berlin-truedop", attribution: "Geoportal Berlin / Digitale farbige TrueOrthophotos 2024, dl-de/zero-2-0" };
  return null;
}

export const utmZone = (crs: string | undefined): 32 | 33 => crs === "EPSG:25832" ? 32 : 33;

/** Douglas-Peucker on planar points; keeps both ends. */
export function simplifyPolyline<T extends Point2>(points: T[], tolerance: number): T[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let index = -1, worst = tolerance;
    for (let i = start + 1; i < end; i++) {
      const distance = segmentDistance(points[i]!, points[start]!, points[end]!).distance;
      if (distance > worst) { worst = distance; index = i; }
    }
    if (index >= 0) { keep[index] = 1; stack.push([start, index], [index, end]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Closest point on segment ab to p. */
export function segmentDistance(p: Point2, a: Point2, b: Point2): { distance: number; point: Point2 } {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  const point: Point2 = [a[0] + t * dx, a[1] + t * dy];
  return { distance: Math.hypot(p[0] - point[0], p[1] - point[1]), point };
}

/** Closest points between two segments (non-intersecting case; crossing segments report 0). */
function segmentPair(a: Point2, b: Point2, c: Point2, d: Point2): { distance: number; from: Point2; to: Point2 } {
  const cross = (o: Point2, p: Point2, q: Point2) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    const t = d1 / (d1 - d2), point: Point2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    return { distance: 0, from: point, to: point };
  }
  const options = [
    { from: a, ...flip(segmentDistance(a, c, d)) }, { from: b, ...flip(segmentDistance(b, c, d)) },
    { to: c, ...swap(segmentDistance(c, a, b)) }, { to: d, ...swap(segmentDistance(d, a, b)) },
  ] as Array<{ distance: number; from: Point2; to: Point2 }>;
  return options.reduce((best, item) => item.distance < best.distance ? item : best);
}
const flip = (r: { distance: number; point: Point2 }) => ({ distance: r.distance, to: r.point });
const swap = (r: { distance: number; point: Point2 }) => ({ distance: r.distance, from: r.point });

/**
 * A plan page placed on the site. Plan metres run x right, y down from the
 * page's top-left corner. `origin` is where that corner lies in the site CRS
 * (easting, northing); `degrees` turns the plan's x axis counter-clockwise from east.
 */
export type PlanPlacement = { origin: Point2; degrees: number };

export function planToSite(point: Point2, placement: PlanPlacement): Point2 {
  const r = placement.degrees * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  // Plan y points down the page; on a north-up site it points south.
  return [placement.origin[0] + cos * point[0] + sin * point[1], placement.origin[1] + sin * point[0] - cos * point[1]];
}

export function siteToPlan(point: Point2, placement: PlanPlacement): Point2 {
  const r = placement.degrees * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = point[0] - placement.origin[0], dy = point[1] - placement.origin[1];
  return [cos * dx + sin * dy, sin * dx - cos * dy];
}

/**
 * Rigid placement from two plan points and the two site points they belong to.
 * The plan keeps its printed scale; `scaleRatio` (site length / plan length)
 * shows how well the printed scale and the picked points agree.
 */
export function twoPointPlacement(plan: [Point2, Point2], site: [Point2, Point2]): PlanPlacement & { scaleRatio: number } | null {
  // Plan vectors in a north-up frame (y flipped) so both pairs share orientation.
  const pv: Point2 = [plan[1][0] - plan[0][0], -(plan[1][1] - plan[0][1])];
  const sv: Point2 = [site[1][0] - site[0][0], site[1][1] - site[0][1]];
  const planLength = Math.hypot(...pv), siteLength = Math.hypot(...sv);
  if (planLength < 0.5 || siteLength < 0.5) return null;
  const degrees = ((Math.atan2(sv[1], sv[0]) - Math.atan2(pv[1], pv[0])) * 180 / Math.PI + 360) % 360;
  // Midpoints coincide, so a scale mismatch spreads evenly over both picks.
  const planMid: Point2 = [(plan[0][0] + plan[1][0]) / 2, (plan[0][1] + plan[1][1]) / 2];
  const siteMid: Point2 = [(site[0][0] + site[1][0]) / 2, (site[0][1] + site[1][1]) / 2];
  const turned = planToSite(planMid, { origin: [0, 0], degrees });
  return { origin: [siteMid[0] - turned[0], siteMid[1] - turned[1]], degrees, scaleRatio: siteLength / planLength };
}

export type Compass = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
const compass: Compass[] = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
/** Direction of a vector in a north-up frame, 8 sectors. */
export const compassOf = (vector: Point2): Compass => compass[Math.round(((Math.atan2(vector[1], vector[0]) * 180 / Math.PI + 360) % 360) / 45) % 8]!;

export type FacadeDistance = {
  sourceId: string;
  /** Shortest horizontal distance from an exterior wall to the source axis, metres. */
  distance: number;
  wallId: string;
  /** Outward direction of the measured wall face. */
  facade: Compass;
  from: Point2;
  to: Point2;
};

/**
 * Shortest distance from the building's exterior walls to each source axis,
 * all in one planar site frame (metres). Walls are polygons; the nearest
 * point to an outside axis lies on the outer face, so every edge is tested.
 */
export function facadeDistances(walls: Array<{ id: string; ring: Point2[] }>, sources: Array<{ id: string; parts: Point2[][] }>): FacadeDistance[] {
  const all = walls.flatMap(wall => wall.ring);
  if (!all.length) return [];
  const centre: Point2 = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length];
  const results: FacadeDistance[] = [];
  const centreOf = (ring: Point2[]): Point2 => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  const unit = (v: Point2): Point2 => { const length = Math.hypot(...v); return length > 1e-9 ? [v[0] / length, v[1] / length] : [0, 0]; };
  for (const source of sources) {
    const candidates: Array<{ distance: number; from: Point2; to: Point2; wallId: string; outward: Point2 }> = [];
    for (const wall of walls) {
      // Outward direction: from the building centre through the wall, so a wall reads as its outside face.
      const wallCentre = centreOf(wall.ring), outward = unit([wallCentre[0] - centre[0], wallCentre[1] - centre[1]]);
      let best: { distance: number; from: Point2; to: Point2 } | null = null;
      for (let i = 0; i < wall.ring.length; i++) {
        const a = wall.ring[i]!, b = wall.ring[(i + 1) % wall.ring.length]!;
        for (const part of source.parts) for (let j = 0; j + 1 < part.length; j++) {
          const pair = segmentPair(a, b, part[j]!, part[j + 1]!);
          if (!best || pair.distance < best.distance) best = pair;
        }
      }
      if (best) candidates.push({ ...best, wallId: wall.id, outward });
    }
    if (!candidates.length) continue;
    const shortest = Math.min(...candidates.map(item => item.distance));
    // Walls meeting at the nearest corner tie; the facade is the one that faces the source.
    const facing = (item: typeof candidates[number]) => { const d = unit([item.to[0] - item.from[0], item.to[1] - item.from[1]]); return d[0] * item.outward[0] + d[1] * item.outward[1]; };
    const best = candidates.filter(item => item.distance - shortest < 0.01).reduce((a, b) => facing(b) > facing(a) ? b : a);
    const direction: Point2 = Math.hypot(...best.outward) > 0 ? best.outward : [best.to[0] - best.from[0], best.to[1] - best.from[1]];
    results.push({ sourceId: source.id, distance: Math.round(best.distance * 10) / 10, wallId: best.wallId, facade: compassOf(direction), from: best.from, to: best.to });
  }
  return results;
}

export type SitePlanWall = { id: string; name: string; exterior: boolean; /** Plan metres, x right, y down from the page's top-left corner. */ ring: Point2[] };
export type SitePlanPage = {
  sourceVersionId: string;
  page: number;
  fileName: string | null;
  storey: { id: string; name: string; levelIndex: number | null } | null;
  scale: { pageAspectRatio: number; metresPerPageHeight: number; denominator: number | null };
  walls: SitePlanWall[];
};
export type StoredPlacement = {
  id: string;
  origin: { x: number; y: number; z?: number; crs?: "EPSG:25832" | "EPSG:25833" };
  orientation: { degrees: number } | null;
  alignmentStatus: "unknown" | "approximate" | "reviewed";
  evidence: Array<{ kind: string; sourceVersionId?: string; page?: number; quote?: string }>;
};
/** modelRevision is null when the project has no building model yet. */
export type SitePlan = { modelRevision: number | null; pages: SitePlanPage[]; placement: StoredPlacement | null };

/** The stored placement applies to a page when its first evidence item is that page and it was saved in the site's CRS. */
export function placementForPage(placement: StoredPlacement | null, page: Pick<SitePlanPage, "sourceVersionId" | "page">, crs: string): PlanPlacement | null {
  const evidence = placement?.evidence[0];
  if (!placement || placement.origin.crs !== crs || evidence?.kind !== "page" || evidence.sourceVersionId !== page.sourceVersionId || evidence.page !== page.page) return null;
  return { origin: [placement.origin.x, placement.origin.y], degrees: placement.orientation?.degrees ?? 0 };
}
