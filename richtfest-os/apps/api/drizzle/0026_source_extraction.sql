CREATE TABLE "projects_source_extractions" (
  "version_id" uuid PRIMARY KEY REFERENCES "projects_file_versions"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "next_page" integer NOT NULL DEFAULT 1,
  "attempts" integer NOT NULL DEFAULT 0,
  "result" jsonb,
  "lease_token" uuid,
  "lease_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "projects_source_extractions_jobs" ON "projects_source_extractions" ("status", "lease_until");
--> statement-breakpoint
CREATE TABLE "projects_source_pages" (
  "version_id" uuid NOT NULL REFERENCES "projects_source_extractions"("version_id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL,
  "page" integer NOT NULL,
  "content" jsonb NOT NULL,
  PRIMARY KEY ("version_id", "page")
);
--> statement-breakpoint
INSERT INTO "projects_source_extractions" ("version_id", "tenant_id")
SELECT id, tenant_id FROM "projects_file_versions" WHERE status = 'ready' AND storage_key IS NOT NULL
ON CONFLICT DO NOTHING;
