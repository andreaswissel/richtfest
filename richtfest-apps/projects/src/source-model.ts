import { Worker } from "node:worker_threads";
import { and, eq, inArray, sql } from "drizzle-orm";
import { documentModelOutput, type SourceModelImport, type DocumentModelInput } from "@richtfest/shared";
import type { SourceModelDeps } from "./deps";
import { sourceModels as jobs, sourceEntities, sourceFacts, sourcePages, sourceExtractions, files, fileVersions } from "./schema";
import { isIfcSource } from "./ifc-model";
import { readSourceText } from "./source-extraction";
import { extractSourceImage, isImageSource } from "./source-text";

/** Non-overlapping evidence windows: never re-read text or accept cross-window quotes. */
function textBatches(pages: DocumentModelInput["pages"]) {
  const batches: DocumentModelInput["pages"][] = [];
  let batch: DocumentModelInput["pages"] = [], size = 0;
  for (const page of pages) {
    for (let offset = 0; offset < page.text.length;) {
      const text = page.text.slice(offset, offset + 4000 - size);
      batch.push({ page: page.page, text }); size += text.length; offset += text.length;
      if (size === 4000) { batches.push(batch); batch = []; size = 0; }
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function parseIfc(bytes: Uint8Array, signal: AbortSignal): Promise<SourceModelImport> {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./ifc-model-worker.ts", import.meta.url));
  try {
    return await new Promise((resolve, reject) => {
      const abort = () => reject(new Error("IFC import interrupted"));
      signal.addEventListener("abort", abort, { once: true });
      worker.once("error", reject);
      worker.once("exit", () => { signal.removeEventListener("abort", abort); reject(new Error("IFC worker exited")); });
      worker.once("message", message => {
        signal.removeEventListener("abort", abort);
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      });
      worker.postMessage(bytes);
    });
  } finally { await worker.terminate(); }
}

/** One durable attempt per revision. An ambiguous interrupted provider call is never replayed. */
export async function runSourceModel(d: SourceModelDeps, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const token = crypto.randomUUID();
  const claimed = await d.db.transaction(async (tx: any) => {
    const [row] = await tx.select({ job: jobs, extraction: sourceExtractions, source: fileVersions, name: files.name, projectId: files.projectId, purpose: files.purpose })
      .from(jobs)
      .innerJoin(fileVersions, and(eq(fileVersions.id, jobs.versionId), eq(fileVersions.tenantId, jobs.tenantId)))
      .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, jobs.tenantId)))
      .innerJoin(sourceExtractions, and(eq(sourceExtractions.versionId, jobs.versionId), eq(sourceExtractions.tenantId, jobs.tenantId)))
      .where(and(eq(fileVersions.status, "ready"), sql`(
        (${jobs.status} = 'queued' and ${inArray(sourceExtractions.status, ["complete", "failed"])}) or
        (${jobs.status} = 'running' and ${jobs.leaseUntil} < now()))`))
      .orderBy(jobs.createdAt).limit(1).for("update", { of: jobs, skipLocked: true });
    if (!row) return null;
    await tx.update(jobs).set({ status: "running", leaseToken: token, leaseUntil: new Date(Date.now() + 10 * 60_000), updatedAt: new Date() })
      .where(eq(jobs.versionId, row.job.versionId));
    await d.audit(tx, row.job.tenantId, "projects.source.model.started", row.job.versionId);
    return row;
  });
  if (!claimed) return false;
  const { job, source, extraction, name } = claimed;
  const owned = and(eq(jobs.versionId, job.versionId), eq(jobs.tenantId, job.tenantId), eq(jobs.leaseToken, token));
  const method = isIfcSource(source.mimeType ?? "", name) ? "ifc" : "document";
  const workSignal = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
  let status = "complete";
  let imported: SourceModelImport = { entities: [], facts: [], metadata: {} };
  let failureCode = "provider";
  try {
    if (job.status === "running") { failureCode = "interrupted"; throw new Error("Interrupted attempt"); }
    if (method === "ifc") {
      const stream = await d.fileStorage.read(source.storageKey, workSignal);
      if (!stream) throw new Error("Source unavailable");
      try {
        const parts: Uint8Array[] = [];
        for await (const part of stream) { workSignal.throwIfAborted(); parts.push(part); }
        imported = await parseIfc(Buffer.concat(parts), workSignal);
      } finally { (stream as { destroy?: () => void }).destroy?.(); }
    } else {
      const pdf = source.mimeType === "application/pdf" || /\.pdf$/i.test(name);
      const standalone = isImageSource(source.mimeType ?? "", name) && !/\.afpub$/i.test(name);
      if (d.classifyImage && (pdf || standalone) && claimed.purpose === "project_evidence") {
        const total = standalone ? 1 : extraction.result?.pages ?? null;
        const count = total === null ? 1 : Math.min(24, total);
        // Triage must leave time for the existing source-model import.
        const classificationSignal = AbortSignal.any([workSignal, AbortSignal.timeout(45_000)]);
        const receipts: import("@richtfest/shared").SourceImageReceipt[] = [];
        let missing = 0, attempted = 0;
        for (let page = 1; page <= count; page++) {
          if (classificationSignal.aborted) break;
          attempted++;
          try {
            const result = await d.classifyImage({ tenantId: job.tenantId, actorId: source.createdBy,
              projectId: claimed.projectId, versionId: job.versionId, page }, classificationSignal);
            receipts.push(result);
            if (result.status === "unavailable") missing++;
            if (["unconfigured", "outcome_unknown", "limit_reached"].includes(result.status)) break;
          } catch { break; /* Triage failure must not fail or repeatedly delay document structuring. */ }
        }
        imported.metadata.imageClassification = { totalPages: total, attemptedPages: attempted,
          completedPages: receipts.filter(r => r.status === "completed").length, missingPages: missing,
          uninspectedPages: total === null ? null : total - receipts.filter(r => r.status === "completed").length,
          coverageUnknown: total === null, receipts,
          semanticInspection: false, provenance: "inferred" };
      }
      // Reuse saved text. Images additionally supply one bounded raster to this
      // upload-time pass, never to subsequent agent reads.
      const rows: { page: number; text: string | null }[] = await d.db.select({ page: sourcePages.page, text: sql<string>`left(${sourcePages.content}->>'text', 24000)` })
        .from(sourcePages).where(and(eq(sourcePages.versionId, job.versionId), eq(sourcePages.tenantId, job.tenantId)))
        .orderBy(sourcePages.page).limit(24);
      let remaining = 24000;
      const pages = rows.flatMap((row: { page: number; text: string | null }) => {
        const text = (row.text ?? "").slice(0, remaining);
        remaining -= text.length;
        return text ? [{ page: row.page, text }] : [];
      });
      imported.metadata = { ...imported.metadata, scope: "Bounded proposal index, not exhaustive document interpretation", inputPages: pages.map(p => p.page),
        inputCharacters: 24000 - remaining, sourcePages: extraction.result?.pages ?? null, sourceExtractionStatus: extraction.status,
        sourceExtractionNotes: extraction.result?.reason, sourceTruncated: extraction.result?.truncated };
      let image: DocumentModelInput["image"];
      if (isImageSource(source.mimeType ?? "", name)) {
        const stream = await d.fileStorage.read(source.storageKey, workSignal);
        if (!stream) throw new Error("Source image unavailable");
        try {
          const visual = await extractSourceImage(stream, name, true);
          image = visual.image;
          imported.metadata.visualNotes = visual.content.reason;
          imported.metadata.imageScope = image?.scope;
        } finally { (stream as { destroy?: () => void }).destroy?.(); }
      }
      if (!pages.length && !image) status = "unsupported";
      else {
        const batches = textBatches(pages);
        if (!batches.length) batches.push([]);
        const diagnostics: Record<string, unknown>[] = [];
        imported.metadata.batches = diagnostics;
        for (const [index, batch] of batches.entries()) {
          workSignal.throwIfAborted();
          const batchImage = index === 0 ? image : undefined;
          const result = await d.structureDocument({ tenantId: job.tenantId, actorId: source.createdBy, versionId: job.versionId, pages: batch, image: batchImage });
          diagnostics.push({ batch: index + 1, status: result.status, ...("metadata" in result ? result.metadata : {}) });
          if ("metadata" in result) imported.metadata = { ...imported.metadata, ...result.metadata, batches: diagnostics };
          if (result.status !== "completed") { status = result.status; imported.entities = []; imported.facts = []; break; }
          failureCode = "schema";
          const output = documentModelOutput.parse(result.output);
          failureCode = "evidence";
          const keys = new Set(output.entities.map(entity => entity.key));
          if (keys.size !== output.entities.length || output.facts.some(fact => !keys.has(fact.entityKey)
            || (fact.evidence.kind === "image"
              ? !batchImage || fact.evidence.scope !== batchImage.scope || fact.provenance !== "inferred"
              : !batch.some(page => fact.evidence.kind === "text" && page.page === fact.evidence.page && page.text.includes(fact.evidence.quote)))))
            throw new Error("Source evidence does not match supplied text or image");
          const namespace = (key: string) => `batch${index + 1}:${key}`;
          imported.entities.push(...output.entities.map(entity => ({ ...entity, key: namespace(entity.key) })));
          imported.facts.push(...output.facts.map(fact => ({ ...fact, entityKey: namespace(fact.entityKey) })));
          failureCode = "provider";
        }
      }
    }
    workSignal.throwIfAborted();
  } catch {
    status = "failed";
    imported = { entities: [], facts: [], metadata: { ...imported.metadata,
      diagnostic: { code: workSignal.aborted ? "interrupted" : failureCode, retryable: false },
      reason: "Import failed, evidence was invalid, or the attempt was interrupted. No automatic replay; originals and saved text remain available." } };
  }
  await d.db.transaction(async (tx: any) => {
    const [current] = await tx.select().from(jobs).where(owned).for("update");
    if (!current) return;
    // Publication and terminal state are atomic. Different source claims are never merged.
    for (let i = 0; i < imported.entities.length; i += 500) await tx.insert(sourceEntities).values(imported.entities.slice(i, i + 500).map(entity => ({ ...entity, tenantId: job.tenantId, versionId: job.versionId })));
    for (let i = 0; i < imported.facts.length; i += 500) await tx.insert(sourceFacts).values(imported.facts.slice(i, i + 500).map(fact => ({ ...fact, tenantId: job.tenantId, versionId: job.versionId })));
    const metadata = { ...current.metadata, ...imported.metadata, entityCount: imported.entities.length, factCount: imported.facts.length };
    await tx.update(jobs).set({ status, method, metadata, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(owned);
    await d.audit(tx, job.tenantId, `projects.source.model.${status}`, job.versionId, { method, entityCount: imported.entities.length, factCount: imported.facts.length });
  });
  return true;
}

export function startSourceModelWorker(d: SourceModelDeps) {
  const controller = new AbortController();
  let active: Promise<void> | null = null;
  const tick = () => {
    if (active || controller.signal.aborted) return;
    active = runSourceModel(d, controller.signal).then(() => {}, () => d.reportError()).finally(() => { active = null; });
  };
  const timer = setInterval(tick, 1000);
  timer.unref(); tick();
  return { async stop() { clearInterval(timer); controller.abort(); await active; } };
}

/** Caller validates project access; this query always additionally scopes tenant and revision. */
export async function readSourceModel(db: any, tenantId: string, versionId: string,
  input: { query?: string; entityKey?: string; offset?: number; limit?: number } = {}) {
  const [job] = await db.select({ status: jobs.status, method: jobs.method, metadata: jobs.metadata }).from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.versionId, versionId)));
  if (!job) return null;
  const { imageQueries: _privateQueries, ...publicMetadata } = job.metadata;
  job.metadata = publicMetadata;
  const limit = Math.max(1, Math.min(100, input.limit ?? 30)), offset = Math.max(0, input.offset ?? 0);
  const terms = [...new Set(input.query?.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 64);
  const search = sql`websearch_to_tsquery('simple', ${terms.join(" OR ")})`;
  const document = sql`to_tsvector('simple', regexp_replace(${sourceFacts.predicate} || ' ' || ${sourceFacts.value}::text, '[[:punct:]]', ' ', 'g'))`;
  const rows = await db.select({ fact: sourceFacts, entity: sourceEntities }).from(sourceFacts)
    .innerJoin(sourceEntities, and(eq(sourceEntities.versionId, sourceFacts.versionId), eq(sourceEntities.key, sourceFacts.entityKey), eq(sourceEntities.tenantId, tenantId)))
    .where(and(eq(sourceFacts.versionId, versionId), eq(sourceFacts.tenantId, tenantId),
      ...(terms.length ? [sql`${document} @@ ${search}`] : []),
      ...(input.entityKey ? [eq(sourceFacts.entityKey, input.entityKey)] : [])))
    .orderBy(...(terms.length ? [sql`ts_rank_cd(${document}, ${search}) desc`] : []), sourceFacts.id).offset(offset).limit(limit + 1);
  return { versionId, ...job, facts: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null,
    coverage: "Selected source claims only; missing or conflicting facts must not be inferred. Review status applies to each fact, not the whole model." };
}

