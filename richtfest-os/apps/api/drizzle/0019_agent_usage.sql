ALTER TABLE "knowledge_agent_runs"
  ADD COLUMN IF NOT EXISTS "started_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "finished_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "duration_ms" integer;

UPDATE "knowledge_agent_runs"
SET "started_at" = CASE WHEN "status" <> 'queued' THEN "created_at" ELSE NULL END,
    "finished_at" = CASE WHEN "status" IN ('needs_review', 'approved', 'cancelled', 'failed', 'unconfigured', 'validated_tool_unavailable') THEN "updated_at" ELSE NULL END,
    "duration_ms" = CASE WHEN "status" IN ('needs_review', 'approved', 'cancelled', 'failed', 'unconfigured', 'validated_tool_unavailable') THEN GREATEST(0, floor(extract(epoch FROM ("updated_at" - "created_at")) * 1000))::integer ELSE NULL END
WHERE "started_at" IS NULL;

CREATE OR REPLACE FUNCTION knowledge_agent_run_timing() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'running' AND NEW.started_at IS NULL THEN
    NEW.started_at := now();
  END IF;
  IF NEW.status IN ('needs_review', 'approved', 'cancelled', 'failed', 'unconfigured', 'validated_tool_unavailable') THEN
    IF NEW.finished_at IS NULL THEN NEW.finished_at := now(); END IF;
    IF NEW.started_at IS NOT NULL THEN
      NEW.duration_ms := GREATEST(0, floor(extract(epoch FROM (NEW.finished_at - NEW.started_at)) * 1000))::integer;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS knowledge_agent_run_timing_trigger ON "knowledge_agent_runs";
CREATE TRIGGER knowledge_agent_run_timing_trigger
  BEFORE INSERT OR UPDATE OF status, started_at, finished_at ON "knowledge_agent_runs"
  FOR EACH ROW EXECUTE FUNCTION knowledge_agent_run_timing();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_agent_run_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "call_index" integer NOT NULL,
  "provider" text NOT NULL,
  "model_id" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "reasoning_tokens" integer,
  "cached_input_tokens" integer,
  "total_tokens" integer,
  "estimated_cost_usd_micros" integer,
  "pricing_version" text,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_agent_run_usage_run_call" ON "knowledge_agent_run_usage" ("run_id", "call_index");
CREATE INDEX IF NOT EXISTS "knowledge_agent_run_usage_tenant_run" ON "knowledge_agent_run_usage" ("tenant_id", "run_id");
