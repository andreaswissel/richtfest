import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
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
import MarkdownContent from "../src/components/chat-markdown-content";
import { ArtifactSourceRegister } from "../src/components/project-workspace/artifact-export";
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
    const html = renderToStaticMarkup(
      <MarkdownContent>
        {formatSourceCitations(text, projectId, sources, "Source unavailable")}
      </MarkdownContent>,
    );
    expect(html).toContain("<h2>Concept</h2>");
    expect(html).toContain("<strong>Review</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain("Facade [original].pdf · v2");
    expect(html).toContain(`sourceVersion=${versionId}`);
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
  test("document, artifact, run and shared work panels are real links", () => {
    const html = render(
      <ArtifactPanel
        projectId={projectId}
        artifacts={[]}
        runs={[]}
        tasks={[]}
      />,
      `/projects/${projectId}`,
      { [`/projects/${projectId}/files`]: [] },
    );
    expect(html).toContain("panel=artifacts");
    expect(html).toContain("panel=runs");
    expect(html).toContain("panel=tasks");
    expect(html).toContain(`href="/projects/${projectId}?view=sources"`);
  });
  test("Affinity Publisher sources use the visual preview endpoint and keep download access", () => {
    const fileId = "550e8400-e29b-41d4-a716-446655440004";
    const versionId = "550e8400-e29b-41d4-a716-446655440005";
    const html = render(
      <ArtifactPanel
        projectId={projectId}
        artifacts={[]}
        runs={[]}
        tasks={[]}
      />,
      `/projects/${projectId}?panel=documents&file=${fileId}&sourceVersion=${versionId}`,
      {
        [`/projects/${projectId}/files`]: [
          { id: fileId, name: "site-plan.afpub", version: 1 },
        ],
        [`/projects/${projectId}/files/${fileId}/versions`]: [
          {
            id: versionId,
            version: 1,
            status: "ready",
            mimeType: "application/octet-stream",
          },
        ],
      },
    );
    expect(html).toContain(
      `/api/projects/${projectId}/files/${fileId}/versions/1/preview`,
    );
    expect(html).toContain(
      `/api/projects/${projectId}/files/${fileId}/versions/1/download`,
    );
    expect(html).toContain("Affinity Publisher preview: site-plan.afpub");
  });
  test("artifact revision can be saved as a PDF with its source version references", () => {
    const artifactId = "550e8400-e29b-41d4-a716-446655440007";
    const revisionId = "550e8400-e29b-41d4-a716-446655440008";
    const sourceVersionId = "550e8400-e29b-41d4-a716-446655440009";
    const html = render(
      <ArtifactPanel
        projectId={projectId}
        artifacts={[]}
        runs={[]}
        tasks={[]}
        initialFiles={[]}
      />,
      `/projects/${projectId}?panel=artifacts&artifact=${artifactId}&revision=${revisionId}`,
      {
        [`/knowledge/artifacts/${artifactId}`]: {
          artifact: {
            id: artifactId,
            projectId,
            title: "Acoustic planning draft",
            type: "report",
            status: "draft",
          },
          revisions: [
            {
              id: revisionId,
              version: 2,
              title: "Preliminary measures",
              content: "## Open checks\n\n- Verify the facade assembly",
              sourceVersionIds: [sourceVersionId],
              sourceReferences: [
                {
                  versionId: sourceVersionId,
                  fileName: "Facade.pdf",
                  version: 1,
                },
              ],
              createdAt: "2026-10-10T10:00:00.000Z",
            },
          ],
          annotations: [],
        },
      },
    );
    expect(html).toContain("Save as PDF");
    expect(html).toContain("Preliminary measures");
    expect(html).toContain("Verify the facade assembly");
    expect(html).toContain("Facade.pdf · v1");
    expect(html).toContain(sourceVersionId);
    expect(html).toContain(`sourceVersion=${sourceVersionId}`);
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
  test("failed runs remain visible in an otherwise empty conversation", () => {
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
              "phase=review; category=provider; The provider call could not complete.",
            createdAt: "2026-10-10T10:00:00.000Z",
            finishedAt: "2026-10-10T10:02:00.000Z",
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
    expect(html).toContain(`agentRun=${runId}`);
    expect(html).not.toContain("No messages yet.");
  });
  test("composer uses the first configured effort when medium is unavailable", () => {
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
    expect(html).toContain('value="low"');
    expect(html).toContain("Preset effort");
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
    expect(html).toContain("Preset effort");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Agent replies are unavailable");
  });
  test("composer shows configured effort levels when optional supervisor is disabled", () => {
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
    expect(html).toContain("Preset effort");
    expect(html).toContain('value="medium"');
  });
});
