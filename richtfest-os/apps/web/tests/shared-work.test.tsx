import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SharedWork } from "../src/screens/foundation";

test("shared work shows supplied thread tasks rather than a project-wide conversation list", () => {
  const client = new QueryClient();
  client.setQueryData(["/knowledge/conversations?projectId=project-one"], {
    conversations: [
      {
        id: "conversation-one",
        title: "Review floor plans",
        assigneeType: "user",
      },
    ],
  });
  client.setQueryData(["/knowledge/runs?projectId=project-one"], { items: [] });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/projects/project-one?view=sharedWork"]}>
        <SharedWork
          projectId="project-one"
          conversationId="conversation-one"
          tasks={[
            { id: "task-one", title: "Check facade detail", status: "open" },
          ]}
          runs={[]}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(html).toContain("Check facade detail");
  expect(html).not.toContain("Review floor plans");
  expect(html).toContain("Create task");
  expect(html).not.toContain("No messages yet");
  expect(html).not.toContain("aria-pressed");
});

test("task disclosures preserve their own full instructions and readable statuses", () => {
  const goal = `${"Check the source maps and reference periods. ".repeat(10)}Keep the final caveat.`;
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SharedWork
          projectId="project-one"
          conversationId="conversation-one"
          tasks={[
            {
              id: "manual",
              title: "Confirm project address",
              status: "cancelled",
            },
            {
              id: "delegated",
              title: goal.slice(0, 300),
              status: "needs_review",
            },
          ]}
          runs={[
            {
              id: "unrelated",
              taskId: "other",
              goal: "Unrelated assignment",
              status: "cancelled",
            },
            {
              id: "linked",
              taskId: "delegated",
              goal,
              status: "needs_review",
            },
          ]}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const disclosures = [
    ...html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g),
  ].map(([markup]) => markup);
  expect(disclosures[0]).toContain("Cancelled");
  expect(disclosures[0]).toContain("Confirm project address</p>");
  expect(disclosures[0]).not.toContain(goal);
  expect(disclosures[1]).toContain("Needs review");
  expect(disclosures[1]).toContain(goal);
  expect(disclosures[1]).not.toContain("Unrelated assignment");
  expect(disclosures.slice(0, 2).join("")).not.toMatch(
    /<details[^>]*\bopen(?:=|\s|>)/,
  );
});
