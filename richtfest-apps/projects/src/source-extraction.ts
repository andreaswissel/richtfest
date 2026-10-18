import { and, eq, sql, inArray } from "drizzle-orm";
import type { SourceText, SourceDocumentLayers } from "@richtfest/shared";
import type { SourceExtractionDeps } from "./deps";
import { files, fileVersions, sourceExtractions as jobs, sourcePages } from "./schema";
import { extractSourceText } from "./source-text";
import { proposeDocumentType } from "./document-type-proposal";
import { isIfcSource } from "./ifc-model";
import { withSourceDocumentPage, prepareSourceDocumentLayers } from "./source-document";

/** Only upload completion/migration queues work. Reads never start extraction. */
export async function runSourceExtraction(d: SourceExtractionDeps, signal: AbortSignal): Promise<boolean> {
  const token = crypto.randomUUID();
  const job = await d.db.transaction(async (tx: any) => {
    const [row] = await tx.select().from(jobs).where(and(
      inArray(jobs.status, ["queued", "running"]),
      sql`(${jobs.leaseUntil} is null or ${jobs.leaseUntil} < now())`,
    )).orderBy(jobs.createdAt).limit(1).for("update", { skipLocked: true });
    if (!row) return null;
    await tx.update(jobs).set({ status: "running", attempts: row.attempts + 1, leaseToken: token,
      leaseUntil: new Date(Date.now() + 10 * 60_000), updatedAt: new Date() }).where(eq(jobs.versionId, row.versionId));
    await d.audit(tx, row.tenantId, "projects.source.extraction.started", row.versionId);
    return row;
  });
  if (!job) return false;
  const owned = and(eq(jobs.versionId, job.versionId), eq(jobs.tenantId, job.tenantId), eq(jobs.leaseToken, token));
  const jobSignal = AbortSignal.any([signal, AbortSignal.timeout(6 * 60_000)]);
  let result: SourceText;
  let status = "complete";
  let progressed = false;
  let documentLayers: SourceDocumentLayers | undefined = job.result?.documentLayers;
  try {
    signal.throwIfAborted();
    if (job.attempts >= 3) throw new Error("Extraction recovery limit reached");
    const [source] = await d.db.select({ storageKey: fileVersions.storageKey, mimeType: fileVersions.mimeType, name: files.name })
      .from(fileVersions).innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, fileVersions.tenantId)))
      .where(and(eq(fileVersions.id, job.versionId), eq(fileVersions.tenantId, job.tenantId), eq(fileVersions.status, "ready")));
    if (!source?.storageKey) throw new Error("Ready source unavailable");
    documentLayers = await prepareSourceDocumentLayers(source, d.fileStorage, documentLayers, jobSignal);
    const structured = isIfcSource(source.mimeType ?? "", source.name);
    if (structured) result = { status: "unsupported", reason: "IFC is imported into the structured source model, not interpreted as raw text." };
    // A process may have stopped after saving the last page but before finalizing.
    else if (job.result?.pages && job.nextPage > job.result.pages) result = job.result;
    else {
      const stream = await d.fileStorage.read(source.storageKey, jobSignal);
      if (!stream) throw new Error("Source storage unavailable");
      try {
        result = await extractSourceText(stream, source.mimeType ?? "", source.name, { pageStart: job.nextPage }, async (page, content) => {
          jobSignal.throwIfAborted();
          await d.db.transaction(async (tx: any) => {
            const [updated] = await tx.update(jobs).set({ nextPage: page + 1, result: { ...content, text: undefined, documentLayers },
              attempts: 0, leaseUntil: new Date(Date.now() + 10 * 60_000), updatedAt: new Date() }).where(owned).returning({ id: jobs.versionId });
            if (!updated) throw new Error("Extraction lease lost");
            await tx.insert(sourcePages).values({ tenantId: job.tenantId, versionId: job.versionId, page, content: withSourceDocumentPage(job.versionId, page, content) });
          });
          progressed = true;
        });
        jobSignal.throwIfAborted();
      } finally {
        // Storage adapters return Node streams, including unsupported formats
        // which extraction deliberately never consumes.
        (stream as AsyncIterable<Uint8Array> & { destroy?: () => void }).destroy?.();
      }
      if (result.coverage?.nextPage && result.coverage.nextPage > job.nextPage) status = "queued";
    }
    if (!structured && result.status !== "available" && !result.pages && status !== "queued") status = "failed";
  } catch {
    status = signal.aborted || progressed || job.attempts < 2 ? "queued" : "failed";
    result = { status: "extraction_failed", reason: "Source extraction interrupted or storage unavailable. Automatic recovery is bounded; the original remains available for manual review." };
  }
  await d.db.transaction(async (tx: any) => {
    const [current] = await tx.select().from(jobs).where(owned).for("update");
    if (!current) return;
    result = { ...result, pages: result.pages ?? current.result?.pages, ...(documentLayers ? { documentLayers } : {}) };
    if (status === "complete" || status === "failed") {
      const [version] = await tx.select({ sourceMetadata: fileVersions.sourceMetadata }).from(fileVersions)
        .where(and(eq(fileVersions.id, job.versionId), eq(fileVersions.tenantId, job.tenantId)));
      if ((version?.sourceMetadata as { workflow?: string } | null)?.workflow === "site_assessment") {
        const pages = await tx.select({ page: sourcePages.page, content: sourcePages.content }).from(sourcePages)
          .where(and(eq(sourcePages.versionId, job.versionId), eq(sourcePages.tenantId, job.tenantId))).orderBy(sourcePages.page).limit(100);
        result.documentTypeProposal = proposeDocumentType(job.versionId, version.sourceMetadata, pages);
      }
    }
    const [saved] = await tx.update(jobs).set({ status, result: { ...result, text: undefined }, leaseToken: null,
      leaseUntil: status === "queued" ? new Date(Date.now() + 2000) : null, updatedAt: new Date() }).where(owned).returning({ id: jobs.versionId });
    if (!saved) return;
    // Text-like sources use one bounded, persisted excerpt, with no PDF pages.
    if (result.text && !result.pages) await tx.insert(sourcePages).values({ tenantId: job.tenantId, versionId: job.versionId, page: 1, content: withSourceDocumentPage(job.versionId, 1, result) }).onConflictDoNothing();
    await d.audit(tx, job.tenantId, `projects.source.extraction.${status}`, job.versionId, { status: result.status, pages: result.pages });
  });
  return true;
}

