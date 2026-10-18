import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { WorkerDeps } from "./deps";
import { trafficCountRuns, trafficCounts, trafficCountSources } from "./schema";
import { countSource, countSources, IMPORTER_VERSION, type CountSource, type ParsedCount } from "./traffic-count-sources";

/**
 * Idempotent import of file-published traffic counts. Each source is claimed
 * under a lease, its files are downloaded and hashed, and an unchanged file set
 * (same checksums, same importer version) is skipped. Changed files are kept as
 * private evidence, parsed, and upserted by source + release + station; records
 * that disappeared from the source and superseded releases are removed. Every
 * attempt is written to public_data_traffic_count_runs.
 */
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Same private-bucket namespace as the other public-data evidence, never tenant uploads; keys are four hex/uuid segments.
const namespace = "7e8f0651-92f5-48d0-a66c-3c9c937c1000";
const evidenceKey = (sourceId: string, token: string, index: number, sha256: string) => `${namespace}/${hash(`traffic-counts:${sourceId}`).slice(0, 32)}/${token}/${index}-${sha256}`;
const MAX_FILE_BYTES = 200_000_000, LEASE_MINUTES = 20, BATCH = 500;
const tick = () => new Promise(resolve => setImmediate(resolve));

export type ImportResult = { sourceId: string; status: "imported" | "unchanged" | "failed" | "busy"; release?: string; records?: number; inserted?: number; updated?: number; removed?: number; skipped?: number; error?: string };

export async function seedCountSources(db: any) {
  await db.insert(trafficCountSources).values(countSources.map(source => ({ id: source.id }))).onConflictDoNothing();
}

async function download(d: WorkerDeps, url: string, signal: AbortSignal): Promise<Buffer> {
  // Fixed catalogue URLs only; no redirects to unreviewed hosts.
  const response = await d.fetch(url, { signal, redirect: "error" });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Source unavailable"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) throw new Error("Source file exceeds the import budget");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

const recordHash = (record: ParsedCount) => hash(JSON.stringify(record));
const bounds = (geometry: ParsedCount["geometry"]) => {
  const points = geometry.type === "Point" ? [geometry.coordinates] : geometry.coordinates.flat();
  const lons = points.map(p => p[0]), lats = points.map(p => p[1]);
  return { minLon: Math.min(...lons), minLat: Math.min(...lats), maxLon: Math.max(...lons), maxLat: Math.max(...lats) };
};
/** Queries search a bounded latitude/longitude band on the (min_lat, min_lon) index; larger records are rejected at import. */
export const MAX_EXTENT_DEG = 0.5;

/** Parses all files into records (yielding to the event loop between batches); throws on mixed releases or duplicate stations. */
export async function parseSource(source: CountSource, files: Array<{ url: string; bytes: Buffer }>) {
  const records: ParsedCount[] = [], ids = new Set<string>();
  let skipped = 0, n = 0;
  for await (const record of source.parse(files)) {
    if (++n % BATCH === 0) await tick();
    if (!record) { skipped++; continue; }
    const box = bounds(record.geometry);
    if (box.maxLon - box.minLon > MAX_EXTENT_DEG || box.maxLat - box.minLat > MAX_EXTENT_DEG) { skipped++; continue; }
    if (ids.has(record.stationId)) throw new Error("Duplicate station id in source");
    if (records.length && records[0]!.release !== record.release) throw new Error("Source mixes releases");
    ids.add(record.stationId); records.push(record);
  }
  if (!records.length) throw new Error("Source contains no usable counts");
  return { records, skipped, release: records[0]!.release };
}

/** Upserts one parsed release and removes stale rows; each row records the SHA-256 of the file it came from. Runs in the caller's transaction. */
export async function writeRelease(tx: any, source: CountSource, release: string, records: ParsedCount[], fileChecksums: Map<string, string>) {
  let inserted = 0, updated = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const values = records.slice(i, i + BATCH).map(record => ({
      id: crypto.randomUUID(), sourceId: source.id, release, stationId: record.stationId, sourceUrl: record.sourceUrl, year: record.year, kind: record.kind,
      road: record.road, roadClass: record.roadClass, name: record.name, geometry: record.geometry, ...bounds(record.geometry),
      dailyTraffic: record.dailyTraffic, heavyVehicles: record.heavyVehicles, hourlyDay: record.hourly.day, hourlyNight: record.hourly.night,
      heavyShareDay: record.hourly.heavyShareDay, heavyShareNight: record.hourly.heavyShareNight, p1Day: record.hourly.p1Day, p2Day: record.hourly.p2Day,
      p1Night: record.hourly.p1Night, p2Night: record.hourly.p2Night, recordHash: recordHash(record), checksum: fileChecksums.get(record.sourceUrl)!, importedAt: new Date(),
    }));
    const excluded = (column: string) => sql.raw(`excluded.${column}`);
    const rows: Array<{ inserted: boolean }> = await tx.insert(trafficCounts).values(values).onConflictDoUpdate({
      target: [trafficCounts.sourceId, trafficCounts.release, trafficCounts.stationId],
      set: Object.fromEntries(["source_url", "year", "kind", "road", "road_class", "name", "geometry", "min_lon", "min_lat", "max_lon", "max_lat", "daily_traffic", "heavy_vehicles", "hourly_day", "hourly_night",
        "heavy_share_day", "heavy_share_night", "p1_day", "p2_day", "p1_night", "p2_night", "record_hash", "checksum", "imported_at"].map(column => [column.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()), excluded(column)])),
      // Unchanged records keep the file checksum and import time they were first written with.
      setWhere: sql`${trafficCounts.recordHash} <> excluded.record_hash`,
    }).returning({ inserted: sql<boolean>`(xmax = 0)` });
    for (const row of rows) row.inserted ? inserted++ : updated++;
  }
  const current = new Set(records.map(record => record.stationId));
  const existing: Array<{ id: string; release: string; stationId: string }> = await tx.select({ id: trafficCounts.id, release: trafficCounts.release, stationId: trafficCounts.stationId }).from(trafficCounts).where(eq(trafficCounts.sourceId, source.id));
  const stale = existing.filter(row => row.release !== release || !current.has(row.stationId)).map(row => row.id);
  for (let i = 0; i < stale.length; i += 1000) await tx.delete(trafficCounts).where(inArray(trafficCounts.id, stale.slice(i, i + 1000)));
  return { inserted, updated, removed: stale.length };
}

