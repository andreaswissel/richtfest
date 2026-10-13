CREATE TABLE "knowledge_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_categories_tenant_name" ON "knowledge_categories" ("tenant_id", lower("name"));
--> statement-breakpoint
ALTER TABLE "knowledge_drafts" ADD COLUMN "category_id" uuid REFERENCES "knowledge_categories" ("id");
--> statement-breakpoint
CREATE INDEX "knowledge_drafts_company_search" ON "knowledge_drafts" USING gin (to_tsvector('german'::regconfig, "title" || ' ' || "body")) WHERE "project_id" IS NULL;
--> statement-breakpoint
CREATE TABLE "knowledge_searches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "created_by" uuid NOT NULL,
  "question" text NOT NULL,
  "filters" jsonb NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "provider" text NOT NULL,
  "answer" text,
  "citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "usage" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "knowledge_searches_actor_history" ON "knowledge_searches" ("tenant_id", "created_by", "created_at");
