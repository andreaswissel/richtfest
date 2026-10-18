import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectPlanning, ProjectPlanningItem } from "@richtfest/shared";
import { ProjectOverview } from "../src/components/project-workspace/project-overview";
import en from "../src/locales/en.json";
import de from "../src/locales/de.json";

const item = (
  id: string,
  title: string,
  patch: Partial<ProjectPlanningItem> = {},
): ProjectPlanningItem => ({
  id,
  title,
  phase: "concept",
  discipline: "physics",
  kind: "deliverable",
  status: "open",
  owner: "",
  dueDate: null,
  notes: "",
  module: "building-model",
  dependsOn: [],
  archived: false,
  ...patch,
});
function render(
  items: ProjectPlanningItem[],
  query = "phase=concept",
  perspective: "coordinator" | "planner" = "planner",
  writable = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData<ProjectPlanning>(["/projects/p1/planning"], {
    revision: 3,
    currentPhase: "brief",
    items,
  });
  client.setQueryData(["/auth/me"], {
    permissions: writable ? ["projects:write"] : [],
  });
  const router = createMemoryRouter(
    [
      {
        path: "/projects/:id",
        element: (
          <QueryClientProvider client={client}>
            <ProjectOverview
              projectId="p1"
              projectName="Real project"
              perspective={perspective}
            />
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: [`/projects/p1?view=overview&${query}`] },
  );
  try {
    return renderToStaticMarkup(<RouterProvider router={router} />);
  } finally {
    router.dispose();
  }
}

test("empty phases show no entries, never invented readiness, and do not offer writes to readers", () => {
  const html = render([item("other", "Another phase", { phase: "permit" })]);
  expect(html).toContain("No planning entries in this scope.");
  expect(html).not.toContain("Another phase");
  expect(html).not.toContain("Add planning entry");
  expect(html).not.toContain("Change current phase");
  expect(html).not.toContain("ready");
  expect(html).toContain(
    "Completed planning tasks are not engineering approvals.",
  );
});

test("planner defaults to physics, filters phases and archives, and retains scope in real module links", () => {
  const html = render(
    [
      item("shown", "Physics concept", { status: "done" }),
      item("other-phase", "Permit secret", { phase: "permit" }),
      item("other-domain", "Structure secret", { discipline: "structure" }),
      item("archived", "Archived secret", { archived: true }),
    ],
    "phase=concept&planningItem=shown",
  );
  expect(html).toContain("Physics concept");
  expect(html).toContain("Completed");
  expect(html).not.toContain("Permit secret");
  expect(html).not.toContain("Structure secret");
  expect(html).not.toContain("Archived secret");
  expect(html).toContain(
    "view=location&amp;phase=concept&amp;planningItem=shown&amp;perspective=planner&amp;discipline=physics",
  );
  expect(html).toContain("view=building-model");
});

test("coordinator includes real cross-phase prerequisites without leaking unrelated phase records", () => {
  const html = render(
    [
      item("package", "Concept package", { dependsOn: ["prerequisite"] }),
      item("prerequisite", "Survey prerequisite", {
        phase: "plot",
        status: "done",
      }),
      item("unrelated", "Unrelated permit milestone", {
        phase: "permit",
        kind: "milestone",
      }),
      item("decision", "Actual decision", {
        kind: "decision",
        discipline: "structure",
      }),
    ],
    "phase=concept",
    "coordinator",
    true,
  );
  expect(html).toContain("Survey prerequisite");
  expect(html).toContain("Actual decision");
  expect(html).not.toContain("Unrelated permit milestone");
  expect(html).toContain("Disciplines in this phase");
  expect(html).toContain("Add planning entry");
  expect(html).toContain("Change current phase");
});

test("out-of-scope URL selection never exposes another phase's notes", () => {
  const html = render(
    [
      item("selected", "Wrong phase title", {
        phase: "permit",
        notes: "Wrong phase notes",
      }),
      item("valid", "Valid concept"),
    ],
    "phase=concept&planningItem=selected",
  );
  expect(html).not.toContain("Wrong phase title");
  expect(html).not.toContain("Wrong phase notes");
  expect(html).toContain("Valid concept");
});

test("invalid dates render safely and planning translations have English/German parity", () => {
  expect(
    render([item("date", "Undated", { dueDate: "2026-02-31" })]),
  ).toContain("Not assigned");
  const keys = (value: object) =>
    Object.keys(value)
      .filter((key) => key.startsWith("planning"))
      .sort();
  expect(keys(de)).toEqual(keys(en));
  expect(de.planningOverview).toBe("Projektübersicht");
  expect(de.planningPlannerOverview).toBe("Fachübersicht");
  expect(de.planningNotApproval).toContain("keine fachtechnischen Freigaben");
});
