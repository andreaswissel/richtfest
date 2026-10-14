import { createServer } from "./server";
import { env } from "./env";
import { backgroundKnowledgeDeps, startSupervisorWorker } from "./supervisor-worker";
import { startArtifactPdfWorker } from "@richtfest/knowledge";
import { startLocationWorker } from "@richtfest/projects/location-worker";
import { startSourceExtractionWorker } from "@richtfest/projects/source-extraction";
import { startSourceModelWorker } from "@richtfest/projects/source-model";
import { structureSourceDocument } from "./source-model-host";
import { fileStorage } from "./app-hosts";
import { recordAudit } from "./audit";
import { startPublicDataWorker } from "@richtfest/public-data/worker";
import { readBerlinSnapshot } from "@richtfest/public-data/queries";
import { publicDataWorkerDeps } from "./public-data-host";
const { app, db, pool } = await createServer();
const server = app.listen(env.PORT, () => console.log(`Richtfest API listening on ${env.PORT}`));
const worker = await startSupervisorWorker(db, pool);
const pdfWorker = startArtifactPdfWorker({
  db, resolveDeps: (tenantId, actorId) => backgroundKnowledgeDeps(db, tenantId, actorId),
  reportError: () => console.error("Artifact PDF preparation failed; automatic recovery is bounded"),
});
const publicDataWorker = env.PUBLIC_DATA_ENABLED ? await startPublicDataWorker(publicDataWorkerDeps(db)) : null;
const locationWorker = startLocationWorker({
  db,
  ...(env.PUBLIC_DATA_ENABLED ? { publicDataSnapshot: (origin: [number, number], radius: number) => readBerlinSnapshot(db, origin, radius) } : {}),
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
  await pdfWorker.stop();
  await modelWorker.stop();
  await extractionWorker.stop();
  await publicDataWorker?.stop();
  await locationWorker.stop();
  await worker.stop();
  await pool.end();
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
