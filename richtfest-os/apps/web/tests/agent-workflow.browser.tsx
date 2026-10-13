import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient as client } from "../src/query";
import { Transcript } from "../src/components/project-workspace/transcript";
import { AgentRuns } from "../src/components/agent-runs";

const settle = () => new Promise((r) => setTimeout(r, 100));
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};

/** Actual composers, synthetic API responses; never starts paid work or writes records. */
export async function mountWorkflowFixture(kind: "chat" | "goal" = "chat") {
  const host = document.createElement("section");
  host.style.cssText =
    "position:fixed;inset:24px;z-index:40;background:var(--background);display:grid;grid-template-rows:auto minmax(0,1fr);border:1px solid var(--border);padding:16px";
  host.innerHTML = "<h1>Mode selection · synthetic browser verification</h1>";
  const content = document.createElement("div");
  content.style.cssText = "display:grid;min-height:0";
  host.append(content);
  document.body.append(host);
  const root = createRoot(content);
  const projectId = crypto.randomUUID(),
    conversationId = crypto.randomUUID();
  const path = `/knowledge/conversations/${conversationId}`;
  const originalFetch = window.fetch;
  const priorReadiness = client.getQueryData(["/agent/readiness"]);
  const readiness = {
    executionAvailable: true,
    provider: "openai",
    supervisor: {
      enabled: true,
      presets: [
        { effort: "low", configured: true },
        { effort: "medium", configured: false },
        { effort: "high", configured: true },
      ],
    },
  };
  client.setQueryData(["/agent/readiness"], readiness);
  client.setQueryData([path, "messages"], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [""],
  });
  const runs: any[] = [];
  const sent: any[] = [];
  const reads: any[] = [];
  let calls = 0,
    choice = "chat",
    delay = 0,
    fail = false;
  window.fetch = async (input, options) => {
    const url = String(input);
    if (url === "/api/knowledge/mode-recommendation") {
      calls++;
      const selected = choice,
        failure = fail;
      await new Promise((r) => setTimeout(r, delay));
      return failure
        ? Response.json({ message: "Synthetic failure" }, { status: 503 })
        : Response.json({
            data: {
              version: "fixture",
              outcome: "classified",
              recommendation: selected,
              confidence: 0.99,
            },
          });
    }
    if (url.startsWith(`/api${path}/messages`)) {
      if (options?.method === "POST") {
        const message = {
          ...JSON.parse(String(options.body)),
          id: crypto.randomUUID(),
          actorKind: "human",
          createdAt: new Date().toISOString(),
        };
        sent.push(message);
        return Response.json({ data: message });
      }
      return Response.json({ data: { items: sent, nextCursor: null } });
    }
    if (url === `/api${path}/read`) {
      const state = JSON.parse(String(options?.body));
      reads.push(state);
      return Response.json({ data: state });
    }
    if (url === "/api/knowledge/runs") {
      const run = JSON.parse(String(options?.body));
      runs.push(run);
      return Response.json({
        data: { ...run, id: crypto.randomUUID(), status: "needs_review" },
      });
    }
    if (url === "/api/agent/readiness")
      return Response.json({ data: readiness });
    if (url.startsWith(`/api/projects/${projectId}/files`))
      return Response.json({ data: [] });
    if (url === `/api/knowledge/workspaces/${projectId}`)
      return Response.json({ data: { runs: [], conversations: [] } });
    return originalFetch(input, options);
  };
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          {kind === "chat" ? (
            <Transcript
              projectId={projectId}
              conversationId={conversationId}
              conversationTitle="Workflow verification"
            />
          ) : (
            <AgentRuns
              projectId={projectId}
              conversationId={conversationId}
              initialRuns={[]}
            />
          )}
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
  if (kind === "goal") {
    (host.querySelector("button") as HTMLButtonElement).click();
    await settle();
  }
  const scope = () =>
    kind === "goal"
      ? document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!
      : host;
  const options = async (open: boolean) => {
    if (kind !== "chat") return scope();
    if (open)
      host
        .querySelector<HTMLButtonElement>('[aria-label="Chat options"]')!
        .click();
    else
      document
        .querySelector<HTMLButtonElement>(
          '.workspace-composer-dialog [data-slot="dialog-close"]',
        )!
        .click();
    await settle();
    return document.querySelector<HTMLElement>(".workspace-composer-dialog")!;
  };
  return {
    host,
    runs,
    sent,
    reads,
    scope,
    options,
    calls: () => calls,
    response: (next: string, ms = 0, error = false) => {
      choice = next;
      delay = ms;
      fail = error;
    },
    async fill(value: string) {
      const field = scope().querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    },
    async mode(value: string) {
      const controls = await options(true);
      [...controls.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((b) => b.textContent === value)!
        .click();
      await settle();
      if (kind === "chat") await options(false);
    },
    async submit() {
      scope().querySelector("form")!.requestSubmit();
      await settle();
    },
    async close() {
      root.unmount();
      await settle();
      window.fetch = originalFetch;
      client.removeQueries({ queryKey: [path, "messages"] });
      client.removeQueries({ queryKey: ["/agent/readiness"] });
      if (priorReadiness)
        client.setQueryData(["/agent/readiness"], priorReadiness);
      host.remove();
    },
  };
}

