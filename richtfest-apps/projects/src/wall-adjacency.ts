import { deriveWallRole, type SpaceContext, type SpaceType, type WallRole } from "@richtfest/shared";

type Point = { x: number; y: number };
export type AdjacencyRoom = { id: string; polygon: Point[]; holes?: Point[][] };
/**
 * Rooms touched by a wall face, with probe hits; "exterior" when nothing lies
 * beyond the face up to the page edge; null when the face is unresolved.
 */
export type WallSide = Array<{ roomId: string; hits: number }> | "exterior" | null;
export type PageScale = { pageAspectRatio: number; metresPerPageHeight: number | null; denominator?: number | null };

export const wallAdjacencyMethod = "plan_side_probe_v2";
const probeFractions = [0.2, 0.35, 0.5, 0.65, 0.8];

const inside = (point: Point, ring: Point[]) => {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
};
const inRoom = (point: Point, room: AdjacencyRoom) => inside(point, room.polygon) && !(room.holes ?? []).some(hole => inside(point, hole));

/** Long axis, extents and centre line of a wall polygon in the given space. */
function wallFrame(wall: Point[]) {
  if (wall.length < 3) return null;
  let start = wall[0], end = wall[1], longest = 0;
  for (let i = 0; i < wall.length; i++) {
    const a = wall[i], b = wall[(i + 1) % wall.length], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > longest) { longest = length; start = a; end = b; }
  }
  if (!(longest > 0)) return null;
  const u = { x: (end.x - start.x) / longest, y: (end.y - start.y) / longest }, v = { x: -u.y, y: u.x };
  const along = wall.map(p => (p.x - start.x) * u.x + (p.y - start.y) * u.y);
  const across = wall.map(p => (p.x - start.x) * v.x + (p.y - start.y) * v.y);
  const [minAlong, maxAlong] = [Math.min(...along), Math.max(...along)], [minAcross, maxAcross] = [Math.min(...across), Math.max(...across)];
  const thickness = maxAcross - minAcross;
  if (!(thickness > 0) || maxAlong - minAlong < thickness) return null;
  const at = (s: number, t: number) => ({ x: start.x + u.x * s + v.x * t, y: start.y + u.y * s + v.y * t });
  return { u, v, minAlong, maxAlong, thickness, centre: (minAcross + maxAcross) / 2, at };
}

/**
 * Wall thickness in cm at the page's printed scale, to the nearest 0.5 cm, or
 * null without a scale. Measured across the exact source polygon.
 */
export function wallThicknessCm(wall: Point[], scale: PageScale) {
  if (!scale.metresPerPageHeight || !(scale.pageAspectRatio > 0)) return null;
  const metres = wall.map(p => ({ x: p.x * scale.pageAspectRatio * scale.metresPerPageHeight!, y: p.y * scale.metresPerPageHeight! }));
  const frame = wallFrame(metres);
  return frame ? Math.round(frame.thickness * 200) / 2 : null;
}

/**
 * Which accepted rooms lie on either side of a wall polygon, in the same
 * normalized page space. Probes step off both long faces at several points
 * along the wall; a side resolves only when most probes land in accepted
 * rooms. A face may border several rooms (a long corridor wall).
 * Rooms are raster regions that stop short of the wall face, so the probe
 * clears the face by at least the wall's own thickness.
 * A face without rooms is exterior only when rays cast outward from it reach
 * the page edge without crossing any room, accepted or still a candidate.
 */
export function wallSides(wall: Point[], rooms: AdjacencyRoom[], obstacles: AdjacencyRoom[] = rooms): [WallSide, WallSide] | null {
  const frame = wallFrame(wall);
  if (!frame) return null;
  const { minAlong, maxAlong, thickness, centre, at } = frame;
  const clearance = thickness / 2 + Math.max(thickness, 0.004);
  const outside = (s: number, direction: 1 | -1) => {
    for (let t = clearance; t < 2; t += 0.002) {
      const point = at(s, centre + direction * t);
      if (point.x < 0 || point.y < 0 || point.x > 1 || point.y > 1) return true;
      if (obstacles.some(room => inRoom(point, room))) return false;
    }
    return true;
  };
  const side = (direction: 1 | -1): WallSide => {
    const counts = new Map<string, number>();
    for (const fraction of probeFractions) {
      const point = at(minAlong + (maxAlong - minAlong) * fraction, centre + direction * clearance);
      const room = rooms.find(candidate => inRoom(point, candidate));
      if (room) counts.set(room.id, (counts.get(room.id) ?? 0) + 1);
    }
    const hits = [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (hits > probeFractions.length / 2) return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([roomId, count]) => ({ roomId, hits: count }));
    if (hits === 0 && [0.35, 0.5, 0.65].every(fraction => outside(minAlong + (maxAlong - minAlong) * fraction, direction))) return "exterior";
    return null;
  };
  return [side(-1), side(1)];
}

const exteriorName = /^(balkon|loggia|terrasse|dachterrasse|garten|freisitz|balcony|terrace)/i;
const stairName = /^(treppenhaus|treppenraum|treppe|stair)/i;
const corridorName = /^(flur|korridor|gang|diele|eingang|eingangshalle|vorraum|corridor|hall)/i;

/**
 * Space context of a room for wall-role derivation. Reviewed or entered
 * properties win; otherwise the apartment marker from plan extraction and the
 * room label give an inferred context. A circulation label only counts as a
 * common space when the room is outside every apartment.
 */
