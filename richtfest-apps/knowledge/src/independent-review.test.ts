import { expect, test } from "bun:test";
import {
  assertIndependentReviewCitations,
  assertIndependentReviewDecision,
  assertRevisionAssignments,
  aggregateIndependentReviews,
  chunkSourceVersionIds,
  independentReview,
  type Assignment,
} from "./supervisor";

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

test("source excerpts are divided into bounded, deduplicated slices", () => {
  expect(chunkSourceVersionIds([
    sourceVersionId,
    otherSourceVersionId,
    sourceVersionId,
    taskId,
    otherTaskId,
  ])).toEqual([
    [sourceVersionId, otherSourceVersionId, taskId],
    [otherTaskId],
  ]);
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