/** Run through Vite: import('/tests/agent-workflow.browser.tsx').then(m => m.testWorkflowDefault()). */
export async function testWorkflowDefault() {
  for (const kind of ["chat", "goal"] as const) {
    for (const scenario of [
      "chat",
      "team",
      "report",
      "uncertain",
      "failure",
      "explicit",
      "stale",
      "close",
    ] as const) {
      const f = await mountWorkflowFixture(kind);
      try {
        if (kind === "chat") {
          assert(
            !f.scope().querySelector('[role="radio"]'),
            "Default composer must hide mode controls",
          );
          assert(
            !f.scope().querySelector("select"),
            "Default composer must hide effort controls",
          );
        }
        const controls = await f.options(true);
        assert(
          controls.querySelector('[role="radio"][aria-checked="true"]')
            ?.textContent === "Suggest",
          `${kind}: Suggest must default`,
        );
        if (kind === "chat") {
          assert(
            controls.querySelector<HTMLSelectElement>("select")?.value ===
              "low",
            "Use the first configured effort when Medium is unavailable",
          );
          await f.options(false);
        }
        await f.fill("Find acoustic references");
        assert(f.calls() === 0, "Typing must not classify");
        f.response(
          ["team", "report", "uncertain"].includes(scenario)
            ? scenario
            : "chat",
          ["stale", "close"].includes(scenario) ? 500 : 0,
          scenario === "failure",
        );
        if (scenario === "explicit") await f.mode("Chat");
        await f.submit();
        if (scenario === "close") {
          if (kind === "goal") {
            f.scope()
              .querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
              .click();
            await new Promise((r) => setTimeout(r, 600));
            assert(f.runs.length === 0, "Closed dialog must not submit late");
          } else {
            await f.close();
            await new Promise((r) => setTimeout(r, 600));
            assert(
              f.sent.length === 0,
              "Unmounted thread must not submit late",
            );
            continue;
          }
        } else if (scenario === "stale") {
          await f.fill("Changed request");
          await f.fill("Find acoustic references");
          await new Promise((r) => setTimeout(r, 600));
          assert(
            f.runs.length === 0 && f.sent.length === 0,
            "Edited-then-restored draft must discard late suggestion",
          );
        } else if (scenario === "team" || scenario === "report") {
          assert(
            f.runs.length === 0 && f.sent.length === 0,
            "Escalation must not submit a message or run",
          );
          const apply = [
            ...f.scope().querySelectorAll<HTMLButtonElement>("button"),
          ].find((b) => b.textContent === "Apply mode");
          assert(apply, "Escalation must offer Apply");
          if (kind === "chat")
            assert(
              apply!.closest(".project-transcript"),
              "Recommendation must appear in the conversation, not composer",
            );
          if (kind === "chat") {
            await new Promise((resolve) => setTimeout(resolve, 800));
            assert(
              f.reads.length > 0 &&
                f.reads.every(
                  (state) =>
                    !state.lastReadMessageId && !state.meaningfulMessageId,
                ),
              "An unsent suggestion must never become a saved message/reader target",
            );
          }
          apply!.click();
          await settle();
          assert(f.runs.length === 0, "Apply must not start execution");
          if (scenario === "team") {
            await f.submit();
            assert(
              f.runs[0]?.workflow.mode === "team",
              "Explicit confirmation must use Team",
            );
          } else {
            if (kind === "chat") {
              assert(
                !document.querySelector(".workspace-composer-dialog"),
                "Report approval must not force template or source settings",
              );
            }
            await f.submit();
            assert(
              f.runs.length === 1 &&
                f.runs[0].workflow.mode === "report" &&
                !f.runs[0].workflow.reportTemplate &&
                f.runs[0].sourceVersionIds.length === 0,
              "Report must request automatic evidence and format selection",
            );
          }
        } else {
          assert(
            f.runs.length === 1 && f.runs[0].workflow.mode === "chat",
            `${kind}/${scenario}: must start one Chat run`,
          );
          assert(
            f.calls() === (scenario === "explicit" ? 0 : 1),
            "One preflight, explicit override bypasses Jev",
          );
        }
      } finally {
        if (f.host.isConnected) await f.close();
      }
    }
  }
  const f = await mountWorkflowFixture();
  try {
    await f.fill("Investigate the project");
    f.response("team");
    await f.submit();
    const useChat = [
      ...f.host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Use Chat instead");
    assert(useChat, "Team suggestion must offer a Chat alternative");
    useChat!.click();
    await settle();
    assert(f.runs.length === 0, "Choosing Chat must not execute before Send");
    await f.submit();
    assert(
      f.runs.length === 1 && f.runs[0].workflow.mode === "chat",
      "Declining escalation must submit as Chat",
    );
  } finally {
    await f.close();
  }
  return "PASS: 17 composer/modal scenarios; compact defaults, inline recommendations, explicit override, confirmation, Chat alternative, fallback, stale drafts and close fencing";
}
