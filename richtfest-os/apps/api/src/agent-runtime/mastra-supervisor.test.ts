import { expect, spyOn, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { createMockModel, MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { callMastraSupervisor, supervisorSchemas } from "./mastra-supervisor";
import { assertDocumentCitations, createSupervisor, stepSupervisor, supervisorReview } from "../../../../../richtfest-apps/knowledge/src/supervisor";
import { sanitizeProviderDiagnostics } from "@richtfest/knowledge/deps";
import type { AppDeps, ProviderExecutionSettings } from "@richtfest/knowledge/deps";
import { knowledgeDeps } from "../app-hosts";
import { agentRuns, agentRunAttempts, agentRunEvents, agentRunUsage, supervisorRuns, tasks, artifacts, artifactRevisions } from "@richtfest/knowledge/schema";
import { eq } from "drizzle-orm";
import { createDatabase } from "../db/client";
import { acousticSectionKeys, agentPresetSnapshotSchema, domainSpecialistRoles, agentModelInputByteBudget, agentExecutionLimitsSchema, companyKnowledgeSearchSchema, exteriorNoiseExtractionSchema } from "@richtfest/shared";
import { vendorPreset } from "../agent-presets";
import { acousticConceptFixture, legacyAcousticDraft } from "../../../../../tests/fixtures/acoustic-concepts";
import { exteriorNoiseFixture } from "../../../../../tests/fixtures/exterior-noise";
import { exteriorNoisePackets } from "../../../../../tests/fixtures/exterior-noise-packets";
import { calculateAcoustics } from "@richtfest/acoustics";
import { metadataHash, serializeProviderInput } from "../provider-metadata";

const base = { provider: "openai" as const, runId: crypto.randomUUID(), goal: "Review evidence", context: {} };
test("Astra report cache boundary survives real Responses transport without losing evidence or hiding write costs", async () => {
  const requests: any[] = [];
  let writes: number | undefined = 300;
  const output = { complete: true, citations: [], content: "Evidence remains unreviewed." };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
    requests.push(await request.json());
    const text = JSON.stringify(output);
    const events = [
      { type: "response.created", response: { id: "resp_test", created_at: 1, model: "gpt-6-astra" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
      { type: "response.completed", response: { id: "resp_test", status: "completed", usage: {
        input_tokens: 2000, output_tokens: 10, input_tokens_details: { cached_tokens: 500, cache_write_tokens: writes },
        output_tokens_details: { reasoning_tokens: 3 },
      } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const prepared: any[] = [], settings: ProviderExecutionSettings[] = [], receipts: any[] = [];
  const context = { documentTask: "section", documentTemplate: { id: "exterior-noise-concept", version: 1 },
    section: "plans", batch: 1, batchCount: 2, workspaceGuidance: { profile: { instructions: "Retain uncertainty. ".repeat(100) } },
    project: { name: "Brücke 🧱", number: "R-71" }, language: "de", sources: [{ text: 'Untrusted "claim"\n31.7 dB', pages: [7, 3] }],
    futureField: { unknown: "must not disappear" },
  };
  const invoke = async (value: typeof context, modelId = "gpt-6-astra") => callMastraSupervisor({ ...base, phase: "review", context: value,
    modelConfig: { modelId, maxOutputTokens: 2048, maxSteps: 1 },
    onRequest: async value => { settings.push(value); }, onPrepared: async value => { prepared.push(value); return undefined; },
    onBeforeModelStep: async () => {}, onModelStepSettled: async value => { receipts.push(value); },
  }, "test-key", { model: new ModelRouterLanguageModel({ id: `openai/${modelId}`, api: "responses", url: `${server.url}v1`, apiKey: "test-key" }) });
  try {
    expect(await invoke(context)).toEqual(output);
    writes = 0;
    const next = { ...context, batch: 2, sources: [{ text: "Different evidence: 48.2 dB", pages: [9, 5] }] };
    expect(await invoke(Object.fromEntries(Object.entries(next).reverse()) as typeof context)).toEqual(output);
    const prefixes: string[] = [];
    for (const [index, value] of [context, next].entries()) {
      const body = requests[index];
      expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
      expect(body.max_output_tokens).toBe(2048);
      expect(body.store).toBe(false);
      expect(body.tools ?? []).toHaveLength(0);
      const users = body.input.filter((message: any) => message.role === "user");
      expect(users).toHaveLength(1);
      const parts = users[0].content;
      expect(parts).toHaveLength(2);
      expect(parts[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
      expect(parts[1].prompt_cache_breakpoint).toBeUndefined();
      prefixes.push(parts[0].text);
      const joined = parts.map((part: any) => part.text).join("");
      expect(JSON.parse(joined)).toEqual({ goal: base.goal, context: value });
      expect(prepared[index].prompt).toBe(joined);
      expect(settings[index]!.promptHash).toBe(metadataHash(joined));
      expect(settings[index]!.promptCache).toBe("report-prefix-v1");
    }
    expect(prefixes[0]).toBe(prefixes[1]);
    expect(requests[0].input[0]).toEqual(requests[1].input[0]);
    expect(receipts[0].usage).toMatchObject({ inputTokens: 2000, outputTokens: 10, cachedInputTokens: 500,
      cacheWriteInputTokens: 300, reasoningTokens: 3, totalTokens: 2010, estimatedCostUsd: 0.01675, pricingVersion: "2026-10-15-cache-writes" });
    expect(receipts[1].usage).toMatchObject({ cacheWriteInputTokens: 0, estimatedCostUsd: 0.016 });
    writes = undefined;
    await invoke(context);
    expect(receipts[2].usage).toMatchObject({ cacheWriteInputTokens: null, estimatedCostUsd: null });
    // Unsupported models keep their original single-prompt transport and pricing.
    await invoke(context, "gpt-4.1");
    expect(requests[3].prompt_cache_options).toBeUndefined();
    expect(settings[3]!.promptCache).toBeUndefined();
    expect(prepared[3].prompt).toBe(serializeProviderInput({ goal: base.goal, context }));
    const estimate = knowledgeDeps({} as any, { actor: { id: "test", tenantId: "test" } } as any).estimateCallCost!;
    // Full bound at the 1.25x write rate, not an assumed cache hit.
    expect(estimate("openai", settings[0]!, 2000, false)).toBe(0.1274);
    expect(requests).toHaveLength(4);
  } finally { await server.stop(true); }
});

for (const modelId of ["gpt-6-astra", "test-model"])
for (const imageCount of [1, 2])
test(`visual inspection preserves ${imageCount} native images and bounds tokens without pricing base64 as text: ${modelId}`, async () => {
  const request = { versionId: crypto.randomUUID(), page: 2, crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
  const data = Buffer.alloc(1024 * 1024, 71).toString("base64");
  const metadata = { ...request, status: "available" as const, scope: "pdf_page" as const, reason: "Unreviewed visual evidence" };
  let rounds = 0, inspections = 0;
  const prompts: any[] = [];
  const admitted: { ordinal: number; inputBytes: number; hasMedia: boolean; inputTokenUpperBound?: number }[] = [];
  const settled: any[] = [];
  let settings!: ProviderExecutionSettings;
  const output = { summary: "Inspected the exact page crop.", rationale: "Visual inference, not approved measurements.", citations: [request.versionId] };
  const model = new MastraLanguageModelV2Mock({ doStream: async options => {
    const bytes = Buffer.byteLength(JSON.stringify(options));
    expect(admitted[rounds]!.inputBytes).toBe(bytes);
    expect(settled).toHaveLength(rounds);
    prompts.push(options.prompt);
    const inspect = rounds++ === 0;
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (inspect) for (let i = 1; i <= imageCount; i++) controller.enqueue({ type: "tool-call", toolCallId: `visual-${i}`, toolName: "inspect_project_source", input: JSON.stringify(request) });
      else {
        controller.enqueue({ type: "text-start", id: "result" });
        controller.enqueue({ type: "text-delta", id: "result", delta: JSON.stringify(output) });
        controller.enqueue({ type: "text-end", id: "result" });
      }
      controller.enqueue({ type: "finish", finishReason: inspect ? "tool-calls" : "stop", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
      controller.close();
    } }) };
  } });
  expect(await callMastraSupervisor({ ...base, phase: "specialist", context: { role: "source_reviewer", sourceVersionIds: [request.versionId] },
    modelConfig: { modelId, maxOutputTokens: 2048, maxSteps: 2 },
    onRequest: async value => { settings = value; },
    onBeforeModelStep: async step => { admitted.push(step); },
    onModelStepSettled: async step => { settled.push(step); },
    inspectSource: async input => { inspections++; expect(input).toEqual(request); return { ...metadata, image: { mediaType: "image/jpeg", data } }; },
  }, "test-key", { model })).toEqual(output);
  expect(rounds).toBe(2);
  expect(inspections).toBe(imageCount);
  expect(admitted.map(s => [s.ordinal, s.hasMedia])).toEqual([[1, false], [2, true]]);
  // Astra accepts at most 30,000 image patches at 1.2 tokens each, plus
  // one token for documented rounding. Transport size is not image tokens.
  expect(admitted[0]!.inputTokenUpperBound).toBeUndefined();
  if (modelId === "gpt-6-astra") {
    expect(admitted[1]!.inputTokenUpperBound).toBeGreaterThan(imageCount * 36001);
    expect(admitted[1]!.inputTokenUpperBound).toBeLessThan(imageCount * 36001 + 25000);
  } else expect(admitted[1]!.inputTokenUpperBound).toBeUndefined();
  const estimate = knowledgeDeps({} as any, { actor: { id: "test", tenantId: "test" } } as any).estimateCallCost!;
  const measured = admitted[1]!;
  const cost = estimate("openai", { ...settings, maxSteps: 1 }, measured.inputBytes, measured.hasMedia, measured.inputTokenUpperBound);
  if (modelId === "gpt-6-astra") {
    expect(cost).toBeCloseTo(measured.inputTokenUpperBound! * 10 / 1_000_000 + 2048 * 50 / 1_000_000, 8);
    expect(estimate("openai", { ...settings, maxSteps: 1 }, measured.inputBytes, true)).toBeGreaterThan(imageCount * 40);
  } else expect(cost).toBeNull();
  expect(settled.map(s => [s.ordinal, s.usage.inputTokens, s.usage.outputTokens])).toEqual([[1, 10, 20], [2, 10, 20]]);
  const results = prompts[1].filter((message: any) => message.role === "tool").flatMap((message: any) => message.content);
  expect(results).toHaveLength(imageCount);
  const result = results.find((part: any) => part.type === "tool-result" && part.toolCallId === "visual-1");
  expect(result.output).toEqual({ type: "content", value: [
    { type: "text", text: JSON.stringify(metadata) }, { type: "media", mediaType: "image/jpeg", data },
  ] });
  // Estimation must not mutate either the true output or the SDK's copies.
  expect(result.providerOptions.mastra.modelOutput).toEqual(result.output);
  expect(result.output.value.filter((part: any) => part.type === "text").map((part: any) => part.text).join("")).not.toContain(data);
});

test("image triage stays text-only and the model can escalate to direct visual inspection", async () => {
  const request = { versionId: crypto.randomUUID(), page: 3 };
  const image = Buffer.from("synthetic-vision-image").toString("base64");
  const receipt = { ...request, status: "completed" as const, model: "jev-1.14.0" as const,
    queryVersion: "image-triage-v1" as const, provenance: "inferred" as const, semanticInspection: false as const,
    reason: "Uncertain page classification; not direct inspection.", answers: { table: { type: "noul" as const, noul: 0.52 } } };
  const output = { summary: "Inspected the source after uncertain triage.", rationale: "Still unreviewed.", citations: [request.versionId] };
  let round = 0, queries = 0, inspections = 0;
  const model = new MastraLanguageModelV2Mock({ doStream: async options => {
    const step = round++;
    const prompt = JSON.stringify(options.prompt);
    if (step === 1) {
      expect(prompt).toContain("semanticInspection");
      expect(prompt).toContain("0.52");
      expect(prompt).not.toContain(image);
      expect(prompt).not.toContain('"type":"media"');
    }
    if (step === 2) expect(prompt).toContain(image);
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (step < 2) controller.enqueue({ type: "tool-call", toolCallId: `triage-${step}`,
        toolName: step === 0 ? "query_source_image" : "inspect_project_source", input: JSON.stringify(request) });
      else {
        controller.enqueue({ type: "text-start", id: "result" });
        controller.enqueue({ type: "text-delta", id: "result", delta: JSON.stringify(output) });
        controller.enqueue({ type: "text-end", id: "result" });
      }
      controller.enqueue({ type: "finish", finishReason: step < 2 ? "tool-calls" : "stop", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
      controller.close();
    } }) };
  } });
  expect(await callMastraSupervisor({ ...base, phase: "specialist", context: { role: "source_reviewer" },
    modelConfig: { modelId: "test-model", maxOutputTokens: 2048, maxSteps: 3 },
    querySourceImage: async input => { queries++; expect(input).toEqual(request); return receipt; },
    inspectSource: async input => { inspections++; return { ...input, status: "available", scope: "pdf_page",
      reason: "Unreviewed", image: { mediaType: "image/jpeg", data: image } }; },
  }, "test-key", { model })).toEqual(output);
  expect([round, queries, inspections]).toEqual([3, 1, 1]);
});

test("visual inspection is not registered for a one-step model or planning", async () => {
  for (const [phase, maxSteps] of [["specialist", 1], ["plan", 4]] as const) {
    const output = phase === "plan" ? { tasks: [{ role: "source_reviewer", goal: "Review source", sourceVersionIds: [] }] }
      : { summary: "No visual tool available", rationale: "Step budget", citations: [] };
    expect(await callMastraSupervisor({ ...base, phase,
      modelConfig: { modelId: "test-model", maxOutputTokens: 2048, maxSteps },
      inspectSource: async () => { throw new Error("Visual inspection must not execute"); },
      querySourceImage: async () => { throw new Error("Image triage must not execute"); },
    }, "test-key", { model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output,
      spyStream: options => { expect(options.tools ?? []).toHaveLength(0); },
    }) })).toEqual(output);
  }
});

test("tool-capable specialists and independent reviewers reserve the last step and may finish early", async () => {
  for (const phase of ["specialist", "independent_review"] as const) for (const maxSteps of [2, 3]) for (const early of [false, true]) {
    const versionId = crypto.randomUUID();
    const output = { summary: "Supplied evidence reviewed", rationale: "Unreviewed inference", citations: [versionId],
      ...(phase === "independent_review" ? { decision: "accept", findings: [], revisions: [] } : {}) };
    let rounds = 0, reads = 0;
    const model = new MastraLanguageModelV2Mock({ doStream: async options => {
      const step = rounds++;
      const final = early || step === maxSteps - 1;
      if (step === maxSteps - 1) {
        expect(options.tools ?? []).toHaveLength(0);
        expect(options.toolChoice).toEqual({ type: "none" });
      } else expect(options.tools?.map(tool => tool.name)).toContain("inspect_project_source");
      expect(options.responseFormat?.type).toBe("json");
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        if (final) {
          controller.enqueue({ type: "text-start", id: "result" });
          controller.enqueue({ type: "text-delta", id: "result", delta: JSON.stringify(output) });
          controller.enqueue({ type: "text-end", id: "result" });
        } else for (const page of [1, 2]) controller.enqueue({ type: "tool-call", toolCallId: `${step}-${page}`,
          toolName: "inspect_project_source", input: JSON.stringify({ versionId, page: step * 2 + page }) });
        controller.enqueue({ type: "finish", finishReason: final ? "stop" : "tool-calls", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
        controller.close();
      } }) };
    } });
    expect(await callMastraSupervisor({ ...base, phase,
      modelConfig: { modelId: "test-model", maxOutputTokens: 2048, maxSteps },
      context: { role: "source_reviewer", sourceVersionIds: [versionId], sourceCoverage: { sliceVersionIds: [versionId] } },
      inspectSource: async request => { reads++; return { ...request, status: "unavailable", scope: "pdf_page", reason: "Rendering unavailable" }; },
    }, "test-key", { model })).toEqual(output);
    expect(rounds).toBe(early ? 1 : maxSteps);
    expect(reads).toBe(early ? 0 : 2 * (maxSteps - 1));
  }
});

test("company search keeps Unicode validation locally without sending unsupported regex to OpenAI", async () => {
  for (const term of ["Außenschallschutz", "DIN 4109-1", "隔音", " façade "]) {
    expect(companyKnowledgeSearchSchema.parse({ terms: [term] }).terms).toEqual([term.trim()]);
  }
  for (const term of ["", " ", "O'Brien", "<script>", "sound.*", "x".repeat(81)]) {
    expect(companyKnowledgeSearchSchema.safeParse({ terms: [term] }).success).toBe(false);
  }
  let request: any;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return Response.json({ error: { type: "invalid_request_error", message: "Offline schema capture" } }, { status: 400 });
  }) as typeof fetch);
  try {
    await expect(callMastraSupervisor({ ...base, phase: "specialist", context: { role: "sound_insulation" },
      modelConfig: { modelId: "gpt-6-luna", maxOutputTokens: 32000, maxSteps: 4 },
      searchCompanyKnowledge: async () => { throw new Error("Must not execute"); },
    }, "offline-placeholder")).rejects.toMatchObject({ providerStatus: 400 });
    const parameters = request.tools.find((tool: any) => tool.name === "search_company_knowledge").parameters;
    expect(parameters.properties.terms.items.type).toBe("string");
    expect(parameters.properties.terms.items.pattern).toBeUndefined();
    expect(parameters.required).toContain("category");
  } finally { fetchMock.mockRestore(); }
});
test("all configured specialist roles can retrieve company knowledge through Mastra without turning it into source citations", async () => {
  const categoryId = crypto.randomUUID();
  const receipt = { receiptId: crypto.randomUUID(), status: "matched" as const, terms: ["Schallschutz"],
    entries: [{ id: crypto.randomUUID(), title: "Acoustic reference", status: "approved" as const,
      categoryId, categoryName: "Schallschutz", displayTitle: "Protection targets", sourceLabel: "Reference 2022", chapter: "Page 17",
      excerpt: "Minimum requirements differ from agreed protection.", bodyHash: "a".repeat(64) }],
    coverage: { limited: true as const, maxEntries: 4 as const, maxCharsPerEntry: 2000 as const },
  };
  for (const role of ["source_reviewer", "requirements_reviewer", "sound_insulation", "construction_law", "cost_optimizer"]) {
    let round = 0;
    const category = role === "source_reviewer" ? categoryId : null;
    const model = new MastraLanguageModelV2Mock({ doStream: async options => {
      const search = round++ === 0;
      const received = options.prompt.filter(message => message.role === "tool").flatMap(message => message.content)
        .flatMap(part => part.type === "tool-result" && part.output.type === "json" ? [part.output.value as any] : []);
      if (!search) expect(received[0].entries[0]).toMatchObject({ categoryId, categoryName: "Schallschutz", sourceLabel: "Reference 2022", chapter: "Page 17" });
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        if (search) controller.enqueue({ type: "tool-call", toolCallId: "knowledge-1", toolName: "search_company_knowledge", input: JSON.stringify({ terms: ["Schallschutz"], category }) });
        else {
          controller.enqueue({ type: "text-start", id: "result" });
          controller.enqueue({ type: "text-delta", id: "result", delta: JSON.stringify({ summary: `${received[0].entries[0].title}: ${received[0].entries[0].excerpt}`, rationale: "General reference, not project evidence.", citations: [] }) });
          controller.enqueue({ type: "text-end", id: "result" });
        }
        controller.enqueue({ type: "finish", finishReason: search ? "tool-calls" : "stop", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
        controller.close();
      } }) };
    } });
    const result = await callMastraSupervisor({ ...base, phase: "specialist", context: { role },
      modelConfig: { modelId: "test-model", maxOutputTokens: 2048, maxSteps: 2 },
      searchCompanyKnowledge: async input => { expect(input).toEqual({ terms: ["Schallschutz"], category: category ?? undefined }); return receipt; },
    }, "test-key", { model });
    expect(result).toMatchObject({ summary: "Acoustic reference: Minimum requirements differ from agreed protection.", citations: [] });
  }
  for (const [phase, maxSteps] of [["specialist", 1], ["review", 4]] as const) {
    await callMastraSupervisor({ ...base, phase, context: { role: "source_reviewer" },
      modelConfig: { modelId: "test-model", maxOutputTokens: 2048, maxSteps },
      searchCompanyKnowledge: async () => { throw new Error("Must not execute"); },
    }, "test-key", { model: createMockModel({ version: "v2", objectGenerationMode: "json",
      mockText: { summary: "No retrieval in this phase", rationale: "", citations: [], ...(phase === "review" ? { decision: "accept", revisions: [], document: { title: "Review", content: "No project evidence." } } : {}) },
      spyStream: request => { expect(request.tools ?? []).toHaveLength(0); },
    }) });
  }
});

