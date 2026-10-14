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

test("agent exchanges preserve literal text and link both participants and the original message", () => {
  const html = render(<SubagentThread projectId={projectId} runId={run.id} />, {
    run,
    events: [],
    threadMessages: [
      {
        id: "reply",
        body: "<script>not executable</script>",
        createdAt: "2026-10-13T12:00:00Z",
        agentMessage: {
          deliveryId: "delivery",
          sender: {
            runId: run.id,
            conversationId: "main",
            role: "source_reviewer",
            goal: run.goal,
          },
          recipient: {
            runId: "acoustic-run",
            conversationId: "acoustic-thread",
            role: "sound_insulation",
            goal: "Prepare the acoustic concept",
          },
          replyToMessageId: "question",
        },
      },
    ],
  });
  expect(html).toContain(
    `href="/projects/${projectId}?conversation=main&amp;agentRun=source-run"`,
  );
  expect(html).toContain(
    `href="/projects/${projectId}?conversation=acoustic-thread&amp;agentRun=acoustic-run"`,
  );
  expect(html).toContain(
    `href="/projects/${projectId}?conversation=main&amp;message=question"`,
  );
  expect(html).toContain("&lt;script&gt;not executable&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain(en.agentMessageDelivered);
  expect(html).not.toContain("Review result");
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
  expect(de.workspaceRunCategoryTimeout).toContain("gespeicherten Fortschritt mit den ursprünglichen Einstellungen");
  expect(de.workspaceRunCategoryTimeout).toContain("„Neu ausführen“ startet von vorn mit den aktuellen Modelleinstellungen");
  expect(de.workspaceRunCategoryTimeout).not.toMatch(
    /Token|Verbindung|Zugangsdaten/i,
  );
});

test("budget and uncertain-outcome stops show safe persisted reasons", () => {
  for (const [category, reason, expected] of [
    ["budget", "Execution paused before another paid call: allowance reached.", en.budgetStopped],
    ["outcome_unknown", "The previous worker lost ownership with an unfinished provider attempt.", en.workspaceRunCategoryOutcomeUnknown],
  ]) {
    const failed = { ...run, status: "failed", error: `phase=review; category=${category}; ${reason}` };
    const html = render(<SubagentThread projectId={projectId} runId={run.id} />, { run: failed, events: [] });
    expect(html).toContain(expected!);
    expect(html).not.toContain(en.workspaceRunNoSpecificReason);
    expect(html).not.toContain("category=");
  }
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

test("supervisor progress names concurrent assignments, distinguishes waiting work and returns to review", () => {
  const supervisor = {
    ...run,
    parentRunId: null,
    specialistRole: null,
    status: "running",
  };
  const children = [
    {
      ...run,
      id: "queued",
      status: "queued",
      goal: "Check missing dimensions",
    },
    {
      ...run,
      id: "active",
      status: "running",
      goal: "Compare floor plan revisions",
    },
    {
      ...run,
      id: "active-two",
      specialistRole: "requirements_reviewer",
      status: "running",
      goal: "Identify required acoustic evidence",
    },
    { ...run, id: "done", status: "completed", goal: "Obsolete assignment" },
  ];
  const node = <SubagentThread projectId={projectId} runId={run.id} />;
  const data = {
    run: supervisor,
    orchestration: { phase: "specialists" },
    events: [],
    children,
  };
  const html = render(node, data);
  expect(html).toContain("Source review");
  expect(html).toContain("Compare floor plan revisions");
  expect(html).toContain("Requirements check");
  expect(html).toContain("Identify required acoustic evidence");
  expect(html).toContain(`Source review · ${en.run_queued}`);
  expect(html).toContain("Check missing dimensions");
  expect(html.indexOf("Compare floor plan revisions")).toBeLessThan(
    html.indexOf("Check missing dimensions"),
  );
  expect(html).not.toContain("Obsolete assignment");
  const review = render(node, {
    ...data,
    children: children.map((child) => ({ ...child, status: "completed" })),
  });
  expect(review).toContain(en.workspaceTaskReviewing);
  expect(review).not.toContain("Compare floor plan revisions");
  const queued = render(node, {
    ...data,
    run: { ...supervisor, status: "queued" },
  });
  expect(queued).toContain(en.agentRunWaitingForWorker);
  expect(queued).not.toContain("Compare floor plan revisions");
});
