-- Additive queue/cache only. No report, revision, source or approval is rewritten.
CREATE TABLE "knowledge_artifact_pdf_exports" (
  "revision_id" uuid PRIMARY KEY REFERENCES "knowledge_artifact_revisions"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL,
  "requested_by" uuid NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "input_hash" text,
  "storage_key" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_token" uuid,
  "lease_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "knowledge_artifact_pdf_pending_idx" ON "knowledge_artifact_pdf_exports" ("status", "lease_until");