test("Mastra specialists execute all acoustic tools before returning structured findings", async () => {
  const provenance = { kind: "assumption", reason: "Synthetic demonstration" };
  const { method, elements, elementsComplete, flanking, ...room } = exteriorNoiseFixture();
  const calls = [
    { name: "sum_sound_levels", input: { receiver: "Facade", weighting: "A", period: "Day", uncorrelatedSources: true,
      sources: [60, 70].map(levelDb => ({ label: String(levelDb), levelDb, provenance })) } },
    { name: "equivalent_sound_level", input: { receiver: "Facade", weighting: "A",
      intervals: [{ label: "Loud", levelDb: 70, durationSeconds: 1, provenance }, { label: "Quiet", levelDb: 50, durationSeconds: 9, provenance }] } },
    { name: "composite_sound_reduction", input: { bandCentreHz: 500, bandwidth: "third_octave",
      elements: [{ label: "Wall", areaM2: 9, reductionDb: 50, provenance }, { label: "Window", areaM2: 1, reductionDb: 20, provenance }] } },
    { name: "exterior_noise_room_requirement", input: room },
    { name: "exterior_noise_facade", input: { ...room, elements, elementsComplete, flanking } },
    { name: "exterior_noise_facade", input: { ...room, elements, elementsComplete: false, flanking } },
  ];
  const receipts: any[] = [];
  let round = 0;
  let settings: any, prepared: any;
  const model = new MastraLanguageModelV2Mock({ doStream: async options => {
    const call = calls[round++];
    const received = options.prompt.filter(message => message.role === "tool").flatMap(message => message.content)
      .flatMap(part => part.type === "tool-result" && part.output.type === "json" ? [part.output.value as any] : []);
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (call) controller.enqueue({ type: "tool-call", toolCallId: `calculation-${round}`, toolName: call.name, input: JSON.stringify(call.input) });
      else {
        controller.enqueue({ type: "text-start", id: "result" });
        controller.enqueue({ type: "text-delta", id: "result", delta: JSON.stringify({ summary: received.map(r => r.status === "unsupported" ? "unsupported" : `${r.value.toFixed(3)} ${r.unit}`).join("; "), rationale: "Arithmetic only, inputs not reviewed.", citations: [] }) });
        controller.enqueue({ type: "text-end", id: "result" });
      }
      controller.enqueue({ type: "finish", finishReason: call ? "tool-calls" : "stop", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
      controller.close();
    } }) };
  } });
  const result = await callMastraSupervisor({ ...base, phase: "specialist", context: { role: "sound_insulation", acousticToolsAvailable: true },
    modelConfig: { modelId: "test-model", maxOutputTokens: 2048, maxSteps: 8 },
    calculateAcoustics: async input => { const receipt = { ...calculateAcoustics(input), receiptId: crypto.randomUUID() }; receipts.push(receipt); return receipt; },
    onRequest: async value => { settings = value; }, onPrepared: async value => { prepared = value; return undefined; },
  }, "test-key", { model });
  expect(result).toMatchObject({ summary: "70.414 dB(A); 60.374 dB(A); 29.961 dB; 44.650 dB; 44.669 dB; unsupported", citations: [] });
  expect(receipts).toHaveLength(6);
  expect(receipts.every(r => r.reviewStatus === "not_reviewed")).toBe(true);
  expect(settings).toMatchObject({ maxSteps: 8, maxOutputTokens: 2048 });
  expect(settings.toolSchemaHash).toMatch(/^[0-9a-f]{64}$/);
  expect(prepared.tools.map((tool: any) => tool.name)).toEqual([...new Set(calls.map(call => call.name))]);
});

