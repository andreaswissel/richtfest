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

  expect(html).toContain("Models by role");
  expect(html).toContain("gpt-5");
  expect(html).toContain("Extra high");
  expect(html).toContain("Optional supervisor delegation is disabled");
});

test("optional specialists keep their table rows and only expose editable values when enabled", () => {
  const reviewer = { modelId: "gpt-5", maxOutputTokens: 3100, maxSteps: 4 };
  for (const enabled of [false, true]) {
    const html = render({
      "/agent/models?provider=openai": {
        models: [{ id: "gpt-5", name: "GPT-5" }],
      },
      "/agent/presets?provider=openai": {
        enabled: true,
        canManage: true,
        presets: [
          {
            effort: "medium",
            supervisor: reviewer,
            specialists: {
              source_reviewer: reviewer,
              requirements_reviewer: reviewer,
              ...(enabled
                ? { sound_insulation: { ...reviewer, maxSteps: 7 } }
                : {}),
            },
          },
        ],
      },
    });
    expect(html.match(/scope="row"/g)?.length).toBe(6);
    for (const role of [
      "Sound insulation",
      "Construction law",
      "Cost optimizer",
    ])
      expect(html).toContain(`scope="row">${role}</th>`);
    const soundSteps = html.match(
      /<input[^>]*aria-label="Sound insulation: Max steps"[^>]*>/,
    )?.[0];
    expect(soundSteps).toBeDefined();
    expect(soundSteps?.includes('disabled=""')).toBe(!enabled);
    expect(soundSteps).toContain(`value="${enabled ? "7" : ""}"`);
  }
});
