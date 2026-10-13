import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient as client } from "../src/query";
import { Transcript } from "../src/components/project-workspace/transcript";
import { SubagentThread } from "../src/components/project-workspace/subagent-thread";

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
const paragraph =
  "Synthetic planning review: compare the source revision, record the missing dimensions, and keep proposed findings separate from approved evidence.";

/** Real chat components with synthetic query responses; no provider or database writes. */
export async function mountChatScrollFixture(
  kind: "main" | "subagent",
  target?: string,
  restore = false,
) {
  const host = document.createElement("section");
  host.style.cssText =
    "position:fixed;inset:24px;background:var(--background);z-index:9999;display:grid;grid-template-rows:auto minmax(0,1fr);border:1px solid var(--border)";
  const heading = document.createElement("h1");
  heading.className = "p-page text-ui-lg";
  heading.textContent = `Synthetic ${kind} chat · streaming scroll check`;
  const content = document.createElement("div");
  content.style.cssText = "display:grid;min-height:0";
  host.append(heading, content);
  document.body.append(host);
  const root = createRoot(content);
  const conversationId = "scroll-fixture";
  const projectId = "scroll-project";
  const runId = "scroll-run";
  const path = `/knowledge/conversations/${conversationId}`;
  let messages = Array.from({ length: 24 }, (_, i) => ({
    id: `scroll-message-${i}`,
    body: `${i + 1}. ${paragraph}\n\n${paragraph}`,
    actorKind: i % 2 ? "agent" : "user",
    createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
  }));
  let run = {
    id: runId,
    projectId,
    status: "completed",
    goal: "Review synthetic project evidence",
    outputSummary: messages.map((m) => m.body).join("\n\n"),
  };
  const originalFetch = window.fetch;
  const previousReadiness = client.getQueryData(["/agent/readiness"]);
  client.setQueryData(["/agent/readiness"], { executionAvailable: false });
  const page = () => ({ items: messages, nextCursor: null, unreadCount: 0 });
  window.fetch = async (input, options) => {
    const url = String(input);
    if (url.startsWith(`/api${path}/messages`))
      return Response.json({ data: page() });
    if (url === `/api${path}/read`) return Response.json({ data: {} });
    if (url === `/api/knowledge/runs/${runId}`)
      return Response.json({ data: { run } });
    return originalFetch(input, options);
  };
  client.setQueryData([path, "messages"], {
    pages: [page()],
    pageParams: [""],
  });
  client.setQueryData([`/knowledge/runs/${runId}`], { run });
  const publish = () => {
    if (kind === "main")
      client.setQueryData([path, "messages"], {
        pages: [page()],
        pageParams: [""],
      });
    else client.setQueryData([`/knowledge/runs/${runId}`], { run });
  };
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[
            `/projects/${projectId}${target && !restore ? `?message=${target}` : ""}`,
          ]}
        >
          {kind === "main" ? (
            <Transcript
              projectId={projectId}
              conversationId={conversationId}
              conversationTitle="Scroll check"
              readState={restore ? { meaningfulMessageId: target } : undefined}
            />
          ) : (
            <SubagentThread projectId={projectId} runId={runId} />
          )}
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return {
    host,
    heading,
    viewport: host.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    )!,
    async grow() {
      messages = messages.map((m, i) =>
        i === messages.length - 1
          ? { ...m, body: `${m.body}\n\n${paragraph}` }
          : m,
      );
      run = { ...run, outputSummary: `${run.outputSummary}\n\n${paragraph}` };
      publish();
      await settle();
    },
    async append() {
      messages = [
        ...messages,
        {
          id: `scroll-message-${messages.length}`,
          body: paragraph,
          actorKind: "user",
          createdAt: new Date(2026, 0, 1, 1, messages.length).toISOString(),
        },
        {
          id: `scroll-message-${messages.length + 1}`,
          body: paragraph,
          actorKind: "agent",
          createdAt: new Date(2026, 0, 1, 1, messages.length + 1).toISOString(),
        },
      ];
      run = { ...run, outputSummary: `${run.outputSummary}\n\n${paragraph}` };
      publish();
      await settle();
    },
    async close() {
      root.unmount();
      await settle();
      client.removeQueries({ queryKey: [path] });
      client.removeQueries({ queryKey: [`/knowledge/runs/${runId}`] });
      client.removeQueries({ queryKey: ["/agent/readiness"] });
      if (previousReadiness)
        client.setQueryData(["/agent/readiness"], previousReadiness);
      window.fetch = originalFetch;
      host.remove();
    },
  };
}