test("exterior source extraction returns structured inputs without exposing arithmetic tools", async () => {
  const partial = exteriorNoisePackets()[0]!;
  partial.facts.find(f => f.field === "envelopeComplete")!.value = false;
  partial.facts.find(f => f.field === "levelDb")!.value = 0;
  const { method, ...room } = exteriorNoiseFixture();
  const provenance = partial.inventory[0]!.provenance;
  for (const record of [room.room, room.applicability, room.flanking, ...room.facades, ...room.facades.map(f => f.noise), ...room.elements])
    record.provenance = provenance;
  const packets = [
    { inventory: [], rooms: [], facts: [], blockers: [{ roomId: null, reason: "No room schedule in this packet" }] },
    partial,
    { inventory: [{ roomId: room.room.id, provenance: room.room.provenance }], rooms: [{ ...room, fieldEvidence: [] }], facts: [], blockers: [] },
  ];
  for (const extraction of packets) {
    const output = { summary: "Extracted inputs remain unreviewed", rationale: "No inference", citations: [], messages: [], exteriorNoiseExtraction: extraction };
    let wire: any;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
      wire = await request.json();
      const text = JSON.stringify(output);
      const events = [
        { type: "response.created", response: { id: "resp_test", created_at: 1, model: "gpt-6-luna" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant", content: [] } },
        { type: "response.output_text.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
        { type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 10, output_tokens: 20 } } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const result = await callMastraSupervisor({ ...base, phase: "specialist", context: { role: "sound_insulation", extractExteriorNoise: true, extractionVersion: 2,
        sources: [{ versionId: provenance.versionId, text: provenance.excerpt }] },
        modelConfig: { modelId: "gpt-6-luna", maxOutputTokens: 2048, maxSteps: 4 },
        calculateAcoustics: async () => { throw new Error("Arithmetic belongs to the application stage"); },
      }, "test-key", { model: new ModelRouterLanguageModel({ id: "openai/gpt-6-luna", api: "responses", url: `${server.url}v1`, apiKey: "test-key" }) });
      expect(result).toEqual(output);
      expect(wire.tools ?? []).toHaveLength(0);
      expect(wire.text.format.strict).toBe(true);
      const schema = wire.text.format.schema.properties.exteriorNoiseExtraction;
      expect(schema.required).toEqual(["inventory", "rooms", "facts", "blockers"]);
      expect(schema.properties.facts.type).toBe("array");
      expect(schema.properties.rooms.items.properties.fieldEvidence.type).toBe("array");
      expect(schema.properties.facts.items.properties.value.anyOf).toEqual([{ type: "string" }, { type: "number" }, { type: "boolean" }]);
      expect(schema.properties.facts.items.properties.provenance.properties.versionId.enum).toEqual([provenance.versionId]);
      expect(schema.properties.inventory.items.properties.provenance.properties.versionId.enum).toEqual([provenance.versionId]);
      expect(schema.properties.rooms.items.properties.facades.items.properties.noise.properties.provenance.properties.versionId.enum).toEqual([provenance.versionId]);
    } finally { server.stop(true); }
  }
});

test("acoustic tools are absent for other roles and insufficient model steps", async () => {
  for (const [role, maxSteps] of [["sound_insulation", 1], ["source_reviewer", 4], ["construction_law", 4]] as const) {
    const output = { summary: "No arithmetic tool is available", rationale: "Configuration limit", citations: [] };
    const result = await callMastraSupervisor({ ...base, phase: "specialist", context: { role, acousticToolsAvailable: true },
      modelConfig: { modelId: "test-model", maxOutputTokens: 2048, maxSteps },
      calculateAcoustics: async () => { throw new Error("Must not execute"); },
    }, "test-key", { model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output,
      spyStream: request => { expect(request.tools ?? []).toHaveLength(0); },
    }) });
    expect(result).toEqual(output);
  }
});

test("authoring, editorial and source-review context budgets reject oversized prompts before inference", async () => {
  expect(agentModelInputByteBudget("openai", "gpt-6-astra", 8000)).toBe(832000);
  expect(agentModelInputByteBudget("vercel", "openai/gpt-6.1-sol", 128000)).toBe(712000);
  expect(agentModelInputByteBudget("openai", "gpt-4.1-mini-2025-04-14", 8000)).toBe(830060);
  expect(agentModelInputByteBudget("anthropic", "claude-sonnet-5-5", 8000)).toBe(792000);
  for (const [provider, modelId] of [["openai", "unknown"], ["openai", "gpt-6-astra-custom"], ["anthropic", "gpt-6-astra"],
    ["vercel", "other/gpt-6-astra"], ["vercel", "gpt-6-astra"], ["vercel", "openai/gpt-6-astra/extra"]] as const)
    expect(agentModelInputByteBudget(provider, modelId, 8000)).toBeUndefined();
  const content = "Source-backed report section, pending specialist review.";
  let prepared = 0;
  for (const task of ["section", "editorial", "editorial_check", "specialist", "independent_review"] as const) for (const length of [20000, 840000]) {
    const phase = task === "specialist" || task === "independent_review" ? task : "review";
    const output = task === "editorial" ? { sections: [{ key: "components", content }], complete: true }
      : task === "editorial_check" ? { preserved: true, issues: [] }
      : phase === "review" ? { content, citations: [], complete: true }
      : { summary: content, rationale: "", citations: [], ...(phase === "independent_review" ? { decision: "accept", findings: [], revisions: [] } : {}) };
    const response = callMastraSupervisor({ ...base, phase, modelConfig: { modelId: "gpt-6-astra", maxOutputTokens: 8000, maxSteps: 1 },
      context: { ...(phase === "review" ? { documentTask: task, documentTemplate: { id: "exterior-noise-concept", version: 1 } } : { role: "source_reviewer" }), original: { content: "x".repeat(length) } },
      onPrepared: async () => { prepared++; return undefined; },
    }, "test-key", { model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output }) });
    if (length === 20000) expect(await response).toEqual(output);
    else await expect(response).rejects.toMatchObject({ retryable: false, diagnostics: { errorId: "CONTEXT_BUDGET_EXCEEDED" } });
  }
  expect(prepared).toBe(5);
});

test("acoustic dependency planning uses a bounded tool-free contract instead of report writing", async () => {
  const output = { summary: "B02 awaits evidence; A01 is calculated.", questions: [{ question: "Confirm B02 geometry?", roomIds: ["B02"] }],
    independentWork: "Publish the saved A01 result as an unapproved partial sheet.", publishPartialSheet: true };
  const request = { ...base, phase: "review" as const, goal: "Schallschutznachweis", modelPolicy: responsePolicy,
    modelConfig: { modelId: "test-model", maxOutputTokens: 32000, maxSteps: 4 },
    context: { documentTask: "acoustic_progress", calculatedRoomIds: ["A01"] } };
  expect(await callMastraSupervisor(request, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output,
      spyStream: options => { expect(options.tools ?? []).toHaveLength(0); } }),
  })).toEqual(output);
  await expect(callMastraSupervisor(request, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { ...output, publishPartialSheet: "yes" } }),
  })).rejects.toMatchObject({ code: "invalid_provider_output", failureCategory: "validation" });
});

test("concept authoring accepts outline, section, editorial and preservation contracts through Mastra", async () => {
  const id = "exterior-noise-concept";
  const versionId = crypto.randomUUID();
  const outline = { id, title: "Außenlärmkonzept", language: "de",
    project: { name: "Project", number: null, client: null, designer: null, author: null, date: null },
    sections: acousticSectionKeys(id).map(key => ({ key, sources: [{ versionId, pageStart: 1, pageEnd: 88 }] })),
    attachments: [{ versionId, pageStart: 17, pageEnd: 88, section: "calculationAppendix", label: "Original appendix" }],
  };
  const section = { content: `${"Source-backed detail. ".repeat(650)}WE31 Kind 1: source-stated 40.5 dB, page 88 [${versionId}].`, citations: [versionId], complete: true };
  expect(section.content.length).toBeGreaterThan(12000);
  const editorial = { sections: [{ key: "components", content: section.content }], complete: true };
  const check = { preserved: false, issues: ["Room WE31 lost its unverified status."] };
  for (const [documentTask, output, invalid] of [
    ["outline", outline, { ...outline, id: "interior-noise-concept" }],
    ["section", section, { ...section, content: " " }],
    ["editorial", editorial, { ...editorial, sections: [{ key: "components", content: " " }] }],
    ["editorial_check", check, { preserved: "yes", issues: [] }],
  ] as const) {
    const request = { ...base, phase: "review" as const, goal: "Create Außenlärmkonzept", modelPolicy: responsePolicy,
      modelConfig: { modelId: "test-model", maxOutputTokens: 32000, maxSteps: 4 },
      inspectSource: async () => { throw new Error("Report authoring must consume supplied evidence, not inspect sources"); },
      context: { documentTask, documentTemplate: { id, version: 1 } } };
    expect(await callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output,
        spyStream: options => { expect(options.tools ?? []).toHaveLength(0); } }),
    })).toEqual(output);
    await expect(callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: invalid }),
    })).rejects.toMatchObject({ code: "invalid_provider_output", failureCategory: "validation" });
  }
});

test("inventory writers bound reservations without changing models, source evidence or narrative limits", async () => {
  for (const maxOutputTokens of [2048, 32000]) for (const section of ["calculationAppendix", "sourcesAndRevisions", "components"]) {
    let settings: any, prepared: any;
    const output = { content: "Source calculations remain unverified.", citations: [], complete: true };
    const sources = [{ versionId: crypto.randomUUID(), name: "Report May 2026.pdf", version: 2,
      text: "[Page 23]\nDatum der Aufstellung: 23. April 2026. Earlier revision: 3. March 2026. Unreviewed.",
      coverage: { pageStart: 23, pageEnd: 23, totalPages: 72, truncated: false } }];
    const cap = section === "components" ? maxOutputTokens : Math.min(maxOutputTokens, 6000);
    const result = await callMastraSupervisor({ ...base, phase: "review", goal: "Create exterior-noise-concept",
      modelConfig: { modelId: "gpt-6-astra", maxOutputTokens, maxSteps: 4, reasoningEffort: "medium" },
      context: { documentTask: "section", section,
        ...(section === "calculationAppendix" ? { inputMode: "imported-calculation-evidence" } : {}),
        documentTemplate: { id: "exterior-noise-concept", version: 1 }, sources },
      onRequest: async value => { settings = value; }, onPrepared: async value => { prepared = value; return undefined; },
    }, "test-key", { model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output,
      spyStream: options => {
        expect(options.maxOutputTokens).toBe(cap);
        expect(options.tools ?? []).toHaveLength(0);
      },
    }) });
    expect(result).toEqual(output);
    expect(settings.modelId).toBe("gpt-6-astra");
    expect(settings.reasoningEffort).toBe("medium");
    expect(settings.maxOutputTokens).toBe(cap);
    expect(prepared.tools).toBeUndefined();
    expect(settings.maxSteps).toBe(section === "components" ? 4 : 1);
    expect(JSON.parse(prepared.prompt).context.sources).toEqual(sources);
    if (section === "sourcesAndRevisions") {
      expect(prepared.instructions).toContain("source and revision register");
      expect(prepared.instructions).toContain("Never infer an issue date from a filename");
      expect(prepared.instructions).toContain("return complete=false");
    }
  }
});

test("editorial packets keep the selected model with bounded writer and checker output", async () => {
  for (const maxOutputTokens of [1024, 32000]) for (const documentTask of ["editorial", "editorial_check"] as const) {
    const cap = documentTask === "editorial" ? 6000 : 2000;
    const output = documentTask === "editorial" ? { sections: [{ key: "components", content: "Unverified source claims." }], complete: true }
      : { preserved: false, issues: ["A source association changed."] };
    let settings: any;
    expect(await callMastraSupervisor({ ...base, phase: "review", modelConfig: {
      modelId: "gpt-6-astra", maxOutputTokens, maxSteps: 4, reasoningEffort: "medium",
    }, context: { documentTask, inputMode: "editorial-packet", sectionKeys: ["components"], documentTemplate: { id: "exterior-noise-concept", version: 1 } },
    onRequest: async value => { settings = value; },
    }, "test-key", { model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output,
      spyStream: options => { expect(options.maxOutputTokens).toBe(Math.min(maxOutputTokens, cap)); expect(options.tools ?? []).toHaveLength(0); },
    }) })).toEqual(output);
    expect(settings.modelId).toBe("gpt-6-astra");
    expect(settings.reasoningEffort).toBe("medium");
    expect(settings.maxOutputTokens).toBe(Math.min(maxOutputTokens, cap));
    expect(settings.maxSteps).toBe(1);
  }
});

