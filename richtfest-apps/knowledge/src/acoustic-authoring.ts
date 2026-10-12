import { createHash } from "node:crypto";
import { z } from "zod";
import {
  acousticConceptOutlineSchema, acousticConceptTemplateSchema, acousticSectionKeys,
  acousticSectionOutputSchema, prepareAgentDocument, type AcousticConceptId, type AgentExecutionLimits,
} from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { resolveCompleteRunSource } from "./source-evidence";
import { batchSpecialistSources } from "./source-batches";

type Outline = z.infer<typeof acousticConceptOutlineSchema>;
type Part = z.infer<typeof acousticSectionOutputSchema>;
export type AcousticDraft = {
  inputHash: string;
  outline: Outline;
  sections: Record<string, { inputHash: string; parts: Part[] }>;
  previousReview?: unknown;
};

/** Durable section authoring: source pages/annexes never consume output tokens. */
export async function authorAcousticConcept(input: {
  d: AppDeps; projectId: string; id: AcousticConceptId; goal: string;
  findings: unknown; sourceVersionIds: string[]; limits: AgentExecutionLimits; maxOutputTokens: number;
  previousReview?: unknown; draft?: AcousticDraft;
  assertActive: () => Promise<unknown>;
  call: (context: Record<string, unknown>, validate: (output: unknown) => unknown) => Promise<unknown>;
  checkpoint: (draft: AcousticDraft, section: string, batch: number, batchCount: number) => Promise<void>;
}) {
  const { d, id, projectId, limits } = input;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // Preserve the fingerprint contract so drafts saved under the old aggregate cap resume.
  const inputHash = hash({ id, goal: input.goal, findings: input.findings, limits, maxOutputTokens: input.maxOutputTokens });
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
    }, value => outlineSchema.parse(value)));
    draft = { inputHash, outline, sections: {}, previousReview: input.previousReview };
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
  for (const key of keys) {
    await input.assertActive();
    const definition = outline.sections.find(section => section.key === key)!;
    const evidence = [];
    for (const range of definition.sources) {
      const source = await resolveCompleteRunSource(d, projectId, range, input.assertActive);
      if (source?.status !== "resolved" || source.source?.versionId !== range.versionId || source.content?.status !== "available")
        invalid(["sections"], "The selected source range has no readable evidence.");
      if (source.content.coverage && (source.content.coverage.pageEnd < range.pageEnd || source.content.coverage.truncated))
        invalid(["sections"], "The selected source page range is incomplete.");
      evidence.push({ versionId: range.versionId, name: source.source.name, version: source.source.version,
        text: String(source.content.text), coverage: source.content.coverage, retrieval: source.content.retrieval,
        extractionNotes: source.content.reason });
    }
    // Scale input pieces down for small presets; never raise cost/token settings silently.
    const batches = batchSpecialistSources(evidence, Math.max(1024, Math.min(16000, input.maxOutputTokens * 2)));
    const sectionHash = hash(batches);
    const progress = draft.sections[key]?.inputHash === sectionHash ? draft.sections[key]! : { inputHash: sectionHash, parts: [] };
    draft.sections[key] = progress;
    for (let index = progress.parts.length; index < batches.length; index++) {
      const batch = batches[index]!;
      const allowed = new Set(batch.map(source => source.versionId));
      const partSchema = acousticSectionOutputSchema.superRefine((part, ctx) => {
        if (!part.complete) ctx.addIssue({ code: "custom", path: ["complete"], message: "The section piece is incomplete; no completed report can be published." });
        const inline = part.content.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
        if (part.citations.some(v => !allowed.has(v)) || inline.some(v => !part.citations.includes(v)))
          ctx.addIssue({ code: "custom", path: ["citations"], message: "Cite only source versions supplied in this piece." });
      });
      const part = partSchema.parse(await input.call({
        documentTask: "section", documentTemplate: { id, version: 1 }, section: key,
        project: outline.project, language: outline.language, sources: batch,
        sourceVersionIds: [...allowed], batch: index + 1, batchCount: batches.length,
        attachments: outline.attachments.filter(a => a.section === key),
        previousReview: draft.previousReview,
      }, value => partSchema.parse(value)));
      progress.parts.push(part);
      // A response cap applies to each piece, not the concatenated report.
      await input.checkpoint(draft, key, index + 1, batches.length);
    }
    bodies[key] = progress.parts.map(part => part.content).join("\n\n");
    for (const part of progress.parts) for (const citation of part.citations) citations.add(citation);
  }
  const template = acousticConceptTemplateSchema.parse({ id, version: 1, language: outline.language,
    project: outline.project, attachments: outline.attachments, ...bodies });
  const document = prepareAgentDocument({ title: outline.title, content: "Rendered from template", template }, id, null)!;
  return {
    document, citations: [...citations], decision: "accept" as const, revisions: [],
    summary: outline.language === "de" ? "Konzeptentwurf mit Quellenbelegen erstellt. Fachliche Prüfung und Freigabe stehen aus."
      : "Source-backed concept draft created. Specialist review and approval remain outstanding.",
    rationale: outline.language === "de" ? "Abschnittsweise aus den angegebenen Quellseiten erstellt; keine Neuberechnung oder Freigabe."
      : "Authored section by section from the listed source pages; no new calculation or approval.",
  };
}
