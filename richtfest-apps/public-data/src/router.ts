import { Router, type Request } from "express";
import { desc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { ok, type PublicReleaseStatusResponse } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { assets, datasets, partitions, releases, runs } from "./schema";
import { releaseFeatures } from "./queries";
import { trafficCountStatus } from "./traffic-count-queries";

export function createRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.use((req, _res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:read");
      if (!d.enabled) throw Object.assign(new Error("Public data catalogue is not enabled"), { status: 503, code: "public_data_disabled" });
      next();
    } catch (error) { next(error); }
  });
  router.get("/release-status", async (req, res, next) => {
    try {
      const ids = z.string().transform(value => value.split(",")).pipe(z.array(z.string().uuid()).min(1).max(20)).parse(req.query.ids);
      const d = getDeps(req);
      const rows = await d.db.select({ release: releases, label: datasets.label, partition: partitions, asset: assets })
        .from(releases).innerJoin(partitions, eq(partitions.id, releases.partitionId))
        .innerJoin(datasets, eq(datasets.id, partitions.datasetId))
        .innerJoin(assets, eq(assets.id, releases.assetId))
        .where(inArray(releases.id, ids)).orderBy(datasets.slug, releases.id);
      const result: PublicReleaseStatusResponse = {
        canRefreshProjectContext: d.canRefreshProjectContext,
        items: rows.map(({ release, label, partition, asset }: { release: typeof releases.$inferSelect; label: string; partition: typeof partitions.$inferSelect; asset: typeof assets.$inferSelect }) => ({
          releaseId: release.id, label, metadata: release.metadata, publishedAt: release.publishedAt.toISOString(),
          retrievedAt: asset.retrievedAt.toISOString(), featureCount: release.featureCount, checksum: asset.checksum, sourceUrl: asset.sourceUrl,
          partition: { id: partition.id, currentReleaseId: partition.currentReleaseId, enabled: partition.enabled,
            lastCheckedAt: partition.lastCheckedAt?.toISOString() ?? null, lastSuccessAt: partition.lastSuccessAt?.toISOString() ?? null,
            nextCheckAt: partition.nextCheckAt.toISOString(), error: partition.error },
          stale: !partition.lastSuccessAt || Date.now() - partition.lastSuccessAt.getTime() > partition.intervalSeconds * 1000,
        })),
      };
      res.json(ok(result));
    } catch (error) { next(error); }
  });
  router.get("/datasets", async (req, res, next) => {
    try {
      const query = z.object({ after: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
      const rows = await getDeps(req).db.select({ dataset: datasets, partition: {
        id: partitions.id, scope: partitions.scope, bbox: partitions.bbox, crs: partitions.crs, enabled: partitions.enabled,
        intervalSeconds: partitions.intervalSeconds, nextCheckAt: partitions.nextCheckAt, lastCheckedAt: partitions.lastCheckedAt,
        lastSuccessAt: partitions.lastSuccessAt, failures: partitions.failures, error: partitions.error, currentReleaseId: partitions.currentReleaseId,
      } }).from(partitions).innerJoin(datasets, eq(datasets.id, partitions.datasetId))
        .where(query.after ? gt(partitions.id, query.after) : undefined).orderBy(partitions.id).limit(query.limit + 1);
      const page = rows.slice(0, query.limit).map((row: any) => ({ ...row, stale: !row.partition.lastSuccessAt || Date.now() - row.partition.lastSuccessAt.getTime() > row.partition.intervalSeconds * 1000 }));
      res.json(ok({ items: page, nextCursor: rows.length > query.limit ? page.at(-1).partition.id : null }));
    } catch (error) { next(error); }
  });
  router.get("/traffic-counts", async (req, res, next) => {
    try { res.json(ok({ items: await trafficCountStatus(getDeps(req).db) })); } catch (error) { next(error); }
  });
  router.get("/partitions/:id/runs", async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const items = await getDeps(req).db.select().from(runs).where(eq(runs.partitionId, id)).orderBy(desc(runs.startedAt)).limit(50);
      res.json(ok({ items }));
    } catch (error) { next(error); }
  });
  router.get("/releases/:id", async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id), db = getDeps(req).db;
      const query = z.object({ after: z.string().min(1).max(500).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
      const [row] = await db.select({ release: releases, evidence: {
        id: assets.id, sourceUrl: assets.sourceUrl, checksum: assets.checksum, sizeBytes: assets.sizeBytes, mimeType: assets.mimeType, retrievedAt: assets.retrievedAt,
      } }).from(releases).innerJoin(assets, eq(assets.id, releases.assetId)).where(eq(releases.id, id));
      if (!row) throw Object.assign(new Error("Public release not found"), { status: 404, code: "not_found" });
      const items = await releaseFeatures(db, id, query.limit + 1, query.after);
      res.json(ok({ ...row, items: items.slice(0, query.limit), nextCursor: items.length > query.limit ? items[query.limit - 1].sourceId : null }));
    } catch (error) { next(error); }
  });
  return router;
}
