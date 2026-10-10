import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TokenLimitAction,
  tokenLimitCandidate,
} from "../src/components/project-workspace/token-limit-action";

const model = { modelId: "test-model", maxOutputTokens: 3000, maxSteps: 2 };
const run = {
  status: "failed",
  failureRole: "supervisor",
  modelPolicy: {
    provider: "openai",
    effort: "medium",
    version: 1,
    source: "workspace",
    supervisor: model,
    specialists: { source_reviewer: model, requirements_reviewer: model },
    maxParallel: 2,
    maxTasks: 3,
    maxRevisions: 1,
  },
  failureEvent: {
    paramsSummary: JSON.stringify({
      diagnostics: {
        errorId: "STRUCTURED_OUTPUT_TRUNCATED",
        finishReason: "length",
      },
    }),
  },
};
test("only confirmed output-token truncation has a direct action, with no initial fetch or execution", () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    const render = (item: any) =>
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <TokenLimitAction run={item} />
        </QueryClientProvider>,
      );
    const decision = render(run);
    expect(decision).toContain(
      "Token limit exceeded. Do you want to set a higher limit of 6,000?",
    );
    expect(decision).toContain(">Yes</button>");
    expect(decision).toContain(">No</button>");
    expect(decision).toContain("Describe what Richtfest should do differently");
    expect(decision).toContain("Only new runs use this workspace setting");
    const schemaFailure = {
      ...run,
      failureEvent: {
        paramsSummary: JSON.stringify({
          diagnostics: {
            errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
            finishReason: "length",
            issues: [{ code: "too_big", path: ["summary"], maximum: 10000 }],
          },
        }),
      },
    };
    expect(render(schemaFailure)).toBe("");
    expect(render({ ...run, failureRole: undefined })).toBe("");
    expect(render({ ...run, status: "running" })).toBe("");
    expect(
      render({
        ...run,
        modelPolicy: {
          ...run.modelPolicy,
          supervisor: { ...model, maxOutputTokens: 128000 },
        },
      }),
    ).toBe("");
    expect(
      render({
        ...run,
        modelPolicy: {
          ...run.modelPolicy,
          supervisor: { ...model, modelId: "" },
        },
      }),
    ).toBe("");
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});
test("child roles require a known role and exact length finish reason", () => {
  expect(
    tokenLimitCandidate({ ...run, failureRole: "source_reviewer" })?.role,
  ).toBe("source_reviewer");
  expect(
    tokenLimitCandidate({ ...run, failureRole: "requirements_reviewer" })?.role,
  ).toBe("requirements_reviewer");
  expect(
    tokenLimitCandidate({ ...run, failureRole: "unknown" }),
  ).toBeUndefined();
  expect(
    tokenLimitCandidate({
      ...run,
      failureEvent: {
        paramsSummary: JSON.stringify({
          diagnostics: {
            errorId: "STRUCTURED_OUTPUT_TRUNCATED",
            finishReason: "stop",
          },
        }),
      },
    }),
  ).toBeUndefined();
});