test("consolidation uses bounded tool-free shared writer and independent checker contracts", async () => {
  for (const inputMode of ["editorial-consolidation", "patch-editorial-v1"]) for (const maxOutputTokens of [1024, 32000]) for (const documentTask of ["consolidation", "consolidation_check"] as const) {
    const output = documentTask === "consolidation"
      ? { replacements: [{ id: "requirements:0", content: null }, { id: "plans:0", content: "" },
        ...(inputMode === "patch-editorial-v1" ? [{ id: "plans:1", content: null }] : [])], complete: true }
      : { preserved: false, issues: ["The shutter-box assembly was replaced by a curtain rating."] };
    let settings: any, prepared: any;
    const request = { ...base, phase: "review" as const,
      modelConfig: { modelId: "gpt-6-astra", maxOutputTokens, maxSteps: 4, reasoningEffort: "medium" as const },
      context: { documentTask, inputMode, documentTemplate: { id: "exterior-noise-concept", version: 1 } },
      inspectSource: async () => { throw new Error("No source inspection during consolidation"); },
      onRequest: async (value: unknown) => { settings = value; },
      onPrepared: async (value: unknown) => { prepared = value; return undefined; },
    };
    expect(await callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output,
        spyStream: options => { expect(options.tools ?? []).toHaveLength(0); },
      }),
    })).toEqual(output);
    expect(settings.maxOutputTokens).toBe(Math.min(maxOutputTokens, documentTask === "consolidation" ? 6000 : 2000));
    expect(settings.maxSteps).toBe(1);
    expect(settings.modelId).toBe("gpt-6-astra");
    expect(settings.reasoningEffort).toBe("medium");
    expect(prepared.tools).toBeUndefined();
    expect(prepared.instructions).toContain("bounded fragment");
    expect(prepared.instructions).toContain("legal scope");
    expect(prepared.instructions).toContain("authoritative context.visualReads");
    expect(prepared.instructions).toContain("available rendering");
    const invalid = documentTask === "consolidation" ? { ...output, replacements: [{ id: "x", content: 7 }] } : { preserved: "yes", issues: [] };
    await expect(callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: invalid }),
    })).rejects.toMatchObject({ code: "invalid_provider_output" });
  }
});

test("writer overrides only report prose, leaving planning and independent checks on their configured models", async () => {
  const supervisor = { modelId: "gpt-6-astra", maxOutputTokens: 32000, maxSteps: 4 };
  const writer = { modelId: "gpt-6-sol", maxOutputTokens: 16000, maxSteps: 1 };
  const specialist = { modelId: "gpt-6-luna", maxOutputTokens: 8000, maxSteps: 2 };
  const policy = { ...vendorPreset("openai", "medium"), supervisor, writer,
    specialists: { source_reviewer: specialist, requirements_reviewer: specialist },
    provider: "openai" as const, effort: "medium" as const, version: 1, source: "workspace" as const };
  const summary = { summary: "Evidence checked.", rationale: "Unverified claims retained.", citations: [] };
  const sections = acousticSectionKeys("exterior-noise-concept");
  const outputs: Record<string, Record<string, unknown>> = {
    section: { content: "Claims remain unverified.", citations: [], complete: true },
    editorial: { complete: true, sections: sections.map(key => ({ key, content: "Claims remain unverified." })) },
    consolidation: { complete: true, replacements: [{ id: "plans:0", content: null }] },
    editorial_check: { preserved: false, issues: ["Attachment status changed."] },
    consolidation_check: { preserved: false, issues: ["Attachment status changed."] },
    outline: { id: "exterior-noise-concept", title: "Report", language: "en",
      project: { name: null, number: null, client: null, designer: null, author: null, date: null }, attachments: [],
      sections: sections.map(key => ({ key, sources: [] })) },
    plan: { documentTemplate: null, tasks: [{ role: "source_reviewer", goal: "Check evidence", sourceVersionIds: [] }] },
    review: { ...summary, document: { title: "Report", content: "Evidence remains unverified." }, decision: "accept", revisions: [] },
    independent_review: { ...summary, decision: "accept", findings: [], revisions: [] },
    specialist: summary,
  };
  for (const enabled of [true, false]) for (const [task, output] of Object.entries(outputs)) {
    const phase = ["plan", "specialist", "review", "independent_review"].includes(task) ? task as "plan" | "specialist" | "review" | "independent_review" : "review";
    const prose = ["section", "editorial", "consolidation"].includes(task);
    const selected = phase === "specialist" ? specialist : enabled && prose ? writer : supervisor;
    let settings: ProviderExecutionSettings | undefined;
    expect(await callMastraSupervisor({ ...base, phase, modelPolicy: { ...policy, writer: enabled ? writer : undefined },
      context: phase === "specialist" ? { role: "source_reviewer" } : phase === "review" && task !== "review"
        ? { documentTask: task, documentTemplate: { id: "exterior-noise-concept", version: 1 } } : {},
      onRequest: async value => { settings = value; },
    }, "test-key", { model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output }) })).toEqual(output);
    expect(settings!.modelId).toBe(selected.modelId);
    expect(settings!.modelRole).toBe(phase === "specialist" ? undefined : enabled && prose ? "writer" : "supervisor");
    expect(settings!.maxOutputTokens).toBeLessThanOrEqual(selected.maxOutputTokens);
  }
});

test("section authoring retains canonical identity, bounded coverage and component distinctions", async () => {
  let prepared: any;
  const output = { content: "Unverified source claims.", citations: [], complete: true };
  await callMastraSupervisor({ ...base, phase: "review", modelConfig: { modelId: "test-model", maxOutputTokens: 4000, maxSteps: 1 },
    context: { documentTask: "section", section: "components", documentTemplate: { id: "exterior-noise-concept", version: 1 } },
    onPrepared: async value => { prepared = value; return undefined; },
  }, "test-key", { model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output }) });
  for (const rule of ["canonical context.sourceDirectory", "never packet-local Q aliases", "never expands allowed citations",
    "one section-owned requirements register", "Absence from this packet is not absence from the project",
    "shutter-box assembly is not a shutter curtain", "budget_exhausted means not inspected",
    "unavailable rendering does not mean illegible text", "available rendering proves only availability, not semantic review"])
    expect(prepared.instructions).toContain(rule);
});

test("sound-insulation synthesis requires the fixed template and renders rather than trusting free-form content", async () => {
  const versionId = crypto.randomUUID();
  const template = {
    id: "sound-insulation-review", version: 1, language: "de",
    scope: "Außenlärmschutz für Raum 101.", sourcesAndRevisions: `Modellstand [${versionId}].`,
    requirements: "Außenlärmpegel fehlt.",
    entities: [{ kind: "room", label: "Raum 101", versionId, entityKey: "#42", page: null,
      globalId: "1AbCdEfGhIjKlMnOpQrStu", observations: "Deklarierter Raum, Zuordnung ungeprüft." }],
    findings: "Keine Schallschutzwerte belegt.", measures: "Fensterdaten anfordern.", openIssues: "Fachliche Prüfung erforderlich.",
  };
  const review = { summary: "Entwurf erstellt.", rationale: "Quellenbezug", citations: [versionId], decision: "accept", revisions: [],
    document: { title: "Schallschutzprüfung", content: "IGNORE THIS FREE-FORM DOCUMENT", template } };
  const request = { ...base, phase: "review" as const, context: { documentTemplate: { id: "sound-insulation-review", version: 1 } } };
  const result: any = await callMastraSupervisor(request, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: review }),
  });
  expect(result.document.content).not.toContain("IGNORE THIS");
  expect(result.document.content).toContain("## 1. Auftrag und Umfang");
  expect(result.document.content).toContain("## 8. Prüfstatus");
  expect(result.document.content).toContain("kein normativer Schallschutznachweis");
  expect(result.document.content).toContain("Werkzeugberechnungen bleiben fachlich ungeprüft");
  expect(result.document.content).toContain("1AbCdEfGhIjKlMnOpQrStu");
  expect(result.document.template).toEqual(template);
  expect(() => assertDocumentCitations(result.document, [])).toThrow("undeclared");
  assertDocumentCitations(result.document, [versionId]);
  await expect(callMastraSupervisor({ ...request, goal: "Create exterior-noise-concept v1" }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: review }),
  })).rejects.toMatchObject({ code: "invalid_provider_output", diagnostics: {
    issues: [{ code: "custom", path: ["document", "template", "id"] }],
  } });
  const largeTemplate = { ...template, entities: Array.from({ length: 65 }, () => ({ ...template.entities[0], observations: "x".repeat(1000) })) };
  const largeReview = { ...review, document: { ...review.document, template: largeTemplate } };
  for (const documentMaxCharacters of [1000, 120000]) {
    const modelPolicy = { ...responsePolicy, executionLimits: { ...responsePolicy.executionLimits, documentMaxCharacters } };
    const response = callMastraSupervisor({ ...request, modelPolicy }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: largeReview }),
    });
    if (documentMaxCharacters === 1000) await expect(response).rejects.toMatchObject({ code: "invalid_provider_output" });
    else {
      const output = await response as typeof result;
      expect(output.document.content.length).toBeGreaterThan(60000);
      expect(output.document.content).toContain("## 8. Prüfstatus");
    }
  }
  for (const invalid of [undefined, { ...template, version: 2 }, { ...template, requirements: "" }]) {
    await expect(callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { ...review, document: { ...review.document, template: invalid } } }),
    })).rejects.toMatchObject({ code: "invalid_provider_output" });
  }
});

for (const id of ["interior-noise-concept", "exterior-noise-concept"] as const) {
  for (const language of ["de", "en"] as const) test(`${id} ${language} survives provider validation with fixed structure, tables and draft limits`, async () => {
    const versionId = crypto.randomUUID();
    const template = acousticConceptFixture(id, language, versionId);
    const review = { summary: "Draft ready", rationale: "Evidence gaps retained", citations: [versionId], decision: "accept", revisions: [],
      document: { title: "Concept", content: "MODEL CONTENT MUST NOT WIN", template } };
    const request = { ...base, phase: "review" as const, goal: `Create ${id}`, context: { documentTemplate: { id: "sound-insulation-review", version: 1 } } };
    const result: any = await callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: review }),
    });
    expect(result.document.template).toEqual(template);
    expect(result.document.content).not.toContain("MODEL CONTENT MUST NOT WIN");
    expect(result.document.content).toContain(template.components);
    expect(result.document.content).toContain(language === "de" ? "| Bauherr | Nicht angegeben |" : "| Client | Not supplied |");
    expect(result.document.content).toContain(language === "de" ? "kein normativer Schallschutznachweis" : "not a standards-based engineering verification");
    expect(result.document.content).toContain(language === "de" ? "Werkzeugberechnungen bleiben fachlich ungeprüft" : "tool calculations remain subject to specialist review");
    expect(result.document.content).toContain(language === "de" ? "## Anlage · Berechnungsnachweise" : "## Appendix · Calculation evidence");
    expect(result.document.content).toContain(language === "de" ? "Keine Freigabe, Unterschrift" : "Not approved, signed");
    if (id === "interior-noise-concept") {
      expect(result.document.content).toContain(language === "de" ? "## 3. Schallschutzpläne Innenlärm" : "## 3. Interior-noise plans");
      expect(result.document.content).toContain(language === "de" ? "## 7. Luft-Wasser-Wärmepumpe" : "## 7. Air-to-water heat pump");
      expect(result.document.content).not.toContain("Exterior-noise assessment");
    } else {
      expect(result.document.content).toContain(language === "de" ? "## 2. Bewertung des Außenlärms" : "## 2. Exterior-noise assessment");
      expect(result.document.content).toContain(language === "de" ? "## 5. Schallschutzpläne Außenlärm" : "## 5. Exterior-noise plans");
      expect(result.document.content).not.toContain("DEGA");
    }
    assertDocumentCitations(result.document, [versionId]);
    expect(() => assertDocumentCitations(result.document, [])).toThrow("undeclared");
    await expect(callMastraSupervisor({ ...request, modelPolicy: {
      ...responsePolicy, executionLimits: { ...responsePolicy.executionLimits, documentMaxCharacters: 1000 },
    } }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: review }),
    })).rejects.toMatchObject({ code: "invalid_provider_output" });
    for (const invalid of [{ ...template, version: 2 }, { ...template, plans: "" }]) {
      await expect(callMastraSupervisor(request, "test-key", {
        model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { ...review, document: { ...review.document, template: invalid } } }),
      })).rejects.toMatchObject({ code: "invalid_provider_output" });
    }
  });
}

