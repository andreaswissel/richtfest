type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

export const planOpeningMethod = "plan_opening_gap_v1";

/** An opening the plan trace found: a gap between two facing wall ends, optionally with a door swing. Page-normalised coordinates. */
export type TracedOpening = {
  sourceKey: string; kind: string; wallAxis: "horizontal" | "vertical" | "oblique"; sourceKeys: string[]; doorSwingKey: string | null;
  physicalWidthM: number | null; jambLength: number; midpoint: Point; closure: Box; sides: string[];
};
export type OpeningPage = { sourceVersionId: string; page: number; storeyId: string; pageAspectRatio: number; openings: TracedOpening[] };
export type OpeningWall = { id: string; storeyId: string; sourceVersionId: string; page: number; footprintKeys: string[]; exterior: boolean; roomIds: string[] };
export type OpeningRoom = { id: string; storeyId: string; polygon: Point[] | null; candidateKey: string | null };
/**
 * Openings already in the model. `planKey` is the plan opening an element was
 * derived from or adopted; without one, the opening was entered (in a
 * verification or from a schedule) and has no place on the plan yet.
 */
export type ExistingOpening = { id: string; kind: string; wallId: string | null; planKey: string | null };

type Placement = { kind: "window" | "door"; storeyId: string; wallId: string; roomId: string; widthM: number | null;
  sourceVersionId: string; page: number; sourceOpeningKey: string; closure: Box; doorSwing: boolean; planKey: string };
/** A new element for a plan opening, or an entered opening that takes the plan opening's place. */
export type PlannedOpening = Placement & ({ action: "create" } | { action: "adopt"; elementId: string });
export type OpeningOutcome = "window" | "door" | "adopted" | "existing" | "ambiguous" | "passage" | "no_wall" | "no_room";

const inside = (point: Point, polygon: Point[]) => {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
};

export const planOpeningKey = (page: Pick<OpeningPage, "sourceVersionId" | "page">, opening: Pick<TracedOpening, "sourceKey">) =>
  `plan-opening:${page.sourceVersionId}:${page.page}:${opening.sourceKey}`;

/**
 * Turns the openings a plan trace found into window and door elements. Pure:
 * the caller persists the result. A gap with a door swing is a door; a gap
 * without one is a window only in an exterior wall bounding one room
 * (elsewhere it may be a passage). Each opening sits in the wall one of its
 * jambs belongs to and belongs to the room on its inner side.
 *
 * Openings already placed are kept as they are. Where a wall holds openings
 * entered without a place on the plan, the plan's gap takes the entered
 * opening when the wall has exactly one of each of that kind; otherwise the
 * gaps are left for a person, so no opening is counted twice.
 */
export function planOpenings(input: { pages: OpeningPage[]; walls: OpeningWall[]; rooms: OpeningRoom[]; existing: ExistingOpening[] }) {
  const placed = new Set(input.existing.flatMap(item => item.planKey ? [item.planKey] : []));
  const candidates: Placement[] = [];
  const outcomes: Array<{ planKey: string; storeyId: string; outcome: OpeningOutcome }> = [];
  for (const page of input.pages) {
    const walls = input.walls.filter(wall => wall.sourceVersionId === page.sourceVersionId && wall.page === page.page);
    const rooms = input.rooms.filter(room => room.storeyId === page.storeyId);
    for (const opening of page.openings) {
      const planKey = planOpeningKey(page, opening);
      const outcome = (value: OpeningOutcome) => outcomes.push({ planKey, storeyId: page.storeyId, outcome: value });
      if (placed.has(planKey)) { outcome("existing"); continue; }
      const door = Boolean(opening.doorSwingKey) || opening.kind.startsWith("door_swing");
      // The rooms on either side: by the trace's room keys, else the rooms containing a point beyond either jamb face.
      const keyed = opening.sides.map(side => rooms.find(room => room.candidateKey && room.candidateKey === side)?.id ?? null);
      const probed = keyed.every(Boolean) ? [] : [-1, 1].flatMap(sign => {
        for (const factor of [1, 2, 4]) {
          const offset = sign * factor * Math.max(opening.jambLength, 0.004);
          const probe = opening.wallAxis === "vertical" ? { x: opening.midpoint.x + offset / page.pageAspectRatio, y: opening.midpoint.y }
            : { x: opening.midpoint.x, y: opening.midpoint.y + offset };
          const room = rooms.find(item => item.polygon && item.polygon.length >= 3 && inside(probe, item.polygon));
          if (room) return [room.id];
        }
        return [];
      });
      const roomIds = [...new Set([...keyed.filter((id): id is string => Boolean(id)), ...probed])];
      const hosts = walls.filter(wall => wall.footprintKeys.some(key => opening.sourceKeys.includes(key)));
      if (!hosts.length) { outcome("no_wall"); continue; }
      // A door leads into the room on its inner side; between two rooms, into the first.
      const roomId = roomIds[0];
      if (!roomId) { outcome("no_room"); continue; }
      if (!door && (!hosts.some(wall => wall.exterior) || roomIds.length > 1)) { outcome("passage"); continue; }
      // Prefer an exterior jamb wall that bounds the room, then any wall bounding it, then the first.
      const host = hosts.find(wall => wall.exterior && wall.roomIds.includes(roomId)) ?? hosts.find(wall => wall.roomIds.includes(roomId)) ?? hosts[0]!;
      candidates.push({ kind: door ? "door" : "window", storeyId: page.storeyId, wallId: host.id, roomId, planKey,
        widthM: opening.physicalWidthM !== null ? Math.round(opening.physicalWidthM * 100) / 100 : null,
        sourceVersionId: page.sourceVersionId, page: page.page, sourceOpeningKey: opening.sourceKey, closure: opening.closure, doorSwing: door });
    }
  }
  // Entered openings without a place, per wall and kind; the number of gaps of that kind in the same wall.
  const unplaced = new Map<string, ExistingOpening[]>(), gaps = new Map<string, number>();
  for (const item of input.existing) if (!item.planKey && item.wallId) unplaced.set(`${item.wallId}:${item.kind}`, [...(unplaced.get(`${item.wallId}:${item.kind}`) ?? []), item]);
  for (const item of candidates) gaps.set(`${item.wallId}:${item.kind}`, (gaps.get(`${item.wallId}:${item.kind}`) ?? 0) + 1);
  const planned: PlannedOpening[] = [];
  for (const item of candidates) {
    const key = `${item.wallId}:${item.kind}`, entered = unplaced.get(key) ?? [];
    const outcome = (value: OpeningOutcome) => outcomes.push({ planKey: item.planKey, storeyId: item.storeyId, outcome: value });
    if (!entered.length) { planned.push({ ...item, action: "create" }); outcome(item.kind); }
    else if (entered.length === 1 && gaps.get(key) === 1) { planned.push({ ...item, action: "adopt", elementId: entered[0]!.id }); outcome("adopted"); }
    else outcome("ambiguous");
  }
  const count = (value: OpeningOutcome) => outcomes.filter(entry => entry.outcome === value).length;
  return { planned, outcomes, summary: { windows: count("window"), doors: count("door"), adopted: count("adopted"), kept: count("existing"), ambiguous: count("ambiguous") } };
}
