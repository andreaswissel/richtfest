import { createHash } from "node:crypto";
import type { SourceDocumentModel, SourceDocumentLayers } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { batchSectionSources } from "./source-batches";

/** Agent execution waits without provider calls; the source HTTP API stays fast. */
export async function resolveRunSource(d: AppDeps, projectId: string,
  input: Parameters<AppDeps["resolveSource"]>[1], assertActive: () => Promise<unknown>) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    await assertActive();
    const result = await d.resolveSource(projectId, input);
    if ((result as { content?: { status?: string } })?.content?.status !== "processing") return result;
    if (Date.now() >= deadline) throw new Error("Source extraction is still in progress. Retry the run after upload processing completes.");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/** Read saved PDF pages to the end of the requested range, never just search hits. */
export async function resolveCompleteRunSource(d: AppDeps, projectId: string,
  input: { versionId: string; pageStart?: number; pageEnd?: number; preferDocumentModel?: boolean }, assertActive: () => Promise<unknown>) {
  if (input.preferDocumentModel && input.pageStart === undefined && input.pageEnd === undefined) {
    const parsed = await resolveCompleteDocumentModel(d, projectId, input.versionId, assertActive);
    if (parsed) return parsed;
  }
  const first: any = await resolveRunSource(d, projectId, { ...input, pageStart: input.pageStart ?? 1 }, assertActive);
  if (first?.content?.evidenceKind === "environment_research") return first;
  if (input.preferDocumentModel && first?.content) first.content = { ...first.content,
    reason: `No complete prepared document model is available for this read; using saved original text with its extraction limitations. ${first.content.reason ?? ""}` };
  if (first?.status !== "resolved" || first.source?.versionId !== input.versionId || !first.content?.coverage) return first;
  const parts = [first.content];
  const end = input.pageEnd ?? first.content.coverage.totalPages;
  let next = first.content.coverage.nextPage;
  let previous = input.pageStart ?? 1;
  while (next !== null && next !== undefined && next <= end) {
    if (next <= previous) throw new Error("Saved source pagination did not advance. Restore source extraction before retrying.");
    previous = next;
    const result: any = await resolveRunSource(d, projectId, { ...input, pageStart: next, pageEnd: end }, assertActive);
    if (result?.status !== "resolved" || result.source?.versionId !== input.versionId || !result.content?.coverage)
      throw new Error("Saved source coverage changed while reading the report.");
    parts.push(result.content);
    next = result.content.coverage.nextPage;
  }
  const pageNumbers = [...new Set<number>(parts.flatMap(part => part.retrieval?.pageNumbers ?? []))].sort((a, b) => a - b);
  const start = input.pageStart ?? 1;
  const complete = parts.every(part => part.status === "available") && pageNumbers.length === end - start + 1
    && pageNumbers.every((page, index) => page === start + index);
  return { ...first, content: { ...first.content,
    text: parts.map(part => part.text ?? "").join("\n"),
    truncated: !complete,
    reason: [...new Set(parts.map(part => part.reason).filter(Boolean))].join("\n"),
    coverage: { pageStart: start, pageEnd: pageNumbers.at(-1) ?? start - 1, totalPages: first.content.coverage.totalPages,
      truncated: !complete, nextPage: null },
    retrieval: { mode: "pages", pageNumbers, characters: parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0) },
  } };
}


