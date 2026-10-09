ALTER TABLE "os_ai_connections" DROP CONSTRAINT IF EXISTS "os_ai_connections_provider_check";
ALTER TABLE "os_ai_connections" ADD CONSTRAINT "os_ai_connections_provider_check" CHECK (provider IN ('openai', 'anthropic', 'vercel'));
ALTER TABLE "os_agent_presets" DROP CONSTRAINT IF EXISTS "os_agent_presets_provider_check";
ALTER TABLE "os_agent_presets" ADD CONSTRAINT "os_agent_presets_provider_check" CHECK (provider IN ('openai', 'anthropic', 'vercel'));
ALTER TABLE "knowledge_agent_runs" ADD COLUMN IF NOT EXISTS "model_policy" jsonb;

CREATE TABLE IF NOT EXISTS "os_agent_settings" (
  "tenant_id" uuid PRIMARY KEY NOT NULL,
  "provider" text DEFAULT 'openai' NOT NULL,
  "updated_by" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "os_agent_settings_provider_check" CHECK (provider IN ('openai', 'anthropic', 'vercel'))
);
