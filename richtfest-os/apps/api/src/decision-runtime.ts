import { z } from "zod";
import type { AppDeps, ProviderUsage } from "@richtfest/knowledge/deps";
import { appRevision, metadataHash } from "./provider-metadata";
import { providerErrorDiagnostics, readProviderError } from "./provider-errors";
import { sanitizeProviderDiagnostics } from "@richtfest/knowledge/deps";
import { estimateCostUsd } from "./model-pricing";

export type DecisionInput = Parameters<NonNullable<AppDeps["executeDecision"]>>[0];
export const decisionPricingVersion = "typesafe-jev-1.13.0-2026-10-13";
const model = "jev-1.13.0" as const;
// Opaque bearer token: reject empty, whitespace and control characters without logging it.
const apiKeySchema = z.string().min(1).refine(value => !/[^!-~]/.test(value));
const timeoutMs = 1500;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({ input_tokens: count, output_tokens: count });
const probability = z.number().finite().min(0).max(1);
const answerSchema = z.object({ type: z.literal("choice"), choice: z.string(),
  probabilities: z.record(probability), confidence: probability }).strict();
const outputSchema = z.object({ model: z.literal(model), answers: z.record(answerSchema) });
const questionsSchema = z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/), z.object({
  type: z.literal("choice"), instructions: z.string().min(1),
  criteria: z.record(z.string().min(1), z.string()).refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 255),
}).strict()).refine(v => Object.keys(v).length >= 1 && Object.keys(v).length <= 64);
const sameKeys = (a: object, b: object) => Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(k => Object.hasOwn(b, k));
type Failure = "invalid_input" | "provider" | "invalid_output" | "transport" | "cancelled" | "timeout";
const failure = (category: Failure) => Object.assign(new Error(`Decision provider failed: ${category}`),
  { failureCategory: category.startsWith("invalid_") ? "validation" : category === "transport" ? "provider" : category,
    code: category === "cancelled" || category === "timeout" ? category : "decision_provider_error" });

/** Fixed endpoint, one short non-streaming attempt; never expose upstream bodies/errors. */
export async function callDecisionModel(input: DecisionInput, apiKey: string,
  options: { signal?: AbortSignal; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([timeout, ...(options.signal ? [options.signal] : [])]);
  let category: Failure = "invalid_input";
  try {
    const parsedApiKey = apiKeySchema.parse(apiKey);
    const questions = questionsSchema.parse(input.questions);
    const body = JSON.stringify({ model, state: input.state, questions });
    if (input.state === undefined) throw failure("invalid_input");
    category = "transport";
    await input.onRequest?.({ version: 1, adapter: "decision", adapterVersion: "1", appRevision: appRevision(),
      modelId: model, requestedReasoningEffort: null, reasoningEffort: null, maxOutputTokens: 0,
      maxSteps: 1, maxRetries: 0, timeoutMs, stream: false, store: null,
      instructionsHash: metadataHash(JSON.stringify(questions)), promptHash: metadataHash(body),
      outputSchemaHash: metadataHash("jev-1.13.0:choice:probabilities:confidence:v1") });
    // Reserve before inference without adding company excerpts to the step log.
    const reused = await input.onPrepared?.({ version: 1, instructions: "", prompt: metadataHash(body), inputBytes: Buffer.byteLength(body, "utf8") });
    if (reused) return { status: "completed" as const, output: outputSchema.parse(reused.output), usage: undefined };
    signal.throwIfAborted();
    // Race also bounds injected fetch implementations and response-body reads that ignore abort.
    const responseBody = await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(failure("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      void (async () => {
        const response = await (options.fetch ?? fetch)(
          "https://api.typesafe.ai/v1/systemone",
          { method: "POST", redirect: "error", signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${parsedApiKey}` }, body });
        if (!response.ok) {
          category = "provider";
          throw Object.assign(failure(category), { providerStatus: response.status,
            diagnostics: await readProviderError(response, apiKey, { state: input.state, questions: input.questions }) });
        }
        return response.json();
      })().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    category = "invalid_output";
    const direct = z.record(z.unknown()).parse(responseBody);
    const rawUsage = usageSchema.safeParse(direct.usage);
    const usage: ProviderUsage = { provider: "typesafe", modelId: model,
      inputTokens: rawUsage.success ? rawUsage.data.input_tokens : null,
      outputTokens: rawUsage.success ? rawUsage.data.output_tokens : null,
      totalTokens: rawUsage.success && Number.isSafeInteger(rawUsage.data.input_tokens + rawUsage.data.output_tokens)
        ? rawUsage.data.input_tokens + rawUsage.data.output_tokens : null,
      reasoningTokens: null, cachedInputTokens: null,
      estimatedCostUsd: estimateCostUsd({ provider: "typesafe", modelId: model,
        inputTokens: rawUsage.success ? rawUsage.data.input_tokens : null,
        outputTokens: rawUsage.success ? rawUsage.data.output_tokens : null, cachedInputTokens: null }).estimatedCostUsd,
      pricingVersion: decisionPricingVersion };
    await input.onUsage?.(usage);
    category = "invalid_output";
    const output = outputSchema.parse(direct);
    if (!sameKeys(output.answers, questions)) throw failure(category);
    for (const [id, answer] of Object.entries(output.answers)) {
      const values = Object.values(answer.probabilities);
      if (!sameKeys(answer.probabilities, questions[id]!.criteria)
        || !Object.hasOwn(answer.probabilities, answer.choice)
        || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-6
        || answer.probabilities[answer.choice] !== Math.max(...values)) throw failure(category);
    }
    await input.onResponse?.({ modelId: model, responseId: null, finishReason: "stop" });
    return { status: "completed" as const, output, usage };
  } catch (error) {
    const value = error as { code?: unknown; providerStatus?: number; diagnostics?: unknown } | null;
    if (value?.code === "budget_exhausted" || value?.code === "outcome_unknown")
      throw Object.assign(new Error("Execution requires human review before inference."), { code: value.code });
    throw Object.assign(failure(options.signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : category), {
      providerStatus: value?.providerStatus,
      diagnostics: { ...sanitizeProviderDiagnostics(value?.diagnostics),
        ...providerErrorDiagnostics(error, apiKey, { state: input.state, questions: input.questions }) },
    });
  }
}