/** Stored page blocks are evidence; parser completion is never semantic completeness. */
async function resolveCompleteDocumentModel(d: AppDeps, projectId: string, versionId: string,
  assertActive: () => Promise<unknown>) {
  const first: any = await resolveRunSource(d, projectId, { versionId, documentModel: true }, assertActive);
  if (first?.status === "resolved" && first.source?.versionId === versionId && first.content?.evidenceKind === "environment_research") return first;
  const model: SourceDocumentModel | undefined = first?.content?.documentModel;
  if (first?.status !== "resolved" || first.source?.versionId !== versionId || model?.versionId !== versionId || !model.coverage.complete) return null;
  const pages = [...model.pages];
  let offset = model.nextOffset;
  let previousOffset = 0;
  while (offset !== null) {
    if (offset <= previousOffset) throw new Error("Saved document model pagination did not advance.");
    previousOffset = offset;
    const result: any = await resolveRunSource(d, projectId, { versionId, documentModel: true, documentOffset: offset }, assertActive);
    const next: SourceDocumentModel | undefined = result?.content?.documentModel;
    if (result?.source?.versionId !== versionId || next?.versionId !== versionId || !next.coverage.complete
      || JSON.stringify(next.coverage) !== JSON.stringify(model.coverage))
      throw new Error("Saved document model coverage changed while reading.");
    pages.push(...next.pages); offset = next.nextOffset;
  }
  const pageNumbers = pages.map(page => page.page);
  if (pages.length !== model.coverage.preparedPages || new Set(pageNumbers).size !== pages.length) return null;
  const sourceClaims = first.content.sourceClaims;
  const facts = [...(sourceClaims?.facts ?? [])];
  let excludedRejectedCount = sourceClaims?.excludedRejectedCount ?? 0;
  let claimOffset = sourceClaims?.nextOffset ?? null;
  let previousClaimOffset = 0;
  while (claimOffset !== null) {
    if (claimOffset <= previousClaimOffset) throw new Error("Saved source claim pagination did not advance.");
    previousClaimOffset = claimOffset;
    const result: any = await resolveRunSource(d, projectId, { versionId, documentModel: true,
      documentOffset: pages.length, modelOffset: claimOffset }, assertActive);
    const claims = result?.content?.sourceClaims;
    if (result?.source?.versionId !== versionId || !claims) throw new Error("Saved source claims changed while reading.");
    facts.push(...claims.facts); excludedRejectedCount += claims.excludedRejectedCount;
    claimOffset = claims.nextOffset;
  }
  const documentModel = { ...model, pages, nextOffset: null };
  // This compact readable view is for consumers of the existing evidence API.
  // Structured extraction receives the individual literal blocks below instead.
  const text = pages.map(page => `[Page ${page.page}]\n${page.blocks.map(block => block.text).join("\n")}`).join("\n");
  return { ...first, content: { status: "available", text, documentModel,
    sourceClaims: sourceClaims ? { ...sourceClaims, facts: facts.filter(row => row.fact.reviewStatus !== "rejected"),
      excludedRejectedCount, nextOffset: null } : null,
    truncated: pages.some(page => page.status !== "available"),
    coverage: { pageStart: pageNumbers[0] ?? 1, pageEnd: pageNumbers.at(-1) ?? 0,
      totalPages: model.coverage.totalPages, truncated: pages.some(page => page.status !== "available"), nextPage: null },
    retrieval: { mode: "pages", pageNumbers, characters: text.length },
    reason: "Saved deterministic document blocks. Positions are extracted-text grid coordinates, not PDF geometry. OCR remains unverified. All parsed pages does not establish a complete room inventory, room mapping, geometry, requirements or calculation inputs. Visual-only candidates remain unresolved. Saved semantic claims are separate, partial and retain their individual review status; rejected claims are excluded.",
  } };
}

