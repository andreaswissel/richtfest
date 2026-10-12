import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RecordData } from "../src/api";
import en from "../src/locales/en.json";
import de from "../src/locales/de.json";
import {
  SubagentList,
  SubagentThread,
} from "../src/components/project-workspace/subagent-thread";
const projectId = "550e8400-e29b-41d4-a716-446655440000";
const run = {
  id: "source-run",
  projectId,
  conversationId: "main",
  parentRunId: "coordinator",
  specialistRole: "source_reviewer",
  goal: "Review the original floor plans",
  status: "needs_review",
  outputSummary: "Source result",
  sourceVersionIds: [],
};
function render(node: React.ReactNode, data: RecordData = { run, events: [] }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData([`/knowledge/runs/${run.id}`], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[
          `/projects/${projectId}?conversation=main&panel=runs&sourceVersion=revision-one`,
        ]}
      >
        {node}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
test("subagent rows show readable names and open scoped thread links without full result cards", () => {
  const html = render(
    <SubagentList
      projectId={projectId}
      conversationId="main"
      runs={[
        run,
        {
          ...run,
          id: "other",
          conversationId: "other-chat",
          outputSummary: "Other chat output",
        },
      ]}
    />,
  );
  expect(html).toContain("Source review");
  expect(html).toContain("agentRun=source-run");
  expect(html).toContain("sourceVersion=revision-one");
  expect(html).not.toContain("Source result");
  expect(html).not.toContain("other-chat");
});
test("specialist threads show work but never independent lifecycle controls or cross-project data", () => {
  const html = render(
    <SubagentThread
      projectId={projectId}
      runId={run.id}
      conversationId="main"
      initialRun={run}
    />,
  );
  expect(html).toContain(run.goal);
  expect(html).toContain("Source result");
  expect(html).not.toContain("Approve result");
  expect(html).not.toContain("Review result");
  expect(html).not.toContain("Stop run");
  expect(html).not.toContain("Retry run");
  const wrong = render(
    <SubagentThread
      projectId="another-project"
      runId={run.id}
      conversationId="main"
      initialRun={run}
    />,
  );
  expect(wrong).not.toContain("Source result");
  expect(wrong).toContain("not available");
});

test("persisted timeout reasons show phase and safe retry guidance in run rows and threads", () => {
  const phases = [
    ["plan", en.workspaceRunPhasePlan],
    ["specialist", en.workspaceRunPhaseSpecialist],
    ["review", en.workspaceRunPhaseReview],
    ["independent_review", en.workspaceRunPhaseIndependentReview],
    ["provider", en.workspaceRunPhaseProvider],
  ];
  for (const [phase, label] of phases) {
    const failed = {
      ...run,
      status: "failed",
      error: `phase=${phase}; category=timeout; ${en.workspaceRunCategoryTimeout}`,
    };
    const rows = render(<SubagentList projectId={projectId} runs={[failed]} />);
    const thread = render(
      <SubagentThread projectId={projectId} runId={run.id} />,
      { run: failed, events: [] },
    );
    for (const html of [rows, thread]) {
      expect(html).toContain(`${en.workspaceRunFailedDuring} ${label}:`);
      expect(html).toContain(en.workspaceRunCategoryTimeout);
      expect(html).not.toContain(en.workspaceRunNoSpecificReason);
      expect(html).not.toMatch(
        /output tokens|credentials|provider connection/i,
      );
      expect(html).not.toContain("phase=");
    }
  }
  expect(de.workspaceRunCategoryTimeout).toContain("Zeitlimit überschritten");
  expect(de.workspaceRunCategoryTimeout).toContain("enger gefassten Auftrag");
  expect(de.workspaceRunCategoryTimeout).toContain("schnelleren Modell");
  expect(de.workspaceRunCategoryTimeout).not.toMatch(
    /Token|Verbindung|Zugangsdaten/i,
  );
});

test("cancelled child timeout reasons retain supervisor cause in history and child links", () => {
  const child = {
    ...run,
    id: "550e8400-e29b-41d4-a716-446655440001",
    status: "cancelled",
    failureReason:
      "phase=specialist; category=timeout; The supervisor failed during specialist. No output was approved.",
  };
  const rows = render(<SubagentList projectId={projectId} runs={[child]} />);
  const thread = render(
    <SubagentThread projectId={projectId} runId={run.id} />,
    { run, events: [], children: [child] },
  );
  for (const html of [rows, thread]) {
    expect(html).toContain(en.workspaceRunChildCancelledDuring);
    expect(html).toContain(en.workspaceRunCategoryTimeout);
    expect(html).toContain(en.workspaceRunChildCauseSupervisorFailed);
    expect(html).not.toContain(en.workspaceRunNoSpecificReason);
    expect(html).not.toMatch(/output tokens|credentials|provider connection/i);
  }
});

test("noncanonical timeout reasons keep the safe unknown-reason fallback", () => {
  const html = render(
    <SubagentList
      projectId={projectId}
      runs={[
        {
          ...run,
          status: "failed",
          error: "phase=specialist; category=timeout; SECRET diagnostic",
        },
      ]}
    />,
  );
  expect(html).toContain(en.workspaceRunNoSpecificReason);
  expect(html).not.toContain("SECRET");
  expect(html).not.toContain(en.workspaceRunCategoryTimeout);
});
