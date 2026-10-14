import { createHash } from "node:crypto";
import { z } from "zod";
import {
  acousticConceptOutlineSchema, acousticConceptTemplateSchema, acousticSectionKeys,
  acousticSectionOutputSchema, prepareAgentDocument, type AcousticConceptId, type AgentExecutionLimits,
  acousticInputProvenance, type AcousticCalculationReceipt, type CompanyKnowledgeReceipt,
  acousticEditorialOutputSchema, acousticEditorialCheckSchema, renderAcousticCalculationReceipts,
} from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { sanitizeProviderDiagnostics } from "./deps";
import { resolveCompleteRunSource } from "./source-evidence";
import { batchSectionSources, batchSpecialistSources } from "./source-batches";

type Outline = z.infer<typeof acousticConceptOutlineSchema>;
type Part = z.infer<typeof acousticSectionOutputSchema>;
export type AcousticDraft = {
  inputHash: string;
  outline: Outline;
  inputByteBudget?: number;
  sections: Record<string, { inputHash: string; parts: (Part | null)[]; byteLimit?: number; fallbacks?: Record<number, Part[]>;
    fallbackByteLimits?: Record<number, number>; inputMode?: "specialist-findings" }>;
  previousReview?: unknown;
  editorial?: {
    inputHash: string;
    candidate?: z.infer<typeof acousticEditorialOutputSchema>;
    check?: z.infer<typeof acousticEditorialCheckSchema>;
    feedback?: z.infer<typeof acousticEditorialCheckSchema>;
    packets?: Record<string, {
      inputHash: string;
      candidate?: z.infer<typeof acousticEditorialOutputSchema>;
      check?: z.infer<typeof acousticEditorialCheckSchema>;
      feedback?: z.infer<typeof acousticEditorialCheckSchema>;
    }>;
  };
};

