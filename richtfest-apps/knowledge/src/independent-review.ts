import { batchSectionSources } from "./source-batches";
import type { Assignment } from "./supervisor";

type ReviewSource = { versionId: string; resolution: any };
type Review = { summary?: string; rationale?: string; citations?: string[];
  document?: { title: string; content: string; template?: unknown } | null };

/** Transport/page chunks are not model tasks. Pack the actual review payload. */
export function prepareIndependentReview(input: {
  review: Review; sources: ReviewSource[]; assignments: Assignment[]; originalGoal: string;
  revision: number; assignedVersionCount: number; unreadableSources: unknown[];
  readableSourceIds: string[]; inputByteBudget?: number; contextOverhead: unknown;
  sourcePageScope?: { versionId: string; pages: number[] }[];
}) {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const document = input.review.document;
  // The template contains the same prose as content. Only retain its attachment
  // manifest; the original full template remains untouched in the saved artifact.
  const template = document?.template as { attachments?: unknown[] } | undefined;
  const fullReview = { summary: input.review.summary, rationale: input.review.rationale,
    citations: input.review.citations,
    ...(document ? { document: { title: document.title, content: document.content,
      ...(template?.attachments ? { attachments: template.attachments } : {}) } } : {}),
  };
  const sections = document?.content.split(/(?=^## )/m) ?? [];
  const sourceIds = input.readableSourceIds;
  const references = sections.map(section => new Set(section.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)
    ?.map(id => id.toLowerCase()).filter(id => sourceIds.includes(id))));
  const context = (sources: ReviewSource[], wholeReport: boolean, slice: number, sliceCount: number) => {
    const ids = new Set(sources.map(source => source.versionId));
    // Uncited evidence still needs a report to check for omissions. A final whole-
    // report pass reconciles cross-source findings when evidence needs >1 call.
    const allSections = wholeReport || !references.some(refs => [...refs].some(id => ids.has(id)));
    const sectionDirectory = sections.map((section, index) => ({
      id: `section:${index}`,
      heading: section.match(/^## (.+)$/m)?.[1] ?? null,
      contentSupplied: allSections || references[index]!.size === 0
        || [...references[index]!].some(id => ids.has(id)),
    }));
    const content = allSections ? document?.content
      : sections.filter((_section, index) => sectionDirectory[index]!.contentSupplied).join("");
    const assignments = input.assignments.filter(assignment => wholeReport || !assignment.sourceVersionIds.length
      || assignment.sourceVersionIds.some(id => ids.has(id)));
    return {
      role: "independent_reviewer", originalGoal: input.originalGoal, revision: input.revision,
      reviewTask: wholeReport ? "complete" : "evidence",
      // Structure only: an omitted section exists but its claims are not evidence
      // in this slice. IDs are positional, so repeated headings stay distinct.
      reportCoverage: { scope: allSections ? "whole_report" : "selected_sections", sectionDirectory },
      companyKnowledge: assignments.flatMap(assignment => assignment.companyKnowledge ?? []),
      assignments: assignments.map(assignment => ({
        taskId: assignment.taskId, role: assignment.role, goal: assignment.goal,
        calculationReceipts: assignment.calculationReceipts,
        visualReads: assignment.visualReads?.filter(read => wholeReport || ids.has(read.request.versionId)),
        sourceVersionIds: assignment.sourceVersionIds.filter(id => ids.has(id)),
        result: assignment.output ? { ...assignment.output, citations: assignment.output.citations.filter(id => ids.has(id)) } : undefined,
      })),
      firstPassReview: { ...fullReview, citations: input.review.citations?.filter(id => ids.has(id)),
        ...(fullReview.document ? { document: { ...fullReview.document, content } } : {}) },
      sourceExcerpts: sources,
      sourceCoverage: { slice, sliceCount, assignedVersionCount: input.assignedVersionCount,
        readableVersionCount: sourceIds.length, sliceVersionIds: [...ids], unreadableSources: input.unreadableSources,
        ...(input.sourcePageScope ? { completeDocumentCoverage: false, sourcePageScope: input.sourcePageScope,
          note: "Only explicitly requested original pages were evaluated; omitted pages were not evaluated and their absence is not established." } : {}) },
    };
  };
  const empty = context([], true, 1000000, 1000000);
  // Unknown models keep a conservative evidence allowance, but no arbitrary file
  // count. Known models budget the entire request, not just the new source text.
  const byteBudget = input.inputByteBudget === undefined ? bytes(empty) + 48 * 1024
    : input.inputByteBudget - 16384 - bytes(input.contextOverhead);
  const assertFits = (value: unknown) => {
    if (bytes(value) > byteBudget) throw new Error("Independent review context exceeds the model input budget. Use a model with a larger context window.");
  };
  const consistency = (findings: unknown) => {
    const value = { ...context(sourceIds.map(versionId => ({ versionId, resolution: undefined })), true, 1, 1),
      reviewTask: "consistency", sourceExcerpts: [], evidenceReview: findings };
    assertFits(value);
    return value;
  };
  const complete = context(input.sources, true, 1, 1);
  if (!input.sources.length) return { batches: [], consistency };
  if (bytes(complete) <= byteBudget) return { batches: [complete], consistency };

  // Avoid packing both a source's full text and its slice in the same payload.
  const evidence = input.sources.map(({ versionId, resolution }) => {
    const { text, ...content } = resolution.content;
    return { versionId, resolution: { ...resolution, content }, text: String(text), truncated: content.truncated };
  });
  const excerpts = (batch: typeof evidence) => batch.map(({ versionId, resolution, text, ...range }: any) => ({ versionId,
    resolution: { ...resolution, content: { ...resolution.content, text, ...range,
      ...(resolution.content.textRange && range.textRange ? { textRange: {
        startByte: resolution.content.textRange.startByte + range.textRange.startByte,
        endByte: resolution.content.textRange.startByte + range.textRange.endByte,
        totalBytes: resolution.content.textRange.totalBytes,
      } } : {}),
    } },
  }));
  const batches = batchSectionSources(evidence, byteBudget,
    batch => bytes(context(excerpts(batch), false, 1000000, 1000000)))
    .map((batch, index, all) => context(excerpts(batch), false, index + 1, all.length));
  for (const batch of batches) assertFits(batch);
  // Fail before spending on evidence passes if the full report cannot fit even
  // without source text. Never silently truncate a report to make a review pass.
  assertFits({ ...empty, reviewTask: "consistency" });
  return { batches, consistency };
}
