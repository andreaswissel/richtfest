import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDeps } from "./deps";
import { artifacts, artifactRevisions, artifactPdfExports as exports } from "./schema";
import { renderArtifactPdf } from "./artifact-pdf-worker";

// Bump when the renderer/layout changes; existing reports then regenerate on download.
const rendererVersion = 1;
const unavailable = () => Object.assign(new Error("PDF preparation is unavailable. Please try again later."),
  { status: 503, code: "pdf_unavailable" });

/** In the revision/review transaction: surviving restarts is part of saving a report. */
export async function queueArtifactPdf(d: AppDeps, tx: any, revisionId: string, invalidate = true) {
  const insert = tx.insert(exports).values({ revisionId, tenantId: d.tenantId, requestedBy: d.actorId });
  const [queued] = await (invalidate ? insert.onConflictDoUpdate({ target: exports.revisionId, set: {
      status: "queued", inputHash: null, requestedBy: d.actorId, attempts: 0,
      leaseToken: null, leaseUntil: null, updatedAt: new Date(),
    } }) : insert.onConflictDoNothing()).returning();
  if (queued) await d.audit(tx, "knowledge.artifact_pdf.queued", "artifact_revision", revisionId);
}

async function pdfInput(d: AppDeps, artifactId: string, revisionId: string) {
  d.requirePermission("knowledge:read");
  const [row] = await d.db.select({
    projectId: artifacts.projectId, title: artifactRevisions.title,
    content: artifactRevisions.content, version: artifactRevisions.version,
    status: sql<string>`case when ${artifactRevisions.version} = (select max(r.version) from knowledge_artifact_revisions r where r.artifact_id=${artifacts.id} and r.tenant_id=${d.tenantId}) then ${artifacts.status} else 'historical revision' end`,
    sourceVersionIds: artifactRevisions.sourceVersionIds, payload: artifactRevisions.payload,
  }).from(artifactRevisions).innerJoin(artifacts, eq(artifactRevisions.artifactId, artifacts.id))
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.tenantId, d.tenantId),
      eq(artifactRevisions.id, revisionId), eq(artifactRevisions.tenantId, d.tenantId))).limit(1);
  if (!row || !(await d.validateProject(row.projectId)))
    throw Object.assign(new Error("Artifact revision not found"), { status: 404, code: "not_found" });
  const sourceVersionIds: string[] = Array.isArray(row.sourceVersionIds)
    ? row.sourceVersionIds.filter((id: unknown): id is string => typeof id === "string") : [];
  const sources = (await d.sourceReferences(row.projectId, sourceVersionIds))
    .sort((a, b) => a.versionId.localeCompare(b.versionId));
  if (!d.sourcePdfVersionIds) throw unavailable();
  const eligiblePdfs = (await d.sourcePdfVersionIds(row.projectId, sourceVersionIds)).sort();
  const input = { ...row, sourceVersionIds, sources, template: row.payload?.template };
  // Include current source names/availability/purpose and status, not just the revision ID.
  const hash = createHash("sha256").update(JSON.stringify({ rendererVersion, input, eligiblePdfs })).digest("hex");
  return { input, hash };
}

