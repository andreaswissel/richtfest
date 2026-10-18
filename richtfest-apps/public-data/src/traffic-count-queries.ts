import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { TrafficCountRecord } from "@richtfest/shared";
import { trafficCountRuns, trafficCounts, trafficCountSources } from "./schema";
import { countSource } from "./traffic-count-sources";
import { MAX_EXTENT_DEG } from "./traffic-count-worker";

const LIMIT = 2000;

/** Current-release count records whose extent overlaps [west, south, east, north] (WGS84). No live fetch. */
export async function trafficCountsInBox(db: any, bbox: [number, number, number, number]): Promise<TrafficCountRecord[]> {
  const [west, south, east, north] = bbox;
  const rows: Array<typeof trafficCounts.$inferSelect> = await db.select({ count: trafficCounts }).from(trafficCounts)
    .innerJoin(trafficCountSources, and(eq(trafficCountSources.id, trafficCounts.sourceId), eq(trafficCountSources.currentRelease, trafficCounts.release)))
    .where(and(
      // Records are at most MAX_EXTENT_DEG wide, so the index range on min_lat/min_lon stays a narrow band.
      gte(trafficCounts.minLat, south - MAX_EXTENT_DEG), lte(trafficCounts.minLat, north),
      gte(trafficCounts.minLon, west - MAX_EXTENT_DEG), lte(trafficCounts.minLon, east),
      gte(trafficCounts.maxLat, south), gte(trafficCounts.maxLon, west),
    )).orderBy(trafficCounts.sourceId, trafficCounts.stationId).limit(LIMIT)
    .then((result: Array<{ count: typeof trafficCounts.$inferSelect }>) => result.map(row => row.count));
  return rows.flatMap(row => {
    const source = countSource(row.sourceId);
    if (!source) return [];
    return [{
      sourceId: row.sourceId, label: source.label, sourceUrl: row.sourceUrl, licence: source.licence, release: row.release, year: row.year,
      stationId: row.stationId, road: row.road, name: row.name, kind: row.kind, specificity: source.specificity, geometry: row.geometry,
      dailyTraffic: row.dailyTraffic, heavyVehicles: row.heavyVehicles,
      hourly: { day: row.hourlyDay, night: row.hourlyNight, heavyShareDay: row.heavyShareDay, heavyShareNight: row.heavyShareNight, p1Day: row.p1Day, p2Day: row.p2Day, p1Night: row.p1Night, p2Night: row.p2Night },
      checksum: row.checksum, importedAt: row.importedAt.toISOString(),
    }];
  });
}

/** Import checkpoints and the latest runs per source, for operators and agents. */
export async function trafficCountStatus(db: any) {
  const sources: Array<typeof trafficCountSources.$inferSelect> = await db.select().from(trafficCountSources).orderBy(trafficCountSources.id);
  const runs: Array<typeof trafficCountRuns.$inferSelect> = await db.select().from(trafficCountRuns).orderBy(desc(trafficCountRuns.startedAt)).limit(50);
  return sources.map(({ leaseToken: _lease, ...row }) => {
    const source = countSource(row.id);
    // Private evidence keys stay internal; runs expose source URLs, checksums and sizes.
    const recent = runs.filter(run => run.sourceId === row.id).slice(0, 5).map(run => ({ ...run, files: run.files?.map(({ storageKey: _key, ...file }) => file) ?? null }));
    return { ...row, label: source?.label ?? row.id, licence: source?.licence ?? null, attribution: source?.attribution ?? null, files: source?.files ?? [], runs: recent };
  });
}
