import { z } from "zod";
import { createDatabase } from "../db/client";
import { env } from "../env";
import { backgroundKnowledgeDeps } from "../supervisor-worker";
import { organizeCompanyImports } from "../../../../../richtfest-apps/knowledge/src/company-imports";

// Explicit workspace and member; no global/default tenant or automatic write mode.
const [tenant, actor, mode] = process.argv.slice(2);
if (mode !== undefined && mode !== "--apply")
  throw new Error("Expected: <tenant UUID> <actor UUID> [--apply]");
const tenantId = z.string().uuid().parse(tenant);
const actorId = z.string().uuid().parse(actor);
const { db, pool } = createDatabase(env.DATABASE_URL);
try {
  const deps = await backgroundKnowledgeDeps(db, tenantId, actorId);
  console.log(
    JSON.stringify(
      await organizeCompanyImports(deps, mode === "--apply"),
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
