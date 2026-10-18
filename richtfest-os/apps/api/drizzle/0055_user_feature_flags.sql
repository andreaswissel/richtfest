CREATE TABLE IF NOT EXISTS "os_user_feature_flags" (
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "flag" text NOT NULL,
  "enabled_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "os_user_feature_flags_pk" PRIMARY KEY ("tenant_id", "user_id", "flag")
);
