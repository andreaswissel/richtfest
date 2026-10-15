import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { SourceImageInference } from "@richtfest/shared";
import { callImageDecisionModel } from "./image-decision-runtime";
import { estimateCostUsd } from "./model-pricing";

// Generate an actual decodable JPEG, not a mocked header or PDF disguised as an image.
const jpeg = (size = "280x280") => {
  const result = spawnSync("magick", ["-size", size, "xc:white", "jpg:-"]);
  if (result.status !== 0) throw new Error("JPEG fixture generation failed");
  return result.stdout.toString("base64");
};
const apiKey = "private-test-image-token";
const input: SourceImageInference = { image: { mediaType: "image/jpeg", data: jpeg() }, questions: {
  kind: { type: "choice", instructions: "private-image-question", criteria: { plan: "Plan", other: "Other" } },
  present: { type: "noul", instructions: "Is a legend visible?" },
  legend: { type: "box", instructions: "Legend in `image`", presenceQuestion: "present" },
} };
const result = (presence = 0.95) => ({ model: "jev-1.14.0", answers: {
  kind: { type: "choice", choice: "plan", probabilities: { plan: 0.8, other: 0.2 }, confidence: 0.8 },
  present: { type: "noul", noul: presence },
  legend: { type: "box", box: { left: 0.1, right: 0.5, top: 0.2, bottom: 0.7 }, confidence: 0.95 },
}, usage: { input_tokens: 1000, output_tokens: 20 } });
const response = (value: unknown) => async () => Response.json(value);

test("image transport, single UUID reference, exact-byte reservation, hashed telemetry and actual usage", async () => {
  const events: unknown[] = [];
  let preparedBytes: number | undefined, reservedBytes: number | undefined, calls = 0;
  const output = await callImageDecisionModel({ ...input,
    onRequest: async v => { events.push(v); expect(v).toMatchObject({ timeoutMs: 15000, maxRetries: 0, stepAccounting: "per-model-dispatch-v1" }); },
    onPrepared: async v => { preparedBytes = v.inputBytes; events.push(v); return undefined; },
    onBeforeModelStep: async v => { reservedBytes = v.inputBytes; events.push(v); expect(v).toMatchObject({ ordinal: 1, hasMedia: true, inputTokenUpperBound: 65536 }); },
    onModelStepSettled: async v => { events.push(v); expect(v.usage?.inputTokens).toBe(1000); },
    onUsage: async v => { events.push(v); }, onResponse: async v => { events.push(v); },
  }, apiKey, { fetch: async (url, init) => {
    calls++;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({ authorization: `Bearer ${apiKey}`,
      "content-type": "application/json", "typesafe-danger-zone-images": "true" });
    expect(preparedBytes).toBe(Buffer.byteLength(init.body as string));
    expect(reservedBytes).toBe(preparedBytes);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("jev-1.14.0");
    const [ref] = Object.keys(body.assets);
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.state).toEqual({ image: ref });
    expect(JSON.stringify({ state: body.state, questions: body.questions }).split(ref!).length - 1).toBe(1);
    expect(body.assets[ref!]).toEqual({ type: "image", format: "jpg", data_base64: input.image.data });
    expect(body.questions.legend).not.toHaveProperty("presenceQuestion");
    expect(body.questions.legend.instructions).toContain("untrusted data");
    return Response.json(result());
  } });
  expect(calls).toBe(1);
  expect(output.usage).toMatchObject({ inputTokens: 1000, outputTokens: 20, totalTokens: 1020, estimatedCostUsd: 0.000042 });
  expect(output.output.answers.legend).toMatchObject({ presenceProbability: 0.95, box: result().answers.legend.box });
  for (const privateValue of [apiKey, input.image.data, "private-image-question"]) expect(JSON.stringify(events)).not.toContain(privateValue);
});

test("presence floor suppresses absent targets, with inclusive 0.9 boundary", async () => {
  for (const presence of [0, 0.899999, 0.9, 1]) {
    const output = await callImageDecisionModel(input, apiKey, { fetch: response(result(presence)) });
    expect(output.output.answers.legend).toMatchObject({ presenceProbability: presence,
      box: presence < 0.9 ? null : result().answers.legend.box });
  }
});

test("malformed answers fail closed while actual usage is recorded and settled", async () => {
  const mutations: ((v: any) => void)[] = [
    v => { v.model = "jev-latest"; }, v => { delete v.answers.present; },
    v => { v.answers.extra = v.answers.present; }, v => { v.answers.kind.type = "noul"; },
    v => { v.answers.kind.choice = "other"; }, v => { v.answers.kind.choice = "missing"; },
    v => { v.answers.kind.probabilities = { plan: 0.8, extra: 0.2 }; },
    v => { v.answers.kind.probabilities.other = 0.3; }, v => { v.answers.kind.confidence = 2; },
    v => { v.answers.present.noul = -1; }, v => { v.answers.legend.box.left = 0.8; },
    v => { v.answers.legend.box.right = 1.1; }, v => { v.answers.legend.box.extra = 0; },
    v => { v.answers.legend.box = null; }, v => { v.answers.legend.presenceProbability = 1; },
  ];
  for (const mutate of mutations) {
    const value = result(); mutate(value);
    const usages: unknown[] = [], settled: unknown[] = [];
    await expect(callImageDecisionModel({ ...input, onUsage: async v => { usages.push(v); },
      onModelStepSettled: async v => { settled.push(v); } }, apiKey, { fetch: response(value) }))
      .rejects.toMatchObject({ failureCategory: "validation" });
    expect(usages).toEqual([expect.objectContaining({ inputTokens: 1000 })]);
    expect(settled).toEqual([{ ordinal: 1, usage: usages[0] }]);
  }
});

