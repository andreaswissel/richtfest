import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SupervisorPresets } from "../src/components/supervisor-presets";

function render(records: Record<string, unknown>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const [key, value] of Object.entries(records))
    client.setQueryData([key], value);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SupervisorPresets provider="openai" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("direct agent model settings remain visible when supervisor delegation is disabled", () => {
  const html = render({
    "/agent/presets?provider=openai": {
      enabled: false,
      canManage: true,
      presets: [
        {
          effort: "medium",
          provider: "openai",
          source: "vendor",
          version: 1,
          configured: true,
          supervisor: { modelId: "gpt-5", reasoningEffort: "xhigh" },
          specialists: {},
        },
      ],
    },
  });

  expect(html).toContain("Agent model settings");
  expect(html).toContain("gpt-5");
  expect(html).toContain("Extra high");
  expect(html).toContain("Optional supervisor delegation is disabled");
});
