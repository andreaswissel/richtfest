import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, boolean, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";
import type { PublicDatasetMetadata, PublicFeature } from "@richtfest/shared";

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