export function startSourceExtractionWorker(d: SourceExtractionDeps) {
  const controller = new AbortController();
  let active: Promise<void> | null = null;
  const tick = () => {
    if (active || controller.signal.aborted) return;
    active = runSourceExtraction(d, controller.signal).then(() => {}, () => d.reportError()).finally(() => { active = null; });
  };
  const timer = setInterval(tick, 1000);
  timer.unref(); tick();
  return { async stop() { clearInterval(timer); controller.abort(); await active; } };
}

/** Called only after the host has validated project/version membership. */
export async function readSourceText(db: any, tenantId: string, versionId: string,
  input: { pageStart?: number; pageEnd?: number; textQuery?: string } = {}): Promise<SourceText> {
  const [job] = await db.select().from(jobs).where(and(eq(jobs.tenantId, tenantId), eq(jobs.versionId, versionId)));
  if (!job) return { status: "unsupported", reason: "No saved extraction is available for this revision." };
  if (["queued", "running"].includes(job.status)) return { status: "processing", reason: "Upload extraction is in progress. No agent extraction is needed; read the saved result when ready." };
  const explicitRange = input.pageStart !== undefined || input.pageEnd !== undefined;
  const pageStart = input.pageStart ?? 1;
  const pageEnd = input.pageEnd ?? job.result?.pages ?? 1;
  if (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd) || pageStart < 1 || pageEnd < pageStart || (job.result?.pages && pageStart > job.result.pages))
    return { status: "extraction_failed", pages: job.result?.pages, reason: "Invalid PDF page range." };
  const terms = [...new Set(input.textQuery?.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 64);
  const search = !explicitRange && terms.length > 0;
  const query = sql`websearch_to_tsquery('simple', ${terms.join(" OR ")})`;
  const rank = sql`ts_rank_cd(to_tsvector('simple', coalesce(${sourcePages.content}->>'text', '')), ${query})`;
  const rows: { page: number; content: SourceText }[] = await db.select({ page: sourcePages.page, content: sourcePages.content }).from(sourcePages)
    .where(and(eq(sourcePages.tenantId, tenantId), eq(sourcePages.versionId, versionId),
      ...(explicitRange ? [sql`${sourcePages.page} >= ${pageStart}`, sql`${sourcePages.page} <= ${pageEnd}`] : [])))
    .orderBy(...(search ? [sql`${rank} desc`, sourcePages.page] : [sourcePages.page])).limit(explicitRange ? 100 : 6);
  if (!rows.length) return job.result ?? { status: "extraction_failed", reason: "No saved source text is available." };
  let budget = explicitRange ? 256 * 1024 : 16000;
  let clipped = false;
  const selected: { page: number; text: string; readable: boolean }[] = [];
  for (const row of rows) {
    const raw = row.content.text ?? `[Page ${row.page}]\n[${row.content.status}: ${row.content.reason ?? "Manual review required"}]`;
    const allowance = search ? Math.min(budget, 2600) : budget;
    if (allowance <= 0) { clipped = true; break; }
    // Preserve whole pages for explicit human/page-range inspection, as before.
    if (explicitRange && raw.length > allowance) { clipped = true; break; }
    let text = raw;
    if (raw.length > allowance) {
      clipped = true;
      const lower = raw.toLowerCase();
      const hits = search ? terms.map(term => lower.indexOf(term)).filter(index => index >= 0) : [];
      const start = hits.length ? Math.max(0, Math.min(...hits) - 400) : 0;
      const prefix = `[Page ${row.page}; partial saved excerpt]\n${raw.split("\n").slice(0, 3).join("\n").slice(0, 200)}\n`;
      text = (prefix + raw.slice(start, start + Math.max(0, allowance - prefix.length - 4)) + "\n[…]").slice(0, allowance);
    }
    budget -= text.length + 1;
    selected.push({ page: row.page, text, readable: row.content.status === "available" });
  }
  selected.sort((a, b) => a.page - b.page);
  const text = selected.map(row => row.text).join("\n");
  const totalPages = job.result?.pages;
  const lastPage = selected.at(-1)?.page ?? pageStart - 1;
  const truncated = clipped || job.status === "failed" || !!job.result?.truncated || (totalPages ? selected.length < totalPages : false);
  return {
    status: selected.some(row => row.readable) ? "available" : "extraction_failed",
    text, pages: totalPages, truncated,
    reason: [rows[0].content.reason, job.status === "failed" ? job.result?.reason : undefined,
      search ? "Relevant saved passages, not a complete document review. Non-matching pages may be omitted." : undefined,
      truncated ? "Limited excerpt; omitted content must not be assumed. Request explicit original page ranges for more evidence." : undefined].filter(Boolean).join(" "),
    coverage: !search && totalPages ? { pageStart, pageEnd: lastPage, totalPages, truncated, nextPage: !explicitRange && clipped ? lastPage : lastPage < totalPages ? lastPage + 1 : null } : undefined,
    retrieval: { mode: search ? "relevant_passages" : "pages", pageNumbers: selected.map(row => row.page), characters: text.length },
  };
}
