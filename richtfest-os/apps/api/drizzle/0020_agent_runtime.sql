CREATE SCHEMA IF NOT EXISTS "rf_agent_runtime";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rf_agent_runtime"."mastra_workflow_snapshot" (
  "workflow_name" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "resourceId" TEXT,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL,
  "createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rf_agent_runtime_mastra_workflow_snapshot_workflow_name_run_id_'
      AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'rf_agent_runtime')
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'rf_agent_runtime_mastra_workflow_snapshot_workflow_name_run_id_'
      AND schemaname = 'rf_agent_runtime'
  ) THEN
    ALTER TABLE "rf_agent_runtime"."mastra_workflow_snapshot"
      ADD CONSTRAINT rf_agent_runtime_mastra_workflow_snapshot_workflow_name_run_id_
      UNIQUE (workflow_name, run_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON i.indexrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE c.relname = 'rf_agent_runtime_mastra_workflow_snapshot_workflow_name_run_id_'
      AND n.nspname = 'rf_agent_runtime'
      AND i.indisreplident = false
  ) THEN
    ALTER TABLE "rf_agent_runtime"."mastra_workflow_snapshot"
      REPLICA IDENTITY USING INDEX rf_agent_runtime_mastra_workflow_snapshot_workflow_name_run_id_;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rf_agent_runtime_mastra_workflow_snapshot_name_createdat_idx"
  ON "rf_agent_runtime"."mastra_workflow_snapshot" ("workflow_name", "createdAt" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rf_agent_runtime_mastra_workflow_snapshot_name_status_createdat"
  ON "rf_agent_runtime"."mastra_workflow_snapshot" (workflow_name, (snapshot ->> 'status'), "createdAt" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rf_agent_runtime_mastra_workflow_snapshot_threadid_idx"
  ON "rf_agent_runtime"."mastra_workflow_snapshot" ((COALESCE(jsonb_path_query_first(snapshot, '$.context.* ? (@.status == "suspended").suspendPayload.__streamState.messageList.memoryInfo.threadId') #>> '{}', snapshot #>> '{context,input,messageListState,memoryInfo,threadId}')));
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass($q$"richtfest_agent_runtime"."mastra_workflow_snapshot"$q$) IS NOT NULL THEN
    INSERT INTO "rf_agent_runtime"."mastra_workflow_snapshot"
      ("workflow_name", "run_id", "resourceId", "snapshot", "createdAt", "updatedAt", "createdAtZ", "updatedAtZ")
    SELECT "workflow_name", "run_id", "resourceId", "snapshot", "createdAt", "updatedAt", "createdAtZ", "updatedAtZ"
    FROM "richtfest_agent_runtime"."mastra_workflow_snapshot"
    ON CONFLICT ("workflow_name", "run_id") DO NOTHING;
  END IF;
END $$;
