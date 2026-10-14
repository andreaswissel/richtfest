import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentRunRetryActions } from "../src/components/agent-run-retry-actions";
import { Input } from "../src/components/ui/input";
import { usePreferences } from "../src/store";

/** Vite: import('/tests/run-retry.browser.tsx').then(m => m.testRunRetry()) */
export async function testRunRetry(
  observe?: (
    state: "loading" | "preview" | "acknowledged" | "stale" | "fresh",
  ) => Promise<void>,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  const previousLanguage = usePreferences.getState().language;
  usePreferences.getState().setLanguage("en");
  const originalFetch = window.fetch;
  let gets = 0;
  const posts: { path: string; body: any }[] = [];
  let stale = true;
  let resumable = true;
  let generation = 1;
  let defer: ((response: Response) => void) | undefined;
  const preview = () => ({
    resumable,
    generation,
    checkpointHash: `hash-${generation}`,
    phase: generation === 1 ? "editorial" : "futurePhase",
    completedSpecialists: 2,
    totalSpecialists: 3,
    sections: [
      { key: "components", savedPieces: 2, savedFallbackPieces: 1 },
      { key: "futureSection", savedPieces: 0, savedFallbackPieces: 0 },
    ],
    savedPieces: 2,
    editorialCandidate: true,
    preservationChecked: generation > 1,
    accounting: {
      recordedCostUsd: 1.23,
      unknownOutcomes: 1,
      unpricedAttempts: 1,
    },
    budget: { maxCostUsd: 10, maxAutomaticRetries: 3 },
  });
  window.fetch = async (input, options) => {
    const path = String(input);
    if (!path.startsWith("/api/knowledge/runs/retry-fixture/"))
      throw new Error(`Unexpected request: ${path}`);
    if (path.endsWith("/recovery")) {
      gets++;
      if (gets === 4)
        return new Promise<Response>((resolve) => {
          defer = resolve;
        });
      return Response.json({ data: preview() });
    }
    posts.push({ path, body: JSON.parse(String(options?.body)) });
    if (stale)
      return Response.json(
        { error: true, message: "Checkpoint changed" },
        { status: 409 },
      );
    return Response.json({ data: { id: "retry-fixture" } });
  };
  const check = (value: unknown, reason: string) => {
    if (!value) throw new Error(reason);
  };
  const wait = async (predicate: () => unknown) => {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Retry fixture did not settle");
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const button = (label: string, scope: ParentNode = dialog() ?? host) => {
    const found = [...scope.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const acknowledge = () =>
    flushSync(() =>
      dialog()!.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click(),
    );
  const change = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
  };
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Input aria-label="Unsent draft" defaultValue="Keep this draft" />
            <AgentRunRetryActions
              run={{ id: "retry-fixture", status: "failed" }}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(
      gets === 0 && posts.length === 0,
      "Mount fetched recovery or submitted work",
    );
    flushSync(() => button("Retry run", host).click());
    await observe?.("loading");
    await wait(() => dialog()?.textContent?.includes("Building components"));
    check(gets === 1 && posts.length === 0, "Preview was not lazy/read-only");
    check(
      dialog()!.textContent!.includes("Consolidating the full report") &&
        dialog()!.textContent!.includes("Other report section") &&
        dialog()!.textContent!.includes("not an approved report") &&
        !dialog()!.textContent!.includes("futureSection"),
      "Stage, sections or editorial preservation were not explained safely",
    );
    await observe?.("preview");
    flushSync(() => usePreferences.getState().setLanguage("de"));
    check(
      dialog()!.textContent!.includes("Bauteile") &&
        dialog()!.textContent!.includes("Anderer Berichtsabschnitt") &&
        !dialog()!.textContent!.includes("editorial"),
      "German recovery labels missing",
    );
    flushSync(() => usePreferences.getState().setLanguage("en"));
    check(
      dialog()!.textContent!.includes("2/3") &&
        dialog()!.textContent!.includes("ADDITIONAL"),
      "Missing retained work or allowance explanation",
    );
    check(
      button("Retry run").disabled,
      "Unknown outcome acknowledgement was optional",
    );
    acknowledge();
    const inputs = dialog()!.querySelectorAll<HTMLInputElement>(
      'input[type="number"]',
    );
    check(
      inputs[0].value === "10" && inputs[1].value === "3",
      "Wrong server defaults",
    );
    for (const value of ["0", "1001", ""]) {
      change(inputs[0], value);
      check(button("Retry run").disabled, "Invalid cost accepted");
    }
    change(inputs[0], "12.5");
    change(inputs[1], "1.5");
    check(button("Retry run").disabled, "Fractional retries accepted");
    change(inputs[1], "0");
    await observe?.("acknowledged");
    const confirm = button("Retry run");
    flushSync(() => {
      confirm.click();
      confirm.click();
    });
    await wait(() => dialog()?.textContent?.includes("Checkpoint changed"));
    check(posts.length === 1, "Duplicate retry was sent");
    check(
      JSON.stringify(posts[0].body) ===
        JSON.stringify({
          generation: 1,
          checkpointHash: "hash-1",
          budget: { maxCostUsd: 12.5, maxAutomaticRetries: 0 },
          acknowledgeUnknownOutcomes: true,
        }),
      "Wrong retry payload",
    );
    check(
      button("Retry run").disabled && gets === 1,
      "Stale checkpoint silently resubmitted/reloaded",
    );
    await observe?.("stale");
    generation++;
    flushSync(() => button("Reload preview").click());
    await wait(() => !button("Reload preview").disabled);
    check(
      gets === 2 &&
        dialog()!.querySelector<HTMLInputElement>('input[type="number"]')!
          .value === "10" &&
        button("Retry run").disabled,
      "Reload did not reset budget/acknowledgement",
    );
    check(
      dialog()!.textContent!.includes("Other workflow stage") &&
        dialog()!.textContent!.includes("This is not human approval") &&
        !dialog()!.textContent!.includes("futurePhase"),
      "Unknown phase fallback or checked draft explanation missing",
    );
    acknowledge();
    stale = false;
    flushSync(() => button("Retry run").click());
    await wait(() => !dialog());
    check(posts[1].body.generation === 2, "Reload did not replace checkpoint");
    check(
      host.querySelector<HTMLInputElement>('[aria-label="Unsent draft"]')!
        .value === "Keep this draft",
      "Retry lost draft",
    );

    resumable = false;
    flushSync(() => button("Retry run", host).click());
    await wait(() => dialog()?.textContent?.includes("cannot resume"));
    flushSync(() => button("Retry run").click());
    await wait(() => !dialog());
    check(
      JSON.stringify(posts[2].body) === "{}",
      "Legacy retry received budget/checkpoint fields",
    );

    flushSync(() => button("Retry run", host).click());
    await wait(() => !!defer);
    check(
      dialog()!.textContent!.includes("Loading") &&
        button("Retry run").disabled &&
        button("Reload preview").disabled &&
        posts.length === 3,
      "Loading preview allowed execution or another preview request",
    );
    flushSync(() =>
      dialog()!
        .querySelector<HTMLButtonElement>('[aria-label="Close"]')!
        .click(),
    );
    defer!(Response.json({ data: preview() }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    check(!dialog() && posts.length === 3, "Closed preview reopened/submitted");

    flushSync(() => button("Run again", host).click());
    check(
      dialog()!.textContent!.includes("fresh workflow") &&
        dialog()!.textContent!.includes("$10"),
      "Fresh run confirmation missing",
    );
    check(
      gets === 4 && posts.length === 3,
      "Fresh confirmation fetched/submitted work",
    );
    await observe?.("fresh");
    flushSync(() => button("Run again").click());
    await wait(() => !dialog());
    check(
      posts[3].path.endsWith("/rerun") &&
        JSON.stringify(posts[3].body) === "{}",
      "Fresh run used recovery payload",
    );
    return [
      "Lazy preview, retained work, acknowledgement, bounds, duplicate protection, explicit 409 reload, refreshed checkpoint, legacy retry, close protection, draft preservation, fresh confirmation passed",
    ];
  } finally {
    root.unmount();
    host.remove();
    client.clear();
    window.fetch = originalFetch;
    usePreferences.getState().setLanguage(previousLanguage);
  }
}
