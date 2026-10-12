import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactPanel } from "../src/components/project-workspace/artifacts";
import { usePreferences } from "../src/store";

/** Run through Vite: import('/tests/document-review.browser.tsx').then(m => m.testDocumentReview()) */
export async function testDocumentReview() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const previousPreferences = usePreferences.getState();
  usePreferences.getState().hydrate({ language: "en" });
  const originalFetch = window.fetch;
  let saved: Record<string, any> | undefined;
  const artifact = {
    id: "artifact-review-test",
    projectId: "review-test",
    conversationId: "thread-test",
    title: "Acoustic planning draft",
    type: "report",
    status: "draft",
  };
  const revision = {
    id: "revision-test",
    version: 2,
    title: "Preliminary measures",
    content: "## Scope\n\nReview **windows**. Review windows.",
    sourceVersionIds: ["source-test"],
    sourceReferences: [
      { versionId: "source-test", fileName: "Facade.pdf", version: 1 },
    ],
  };
  const record = {
    artifact,
    revisions: [revision, { ...revision, id: "old-revision-test", version: 1 }],
    annotations: [] as Record<string, any>[],
  };
  client.setQueryData(["/knowledge/artifacts/artifact-review-test"], record);
  client.setQueryData(
    ["/projects/review-test/files/file-test/versions"],
    [
      {
        id: "source-test",
        version: 1,
        status: "ready",
        mimeType: "application/octet-stream",
      },
    ],
  );
  client.setQueryData(
    [
      "/knowledge/projects/review-test/sources/source-test/content?pageStart=1&pageEnd=1",
    ],
    { content: { status: "unavailable" } },
  );
  window.fetch = async (input, options) => {
    if (String(input) === "/api/knowledge/annotations") {
      saved = JSON.parse(String(options?.body));
      return Response.json({ data: { message: { id: "message-test" } } });
    }
    return originalFetch(input, options);
  };
  const check = (condition: unknown, reason: string) => {
    if (!condition) throw new Error(reason);
  };
  const wait = async (predicate: () => unknown) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Document review did not settle");
  };
  let mountId = 0;
  const mount = (query: string) =>
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter
            key={++mountId}
            initialEntries={[
              `/projects/review-test?conversation=thread-test&${query}`,
            ]}
          >
            <ArtifactPanel
              projectId="review-test"
              conversationId="thread-test"
              artifacts={[]}
              runs={[]}
              tasks={[]}
              initialFiles={[
                { id: "file-test", name: "site-plan.afpub", version: 1 },
              ]}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  try {
    // These checks moved from SSR because document content now lives in a modal portal.
    mount("panel=documents&file=file-test&sourceVersion=source-test");
    await wait(() => dialog()?.querySelector(".affinity-publisher-preview"));
    check(
      dialog().querySelector("img")?.getAttribute("src") ===
        "/api/projects/review-test/files/file-test/versions/1/preview",
      "Publisher uses the visual preview endpoint",
    );
    check(
      dialog().querySelector("img")?.alt ===
        "Affinity Publisher preview: site-plan.afpub",
      "Publisher preview remains labelled",
    );
    check(
      dialog().querySelector(
        'a[href="/api/projects/review-test/files/file-test/versions/1/download"]',
      ),
      "Original download remains accessible",
    );

    mount(
      "panel=artifacts&artifact=artifact-review-test&revision=revision-test",
    );
    await wait(() => dialog()?.querySelector(".artifact-content strong"));
    check(
      dialog().textContent?.includes("Save as PDF"),
      "Revision keeps PDF export",
    );
    check(
      dialog().querySelector('a[href*="sourceVersion=source-test"]')
        ?.textContent === "Facade.pdf · v1",
      "Source register links the exact source version",
    );
    check(
      dialog().querySelector('a[href*="sourceVersion=source-test"]')
        ?.getAttribute("href")?.includes("conversation=thread-test"),
      "Opening a source reference must retain the document's thread",
    );
    const documentText = dialog().querySelector(".artifact-content")!;
    const range = document.createRange();
    range.setStart(documentText.querySelector("h2")!.firstChild!, 0);
    range.setEnd(documentText.querySelector("strong")!.firstChild!, 7);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    flushSync(() =>
      documentText.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })),
    );
    const quote =
      dialog().querySelector<HTMLTextAreaElement>('[name="quote"]')!;
    check(
      quote.value === "Scope\nReview windows",
      "Cross-block selection must preserve its newline",
    );
    const comment =
      dialog().querySelector<HTMLTextAreaElement>("textarea[required]")!;
    // Use the native setter so React receives a real input change.
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(comment, "Verify this scope before continuing.");
    flushSync(() =>
      comment.dispatchEvent(new Event("input", { bubbles: true })),
    );
    dialog()
      .querySelector<HTMLFormElement>(".annotation-form")!
      .requestSubmit();
    await wait(() => saved);
    check(
      saved?.quote === "Scope\nReview windows" &&
        saved?.selection?.start === 0 &&
        saved?.selection?.end === 20,
      "Saved comment must anchor across heading, paragraph and bold text",
    );
    check(
      saved?.artifactRevisionId === "revision-test" &&
        saved?.conversationId === "thread-test",
      "Comment belongs to the exact revision and thread",
    );
    client.setQueryData(["/knowledge/artifacts/artifact-review-test"], {
      ...record,
      annotations: [{ ...saved, id: "note-test" }],
    });
    mount(
      "panel=artifacts&artifact=artifact-review-test&revision=revision-test",
    );
    await wait(() => CSS.highlights.get("artifact-comments")?.size === 1);
    check(
      [...CSS.highlights.get("artifact-comments")!][0].toString() ===
        "Scope\nReview windows",
      "Saved anchor must restore the exact marked passage after remount",
    );
    mount(
      "panel=artifacts&artifact=artifact-review-test&revision=old-revision-test",
    );
    await wait(() => dialog()?.querySelector(".artifact-content strong"));
    check(
      !dialog().textContent?.includes("Verify this scope before continuing."),
      "Comments must not leak into another revision with identical content",
    );
    check(
      !CSS.highlights.get("artifact-comments")?.size,
      "Highlights must not leak into another revision",
    );
    return "PASS: Publisher preview/download, revision PDF export and source links, cross-block selection, saved exact anchor, revision isolation";
  } finally {
    root.unmount();
    client.clear();
    window.fetch = originalFetch;
    usePreferences.getState().hydrate(previousPreferences);
    host.remove();
  }
}
