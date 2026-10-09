CREATE TABLE IF NOT EXISTS "os_agent_presets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "effort" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "config" jsonb,
  "updated_by" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "os_agent_presets_provider_check" CHECK (provider IN ('openai', 'anthropic')),
  CONSTRAINT "os_agent_presets_effort_check" CHECK (effort IN ('low', 'medium', 'high', 'ultra'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "os_agent_presets_scope" ON "os_agent_presets" ("tenant_id", "provider", "effort");
