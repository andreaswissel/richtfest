import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, boolean, index, uniqueIndex, primaryKey, doublePrecision, real } from "drizzle-orm/pg-core";
import type { PublicDatasetMetadata, PublicFeature, TrafficCountRecord } from "@richtfest/shared";

// Only curated public data belongs here. No tenant IDs, project selections or private uploads.
export const datasets = pgTable("public_data_datasets", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
  connector: text("connector").notNull(),
  metadata: jsonb("metadata").$type<PublicDatasetMetadata>().notNull(),
});
export const partitions = pgTable("public_data_partitions", {
  id: uuid("id").primaryKey(),
  datasetId: uuid("dataset_id").notNull().references(() => datasets.id),
  scope: text("scope").notNull(),
  // Explicit projected bounding box, not a claim of complete city/radius coverage.
  bbox: jsonb("bbox").$type<[number, number, number, number]>().notNull(),
  crs: text("crs").notNull().default("EPSG:25833"),
  enabled: boolean("enabled").notNull().default(true),
  intervalSeconds: integer("interval_seconds").notNull(),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  failures: integer("failures").notNull().default(0),
  error: text("error"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  currentReleaseId: uuid("current_release_id"),
}, t => ({ due: index("public_data_partitions_due").on(t.nextCheckAt), scope: uniqueIndex("public_data_partition_scope").on(t.datasetId, t.scope) }));
export const runs = pgTable("public_data_runs", {
  id: uuid("id").primaryKey(),
  partitionId: uuid("partition_id").notNull().references(() => partitions.id),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
  releaseId: uuid("release_id"),
}, t => ({ history: index("public_data_runs_history").on(t.partitionId, t.startedAt) }));
export const assets = pgTable("public_data_assets", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  storageKey: text("storage_key").notNull(),
  sourceUrl: text("source_url").notNull(),
  checksum: text("checksum").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  mimeType: text("mime_type").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
});
export const releases = pgTable("public_data_releases", {
  id: uuid("id").primaryKey(),
  partitionId: uuid("partition_id").notNull().references(() => partitions.id),
  assetId: uuid("asset_id").notNull().references(() => assets.id),
  fingerprint: text("fingerprint").notNull(),
  importerVersion: text("importer_version").notNull(),
  metadata: jsonb("metadata").$type<PublicDatasetMetadata>().notNull(),
  bbox: jsonb("bbox").$type<[number, number, number, number]>().notNull(),
  crs: text("crs").notNull(),
  featureCount: integer("feature_count").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
});
export const revisions = pgTable("public_data_revisions", {
  id: uuid("id").primaryKey(),
  partitionId: uuid("partition_id").notNull().references(() => partitions.id),
  sourceId: text("source_id").notNull(),
  checksum: text("checksum").notNull(),
  feature: jsonb("feature").$type<PublicFeature>().notNull(),
  assetId: uuid("asset_id").notNull().references(() => assets.id),
}, t => ({ identity: uniqueIndex("public_data_revision_identity").on(t.partitionId, t.sourceId, t.checksum) }));
export const releaseMembers = pgTable("public_data_release_members", {
  releaseId: uuid("release_id").notNull().references(() => releases.id),
  revisionId: uuid("revision_id").notNull().references(() => revisions.id),
  sourceId: text("source_id").notNull(),
}, t => ({ pk: primaryKey({ columns: [t.releaseId, t.sourceId] }) }));

// --- Traffic counts published only as files (BASt, state road authorities) ---

/** Sync checkpoint per count source; the source definitions themselves live in code (traffic-count-sources.ts). */
export const trafficCountSources = pgTable("public_data_traffic_count_sources", {
  id: text("id").primaryKey(),
  currentRelease: text("current_release"),
  /** SHA-256 over the source file checksums of the last successful import; unchanged files are skipped. */
  checksum: text("checksum"),
  importerVersion: text("importer_version"),
  recordCount: integer("record_count").notNull().default(0),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  failures: integer("failures").notNull().default(0),
  error: text("error"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
}, t => ({ due: index("public_data_traffic_count_sources_due").on(t.nextCheckAt) }));

/** One row per import attempt: the audit trail of this tenant-independent job. */
export const trafficCountRuns = pgTable("public_data_traffic_count_runs", {
  id: uuid("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => trafficCountSources.id),
  status: text("status").notNull(),
  trigger: text("trigger").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  release: text("release"),
  checksum: text("checksum"),
  /** Retrieved files: url, sha256, size, retrieval time and private-bucket evidence key. */
  files: jsonb("files").$type<Array<{ url: string; sha256: string; sizeBytes: number; retrievedAt: string; storageKey: string | null }>>(),
  records: integer("records"),
  inserted: integer("inserted"),
  updated: integer("updated"),
  removed: integer("removed"),
  skipped: integer("skipped"),
  error: text("error"),
}, t => ({ history: index("public_data_traffic_count_runs_history").on(t.sourceId, t.startedAt) }));

/** Imported count records; global reference data, no tenant. Bounding box columns serve bbox queries without PostGIS. */
export const trafficCounts = pgTable("public_data_traffic_counts", {
  id: uuid("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => trafficCountSources.id),
  release: text("release").notNull(),
  stationId: text("station_id").notNull(),
  sourceUrl: text("source_url").notNull(),
  year: integer("year").notNull(),
  kind: text("kind").$type<TrafficCountRecord["kind"]>().notNull(),
  road: text("road"),
  roadClass: text("road_class"),
  name: text("name"),
  geometry: jsonb("geometry").$type<TrafficCountRecord["geometry"]>().notNull(),
  minLon: doublePrecision("min_lon").notNull(),
  minLat: doublePrecision("min_lat").notNull(),
  maxLon: doublePrecision("max_lon").notNull(),
  maxLat: doublePrecision("max_lat").notNull(),
  dailyTraffic: integer("daily_traffic").notNull(),
  heavyVehicles: integer("heavy_vehicles"),
  hourlyDay: real("hourly_day"),
  hourlyNight: real("hourly_night"),
  heavyShareDay: real("heavy_share_day"),
  heavyShareNight: real("heavy_share_night"),
  p1Day: real("p1_day"),
  p2Day: real("p2_day"),
  p1Night: real("p1_night"),
  p2Night: real("p2_night"),
  /** Hash of the normalised record; unchanged records are not rewritten on re-import. */
  recordHash: text("record_hash").notNull(),
  /** SHA-256 of the source file(s) this record was last written from. */
  checksum: text("checksum").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  identity: uniqueIndex("public_data_traffic_count_identity").on(t.sourceId, t.release, t.stationId),
  box: index("public_data_traffic_counts_box").on(t.minLat, t.minLon),
}));
