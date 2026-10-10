import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  agentRunReviewPayload,
  AgentRunReviews,
} from "../src/components/agent-run-review";
import { SubagentThread } from "../src/components/project-workspace/subagent-thread";

for (const decision of ["approved", "rejected"] as const) {
  test(`${decision} preserves the note and omits a blank evaluation`, () => {
    const form = new FormData();
    form.set("note", "Please verify the source");
    form.set("correctness", "");
    form.set("rework", "");
    expect(agentRunReviewPayload(form, decision)).toEqual({
      decision,
      note: "Please verify the source",
    });
  });
  test(`${decision} submits partial scores and explicit no rework`, () => {
    const form = new FormData();
    form.set("note", "Reviewed");
    form.set("correctness", "5");
    form.set("usefulness", "1");
    form.set("rework", "none");
    expect(agentRunReviewPayload(form, decision)).toEqual({
      decision,
      note: "Reviewed",
      evaluation: { correctness: 5, usefulness: 1, rework: "none" },
    });
  });
}

test("saved review renders original output, note and evaluation without inventing omitted scores", () => {
  const html = renderToStaticMarkup(
    <AgentRunReviews
      approvals={[
        {
          id: "review",
          decision: "rejected",
          note: "Missing sources",
          evaluation: { rubricVersion: 1, completeness: 2, rework: "major" },
          evaluatedOutput: {
            summary: "Original result",
            rationale: "Original reasoning",
            artifactRevisionIds: ["revision-one"],
          },
        },
      ]}
    />,
  );
  expect(html).toContain("Missing sources");
  expect(html).toContain("Completeness: 2/5");
  expect(html).toContain("Major — substantial revision");
  expect(html).toContain("Original result");
  expect(html).toContain("revision-one");
  expect(html).not.toContain("Correctness:");
});

test("run detail uses cached child attempts and reviews with collapsed diagnostics", () => {
  const client = new QueryClient();
  client.setQueryData(["/knowledge/runs/parent"], {
    run: {
      id: "parent",
      projectId: "project",
      status: "approved",
      goal: "Review",
    },
    approvals: [
      {
        id: "review",
        decision: "approved",
        note: "Saved note",
        evaluation: { usefulness: 4 },
      },
    ],
    children: [
      { id: "child", parentRunId: "parent", specialistRole: "source_reviewer" },
    ],
    attempts: [
      {
        id: "attempt",
        runId: "child",
        phase: "specialist",
        attemptNumber: 2,
        status: "completed",
        settings: {
          modelId: "configured-model",
          requestedReasoningEffort: "high",
        },
        response: { modelId: "actual-model" },
        usageStatus: "missing",
      },
    ],
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SubagentThread projectId="project" runId="parent" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(html).toContain("Saved note");
  expect(html).toContain("Usefulness: 4/5");
  expect(html).toContain("Execution attempts");
  expect(html).toContain("actual-model");
  expect(html).toContain("Provider default");
  expect(html).toContain("Attempt 2");
  expect(html).toContain("Source review");
  expect(html).toContain("totals may be incomplete");
  expect(html).not.toContain("<details open");
});