test("domain specialists select their snapshotted models and cannot execute or be planned when disabled", async () => {
  const legacy = agentPresetSnapshotSchema.parse({ ...vendorPreset("openai", "medium"), effort: "medium", provider: "openai", version: 1, source: "workspace" });
  for (const role of domainSpecialistRoles) {
    const output = { summary: "Evidence reviewed", rationale: "Source proposal", citations: [] };
    const model = { modelId: `${role}-model`, maxOutputTokens: 777, maxSteps: 1 };
    const policy = agentPresetSnapshotSchema.parse({ ...legacy, specialists: { ...legacy.specialists, [role]: model } });
    let metadata: any;
    let request: any;
    await callMastraSupervisor({ ...base, phase: "specialist", context: { role }, modelPolicy: policy, onRequest: async value => { metadata = value; } }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output, spyStream: value => { request = value; } }),
    });
    expect(metadata.modelId).toBe(model.modelId);
    expect(request.maxOutputTokens).toBe(777);
    expect(JSON.stringify(request)).toContain("never mental arithmetic or claims of IFC semantic completeness");
    expect(JSON.stringify(request)).toContain("never gives binding legal approval");
    expect(JSON.stringify(request)).toContain("never invents prices");
    await expect(callMastraSupervisor({ ...base, phase: "specialist", context: { role }, modelPolicy: legacy, modelConfig: model }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output }),
    })).rejects.toThrow("disabled");
    const plan = { tasks: [{ role, goal: "Review domain evidence", sourceVersionIds: [] }] };
    expect(await callMastraSupervisor({ ...base, phase: "plan", modelPolicy: policy }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: plan }),
    })).toEqual(plan);
    await expect(callMastraSupervisor({ ...base, phase: "plan", modelPolicy: legacy }, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: plan }),
    })).rejects.toMatchObject({ code: "invalid_provider_output" });
  }
});

test("later model-step admission preserves control failures and pauses, but does not reset, the active deadline", async () => {
  for (const outcome of ["success", "budget_exhausted", "outcome_unknown", "cancelled"] as const) {
    const cancellation = new AbortController();
    const signals: AbortController[] = [];
    const timeouts = spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController(); signals.push(controller); return controller.signal;
    });
    let rounds = 0;
    const settlements: any[] = [];
    const versionId = crypto.randomUUID();
    const model = new MastraLanguageModelV2Mock({ doStream: async () => {
      const first = rounds++ === 0;
      await Bun.sleep(25);
      return { stream: new ReadableStream({ start(c) {
        if (first) c.enqueue({ type: "tool-call", toolCallId: "inspect", toolName: "inspect_project_source", input: JSON.stringify({ versionId, page: 1 }) });
        else {
          c.enqueue({ type: "text-start", id: "result" });
          c.enqueue({ type: "text-delta", id: "result", delta: JSON.stringify({ summary: "Reviewed", rationale: "Draft", citations: [] }) });
          c.enqueue({ type: "text-end", id: "result" });
        }
        c.enqueue({ type: "finish", finishReason: first ? "tool-calls" : "stop", usage: first
          ? { inputTokens: { total: 19, noCache: 4, cacheRead: 15, cacheWrite: 0 }, outputTokens: { total: 7, text: 3, reasoning: 4 } } as any
          : { inputTokens: 11, outputTokens: 5 } });
        c.close();
      } }) };
    } });
    try {
      const result = await callMastraSupervisor({ ...base, phase: "specialist", modelConfig: { modelId: "gpt-6-astra", maxOutputTokens: 2048, maxSteps: 2 },
        inspectSource: async request => ({ ...request, status: "unavailable", scope: "pdf_page", reason: "No rendering" }),
        onBeforeModelStep: async ({ ordinal }, signal) => {
          if (ordinal === 1) return;
          expect(settlements).toHaveLength(1);
          signals.at(-1)!.abort(new DOMException("Old deadline expired while admission paused", "TimeoutError"));
          if (outcome === "cancelled") { cancellation.abort(); signal!.throwIfAborted(); }
          if (outcome !== "success") throw Object.assign(new Error("Private failure details"), { code: outcome });
        },
        onModelStepSettled: async receipt => { settlements.push(receipt); },
      }, "test-key", { model, signal: cancellation.signal }).then(value => value, error => error);
      expect(rounds).toBe(outcome === "success" ? 2 : 1);
      expect(settlements).toHaveLength(rounds);
      expect(settlements[0].usage).toMatchObject({ inputTokens: 19, outputTokens: 7, totalTokens: 26,
        cachedInputTokens: 15, reasoningTokens: 4, estimatedCostUsd: 0.000405 });
      expect(timeouts.mock.calls.at(-1)![0]).toBeLessThan(180000 - 20);
      if (outcome === "success") expect(result.summary).toBe("Reviewed");
      else {
        expect(result.code).toBe(outcome);
        expect(result.message).not.toContain("Private failure details");
      }
    } finally { timeouts.mockRestore(); }
  }
});

test("budget admission waits outside the provider deadline and cancellation never dispatches", async () => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(100));
  try {
    for (const cancel of [false, true]) {
      const cancellation = new AbortController();
      const result = callMastraSupervisor({ ...base, phase: "plan",
        onPrepared: async (_input, signal) => {
          expect(signal).toBe(cancellation.signal);
          await Bun.sleep(150);
          if (cancel) cancellation.abort();
          return undefined;
        },
      }, "test-key", { signal: cancellation.signal,
        model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { tasks: [
          { role: "source_reviewer", goal: "Review evidence", sourceVersionIds: [] },
        ] } }),
      });
      if (cancel) await expect(result).rejects.toMatchObject({ code: "cancelled" });
      else expect(await result).toMatchObject({ tasks: [{ goal: "Review evidence" }] });
    }
  } finally { timeout.mockRestore(); }
});

test("phase deadlines abort real Mastra streams without accepting partial output or leaking contents", async () => {
  for (const phase of ["plan", "specialist", "review", "independent_review"] as const) {
    for (const cancelled of [false, true]) {
      const deadline = new AbortController();
      const cancellation = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
      const secret = "sk-timeout-secret";
      const privateGoal = "Private project prompt";
      let settings: any;
      let upstreamAborted = false;
      let accepted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deltas: string[] = [];
      try {
        const model = new MastraLanguageModelV2Mock({ doStream: async ({ abortSignal }) => ({
          stream: new ReadableStream({ start(controller) {
            controller.enqueue({ type: "text-start", id: "output" });
            controller.enqueue({ type: "text-delta", id: "output", delta: phase === "plan"
              ? '{"tasks":[{"role":"source_reviewer","goal":"unfinished'
              : JSON.stringify({ summary: `Evidence ${secret} remains incomplete`, rationale: privateGoal, citations: [] }).slice(0, -1) });
            abortSignal!.addEventListener("abort", () => {
              upstreamAborted = true;
              controller.error(new Error(`Bearer ${secret} ${privateGoal}`));
            }, { once: true });
            timer = setTimeout(() => (cancelled ? cancellation : deadline).abort(
              new DOMException(`${secret} ${privateGoal}`, cancelled ? "AbortError" : "TimeoutError"),
            ), 25);
          } }),
        }) });
        const error = await callMastraSupervisor({ ...base, phase, goal: privateGoal,
          onRequest: async value => { settings = value; },
          onSummaryDelta: async delta => { deltas.push(delta); },
        }, secret, { model, signal: cancellation.signal }).then(() => { accepted = true; }, error => error);
        const timeoutMs = phase === "plan" ? 60000 : 180000;
        expect(timeout).toHaveBeenCalledWith(timeoutMs);
        expect(settings.timeoutMs).toBe(timeoutMs);
        expect(upstreamAborted).toBe(true);
        expect(accepted).toBe(false);
        expect(error).toMatchObject(cancelled ? { code: "cancelled" } : {
          code: "timeout", failureCategory: "timeout", providerFailure: true, retryable: false, timedOut: true,
        });
        if (cancelled) expect(error.failureCategory).not.toBe("timeout");
        expect(error.cause).toBeUndefined();
        expect(`${error.message}${JSON.stringify(error)}${JSON.stringify(settings)}${deltas.join("")}`).not.toContain(secret);
        expect(`${error.message}${JSON.stringify(error)}${JSON.stringify(settings)}`).not.toContain(privateGoal);
      } finally {
        if (timer) clearTimeout(timer);
        timeout.mockRestore();
      }
    }
  }
});

test("deadlines and cancellation finish with open SDK streams and retain settled usage", async () => {
  for (const streamSummary of [false, true]) {
    for (const cancelled of [false, true]) {
      const deadline = new AbortController();
      const cancellation = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let release!: (value: any) => void;
      const pending = new Promise<any>(resolve => { release = resolve; });
      let streamController!: ReadableStreamDefaultController<any>;
      const objectStream = new ReadableStream({ start(controller) { streamController = controller; } });
      const stream = spyOn(Agent.prototype, "stream").mockImplementation(async () => {
        entered();
        return { objectStream, getFullOutput: () => pending, totalUsage: Promise.resolve({ inputTokens: 37, outputTokens: 11, totalTokens: 48 }),
          usage: pending, finishReason: pending, object: pending, text: pending } as any;
      });
      let summaries = 0;
      const usage: any[] = [];
      const execution = callMastraSupervisor({ ...base, phase: "specialist",
        onUsage: async value => { usage.push(value); },
        ...(streamSummary ? { onSummaryDelta: async () => { summaries++; } } : {}),
      }, "test-key", { model: createMockModel({ version: "v2", mockText: "unused" }), signal: cancellation.signal }).then(() => "accepted", error => error);
      try {
        await started;
        (cancelled ? cancellation : deadline).abort();
        const outcome = await Promise.race([execution, Bun.sleep(1000).then(() => "still pending")]);
        expect(outcome).toMatchObject(cancelled ? { code: "cancelled" } : {
          code: "timeout", failureCategory: "timeout", retryable: false,
        });
        expect(usage).toMatchObject([{ inputTokens: 37, outputTokens: 11, totalTokens: 48 }]);
        expect(summaries).toBe(0);
      } finally {
        release({});
        try { streamController.close(); } catch { /* The application may cancel its reader. */ }
        stream.mockRestore();
        timeout.mockRestore();
        await execution;
      }
    }
  }
});

const responsePolicy = {
  ...vendorPreset("openai", "medium"), provider: "openai" as const, effort: "medium" as const, source: "workspace" as const, version: 2,
  executionLimits: { summaryMaxCharacters: 12000, rationaleMaxCharacters: 3000, documentMaxCharacters: 70000, timeoutSeconds: 10 },
};
test("explicit Team plans and reviews without documents despite acoustic context and goal", async () => {
  const modelPolicy = { ...responsePolicy, workflow: { mode: "team" as const } };
  for (const phase of ["plan", "review"] as const) {
    const output = phase === "plan"
      ? { tasks: [{ role: "source_reviewer", goal: "Review acoustic evidence", sourceVersionIds: [] }], documentTemplate: null }
      : { summary: "Acoustic evidence reviewed; specialist approval remains necessary.", rationale: "Evidence gaps retained", citations: [], decision: "accept", revisions: [], document: null };
    const request = { ...base, phase, goal: "Create exterior-noise-concept", modelPolicy,
      context: { role: "sound_insulation", documentTemplate: { id: "sound-insulation-review", version: 1 } } };
    expect(await callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output,
        spyStream: value => { expect(JSON.stringify(value)).toContain("The user explicitly selected Team, not Report"); },
      }),
    })).toEqual(output);
    const invalid = phase === "plan" ? { ...output, documentTemplate: "exterior-noise-concept" }
      : { ...output, document: { title: "Acoustic report", content: "Unrequested deliverable" } };
    await expect(callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: invalid }),
    })).rejects.toMatchObject({ code: "invalid_provider_output", failureCategory: "validation" });
  }
});

