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