/** Run through Vite: import('/tests/chat-scroll.browser.tsx').then(m => m.testChatScroll()) */
export async function testChatScroll() {
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  for (const kind of ["main", "subagent"] as const) {
    const fixture = await mountChatScrollFixture(kind);
    const { viewport, host } = fixture;
    const gap = () =>
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    const latest = () =>
      host.querySelector<HTMLButtonElement>(".workspace-jump button");
    const select = (node: Node) => {
      const range = document.createRange();
      // A partial text selection reproduces native browser scroll anchoring.
      const text = node.firstChild!;
      range.setStart(text, 3);
      range.setEnd(text, Math.min(35, text.textContent!.length));
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    };
    try {
      assert(
        viewport.scrollHeight > viewport.clientHeight * 2,
        `${kind}: fixture must overflow`,
      );
      assert(gap() <= 8, `${kind}: opens at latest (gap ${gap()})`);
      await fixture.grow();
      assert(gap() <= 8, `${kind}: growing reply stays at latest`);
      viewport.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 100, bubbles: true }),
      );
      viewport.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      await fixture.grow();
      assert(
        gap() <= 8,
        `${kind}: downward wheel and Tab must not stop following`,
      );
      viewport.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -300, bubbles: true }),
      );
      viewport.scrollTop -= 300;
      await settle();
      const readingTop = viewport.scrollTop;
      await fixture.grow();
      await fixture.append();
      assert(
        Math.abs(viewport.scrollTop - readingTop) <= 2,
        `${kind}: growth and new user turn must not steal reading position`,
      );
      assert(Boolean(latest()), `${kind}: Latest appears when reading history`);
      latest()!.click();
      await settle();
      await fixture.grow();
      assert(gap() <= 8, `${kind}: Latest resumes continued following`);
      select(fixture.heading);
      await settle();
      await fixture.grow();
      assert(
        gap() <= 8 && !latest(),
        `${kind}: selection outside chat must not pause it`,
      );
      window.getSelection()!.removeAllRanges();
      const text = [...viewport.querySelectorAll("p")].at(-1)!;
      select(text);
      await settle();
      const selectedTop = viewport.scrollTop;
      const selectedText = window.getSelection()!.toString();
      await fixture.grow();
      assert(
        Math.abs(viewport.scrollTop - selectedTop) <= 2,
        `${kind}: selected text stays still`,
      );
      assert(
        window.getSelection()!.toString() === selectedText,
        `${kind}: streamed growth preserves selection`,
      );
      latest()!.click();
      await settle();
      await fixture.grow();
      assert(gap() <= 8, `${kind}: Latest resumes after selection`);
      window.getSelection()!.removeAllRanges();
      viewport.scrollTop -= 250;
      await settle();
      viewport.scrollTop = viewport.scrollHeight;
      await settle();
      await fixture.grow();
      assert(
        gap() <= 8,
        `${kind}: manually returning to bottom resumes following`,
      );
    } finally {
      window.getSelection()?.removeAllRanges();
      await fixture.close();
    }
  }
  for (const restore of [false, true]) {
    const linked = await mountChatScrollFixture(
      "main",
      "scroll-message-2",
      restore,
    );
    try {
      const before = linked.viewport.scrollTop;
      await linked.grow();
      assert(
        Math.abs(linked.viewport.scrollTop - before) <= 2,
        "message deep link / saved position must not start following",
      );
      assert(
        linked.viewport.scrollHeight - linked.viewport.clientHeight - before >
          100,
        "deep link / saved position must stay away from latest",
      );
    } finally {
      await linked.close();
    }
  }
  return "PASS: main + subagent follow growth, pause on scroll-away/selection, ignore unrelated selection and keys, resume via Latest/manual bottom, preserve deep links";
}
