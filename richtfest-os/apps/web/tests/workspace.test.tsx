import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProjectOpenUI, {
  library,
  validateOpenUI,
} from "../src/components/project-workspace/openui";
import {
  mergeMessages,
  type MessagePage,
} from "../src/components/project-workspace/types";
import { ArtifactPanel } from "../src/components/project-workspace/artifacts";
import { Transcript } from "../src/components/project-workspace/transcript";
import { isPositiveFeedback } from "../src/components/project-workspace/richtfest-celebration";
import MarkdownContent from "../src/components/chat-markdown-content";
import { ArtifactSourceRegister } from "../src/components/project-workspace/artifact-export";
import { ProjectAnalytics } from "../src/components/project-workspace/analytics";
import { ProjectWorkspace } from "../src/screens/project-workspace";
import { formatSourceCitations } from "@richtfest/shared";
const projectId = "550e8400-e29b-41d4-a716-446655440000";
const conversationId = "550e8400-e29b-41d4-a716-446655440001";
function render(
  node: React.ReactNode,
  path = "/",
  records: Record<string, unknown> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const [key, value] of Object.entries(records))
    client.setQueryData([key], value);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("registered OpenUI boundary", () => {
  test("PDF attachment title opens the exact revision while its action downloads PDF", () => {
    const artifactId = "550e8400-e29b-41d4-a716-446655440002";
    const revisionId = "550e8400-e29b-41d4-a716-446655440003";
    const html = render(
      <ProjectOpenUI
        projectId={projectId}
        conversationId={conversationId}
        response={`root = ArtifactPdf("${artifactId}", "${revisionId}")`}
      />,
      "/",
      {
        [`/knowledge/workspaces/${projectId}`]: {
          artifacts: [
            { id: artifactId, projectId, title: "Completed concept" },
          ],
        },
      },
    );
    expect(html).toContain(
      `href="/projects/${projectId}?panel=artifacts&amp;artifact=${artifactId}&amp;revision=${revisionId}&amp;conversation=${conversationId}"`,
    );
    expect(html).toContain(
      `href="/api/knowledge/artifacts/${artifactId}/revisions/${revisionId}/pdf" download`,
    );
  });

  test("Markdown concepts render tables, emphasis and trusted exact-version citations", () => {
    const versionId = "550e8400-e29b-41d4-a716-446655440009";
    const missingId = "550e8400-e29b-41d4-a716-446655440010";
    const sources = [
      { versionId, fileName: "Facade [original].pdf", version: 2 },
    ];
    const text = `## Concept\n\n**Review** [${versionId}]\n\n| Check | Result |\n| --- | --- |\n| Wall | Pending |\n\n[${missingId}]`;
    const html = render(
      <MarkdownContent>
        {formatSourceCitations(text, projectId, sources, "Source unavailable")}
      </MarkdownContent>,
      `/projects/${projectId}?conversation=${conversationId}`,
    );
    expect(html).toContain("<h2>Concept</h2>");
    expect(html).toContain("<strong>Review</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain("Facade [original].pdf · v2");
    expect(html).toContain(`sourceVersion=${versionId}`);
    expect(html).toContain(`conversation=${conversationId}`);
    expect(html).toContain("Source unavailable");
    expect(html).not.toContain(missingId);
    const register = render(
      <ArtifactSourceRegister
        projectId={projectId}
        revision={{
          sourceVersionIds: [versionId, missingId, versionId],
          sourceReferences: sources,
        }}
      />,
    );
    expect(register).toContain("Facade [original].pdf · v2");
    expect(register).toContain("Source unavailable");
    expect(register).not.toContain(missingId);
    expect(register.match(/<li>/g)).toHaveLength(2);
  });

  test("artifact previews resolve trusted titles and preserve the exact revision", () => {
    const artifactId = "550e8400-e29b-41d4-a716-446655440002";
    const revisionId = "550e8400-e29b-41d4-a716-446655440003";
    const response = `root = ArtifactPreview("${artifactId}", "${revisionId}")`;
    expect(validateOpenUI(response)).toBe(true);
    const node = (
      <ProjectOpenUI
        projectId={projectId}
        conversationId={conversationId}
        response={response}
      />
    );
    const html = render(node, "/", {
      [`/knowledge/workspaces/${projectId}`]: {
        artifacts: [{ id: artifactId, projectId, title: "Evidence review" }],
      },
    });
    expect(html).toContain("Evidence review");
    expect(html).toContain(
      `artifact=${artifactId}&amp;revision=${revisionId}&amp;conversation=${conversationId}`,
    );
    const unavailable = render(node, "/", {
      [`/knowledge/workspaces/${projectId}`]: {
        artifacts: [
          { id: artifactId, projectId: conversationId, title: "Other project" },
        ],
      },
    });
    expect(unavailable).not.toContain("Other project");
    expect(unavailable).not.toContain(`artifact=${artifactId}`);
  });
  test("rejects unknown components, raw HTML and unresolved references", () => {
    expect(validateOpenUI('root = Evil("hello")')).toBe(false);
    expect(validateOpenUI("<script>alert(1)</script>")).toBe(false);
    expect(validateOpenUI("root = missing")).toBe(false);
    expect(validateOpenUI('root = Query("external")')).toBe(false);
    expect(validateOpenUI('root = Mutation("execute")')).toBe(false);
  });
  test("renders registered component text without interpreting HTML", () => {
    expect(validateOpenUI('root = Callout("Source review pending")')).toBe(
      true,
    );
    const html = render(
      <ProjectOpenUI
        projectId={projectId}
        response={'root = Callout("Source review pending")'}
      />,
    );
    expect(html).toContain("Source review pending");
  });
  test("registry contains no model-defined URL or executable action", () => {
    const schema = JSON.stringify(library.toJSONSchema());
    expect(schema).not.toContain('"href"');
    expect(schema).not.toContain('"html"');
    expect(schema).toContain("versionId");
    expect(schema).toContain("artifactId");
  });
  test("source links always retain trusted project and immutable revision", () => {
    const html = render(
      <ProjectOpenUI
        projectId={projectId}
        conversationId={conversationId}
        response={`root = SourceCitation("Original PDF", "${conversationId}")`}
      />,
    );
    expect(html).toContain(
      `/projects/${projectId}?sourceVersion=${conversationId}`,
    );
  });
});
describe("workspace records and navigation", () => {
  test("mobile deep links show resources, while thread and message targets show conversation", () => {
    for (const [query, panel] of [
      ["", "conversation"],
      ["?panel=tasks", "resources"],
      ["?artifact=report&revision=exact", "resources"],
      ["?sourceVersion=exact&page=3", "resources"],
      ["?panel=artifacts&message=target", "conversation"],
      ["?panel=runs&agentRun=target", "conversation"],
    ]) {
      const html = render(
        <Routes>
          <Route path="/projects/:id" element={<ProjectWorkspace />} />
        </Routes>,
        `/projects/${projectId}${query}`,
      );
      expect(html).toContain(`data-mobile-panel="${panel}"`);
    }
  });
  test("celebration recognizes short positive feedback in English and German", () => {
    for (const message of [
      "nice, that worked",
      "  NICE, that worked!!!  ",
      "Great work, thank you!",
      "Perfect!",
      "That’s great!",
      "looks good",
      "Super, das hat geklappt!",
      "Perfekt, vielen Dank.",
      "Gut gemacht!",
    ])
      expect(isPositiveFeedback(message)).toBe(true);
  });
  test("celebration does not mistake complaints, questions or quoted instructions for praise", () => {
    for (const message of [
      "",
      "nice, that did not work",
      "thanks, but it still doesn't work",
      "That worked?",
      "not perfect",
      "Say 'nice, that worked' when finished",
      '"nice, that worked"',
      "Perfekt wäre es, wenn es funktioniert.",
      "Danke, das funktioniert nicht.",
      "Please check the roof dimensions",
      "great ".repeat(40),
    ])
      expect(isPositiveFeedback(message)).toBe(false);
  });
  test("analytics distinguishes total, partial, unavailable and genuine zero costs", () => {
    const usage = {
      inputTokens: 1234,
      outputTokens: 567,
      estimatedCostUsd: 0.75,
      recordedCostUsd: 0.75,
    };
    const node = <ProjectAnalytics projectId={projectId} />;
    const path = `/knowledge/workspaces/${projectId}/analytics?page=0`;
    const html = render(node, "/", {
      [path]: {
        hasMore: false,
        summary: {
          runCount: 4,
          averagedRunCount: 2,
          averageTokensPerRun: 900.5,
          missingUsageAttempts: 1,
          unreportedRuns: 1,
          usage: {
            totalTokens: 3602,
            recordedCostUsd: 0.98,
            unpricedCalls: 0,
            incompleteTokenCalls: 0,
          },
          models: [
            {
              provider: "openai",
              modelId: "test-model",
              callCount: 2,
              inputTokens: 2468,
              outputTokens: 1134,
              totalTokens: 3602,
              reasoningTokens: 200,
              cachedInputTokens: 400,
              recordedCostUsd: 0.98,
              unpricedCalls: 0,
              incompleteTokenCalls: 0,
            },
          ],
        },
        runs: [
          {
            id: "complete",
            goal: "Complete run",
            status: "needs_review",
            createdAt: "2026-10-12",
            members: [{}, {}, {}],
            aggregate: usage,
          },
          {
            id: "partial",
            goal: "Partial run",
            status: "failed",
            createdAt: "2026-10-12",
            members: [{}],
            aggregate: {
              ...usage,
              estimatedCostUsd: null,
              recordedCostUsd: 0.23,
            },
          },
          {
            id: "unknown",
            goal: "Unknown run",
            status: "cancelled",
            createdAt: "2026-10-12",
            members: [{}],
            aggregate: {
              ...usage,
              estimatedCostUsd: null,
              recordedCostUsd: null,
            },
          },
          {
            id: "free",
            goal: "Zero run",
            status: "completed",
            createdAt: "2026-10-12",
            members: [{}],
            aggregate: { ...usage, estimatedCostUsd: 0, recordedCostUsd: 0 },
          },
        ],
      },
    });
    expect(html).toContain("$0.75");
    expect(html).toContain("$0.23");
    expect(html).toContain("Project totals · all runs");
    expect(html).toContain("3,602");
    expect(html).toContain("$0.98");
    expect(html).toContain("901");
    expect(html.replace(/<[^>]*>/g, "")).toContain("Measured runs: 2 / 4");
    expect(html).toContain("Usage by model");
    expect(html).toContain("test-model");
    expect(html.match(/Partial · recorded only/g)).toHaveLength(3);
    expect(html.match(/Unavailable/g)).toHaveLength(1);
    expect(html.match(/\$0\.00/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
    const empty = render(node, "/", { [path]: { hasMore: false, runs: [] } });
    expect(empty).toContain("No agent runs in this project yet.");
    expect(empty).not.toContain("$0.00");
  });
  test("history prepend merges stable IDs in chronological order without duplicate messages", () => {
    const make = (id: string, createdAt: string) => ({
      id,
      body: id,
      actorKind: "user",
      createdAt,
    });
    const page = (items: ReturnType<typeof make>[]): MessagePage => ({
      items,
      nextCursor: null,
      unreadCount: 0,
    });
    const result = mergeMessages([
      page([
        make("c", "2026-10-09T03:00:00Z"),
        make("b", "2026-10-09T02:00:00Z"),
      ]),
      page([
        make("a", "2026-10-09T01:00:00Z"),
        make("b", "2026-10-09T02:00:00Z"),
      ]),
    ]);
    expect(result.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
  test("artifact gallery exposes preview cards and originating run links within the thread", () => {
    const html = render(
      <ArtifactPanel
        projectId={projectId}
        conversationId={conversationId}
        artifacts={[
          {
            id: "artifact-one",
            title: "Facade concept",
            preview: "Check the window junction",
            version: 2,
            runId: "run-one",
            runGoal: "Review facade",
            conversationId,
          },
        ]}
        runs={[]}
        tasks={[]}
      />,
      `/projects/${projectId}?conversation=${conversationId}`,
      { [`/projects/${projectId}/files`]: [] },
    );
    expect(html).toContain("panel=artifacts");
    expect(html).toContain("artifact=artifact-one");
    expect(html).toContain("Check the window junction");
    expect(html).toContain(
      `conversation=${conversationId}&amp;agentRun=run-one`,
    );
    expect(html).toContain("Review facade");
  });
  test("detail rail links retain the thread, clear stale selections, and mark the displayed panel", () => {
    for (const [query, active] of [
      ["", "artifacts"],
      ["&panel=tasks&agentRun=old&message=old", "tasks"],
      ["&panel=runs&sourceVersion=exact&page=3", "documents"],
    ]) {
      const html = render(
        <ArtifactPanel
          projectId={projectId}
          conversationId={conversationId}
          artifacts={[]}
          tasks={[]}
          runs={[]}
          initialFiles={[]}
        />,
        `/projects/${projectId}?conversation=${conversationId}${query}`,
      );
      const nav = html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)?.[0] || "";
      expect(nav).toContain('aria-label="Thread resources"');
      for (const panel of ["artifacts", "tasks", "runs", "documents"])
        expect(nav).toContain(
          `href="/projects/${projectId}?panel=${panel}&amp;conversation=${conversationId}"`,
        );
      expect(nav).toContain(
        `aria-current="page" href="/projects/${projectId}?panel=${active}&amp;conversation=${conversationId}"`,
      );
      expect(nav).not.toMatch(/agentRun=|message=|sourceVersion=|page=3/);
    }
  });
  test("unconfigured composer shows an actionable alert without claiming a message was saved", () => {
    const html = render(
      <Transcript projectId={projectId} conversationId={conversationId} />,
      `/projects/${projectId}`,
      {
        "/agent/readiness": {
          configured: false,
          executionAvailable: false,
          source: null,
        },
      },
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Agent replies are unavailable");
    expect(html).toContain("You can still save messages");
    expect(html).not.toContain("Your message was saved");
    expect(html).toContain('href="/settings"');
    expect(html).toContain('data-slot="message-scroller-viewport"');
    expect(html).not.toContain("Jump to latest");
    expect(html).not.toContain("Richtfest mode");
    expect(html).not.toContain('class="richtfest-celebration"');
  });
  test("timed-out runs remain visible in an empty conversation without token-limit advice", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440006";
    const html = render(
      <Transcript
        projectId={projectId}
        conversationId={conversationId}
        runs={[
          {
            id: runId,
            projectId,
            conversationId,
            status: "failed",
            failureReason:
              "phase=review; category=timeout; The provider call exceeded its time limit.",
            failureEvent: {
              paramsSummary: JSON.stringify({
                diagnostics: {
                  errorId: "STRUCTURED_OUTPUT_TRUNCATED",
                  finishReason: "length",
                },
              }),
            },
            createdAt: "2026-10-10T10:00:00.000Z",
            finishedAt: "2026-10-10T10:02:00.000Z",
          },
          {
            id: "550e8400-e29b-41d4-a716-446655440007",
            projectId,
            conversationId,
            status: "failed",
            failureReason:
              "phase=review; category=timeout; The model call exceeded its configured time limit.",
            createdAt: "2026-10-10T10:03:00.000Z",
            finishedAt: "2026-10-10T10:04:00.000Z",
          },
        ]}
      />,
      `/projects/${projectId}`,
      {
        "/agent/readiness": {
          configured: true,
          executionAvailable: true,
          source: "workspace",
          supervisor: {
            enabled: true,
            presets: [{ effort: "medium", configured: true }],
          },
        },
      },
    );
    expect(html).toContain("The agent could not finish");
    expect(html).toContain("Failed during review");
    expect(html).toContain("The provider call exceeded its time limit");
    expect(html).not.toContain("Check the provider connection");
    expect(html).not.toContain("Token limit exceeded");
    expect(html).toContain(
      "Retry run reuses available saved progress with the original settings",
    );
    expect(html).toContain(
      "Use Run again to start fresh with current model settings",
    );
    expect(html).toContain(`agentRun=${runId}`);
    expect(html).not.toContain("No messages yet.");
  });
  test("composer keeps configured effort behind chat options", () => {
    const html = render(
      <Transcript projectId={projectId} conversationId={conversationId} />,
      `/projects/${projectId}`,
      {
        "/agent/readiness": {
          configured: true,
          executionAvailable: true,
          source: "workspace",
          supervisor: {
            enabled: true,
            presets: [
              { effort: "low", configured: true },
              { effort: "medium", configured: false },
            ],
          },
        },
      },
    );
    expect(html).toContain('aria-label="Chat options"');
    expect(html).not.toContain("Preset effort");
    expect(html).not.toContain('role="radio"');
  });
  test("composer keeps provider selection in Settings", () => {
    const html = render(
      <Transcript projectId={projectId} conversationId={conversationId} />,
      `/projects/${projectId}`,
      {
        "/agent/readiness": {
          configured: true,
          executionAvailable: true,
          provider: "vercel",
          source: "workspace",
          supervisor: {
            enabled: true,
            presets: [{ effort: "medium", configured: true }],
          },
        },
      },
    );
    expect(html).not.toContain("OpenAI");
    expect(html).not.toContain("Anthropic");
    expect(html).not.toContain("Vercel AI Gateway");
    expect(html).toContain('aria-label="Chat options"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Agent replies are unavailable");
  });
  test("composer keeps chat options available when optional supervisor is disabled", () => {
    const html = render(
      <Transcript projectId={projectId} conversationId={conversationId} />,
      `/projects/${projectId}`,
      {
        "/agent/readiness": {
          configured: false,
          executionAvailable: false,
          provider: "openai",
          source: null,
          supervisor: {
            enabled: false,
            presets: [{ effort: "medium", configured: true }],
          },
        },
      },
    );
    expect(html).toContain('aria-label="Chat options"');
    expect(html).not.toContain("Preset effort");
  });
});
