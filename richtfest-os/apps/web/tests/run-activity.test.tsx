import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../src/locales/en.json";
import {
  providerActivityMetadata,
  providerFailureExplanation,
  terminalProviderFailure,
} from "../src/components/project-workspace/run-activity";
import { RunActivityFeed } from "../src/components/project-workspace/run-activity-feed";
const t = (key: keyof typeof en) => en[key];
const diagnostics = {
  errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
  finishReason: "stop",
  issues: [{ code: "too_big", path: ["summary"], maximum: 10000 }],
  message: "SECRET provider text",
};
const event = (runId = "own", extra = diagnostics) => ({
  id: runId,
  eventType: "provider_call_failed",
  resultSummary: "review; attempt 3",
  paramsSummary: JSON.stringify({
    callId: "call",
    runId,
    attempt: 3,
    diagnostics: extra,
  }),
});
test("verified summary character failure is distinct from output truncation", () => {
  const html = renderToStaticMarkup(
    <RunActivityFeed events={[event()]} active={false} />,
  );
  expect(html).toContain("10000 characters");
  expect(html).toContain("not a token limit");
  expect(html).toContain("Attempt 3");
  expect(html).not.toContain("SECRET");
  expect(
    providerFailureExplanation(
      { errorId: "STRUCTURED_OUTPUT_TRUNCATED", finishReason: "length" },
      t,
    ),
  ).toContain("output length limit");
  expect(
    providerFailureExplanation(
      { errorId: "STRUCTURED_OUTPUT_TRUNCATED", finishReason: "stop" },
      t,
    ),
  ).toBeUndefined();
  expect(
    providerFailureExplanation(
      {
        errorId: diagnostics.errorId,
        issues: [{ code: "invalid_string", path: ["citations"] }],
      },
      t,
    ),
  ).toContain("field validation");
});
test("malformed and legacy correlation is safe and does not invent numeric limits", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  expect(providerActivityMetadata({ paramsSummary: id }).callId).toBe(id);
  for (const paramsSummary of ["{broken", "null", "[]", "42"])
    expect(providerActivityMetadata({ paramsSummary }).callId).toBeUndefined();
  expect(
    providerFailureExplanation(
      { ...diagnostics, issues: [{ code: "too_big", path: ["summary"] }] },
      t,
    ),
  ).not.toContain("10000");
});
test("terminal diagnostics cannot attribute a sibling or another phase failure", () => {
  const run = {
    id: "own",
    status: "failed",
    error: "phase=review; category=validation",
  };
  expect(
    terminalProviderFailure(run, [event("sibling")], [], t),
  ).toBeUndefined();
  expect(
    terminalProviderFailure(run, [event(), event("sibling")], [], t),
  ).toContain("10000");
  expect(
    terminalProviderFailure(
      run,
      [{ ...event(), resultSummary: "plan" }],
      [],
      t,
    ),
  ).toBeUndefined();
});
