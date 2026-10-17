/**
 * Ceilings from plan extraction. A floor plan shows no slab, but every storey
 * with accepted rooms has a ceiling over them, and that ceiling is the floor of
 * the storey above. Richtfest creates one ceiling per storey so its component
 * data can be requested, entered and reviewed like a wall's; thickness and
 * construction come from sections or the architect, never from the plan.
 */
export const storeyCeilingMethod = "storey_ceiling_v1";
export const storeyCeilingKey = (storeyId: string) => `ceiling-above:${storeyId}`;

type Storey = { id: string; buildingId: string; name: string; levelIndex: number | null };
type Entity = { id: string; storeyId?: string | null; stableKey?: string; constructionState?: string; geometry: unknown };
type Source = { sourceVersionId: string; page: number };

export type PlannedCeiling = { storeyId: string; buildingId: string; stableKey: string; name: string; existingId: string | null;
  source: Source; constructionState: string; roomIds: string[]; upperStoreyId: string | null };

const sourceOf = (entity: Entity): Source | null => {
  const source = entity.geometry && typeof entity.geometry === "object" ? (entity.geometry as { source?: Partial<Source> }).source : undefined;
  return source?.sourceVersionId && source.page ? { sourceVersionId: source.sourceVersionId, page: source.page } : null;
};
const mostCommon = <T,>(values: T[]) => {
  const counts = new Map<string, { value: T; count: number }>();
  for (const value of values) { const key = JSON.stringify(value); counts.set(key, { value, count: (counts.get(key)?.count ?? 0) + 1 }); }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.value;
};

/** One ceiling per storey that has accepted plan rooms. The storey above is linked only when both levels are known. */
export function planStoreyCeilings(input: { storeys: Storey[]; rooms: Entity[]; elements: Entity[] }): PlannedCeiling[] {
  return input.storeys.flatMap(storey => {
    const rooms = input.rooms.filter(room => room.storeyId === storey.id && sourceOf(room));
    if (!rooms.length) return [];
    const stableKey = storeyCeilingKey(storey.id);
    const upper = storey.levelIndex === null ? null
      : input.storeys.find(other => other.buildingId === storey.buildingId && other.levelIndex === storey.levelIndex! + 1) ?? null;
    return [{ storeyId: storey.id, buildingId: storey.buildingId, stableKey, name: `Ceiling above ${storey.name}`,
      existingId: input.elements.find(element => element.stableKey === stableKey)?.id ?? null,
      source: mostCommon(rooms.map(room => sourceOf(room)!))!,
      // A ceiling over proposed rooms is proposed construction; mixed storeys stay unknown.
      constructionState: rooms.every(room => room.constructionState === rooms[0].constructionState) ? rooms[0].constructionState ?? "unknown" : "unknown",
      roomIds: rooms.map(room => room.id), upperStoreyId: upper?.id ?? null }];
  });
}
