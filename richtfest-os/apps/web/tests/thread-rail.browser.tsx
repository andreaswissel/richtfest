import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { ThreadRail } from "../src/components/project-workspace/thread-rail";

/** Run through Vite: import('/tests/thread-rail.browser.tsx').then(m => m.testThreadArchive()) */
export async function testThreadArchive() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const originalFetch = window.fetch;
  const conversation = {
    id: "archive-test",
    title: "Planning review",
    archivedAt: null as string | null,
  };
  let releaseSave = () => {};
  let releaseRefresh = () => {};
  let save = Promise.resolve();
  let refresh = Promise.resolve();
  let rejectSave = false;
  const waitFor = async (condition: () => boolean, message: string) => {
    const deadline = Date.now() + 2000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  window.fetch = async (input, options) => {
    if (String(input) !== "/api/knowledge/conversations/archive-test/archive")
      return originalFetch(input, options);
    await save;
    if (rejectSave)
      return Response.json({ message: "Archive denied" }, { status: 403 });
    conversation.archivedAt = JSON.parse(String(options?.body)).archived
      ? "2026-10-13T12:00:00Z"
      : null;
    return Response.json({ data: { ...conversation } });
  };
  function Workspace() {
    const workspace = useQuery({
      queryKey: ["/knowledge/workspaces/archive-project"],
      initialData: { conversations: [{ ...conversation }] },
      staleTime: Infinity,
      queryFn: async () => {
        await refresh;
        return { conversations: [{ ...conversation }] };
      },
    });
    useQuery({
      queryKey: ["/knowledge/conversations?projectId=archive-project"],
      initialData: [{ ...conversation }],
      staleTime: Infinity,
      queryFn: async () => {
        await refresh;
        return [{ ...conversation }];
      },
    });
    return (
      <ThreadRail
        projectId="archive-project"
        selectedId={conversation.id}
        conversations={workspace.data.conversations}
        artifactCount={0}
        taskCount={0}
        onCreate={() => {}}
      />
    );
  }
  const action = () =>
    host.querySelector<HTMLButtonElement>(
      ".thread-rail-row button:last-child",
    )!;
  const isArchived = () =>
    Boolean(host.querySelector(".thread-rail-archived .thread-rail-row"));
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Workspace />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    for (const archived of [true, false]) {
      save = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      refresh = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      action().click();
      await waitFor(
        () => action().disabled,
        "Action must remain pending until the save succeeds",
      );
      if (isArchived() === archived)
        throw new Error("Archive state changed before the save succeeded");
      releaseSave();
      await waitFor(
        () => isArchived() === archived,
        "Saved thread must move to the correct section",
      );
      await waitFor(
        () => !action().disabled,
        "Successful save must release the action without waiting for refreshes",
      );
      if (client.isFetching() !== 2)
        throw new Error(
          "Both refreshes must still be held for this regression check",
        );
      releaseRefresh();
      await waitFor(
        () => client.isFetching() === 0,
        "Background refreshes must complete",
      );
    }
    rejectSave = true;
    action().click();
    await waitFor(
      () => host.textContent!.includes("Archive denied"),
      "Failed save must display its error",
    );
    if (isArchived() || action().disabled)
      throw new Error(
        "Failed save must preserve the active thread and allow retry",
      );
    return "PASS: archive and restore wait for save, not slow refreshes; failed save preserves thread and permits retry";
  } finally {
    releaseSave();
    releaseRefresh();
    root.unmount();
    client.clear();
    window.fetch = originalFetch;
    host.remove();
  }
}
