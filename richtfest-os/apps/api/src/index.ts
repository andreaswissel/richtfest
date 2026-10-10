import { createServer } from "./server";
import { env } from "./env";
import { startSupervisorWorker } from "./supervisor-worker";
import { startLocationWorker } from "@richtfest/projects/location-worker";
import { recordAudit } from "./audit";
const { app, db, pool } = createServer();
const server = app.listen(env.PORT, () => console.log(`Richtfest API listening on ${env.PORT}`));
const worker = await startSupervisorWorker(db, pool);
const locationWorker = startLocationWorker({
  db,
  audit: (tx, tenantId, action, projectId, metadata) => recordAudit(tx, null, tenantId, action, "project", projectId, metadata, { actorType: "system" }),
  reportError: () => console.error("Project location worker database operation failed; will retry"),
});
async function shutdown() {
  server.close();
  await locationWorker.stop();
  await worker.stop();
  await pool.end();
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
