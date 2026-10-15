import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { SOURCE_DOCUMENT_PARSER_VERSION, sourceDocumentPageSchema, sourceDocumentModelSchema, sourceDocumentLayersSchema,
  type SourceDocumentPage, type SourceDocumentModel, type SourceDocumentLayers, type SourceText } from "@richtfest/shared";
import { sourcePages, sourceExtractions } from "./schema";
import type { FileStorage } from "./deps";
import { inspectPdfLayers } from "./pdf-layers";

const fingerprint = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const conflict = () => Object.assign(new Error("Saved document model does not match its immutable source text"), { status: 409, code: "document_model_conflict" });

/** Deterministic text layout only: no room recognition, interpretation or inference. */
export function buildSourceDocumentPage(versionId: string, page: number, content: SourceText): SourceDocumentPage {
  const raw = content.text ?? "";
  const rawTextSha256 = fingerprint(raw);
  const blocks: SourceDocumentPage["blocks"] = [];
  let lineNumber = 0, lineStartByte = 0;
  for (const match of raw.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (!match[0].length) continue;
    lineNumber++;
    const line = match[1]!;
    let previousEnd = 0, byteOffset = lineStartByte, column = 1;
    // Keep single internal spaces verbatim; split only layout padding and other
    // whitespace. Every non-whitespace token is retained in its original order.
    for (const span of line.matchAll(/\S+(?: \S+)*/gu)) {
      const start = span.index!;
      const gap = line.slice(previousEnd, start);
      byteOffset += Buffer.byteLength(gap, "utf8");
      column += [...gap].length;
      const text = span[0], startByte = byteOffset;
      byteOffset += Buffer.byteLength(text, "utf8");
      blocks.push({ id: `${versionId}:p${page}:${rawTextSha256.slice(0, 12)}:${startByte}-${byteOffset}`,
        text, startByte, endByte: byteOffset, line: lineNumber, column, layerAssociation: "unknown" });
      column += [...text].length;
      previousEnd = start + text.length;
    }
    lineStartByte += Buffer.byteLength(match[0], "utf8");
  }
  const header = raw.slice(0, 300);
  const origin = /^\s*\[Page \d+\]\r?\n\[Native text\]/.test(header) ? "native_text"
    : /^\s*(?:\[Page \d+\]|\[Standalone image\]|\[Affinity[^\r\n]*\])\r?\n\[OCR:/.test(header) ? "ocr" : "unknown";
  return sourceDocumentPageSchema.parse({ version: 1, parserVersion: SOURCE_DOCUMENT_PARSER_VERSION,
    versionId, page, rawTextSha256, rawTextBytes: Buffer.byteLength(raw, "utf8"), origin,
    status: content.status !== "available" || !blocks.length ? "unreadable" : content.truncated ? "incomplete" : "available",
    sourceStatus: content.status, positionSpace: "extracted_text_grid", blocks,
    limitations: ["Text-grid positions are not physical PDF geometry. Blocks do not identify rooms, tables or their relationships.",
      "Page coverage does not establish complete room inventory, engineering inputs or approval. Original extraction and OCR limitations remain applicable.",
      "Hidden PDF-layer text coverage is not verified; text blocks are not associated with PDF optional-content groups. Layer visibility describes display intent, not print output.",
      ...(content.reason ? [content.reason] : [])],
  });
}

/** Never regenerate or overwrite an existing page model silently. */
export function savedSourceDocumentPage(versionId: string, page: number, content: SourceText): SourceDocumentPage | null {
  if (!content.documentModel) return null;
  const parsed = sourceDocumentPageSchema.safeParse(content.documentModel);
  const raw = content.text ?? "";
  if (!parsed.success || parsed.data.versionId !== versionId || parsed.data.page !== page
    || parsed.data.rawTextSha256 !== fingerprint(raw) || parsed.data.rawTextBytes !== Buffer.byteLength(raw, "utf8")) throw conflict();
  const bytes = Buffer.from(raw, "utf8");
  let previousEnd = 0;
  for (const block of parsed.data.blocks) {
    if (block.startByte < previousEnd || block.endByte <= block.startByte || block.endByte > bytes.length
      || bytes.subarray(block.startByte, block.endByte).toString("utf8") !== block.text
      || /\S/u.test(bytes.subarray(previousEnd, block.startByte).toString("utf8"))) throw conflict();
    previousEnd = block.endByte;
  }
  if (/\S/u.test(bytes.subarray(previousEnd).toString("utf8"))) throw conflict();
  return parsed.data;
}

export function withSourceDocumentPage(versionId: string, page: number, content: SourceText): SourceText {
  return { ...content, documentModel: savedSourceDocumentPage(versionId, page, content) ?? buildSourceDocumentPage(versionId, page, content) };
}

const unavailableLayers = (reason: string): SourceDocumentLayers => ({ status: "unavailable",
  parserVersion: "pdfjs-optional-content-v1", visibilityIntent: "display", originalPdfSha256: null,
  groups: [], blockAssociation: "unknown", reason });

/** Inspect the original PDF once; never render, re-extract text or invoke a provider. */
export async function prepareSourceDocumentLayers(source: { name: string; mimeType: string | null; storageKey: string | null },
  storage: Pick<FileStorage, "read">, existing?: SourceDocumentLayers, signal?: AbortSignal): Promise<SourceDocumentLayers> {
  if (existing) return sourceDocumentLayersSchema.parse(existing);
  if (source.mimeType !== "application/pdf" && !/\.pdf$/i.test(source.name))
    return unavailableLayers("PDF optional-content metadata does not apply to this source format.");
  if (!source.storageKey) return unavailableLayers("Original PDF storage is unavailable; layer coverage is unknown.");
  const inspectionSignal = signal ?? AbortSignal.timeout(60_000);
  let stream: Awaited<ReturnType<FileStorage["read"]>> = null;
  try {
    stream = await storage.read(source.storageKey, inspectionSignal);
    if (!stream) return unavailableLayers("Original PDF storage is unavailable; layer coverage is unknown.");
    return sourceDocumentLayersSchema.parse(await inspectPdfLayers(stream, inspectionSignal));
  } catch {
    return unavailableLayers("PDF optional-content inspection is unavailable; layer coverage is unknown.");
  } finally { (stream as { destroy?: () => void } | null)?.destroy?.(); }
}

/** Caller authorizes project/version access. This reader never prepares or queues work. */
export async function readSourceDocumentModel(db: any, tenantId: string, versionId: string,
  input: { page?: number; offset?: number; limit?: number } = {}): Promise<SourceDocumentModel> {
  const offset = input.offset ?? 0, limit = input.limit ?? 12;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100
    || (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1)))
    throw Object.assign(new Error("Invalid document page selection"), { status: 400 });
  const where = and(eq(sourcePages.tenantId, tenantId), eq(sourcePages.versionId, versionId));
  const [extraction] = await db.select({ status: sourceExtractions.status, result: sourceExtractions.result }).from(sourceExtractions)
    .where(and(eq(sourceExtractions.tenantId, tenantId), eq(sourceExtractions.versionId, versionId)));
  const [counts] = await db.select({
    saved: sql<number>`count(*)::int`,
    first: sql<number | null>`min(${sourcePages.page})`, last: sql<number | null>`max(${sourcePages.page})`,
    prepared: sql<number>`count(*) filter (where ${sourcePages.content}->'documentModel'->>'parserVersion' = ${SOURCE_DOCUMENT_PARSER_VERSION})::int`,
    unreadable: sql<number>`count(*) filter (where ${sourcePages.content}->'documentModel'->>'status' = 'unreadable')::int`,
    incomplete: sql<number>`count(*) filter (where ${sourcePages.content}->'documentModel'->>'status' = 'incomplete')::int`,
  }).from(sourcePages).where(where);
  const rows: { page: number; content: SourceText }[] = await db.select({ page: sourcePages.page, content: sourcePages.content }).from(sourcePages)
    .where(and(where, ...(input.page === undefined ? [] : [eq(sourcePages.page, input.page)])))
    .orderBy(sourcePages.page).offset(offset).limit(limit + 1);
  const savedPages = Number(counts.saved), preparedPages = Number(counts.prepared);
  const totalPages = extraction?.result?.pages ?? (extraction?.status === "complete" && !extraction.result?.truncated && savedPages === 1 ? 1 : null);
  return sourceDocumentModelSchema.parse({ version: 1, versionId,
    layersPrepared: !!extraction?.result?.documentLayers,
    layers: extraction?.result?.documentLayers ?? unavailableLayers("PDF optional-content metadata has not been prepared; hidden-layer text coverage is unknown."),
    pages: rows.slice(0, limit).flatMap(row => {
      const model = savedSourceDocumentPage(versionId, row.page, row.content);
      return model ? [model] : [];
    }),
    coverage: { extractionStatus: extraction?.status ?? "unavailable", totalPages, savedPages, preparedPages,
      unpreparedPages: savedPages - preparedPages, unreadablePages: Number(counts.unreadable), incompletePages: Number(counts.incomplete),
      complete: extraction?.status === "complete" && !extraction.result?.truncated && totalPages !== null
        && savedPages === totalPages && preparedPages === totalPages && Number(counts.first) === 1 && Number(counts.last) === totalPages
        && Number(counts.unreadable) === 0 && Number(counts.incomplete) === 0,
      semanticCompleteness: false },
    nextOffset: rows.length > limit ? offset + limit : null,
  });
}
