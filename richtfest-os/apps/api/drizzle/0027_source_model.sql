CREATE TABLE "projects_source_models" (
  "version_id" uuid PRIMARY KEY REFERENCES "projects_file_versions"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "method" text,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "lease_token" uuid,
  "lease_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "projects_source_models_jobs" ON "projects_source_models" ("status", "lease_until");
--> statement-breakpoint
CREATE TABLE "projects_source_entities" (
  "version_id" uuid NOT NULL REFERENCES "projects_source_models"("version_id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL,
  "key" text NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "global_id" text,
  PRIMARY KEY ("version_id", "key")
);
--> statement-breakpoint
CREATE TABLE "projects_source_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "version_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "entity_key" text NOT NULL,
  "predicate" text NOT NULL,
  "kind" text NOT NULL,
  "value" jsonb NOT NULL,
  "unit" jsonb,
  "provenance" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "review_status" text NOT NULL DEFAULT 'unreviewed',
  "review_revision" integer NOT NULL DEFAULT 0,
  "reviewed_by" uuid,
  "reviewed_at" timestamptz,
  "review_note" text,
  FOREIGN KEY ("version_id", "entity_key") REFERENCES "projects_source_entities" ("version_id", "key") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "projects_source_facts_lookup" ON "projects_source_facts" ("tenant_id", "version_id", "entity_key");
--> statement-breakpoint
CREATE INDEX "projects_source_facts_search" ON "projects_source_facts" USING gin
  (to_tsvector('simple', regexp_replace("predicate" || ' ' || "value"::text, '[[:punct:]]', ' ', 'g')));
--> statement-breakpoint
INSERT INTO "projects_source_models" ("version_id", "tenant_id")
SELECT id, tenant_id FROM "projects_file_versions" WHERE status = 'ready' AND storage_key IS NOT NULL
ON CONFLICT DO NOTHING;
