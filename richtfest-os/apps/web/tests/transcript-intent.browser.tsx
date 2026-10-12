import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient as client } from "../src/query";
import { Transcript } from "../src/components/project-workspace/transcript";

/** Run through Vite: import('/tests/transcript-intent.browser.tsx').then(m => m.testTranscriptIntent()) */
export async function testTranscriptIntent() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;background:white;z-index:9999";
  document.body.append(host);
  const root = createRoot(host);
  const previousReadiness = client.getQueryData(["/agent/readiness"]);
  const originalFetch = window.fetch;
  const conversationId = "intent-test";
  const path = `/api/knowledge/conversations/${conversationId}`;
  let messages: {
    id: string;
    body: string;
    actorKind: string;
    createdAt: string;
  }[] = [];
  let executions: { url: string; body: any }[] = [];
  window.fetch = async (input, options) => {
    const url = String(input);
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    const reply = (data: unknown) => Response.json({ data });
    if (url === "/api/agent/readiness")
      return reply({
        executionAvailable: true,
        provider: "openai",
        supervisor: {
          enabled: true,
          presets: [{ effort: "medium", configured: true }],
        },
      });
    if (url.startsWith(`${path}/messages`)) {
      if (options?.method === "POST") {
        const message = {
          id: crypto.randomUUID(),
          body: body.body,
          actorKind: "user",
          createdAt: new Date().toISOString(),
        };
        messages.push(message);
        return reply(message);
      }
      return reply({ items: messages, nextCursor: null, unreadCount: 0 });
    }
    if (url === `${path}/read`) return reply(body);
    if (
      url === "/api/knowledge/runs" ||
      url === "/api/knowledge/runs/active/steer"
    ) {
      executions.push({ url, body });
      return reply({ id: "result" });
    }
    return originalFetch(input, options);
  };
  const settle = async () => {
    const deadline = Date.now() + 3000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (Date.now() > deadline) throw new Error("Transcript did not settle");
    } while (client.isFetching() || client.isMutating());
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  try {
    for (const active of [false, true]) {
      for (const scenario of [
        { body: "super", execute: false, celebrate: true },
        { body: "  Danke!  ", execute: false, celebrate: true },
        { body: "super, now check the roof", execute: true, celebrate: false },
        {
          body: "Danke, das funktioniert nicht.",
          execute: true,
          celebrate: false,
        },
        { body: "That worked?", execute: true, celebrate: false },
        { body: "continue", execute: true, celebrate: false },
        { body: "super", attach: true, execute: true, celebrate: true },
      ]) {
        flushSync(() => root.render(null));
        await settle();
        client.removeQueries({ queryKey: ["/agent/readiness"] });
        client.removeQueries({
          queryKey: [`/knowledge/conversations/${conversationId}`],
        });
        messages = [];
        executions = [];
        flushSync(() =>
          root.render(
            <QueryClientProvider client={client}>
              <MemoryRouter initialEntries={["/?sourceVersion=source-version"]}>
                <Transcript
                  projectId="intent-project"
                  conversationId={conversationId}
                  conversationTitle="Intent check"
                  runs={
                    active
                      ? [
                          {
                            id: "active",
                            conversationId,
                            provider: "openai",
                            status: "running",
                            goal: "Review sources",
                            createdAt: new Date().toISOString(),
                          },
                        ]
                      : []
                  }
                />
              </MemoryRouter>
            </QueryClientProvider>,
          ),
        );
        await settle();
        if (scenario.attach) {
          const attach = [...host.querySelectorAll("button")].find(
            (button) => button.textContent === "Attach open source revision",
          );
          if (!attach) throw new Error("Missing attach-source control");
          flushSync(() => attach.click());
        }
        const textarea = host.querySelector("textarea")!;
        flushSync(() => {
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )!.set!.call(textarea, scenario.body);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
        textarea.form!.requestSubmit();
        await settle();
        const label = `${active ? "active" : "idle"}: ${scenario.body}${scenario.attach ? " + source" : ""}`;
        if (
          messages.length !== 1 ||
          messages[0]!.body !== scenario.body ||
          textarea.value !== ""
        )
          throw new Error(
            `${label}: message must be saved and composer cleared`,
          );
        if (!host.textContent?.includes(scenario.body.trim()))
          throw new Error(`${label}: saved message missing from transcript`);
        if (
          Boolean(host.querySelector(".richtfest-celebration")) !==
          scenario.celebrate
        )
          throw new Error(`${label}: incorrect acknowledgement feedback`);
        if (executions.length !== Number(scenario.execute))
          throw new Error(
            `${label}: expected ${Number(scenario.execute)} executions, got ${executions.length}`,
          );
        if (scenario.execute) {
          const execution = executions[0]!;
          if (
            execution.url !==
              (active
                ? "/api/knowledge/runs/active/steer"
                : "/api/knowledge/runs") ||
            execution.body.messageId !== messages[0]!.id
          )
            throw new Error(
              `${label}: wrong execution target or saved message`,
            );
          if (
            scenario.attach &&
            execution.body.sourceVersionIds[0] !== "source-version"
          )
            throw new Error(`${label}: attached source not forwarded`);
        }
      }
    }
    return "PASS: 14 idle/active cases; acknowledgements saved and celebrated without execution; instructions, questions, complaints and attached sources still start/steer runs";
  } finally {
    root.unmount();
    await settle();
    client.removeQueries({
      queryKey: [`/knowledge/conversations/${conversationId}`],
    });
    client.removeQueries({ queryKey: ["/agent/readiness"] });
    if (previousReadiness)
      client.setQueryData(["/agent/readiness"], previousReadiness);
    window.fetch = originalFetch;
    host.remove();
  }
}
