CREATE TABLE "public_data_traffic_count_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "current_release" text,
  "checksum" text,
  "importer_version" text,
  "record_count" integer DEFAULT 0 NOT NULL,
  "next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_checked_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "failures" integer DEFAULT 0 NOT NULL,
  "error" text,
  "lease_token" uuid,
  "lease_until" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "public_data_traffic_count_sources_due" ON "public_data_traffic_count_sources" ("next_check_at");
--> statement-breakpoint
CREATE TABLE "public_data_traffic_count_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL REFERENCES "public_data_traffic_count_sources"("id"),
  "status" text NOT NULL,
  "trigger" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "release" text,
  "checksum" text,
  "files" jsonb,
  "records" integer,
  "inserted" integer,
  "updated" integer,
  "removed" integer,
  "skipped" integer,
  "error" text
);
--> statement-breakpoint
CREATE INDEX "public_data_traffic_count_runs_history" ON "public_data_traffic_count_runs" ("source_id", "started_at");
--> statement-breakpoint
CREATE TABLE "public_data_traffic_counts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL REFERENCES "public_data_traffic_count_sources"("id"),
  "release" text NOT NULL,
  "station_id" text NOT NULL,
  "source_url" text NOT NULL,
  "year" integer NOT NULL,
  "kind" text NOT NULL,
  "road" text,
  "road_class" text,
  "name" text,
  "geometry" jsonb NOT NULL,
  "min_lon" double precision NOT NULL,
  "min_lat" double precision NOT NULL,
  "max_lon" double precision NOT NULL,
  "max_lat" double precision NOT NULL,
  "daily_traffic" integer NOT NULL,
  "heavy_vehicles" integer,
  "hourly_day" real,
  "hourly_night" real,
  "heavy_share_day" real,
  "heavy_share_night" real,
  "p1_day" real,
  "p2_day" real,
  "p1_night" real,
  "p2_night" real,
  "record_hash" text NOT NULL,
  "checksum" text NOT NULL,
  "imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "public_data_traffic_count_identity" ON "public_data_traffic_counts" ("source_id", "release", "station_id");
--> statement-breakpoint
CREATE INDEX "public_data_traffic_counts_box" ON "public_data_traffic_counts" ("min_lat", "min_lon");
