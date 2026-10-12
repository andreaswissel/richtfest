import { lazy, Suspense, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import {
  ModuleLoadBoundary,
  RouteError,
} from "../src/components/module-recovery";
import { Input } from "../src/components/ui/input";
import { usePreferences } from "../src/store";

/** Run in Vite: import('/tests/module-recovery.browser.tsx').then(m => m.testModuleRecovery()) */
export async function testModuleRecovery() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const previousLanguage = usePreferences.getState().language;
  usePreferences.getState().setLanguage("en");
  const results: string[] = [];
  function check(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
  }
  async function waitFor(text: string) {
    const deadline = Date.now() + 3000;
    while (!host.textContent?.includes(text)) {
      if (Date.now() > deadline)
        throw new Error(`Missing recovery text: ${text}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    // Chrome, Safari, Firefox and Vite CSS failures must preserve the composer.
    for (const message of [
      "Failed to fetch dynamically imported module: /assets/old.js",
      "Importing a module script failed.",
      "error loading dynamically imported module: /assets/old.js",
      "Unable to preload CSS for /assets/old.css",
    ]) {
      let reject!: (error: Error) => void;
      const Deferred = lazy(
        () =>
          new Promise<{ default: () => null }>((_, fail) => (reject = fail)),
      );
      function Conversation() {
        const [draft, setDraft] = useState("unsent draft — keep me");
        return (
          <>
            <ModuleLoadBoundary fallback={<p>Original message text</p>}>
              <Suspense fallback={<p>Loading renderer</p>}>
                <Deferred />
              </Suspense>
            </ModuleLoadBoundary>
            <Input
              aria-label="Draft"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </>
        );
      }
      flushSync(() => root.render(<Conversation key={message} />));
      const composer = host.querySelector("input")!;
      reject(new TypeError(message));
      await waitFor("Reload app");
      check(host.querySelector("input") === composer, "Composer was unmounted");
      check(composer.value === "unsent draft — keep me", "Draft was lost");
      check(
        host.textContent?.includes("Original message text"),
        "Plain text was lost",
      );
      check(
        host.textContent?.includes("Nothing will reload automatically"),
        "Missing reload warning",
      );
      check(
        host.querySelector('[role="alert"]'),
        "Recovery notice is not accessible",
      );
      results.push(`Draft and original text preserved: ${message}`);
    }

    // Ordinary errors must reach the route boundary, not be called asset failures.
    for (const error of [
      new Error("render bug"),
      new TypeError("Failed to fetch"),
    ]) {
      function Broken(): never {
        throw error;
      }
      const router = createMemoryRouter([
        {
          path: "/",
          element: (
            <ModuleLoadBoundary>
              <Broken />
            </ModuleLoadBoundary>
          ),
          errorElement: <RouteError />,
        },
      ]);
      try {
        flushSync(() => root.render(<RouterProvider router={router} />));
        await waitFor("unexpected error");
        check(
          !host.textContent?.includes("app may have been updated"),
          "Misclassified a non-module error",
        );
        check(
          !host.textContent?.includes("Hey developer"),
          "Default error screen leaked",
        );
        results.push(`Generic error kept distinct: ${error.message}`);
      } finally {
        flushSync(() => root.render(null));
        router.dispose();
      }
    }
    return results;
  } finally {
    root.unmount();
    host.remove();
    usePreferences.getState().setLanguage(previousLanguage);
  }
}
