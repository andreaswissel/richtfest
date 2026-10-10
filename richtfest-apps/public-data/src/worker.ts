import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { WorkerDeps } from "./deps";
import { assets, datasets, partitions, releaseMembers, releases, revisions, runs } from "./schema";
import { IMPORTER_VERSION, normalize, readBody, sourceUrl } from "./berlin";
import { seedCatalogue } from "./catalogue";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Fixed private-bucket namespace distinct from tenant uploads; remaining segments identify evidence.
const namespace = "7e8f0651-92f5-48d0-a66c-3c9c937c1000";

export async function runImport(d: WorkerDeps, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const token = crypto.randomUUID();
  const claim = await d.db.transaction(async (tx: any) => {
    const [partition]: (typeof partitions.$inferSelect)[] = await tx.select().from(partitions).where(and(
      eq(partitions.enabled, true), sql`${partitions.nextCheckAt} <= now()`,
      sql`(${partitions.leaseUntil} is null or ${partitions.leaseUntil} < now())`,
    )).orderBy(partitions.nextCheckAt, partitions.id).limit(1).for("update", { skipLocked: true });
    if (!partition) return null;
    const [dataset]: (typeof datasets.$inferSelect)[] = await tx.select().from(datasets).where(eq(datasets.id, partition.datasetId));
    // An interrupted request restarts this small, single-response partition, never resumes unsafe WFS pages.
    await tx.update(runs).set({ status: "interrupted", finishedAt: new Date(), error: "Import lease expired; partition restarted" }).where(and(eq(runs.partitionId, partition.id), eq(runs.status, "running")));
    await tx.update(partitions).set({ leaseToken: token, leaseUntil: sql`now() + interval '3 minutes'` }).where(eq(partitions.id, partition.id));
    await tx.insert(runs).values({ id: token, partitionId: partition.id, status: "running" });
    return { partition, dataset };
  });
  if (!claim) return false;
  const { partition, dataset } = claim;
  const owned = and(eq(partitions.id, partition.id), eq(partitions.leaseToken, token));
  const jobSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  let stage = "retrieval";
  try {
    const url = sourceUrl(dataset.connector, partition.bbox, partition.crs);
    // No user-supplied URLs and no redirects to private or unreviewed hosts.
    const response = await d.fetch(url, { signal: jobSignal, redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Source unavailable");
    const bytes = await readBody(response), retrievedAt = new Date(), assetId = crypto.randomUUID();
    const storageKey = `${namespace}/${partition.id}/${token}/${assetId}`;
    stage = "storage";
    await d.saveRaw(storageKey, bytes, "application/json", jobSignal);
    await d.db.insert(assets).values({ id: assetId, runId: token, storageKey, sourceUrl: url, checksum: hash(bytes), sizeBytes: bytes.byteLength, mimeType: "application/json", retrievedAt });
    stage = "validation";
    const features = normalize(dataset.connector, bytes);
    const values = features.map(feature => ({ id: crypto.randomUUID(), partitionId: partition.id, sourceId: feature.sourceId, checksum: hash(JSON.stringify(feature)), feature, assetId }));
    const fingerprint = hash(JSON.stringify({ importer: IMPORTER_VERSION, metadata: dataset.metadata, bbox: partition.bbox, crs: partition.crs, records: values.map(v => [v.sourceId, v.checksum]) }));
    jobSignal.throwIfAborted();
    stage = "publication";
    await d.db.transaction(async (tx: any) => {
      const [current]: (typeof partitions.$inferSelect)[] = await tx.select().from(partitions).where(and(owned, sql`${partitions.leaseUntil} > now()`)).for("update");
      if (!current) return; // A recovered worker owns this partition; stale results cannot publish.
      const [previous]: (typeof releases.$inferSelect)[] = current.currentReleaseId ? await tx.select().from(releases).where(eq(releases.id, current.currentReleaseId)) : [];
      let releaseId = current.currentReleaseId;
      const changed = previous?.fingerprint !== fingerprint;
      if (changed) {
        releaseId = crypto.randomUUID();
        await tx.insert(releases).values({ id: releaseId, partitionId: partition.id, assetId, fingerprint, importerVersion: IMPORTER_VERSION, metadata: dataset.metadata, bbox: partition.bbox, crs: partition.crs, featureCount: features.length });
        for (let i = 0; i < values.length; i += 250) {
          const batch = values.slice(i, i + 250);
          await tx.insert(revisions).values(batch).onConflictDoNothing();
          const stored: (typeof revisions.$inferSelect)[] = await tx.select().from(revisions).where(and(eq(revisions.partitionId, partition.id), inArray(revisions.checksum, batch.map(v => v.checksum))));
          const byIdentity = new Map(stored.map(v => [`${v.sourceId}:${v.checksum}`, v.id]));
          await tx.insert(releaseMembers).values(batch.map(v => ({ releaseId, revisionId: byIdentity.get(`${v.sourceId}:${v.checksum}`)!, sourceId: v.sourceId })));
        }
      }
      jobSignal.throwIfAborted();
      // A complete replacement manifest expresses removals without deleting historical evidence.
      await tx.update(partitions).set({ currentReleaseId: releaseId, lastCheckedAt: retrievedAt, lastSuccessAt: retrievedAt, failures: 0, error: null, leaseToken: null, leaseUntil: null, nextCheckAt: sql`now() + ${partition.intervalSeconds} * interval '1 second'` }).where(owned);
      await tx.update(runs).set({ status: changed ? "published" : "unchanged", releaseId, finishedAt: new Date() }).where(eq(runs.id, token));
    });
  } catch {
    // Stage-only diagnostics: never retain upstream bodies, credentials or arbitrary exception text.
    const error = signal.aborted ? "Import interrupted; retry scheduled" : `Public data ${stage} failed; last published release retained`;
    await d.db.transaction(async (tx: any) => {
      const retrySeconds = signal.aborted ? 0 : Math.min(86400, 60 * 2 ** Math.min(partition.failures, 11));
      const updated = await tx.update(partitions).set({ leaseToken: null, leaseUntil: null, error, failures: sql`${partitions.failures} + 1`, lastCheckedAt: new Date(), nextCheckAt: sql`now() + ${retrySeconds} * interval '1 second'` }).where(owned).returning({ id: partitions.id });
      if (updated.length) await tx.update(runs).set({ status: signal.aborted ? "interrupted" : "failed", error, finishedAt: new Date() }).where(eq(runs.id, token));
    });
  }
  return true;
}

export async function startPublicDataWorker(d: WorkerDeps) {
  await seedCatalogue(d.db);
  const controller = new AbortController();
  let active: Promise<unknown> | null = null;
  const tick = () => {
    if (active || controller.signal.aborted) return;
    active = runImport(d, controller.signal).catch(() => d.reportError()).finally(() => { active = null; });
  };
  const timer = setInterval(tick, 5000);
  timer.unref(); tick();
  return { async stop() { clearInterval(timer); controller.abort(); await active; } };
}
