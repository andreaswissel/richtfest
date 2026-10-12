import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadRail } from "../src/components/project-workspace/thread-rail";

test("rail scopes resources to the thread, clears document selection, and exposes reversible archive actions", () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter
        initialEntries={[
          "/projects/p?view=sharedWork&agentRun=old&message=old&panel=documents&sourceVersion=revision",
        ]}
      >
        <ThreadRail
          projectId="p"
          selectedId="archived"
          artifactCount={2}
          taskCount={1}
          onCreate={() => {}}
          conversations={[
            {
              id: "active",
              title: "Planning review",
              unreadCount: 2,
              archivedAt: null,
            },
            {
              id: "archived",
              title: "Previous review",
              archivedAt: "2026-10-09T12:00:00Z",
            },
          ]}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(html).toContain("Planning review");
  expect(html).toContain("Previous review");
  expect(html).toContain("Archive thread");
  expect(html).toContain("Restore thread");
  expect(html).toContain("New thread");
  expect(html).not.toContain("sourceVersion=revision");
  for (const panel of ["artifacts", "tasks", "runs", "documents"])
    expect(html).toContain(
      `href="/projects/p?conversation=archived&amp;panel=${panel}"`,
    );
  expect(html).toContain('class="thread-rail-archived" open=""');
  expect(html).not.toContain("agentRun=");
  expect(html).not.toContain("message=");
  expect(html).not.toContain("view=sharedWork");
  expect(html).not.toContain("<select");
});