/** One owner per revision across requests and replicas; an expired lease is recoverable. */
export async function prepareArtifactPdf(d: AppDeps, artifactId: string, revisionId: string) {
  const { input, hash } = await pdfInput(d, artifactId, revisionId);
  const storage = d.pdfStorage;
  if (!storage) throw unavailable();
  const scope = and(eq(exports.tenantId, d.tenantId), eq(exports.revisionId, revisionId));
  const [cached] = await d.db.select().from(exports).where(scope);
  if (!cached) await d.db.transaction((tx: any) => queueArtifactPdf(d, tx, revisionId, false));
  if (cached?.status === "ready" && cached.inputHash === hash && cached.storageKey) {
    const stored = await storage.read(cached.storageKey);
    if (stored) return { ...stored, title: input.title, version: input.version };
    // Missing blobs are not successful exports; recover without serving an empty PDF.
    await d.db.update(exports).set({ status: "queued", inputHash: null, attempts: 0 })
      .where(and(scope, eq(exports.status, "ready"), eq(exports.inputHash, hash)));
  }
  const token = randomUUID();
  const job = await d.db.transaction(async (tx: any) => {
    const [current] = await tx.select().from(exports).where(scope).for("update");
    if (current.leaseUntil && current.leaseUntil > new Date()
      && (current.status === "running" || current.inputHash === hash)) return null;
    if (current.status === "ready" && current.inputHash === hash) return null;
    if (current.inputHash === hash && current.attempts >= 3) {
      if (current.status !== "failed") {
        await tx.update(exports).set({ status: "failed", leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(scope);
        await d.audit(tx, "knowledge.artifact_pdf.failed", "artifact_revision", revisionId);
      }
      return { exhausted: true };
    }
    const attempts = current.inputHash === hash ? current.attempts + 1 : 1;
    await tx.update(exports).set({ status: "running", inputHash: hash, attempts, leaseToken: token,
      leaseUntil: new Date(Date.now() + 10 * 60_000), updatedAt: new Date() }).where(scope);
    await d.audit(tx, "knowledge.artifact_pdf.started", "artifact_revision", revisionId);
    return { ...current, attempts };
  });
  if (!job) return null;
  if (job.exhausted) throw unavailable();
  const owned = and(scope, eq(exports.leaseToken, token));
  const storageKey = `${d.tenantId}/${artifactId}/${revisionId}/${token}`;
  let published = false;
  try {
    const bytes = await renderArtifactPdf({ ...input, readSourcePdf: d.readSourcePdf });
    await storage.write(storageKey, bytes);
    published = await d.db.transaction(async (tx: any) => {
      const [saved] = await tx.update(exports).set({ status: "ready", storageKey,
        leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(owned).returning();
      if (!saved) return false; // A newer revision/status invalidated the in-flight export.
      await d.audit(tx, "knowledge.artifact_pdf.ready", "artifact_revision", revisionId, { sizeBytes: bytes.length });
      return true;
    });
    if (published && job.storageKey) await storage.remove(job.storageKey).catch(() => {});
  } catch (error) {
    await d.db.transaction(async (tx: any) => {
      const [saved] = await tx.update(exports).set({ status: job.attempts < 3 ? "queued" : "failed",
        leaseToken: null, leaseUntil: new Date(Date.now() + 5000), updatedAt: new Date() }).where(owned).returning();
      if (saved) await d.audit(tx, "knowledge.artifact_pdf.failed", "artifact_revision", revisionId);
    });
    throw error;
  } finally {
    if (!published) await storage.remove(storageKey).catch(() => {});
  }
  // Recheck current access, source state and status before delivering, even after a long render.
  return null;
}

export function startArtifactPdfWorker(d: {
  db: any;
  resolveDeps: (tenantId: string, actorId: string) => Promise<AppDeps>;
  reportError: () => void;
}) {
  let stopping = false;
  let active: Promise<void> | undefined;
  const tick = async () => {
    const [job] = await d.db.select({ tenantId: exports.tenantId, actorId: exports.requestedBy,
      revisionId: exports.revisionId, artifactId: artifactRevisions.artifactId })
      .from(exports).innerJoin(artifactRevisions, eq(artifactRevisions.id, exports.revisionId))
      .where(and(inArray(exports.status, ["queued", "running"]),
        sql`(${exports.leaseUntil} is null or ${exports.leaseUntil} < now())`))
      .orderBy(exports.updatedAt).limit(1);
    if (!job || stopping) return;
    const deps = await d.resolveDeps(job.tenantId, job.actorId);
    try {
      const result = await prepareArtifactPdf(deps, job.artifactId, job.revisionId);
      // Another replica may have completed it between polling and claiming.
      if (result) for await (const _chunk of result.stream) { /* drain/close the storage stream */ }
    } catch (error) {
      // Revoked access fails closed, without repeatedly polling an unclaimable job.
      if ([403, 404].includes((error as { status?: number }).status ?? 0)) {
        await deps.db.transaction(async (tx: any) => {
          await tx.update(exports).set({ status: "failed", updatedAt: new Date() })
            .where(and(eq(exports.revisionId, job.revisionId), eq(exports.tenantId, job.tenantId),
              inArray(exports.status, ["queued", "running"]),
              sql`(${exports.leaseUntil} is null or ${exports.leaseUntil} < now())`));
          await deps.audit(tx, "knowledge.artifact_pdf.failed", "artifact_revision", job.revisionId);
        });
      }
      d.reportError();
    }
  };
  const schedule = () => {
    if (!stopping && !active) active = tick().catch(d.reportError).finally(() => { active = undefined; });
  };
  const timer = setInterval(schedule, 1000);
  timer.unref(); schedule();
  return { async stop() { stopping = true; clearInterval(timer); await active; } };
}