/** Never copy a whole document's proof blocks into every small transport slice. */
export function sourceEvidencePackets(versionId: string, excerpt: any): any[] {
  const base = { versionId, name: excerpt.source.name, version: excerpt.source.version, mimeType: excerpt.source.mimeType };
  const model: SourceDocumentModel | undefined = excerpt.content.documentModel;
  if (!model) return [{ ...base, evidenceKind: excerpt.content.evidenceKind, textEncoding: excerpt.content.textEncoding, authority: excerpt.content.authority, text: excerpt.content.text as string, truncated: excerpt.content.truncated,
    coverage: excerpt.content.coverage, retrieval: excerpt.content.retrieval, model: excerpt.content.model, extractionNotes: excerpt.content.reason }];
  const packets: any[] = [];
  for (const page of model.pages) {
    const isGeneratedHeader = (text: string) => /^\[(?:Page \d+|Native text|OCR:.*|Standalone image|Affinity[^\]]*)\]$/.test(text);
    // Saved extraction may begin with blank lines. Only the contiguous known
    // extraction prefix is synthetic; matching labels later remain source text.
    let generatedHeaderCount = 0;
    if (page.origin !== "unknown") {
      while (generatedHeaderCount < Math.min(2, page.blocks.length)
        && isGeneratedHeader(page.blocks[generatedHeaderCount]!.text)) generatedHeaderCount++;
    }
    const blocks = page.blocks.slice(generatedHeaderCount);
    const documentPage = { parserVersion: page.parserVersion, rawTextSha256: page.rawTextSha256,
      rawTextBytes: page.rawTextBytes, origin: page.origin, status: page.status, sourceStatus: page.sourceStatus,
      positionSpace: page.positionSpace, layerAssociation: "unknown", semanticCompleteness: false,
      blockCount: page.blocks.length, packetScope: "selected_document_blocks", totalPages: model.coverage.totalPages,
      generatedHeadersOmitted: generatedHeaderCount > 0, generatedHeaderCount };
    for (const block of blocks) {
      const { text, ...documentBlock } = block;
      packets.push({ ...base, text, sourcePage: page.page, evidenceKind: "document_block", documentPage, documentBlock,
        truncated: page.status !== "available", extractionNotes: page.limitations.join(" ") });
    }
    if (!blocks.length) packets.push({ ...base, text: `No extracted text blocks on original page ${page.page}. This does not establish a blank page.`,
      sourcePage: page.page, evidenceKind: "page_notice", documentPage, truncated: true, extractionNotes: page.limitations.join(" ") });
  }
  for (const row of excerpt.content.sourceClaims?.facts ?? []) {
    if (row.fact.reviewStatus === "rejected") continue;
    const evidence = row.fact.evidence;
    packets.push({ ...base, text: evidence.kind === "text" ? evidence.quote : evidence.kind === "image" ? evidence.description : "Saved IFC declaration; see typed source fact.",
      ...(evidence.kind === "text" ? { sourcePage: evidence.page } : {}), evidenceKind: "source_fact",
      sourceFact: row, truncated: true,
      extractionNotes: "Separate saved semantic claim, not a complete inventory or parser approval. Only original text evidence can support a source-text quotation. Rejected claims are excluded; image and IFC claims do not become text quotations." });
  }
  return packets;
}


/** Compact the current slice only; literal block text never becomes JSONL evidence. */
export function compactDocumentPackets(sources: any[]): any[] {
  const result: any[] = [];
  for (const source of sources) {
    if (source.evidenceKind !== "document_block") { result.push(source); continue; }
    // Source version/page/hash identify the block; do not repeat UUIDs and
    // property names for every short plan label. Byte offset is its local ID.
    // Tuple: [original startByte, line, column, literal text, optional fragment range].
    const range = source.textRange;
    const block = [source.documentBlock.startByte, source.documentBlock.line, source.documentBlock.column, source.text,
      ...(range && (range.startByte !== 0 || range.endByte !== range.totalBytes)
        ? [[range.startByte, range.endByte, range.totalBytes]] : [])];
    const previous = result.at(-1);
    if (previous?.evidenceKind === "document_blocks" && previous.versionId === source.versionId
      && previous.sourcePage === source.sourcePage && previous.documentPage.rawTextSha256 === source.documentPage.rawTextSha256
      && previous.continuation === source.continuation) {
      previous.documentBlocks.push(block);
      previous.truncated ||= source.truncated;
    } else {
      const { documentBlock: _block, textRange: _range, ...rest } = source;
      result.push({ ...rest, text: "", evidenceKind: "document_blocks", documentBlocks: [block] });
    }
  }
  return result;
}


