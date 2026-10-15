import { expect, test } from "bun:test";
import {
  assertIndependentReviewCitations,
  assertIndependentReviewDecision,
  assertRevisionAssignments,
  aggregateIndependentReviews,
  independentReview,
  type Assignment,
} from "./supervisor";
import { prepareIndependentReview } from "./independent-review";

const sourceVersionId = "00000000-0000-4000-8000-000000000001";
const otherSourceVersionId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const otherTaskId = "00000000-0000-4000-8000-000000000004";

const assignment = (id = taskId): Assignment => ({
  taskId: id,
  runId: crypto.randomUUID(),
  role: "source_reviewer",
  goal: "Check the assigned source",
  sourceVersionIds: [sourceVersionId],
});

test("independent review requires structured findings and bounded revision requests", () => {
  const parsed = independentReview.parse({
    summary: "The first-pass summary is supported.",
    rationale: "I checked the excerpts directly.",
    citations: [sourceVersionId],
    decision: "revise",
    findings: [{
      severity: "blocking",
      issue: "The result omits the façade requirement.",
      recommendation: "Add the cited requirement to the assignment result.",
      citations: [sourceVersionId],
    }],
    revisions: [{ taskId, goal: "Add the façade requirement and cite its source." }],
  });
  expect(parsed.findings).toHaveLength(1);
  expect(() => independentReview.parse({
    ...parsed,
    extra: "not allowed",
  })).toThrow();
  expect(() => independentReview.parse({
    ...parsed,
    findings: [{ ...parsed.findings[0], severity: "critical" }],
  })).toThrow();
});

test("independent review citations must resolve from the exact assigned versions", () => {
  const review = independentReview.parse({
    summary: "Reviewed.",
    rationale: "Source text was re-read.",
    citations: [sourceVersionId],
    decision: "accept",
    findings: [{ severity: "note", issue: "Minor wording.", recommendation: "Keep as a note.", citations: [] }],
    revisions: [],
  });
  expect(() => assertIndependentReviewCitations(review, new Set([sourceVersionId]))).not.toThrow();
  expect(() => assertIndependentReviewCitations(review, new Set())).toThrow("readable resolved text");
  expect(() => assertIndependentReviewCitations({ ...review, findings: [{
    ...review.findings[0],
    citations: [otherSourceVersionId],
  }] }, new Set([sourceVersionId]))).toThrow("readable resolved text");
});

test("an accepted independent review cannot leave blocking findings or revisions", () => {
  const accepted = independentReview.parse({
    summary: "Looks complete.",
    rationale: "I reread the sources.",
    citations: [sourceVersionId],
    decision: "accept",
    findings: [],
    revisions: [],
  });
  expect(() => assertIndependentReviewDecision(accepted, [assignment()])).not.toThrow();
  expect(() => assertIndependentReviewDecision({
    ...accepted,
    findings: [{ severity: "blocking", issue: "Missing item.", recommendation: "Add it.", citations: [sourceVersionId] }],
  }, [assignment()])).toThrow("blocking findings");
  expect(() => assertIndependentReviewDecision({
    ...accepted,
    revisions: [{ taskId, goal: "Change it." }],
  }, [assignment()])).toThrow("blocking findings");
});

test("independent revisions can only target existing bounded assignments", () => {
  const assignments = [assignment(), assignment(otherTaskId)];
  expect(() => assertRevisionAssignments([{ taskId, goal: "Refine this finding." }], assignments)).not.toThrow();
  expect(() => assertRevisionAssignments([], assignments)).toThrow("Invalid revision assignments");
  expect(() => assertRevisionAssignments([{ taskId: crypto.randomUUID(), goal: "Expand scope." }], assignments)).toThrow("Invalid revision assignments");
  expect(() => assertRevisionAssignments([
    { taskId, goal: "First." },
    { taskId, goal: "Duplicate." },
  ], assignments)).toThrow("Invalid revision assignments");
});

