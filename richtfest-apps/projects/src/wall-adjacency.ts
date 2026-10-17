import { deriveWallRole, type SpaceContext, type SpaceType, type WallRole } from "@richtfest/shared";

type Point = { x: number; y: number };
export type AdjacencyRoom = { id: string; polygon: Point[]; holes?: Point[][] };
/** Rooms touched by a wall face, with probe hits; null when most probes found no accepted room. */
export type WallSide = Array<{ roomId: string; hits: number }> | null;

export const wallAdjacencyMethod = "plan_side_probe_v1";
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

/**
 * Which accepted rooms lie on either side of a wall polygon, in the same
 * normalized page space. Probes step off both long faces at several points
 * along the wall; a side resolves only when most probes land in accepted
 * rooms. A face may border several rooms (a long corridor wall).
 * Rooms are raster regions that stop short of the wall face, so the probe
 * clears the face by at least the wall's own thickness.
 */
export function wallSides(wall: Point[], rooms: AdjacencyRoom[]): [WallSide, WallSide] | null {
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
  const thickness = maxAcross - minAcross, centre = (minAcross + maxAcross) / 2;
  if (!(thickness > 0) || maxAlong - minAlong < thickness) return null;
  const clearance = thickness / 2 + Math.max(thickness, 0.004);
  const side = (direction: 1 | -1): WallSide => {
    const counts = new Map<string, number>();
    for (const fraction of probeFractions) {
      const s = minAlong + (maxAlong - minAlong) * fraction, t = centre + direction * clearance;
      const point = { x: start.x + u.x * s + v.x * t, y: start.y + u.y * s + v.y * t };
      const room = rooms.find(candidate => inRoom(point, candidate));
      if (room) counts.set(room.id, (counts.get(room.id) ?? 0) + 1);
    }
    const hits = [...counts.values()].reduce((sum, count) => sum + count, 0);
    return hits > probeFractions.length / 2 ? [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([roomId, count]) => ({ roomId, hits: count })) : null;
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

type ModelProperty = { entityType: string; entityId: string; propertyKey: string;
  current: { value: unknown; reviewStatus: string; provenance: string } | null; reviewed: { value: unknown } | null };
type ModelEntity = { id: string; name: string; kind?: string; geometry: unknown };
type PlanGeometry = { polygon?: Point[]; holes?: Point[][]; groupLabel?: string | null; planRegion?: { x: number; y: number; width: number; height: number };
  source?: { sourceVersionId?: string; page?: number } };

/** Latest non-rejected value, falling back to the last approved one. */
export const effectiveValue = (property: ModelProperty | undefined) =>
  property?.current && property.current.reviewStatus !== "rejected" ? property.current.value : property?.reviewed?.value ?? null;

export type PlannedWall = { wallId: string; sourceVersionId: string; page: number; planRegion: PlanGeometry["planRegion"] | null;
  sides: [WallSide, WallSide]; role: WallRole | null; writeRole: boolean };

/**
 * Plans adjacency and wall-role proposals for accepted walls. Pure: the caller
 * persists the result. A role is proposed only when every room pair across the
 * wall yields the same role, and never over a person's entry or review.
 */
export function planWallAdjacency(input: { rooms: ModelEntity[]; elements: ModelEntity[]; properties: ModelProperty[] }) {
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
  const walls: PlannedWall[] = [];
  for (const element of input.elements) {
    const g = geometry(element), key = sourceKey(g);
    const isWall = element.kind === "draft_wall" || effectiveValue(prop("element", element.id, "componentType")) === "wall";
    if (!isWall || !key || !Array.isArray(g.polygon)) continue;
    const rooms = roomsBySource.get(key) ?? [];
    const sides = wallSides(g.polygon, rooms);
    if (!sides) continue;
    const context = (id: string) => rooms.find(room => room.id === id)!.context;
    const roles = sides[0] && sides[1] ? sides[0].flatMap(a => sides[1]!.map(b => deriveWallRole(context(a.roomId), context(b.roomId)))) : [null];
    const role = roles.every(item => item && item === roles[0]) ? roles[0] : null;
    const existing = prop("element", element.id, "wallRole");
    const writeRole = Boolean(role) && !existing?.reviewed && (!existing?.current || (existing.current.provenance === "inferred"
      && existing.current.value !== role && existing.current.reviewStatus !== "approved"));
    walls.push({ wallId: element.id, sourceVersionId: g.source!.sourceVersionId!, page: g.source!.page!, planRegion: g.planRegion ?? null, sides, role, writeRole });
  }
  return walls;
}
