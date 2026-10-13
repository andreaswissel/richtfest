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
    supervisor: { enabled: true, presets: [] },
  };
  client.setQueryData(["/agent/readiness"], readiness);
  client.setQueryData([path, "messages"], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [""],
  });
  const runs: any[] = [];
  const sent: any[] = [];
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
    if (url === `/api${path}/read`) return Response.json({ data: {} });
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
      ? document.querySelector<HTMLElement>('[role="dialog"]')!
      : host;
  return {
    host,
    runs,
    sent,
    scope,
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
      [...scope().querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((b) => b.textContent === value)!
        .click();
      await settle();
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
        assert(
          f.scope().querySelector('[role="radio"][aria-checked="true"]')
            ?.textContent === "Suggest",
          `${kind}: Suggest must default`,
        );
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
            await f.submit();
            assert(
              f.runs.length === 0,
              "Report without sources must stay blocked",
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
  return "PASS: 16 composer/modal scenarios; default, explicit override, confirmation, fallback, stale drafts and close fencing";
}
