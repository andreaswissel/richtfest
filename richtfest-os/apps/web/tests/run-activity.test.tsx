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
test("activity history is collapsed while the current assignment and latest update stay visible", () => {
  const html = renderToStaticMarkup(
    <RunActivityFeed
      active
      run={{
        id: "source",
        status: "running",
        specialistRole: "source_reviewer",
        goal: "Compare floor plan revisions",
      }}
      events={[
        { id: "start", eventType: "provider_call_started" },
        { id: "retry", eventType: "provider_call_retrying" },
      ]}
    />,
  );
  const summary = html.split("<details")[0];
  expect(summary).toContain("Source review");
  expect(summary).toContain("Compare floor plan revisions");
  expect(summary).toContain(en.workspaceActivityProviderCallRetrying);
  expect(summary).not.toContain(en.workspaceActivityProviderCallStarted);
  expect(html).toContain("Activity history");
  expect(html).toContain(en.workspaceActivityProviderCallStarted);
  expect(html).not.toMatch(/<details[^>]*\bopen/);
  const stopped = renderToStaticMarkup(
    <RunActivityFeed
      active={false}
      run={{ id: "source", status: "cancelled", goal: "Old assignment" }}
      events={[{ id: "stop", eventType: "cancelled" }]}
    />,
  );
  expect(stopped).not.toContain("Old assignment");
  expect(stopped).toContain(en.workspaceActivityCancelled);
});

test("live work replaces assignments with attributed source batches and unreviewed findings, without stale sibling or prior-run output", () => {
  const parent = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    isSupervisor: true,
    status: "running",
  };
  const child = {
    id: "550e8400-e29b-41d4-a716-446655440001",
    parentRunId: parent.id,
    specialistRole: "source_reviewer",
    status: "running",
    goal: "Static assignment",
  };
  const other = {
    ...child,
    id: "550e8400-e29b-41d4-a716-446655440002",
    specialistRole: "requirements_reviewer",
  };
  const progress = (runId: string, summary: string, batch = 2) => ({
    id: summary,
    eventType: "work_progress",
    paramsSummary: JSON.stringify({
      runId,
      stage: "reading_sources",
      batch,
      batchCount: 3,
      summary,
      sources: [
        {
          versionId: "550e8400-e29b-41d4-a716-446655440003",
          name: "Floor plans.pdf",
          version: 2,
        },
      ],
    }),
  });
  const events = [
    progress(child.id, "Outdated finding", 1),
    progress(other.id, "Missing wall build-up"),
    progress(child.id, "Room dimensions differ between revisions"),
    { id: "call", eventType: "provider_call_started" },
  ];
  const render = (run = parent, children = [child, other], updates = events) =>
    renderToStaticMarkup(
      <RunActivityFeed active run={run} children={children} events={updates} />,
    );
  const visible = render().split("<details")[0];
  expect(visible).toContain("Batch 2/3");
  expect(visible).toContain("Floor plans.pdf (Version 2)");
  expect(visible).toContain("Room dimensions differ between revisions");
  expect(visible).toContain("Missing wall build-up");
  expect(visible).toContain("Not reviewed");
  expect(visible).not.toContain("Outdated finding");
  expect(visible).not.toContain("Static assignment");
  expect(visible).not.toContain(en.workspaceActivityProviderCallStarted);
  expect(render()).toContain("Outdated finding"); // Preserved only in expanded history.
  for (const updates of [
    [...events, { id: "resume", eventType: "resumed" }],
    [
      {
        id: "bad",
        eventType: "work_progress",
        paramsSummary: '{"summary":"UNSAFE malformed progress"}',
      },
    ],
  ]) {
    const fallback = render(parent, [child], updates).split("<details")[0];
    expect(fallback).toContain("Static assignment");
    expect(fallback).not.toContain("Room dimensions differ");
    expect(fallback).not.toContain("UNSAFE");
  }
  const queued = render(parent, [{ ...child, status: "queued" }]).split(
    "<details",
  )[0];
  expect(queued).toContain("Waiting for the worker to start");
  expect(queued).not.toContain("Room dimensions differ");
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

test("persisted timeout takes precedence over earlier own-run validation or truncation diagnostics", () => {
  const html = renderToStaticMarkup(
    <RunActivityFeed
      active={false}
      events={[
        {
          id: "timeout",
          eventType: "supervisor_failed",
          paramsSummary:
            "phase=specialist; category=timeout; The provider call exceeded its time limit.",
        },
      ]}
    />,
  );
  expect(html).toContain("Provider call timed out");
  expect(html).not.toContain("check the provider connection");
  for (const field of ["error", "failureReason"]) {
    const run = {
      id: "own",
      status: "failed",
      [field]:
        "phase=review; category=timeout; The provider call exceeded its time limit. Retry with a narrower assignment or a faster model.",
    };
    const truncated = {
      ...event(),
      paramsSummary: JSON.stringify({
        callId: "call",
        runId: "own",
        attempt: 3,
        diagnostics: {
          errorId: "STRUCTURED_OUTPUT_TRUNCATED",
          finishReason: "length",
        },
      }),
    };
    expect(terminalProviderFailure(run, [event()], [], t)).toBeUndefined();
    expect(terminalProviderFailure(run, [truncated], [], t)).toBeUndefined();
  }
});
