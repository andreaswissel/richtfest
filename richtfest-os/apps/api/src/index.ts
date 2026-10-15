import { createServer } from "./server";
import { env } from "./env";
import { backgroundKnowledgeDeps, startSupervisorWorker } from "./supervisor-worker";
import { startArtifactPdfWorker } from "@richtfest/knowledge";
import { startLocationWorker } from "@richtfest/projects/location-worker";
import { startSourceExtractionWorker } from "@richtfest/projects/source-extraction";
import { startBuildingExtractionWorker } from "@richtfest/projects/building-extraction";
import { startSourceModelWorker } from "@richtfest/projects/source-model";
import { structureSourceDocument } from "./source-model-host";
import { fileStorage } from "./app-hosts";
import { recordAudit } from "./audit";
import { startPublicDataWorker } from "@richtfest/public-data/worker";
import { readBerlinSnapshot } from "@richtfest/public-data/queries";
import { publicDataWorkerDeps } from "./public-data-host";
import { withProviderCredential } from "./ai-connections";
import { callDecisionModel } from "./decision-runtime";
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
const buildingExtractionWorker = startBuildingExtractionWorker({
  db, fileStorage,
  executeDecision: input => withProviderCredential(db,input.tenantId,input.actorId,"typesafe",
    key => callDecisionModel({state:input.state,questions:input.questions,signal:input.signal},key))
    .then(result=>result??{status:"unconfigured" as const}),
  audit: (tx, tenantId, action, versionId, metadata) => recordAudit(tx, null, tenantId, action, "file_version", versionId, metadata, { actorType: "system" }),
  reportError: () => console.error("Building plan extraction database operation failed; will retry"),
});
const modelWorker = startSourceModelWorker({
  db, fileStorage, structureDocument: input => structureSourceDocument(db, input),
  classifyImage: env.SOURCE_IMAGE_TRIAGE_ENABLED ? async (input, signal) => {
    const deps = await backgroundKnowledgeDeps(db, input.tenantId, input.actorId);
    return deps.querySourceImage!(input.projectId, { versionId: input.versionId, page: input.page },
      image => deps.executeImageDecision!({ ...image,
        onUsage: usage => db.transaction(tx => recordAudit(tx, input.actorId, input.tenantId,
          "projects.source.image.usage", "file_version", input.versionId, { page: input.page, usage })),
      }), signal);
  } : undefined,
  audit: (tx, tenantId, action, versionId, metadata) => recordAudit(tx, null, tenantId, action, "file_version", versionId, metadata, { actorType: "system" }),
  reportError: () => console.error("Project source model worker database operation failed"),
});
async function shutdown() {
  server.close();
  await pdfWorker.stop();
  await modelWorker.stop();
  await extractionWorker.stop();
  await buildingExtractionWorker.stop();
  await publicDataWorker?.stop();
  await locationWorker.stop();
  await worker.stop();
  await pool.end();
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
