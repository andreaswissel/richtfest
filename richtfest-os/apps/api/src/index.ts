import { createServer } from "./server";
import { env } from "./env";
import { startSupervisorWorker } from "./supervisor-worker";
import { startLocationWorker } from "@richtfest/projects/location-worker";
import { startSourceExtractionWorker } from "@richtfest/projects/source-extraction";
import { startSourceModelWorker } from "@richtfest/projects/source-model";
import { structureSourceDocument } from "./source-model-host";
import { fileStorage } from "./app-hosts";
import { recordAudit } from "./audit";
const { app, db, pool } = await createServer();
const server = app.listen(env.PORT, () => console.log(`Richtfest API listening on ${env.PORT}`));
const worker = await startSupervisorWorker(db, pool);
const locationWorker = startLocationWorker({
  db,
  audit: (tx, tenantId, action, projectId, metadata) => recordAudit(tx, null, tenantId, action, "project", projectId, metadata, { actorType: "system" }),
  reportError: () => console.error("Project location worker database operation failed; will retry"),
});
const extractionWorker = startSourceExtractionWorker({
  db, fileStorage,
  audit: (tx, tenantId, action, versionId, metadata) => recordAudit(tx, null, tenantId, action, "file_version", versionId, metadata, { actorType: "system" }),
  reportError: () => console.error("Project source extraction worker database operation failed; will retry"),
});
const modelWorker = startSourceModelWorker({
  db, fileStorage, structureDocument: input => structureSourceDocument(db, input),
  audit: (tx, tenantId, action, versionId, metadata) => recordAudit(tx, null, tenantId, action, "file_version", versionId, metadata, { actorType: "system" }),
  reportError: () => console.error("Project source model worker database operation failed"),
});
async function shutdown() {
  server.close();
  await modelWorker.stop();
  await extractionWorker.stop();
  await locationWorker.stop();
  await worker.stop();
  await pool.end();
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