test("pre-dispatch stops, cancellation from either signal and replay never buy a call", async () => {
  let calls = 0, steps = 0, settlements = 0;
  const options = { fetch: async () => { calls++; return Response.json(result()); } };
  for (const hook of ["onPrepared", "onBeforeModelStep"] as const) for (const code of ["budget_exhausted", "outcome_unknown"]) {
    await expect(callImageDecisionModel({ ...input, [hook]: async () => { throw Object.assign(new Error(apiKey), { code }); } }, apiKey, options))
      .rejects.toMatchObject({ code });
  }
  const controller = new AbortController(); controller.abort(new Error(apiKey));
  await expect(callImageDecisionModel({ ...input, signal: controller.signal }, apiKey, options)).rejects.toMatchObject({ code: "cancelled" });
  await expect(callImageDecisionModel(input, apiKey, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  const saved = await callImageDecisionModel(input, apiKey, { fetch: response(result(0.2)) });
  const hashes: string[] = [];
  for (let i = 0; i < 2; i++) {
    const reused = await callImageDecisionModel({ ...input,
      onPrepared: async v => { hashes.push(v.prompt); return { output: saved.output }; },
      onBeforeModelStep: async () => { steps++; }, onModelStepSettled: async () => { settlements++; },
    }, apiKey, options);
    expect(reused.output).toEqual(saved.output); expect(reused.usage).toBeUndefined();
  }
  expect(hashes[0]).toBe(hashes[1]);
  await expect(callImageDecisionModel({ ...input, onPrepared: async () => ({ output: { ...saved.output, answers: {} } }) }, apiKey, options))
    .rejects.toMatchObject({ failureCategory: "validation" });
  expect([calls, steps, settlements]).toEqual([0, 0, 0]);
});

test("invalid JPEG, PDF, dimensions, question companions and keys stop before telemetry", async () => {
  let calls = 0;
  const options = { fetch: async () => { calls++; return Response.json(result()); } };
  const countTelemetry = async () => { calls++; };
  for (const data of ["", "!!!!", Buffer.from("%PDF-1.7").toString("base64"), jpeg("256x256"), jpeg("1569x280"), input.image.data.slice(0, -4)]) {
    await expect(callImageDecisionModel({ ...input, image: { mediaType: "image/jpeg", data }, onRequest: countTelemetry }, apiKey, options))
      .rejects.toMatchObject({ failureCategory: "validation" });
  }
  for (const key of ["", "secret token", "secret\n"]) await expect(callImageDecisionModel({ ...input, onRequest: countTelemetry }, key, options)).rejects.toMatchObject({ failureCategory: "validation" });
  await expect(callImageDecisionModel({ ...input, questions: { target: { type: "box", instructions: "Find", presenceQuestion: "missing" } } }, apiKey, options)).rejects.toMatchObject({ failureCategory: "validation" });
  expect(calls).toBe(0);
});

test("unknown usage is never zero or inferred from image size; failures settle once without retry or secret leakage", async () => {
  for (const usage of [undefined, { input_tokens: -1, output_tokens: 0 }, { input_tokens: "100", output_tokens: 1 }]) {
    const output = await callImageDecisionModel(input, apiKey, { fetch: response({ ...result(), usage }) });
    expect(output.usage).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostUsd: null });
  }
  for (const fetcher of [async () => { throw new Error(apiKey); }, async () => new Response(apiKey),
    async () => Response.json({ error: { code: "invalid_image", message: `${apiKey} ${input.image.data}` } }, { status: 400, headers: { "x-request-id": "req_image" } })]) {
    let calls = 0; const settlements: unknown[] = [];
    const error = await callImageDecisionModel({ ...input, onModelStepSettled: async v => { settlements.push(v); } }, apiKey,
      { fetch: async () => { calls++; return fetcher(); } }).catch(e => e);
    expect(error.code).toBe("decision_provider_error");
    expect(JSON.stringify(error)).not.toContain(apiKey); expect(JSON.stringify(error)).not.toContain(input.image.data);
    expect(error.cause).toBeUndefined();
    expect(calls).toBe(1); expect(settlements).toEqual([{ ordinal: 1, usage: undefined }]);
    if (error.providerStatus === 400) expect(error.diagnostics).toMatchObject({ providerMessage: "[redacted] [redacted]", providerRequestId: "req_image" });
  }
});

test("cancellation and 15s active deadline also bound transports ignoring abort", async () => {
  const controller = new AbortController(); const settled: unknown[] = [];
  const pending = callImageDecisionModel({ ...input, onModelStepSettled: async v => { settled.push(v); } }, apiKey,
    { signal: controller.signal, fetch: () => { controller.abort(); return new Promise(() => {}); } });
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  expect(settled).toEqual([{ ordinal: 1, usage: undefined }]);
  const start = Date.now();
  await expect(callImageDecisionModel(input, apiKey, { fetch: () => new Promise(() => {}) })).rejects.toMatchObject({ code: "timeout" });
  expect(Date.now() - start).toBeLessThan(16500);
}, 20000);

test("exact image pricing preserves 1.13 and unknown model behavior", () => {
  for (const modelId of ["jev-1.13.0", "jev-1.14.0"]) expect(estimateCostUsd({ provider: "typesafe", modelId,
    inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: null }).estimatedCostUsd).toBe(0.042);
  expect(estimateCostUsd({ provider: "typesafe", modelId: "jev-1.14.1", inputTokens: 1000, outputTokens: 10, cachedInputTokens: null }).estimatedCostUsd).toBeNull();
});
