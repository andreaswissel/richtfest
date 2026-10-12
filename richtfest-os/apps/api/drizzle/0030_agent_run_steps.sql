ALTER TABLE "knowledge_agent_runs" ADD COLUMN "checkpoint_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_agent_runs" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "knowledge_agent_run_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "attempt_id" uuid,
  "generation" integer NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "kind" text NOT NULL,
  "step_key" text NOT NULL,
  "input_hash" text NOT NULL,
  "input" jsonb NOT NULL,
  "output" jsonb,
  "status" text NOT NULL,
  "reused_from_step_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "knowledge_agent_run_steps_lookup" ON "knowledge_agent_run_steps" USING btree ("tenant_id", "run_id", "kind", "step_key", "input_hash");
