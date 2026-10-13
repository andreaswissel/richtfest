import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings } from "../src/screens/settings";
import { SupervisorPresets } from "../src/components/supervisor-presets";
import {
  canEditConnection,
  connectionProviderIds,
  getSelectedProvider,
  isConnectionProviderId,
  isProviderId,
  providerIds,
  providerLabel,
  type ProviderConnection,
} from "../src/connection-policy";
test("missing encryption always fails closed, including administrators", () => {
  expect(canEditConnection(undefined, "personal")).toBe(false);
  expect(
    canEditConnection(
      { encryptionConfigured: false, canManageWorkspace: true },
      "personal",
    ),
  ).toBe(false);
  expect(
    canEditConnection(
      { encryptionConfigured: false, canManageWorkspace: true },
      "workspace",
    ),
  ).toBe(false);
});
test("members can manage personal credentials but not shared workspace credentials", () => {
  const member = { encryptionConfigured: true, canManageWorkspace: false };
  expect(canEditConnection(member, "personal")).toBe(true);
  expect(canEditConnection(member, "workspace")).toBe(false);
  expect(canEditConnection(member, "other")).toBe(false);
  expect(
    canEditConnection({ ...member, canManageWorkspace: true }, "workspace"),
  ).toBe(true);
});
test("workspace provider selection supports the gateway and defaults safely", () => {
  expect(providerIds).toEqual(["openai", "anthropic", "vercel"]);
  expect(getSelectedProvider()).toBe("openai");
  expect(
    getSelectedProvider({
      encryptionConfigured: true,
      canManageWorkspace: true,
      providers: [],
      selectedProvider: "vercel",
    }),
  ).toBe("vercel");
});
test("TypeSafe is a connection only, never a generative provider", () => {
  expect(connectionProviderIds).toEqual([...providerIds, "typesafe"]);
  expect(isConnectionProviderId("typesafe")).toBe(true);
  expect(isConnectionProviderId("cloudflare")).toBe(false);
  expect(isConnectionProviderId("unknown")).toBe(false);
  expect(isProviderId("typesafe")).toBe(false);
  expect(providerLabel("typesafe")).toBe("TypeSafe (Jev)");
  expect(
    getSelectedProvider({
      encryptionConfigured: true,
      canManageWorkspace: true,
      providers: [],
      selectedProvider: "typesafe" as never,
    }),
  ).toBe("openai");
});
function render(
  component: ReturnType<typeof createElement>,
  path: string,
  data: unknown,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData([path], data);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, component),
    ),
  );
}

test("server credential availability is visible even when an override takes precedence", () => {
  for (const source of ["personal", "workspace", "server", null] as const) {
    const connection: ProviderConnection = {
      provider: "typesafe",
      personal: { configured: source === "personal" },
      workspace: { configured: source === "workspace" },
      server: { configured: source !== null },
      effectiveSource: source,
    };
    const html = render(createElement(Settings), "/settings/ai-connections", {
      encryptionConfigured: true,
      canManageWorkspace: true,
      providers: [connection],
    });
    expect(html).toContain("TypeSafe (Jev)");
    expect(html).toContain(
      source === null
        ? "No server credential reported"
        : "Server credential available",
    );
    expect(html).toContain("personal → workspace → server");
    expect(html).toContain("cannot be removed here");
    expect(html).not.toContain('name="accountId"');
    expect(html).not.toContain('value="server"');
  }
});

test("knowledge ranking is opt-in and independent of routing mode", () => {
  for (const mode of ["off", "shadow", "enabled"]) {
    for (const enabled of [undefined, false, true]) {
      const html = render(
        createElement(SupervisorPresets),
        "/agent/presets?provider=openai",
        {
          enabled: true,
          canManage: true,
          presets: [
            {
              effort: "medium",
              decisionRouting: { mode, minConfidence: 0.99 },
              knowledgeRerankingEnabled: enabled,
            },
          ],
        },
      );
      const control = html.match(
        /<button[^>]*aria-label="Rank company knowledge with Jev"[^>]*>/,
      )?.[0];
      expect(control).toBeDefined();
      expect(control).toContain(`aria-checked="${enabled === true}"`);
      expect(control).not.toContain('disabled=""');
      expect(html.indexOf("Minimum confidence")).toBeLessThan(
        html.indexOf("Rank company knowledge with Jev"),
      );
      expect(html).toContain("deterministic fallback");
    }
  }
});
