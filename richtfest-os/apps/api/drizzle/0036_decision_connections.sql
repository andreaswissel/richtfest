-- Decision credentials are separate from the generative provider selection.
-- Existing rows remain valid; no records or generative-provider checks change.
ALTER TABLE "os_ai_connections" DROP CONSTRAINT "os_ai_connections_provider_check";
ALTER TABLE "os_ai_connections" ADD CONSTRAINT "os_ai_connections_provider_check"
  CHECK (provider IN ('openai', 'anthropic', 'vercel', 'typesafe'));