type Claim = { row: typeof trafficCountSources.$inferSelect; token: string };
async function claim(db: any, sourceId: string | null, trigger: string): Promise<Claim | null> {
  const token = crypto.randomUUID();
  return db.transaction(async (tx: any) => {
    const [row]: (typeof trafficCountSources.$inferSelect)[] = await tx.select().from(trafficCountSources).where(and(
      sourceId ? eq(trafficCountSources.id, sourceId) : sql`${trafficCountSources.nextCheckAt} <= now()`,
      sourceId ? undefined : inArray(trafficCountSources.id, countSources.map(source => source.id)),
      sql`(${trafficCountSources.leaseUntil} is null or ${trafficCountSources.leaseUntil} < now())`,
    )).orderBy(trafficCountSources.nextCheckAt, trafficCountSources.id).limit(1).for("update", { skipLocked: true });
    if (!row) return null;
    await tx.update(trafficCountRuns).set({ status: "interrupted", finishedAt: new Date(), error: "Import lease expired; source restarted" }).where(and(eq(trafficCountRuns.sourceId, row.id), eq(trafficCountRuns.status, "running")));
    await tx.update(trafficCountSources).set({ leaseToken: token, leaseUntil: sql`now() + ${LEASE_MINUTES} * interval '1 minute'` }).where(eq(trafficCountSources.id, row.id));
    await tx.insert(trafficCountRuns).values({ id: token, sourceId: row.id, status: "running", trigger });
    return { row, token };
  });
}

