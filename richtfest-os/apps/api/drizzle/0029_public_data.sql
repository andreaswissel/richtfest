CREATE TABLE "public_data_datasets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "label" text NOT NULL,
  "connector" text NOT NULL,
  "metadata" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_data_partitions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "dataset_id" uuid NOT NULL REFERENCES "public_data_datasets"("id"),
  "scope" text NOT NULL,
  "bbox" jsonb NOT NULL,
  "crs" text NOT NULL DEFAULT 'EPSG:25833',
  "enabled" boolean NOT NULL DEFAULT true,
  "interval_seconds" integer NOT NULL CHECK (interval_seconds > 0),
  "next_check_at" timestamptz NOT NULL DEFAULT now(),
  "last_checked_at" timestamptz,
  "last_success_at" timestamptz,
  "failures" integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  "error" text,
  "lease_token" uuid,
  "lease_until" timestamptz,
  "current_release_id" uuid
);
CREATE INDEX "public_data_partitions_due" ON "public_data_partitions" ("next_check_at");
CREATE UNIQUE INDEX "public_data_partition_scope" ON "public_data_partitions" ("dataset_id", "scope");
--> statement-breakpoint
CREATE TABLE "public_data_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "partition_id" uuid NOT NULL REFERENCES "public_data_partitions"("id"),
  "status" text NOT NULL CHECK (status IN ('running', 'published', 'unchanged', 'failed', 'interrupted')),
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "error" text,
  "release_id" uuid
);
CREATE INDEX "public_data_runs_history" ON "public_data_runs" ("partition_id", "started_at");
--> statement-breakpoint
CREATE TABLE "public_data_assets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "public_data_runs"("id"),
  "storage_key" text NOT NULL,
  "source_url" text NOT NULL,
  "checksum" text NOT NULL,
  "size_bytes" bigint NOT NULL CHECK (size_bytes >= 0),
  "mime_type" text NOT NULL,
  "retrieved_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_data_releases" (
  "id" uuid PRIMARY KEY NOT NULL,
  "partition_id" uuid NOT NULL REFERENCES "public_data_partitions"("id"),
  "asset_id" uuid NOT NULL REFERENCES "public_data_assets"("id"),
  "fingerprint" text NOT NULL,
  "importer_version" text NOT NULL,
  "metadata" jsonb NOT NULL,
  "bbox" jsonb NOT NULL,
  "crs" text NOT NULL,
  "feature_count" integer NOT NULL CHECK (feature_count >= 0),
  "published_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "public_data_revisions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "partition_id" uuid NOT NULL REFERENCES "public_data_partitions"("id"),
  "source_id" text NOT NULL,
  "checksum" text NOT NULL,
  "feature" jsonb NOT NULL,
  "asset_id" uuid NOT NULL REFERENCES "public_data_assets"("id")
);
CREATE UNIQUE INDEX "public_data_revision_identity" ON "public_data_revisions" ("partition_id", "source_id", "checksum");
--> statement-breakpoint
CREATE TABLE "public_data_release_members" (
  "release_id" uuid NOT NULL REFERENCES "public_data_releases"("id"),
  "revision_id" uuid NOT NULL REFERENCES "public_data_revisions"("id"),
  "source_id" text NOT NULL,
  PRIMARY KEY ("release_id", "source_id")
);
