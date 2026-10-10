CREATE TABLE "support_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "created_by" uuid NOT NULL,
  "title" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "support_conversations_owner" ON "support_conversations" ("tenant_id", "created_by", "created_at");
--> statement-breakpoint
CREATE TABLE "support_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "support_conversations"("id"),
  "request_id" uuid,
  "role" text NOT NULL CHECK ("role" IN ('user', 'assistant')),
  "body" text NOT NULL,
  "status" text DEFAULT 'completed' NOT NULL CHECK ("status" IN ('completed', 'pending', 'failed', 'unconfigured')),
  "openui" text,
  "proposal" jsonb,
  "sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "support_messages_conversation" ON "support_messages" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "support_messages_request" ON "support_messages" ("request_id");
--> statement-breakpoint
CREATE TABLE "support_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "created_by" uuid NOT NULL,
  "conversation_id" uuid REFERENCES "support_conversations"("id"),
  "message_id" uuid REFERENCES "support_messages"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('bug', 'feature')),
  "title" text NOT NULL,
  "description" text NOT NULL,
  "page_path" text,
  "status" text DEFAULT 'open' NOT NULL CHECK ("status" IN ('open', 'in_progress', 'resolved')),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "support_reports_tenant" ON "support_reports" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "support_reports_message" ON "support_reports" ("message_id");
