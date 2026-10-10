import { expect, test } from "bun:test";
import { createMockModel, MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { callMastraSupervisor } from "./mastra-supervisor";

const base = { provider: "openai" as const, runId: crypto.randomUUID(), goal: "Review evidence", context: {} };
test("real Mastra agent validates scoped specialist output and redacts transient secrets", async () => {
  const key = "sk-test-secret";
  const output = await callMastraSupervisor({ ...base, phase: "specialist" }, key, {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: ({ summary: `Evidence ${key}`, rationale: "Only assigned sources", citations: [] }) }),
  });
  expect(output).toEqual({ summary: "Evidence [redacted]", rationale: "Only assigned sources", citations: [] });
});
test("real Mastra agent rejects plans outside bounded schema", async () => {
  await expect(callMastraSupervisor({ ...base, phase: "plan" }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: ({ tasks: [{ role: "admin", goal: "Write data", sourceVersionIds: [] }] }) }),
  })).rejects.toThrow("Supervisor model execution failed");
});
test("Mastra truncation and OpenAI schema failures remain retryable without exposing output", async () => {
  for (const failure of ["truncated", "schema"] as const) {
    for (const streaming of [false, true]) {
      const secret = "sk-test-secret";
      const text = failure === "truncated" ? `{"summary":"${secret}`
        : JSON.stringify({ summary: secret, rationale: "Invalid citation", citations: ["not-a-uuid"] });
      const finishReason = failure === "truncated" ? "length" : "stop";
      const usage = { inputTokens: 12, outputTokens: 50, totalTokens: 62 };
      const model = new MastraLanguageModelV2Mock({
        provider: "openai",
        modelId: "gpt-4.1",
        doGenerate: async () => ({ content: [{ type: "text", text }], finishReason, usage, warnings: [] }),
        doStream: async () => ({ stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "text-start", id: "output" });
          controller.enqueue({ type: "text-delta", id: "output", delta: text });
          controller.enqueue({ type: "text-end", id: "output" });
          controller.enqueue({ type: "finish", finishReason, usage });
          controller.close();
        } }) }),
      });
      const error = await callMastraSupervisor({
        ...base, phase: "specialist",
        onSummaryDelta: streaming ? async () => {} : undefined,
      }, secret, { model }).then(() => { throw new Error("Invalid output was accepted"); }, error => error);
      expect(error).toMatchObject({
        code: "invalid_provider_output", providerFailure: true, retryable: true, failureCategory: "validation",
      });
      expect(error.providerStatus).toBeUndefined();
      expect(error.cause).toBeUndefined();
      expect(`${error.message}${JSON.stringify(error)}`).not.toContain(secret);
      expect(`${error.message}${JSON.stringify(error)}`).not.toContain("not-a-uuid");
    }
  }
});
test("real Mastra agent returns a valid focused plan", async () => {
  const plan = { tasks: [{ role: "source_reviewer", goal: "Check assigned source", sourceVersionIds: [crypto.randomUUID()] }] };
  expect(await callMastraSupervisor({ ...base, phase: "plan" }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: plan }),
  })).toEqual(plan);
});

test("independent review requires evidence findings and does not inherit the supervisor conclusion", async () => {
  let request: any;
  const finding = {
    summary: "The draft is supported with one scope note.",
    rationale: "Checked the supplied source excerpts independently.",
    citations: [crypto.randomUUID()],
    decision: "accept",
    findings: [{ severity: "note", issue: "One source excludes balcony doors.", recommendation: "Keep that exclusion visible.", citations: [crypto.randomUUID()] }],
    revisions: [],
  };
  const output = await callMastraSupervisor({ ...base, phase: "independent_review", context: { role: "independent_reviewer", proposedResult: "Draft" } }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: finding, spyGenerate: value => { request = value; } }),
  });
  expect(output).toEqual(finding);
  const prompt = JSON.stringify(request);
  expect(prompt).toContain("fresh, independent reviewer");
  expect(prompt).toContain("Re-read the supplied immutable source excerpts");
});

test("source review plans treat unreviewed files as readable and honor all-source requests", async () => {
  let request: any;
  await callMastraSupervisor({
    ...base,
    phase: "plan",
    goal: "Review all project files and prepare the requested plan",
    context: { sourceInventory: { sources: [{ versionId: crypto.randomUUID() }], truncated: false } },
  }, "test-key", {
    model: createMockModel({
      version: "v2",
      objectGenerationMode: "json",
      mockText: { tasks: [{ role: "source_reviewer", goal: "Review the available project source", sourceVersionIds: [crypto.randomUUID()] }] },
      spyGenerate: value => { request = value; },
    }),
  });
  const prompt = JSON.stringify(request);
  expect(prompt).toContain("unreviewed status is not a reason to defer inspection");
  expect(prompt).toContain("distribute every available version across assignments");
  expect(prompt).toContain("do not claim full coverage");
});

