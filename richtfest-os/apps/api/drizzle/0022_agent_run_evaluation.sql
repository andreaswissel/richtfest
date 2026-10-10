CREATE TABLE "knowledge_agent_run_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "phase" text NOT NULL,
  "generation" integer,
  "attempt_number" integer NOT NULL,
  "provider" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "settings" jsonb,
  "response" jsonb,
  "usage_status" text DEFAULT 'pending' NOT NULL,
  "failure_category" text,
  "provider_status" integer,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "knowledge_agent_run_attempts_tenant_run" ON "knowledge_agent_run_attempts" ("tenant_id", "run_id");
ALTER TABLE "knowledge_agent_run_usage" ADD COLUMN "attempt_id" uuid;
ALTER TABLE "knowledge_agent_run_approvals" ADD COLUMN "evaluation" jsonb, ADD COLUMN "evaluated_output" jsonb;
