import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { agentExecutionLimitsSchema } from "@richtfest/shared";
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

function renderLimits(
  executionLimits?: Record<string, unknown>,
  canManage = true,
) {
  return render({
    "/agent/presets?provider=openai": {
      enabled: true,
      canManage,
      presets: [{ effort: "medium", source: "workspace", executionLimits }],
    },
  });
}

test("response limits use shared defaults below execution limits and before the compact footer", () => {
  const html = renderLimits();
  expect(html.indexOf("Execution limits")).toBeLessThan(
    html.indexOf("Response limits"),
  );
  expect(html.indexOf("Response limits")).toBeLessThan(
    html.indexOf("supervisor-preset-actions"),
  );
  for (const value of [10000, 2000, 60000, 180])
    expect(html).toContain(`value="${value}"`);
  expect(html).toContain("Summary characters");
  expect(html).toContain("Rationale characters");
  expect(html).toContain("Document characters");
  expect(html).toContain("Call timeout (seconds)");
  expect(html).toContain('min="10" max="600" step="1"');
  expect(html).not.toContain('aria-invalid="true"');
});

test("invalid, empty and fractional response limits block saving without blocking reset", () => {
  const defaults = agentExecutionLimitsSchema.parse({});
  for (const key of Object.keys(defaults)) {
    for (const value of ["", 0, 1.5, 1000000]) {
      const html = renderLimits({ ...defaults, [key]: value });
      expect(html).toContain('aria-invalid="true"');
      expect(html).toContain(
        "Enter whole numbers within the displayed ranges before saving.",
      );
      expect(html).toMatch(
        /<button[^>]*disabled=""[^>]*>Save agent model settings<\/button>/,
      );
      expect(html).toMatch(
        /<button(?![^>]*disabled="")[^>]*>Reset model settings to vendor default<\/button>/,
      );
    }
  }
});

test("response limits inherit the shared read-only state", () => {
  const html = renderLimits(undefined, false);
  expect(html).toMatch(
    /<fieldset[^>]*disabled=""[^>]*><legend[^>]*>Response limits/,
  );
  expect(html).toMatch(
    /<button[^>]*disabled=""[^>]*>Save agent model settings<\/button>/,
  );
});