/** Default agent reads prefer the saved model; explicit page reads retain original text evidence. */
export async function readSourceEvidence(db: any, tenantId: string, versionId: string,
  input: { name: string; mimeType: string; pageStart?: number; pageEnd?: number; textQuery?: string; entityKey?: string; modelOffset?: number }) {
  const image = isImageSource(input.mimeType, input.name);
  // Short visual descriptions need not share the task's wording. Return their
  // bounded fact index rather than treating a keyword miss as unreadable content.
  const model = await readSourceModel(db, tenantId, versionId, { query: image ? undefined : input.textQuery, entityKey: input.entityKey, offset: input.modelOffset });
  const ifc = isIfcSource(input.mimeType, input.name);
  const explicitPages = input.pageStart !== undefined || input.pageEnd !== undefined;
  if (image && !explicitPages && model && ["queued", "running"].includes(model.status))
    return { status: "processing" as const, reason: "Image interpretation is pending; saved OCR alone may not describe the source." };
  if (model?.status === "complete" && (!explicitPages || ifc) && model.facts.length) {
    let budget = 16000, omitted = false;
    const lines: string[] = [];
    for (const { fact, entity } of model.facts) {
      const line = JSON.stringify({ id: fact.id, entity: { key: entity.key, name: entity.name, kind: entity.kind, globalId: entity.globalId },
        predicate: fact.predicate, kind: fact.kind, value: fact.value, unit: fact.unit, provenance: fact.provenance, reviewStatus: fact.reviewStatus, evidence: fact.evidence });
      if (line.length > budget) { omitted = true; continue; }
      lines.push(line); budget -= line.length + 1;
    }
    return { status: "available" as const, text: lines.join("\n"), truncated: true,
      reason: `${model.coverage} ${model.metadata.sourceExtractionNotes ?? ""} ${model.metadata.visualNotes ?? ""} Saved ${model.method} model facts, not a fresh extraction. ${omitted ? "Oversized facts omitted from this excerpt. " : ""}Use the model API for full fact records, entityKey/modelOffset for more claims, or explicit page ranges for document text.`,
      model: { status: model.status, method: model.method, metadata: model.metadata, nextOffset: model.nextOffset } };
  }
  if (ifc) return { status: model && ["queued", "running"].includes(model.status) ? "processing" as const : "extraction_failed" as const,
    reason: model?.status === "complete" ? "No imported IFC facts match this selection. No absence or engineering result can be inferred." : "Deterministic IFC model import is pending or unavailable; the original remains available. No LLM fallback is used." };
  const text = await readSourceText(db, tenantId, versionId, input);
  return { ...text,
    reason: image ? `${text.reason ?? ""} Visual model: ${model?.status ?? "unavailable"}. ${model?.metadata.visualNotes ?? ""}` : text.reason,
    model: model ? { status: model.status, metadata: model.metadata } : null };
}
