import { and, eq, gt, inArray } from "drizzle-orm";
import type { PublicDataSnapshot, PublicDataUpdate } from "@richtfest/shared";
import { assets, datasets, partitions, releaseMembers, releases, revisions } from "./schema";
import { BERLIN_BBOX, berlinSources } from "./catalogue";

export async function releaseFeatures(db: any, releaseId: string, limit: number, after?: string) {
  return db.select({ revisionId: revisions.id, sourceId: revisions.sourceId, feature: revisions.feature })
    .from(releaseMembers).innerJoin(revisions, eq(revisions.id, releaseMembers.revisionId))
    .where(and(eq(releaseMembers.releaseId, releaseId), after ? gt(releaseMembers.sourceId, after) : undefined))
    .orderBy(releaseMembers.sourceId).limit(limit);
}

export async function readBerlinSnapshot(db: any, origin?: [number, number], radius = 100): Promise<PublicDataSnapshot | null> {
  const covers = (bbox: number[]) => !origin || (origin[0] - radius >= bbox[0]! && origin[1] - radius >= bbox[1]! && origin[0] + radius <= bbox[2]! && origin[1] + radius <= bbox[3]!);
  // Other saved addresses retain their on-demand import; never substitute the pilot site.
  if (!covers(BERLIN_BBOX)) return null;
  // Capture the three current pointers together, then read immutable releases. No live fetch on reads.
  const rows = await db.select({ release: releases, dataset: datasets, asset: assets }).from(partitions)
    .innerJoin(releases, eq(releases.id, partitions.currentReleaseId))
    .innerJoin(datasets, eq(datasets.id, partitions.datasetId))
    .innerJoin(assets, eq(assets.id, releases.assetId))
    .where(inArray(partitions.id, berlinSources.map(s => s.partitionId)));
  if (rows.length !== berlinSources.length) throw new Error("Location context public data is not ready; retry after catalogue imports complete");
  if (rows.some(({ release }: { release: typeof releases.$inferSelect }) => !covers(release.bbox))) return null;
  return { releases: await Promise.all(rows.map(async ({ release, dataset, asset }: any) => ({
    id: release.id, partitionId: release.partitionId, datasetId: dataset.id, label: dataset.label,
    metadata: release.metadata, sourceUrl: asset.sourceUrl, retrievedAt: asset.retrievedAt.toISOString(), publishedAt: release.publishedAt.toISOString(),
    features: await releaseFeatures(db, release.id, 10000),
  }))) };
}

export async function availableUpdates(db: any, pinnedIds: string[]): Promise<PublicDataUpdate[]> {
  if (!pinnedIds.length) return [];
  const rows = await db.select({ partitionId: partitions.id, pinnedReleaseId: releases.id, latestReleaseId: partitions.currentReleaseId })
    .from(releases).innerJoin(partitions, eq(partitions.id, releases.partitionId)).where(inArray(releases.id, pinnedIds));
  return rows.filter((row: any) => row.latestReleaseId && row.latestReleaseId !== row.pinnedReleaseId);
}
