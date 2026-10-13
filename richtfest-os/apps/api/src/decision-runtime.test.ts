import { expect, test } from "bun:test";
import { callDecisionModel, type DecisionInput } from "./decision-runtime";

const apiKey = "test-private-token";
const input: DecisionInput = { runId: "run", state: { private: "private-source" }, questions: {
  route: { type: "choice", instructions: "private-question", criteria: { yes: "Proceed", no: "Stop" } },
} };
const result = () => ({ model: "jev-1.13.0", answers: { route: {
  type: "choice", choice: "yes", probabilities: { yes: 0.8, no: 0.2 }, confidence: 0.8,
} }, usage: { input_tokens: 1000, output_tokens: 8 } });
const response = (value: unknown) => async () => Response.json(value);

test("decision output is typed, priced and telemetry contains only hashes/known metadata", async () => {
  const requests: unknown[] = [], responses: unknown[] = [];
  let calls = 0;
  const output = await callDecisionModel({ ...input,
    onRequest: async v => { requests.push(v); }, onResponse: async v => { responses.push(v); },
  }, apiKey, { fetch: async (url, init) => {
    calls++;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ model: "jev-1.13.0", state: input.state, questions: input.questions });
    return response(result())();
  } });
  expect(calls).toBe(1);
  expect(output.output.answers.route!.choice).toBe("yes");
  expect(output.usage).toMatchObject({ provider: "typesafe", modelId: "jev-1.13.0", inputTokens: 1000, outputTokens: 8, totalTokens: 1008,
    estimatedCostUsd: 0.000042, pricingVersion: "typesafe-jev-1.13.0-2026-10-13" });
  expect(requests[0]).toMatchObject({ adapter: "decision", timeoutMs: 1500, maxRetries: 0 });
  expect(responses).toEqual([{ modelId: "jev-1.13.0", responseId: null, finishReason: "stop" }]);
  for (const secret of [apiKey, "private-source", "private-question"])
    expect(JSON.stringify({ requests, responses })).not.toContain(secret);
});

test("missing or invalid usage is unknown rather than fabricated zero", async () => {
  for (const usage of [undefined, { input_tokens: -1, output_tokens: 8 }, { input_tokens: "100", output_tokens: 8 }]) {
    const output = await callDecisionModel(input, apiKey, { fetch: response({ ...result(), usage }) });
    expect(output.usage.inputTokens).toBeNull();
    expect(output.usage.estimatedCostUsd).toBeNull();
  }
});

test("malformed answers are rejected but trustworthy usage is still reported", async () => {
  const malformed = [
    { ...result(), model: "raw-secret-model" },
    { ...result(), answers: {} },
    { ...result(), answers: { ...result().answers, extra: result().answers.route } },
    { ...result(), answers: { route: { ...result().answers.route, choice: "no" } } },
    { ...result(), answers: { route: { ...result().answers.route, probabilities: { yes: 0.8, extra: 0.2 } } } },
    { ...result(), answers: { route: { ...result().answers.route, probabilities: { yes: 0.8, no: 0.3 } } } },
    { ...result(), answers: { route: { ...result().answers.route, confidence: 2 } } },
  ];
  for (const value of malformed) {
    const usages: unknown[] = [];
    await expect(callDecisionModel({ ...input, onUsage: async v => { usages.push(v); } }, apiKey,
      { fetch: response(value) })).rejects.toMatchObject({ failureCategory: "validation" });
    expect(usages).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 8,
      estimatedCostUsd: 0.000042 })]);
  }
});

test("probability sums tolerate rounding only within a fixed small bound", async () => {
  const rounded = (no: number) => ({ ...result(), answers: { route: {
    ...result().answers.route, probabilities: { yes: 0.8, no },
  } } });
  await expect(callDecisionModel(input, apiKey, { fetch: response(rounded(0.2000005)) }))
    .resolves.toMatchObject({ status: "completed" });
  await expect(callDecisionModel(input, apiKey, { fetch: response(rounded(0.200002)) }))
    .rejects.toMatchObject({ failureCategory: "validation" });
});

test("HTTP, envelope, JSON and transport errors never expose raw secrets or retry", async () => {
  for (const fetcher of [async () => new Response(apiKey, { status: 500 }),
    async () => Response.json({ success: false, errors: [apiKey] }),
    async () => Response.json({ success: true, result: result() }),
    async () => new Response(apiKey),
    async () => { throw new Error(apiKey); }]) {
    let calls = 0;
    try {
      await callDecisionModel(input, apiKey, { fetch: async () => { calls++; return fetcher(); } });
      throw new Error("unexpected success");
    } catch (error: any) {
      expect(error.code).toBe("decision_provider_error");
      expect(String(error)).not.toContain(apiKey);
      expect(error.cause).toBeUndefined();
    }
    expect(calls).toBe(1);
  }
});

test("Jev HTTP failures retain the reason and request ID even when routing falls back", async () => {
  const error = await callDecisionModel(input, apiKey, { fetch: async () => Response.json({
    error: { code: "insufficient_quota", message: `Account credits exhausted. ${apiKey} private-source` },
  }, { status: 402, headers: { "x-request-id": "req_jev_123" } }) }).catch(error => error);
  expect(error).toMatchObject({ providerStatus: 402, failureCategory: "provider", diagnostics: {
    providerCode: "insufficient_quota", providerRequestId: "req_jev_123",
    providerMessage: "Account credits exhausted. [redacted] [redacted]",
  } });
  expect(JSON.stringify(error)).not.toContain(apiKey);
  expect(JSON.stringify(error)).not.toContain("private-source");
});

test("cancellation and 1500ms deadline bound a fetch that ignores abort", async () => {
  const controller = new AbortController();
  controller.abort(new Error(apiKey));
  let calls = 0;
  await expect(callDecisionModel(input, apiKey, { signal: controller.signal,
    fetch: async () => { calls++; return response(result())(); } })).rejects.toMatchObject({ code: "cancelled" });
  expect(calls).toBe(0);
  const active = new AbortController();
  const pending = callDecisionModel(input, apiKey, { signal: active.signal, fetch: () => new Promise(() => {}) });
  active.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  const start = Date.now();
  await expect(callDecisionModel(input, apiKey, { fetch: () => new Promise(() => {}) }))
    .rejects.toMatchObject({ code: "timeout", failureCategory: "timeout" });
  expect(Date.now() - start).toBeLessThan(2200);
});

test("missing or invalid keys and non-choice input never reach fetch or telemetry", async () => {
  let calls = 0;
  const telemetry: unknown[] = [];
  const fetcher = async () => { calls++; return response(result())(); };
  for (const key of [undefined, null, 123, "", " ", "secret token", "secret\n", "secret\r", "secret\u0000", "secreté"]) {
    await expect(callDecisionModel({ ...input, onRequest: async v => { telemetry.push(v); } }, key as any,
      { fetch: fetcher })).rejects.toMatchObject({ failureCategory: "validation", code: "decision_provider_error" });
  }
  await expect(callDecisionModel({ ...input, questions: { route: { type: "score" } } } as any,
    apiKey, { fetch: fetcher })).rejects.toMatchObject({ failureCategory: "validation" });
  expect(calls).toBe(0);
  expect(telemetry).toEqual([]);
});