/** Lossless runtime layer directory; full source-model responses remain unchanged. */
export function compactDocumentLayers(layers: SourceDocumentLayers) {
  const strings: string[] = [], paths: number[][] = [];
  const stringIds = new Map<string, number>(), pathIds = new Map<string, number>();
  const stringId = (value: string) => {
    let id = stringIds.get(value);
    if (id === undefined) { id = strings.length; strings.push(value); stringIds.set(value, id); }
    return id;
  };
  const groups = layers.groups.map(group => {
    const path = group.path.map(stringId), pathKey = JSON.stringify(path);
    let pathId = pathIds.get(pathKey);
    if (pathId === undefined) { pathId = paths.length; paths.push(path); pathIds.set(pathKey, pathId); }
    return [group.id, group.name === null ? -1 : stringId(group.name), pathId,
      ["unknown", "hidden", "visible"].indexOf(group.defaultVisibility), group.order];
  });
  const { groups: _groups, ...metadata } = layers;
  return { ...metadata, manifestSha256: createHash("sha256").update(JSON.stringify(layers)).digest("hex"),
    encoding: "layer-directory-v1", groupFields: ["id", "nameStringIndex", "pathIndex", "visibilityIndex", "order"],
    nullNameIndex: -1, visibility: ["unknown", "hidden", "visible"], strings, paths, groups };
}

/** Output density tracks literal evidence, while admission separately caps full JSON. */
export function documentPacketDensityBytes(sources: any[]): number {
  return Buffer.byteLength(JSON.stringify(compactDocumentPackets(sources).map(source => {
    if (source.evidenceKind === "document_blocks") {
      const { documentBlocks, ...metadata } = source;
      return { ...metadata, text: documentBlocks.map((block: [number, number, number, string]) => block[3]).join("\n") };
    }
    return source.evidenceKind ? source : { ...source, text: source.text.replace(/[\t ]+/g, " ") };
  })));
}


/** Keep a prepared page together whenever it fits; its blocks remain distinct evidence. */
export function batchPreparedSourcePages(sources: any[], byteLimit: number,
  sizeOf: (batch: any[]) => number, includePageNumbers = false): any[][] {
  if (!sources.some(source => source.evidenceKind === "document_block"))
    return batchSectionSources(sources, byteLimit, sizeOf, includePageNumbers);
  const batches: any[][] = [];
  let pending: any[] = [];
  const flush = () => { if (pending.length) batches.push(pending); pending = []; };
  let index = 0;
  while (index < sources.length) {
    const first = sources[index]!;
    let end = index + 1;
    if (first.evidenceKind !== "document_block") {
      // Keep existing raw-page/fact packing and ordering unchanged between models.
      while (end < sources.length && sources[end]!.evidenceKind !== "document_block") end++;
      flush();
      batches.push(...batchSectionSources(sources.slice(index, end), byteLimit, sizeOf, includePageNumbers));
    } else {
      while (end < sources.length && sources[end]!.evidenceKind === "document_block"
        && sources[end]!.versionId === first.versionId && sources[end]!.sourcePage === first.sourcePage
        && sources[end]!.documentPage.rawTextSha256 === first.documentPage.rawTextSha256) end++;
      const page = sources.slice(index, end).map(source => {
        const bytes = Buffer.byteLength(source.text, "utf8");
        return { ...source, extractionTruncated: source.truncated === true,
          textRange: source.textRange ?? { startByte: 0, endByte: bytes, totalBytes: bytes },
          ...(includePageNumbers ? { packetPageNumbers: [source.sourcePage] } : {}) };
      });
      if (sizeOf(page) <= byteLimit) {
        if (pending.length && sizeOf([...pending, ...page]) > byteLimit) flush();
        pending.push(...page);
      } else {
        flush();
        // Only oversized pages use existing lossless block/UTF-8 fragmentation.
        batches.push(...batchSectionSources(sources.slice(index, end), byteLimit, sizeOf, includePageNumbers));
      }
    }
    index = end;
  }
  flush();
  return batches.length ? batches : [[]];
}