test("configured reasoning and output budget reach the selected provider", async () => {
  let request: any;
  await callMastraSupervisor({ ...base, phase: "specialist", modelConfig: { modelId: "gpt-5.1", reasoningEffort: "low", maxOutputTokens: 900, maxSteps: 1 } }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { summary: "Done", rationale: "Evidence", citations: [] }, spyGenerate: value => { request = value; } }),
  });
  expect(request.maxOutputTokens).toBe(900);
  expect(request.providerOptions.openai).toEqual({ store: false, reasoningEffort: "low" });
});
test("live model calls require a configured preset", async () => {
  await expect(callMastraSupervisor({ ...base, phase: "plan" }, "test-key")).rejects.toThrow("preset is unconfigured");
});

test("Mastra streams only decoded sanitized summary deltas", async () => {
  const deltas: string[] = [];
  const summary = "The assigned evidence confirms a documented requirement. sk-test-secret Additional review remains necessary before approval.";
  const output = await callMastraSupervisor({ ...base, phase: "specialist", onSummaryDelta: async delta => { deltas.push(delta); } }, "sk-test-secret", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { summary, rationale: "Private rationale is not a streamed summary", citations: [] } }),
  });
  expect(deltas.join("")).toBe(summary.replace("sk-test-secret", "[redacted]"));
  expect(deltas.join("")).not.toContain("rationale");
  expect(output).toHaveProperty("summary", deltas.join(""));
});

test("an already cancelled inference never invokes a model or emits summary", async () => {
  let invoked = false;
  const signal = AbortSignal.abort();
  await expect(callMastraSupervisor({ ...base, phase: "review", onSummaryDelta: async () => { throw new Error("Must not emit"); } }, "test-key", {
    signal,
    model: createMockModel({ version: "v2", mockText: {}, spyStream: () => { invoked = true; } }),
  })).rejects.toThrow("Supervisor model execution failed");
  expect(invoked).toBe(false);
});

function chunkedModel(text: string, onFinish: () => void = () => {}) {
  return new MastraLanguageModelV2Mock({ doStream: async ({ abortSignal }) => {
    let offset = -1;
    return { stream: new ReadableStream({ async pull(controller) {
      await Bun.sleep(1);
      if (abortSignal?.aborted) { controller.error(new Error("Cancelled upstream")); return; }
      if (offset === -1) { controller.enqueue({ type: "text-start", id: "summary" }); offset = 0; return; }
      if (offset < text.length) {
        controller.enqueue({ type: "text-delta", id: "summary", delta: text.slice(offset, offset + 7) });
        offset += 7; return;
      }
      onFinish();
      controller.enqueue({ type: "text-end", id: "summary" });
      controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
      controller.close();
    } }) };
  } });
}

test("real partial-object stream emits before provider finishes and hides split credentials", async () => {
  let finished = false;
  let liveDeltas = 0;
  const deltas: string[] = [];
  const summary = "The reviewed source has useful evidence that is ready for review. sk-test-secret This conclusion still needs human approval.";
  await callMastraSupervisor({ ...base, phase: "specialist", onSummaryDelta: async delta => {
    if (!finished) liveDeltas++;
    deltas.push(delta);
  } }, "sk-test-secret", { model: chunkedModel(JSON.stringify({ summary, rationale: "Rationale only", citations: [] }), () => { finished = true; }) });
  expect(liveDeltas).toBeGreaterThan(1);
  expect(deltas.join("")).toBe(summary.replace("sk-test-secret", "[redacted]"));
  expect(deltas.some(delta => delta.includes("sk-"))).toBe(false);
});

test("cancelling during structured streaming stops summary publication", async () => {
  const controller = new AbortController();
  let count = 0;
  await expect(callMastraSupervisor({ ...base, phase: "specialist", onSummaryDelta: async () => {
    count++; controller.abort();
  } }, "test-key", { signal: controller.signal, model: chunkedModel(JSON.stringify({ summary: "A sufficiently long evidence summary has begun streaming and will be interrupted before further details can be published.", rationale: "Evidence", citations: [] })) })).rejects.toThrow("Supervisor model execution failed");
  expect(count).toBe(1);
});
