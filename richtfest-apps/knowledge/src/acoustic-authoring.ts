import { createHash } from "node:crypto";
import { z } from "zod";
import {
  acousticConceptOutlineSchema, acousticConceptTemplateSchema, acousticSectionKeys,
  acousticSectionOutputSchema, prepareAgentDocument, type AcousticConceptId, type AgentExecutionLimits,
  acousticInputProvenance, type AcousticCalculationReceipt, type CompanyKnowledgeReceipt,
  acousticEditorialOutputSchema, acousticEditorialCheckSchema,
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
  sections: Record<string, { inputHash: string; parts: (Part | null)[]; byteLimit?: number; fallbacks?: Record<number, Part[]> }>;
  previousReview?: unknown;
  editorial?: {
    inputHash: string;
    candidate?: z.infer<typeof acousticEditorialOutputSchema>;
    check?: z.infer<typeof acousticEditorialCheckSchema>;
    feedback?: z.infer<typeof acousticEditorialCheckSchema>;
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
  for (const key of keys) {
    await input.assertActive();
    const definition = outline.sections.find(section => section.key === key)!;
    const evidence = [];
    for (const range of definition.sources) {
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
    const calculationSourceIds = calculationReceipts.flatMap(receipt =>
      acousticInputProvenance(receipt.input).flatMap(p => p.kind === "source" && sourceIds.has(p.versionId) ? [p.versionId] : []),
    );
    const sectionContext = {
      documentTask: "section", documentTemplate: { id, version: 1 }, section: key,
      project: outline.project, language: outline.language,
      attachments: outline.attachments.filter(a => a.section === key), previousReview: draft.previousReview,
      ...(calculationReceipts.length ? { calculationReceipts } : {}),
      ...(input.companyKnowledge?.length ? { companyKnowledge: input.companyKnowledge } : {}),
    };
    // Reserve instructions/schema space plus the actual variable context. A byte
    // budget is conservative, not an assumed four-characters-per-token ratio.
    const byteLimit = draft.inputByteBudget === undefined ? undefined : draft.sections[key]?.byteLimit
      ?? draft.inputByteBudget - 16384 - Buffer.byteLength(JSON.stringify({ goal: input.goal,
        contextOverhead: input.contextOverhead, ...sectionContext, sourceVersionIds: definition.sources.map(range => range.versionId),
        batch: 1000000, batchCount: 1000000, splitOnTruncation: true }), "utf8");
    if (byteLimit !== undefined && byteLimit < 1024) invalid(["sections"], "Report context exceeds the model input budget.");
    // Historical/unknown-model drafts keep their exact batching and retry contract.
    const legacyLimit = Math.max(1024, Math.min(16000, input.maxOutputTokens * 2));
    const batches = byteLimit === undefined ? batchSpecialistSources(evidence, legacyLimit) : batchSectionSources(evidence, byteLimit);
    const sectionHash = hash(batches);
    const progress: AcousticDraft["sections"][string] = draft.sections[key]?.inputHash === sectionHash
      ? draft.sections[key]! : { inputHash: sectionHash, parts: [], byteLimit };
    draft.sections[key] = progress;
    let nextIndex = 0;
    let stopped = false;
    let failure: unknown;
    let checkpoint = Promise.resolve();
    const save = (update: () => void) => {
      checkpoint = checkpoint.then(async () => {
        update();
        await input.checkpoint(draft, key, progress.parts.filter(Boolean).length, batches.length);
      });
      return checkpoint;
    };
    const requestPart = async (batch: typeof batches[number], batchNumber: number, batchCount: number, splitOnTruncation: boolean, parentBatch?: number) => {
      const allowed = new Set([...batch.map(source => source.versionId), ...calculationSourceIds]);
      const partSchema = acousticSectionOutputSchema.superRefine((part, ctx) => {
        if (!part.complete && !splitOnTruncation) ctx.addIssue({ code: "custom", path: ["complete"], message: "The section piece is incomplete; no completed report can be published." });
        const inline = part.content.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
        if (part.citations.some(v => !allowed.has(v)) || inline.some(v => !part.citations.includes(v)))
          ctx.addIssue({ code: "custom", path: ["citations"], message: "Cite only source versions supplied in this piece." });
      });
      return partSchema.parse(await input.call({
        ...sectionContext, sources: batch, sourceVersionIds: [...allowed], batch: batchNumber, batchCount,
        ...(byteLimit === undefined ? {} : { splitOnTruncation, parentBatch }),
      }, value => partSchema.parse(value)));
    };
    const writePiece = async (index: number) => {
      const batch = batches[index]!;
      let part: Part | undefined;
      if (!progress.fallbacks?.[index]) {
        try { part = await requestPart(batch, index + 1, batches.length, byteLimit !== undefined); }
        catch (error) {
          const metadata = error as { failureCategory?: string; diagnostics?: unknown };
          const diagnostics = sanitizeProviderDiagnostics(metadata?.diagnostics);
          if (byteLimit === undefined || metadata?.failureCategory !== "validation"
            || (diagnostics.finishReason !== "length" && diagnostics.errorId !== "STRUCTURED_OUTPUT_TRUNCATED")) throw error;
        }
      }
      if (!part?.complete) {
        const smaller = batchSpecialistSources(batch.map(source => ({ ...source, truncated: source.extractionTruncated })), legacyLimit);
        if (smaller.length < 2) invalid(["complete"], "The section piece is incomplete within its configured output budget.");
        if (!progress.fallbacks?.[index]) await save(() => { (progress.fallbacks ??= {})[index] = []; });
        const parts = progress.fallbacks![index]!;
        // Keep successful fallback pieces across cancellation/restart. Each root
        // worker owns its fallback sequence, preserving the shared parallel cap.
        for (let i = parts.length; i < smaller.length; i++) {
          if (stopped) throw new Error("Section drafting stopped after a sibling failure.");
          const completed = await requestPart(smaller[i]!, i + 1, smaller.length, false, index + 1);
          await save(() => { parts.push(completed); });
        }
        part = { content: parts.map(piece => piece.content).join("\n\n"), citations: [...new Set(parts.flatMap(piece => piece.citations))], complete: true };
      }
      // Serialize draft mutations and writes, but not provider calls. JSON nulls
      // preserve holes when later pieces finish first; old prefix arrays still work.
      await save(() => { progress.parts[index] = part!; });
    };
    await Promise.allSettled(Array.from({ length: Math.min(input.maxParallel, batches.length) }, async () => {
      try {
        while (!stopped && nextIndex < batches.length) {
          const index = nextIndex++;
          if (!progress.parts[index]) await writePiece(index);
        }
      } catch (error) {
        if (!stopped) failure = error;
        stopped = true;
        throw error;
      }
    }));
    // Drain in-flight siblings before releasing the lease or failing the run.
    if (stopped) throw failure;
    bodies[key] = progress.parts.map(part => part!.content).join("\n\n");
    for (const part of progress.parts) for (const citation of part!.citations) citations.add(citation);
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
  await input.assertActive();
  if (!editorial.candidate) {
    await input.checkpoint(draft, "editing_document", 0, 0);
    editorial.candidate = editSchema.parse(await input.call({
      ...editorialContext, documentTask: "editorial", feedback: editorial.feedback,
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
    editorial.check = acousticEditorialCheckSchema.parse(await input.call({
      ...editorialContext, documentTask: "editorial_check", edited,
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
