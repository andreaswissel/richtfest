-- Additive explicit full-PDF export pairings. No backfill or original-version changes.
CREATE TABLE "projects_source_representations" (
  "original_version_id" uuid PRIMARY KEY REFERENCES "projects_file_versions"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL,
  "pdf_version_id" uuid NOT NULL REFERENCES "projects_file_versions"("id") ON DELETE CASCADE,
  "confirmed_by" uuid NOT NULL,
  "confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
