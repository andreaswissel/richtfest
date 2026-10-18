import type {
  AcousticNormPack, PeriodEmission, Point2, RoadClass, RoadEmission, RoadEmissionIssue, RoadEmissionNote, RoadNoiseReceiver, RoadNoiseSource, RoadRatingLevel, RoadSurfaceType,
} from "@richtfest/shared";

/**
 * Road traffic noise after the RLS-19 method: emission of each source line and
 * the rating level at a receiver under free propagation over flat ground.
 * Screening, reflections, junction and multiple-reflection corrections are not
 * modelled; callers must report that limitation with every result.
 * All coefficients come from the configured norm pack.
 */
type Rls19 = AcousticNormPack["rls19"];
type Group = "car" | "truck1" | "truck2";
const groups: Group[] = ["car", "truck1", "truck2"];

const lg = Math.log10;
const energySum = (levels: number[]) => {
  if (!levels.length) return -Infinity;
  const peak = Math.max(...levels);
  return peak + 10 * lg(levels.reduce((sum, level) => sum + 10 ** ((level - peak) / 10), 0));
};

/** Speed per vehicle group: posted limit, at least the minimum; trucks capped where the guideline assumes hypothetical truck speeds. */
export function groupSpeeds(rls: Rls19, roadClass: RoadClass, limitKmh: number | null): Record<Group, number> | null {
  if (limitKmh === null && roadClass !== "motorway") return null;
  const cap = roadClass === "motorway" ? rls.speed.truckCapKmh.motorway : rls.speed.truckCapKmh.other;
  const car = Math.max(limitKmh ?? rls.speed.unrestrictedCarKmh, rls.speed.minimumKmh);
  const truck = Math.max(Math.min(limitKmh ?? cap, cap), rls.speed.minimumKmh);
  return { car, truck1: truck, truck2: truck };
}

/** Basic sound power level of one vehicle at constant speed. */
export const baseVehicleLevel = (rls: Rls19, group: Group, speedKmh: number) => {
  const { a, b, c } = rls.emission[group];
  return a + 10 * lg(1 + (speedKmh / b) ** c);
};

export function surfaceCorrection(rls: Rls19, surface: RoadSurfaceType, group: Group, speedKmh: number): number | null {
  const entry = rls.surfaces[surface];
  if (!entry) return null;
  if (entry.kind === "by_speed") {
    const reached = entry.columns.filter(column => speedKmh >= column.fromKmh);
    return (reached.at(-1) ?? entry.columns[0]!).value;
  }
  const row = group === "car" ? entry.car : entry.truck;
  return speedKmh <= entry.splitKmh ? row.low : row.high;
}

export function gradientCorrection(rls: Rls19, group: Group, gradientPct: number, speedKmh: number) {
  const g = Math.max(-rls.gradient.clampPct, Math.min(rls.gradient.clampPct, gradientPct));
  const { downhill, uphill } = rls.gradient[group];
  const term = (t: typeof downhill) =>
    ((g - t.fromPct) / t.gradientDivisor) * ((t.constant + t.speedFactor * Math.min(speedKmh, t.speedCapKmh ?? speedKmh)) / t.speedDivisor);
  if (g < downhill.fromPct) return term(downhill);
  if (g > uphill.fromPct) return term(uphill);
  return 0;
}

/** Length-related sound power level of a source line for hourly traffic M and truck shares. */
export function lineLevel(hourlyTraffic: number, truck1Pct: number, truck2Pct: number, speed: Record<Group, number>, vehicleLevel: Record<Group, number>) {
  const share: Record<Group, number> = { car: 100 - truck1Pct - truck2Pct, truck1: truck1Pct, truck2: truck2Pct };
  const sum = groups.reduce((total, group) => total + (share[group] / 100) * (10 ** (vehicleLevel[group] / 10) / speed[group]), 0);
  return 10 * lg(hourlyTraffic) + 10 * lg(sum) - 30;
}

