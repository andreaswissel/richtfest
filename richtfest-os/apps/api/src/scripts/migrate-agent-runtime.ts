import { PostgresStore } from "@mastra/pg";
import { noopLogger } from "@mastra/core/logger";
import { MASTRA_SCHEMA } from "../agent-runtime/mastra-workflow";

/** Explicit operator action; this is never invoked by application startup. */
export async function migrateAgentRuntime(connectionString: string) {
  const storage = new PostgresStore({
    id: "richtfest-agent-runtime-migration",
    connectionString,
    schemaName: MASTRA_SCHEMA,
    disableInit: false,
  });
  storage.__setLogger(noopLogger);
  try { await storage.init(); } finally { await storage.close(); }
}
if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  try {
    await migrateAgentRuntime(connectionString);
    console.log(`Agent runtime schema ${MASTRA_SCHEMA} migrated.`);
  } catch {
    console.error("Agent runtime migration failed. Verify database access and schema permissions.");
    process.exitCode = 1;
  }
}
