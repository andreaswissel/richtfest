import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { AppUpdateButton } from "../src/components/app-update-button";
import { usePreferences } from "../src/store";

/** Run through Vite: import('/tests/app-update.browser.tsx').then(m => m.testAppUpdate()) */
export async function testAppUpdate() {
  const host = document.createElement("div");
  host.style.width = "193px"; // Available width in the narrower desktop rail.
  document.body.append(host);
  const previousPreferences = usePreferences.getState();
  const previousDensity = document.documentElement.dataset.density;
  const meta = document.createElement("meta");
  meta.name = "richtfest-build";
  meta.content = "loaded-build";
  document.head.prepend(meta);
  const originalFetch = window.fetch;
  let response = () => Response.json({ version: "loaded-build" });
  window.fetch = (input, options) =>
    input === "/version.json"
      ? Promise.resolve(response())
      : originalFetch(input, options);
  const client = new QueryClient();
  const root = createRoot(host);
  const check = (expected: boolean, reason: string) => {
    if (Boolean(host.querySelector("button")) !== expected)
      throw new Error(reason);
  };
  const settle = async () => {
    while (client.isFetching()) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
  };
  const mount = () =>
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <AppUpdateButton />
        </QueryClientProvider>,
      ),
    );
  const focus = async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await settle();
  };
  try {
    mount();
    await settle();
    check(false, "The current build must not offer an update");
    for (const invalid of [
      () => new Response("Unavailable", { status: 503 }),
      () => Response.json({ version: null }),
      () => new Response("<html>Proxy error</html>"),
    ]) {
      response = invalid;
      await focus();
      check(false, "A failed or malformed check must not offer an update");
    }
    response = () => Response.json({ version: "new-build" });
    await focus();
    check(true, "Returning to the tab must detect a changed build");
    response = () => new Response("Unavailable", { status: 503 });
    await focus();
    check(true, "A transient error must not hide an already detected update");

    // A deployment can happen before this tab's very first check.
    flushSync(() => root.render(null));
    client.clear();
    response = () => Response.json({ version: "new-build" });
    mount();
    await settle();
    check(true, "Compare against loaded HTML, not the first response");
    await document.fonts.ready;
    for (const language of ["en", "de"] as const) {
      for (const density of ["dense", "normal"] as const) {
        flushSync(() =>
          usePreferences.getState().hydrate({ language, density }),
        );
        document.documentElement.dataset.density = density;
        const button = host.querySelector("button")!;
        await Promise.all(
          button.getAnimations().map((animation) => animation.finished),
        );
        const label = document.createRange();
        label.selectNodeContents(button.lastChild!);
        if (
          label.getClientRects().length !== 1 ||
          label.getBoundingClientRect().right >
            button.getBoundingClientRect().right - 6
        )
          throw new Error(
            `${language}/${density}: update label wraps or overflows the rail`,
          );
      }
    }
    return "PASS: same build, failed/malformed checks, focus detection, retained update, deployment before first check, single-line labels in both languages and densities";
  } finally {
    root.unmount();
    client.clear();
    window.fetch = originalFetch;
    focusManager.setFocused(undefined);
    usePreferences.getState().hydrate(previousPreferences);
    if (previousDensity)
      document.documentElement.dataset.density = previousDensity;
    else delete document.documentElement.dataset.density;
    meta.remove();
    host.remove();
  }
}