test("explicit Report preserves its chosen template instead of inferring one from the goal", async () => {
  const versionId = crypto.randomUUID();
  for (const reportTemplate of ["interior-noise-concept", "exterior-noise-concept"] as const) {
    const other = reportTemplate === "interior-noise-concept" ? "exterior-noise-concept" : "interior-noise-concept";
    const template = acousticConceptFixture(reportTemplate, "en", versionId);
    const output = { summary: "Draft ready", rationale: "Evidence gaps retained", citations: [versionId], decision: "accept", revisions: [],
      document: { title: "Chosen report", content: "MODEL CONTENT MUST NOT WIN", template } };
    const request = { ...base, phase: "review" as const, goal: `Create ${other}`,
      modelPolicy: { ...responsePolicy, workflow: { mode: "report" as const, reportTemplate } },
      context: { documentTemplate: { id: "sound-insulation-review", version: 1 } } };
    const result: any = await callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output,
        spyStream: value => { expect(JSON.stringify(value)).toContain(`The user explicitly selected Report with template ${reportTemplate}`); },
      }),
    });
    expect(result.document.template).toEqual(template);
    expect(result.document.content).not.toContain("MODEL CONTENT MUST NOT WIN");
    await expect(callMastraSupervisor(request, "test-key", {
      model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: {
        ...output, document: { ...output.document, template: acousticConceptFixture(other, "en", versionId) },
      } }),
    })).rejects.toMatchObject({ code: "invalid_provider_output", failureCategory: "validation" });
  }
});

test("explicit Report with the general review template rejects goal-inferred concept templates", async () => {
  const versionId = crypto.randomUUID();
  const template = { id: "sound-insulation-review", version: 1, language: "en", scope: "General review",
    sourcesAndRevisions: `Source [${versionId}]`, requirements: "Requirements need confirmation", entities: [],
    findings: "Evidence remains unverified", measures: "Request specialist review", openIssues: "Approval pending" };
  const output = { summary: "Draft ready", rationale: "Evidence gaps retained", citations: [versionId], decision: "accept", revisions: [],
    document: { title: "General review", content: "Rendered from template", template } };
  const request = { ...base, phase: "review" as const, goal: "Create exterior-noise-concept",
    modelPolicy: { ...responsePolicy, workflow: { mode: "report" as const, reportTemplate: "sound-insulation-review" as const } },
    context: { documentTemplate: { id: "sound-insulation-review", version: 1 } } };
  const result: any = await callMastraSupervisor(request, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output }),
  });
  expect(result.document.template).toEqual(template);
  await expect(callMastraSupervisor(request, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: {
      ...output, document: { ...output.document, template: acousticConceptFixture("exterior-noise-concept", "en", versionId) },
    } }),
  })).rejects.toMatchObject({ code: "invalid_provider_output", failureCategory: "validation" });
});

test("real Mastra accepts enlarged responses and rejects each configured cap", async () => {
  const review = { summary: "s".repeat(12000), rationale: "r".repeat(3000), citations: [], decision: "accept", revisions: [],
    document: { title: "Concept", content: "d".repeat(70000) } };
  const invoke = (output: typeof review) => callMastraSupervisor({ ...base, phase: "review", modelPolicy: responsePolicy }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output }),
  });
  expect(await invoke(review)).toEqual(review);
  for (const output of [
    { ...review, summary: review.summary + "s" }, { ...review, rationale: review.rationale + "r" },
    { ...review, document: { ...review.document, content: review.document.content + "d" } },
  ]) {
    const error = await invoke(output).then(() => null, error => error);
    expect(error).toMatchObject({ code: "invalid_provider_output", failureCategory: "validation", retryable: true });
  }
});

test("configured ten-second timeout aborts real Mastra and retains timeout classification", async () => {
  let aborted = false;
  const start = performance.now();
  const model = new MastraLanguageModelV2Mock({ doStream: async ({ abortSignal }) => ({
    stream: new ReadableStream({ start(controller) {
      const abort = () => { aborted = true; controller.error(new DOMException("Timed out", "AbortError")); };
      if (abortSignal?.aborted) abort();
      else abortSignal?.addEventListener("abort", abort, { once: true });
    } }),
  }) });
  const error = await callMastraSupervisor({ ...base, phase: "specialist", context: { role: "source_reviewer" }, modelPolicy: responsePolicy }, "test-key", { model }).then(() => null, error => error);
  expect(aborted).toBe(true);
  expect(performance.now() - start).toBeGreaterThanOrEqual(9500);
  expect(performance.now() - start).toBeLessThan(15000);
  expect(error).toMatchObject({ code: "timeout", failureCategory: "timeout", timedOut: true, retryable: false });
}, 20000);

for (const failure of ["summary", "citation", "acoustic_field", "acoustic_provenance"] as const) test.skipIf(!process.env.DATABASE_URL)(`supervisor repairs a rejected ${failure} through Mastra without retrying a successful sibling`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const modelConfig = { modelId: "test-model", maxSteps: 1, maxOutputTokens: 32000 };
  const acoustic = failure.startsWith("acoustic_");
  const packet = exteriorNoisePackets()[0]!;
  const provenance = packet.inventory[0]!.provenance;
  const sourceVersionIds = acoustic ? [provenance.versionId] : [];
  const expectedAcousticIssue = failure === "acoustic_field"
    ? { code: "custom", path: ["exteriorNoiseExtraction", "facts", 121, "value"], acoustic: "invalid_fact_value" }
    : { code: "custom", path: ["exteriorNoiseExtraction", "inventory", 0, "provenance", "excerpt"], acoustic: "quote_not_in_source" };
  const policy = { provider: "openai" as const, effort: "medium" as const, source: "vendor" as const, version: 1,
    supervisor: modelConfig, specialists: { source_reviewer: modelConfig, requirements_reviewer: modelConfig }, maxParallel: 2, maxTasks: 2, maxRevisions: 1 };
  const d = {
    db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {}, validateProject: async () => true,
    validateSourceVersion: async () => true,
    listProjectSources: async () => ({ sources: sourceVersionIds.map(versionId => ({ versionId, name: "Synthetic schedule" })), truncated: false }),
    resolveSource: async () => ({ status: "resolved", source: { versionId: provenance.versionId, name: "Synthetic schedule" },
      content: { status: "available", text: provenance.excerpt, truncated: false } }),
    executeSupervisor: async (input: Parameters<NonNullable<AppDeps["executeSupervisor"]>>[0]) => {
      if (input.phase === "plan") return { status: "completed", output: { ...(acoustic ? { documentTemplate: "exterior-noise-concept" } : {}), tasks: [
        { role: "requirements_reviewer", goal: "Check requirements", sourceVersionIds },
        { role: "source_reviewer", goal: "Check sources", sourceVersionIds },
      ] } };
      const output = await callMastraSupervisor({ ...input, modelConfig }, "test-key", {
        model: new MastraLanguageModelV2Mock({ doStream: async options => {
          const instructions = options.prompt.filter(message => message.role === "system").map(message => message.content).join("\n");
          const corrected = acoustic ? instructions.includes(JSON.stringify(expectedAcousticIssue)) : failure === "summary"
            ? instructions.includes('"code":"too_big","path":["summary"],"maximum":10000') && instructions.includes("rewrite it concisely")
            : instructions.includes('"errorId":"SOURCE_CITATION_OUT_OF_SCOPE"') && instructions.includes("Recheck the claims behind rejected references");
          const summary = input.goal === "Check sources" ? "Sources inspected; coverage gaps remain explicit."
            : corrected ? "Requirements identified; missing dimensions still require confirmation."
            : failure === "summary" ? "Overlong requirements. ".repeat(600) : "Unsupported reference";
          const citations = failure === "citation" && input.goal !== "Check sources" && !corrected ? [crypto.randomUUID()] : [];
          const extraction = structuredClone(packet);
          if (acoustic && input.goal !== "Check sources" && !corrected) {
            if (failure === "acoustic_field") {
              extraction.facts = Array.from({ length: 122 }, () => structuredClone(packet.facts[1]!));
              extraction.facts[121]!.value = -1;
            } else extraction.inventory[0]!.provenance = { ...provenance, excerpt: "REJECTED_QUOTE_MUST_NOT_REACH_FEEDBACK" };
          }
          if (acoustic && corrected) {
            expect((input.context as any).outputValidationFeedback.issues).toEqual([expectedAcousticIssue]);
            expect(instructions).not.toContain("REJECTED_QUOTE_MUST_NOT_REACH_FEEDBACK");
          }
          const text = JSON.stringify({ summary, rationale: "Unreviewed proposal, not a validated calculation.", citations,
            ...(acoustic ? { exteriorNoiseExtraction: extraction } : {}) });
          return { stream: new ReadableStream({ start(controller) {
            controller.enqueue({ type: "text-start", id: "output" });
            controller.enqueue({ type: "text-delta", id: "output", delta: text });
            controller.enqueue({ type: "text-end", id: "output" });
            controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
            controller.close();
          } }) };
        } }),
      });
      return { status: "completed", output };
    },
  } as unknown as AppDeps;
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Prepare concept", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    const children = await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, run!.id));
    expect(children).toHaveLength(2);
    expect(children.every(child => child.status === "needs_review")).toBe(true);
    const requirements = children.find(child => child.specialistRole === "requirements_reviewer")!;
    expect(requirements.outputSummary).toBe("Requirements identified; missing dimensions still require confirmation.");
    const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, requirements.id)).orderBy(agentRunAttempts.attemptNumber);
    expect(attempts.map(attempt => attempt.status)).toEqual(["failed", "completed"]);
    const [first, second] = attempts.map(attempt => attempt.settings as any);
    expect(first.promptHash).not.toBe(second.promptHash);
    expect(first.instructionsHash).not.toBe(second.instructionsHash);
    expect(first.outputSchemaHash).toBe(second.outputSchemaHash);
    expect(second.maxOutputTokens).toBe(32000);
    const source = children.find(child => child.specialistRole === "source_reviewer")!;
    expect(await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, source.id))).toHaveLength(1);
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    expect(state!.phase).toBe("review");
  } finally {
    for (const table of [agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});
for (const failure of ["incomplete_references", "wrong_key", "multiple_sections", "truncated_split", "incomplete_split"] as const)
test.skipIf(!process.env.DATABASE_URL)(`editorial packet repairs ${failure} through tracked Mastra calls without redoing saved work`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), versionId = crypto.randomUUID(), foreignId = crypto.randomUUID();
  const id = "exterior-noise-concept" as const, fixture = acousticConceptFixture(id, "en", versionId);
  if (fixture.id !== id) throw new Error("Expected exterior noise fixture");
  const model = { modelId: "test-model", maxOutputTokens: 32000, maxSteps: 1 };
  const splitting = failure === "truncated_split" || failure === "incomplete_split";
  const firstPacket = splitting ? [17, 93, 42].map(room => `Room ${room}: ${fixture.exteriorNoiseAssessment} [${versionId}]`).join("\n\n")
    : `${fixture.exteriorNoiseAssessment} [${versionId}]`;
  const prose = `${firstPacket}\n\n${"Unreviewed source claims remain uncertain. ".repeat(450)}`.trim();
  const writerCalls: string[] = [];
  let failedRootCalls = 0;
  let repaired = false;
  const d: any = { db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {}, audit: async () => {},
    validateProject: async () => true, validateSourceVersion: async () => true,
    sourceReferences: async () => [{ versionId, fileName: "Evidence", version: 1 }],
    resolveSource: async () => ({ status: "resolved", source: { versionId, name: "Evidence" }, content: { status: "available", text: "Fixture" } }),
    executeSupervisor: async (input: any) => {
      const context = input.context;
      if (context.documentTask === "outline") return { status: "completed", output: { id, title: "Repair fixture", language: "en", project: fixture.project,
        sections: acousticSectionKeys(id).map(key => ({ key, sources: [{ versionId, pageStart: 1, pageEnd: 1 }] })), attachments: [] } };
      if (context.documentTask === "section") return { status: "completed", output: { content: context.section === "exteriorNoiseAssessment" ? prose : (fixture as any)[context.section], citations: [versionId], complete: true } };
      if (context.documentTask === "consolidation") return { status: "completed", output: {
        complete: true, replacements: context.original.map((fragment: any) => ({ id: fragment.id, content: null })),
      } };
      expect(context.inputMode).toBe("editorial-packet");
      const key = context.sectionKeys[0], target = key === "exteriorNoiseAssessment";
      if (context.documentTask === "editorial") writerCalls.push(key);
      let output: any = context.documentTask === "editorial_check" ? { preserved: true, issues: [] }
        : { sections: [{ key, content: context.original[key] }], complete: true };
      if (target && splitting && context.documentTask === "editorial") {
        if (!context.packetPath) {
          failedRootCalls++;
          if (failure === "truncated_split") throw Object.assign(new Error("Truncated output"), { providerFailure: true, retryable: true,
            failureCategory: "validation", diagnostics: { errorId: "STRUCTURED_OUTPUT_TRUNCATED", finishReason: "length" } });
          output.complete = false;
        } else {
          expect(context.outputValidationFeedback).toBeUndefined();
          expect(firstPacket).toContain(context.original[key].trim());
          repaired = true;
        }
      }
      if (target && context.documentTask === "editorial" && !context.outputValidationFeedback) {
        if (failure === "incomplete_references") output = { complete: false, sections: [{ key, content: `Unsupported claim [${foreignId}]` }] };
        if (failure === "wrong_key") output.sections[0].key = "components";
        if (failure === "multiple_sections") output.sections.push({ ...output.sections[0] });
      }
      if (target && context.outputValidationFeedback) {
        const [saved] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, input.runId));
        expect((saved!.review as any).documentDraft.editorial.packets["preliminaryRemarks:0"].check).toEqual({ preserved: true, issues: [] });
        const issues = context.outputValidationFeedback.issues;
        if (failure === "incomplete_references") {
          expect(issues).toEqual([
            { code: "custom", path: ["complete"], editorial: { reason: "incomplete" } },
            { code: "custom", path: ["sections", 0, "content"], editorial: { reason: "references", missingReferences: [versionId], addedReferences: [foreignId] } },
          ]);
        } else if (failure === "wrong_key") expect(issues).toEqual([
          { code: "invalid_literal", path: ["sections", 0, "key"], expected: "exteriorNoiseAssessment", received: "components" },
        ]);
        else expect(issues).toEqual([{ code: "too_big", path: ["sections"], maximum: 1 }]);
        repaired = true;
      }
      return { status: "completed", output: await callMastraSupervisor({ ...input, modelConfig: model }, "test-key", {
        model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: output, spyStream: options => {
          if (context.documentTask === "editorial") {
            const schema: any = options.responseFormat?.schema;
            expect(schema.properties.sections.minItems).toBe(1);
            expect(schema.properties.sections.maxItems).toBe(1);
            const allowed = schema.properties.sections.items.properties.key;
            expect(allowed.const ?? allowed.enum?.[0]).toBe(key);
          }
          if (target && context.outputValidationFeedback) {
            const instructions = options.prompt.filter((m: { role: string }) => m.role === "system").map((m: { content: unknown }) => m.content).join("\n");
            expect(instructions).toContain(JSON.stringify(context.outputValidationFeedback));
            expect(instructions).toContain("Never append a UUID list merely to pass validation");
          }
        } }),
      }) };
    },
  };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Create exterior-noise-concept", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", { provider: "openai", effort: "medium", version: 1, source: "workspace", supervisor: model,
      specialists: { source_reviewer: model, requirements_reviewer: model }, independentReviewEnabled: false, maxParallel: 1, maxTasks: 1, maxRevisions: 1 });
    const documentDraft = await legacyAcousticDraft({ d, projectId: run!.projectId!, id, goal: run!.goal,
      findings: [], sourceVersionIds: [versionId], limits: agentExecutionLimitsSchema.parse({}),
      maxOutputTokens: model.maxOutputTokens, maxParallel: 1, assertActive: async () => {}, checkpoint: async () => {},
      call: async context => (await d.executeSupervisor({ phase: "review", context })).output });
    await db.update(supervisorRuns).set({ phase: "review", review: { documentDraft }, assignments: [{ role: "source_reviewer", runId: crypto.randomUUID(), taskId: crypto.randomUUID(), sourceVersionIds: [versionId], output: { citations: [versionId] } }] }).where(eq(supervisorRuns.runId, run!.id));
    await stepSupervisor(d, run!.id);
    expect(repaired).toBe(true);
    expect(writerCalls.filter(k => k === "preliminaryRemarks")).toHaveLength(1);
    if (splitting) {
      expect(failedRootCalls).toBe(1);
      expect(writerCalls.filter(k => k === "exteriorNoiseAssessment").length).toBeGreaterThan(2);
    } else expect(writerCalls.filter(k => k === "exteriorNoiseAssessment")).toHaveLength(2);
    const [revision] = await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId));
    expect(revision!.content).toContain(fixture.exteriorNoiseAssessment);
    expect(revision!.content).not.toContain(foreignId);
    expect((revision!.payload as any).template.exteriorNoiseAssessment).toBe(prose);
    expect((revision!.payload as any).template.calculationAppendix).toBe(fixture.calculationAppendix);
  } finally {
    for (const table of [artifactRevisions, artifacts, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks]) await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
}, 20000);

