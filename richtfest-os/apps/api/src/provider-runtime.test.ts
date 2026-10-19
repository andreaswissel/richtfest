import { describe, expect, test } from "bun:test";
import { callProvider, reasoningEffortForModel, redactProviderText, supportsReasoningModel } from "./provider-runtime";
import { buildingDeepLink } from "@richtfest/shared";
import {
  validateTool,
  outputInput,
  directOutputSchema,
} from "../../../../richtfest-apps/knowledge/src/runs";
const output = {
  summary: "Review the IFC excerpt",
  rationale: "Source content requires human review",
  citations: [],
  tools: [],
  artifact: {
    title: "Review",
    content: "Proposed IFC review",
    type: "draft" as const,
  },
};
test("Chat provider receives reviewed building state and returns a proposal for the same stable room and evidence", async () => {
  const projectId = "00000000-0000-4000-8000-000000000001";
  const entityId = "00000000-0000-4000-8000-000000000002";
  const evidence = [{ kind: "page" as const, sourceVersionId: "00000000-0000-4000-8000-000000000003", page: 3 }];
  const deepLink = buildingDeepLink(projectId, "room", entityId);
  const proposal = { entityType: "room" as const, entityId, baseRevision: 4, propertyKey: "roomUse", value: "Conference room", reason: "Clarify room use", evidence };
  let request: any;
  const result = await callProvider({ provider: "openai", goal: `Review ${deepLink}`, context: {
    workflow: { mode: "chat" }, buildingModel: { revision: 4, entities: [{ id: entityId, deepLink }],
      properties: [{ entityId, propertyKey: "roomUse", value: "Meeting room", reviewStatus: "approved", evidence }] },
  } }, "test-credential", async (_url, init) => {
    request = JSON.parse(String(init.body));
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      summary: `Proposed clarification for ${deepLink}`, rationale: "Human review required", citations: [],
      tools: [{ name: "propose_building_model_change", input: proposal }], artifact: null,
    }) }] }] });
  });
  expect(JSON.stringify(request.input)).toContain("Meeting room");
  expect(JSON.stringify(request.input)).toContain(deepLink);
  expect(request.instructions).toContain("never approves or changes a reviewed fact");
  expect(request.instructions).toContain("propose_building_model_change");
  expect(request.instructions).toContain("propose_exterior_noise_inputs");
  const parsed = outputInput.parse(result);
  expect(validateTool(parsed.tools[0]!.name, parsed.tools[0]!.input)).toEqual(proposal);
});
test("direct HTTP and streaming errors preserve provider reasons, not credentials or echoed input", async () => {
  const key = "opaque-connection-token";
  const error = { type: "invalid_request_error", code: "invalid_json_schema", param: "text.format.schema",
    message: `Invalid schema: required must include every property. ${key} confidential document excerpt` };
  for (const provider of ["openai", "anthropic", "vercel"] as const) for (const streaming of [false, true]) {
    const failure: any = await callProvider({ provider, modelId: "test-model", goal: "Review", context: { excerpt: "confidential document excerpt" } }, key,
      async () => streaming ? new Response(`data: ${JSON.stringify({ type: "error", error })}\n\n`,
        { headers: { "content-type": "text/event-stream", "request-id": "req_stream_123" } })
        : Response.json({ error, input: "private raw input" }, { status: 400, headers: { "x-request-id": "req_http_123" } }))
      .catch(error => error);
    expect(failure.diagnostics).toMatchObject({ providerCode: "invalid_json_schema", providerType: "invalid_request_error",
      providerMessage: "Invalid schema: required must include every property. [redacted] [redacted]",
      providerParam: "text.format.schema", providerRequestId: streaming ? "req_stream_123" : "req_http_123" });
    if (!streaming) expect(failure.providerStatus).toBe(400);
    for (const secret of [key, "confidential document excerpt", "private raw input"]) expect(JSON.stringify(failure)).not.toContain(secret);
  }
});
test("malformed, oversized and stalled provider errors preserve HTTP status without dumping bodies", async () => {
  for (const body of ["<html>private proxy response</html>", JSON.stringify({ error: { message: "x".repeat(66000) } }),
    new ReadableStream({ start() {} })]) {
    const failure = await callProvider({ provider: "openai", goal: "Review", context: {} }, "test-key",
      async () => new Response(body, { status: 502, headers: { "x-request-id": "req_proxy_123" } })).catch(error => error);
    expect(failure).toMatchObject({ providerStatus: 502, diagnostics: { providerRequestId: "req_proxy_123",
      providerMessage: "The provider supplied no readable structured error message." } });
    expect(JSON.stringify(failure)).not.toContain("private proxy response");
  }
});
test("configured direct response limits preserve large drafts and enforce the selected caps", async () => {
  const executionLimits = { summaryMaxCharacters: 15000, rationaleMaxCharacters: 3000, documentMaxCharacters: 150000, timeoutSeconds: 180 };
  const large = { ...output, summary: "s".repeat(15000), rationale: "r".repeat(3000), artifact: { ...output.artifact, content: '"'.repeat(150000) } };
  let timeoutMs: number | undefined;
  const result = await callProvider({ provider: "openai", goal: "Draft", context: {}, executionLimits,
    onRequest: async settings => { timeoutMs = settings.timeoutMs; },
  }, "test-key", async () => new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify(large) })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  expect(timeoutMs).toBe(180000);
  expect(directOutputSchema(executionLimits).parse(result)).toEqual(large);
  expect(outputInput.safeParse(result).success).toBe(false);
  expect(directOutputSchema(executionLimits).safeParse({ ...large, summary: large.summary + "s" }).success).toBe(false);
  expect(validateTool("create_draft", { title: "Draft", content: large.artifact.content }, executionLimits)).toMatchObject({ content: large.artifact.content });
  expect(() => validateTool("create_draft", { title: "Draft", content: large.artifact.content + "x" }, executionLimits)).toThrow();
});

