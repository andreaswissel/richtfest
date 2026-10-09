import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData([`/knowledge/runs/${run.id}`], { run, events: [] });
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
