CREATE TABLE "knowledge_agent_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "key" text NOT NULL CHECK ("key" IN ('supervisor', 'source_reviewer', 'requirements_reviewer')),
  "instructions" text DEFAULT '' NOT NULL,
  "trigger_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_agent_profiles_tenant_role" ON "knowledge_agent_profiles" ("tenant_id", "key");
--> statement-breakpoint
ALTER TABLE "knowledge_supervisor_runs" ADD COLUMN "profile_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;