export function roomSpaceContext(room: { name: string; groupLabel?: string | null }, properties: { apartmentUnit?: unknown; spaceType?: unknown }): SpaceContext & { inferred: boolean } {
  const unitProperty = typeof properties.apartmentUnit === "string" ? properties.apartmentUnit : null;
  const apartmentUnit = unitProperty ?? (room.groupLabel?.trim() || null);
  if (typeof properties.spaceType === "string") return { apartmentUnit, spaceType: properties.spaceType as SpaceType, inferred: !unitProperty && Boolean(apartmentUnit) };
  const name = room.name.trim();
  const spaceType: SpaceType | null = exteriorName.test(name) ? "exterior"
    : apartmentUnit ? "apartment"
    : stairName.test(name) ? "stairwell"
    : corridorName.test(name) ? "common_corridor" : null;
  return { apartmentUnit, spaceType, inferred: true };
}

export type ModelProperty = { entityType: string; entityId: string; propertyKey: string;
  current: { value: unknown; reviewStatus: string; provenance: string } | null; reviewed: { value: unknown } | null };
type ModelEntity = { id: string; name: string; kind?: string; geometry: unknown };
type PlanGeometry = { polygon?: Point[]; holes?: Point[][]; groupLabel?: string | null; planRegion?: { x: number; y: number; width: number; height: number };
  source?: { sourceVersionId?: string; page?: number } };

/** Latest non-rejected value, falling back to the last approved one. */
export const effectiveValue = (property: ModelProperty | undefined) =>
  property?.current && property.current.reviewStatus !== "rejected" ? property.current.value : property?.reviewed?.value ?? null;

export type PlannedWall = { wallId: string; sourceVersionId: string; page: number; planRegion: PlanGeometry["planRegion"] | null;
  sides: [WallSide, WallSide]; role: WallRole | null; writeRole: boolean; thicknessCm: number | null; writeThickness: boolean; scaleDenominator: number | null };

/** Derived values never replace a person's entry or any reviewed value, and are not repeated or re-proposed after rejection. */
export const derivedWritable = (existing: ModelProperty | undefined, value: unknown) => value !== null && !existing?.reviewed
  && (!existing?.current || (existing.current.provenance === "inferred" && existing.current.reviewStatus !== "approved" && existing.current.value !== value));

/**
 * Plans adjacency, wall-role and thickness proposals for accepted walls. Pure:
 * the caller persists the result. A role is proposed only when every pair of
 * sides across the wall yields the same role.
 */
export function planWallAdjacency(input: { rooms: ModelEntity[]; elements: ModelEntity[]; properties: ModelProperty[];
  candidateRooms?: ModelEntity[]; scales?: Map<string, PageScale> }) {
  const props = new Map<string, ModelProperty>();
  for (const property of input.properties) props.set(`${property.entityType}:${property.entityId}:${property.propertyKey}`, property);
  const prop = (type: string, id: string, key: string) => props.get(`${type}:${id}:${key}`);
  const geometry = (entity: ModelEntity) => (entity.geometry && typeof entity.geometry === "object" ? entity.geometry : {}) as PlanGeometry;
  const sourceKey = (g: PlanGeometry) => g.source?.sourceVersionId && g.source.page ? `${g.source.sourceVersionId}:${g.source.page}` : null;
  const roomsBySource = new Map<string, Array<AdjacencyRoom & { context: SpaceContext }>>();
  for (const room of input.rooms) {
    const g = geometry(room), key = sourceKey(g);
    if (!key || !Array.isArray(g.polygon) || g.polygon.length < 3) continue;
    const context = roomSpaceContext({ name: room.name, groupLabel: g.groupLabel },
      { apartmentUnit: effectiveValue(prop("room", room.id, "apartmentUnit")), spaceType: effectiveValue(prop("room", room.id, "spaceType")) });
    roomsBySource.set(key, [...(roomsBySource.get(key) ?? []), { id: room.id, polygon: g.polygon, holes: g.holes, context }]);
  }
  // Unreviewed room regions still block the exterior test: an unaccepted room is not outside.
  const candidatesBySource = new Map<string, AdjacencyRoom[]>();
  for (const candidate of input.candidateRooms ?? []) {
    const g = geometry(candidate), key = sourceKey(g);
    if (key && Array.isArray(g.polygon) && g.polygon.length >= 3) candidatesBySource.set(key, [...(candidatesBySource.get(key) ?? []), { id: candidate.id, polygon: g.polygon, holes: g.holes }]);
  }
  const outside: SpaceContext = { apartmentUnit: null, spaceType: "exterior" };
  const walls: PlannedWall[] = [];
  for (const element of input.elements) {
    const g = geometry(element), key = sourceKey(g);
    const isWall = element.kind === "draft_wall" || effectiveValue(prop("element", element.id, "componentType")) === "wall";
    if (!isWall || !key || !Array.isArray(g.polygon)) continue;
    const rooms = roomsBySource.get(key) ?? [];
    const sides = wallSides(g.polygon, rooms, [...rooms, ...(candidatesBySource.get(key) ?? [])]);
    if (!sides) continue;
    const contexts = (side: WallSide) => side === "exterior" ? [outside] : side ? side.map(item => rooms.find(room => room.id === item.roomId)!.context) : [null];
    const roles = contexts(sides[0]).flatMap(a => contexts(sides[1]).map(b => deriveWallRole(a, b)));
    const role = roles.every(item => item && item === roles[0]) ? roles[0] : null;
    const scale = input.scales?.get(key);
    const thicknessCm = scale ? wallThicknessCm(g.polygon, scale) : null;
    walls.push({ wallId: element.id, sourceVersionId: g.source!.sourceVersionId!, page: g.source!.page!, planRegion: g.planRegion ?? null, sides, role,
      writeRole: derivedWritable(prop("element", element.id, "wallRole"), role), thicknessCm,
      writeThickness: derivedWritable(prop("element", element.id, "thickness"), thicknessCm), scaleDenominator: scale?.denominator ?? null });
  }
  return walls;
}