export function roadEmission(pack: AcousticNormPack, source: RoadNoiseSource): RoadEmission {
  const rls = pack.rls19;
  const notes: RoadEmissionNote[] = [];
  const issues: RoadEmissionIssue[] = [];
  if (source.dailyTraffic === null) issues.push("missing_daily_traffic");
  const speed = groupSpeeds(rls, source.roadClass, source.speedLimitKmh);
  if (!speed) issues.push("missing_speed_limit");
  const surface = source.surface ?? rls.referenceSurface;
  if (!source.surface) notes.push("reference_surface");
  if (source.gradientPct === null) notes.push("flat_gradient");
  if (issues.length || !speed) return { ok: false, issues, notes };
  notes.push("standard_traffic");
  if (source.heavyVehicleSharePct !== null) notes.push("heavy_share_split");
  const vehicleLevel = {} as Record<Group, number>;
  for (const group of groups) {
    const correction = surfaceCorrection(rls, surface, group, speed[group]);
    if (correction === null) return { ok: false, issues: ["surface_not_defined_for_speed"], notes };
    vehicleLevel[group] = baseVehicleLevel(rls, group, speed[group]) + correction + gradientCorrection(rls, group, source.gradientPct ?? 0, speed[group]);
  }
  const period = (key: "day" | "night"): PeriodEmission => {
    const standard = rls.standardTraffic[source.roadClass]![key];
    const standardSum = standard.truck1Pct + standard.truck2Pct;
    // A measured truck share replaces the standard sum; the standard ratio splits it between the groups.
    const truck1Pct = source.heavyVehicleSharePct === null ? standard.truck1Pct
      : standardSum > 0 ? source.heavyVehicleSharePct * standard.truck1Pct / standardSum : 0;
    const truck2Pct = source.heavyVehicleSharePct === null ? standard.truck2Pct : source.heavyVehicleSharePct - truck1Pct;
    const hourlyTraffic = standard.hourlyPerDailyTraffic * source.dailyTraffic!;
    return {
      hourlyTraffic, truck1Pct, truck2Pct, speedKmh: speed, vehicleLevelDb: vehicleLevel,
      lineLevelDb: lineLevel(hourlyTraffic / 2, truck1Pct, truck2Pct, speed, vehicleLevel),
    };
  };
  return { ok: true, day: period("day"), night: period("night"), notes };
}

/** One line per direction, offset from the axis by the lane rule; a mapped carriageway of a divided road is one direction. */
export function sourceLines(rls: Rls19, source: RoadNoiseSource): { lines: Point2[][]; lanesAssumed: boolean } {
  const lanes = source.lanes && source.lanes > 0 ? source.lanes : 2;
  const perDirection = Math.max(1, Math.round(lanes / 2));
  const offsets = rls.sourceLineLanes.offsets;
  const offsetLanes = perDirection <= offsets.length ? offsets[perDirection - 1]! : perDirection - rls.sourceLineLanes.manyLanesFromOuter;
  const offset = offsetLanes * source.laneWidthM;
  const lines: Point2[][] = [];
  for (const part of source.parts) {
    if (part.length < 2) continue;
    if (isCarriageway(part, source.parts)) { lines.push(part); continue; }
    lines.push(offsetPolyline(part, offset), offsetPolyline(part, -offset));
  }
  return { lines, lanesAssumed: !source.lanes };
}

const direction = (part: Point2[]): Point2 => {
  const [a, b] = [part[0]!, part.at(-1)!];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
};
/** The point halfway along the polyline. */
function midpoint(part: Point2[]): Point2 {
  const lengths = part.slice(1).map((p, i) => Math.hypot(p[0] - part[i]![0], p[1] - part[i]![1]));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]! && lengths[i]) {
      const t = remaining / lengths[i]!, [a, b] = [part[i]!, part[i + 1]!];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= lengths[i]!;
  }
  return part[0]!;
}

/** A part runs beside a parallel twin 5–60 m to its side: the two carriageways of a divided road, each carrying one direction. */
function isCarriageway(part: Point2[], parts: Point2[][]) {
  const d = direction(part), m = midpoint(part);
  return parts.some(other => {
    if (other === part || other.length < 2) return false;
    const o = direction(other);
    if (Math.abs(d[0] * o[0] + d[1] * o[1]) < 0.95) return false;
    const { distance, point } = closestOnPolyline(m, other);
    // Beside, not ahead: consecutive pieces of one carriageway lie along the direction of travel.
    const along = distance ? Math.abs(((point[0] - m[0]) * d[0] + (point[1] - m[1]) * d[1]) / distance) : 1;
    return distance > 5 && distance < 60 && along < 0.3;
  });
}