test("direct telemetry hashes actual requests and preserves failure usage without invented response metadata", async () => {
  let settings: any;
  let metadata: any;
  let usage: any;
  await expect(callProvider({ provider: "openai", modelId: "o3", reasoningEffort: "xhigh", goal: "private goal", context: {},
    onRequest: async value => { settings = value; }, onResponse: async value => { metadata = value; },
    onUsage: async value => { usage = value; },
  }, "secret", async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(settings.reasoningEffort).toBeNull();
    expect(settings.requestedReasoningEffort).toBe("xhigh");
    expect(body.reasoning).toBeUndefined();
    expect(settings.promptHash).toBe(new Bun.CryptoHasher("sha256").update(body.input).digest("hex"));
    expect(settings.instructionsHash).toBe(new Bun.CryptoHasher("sha256").update(body.instructions).digest("hex"));
    expect(settings.maxOutputTokens).toBe(2500);
    return Response.json({ usage: { input_tokens: 10, output_tokens: 2 }, output: [{ type: "message", content: [{ type: "output_text", text: "invalid" }] }] });
  })).rejects.toThrow("invalid structured output");
  expect(metadata).toEqual({ modelId: null, responseId: null, finishReason: null });
  expect(usage).toMatchObject({ modelId: "o3", inputTokens: 10, outputTokens: 2 });
  expect(JSON.stringify(settings)).not.toContain("private goal");
});
test("direct adapter retains received usage after a transient telemetry write failure", async () => {
  const saved: unknown[] = [];
  let writeFailed = false;
  await expect(callProvider({ provider: "openai", modelId: "gpt-4.1-mini", goal: "Review", context: {},
    onUsage: async usage => {
      if (!writeFailed) { writeFailed = true; throw new Error("Telemetry write failed"); }
      saved.push(usage);
    },
  }, "test-key", async () => Response.json({
    usage: { input_tokens: 37, output_tokens: 11 },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  }))).rejects.toThrow("Telemetry write failed");
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ inputTokens: 37, outputTokens: 11, totalTokens: 48 });
});
test("visual evidence is sent as an image alongside text for each provider, not as prompt JSON", async () => {
  for (const provider of ["openai", "anthropic", "vercel"] as const) {
    const image = { mediaType: "image/jpeg" as const, data: "aW1hZ2UtYnl0ZXM=" };
    let settings: any;
    await callProvider({ provider, modelId: "vision-model", goal: "Read illustration", context: { imageScope: "affinity_preview" }, image,
      onRequest: async value => { settings = value; },
    }, "test-secret", async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const parts = provider === "anthropic" ? body.messages[0].content : body.input[0].content;
      expect(JSON.parse(parts[0].text).context).toEqual({ imageScope: "affinity_preview" });
      expect(parts[0].text).not.toContain(image.data);
      expect(parts[1]).toEqual(provider === "anthropic"
        ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.data } }
        : { type: "input_image", image_url: `data:image/jpeg;base64,${image.data}`, detail: "high" });
      expect(JSON.stringify(settings)).not.toContain(image.data);
      return Response.json(provider === "anthropic"
        ? { content: [{ type: "text", text: JSON.stringify(output) }] }
        : { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
    });
  }
});
describe("trusted provider adapter", () => {
  for (const provider of ["openai", "anthropic"] as const)
    test(`${provider} sends explicit provider request and reads only public text`, async () => {
      let observed: any;
      let responseMetadata: any;
      let reportedUsage: any;
      const result = await callProvider(
        {
          provider,
          onResponse: async value => { responseMetadata = value; },
          onUsage: async value => { reportedUsage = value; },
          modelId: provider === "openai" ? "o3-mini" : "custom-anthropic-model",
          maxOutputTokens: 777,
          reasoningEffort: provider === "openai" ? "high" : undefined,
          goal: "Review source",
          context: { text: "ISO-IFC-SOURCE" },
        },
        "sk-private-secret",
        async (url, init) => {
          observed = { url, init };
          return Response.json(
            provider === "openai"
              ? {
                  id: "response-123", model: "gpt-4.1-mini-snapshot", status: "completed",
                  usage: { input_tokens: 19, output_tokens: 7 },
                  output: [
                    { type: "reasoning", summary: [{ text: "hidden" }] },
                    {
                      type: "message",
                      content: [
                        { type: "output_text", text: JSON.stringify(output) },
                      ],
                    },
                  ],
                }
              : {
                  id: "response-123", model: "claude-sonnet-4-snapshot", stop_reason: "end_turn",
                  usage: { input_tokens: 19, output_tokens: 7 },
                  content: [
                    { type: "thinking", thinking: "hidden" },
                    { type: "text", text: JSON.stringify(output) },
                  ],
                },
          );
        },
      );
      expect(outputInput.parse(result)).toEqual(output);
      expect(responseMetadata).toEqual({ modelId: provider === "openai" ? "gpt-4.1-mini-snapshot" : "claude-sonnet-4-snapshot", responseId: "response-123", finishReason: provider === "openai" ? "completed" : "end_turn" });
      expect(reportedUsage).toMatchObject({ modelId: responseMetadata.modelId, inputTokens: 19, outputTokens: 7, totalTokens: 26 });
      expect(observed.url).toContain(
        provider === "openai" ? "api.openai.com" : "api.anthropic.com",
      );
      expect(observed.init.body).toContain("ISO-IFC-SOURCE");
      const body = JSON.parse(observed.init.body);
      expect(body.model).toBe(provider === "openai" ? "o3-mini" : "custom-anthropic-model");
      expect(provider === "openai" ? body.max_output_tokens : body.max_tokens).toBe(777);
      if (provider === "openai") expect(body.reasoning).toEqual({ effort: "high" });
      else expect(body.reasoning).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("hidden");
    });
  test("vercel uses the AI Gateway model and never falls back", async () => {
    let observed: any;
    const result = await callProvider(
      { provider: "vercel", modelId: "openai/o3", reasoningEffort: "high", goal: "Review source", context: {} },
      "gateway-secret",
      async (url, init) => {
        observed = { url, init };
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
      },
    );
    expect(outputInput.parse(result)).toEqual(output);
    expect(observed.url).toBe("https://ai-gateway.vercel.sh/v1/responses");
    expect(observed.init.headers.authorization).toBe("Bearer gateway-secret");
    expect(observed.init.body).toContain('"model":"openai/o3"');
    expect(observed.init.body).toContain('"reasoning":{"effort":"high"}');
    await expect(callProvider(
      { provider: "vercel", modelId: "anthropic/claude-sonnet-4", goal: "x", context: {} },
      "gateway-secret",
      async () => new Response("secret body", { status: 402 }),
    )).rejects.toThrow("HTTP 402");
  });
  test("upstream error bodies never propagate", async () => {
    await expect(
      callProvider(
        { provider: "openai", goal: "x", context: {} },
        "sk-private-secret",
        async () => new Response("sk-private-secret", { status: 401 }),
      ),
    ).rejects.toThrow("HTTP 401");
  });
  test("suppresses reasoning for ordinary models", async () => {
    expect(supportsReasoningModel("openai", "gpt-4.1-mini")).toBe(false);
    expect(supportsReasoningModel("vercel", "openai/gpt-4.1-mini")).toBe(false);
    expect(supportsReasoningModel("vercel", "openai/o3")).toBe(true);
    expect(supportsReasoningModel("openai", "gpt-5.1")).toBe(true);
    expect(supportsReasoningModel("vercel", "openai/gpt-6.0")).toBe(true);
    expect(supportsReasoningModel("openai", "gpt-5-chat-latest")).toBe(false);
    expect(reasoningEffortForModel("openai", "o3", "xhigh")).toBeUndefined();
    expect(reasoningEffortForModel("openai", "gpt-5", "xhigh")).toBeUndefined();
    expect(reasoningEffortForModel("openai", "gpt-5-mini", "xhigh")).toBeUndefined();
    expect(reasoningEffortForModel("openai", "gpt-5.1", "xhigh")).toBe("xhigh");
    let observed: any;
    await callProvider({ provider: "openai", modelId: "gpt-4.1-mini", reasoningEffort: "high", goal: "x", context: {} }, "secret", async (_url, init) => {
      observed = JSON.parse(String(init.body));
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
    });
    expect(observed.reasoning).toBeUndefined();
  });
  test("provider echo secrets are redacted before parsing", async () => {
    const result = await callProvider(
      { provider: "openai", goal: "x", context: {} },
      "custom-secret-value",
      async () =>
        Response.json({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    ...output,
                    summary: "custom-secret-value sk-another-secret",
                  }),
                },
              ],
            },
          ],
        }),
    );
    expect(JSON.stringify(result)).not.toContain("custom-secret-value");
    expect(JSON.stringify(result)).not.toContain("sk-another-secret");
    expect(redactProviderText("Bearer testsecret")).toBe("Bearer [redacted]");
  });
  test("tools are strictly allowlisted and cannot accept arbitrary URLs or writes", () => {
    expect(() =>
      validateTool("fetch_url", { url: "https://example.com" }),
    ).toThrow();
    expect(() =>
      validateTool("resolve_project_source", { url: "https://example.com" }),
    ).toThrow();
    expect(() =>
      validateTool("create_draft", {
        title: "x",
        content: "y",
        status: "approved",
      }),
    ).toThrow();
    expect(
      validateTool("validated_calculation", {
        request: "Calculate sound insulation",
      }),
    ).toEqual({ request: "Calculate sound insulation" });
  });
});
for (const provider of ["openai", "anthropic"] as const)
  test(`${provider} streams decoded summary deltas only`, async () => {
    const deltas: string[] = [];
    const full = JSON.stringify({
      ...output,
      summary: "First sentence. Second sentence. Safe ending.",
    });
    const pieces = [full.slice(0, 32), full.slice(32, 52), full.slice(52)];
    const result = await callProvider(
      {
        provider,
        goal: "Review",
        context: {},
        onSummaryDelta: async (delta) => {
          deltas.push(delta);
        },
      },
      "sk-private-key",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const piece of pieces) {
                const event =
                  provider === "openai"
                    ? { type: "response.output_text.delta", delta: piece }
                    : {
                        type: "content_block_delta",
                        delta: { type: "text_delta", text: piece },
                      };
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(event)}\n\n`,
                  ),
                );
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(
      "First sentence. Second sentence. Safe ending.",
    );
    expect(JSON.stringify(deltas)).not.toContain("rationale");
    expect(outputInput.parse(result).summary).toBe(deltas.join(""));
  });