test("review slices distinguish omitted sections from missing content without dropping evidence", () => {
  const content = `Uncited introduction.\n\n## Assessment\n31.7 dB [${sourceVersionId}]\n\n## Plans\nDrawing p. 9 [${otherSourceVersionId}]\n\n## Plans\nUncited unresolved attachment status.\n`;
  const sources = [sourceVersionId, otherSourceVersionId, taskId].map((versionId, i) => ({ versionId,
    resolution: { status: "resolved", source: { versionId, name: `source-${i}` },
      content: { status: "available", text: `[Page ${i + 1}]\n${"Überprüfung 🧱 ".repeat(1500)}`, truncated: false } },
  }));
  const input = { review: { document: { title: "Report", content }, citations: [sourceVersionId, otherSourceVersionId] },
    sources, assignments: [], originalGoal: "Check all evidence", revision: 0, assignedVersionCount: 3,
    readableSourceIds: sources.map(s => s.versionId), unreadableSources: [], contextOverhead: {} };
  const plan = prepareIndependentReview({ ...input, inputByteBudget: 54000 });
  expect(plan.batches.length).toBeGreaterThan(1);
  const first = plan.batches.find(b => b.sourceCoverage.sliceVersionIds.length === 1 && b.sourceCoverage.sliceVersionIds[0] === sourceVersionId)!;
  expect(first.reportCoverage).toEqual({ scope: "selected_sections", sectionDirectory: [
    { id: "section:0", heading: null, contentSupplied: true },
    { id: "section:1", heading: "Assessment", contentSupplied: true },
    { id: "section:2", heading: "Plans", contentSupplied: false },
    { id: "section:3", heading: "Plans", contentSupplied: true },
  ] });
  expect(first.firstPassReview.document!.content).toContain("31.7 dB");
  expect(first.firstPassReview.document!.content).not.toContain("Drawing p. 9");
  expect(first.firstPassReview.document!.content).toContain("Uncited unresolved attachment status");
  for (const source of sources) {
    const pieces = plan.batches.flatMap(b => b.sourceExcerpts).filter(s => s.versionId === source.versionId);
    expect(pieces.map(p => p.resolution.content.text).join("")).toBe(source.resolution.content.text);
  }
  // Evidence the report never cited still gets the whole report for omissions.
  const unmatched = plan.batches.find(b => b.sourceCoverage.sliceVersionIds.length === 1 && b.sourceCoverage.sliceVersionIds[0] === taskId)!;
  expect(unmatched.reportCoverage.scope).toBe("whole_report");
  expect(unmatched.firstPassReview.document!.content).toBe(content);
  const consistency = plan.consistency({ findings: [] });
  expect(consistency.firstPassReview.document!.content).toBe(content);
  expect(consistency.reportCoverage.sectionDirectory.every(s => s.contentSupplied)).toBe(true);
  const complete = prepareIndependentReview({ ...input, inputByteBudget: 250000 }).batches;
  expect(complete).toHaveLength(1);
  expect(complete[0]!.reviewTask).toBe("complete");
  expect(complete[0]!.firstPassReview.document!.content).toBe(content);
});

test("slice results aggregate findings, citations, and bounded assignment revisions", () => {
  const first = independentReview.parse({
    summary: "First slice checked.",
    rationale: "Directly reread the first excerpt.",
    citations: [sourceVersionId],
    decision: "revise",
    findings: [{ severity: "blocking", issue: "Missing value.", recommendation: "Add it.", citations: [sourceVersionId] }],
    revisions: [{ taskId, goal: "Include the missing value." }],
  });
  const second = independentReview.parse({
    summary: "Second slice checked.",
    rationale: "Directly reread the second excerpt.",
    citations: [otherSourceVersionId],
    decision: "revise",
    findings: [{ severity: "note", issue: "Clarify scope.", recommendation: "State the boundary.", citations: [otherSourceVersionId] }],
    revisions: [{ taskId, goal: "Also state the boundary." }],
  });
  const combined = aggregateIndependentReviews([
    { sourceVersionIds: [sourceVersionId], output: first },
    { sourceVersionIds: [otherSourceVersionId], output: second },
  ]);
  expect(combined.citations).toEqual([sourceVersionId, otherSourceVersionId]);
  expect(combined.findings).toHaveLength(2);
  expect(combined.revisions).toEqual([{
    taskId,
    goal: "Include the missing value.\nAdditional review guidance: Also state the boundary.",
  }]);
  expect(combined.decision).toBe("revise");
});