function closestOnPolyline(p: Point2, line: Point2[]) {
  let best = { distance: Infinity, point: p };
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i]!, line[i + 1]!];
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
    const point: Point2 = [a[0] + t * dx, a[1] + t * dy];
    const distance = Math.hypot(p[0] - point[0], p[1] - point[1]);
    if (distance < best.distance) best = { distance, point };
  }
  return best;
}

const pointToPolyline = (p: Point2, line: Point2[]) => closestOnPolyline(p, line).distance;

function offsetPolyline(part: Point2[], offset: number): Point2[] {
  if (!offset) return part;
  return part.map((p, i) => {
    const a = part[Math.max(0, i - 1)]!, b = part[Math.min(part.length - 1, i + 1)]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] - ((b[1] - a[1]) / length) * offset, p[1] + ((b[0] - a[0]) / length) * offset] as Point2;
  });
}

/** Attenuation from a point source at height h_s to the receiver over flat ground, free propagation. */
export function attenuation(rls: Rls19, horizontalM: number, sourceHeightM: number, receiverHeightM: number) {
  const s = Math.hypot(horizontalM, receiverHeightM - sourceHeightM);
  const hm = (sourceHeightM + receiverHeightM) / 2;
  const { maxDb, heightFactor, distanceTermM } = rls.propagation.ground;
  const divergence = 20 * lg(s) + rls.propagation.divergenceConstantDb;
  const air = s / rls.propagation.airAbsorptionDivisorM;
  const ground = Math.max(maxDb - (hm / s) * (heightFactor + distanceTermM / s), 0);
  return { s, hm, divergence, air, ground, total: divergence + air + ground };
}

/**
 * Sum of the line pieces reaching the receiver: L = 10 lg Σ 10^((L'w + 10 lg l − D_A)/10).
 * Pieces are no longer than a third of their distance, finer than the guideline's half-distance rule.
 */
export function lineRatingLevel(rls: Rls19, line: Point2[], lineLevelDb: number, receiver: RoadNoiseReceiver) {
  const [rx, ry, rz] = receiver.position;
  const levels: number[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i]!, line[i + 1]!];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!length) continue;
    const nearest = pointToPolyline([rx, ry], [a, b]);
    const pieces = Math.max(1, Math.ceil(length / Math.max(0.5, nearest / 3)));
    const pieceLength = length / pieces;
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      if (receiver.normal && (x - rx) * receiver.normal[0] + (y - ry) * receiver.normal[1] <= 0) continue;
      const { total } = attenuation(rls, Math.hypot(x - rx, y - ry), rls.sourceHeightM, rz);
      levels.push(lineLevelDb + 10 * lg(pieceLength) - total);
    }
  }
  return energySum(levels);
}

/** Rating levels Lr,day and Lr,night per receiver and source; null when no part of the source is in front of the facade. */
export function roadRatingLevels(pack: AcousticNormPack, sources: RoadNoiseSource[], receivers: RoadNoiseReceiver[]): RoadRatingLevel[] {
  const rls = pack.rls19;
  const results: RoadRatingLevel[] = [];
  for (const source of sources) {
    const emission = roadEmission(pack, source);
    if (!emission.ok) {
      for (const receiver of receivers) results.push({ receiverId: receiver.id, sourceId: source.id, ok: false, emission });
      continue;
    }
    const { lines, lanesAssumed } = sourceLines(rls, source);
    if (lanesAssumed && !emission.notes.includes("lanes_assumed")) emission.notes.push("lanes_assumed");
    for (const receiver of receivers) {
      // Day and night differ only by the line level, so one geometric pass serves both.
      const geometric = energySum(lines.map(line => lineRatingLevel(rls, line, 0, receiver)));
      const level = (lineLevelDb: number) => Number.isFinite(geometric) ? geometric + lineLevelDb : null;
      results.push({ receiverId: receiver.id, sourceId: source.id, ok: true, dayDb: level(emission.day.lineLevelDb), nightDb: level(emission.night.lineLevelDb), emission, lanesAssumed });
    }
  }
  return results;
}