async function run(d: WorkerDeps, { row, token }: Claim, signal: AbortSignal, force: boolean): Promise<ImportResult> {
  const source = countSource(row.id)!;
  const owned = and(eq(trafficCountSources.id, row.id), eq(trafficCountSources.leaseToken, token));
  const jobSignal = AbortSignal.any([signal, AbortSignal.timeout((LEASE_MINUTES - 1) * 60_000)]);
  const next = sql`now() + ${source.intervalDays} * interval '1 day'`;
  let stage = "retrieval";
  try {
    const files: Array<{ url: string; bytes: Buffer; sha256: string; retrievedAt: string }> = [];
    for (const url of source.files) {
      const bytes = await download(d, url, jobSignal);
      files.push({ url, bytes, sha256: hash(bytes), retrievedAt: new Date().toISOString() });
    }
    const checksum = hash([IMPORTER_VERSION, ...files.map(file => file.sha256)].join("\n"));
    const fileLog = (keys: Array<string | null>) => files.map((file, i) => ({ url: file.url, sha256: file.sha256, sizeBytes: file.bytes.byteLength, retrievedAt: file.retrievedAt, storageKey: keys[i] ?? null }));
    if (!force && row.checksum === checksum && row.importerVersion === IMPORTER_VERSION) {
      await d.db.transaction(async (tx: any) => {
        const updated = await tx.update(trafficCountSources).set({ lastCheckedAt: new Date(), lastSuccessAt: new Date(), failures: 0, error: null, leaseToken: null, leaseUntil: null, nextCheckAt: next }).where(owned).returning({ id: trafficCountSources.id });
        if (updated.length) await tx.update(trafficCountRuns).set({ status: "unchanged", finishedAt: new Date(), checksum, release: row.currentRelease, files: fileLog([]), records: row.recordCount }).where(eq(trafficCountRuns.id, token));
      });
      return { sourceId: row.id, status: "unchanged", release: row.currentRelease ?? undefined, records: row.recordCount };
    }
    stage = "storage";
    const keys: string[] = [];
    for (const [i, file] of files.entries()) {
      const key = evidenceKey(row.id, token, i, file.sha256);
      await d.saveRaw(key, file.bytes, "application/octet-stream", jobSignal);
      keys.push(key);
    }
    stage = "validation";
    const parsed = await parseSource(source, files);
    jobSignal.throwIfAborted();
    stage = "publication";
    const result = await d.db.transaction(async (tx: any) => {
      const [current] = await tx.select({ id: trafficCountSources.id }).from(trafficCountSources).where(and(owned, sql`${trafficCountSources.leaseUntil} > now()`)).for("update");
      if (!current) return null; // A recovered worker owns this source; stale results cannot publish.
      const changes = await writeRelease(tx, source, parsed.release, parsed.records, new Map(files.map(file => [file.url, file.sha256])));
      jobSignal.throwIfAborted();
      await tx.update(trafficCountSources).set({ currentRelease: parsed.release, checksum, importerVersion: IMPORTER_VERSION, recordCount: parsed.records.length, lastCheckedAt: new Date(), lastSuccessAt: new Date(), failures: 0, error: null, leaseToken: null, leaseUntil: null, nextCheckAt: next }).where(owned);
      await tx.update(trafficCountRuns).set({ status: "imported", finishedAt: new Date(), release: parsed.release, checksum, files: fileLog(keys), records: parsed.records.length, skipped: parsed.skipped, ...changes }).where(eq(trafficCountRuns.id, token));
      return changes;
    });
    if (!result) return { sourceId: row.id, status: "busy" };
    return { sourceId: row.id, status: "imported", release: parsed.release, records: parsed.records.length, skipped: parsed.skipped, ...result };
  } catch {
    // Stage-only diagnostics: no upstream bodies or arbitrary exception text in stored state.
    const error = signal.aborted ? "Import interrupted; retry scheduled" : `Traffic count ${stage} failed; previous records retained`;
    await d.db.transaction(async (tx: any) => {
      const retrySeconds = signal.aborted ? 0 : Math.min(86400, 300 * 2 ** Math.min(row.failures, 8));
      const updated = await tx.update(trafficCountSources).set({ leaseToken: null, leaseUntil: null, error, failures: sql`${trafficCountSources.failures} + 1`, lastCheckedAt: new Date(), nextCheckAt: sql`now() + ${retrySeconds} * interval '1 second'` }).where(owned).returning({ id: trafficCountSources.id });
      if (updated.length) await tx.update(trafficCountRuns).set({ status: signal.aborted ? "interrupted" : "failed", error, finishedAt: new Date() }).where(eq(trafficCountRuns.id, token));
    });
    return { sourceId: row.id, status: "failed", error };
  }
}

/** Imports one named source now (operator script or admin trigger); `force` re-parses unchanged files. */
export async function importCountSource(d: WorkerDeps, sourceId: string, options: { signal?: AbortSignal; force?: boolean; trigger?: string } = {}): Promise<ImportResult> {
  if (!countSource(sourceId)) throw new Error("Unknown traffic count source");
  await seedCountSources(d.db);
  const claimed = await claim(d.db, sourceId, options.trigger ?? "manual");
  if (!claimed) return { sourceId, status: "busy" };
  return run(d, claimed, options.signal ?? new AbortController().signal, options.force ?? false);
}

/** Imports the next due source, if any. */
export async function runDueCountImport(d: WorkerDeps, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const claimed = await claim(d.db, null, "schedule");
  if (!claimed) return false;
  await run(d, claimed, signal, false);
  return true;
}

export async function startTrafficCountWorker(d: WorkerDeps) {
  await seedCountSources(d.db);
  const controller = new AbortController();
  let active: Promise<unknown> | null = null;
  const poll = () => {
    if (active || controller.signal.aborted) return;
    active = runDueCountImport(d, controller.signal).catch(() => d.reportError()).finally(() => { active = null; });
  };
  const timer = setInterval(poll, 60_000);
  timer.unref(); poll();
  return { async stop() { clearInterval(timer); controller.abort(); await active; } };
}