test("review document survives real Mastra while only the handoff streams", async () => {
  const versionId = crypto.randomUUID();
  const review = { summary: "The concept is ready for human review.", rationale: "Evidence checked", citations: [versionId], decision: "accept", revisions: [],
    document: { title: "Project concept", content: `# Scope\n\nSource-backed measures [${versionId}]\n\n${"Detailed proposed measure. ".repeat(500)}`.trim() } };
  const deltas: string[] = [];
  expect(await callMastraSupervisor({ ...base, phase: "review", onSummaryDelta: async delta => { deltas.push(delta); } }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: review }),
  })).toEqual(review);
  expect(deltas.join("")).toBe(review.summary);
  const { document, ...legacy } = review;
  expect(supervisorSchemas.review.safeParse(legacy).success).toBe(false);
  expect(supervisorReview.safeParse(legacy).success).toBe(true);
  expect(supervisorReview.safeParse({ ...legacy, document: null }).success).toBe(true);
  expect(() => assertDocumentCitations(document, [versionId])).not.toThrow();
  expect(() => assertDocumentCitations(document, [])).toThrow("undeclared");
});
test("Mastra telemetry reports filtered effort and no configured-model response fallback", async () => {
  let settings: any;
  let metadata: any;
  const model = new MastraLanguageModelV2Mock({ doStream: async () => ({
    stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "text-start", id: "output" });
      controller.enqueue({ type: "text-delta", id: "output", delta: JSON.stringify({ summary: "Done", rationale: "Evidence", citations: [] }) });
      controller.enqueue({ type: "text-end", id: "output" });
      controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 } });
      controller.close();
    } }),
  }) });
  await callMastraSupervisor({ ...base, phase: "specialist", modelConfig: { modelId: "o3", reasoningEffort: "xhigh", maxSteps: 1, maxOutputTokens: 900 },
    onRequest: async value => { settings = value; }, onResponse: async value => { metadata = value; },
  }, "test-key", { model });
  expect(settings).toMatchObject({ requestedReasoningEffort: "xhigh", reasoningEffort: null, maxOutputTokens: 900, maxRetries: 0, stream: true });
  expect(settings.outputSchemaHash).toMatch(/^[a-f0-9]{64}$/);
  expect(metadata.modelId).toBeNull();
});
test("real Mastra agent validates scoped specialist output and redacts transient secrets", async () => {
  const key = "sk-test-secret";
  const recipientRunId = crypto.randomUUID();
  const output = await callMastraSupervisor({ ...base, phase: "specialist" }, key, {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: ({ summary: `Evidence ${key}`, rationale: "Only assigned sources", citations: [],
      messages: [{ recipientRunId, body: `Please check the revision. ${key}` }],
    }) }),
  });
  expect(output).toEqual({ summary: "Evidence [redacted]", rationale: "Only assigned sources", citations: [],
    messages: [{ recipientRunId, body: "Please check the revision. [redacted]" }],
  });
});
test("real Mastra agent rejects plans outside bounded schema", async () => {
  await expect(callMastraSupervisor({ ...base, phase: "plan" }, "test-key", {
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: ({ tasks: [{ role: "admin", goal: "Write data", sourceVersionIds: [] }] }) }),
  })).rejects.toThrow("Supervisor model execution failed");
});
test("Mastra retains received usage after a transient telemetry write failure", async () => {
  const model = new MastraLanguageModelV2Mock({
    provider: "openai", modelId: "gpt-4.1-mini",
    doStream: async () => ({ stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "text-start", id: "output" });
      controller.enqueue({ type: "text-delta", id: "output", delta: JSON.stringify({ summary: "Reviewed", rationale: "Evidence", citations: [] }) });
      controller.enqueue({ type: "text-end", id: "output" });
      controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 37, outputTokens: 11, totalTokens: 48 } });
      controller.close();
    } }) }),
  });
  const saved: unknown[] = [];
  let writeFailed = false;
  await expect(callMastraSupervisor({ ...base, phase: "specialist",
    onUsage: async usage => {
      if (!writeFailed) { writeFailed = true; throw new Error("Telemetry write failed"); }
      saved.push(usage);
    },
  }, "test-key", { model })).rejects.toThrow("Supervisor model execution failed");
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ inputTokens: 37, outputTokens: 11, totalTokens: 48 });
});
test("OpenAI agent messages allow no reply target without accepting malformed reply IDs", async () => {
  const recipientRunId = crypto.randomUUID(), originalMessageId = crypto.randomUUID();
  for (const replyToMessageId of [null, undefined, originalMessageId, "", "not-a-uuid"]) {
    let wireReplySchema: any;
    const output = { summary: "Source conflict identified.", rationale: "Needs clarification.", citations: [],
      messages: [{ recipientRunId, body: "Which source revision is authoritative?", replyToMessageId }] };
    const model = new MastraLanguageModelV2Mock({ provider: "openai.responses", modelId: "gpt-6-luna",
      doStream: async options => {
        const schema = options.responseFormat?.type === "json" ? options.responseFormat.schema as any : undefined;
        wireReplySchema = schema?.properties.messages.items.properties.replyToMessageId;
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "text-start", id: "output" });
          controller.enqueue({ type: "text-delta", id: "output", delta: JSON.stringify(output) });
          controller.enqueue({ type: "text-end", id: "output" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
          controller.close();
        } }) };
      },
    });
    const result = await callMastraSupervisor({ ...base, phase: "specialist", context: {
      messaging: { recipients: [{ runId: recipientRunId }], inbox: [], remainingMessages: 12 },
    } }, "test-key", { model }).then(output => ({ output }), error => ({ error }));
    // Check the actual model-facing contract: a local parser accepting null is not enough.
    expect(wireReplySchema.anyOf).toEqual(expect.arrayContaining([{ type: "null" }, expect.objectContaining({ type: "string" })]));
    if (replyToMessageId === "" || replyToMessageId === "not-a-uuid") {
      expect(result).toMatchObject({ error: { retryable: true, failureCategory: "validation", diagnostics: {
        issues: [{ code: "invalid_string", path: ["messages", 0, "replyToMessageId"], validation: "uuid" }],
      } } });
    } else {
      expect(result).toEqual({ output: { ...output, messages: [{ ...output.messages[0], replyToMessageId: replyToMessageId ?? undefined }] } });
    }
  }
});
test("Mastra truncation and OpenAI schema failures remain retryable without exposing output", async () => {
  for (const failure of ["truncated", "complete_length", "schema", "summary_limit"] as const) {
    for (const streaming of [false, true]) {
      const secret = "sk-test-secret";
      const text = failure === "truncated" ? `{"summary":"${secret}`
        : failure === "complete_length" ? JSON.stringify({ summary: "Valid JSON is still incomplete when stopped by the token cap", rationale: secret, citations: [] })
        : failure === "summary_limit" ? JSON.stringify({ summary: "x".repeat(10001), rationale: secret, citations: [] })
        : JSON.stringify({ summary: secret, rationale: "Invalid citation", citations: ["not-a-uuid"] });
      const finishReason = failure === "truncated" || failure === "complete_length" ? "length" : "stop";
      const usage = { inputTokens: 12, outputTokens: 50, totalTokens: 62 };
      const model = new MastraLanguageModelV2Mock({
        provider: "openai",
        modelId: "gpt-4.1",
        doGenerate: async () => ({ content: [{ type: "text", text }], finishReason, usage, warnings: [], response: { id: "provider-response", modelId: "gpt-4.1-mini-snapshot" } }),
        doStream: async () => ({ stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "response-metadata", id: "provider-response", modelId: "gpt-4.1-mini-snapshot" });
          controller.enqueue({ type: "text-start", id: "output" });
          controller.enqueue({ type: "text-delta", id: "output", delta: text });
          controller.enqueue({ type: "text-end", id: "output" });
          // Exercise the newer provider shape through the V2 mock's older stream type.
          controller.enqueue({ type: "finish", finishReason: failure === "complete_length"
            ? { unified: "length", raw: "max_output_tokens" } as unknown as typeof finishReason : finishReason, usage });
          controller.close();
        } }) }),
      });
      const reportedUsage: unknown[] = [];
      let responseMetadata: any;
      const error = await callMastraSupervisor({
        ...base, phase: "specialist",
        onSummaryDelta: streaming ? async () => {} : undefined,
        onUsage: async value => { reportedUsage.push(value); },
        onResponse: async value => { responseMetadata = value; },
      }, secret, { model }).then(() => { throw new Error("Invalid output was accepted"); }, error => error);
      expect(reportedUsage).toHaveLength(1);
      expect(reportedUsage[0]).toMatchObject({ modelId: "gpt-4.1-mini-snapshot", inputTokens: 12, outputTokens: 50, totalTokens: 62 });
      expect(responseMetadata).toEqual({ modelId: "gpt-4.1-mini-snapshot", responseId: "provider-response", finishReason });
      expect(error).toMatchObject({
        code: "invalid_provider_output", providerFailure: true, retryable: true, failureCategory: "validation",
      });
      expect(error.providerStatus).toBeUndefined();
      expect(error.diagnostics).toMatchObject({
        errorId: failure === "truncated" || failure === "complete_length" ? "STRUCTURED_OUTPUT_TRUNCATED" : "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
        // Prefer upstream metadata over Mastra's post-validation "error" reason.
        finishReason,
      });
      if (failure === "schema") expect(error.diagnostics.issues).toEqual([{ code: "invalid_string", path: ["citations", 0], validation: "uuid" }]);
      if (failure === "summary_limit") expect(error.diagnostics.issues).toEqual([{ code: "too_big", path: ["summary"], maximum: 10000 }]);
      expect(error.cause).toBeUndefined();
      expect(`${error.message}${JSON.stringify(error)}`).not.toContain(secret);
      expect(`${error.message}${JSON.stringify(error)}`).not.toContain("not-a-uuid");
    }
  }
});
test("diagnostics exclude unknown paths, messages, values and unbounded numeric limits", () => {
  const versionId = crypto.randomUUID();
  expect(sanitizeProviderDiagnostics({ errorId: "secret", finishReason: "secret", message: "sk-secret", rejectedCitations: [versionId], issues: [
    { code: "too_big", path: ["summary"], maximum: 10000, message: "sk-secret", value: "sk-secret" },
    { code: "invalid_type", path: ["sk-secret"] },
    { code: "invalid_type", path: ["citations", 101] },
    { code: "sk-secret", path: [] },
    { code: "too_small", path: ["tasks"], minimum: Infinity },
  ] })).toEqual({ issues: [{ code: "too_big", path: ["summary"], maximum: 10000 }, { code: "too_small", path: ["tasks"] }] });
  expect(sanitizeProviderDiagnostics({ errorId: "SOURCE_CITATION_OUT_OF_SCOPE",
    rejectedCitations: [versionId, "sk-secret", { id: versionId }, `${versionId}\nsecret`],
  })).toEqual({ errorId: "SOURCE_CITATION_OUT_OF_SCOPE", rejectedCitations: [versionId] });
  expect(sanitizeProviderDiagnostics({ errorId: "SOURCE_CITATION_OUT_OF_SCOPE",
    rejectedCitations: Array(101).fill(versionId),
  }).rejectedCitations).toHaveLength(100);
  const packet = sanitizeProviderDiagnostics({ issues: [
    { code: "custom", path: ["complete"], params: { editorial: { reason: "incomplete", secret: "sk-secret" } } },
    { code: "custom", path: ["sections", 0, "content"], params: { editorial: {
      reason: "references", missingReferences: [versionId, "sk-secret"], addedReferences: Array(101).fill(versionId),
    } } },
    { code: "invalid_literal", path: ["sections", 0, "key"], expected: "components", received: "sk-secret" },
    { code: "custom", path: ["sections"], params: { editorial: { reason: "references", missingReferences: [versionId] } } },
  ] });
  expect(packet.issues?.[0]?.editorial).toEqual({ reason: "incomplete" });
  expect(packet.issues?.[1]?.editorial?.missingReferences).toEqual([versionId]);
  expect(packet.issues?.[1]?.editorial?.addedReferences).toHaveLength(100);
  expect(packet.issues?.[2]).toEqual({ code: "invalid_literal", path: ["sections", 0, "key"], expected: "components" });
  expect(packet.issues?.[3]).toEqual({ code: "custom", path: ["sections"] });
  expect(JSON.stringify(packet)).not.toContain("sk-secret");
  expect(sanitizeProviderDiagnostics(sanitizeProviderDiagnostics(packet))).toEqual(packet);
});