/** Durable section authoring: source pages/annexes never consume output tokens. */
export async function authorAcousticConcept(input: {
  d: AppDeps; projectId: string; id: AcousticConceptId; goal: string;
  findings: unknown; sourceVersionIds: string[]; limits: AgentExecutionLimits; maxOutputTokens: number;
  calculationReceipts?: AcousticCalculationReceipt[];
  companyKnowledge?: CompanyKnowledgeReceipt[];
  maxParallel: number;
  inputByteBudget?: number; contextOverhead?: unknown;
  previousReview?: unknown; draft?: AcousticDraft;
  assertActive: () => Promise<unknown>;
  call: (context: Record<string, unknown>, validate: (output: unknown) => unknown) => Promise<unknown>;
  checkpoint: (draft: AcousticDraft, section: string, batch: number, batchCount: number) => Promise<void>;
}) {
  const { d, id, projectId, limits } = input;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // Preserve the fingerprint contract so drafts saved under the old aggregate cap resume.
  const inputHash = hash({ id, goal: input.goal, findings: input.findings, limits, maxOutputTokens: input.maxOutputTokens,
    ...(input.calculationReceipts?.length ? { calculationReceipts: input.calculationReceipts } : {}),
    ...(input.companyKnowledge?.length ? { companyKnowledge: input.companyKnowledge } : {}),
  });
  const sourceIds = new Set(input.sourceVersionIds);
  const savedFindings = z.array(z.object({
    sourceVersionIds: z.array(z.string()),
    output: z.object({ summary: z.string().optional(), rationale: z.string().optional(),
      citations: z.array(z.string()).optional() }).passthrough(),
  }).passthrough()).safeParse(input.findings);
  const findings = savedFindings.success ? savedFindings.data.filter(f =>
    f.output.summary?.trim() || f.output.rationale?.trim()) : [];
  const findingSourceIds = [...new Set(findings.flatMap(f => (f.output.citations ?? [])
    .filter(v => sourceIds.has(v) && f.sourceVersionIds.includes(v))))];
  const keys = acousticSectionKeys(id);
  const invalid = (path: (string | number)[], message: string): never => {
    throw new z.ZodError([{ code: "custom", path, message }]);
  };
  const outlineSchema = acousticConceptOutlineSchema.extend({ id: z.literal(id) }).superRefine((outline, ctx) => {
    if (outline.sections.length !== keys.length || keys.some(key => outline.sections.filter(s => s.key === key).length !== 1))
      ctx.addIssue({ code: "custom", path: ["sections"], message: "Include every required section exactly once." });
    for (const range of [...outline.sections.flatMap(s => s.sources), ...outline.attachments]) {
      if (!sourceIds.has(range.versionId) || range.pageEnd < range.pageStart)
        ctx.addIssue({ code: "custom", path: ["sections"], message: "Use only assigned readable source versions and valid original page ranges." });
    }
  });
  let draft = input.draft?.inputHash === inputHash ? input.draft : undefined;
  if (!draft) {
    const outline = outlineSchema.parse(await input.call({
      documentTask: "outline", documentTemplate: { id, version: 1 }, sectionKeys: keys,
      findings: input.findings, sourceVersionIds: input.sourceVersionIds, previousReview: input.previousReview,
      ...(input.calculationReceipts?.length ? { calculationReceipts: input.calculationReceipts } : {}),
      ...(input.companyKnowledge?.length ? { companyKnowledge: input.companyKnowledge } : {}),
    }, value => outlineSchema.parse(value)));
    // Normalize new outlines only: old drafts retain their batch identities on retry.
    for (const section of outline.sections) {
      const ranges: typeof section.sources = [];
      for (const versionId of new Set(section.sources.map(range => range.versionId))) {
        for (const range of section.sources.filter(range => range.versionId === versionId).sort((a, b) => a.pageStart - b.pageStart)) {
          const previous = ranges.at(-1);
          if (previous?.versionId === versionId && range.pageStart <= previous.pageEnd + 1)
            previous.pageEnd = Math.max(previous.pageEnd, range.pageEnd);
          else ranges.push({ ...range });
        }
      }
      section.sources = ranges;
    }
    draft = { inputHash, outline, sections: {}, previousReview: input.previousReview, inputByteBudget: input.inputByteBudget };
    await input.checkpoint(draft, "outline", 1, 1);
  }
  const { outline } = draft;
  // Fail before publication if the proposed plan/annex cannot actually be attached.
  const pdfCounts = new Map<string, number>();
  for (const attachment of outline.attachments) {
    if (!pdfCounts.has(attachment.versionId)) {
      const bytes = await d.readSourcePdf?.(projectId, attachment.versionId);
      if (!bytes) invalid(["attachments"], "The selected source PDF is unavailable.");
      const { PDFDocument } = await import("pdf-lib");
      try { pdfCounts.set(attachment.versionId, (await PDFDocument.load(bytes!)).getPageCount()); }
      catch { invalid(["attachments"], "The selected source PDF cannot be read."); }
    }
    if (attachment.pageEnd > pdfCounts.get(attachment.versionId)!) invalid(["attachments"], "The selected source page range is unavailable.");
  }
  const bodies: Record<string, string> = {};
  const citations = new Set(outline.attachments.map(a => a.versionId));
  const resolvedRanges = new Map<string, Awaited<ReturnType<typeof resolveCompleteRunSource>>>();
  const jobs: (() => Promise<void>)[] = [];
  let stopped = false;
  let failure: unknown;
  let checkpoint = Promise.resolve();
  const save = (key: string, batchCount: number, update: () => void) => {
    checkpoint = checkpoint.then(async () => {
      update();
      // A checkpoint owns its snapshot, even while other sections are prepared.
      await input.checkpoint(structuredClone(draft!), key, draft!.sections[key]!.parts.filter(Boolean).length, batchCount);
    });
    return checkpoint;
  };
  for (const key of keys) {
    await input.assertActive();
    const definition = outline.sections.find(section => section.key === key)!;
    const saved = draft.sections[key];
    // Never reinterpret a legacy piece (including an interrupted fallback).
    // Empty sections can switch without changing the overall draft fingerprint.
    const useFindings = key === "openIssues" && findings.length > 0
      && (saved?.inputMode === "specialist-findings"
        || (!saved?.parts.some(Boolean) && !Object.values(saved?.fallbacks ?? {}).some(parts => parts.length)));
    const evidence = [];
    for (const range of useFindings ? [] : definition.sources) {
      const rangeKey = `${range.versionId}:${range.pageStart}:${range.pageEnd}`;
      const source = resolvedRanges.get(rangeKey) ?? await resolveCompleteRunSource(d, projectId, range, input.assertActive);
      if (source?.status !== "resolved" || source.source?.versionId !== range.versionId || source.content?.status !== "available")
        invalid(["sections"], "The selected source range has no readable evidence.");
      if (source.content.coverage && (source.content.coverage.pageEnd < range.pageEnd || source.content.coverage.truncated))
        invalid(["sections"], "The selected source page range is incomplete.");
      resolvedRanges.set(rangeKey, source);
      evidence.push({ versionId: range.versionId, name: source.source.name, version: source.source.version,
        text: String(source.content.text), coverage: source.content.coverage, retrieval: source.content.retrieval,
        extractionNotes: source.content.reason });
    }
    // Keep new arithmetic together in the appendix, separate from source claims.
    const calculationReceipts = key === "calculationAppendix" ? input.calculationReceipts ?? [] : [];
    const appendix = key === "calculationAppendix";
    // Keep the original context for legacy root-batch identity. Actual appendix
    // calls below receive only imported evidence; arithmetic is rendered in code.
    const sectionContext = {
      documentTask: "section", documentTemplate: { id, version: 1 }, section: key,
      project: outline.project, language: outline.language,
      attachments: outline.attachments.filter(a => a.section === key), previousReview: draft.previousReview,
      ...(useFindings ? { findings, inputMode: "specialist-findings",
        evidenceInstructions: "Draft open issues from saved specialist findings, not a fresh source review. Retain unresolved limitations, missing inputs and required specialist verification explicitly. Findings are attributed reports, not verified project facts. Only supplied citations also listed in sourceVersionIds may be cited; company references and calculation receipt IDs are not project sources." } : {}),
      ...(calculationReceipts.length ? { calculationReceipts } : {}),
      ...(input.companyKnowledge?.length ? { companyKnowledge: input.companyKnowledge } : {}),
    };
    // Reserve instructions/schema space plus the actual variable context. A byte
    // budget is conservative, not an assumed four-characters-per-token ratio.
    const byteLimit = draft.inputByteBudget === undefined ? undefined : (useFindings && saved?.inputMode !== "specialist-findings" ? undefined : saved?.byteLimit)
      ?? draft.inputByteBudget - 16384 - Buffer.byteLength(JSON.stringify({ goal: input.goal,
        contextOverhead: input.contextOverhead, ...sectionContext, sourceVersionIds: useFindings ? findingSourceIds : definition.sources.map(range => range.versionId),
        batch: 1000000, batchCount: 1000000, splitOnTruncation: true }), "utf8");
    if (byteLimit !== undefined && byteLimit < 1024) invalid(["sections"], "Report context exceeds the model input budget.");
    // Historical/unknown-model drafts keep their exact batching and retry contract.
    const legacyLimit = Math.max(1024, Math.min(16000, input.maxOutputTokens * 2));
    const batches = byteLimit === undefined ? batchSpecialistSources(evidence, legacyLimit) : batchSectionSources(evidence, byteLimit);
    const sectionHash = useFindings ? hash({ inputMode: "specialist-findings", findings, sourceVersionIds: findingSourceIds }) : hash(batches);
    const progress: AcousticDraft["sections"][string] = draft.sections[key]?.inputHash === sectionHash
      ? draft.sections[key]! : { inputHash: sectionHash, parts: [], byteLimit,
        ...(useFindings ? { inputMode: "specialist-findings" as const } : {}) };
    draft.sections[key] = progress;
    const savePiece = (update: () => void) => save(key, batches.length, update);
    const requestPart = async (batch: typeof batches[number], batchNumber: number, batchCount: number, splitOnTruncation: boolean, parentBatch?: number) => {
      await input.assertActive();
      if (stopped) throw new Error("Section drafting stopped after a sibling failure.");
      const allowed = new Set([...batch.map(source => source.versionId),
        ...(useFindings ? findingSourceIds : [])]);
      const partSchema = acousticSectionOutputSchema.superRefine((part, ctx) => {
        if (!part.complete && !splitOnTruncation) ctx.addIssue({ code: "custom", path: ["complete"], message: "The section piece is incomplete; no completed report can be published." });
        const inline = part.content.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
        const rejectedCitations = [...new Set([...part.citations, ...inline].filter(v => !allowed.has(v)))];
        if (rejectedCitations.length) throw Object.assign(new Error("Section cited evidence outside this piece."), {
          providerFailure: true, retryable: true, failureCategory: "validation",
          diagnostics: sanitizeProviderDiagnostics({ errorId: "SOURCE_CITATION_OUT_OF_SCOPE", rejectedCitations }),
        });
        // Repair only the reference register, never prose or identifiers. Every
        // added reference already appears in the text AND this piece's evidence.
        part.citations = [...new Set([...part.citations, ...inline])];
      });
      const { calculationReceipts: _receipts, companyKnowledge: _knowledge, ...appendixContext } = sectionContext;
      return partSchema.parse(await input.call({
        ...(appendix ? { ...appendixContext, inputMode: "imported-calculation-evidence",
          attachments: sectionContext.attachments.filter(a => allowed.has(a.versionId)) } : sectionContext),
        sources: batch, sourceVersionIds: [...allowed], batch: batchNumber, batchCount,
        ...(byteLimit === undefined ? {} : { splitOnTruncation, parentBatch }),
      }, value => partSchema.parse(value)));
    };
    const writePiece = async (index: number) => {
      const batch = batches[index]!;
      let part: Part | undefined;
      if (appendix && !batch.length) {
        // A source-free appendix needs no inference, even when receipts exist.
        part = { content: outline.language === "de"
          ? "Keine importierten Berechnungsnachweise für diesen Abschnitt ausgewählt. Dies belegt nicht, dass das Projekt keine weiteren Nachweise enthält."
          : "No imported calculation evidence selected for this section. This does not establish that the project contains no other calculation evidence.",
        citations: [], complete: true };
      }
      // Context capacity is not a sensible spending target for an inventory.
      // Split only missing roots, keeping later saved pieces and legacy fallbacks.
      const appendixBytes = Math.min(byteLimit ?? 128 * 1024, 128 * 1024);
      if (appendix && !progress.fallbacks?.[index] && Buffer.byteLength(JSON.stringify(batch), "utf8") > appendixBytes) {
        await savePiece(() => {
          (progress.fallbacks ??= {})[index] = [];
          (progress.fallbackByteLimits ??= {})[index] = appendixBytes;
        });
      }
      if (!part && !progress.fallbacks?.[index]) {
        try { part = await requestPart(batch, index + 1, batches.length, byteLimit !== undefined); }
        catch (error) {
          const metadata = error as { failureCategory?: string; diagnostics?: unknown };
          const diagnostics = sanitizeProviderDiagnostics(metadata?.diagnostics);
          if (byteLimit === undefined || metadata?.failureCategory !== "validation"
            || (diagnostics.finishReason !== "length" && diagnostics.errorId !== "STRUCTURED_OUTPUT_TRUNCATED")) throw error;
        }
      }
      if (!part?.complete) {
        const fallbackBytes = progress.fallbackByteLimits?.[index];
        const smaller = fallbackBytes === undefined
          ? batchSpecialistSources(batch.map(source => ({ ...source, truncated: source.extractionTruncated })), legacyLimit)
          : batchSectionSources(batch.map(source => ({ ...source, truncated: source.extractionTruncated })), fallbackBytes);
        if (smaller.length < 2) invalid(["complete"], "The section piece is incomplete within its configured output budget.");
        if (!progress.fallbacks?.[index]) await savePiece(() => { (progress.fallbacks ??= {})[index] = []; });
        const parts = progress.fallbacks![index]!;
        // Keep successful fallback pieces across cancellation/restart. Each root
        // worker owns its fallback sequence, preserving the shared parallel cap.
        for (let i = parts.length; i < smaller.length; i++) {
          if (stopped) throw new Error("Section drafting stopped after a sibling failure.");
          const completed = await requestPart(smaller[i]!, i + 1, smaller.length, false, index + 1);
          await savePiece(() => { parts.push(completed); });
        }
        part = { content: parts.map(piece => piece.content).join("\n\n"), citations: [...new Set(parts.flatMap(piece => piece.citations))], complete: true };
      }
      // Serialize draft mutations and writes, but not provider calls. JSON nulls
      // preserve holes when later pieces finish first; old prefix arrays still work.
      await savePiece(() => { progress.parts[index] = part!; });
    };
    for (let index = 0; index < batches.length; index++) {
      if (!progress.parts[index]) jobs.push(() => writePiece(index));
    }
  }
  // Root pieces across every section share one worker pool. A fallback stays
  // in its root's slot, so retries cannot exceed the same provider-call cap.
  let nextIndex = 0;
  await Promise.allSettled(Array.from({ length: Math.min(input.maxParallel, jobs.length) }, async () => {
      try {
        while (!stopped && nextIndex < jobs.length) {
          const index = nextIndex++;
          await input.assertActive();
          if (!stopped) await jobs[index]!();
        }
      } catch (error) {
        if (!stopped) failure = error;
        stopped = true;
        throw error;
      }
  }));
  // Drain in-flight siblings before releasing the lease or failing the run.
  if (stopped) throw failure;
  for (const key of keys) {
    const progress = draft.sections[key]!;
    bodies[key] = progress.parts.map(part => part!.content).join("\n\n");
    for (const part of progress.parts) for (const citation of part!.citations) citations.add(citation);
  }
  if (input.calculationReceipts?.length) {
    for (const receipt of input.calculationReceipts) for (const p of acousticInputProvenance(receipt.input)) {
      if (p.kind !== "source") continue;
      if (!sourceIds.has(p.versionId)) invalid(["calculationReceipts"], "Calculation input cites a source outside this report.");
      citations.add(p.versionId);
    }
    bodies.calculationAppendix += `\n\n${renderAcousticCalculationReceipts(input.calculationReceipts, outline.language)}`;
  }
  const template = acousticConceptTemplateSchema.parse({ id, version: 1, language: outline.language,
    project: outline.project, attachments: outline.attachments, ...bodies });
  // Validate the source draft before editing; an editor must not conceal invalid
  // section output. Keep the original pieces unchanged for review and recovery.
  prepareAgentDocument({ title: outline.title, content: "Rendered from template", template }, id, null);
  const editableKeys = keys.filter(key => key !== "calculationAppendix");
  const editorialContext = {
    documentTemplate: { id, version: 1 }, sectionKeys: editableKeys, original: template,
    previousReview: draft.previousReview,
    ...(input.companyKnowledge?.length ? { companyKnowledge: input.companyKnowledge } : {}),
  };
  const editorialHash = hash(editorialContext);
  if (draft.editorial?.inputHash !== editorialHash) draft.editorial = { inputHash: editorialHash };
  const editorial = draft.editorial;
  // The hash keeps its historical contract; immutable appendix prose is not
  // needed in an editing request. Existing paid candidates remain reusable.
  const { calculationAppendix: _appendix, ...editableOriginal } = template;
  const requestContext = { ...editorialContext, original: editableOriginal };
  // A rejected edit is never published. An explicit retry may regenerate it
  // with feedback, while a timeout during checking reuses the saved candidate.
  if (editorial.check && (!editorial.check.preserved || editorial.check.issues.length)) {
    editorial.feedback = editorial.check;
    delete editorial.candidate;
    delete editorial.check;
  }
  const inlineIds = (value: unknown) => new Set(JSON.stringify(value).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []);
  const originalReferences = inlineIds(template);
  const editSchema = acousticEditorialOutputSchema.superRefine((edit, ctx) => {
    if (!edit.complete) ctx.addIssue({ code: "custom", path: ["complete"], message: "The editorial pass is incomplete; no report can be published." });
    if (edit.sections.length !== editableKeys.length || editableKeys.some(key => edit.sections.filter(s => s.key === key).length !== 1))
      ctx.addIssue({ code: "custom", path: ["sections"], message: "Edit every requested section exactly once; the calculation appendix is immutable." });
    const edited = { ...template, ...Object.fromEntries(edit.sections.map(s => [s.key, s.content])) };
    const references = inlineIds(edited);
    if ([...originalReferences].some(ref => !references.has(ref)) || [...references].some(ref => !originalReferences.has(ref) && !citations.has(ref)))
      ctx.addIssue({ code: "custom", path: ["sections"], message: "Preserve source references without introducing unknown identifiers." });
    prepareAgentDocument({ title: outline.title, content: "Rendered from template", template: edited }, id, null);
  });
  if (editorial.packets || (!editorial.candidate && Buffer.byteLength(JSON.stringify(requestContext)) > 16 * 1024)) {
    editorial.packets ??= {};
    const sections: z.infer<typeof acousticEditorialOutputSchema>["sections"] = [];
    for (const key of editableKeys) {
      // Split only between Markdown blocks, never through a table or paragraph.
      // An indivisible oversized block is retained verbatim, not summarized.
      const blocks = bodies[key]!.split(/(\n{2,})/);
      const packets: string[] = [];
      let packet = "";
      for (let i = 0; i < blocks.length; i += 2) {
        const block = blocks[i]! + (blocks[i + 1] ?? "");
        if (packet && Buffer.byteLength(packet + block) > 16 * 1024) { packets.push(packet); packet = ""; }
        packet += block;
      }
      if (packet) packets.push(packet);
      const contents: string[] = [];
      for (const [index, original] of packets.entries()) {
        await input.assertActive();
        if (Buffer.byteLength(original) > 16 * 1024) { contents.push(original); continue; }
        const context = { documentTemplate: { id, version: 1 }, documentTask: "editorial",
          inputMode: "editorial-packet", sectionKeys: [key], sectionDirectory: editableKeys,
          original: { id, version: 1, language: outline.language, project: outline.project, [key]: original },
          batch: index + 1, batchCount: packets.length };
        const packetHash = hash(context), packetKey = `${key}:${index}`;
        let saved = editorial.packets[packetKey];
        if (saved?.inputHash !== packetHash) saved = editorial.packets[packetKey] = { inputHash: packetHash };
        if (saved.check && (!saved.check.preserved || saved.check.issues.length)) {
          saved.feedback = saved.check;
          delete saved.candidate;
          delete saved.check;
        }
        const references = inlineIds(original);
        const packetSchema = acousticEditorialOutputSchema.superRefine((edit, ctx) => {
          if (!edit.complete || edit.sections.length !== 1 || edit.sections[0]?.key !== key)
            ctx.addIssue({ code: "custom", path: ["sections"], message: "Return the complete requested editorial packet only." });
          const next = inlineIds(edit);
          if ([...references].some(ref => !next.has(ref)) || [...next].some(ref => !references.has(ref)))
            ctx.addIssue({ code: "custom", path: ["sections"], message: "Preserve this packet's source references without adding identifiers." });
          // Validate Markdown/template constraints before paying for a checker.
          prepareAgentDocument({ title: outline.title, content: "Rendered from template", template: {
            ...template, ...Object.fromEntries(edit.sections.map(s => [s.key, s.content])),
          } }, id, null);
        });
        if (!saved.candidate) {
          await input.checkpoint(draft, "editing_document", index, packets.length);
          saved.candidate = packetSchema.parse(await input.call({ ...context, feedback: saved.feedback }, value => packetSchema.parse(value)));
          await input.assertActive();
          await input.checkpoint(draft, "editing_document", index + 1, packets.length);
        }
        const candidate = packetSchema.parse(saved.candidate);
        if (!saved.check) {
          saved.check = acousticEditorialCheckSchema.parse(await input.call({ ...context, documentTask: "editorial_check",
            edited: { ...context.original, [key]: candidate.sections[0]!.content },
          }, value => acousticEditorialCheckSchema.parse(value)));
          await input.assertActive();
          await input.checkpoint(draft, "checking_editorial", index + 1, packets.length);
        }
        if (!saved.check.preserved || saved.check.issues.length)
          invalid(["editorial"], "An editorial packet changed or omitted evidence. Retry to revise only the rejected packet using its saved feedback.");
        contents.push(candidate.sections[0]!.content);
      }
      sections.push({ key, content: contents.join("\n\n") });
    }
    editorial.candidate = editSchema.parse({ sections, complete: true });
    // Every changed packet passed its own fresh semantic comparison. Verbatim
    // blocks and immutable fields are copied by code, not approved by a model.
    editorial.check = { preserved: true, issues: [] };
    await input.checkpoint(draft, "checking_editorial", 1, 1);
  }
  await input.assertActive();
  if (!editorial.candidate) {
    await input.checkpoint(draft, "editing_document", 0, 0);
    editorial.candidate = editSchema.parse(await input.call({
      ...requestContext, documentTask: "editorial", feedback: editorial.feedback,
    }, value => editSchema.parse(value)));
    await input.checkpoint(draft, "editing_document", 0, 0);
  }
  const candidate = editSchema.parse(editorial.candidate);
  const edited = acousticConceptTemplateSchema.parse({ ...template, ...Object.fromEntries(candidate.sections.map(s => [s.key, s.content])) });
  await input.assertActive();
  if (!editorial.check) {
    await input.checkpoint(draft, "checking_editorial", 0, 0);
    // Separate, fresh model call. A negative verdict is valid output, not a
    // schema error to retry until the reviewer happens to return approval.
    const { calculationAppendix: _unchanged, ...editableResult } = edited;
    editorial.check = acousticEditorialCheckSchema.parse(await input.call({
      ...requestContext, documentTask: "editorial_check", edited: editableResult,
    }, value => acousticEditorialCheckSchema.parse(value)));
    await input.checkpoint(draft, "checking_editorial", 0, 0);
  }
  if (!editorial.check.preserved || editorial.check.issues.length)
    invalid(["editorial"], "The editorial preservation check found changed or missing evidence. Retry to revise the edit using the saved feedback.");
  await input.assertActive();
  const document = prepareAgentDocument({ title: outline.title, content: "Rendered from template", template: edited }, id, null)!;
  return {
    document, citations: [...citations], decision: "accept" as const, revisions: [],
    summary: outline.language === "de" ? "Konzeptentwurf mit Quellenbelegen erstellt. Fachliche Prüfung und Freigabe stehen aus."
      : "Source-backed concept draft created. Specialist review and approval remain outstanding.",
    rationale: outline.language === "de" ? "Abschnittsweise aus Quellen und gegebenenfalls gespeicherten Rechenprotokollen erstellt; kein normativer Nachweis oder Freigabe."
      : "Authored section by section from source pages and any saved calculation receipts; no normative verification or approval.",
  };
}
