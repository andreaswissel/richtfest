CREATE TABLE "projects_locations" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "revision" integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  "scene" jsonb NOT NULL DEFAULT '{"objects":[],"planningNotes":""}'::jsonb,
  "context" jsonb,
  "cloud" jsonb,
  "context_status" text NOT NULL DEFAULT 'idle' CHECK (context_status IN ('idle','queued','running','ready','failed')),
  "context_error" text,
  "lidar_status" text NOT NULL DEFAULT 'idle' CHECK (lidar_status IN ('idle','queued','running','ready','failed')),
  "lidar_error" text,
  "lease_token" uuid,
  "lease_until" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "projects_locations_jobs" ON "projects_locations" ("context_status", "lidar_status", "lease_until");