test("acoustic diagnostics retain schema paths and bounded indices without rejected evidence", () => {
  const { method, ...room } = exteriorNoiseFixture();
  room.facades[1]!.noise.levelDb = 151;
  room.room.floorAreaM2 = 1000001;
  room.facades[1]!.noise.provenance = { kind: "source", versionId: "sk-secret", page: 1, excerpt: "private source text" };
  const parsed = exteriorNoiseExtractionSchema.safeParse({ inventory: [], rooms: [room], blockers: [] });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("Invalid acoustic input was accepted");
  const diagnostics = sanitizeProviderDiagnostics({ issues: parsed.error.issues.map(issue => ({ ...issue, path: ["exteriorNoiseExtraction", ...issue.path] })) });
  expect(diagnostics.issues).toEqual([
    { code: "too_big", path: ["exteriorNoiseExtraction", "rooms", 0, "room", "floorAreaM2"], maximum: 1000000 },
    { code: "too_big", path: ["exteriorNoiseExtraction", "rooms", 0, "facades", 1, "noise", "levelDb"], maximum: 150 },
    { code: "invalid_string", path: ["exteriorNoiseExtraction", "rooms", 0, "facades", 1, "noise", "provenance", "versionId"], validation: "uuid" },
  ]);
  expect(sanitizeProviderDiagnostics(diagnostics)).toEqual(diagnostics);
  expect(JSON.stringify(diagnostics)).not.toContain("sk-secret");
  expect(JSON.stringify(diagnostics)).not.toContain("private source text");
  for (const [path, retained] of [
    [["exteriorNoiseExtraction", "facts", 4999, "value"], true],
    [["exteriorNoiseExtraction", "facts", 5000, "value"], false],
    [["exteriorNoiseExtraction", "rooms", 0, "fieldEvidence", 2999, "provenance", "excerpt"], true],
    [["exteriorNoiseExtraction", "rooms", 0, "fieldEvidence", 3000, "provenance", "excerpt"], false],
    [["exteriorNoiseExtraction", "facts", -1, "value"], false],
    [["exteriorNoiseExtraction", "facts", 1.5, "value"], false],
    [["exteriorNoiseExtraction", "facts", 0, "sk-secret"], false],
    [["exteriorNoiseExtraction", "rooms", 0, "facades", 0, "noise", "provenance", "excerpt", "id", "id"], false],
    [["facts", 4999, "value"], false],
    [["citations", 101], false],
  ] as const) {
    const result = sanitizeProviderDiagnostics({ issues: [{ code: "custom", path,
      message: "private source text", received: "sk-secret", params: { secret: "sk-secret" } }] });
    expect(result).toEqual(retained ? { issues: [{ code: "custom", path: [...path] }] } : {});
  }
  const issue = { code: "custom", path: ["exteriorNoiseExtraction"] };
  expect(sanitizeProviderDiagnostics({ issues: Array(11).fill(issue) }).issues).toHaveLength(10);
});

test("provider 429 diagnostics distinguish quota from throttling without retaining bodies or arbitrary headers", async () => {
  for (const providerCode of ["rate_limit_exceeded", "insufficient_quota", "billing_hard_limit_reached", "secret-provider-code"]) {
    let invocations = 0;
    const model = new MastraLanguageModelV2Mock({ doStream: async () => {
      invocations++;
      throw Object.assign(new Error("secret exception message"), { statusCode: 429, isRetryable: true,
        responseBody: JSON.stringify({ error: { code: providerCode, message: "Request capacity exhausted." }, input: "secret request body" }),
        responseHeaders: { "Retry-After": "72", "authorization": "secret key",
          "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "1m2.5s", "x-ratelimit-remaining-tokens": "secret header" },
      });
    } });
    const error = await callMastraSupervisor({ ...base, phase: "independent_review" }, "test-key", { model })
      .then(() => { throw new Error("Expected rate-limit failure"); }, error => error);
    expect(error).toMatchObject({ providerStatus: 429, retryAfterMs: 72000,
      retryable: !["insufficient_quota", "billing_hard_limit_reached"].includes(providerCode),
      diagnostics: { retryAfterMs: 72000, rateLimit: { limitRequests: 100, remainingRequests: 0, resetRequestsMs: 62500 } },
    });
    expect(error.diagnostics.providerCode).toBe(providerCode.startsWith("secret") ? undefined : providerCode);
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(error.cause).toBeUndefined();
    expect(invocations).toBe(1);
  }
});
test("supervisor preserves nested provider rejection reasons and auth request IDs without SDK payloads", async () => {
  const key = "opaque-private-provider-key";
  for (const status of [400, 401]) {
    const model = new MastraLanguageModelV2Mock({ doStream: async () => {
      throw Object.assign(new Error("Wrapper contains private SDK request"), { cause: Object.assign(new Error(key), {
        statusCode: status,
        responseBody: JSON.stringify({ error: { type: "invalid_request_error", code: status === 400 ? "invalid_function_parameters" : "invalid_api_key",
          param: "tools[4].parameters", message: `Invalid schema: anyOf branches share a first key. ${key} private project excerpt` },
          input: "private SDK request" }),
        responseHeaders: { "x-request-id": "req_schema_123", authorization: `Bearer ${key}` },
      }) });
    } });
    const error: any = await callMastraSupervisor({ ...base, phase: "specialist", context: { excerpt: "private project excerpt" } }, key, { model }).catch(error => error);
    expect(error).toMatchObject({ providerStatus: status, retryable: false, diagnostics: {
      providerCode: status === 400 ? "invalid_function_parameters" : "invalid_api_key", providerType: "invalid_request_error",
      providerParam: "tools[4].parameters", providerRequestId: "req_schema_123",
      providerMessage: "Invalid schema: anyOf branches share a first key. [redacted] [redacted]",
    } });
    for (const secret of [key, "private project excerpt", "private SDK request"]) expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.cause).toBeUndefined();
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
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: finding, spyStream: value => { request = value; } }),
  });
  expect(output).toEqual(finding);
  const prompt = JSON.stringify(request);
  expect(prompt).toContain("fresh, independent reviewer");
  expect(prompt).toContain("against every supplied source excerpt");
  expect(prompt).toContain("Do not claim to have reread absent source text");
  expect(prompt).not.toContain("document.content at most");
  expect(prompt).toContain("summary at most 10000 characters");
  expect(prompt).toContain("contentSupplied=false means deliberately omitted");
  expect(prompt).toContain("no per-response character ceiling");
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
      spyStream: value => { request = value; },
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
    model: createMockModel({ version: "v2", objectGenerationMode: "json", mockText: { summary: "Done", rationale: "Evidence", citations: [] }, spyStream: value => { request = value; } }),
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
  const error = await callMastraSupervisor({ ...base, phase: "specialist", context: { role: "source_reviewer" }, modelPolicy: responsePolicy, onSummaryDelta: async () => {
    count++; controller.abort();
  } }, "test-key", { signal: controller.signal, model: chunkedModel(JSON.stringify({ summary: "A sufficiently long evidence summary has begun streaming and will be interrupted before further details can be published.", rationale: "Evidence", citations: [] })) }).then(() => null, error => error);
  expect(error).toMatchObject({ code: "cancelled" });
  expect(error.failureCategory).not.toBe("timeout");
  expect(count).toBe(1);
});
