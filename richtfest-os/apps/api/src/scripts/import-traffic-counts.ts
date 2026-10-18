import { countSources } from "@richtfest/public-data/traffic-count-sources";
import { importCountSource } from "@richtfest/public-data/traffic-count-worker";
import { createDatabase } from "../db/client";
import { publicDataWorkerDeps } from "../public-data-host";

// Operator import of file-published traffic counts, outside request paths:
//   bun src/scripts/import-traffic-counts.ts [source-id ...] [--force]
// Without ids it imports every catalogued source. Unchanged files are skipped unless --force.
const args = process.argv.slice(2), force = args.includes("--force");
const ids = args.filter(arg => !arg.startsWith("--"));
const unknown = ids.filter(id => !countSources.some(source => source.id === id));
if (unknown.length) throw new Error(`Unknown traffic count source: ${unknown.join(", ")}; known: ${countSources.map(source => source.id).join(", ")}`);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const { db, pool } = createDatabase(process.env.DATABASE_URL);
try {
  for (const id of ids.length ? ids : countSources.map(source => source.id)) {
    const started = Date.now();
    const result = await importCountSource(publicDataWorkerDeps(db), id, { force, trigger: "operator" });
    console.log(JSON.stringify({ ...result, seconds: Math.round((Date.now() - started) / 100) / 10 }));
  }
} finally { await pool.end(); }
