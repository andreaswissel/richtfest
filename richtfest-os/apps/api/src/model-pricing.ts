import type { ProviderUsage } from "@richtfest/knowledge/deps";

// Rates are deliberately versioned and conservative. A model without an exact
// entry is reported with a null estimate instead of using a misleading proxy.
export const MODEL_PRICING_VERSION = "2026-10-10";
type Rate = { provider: ProviderUsage["provider"]; model: RegExp; input: number; output: number; cachedInput?: number };

// USD per million tokens. Keep this list limited to rates we can stand behind.
const RATES: Rate[] = [
  { provider: "typesafe", model: /^jev-1\.13\.0$/, input: 0.042, output: 0 },
  { provider: "openai", model: /^gpt-6-astra(?:-|$)/, input: 10, output: 50, cachedInput: 1 },
  { provider: "openai", model: /^gpt-6(?:\.1)?-sol(?:-|$)/, input: 2, output: 10, cachedInput: 0.2 },
  { provider: "openai", model: /^gpt-6-luna(?:-|$)/, input: 0.1, output: 0.5, cachedInput: 0.01 },
  { provider: "openai", model: /^gpt-4\.1-nano(?:-|$)/, input: 0.1, output: 0.4 },
  { provider: "openai", model: /^gpt-4\.1-mini(?:-|$)/, input: 0.4, output: 1.6 },
  { provider: "openai", model: /^gpt-4\.1(?:-|$)/, input: 2, output: 8 },
  { provider: "openai", model: /^o3-mini(?:-|$)/, input: 1.1, output: 4.4 },
  { provider: "openai", model: /^o3(?:-|$)/, input: 2, output: 8 },
  { provider: "anthropic", model: /^claude-haiku-4(?:-|$)/, input: 1, output: 5 },
  { provider: "anthropic", model: /^claude-sonnet-4(?:-|$)/, input: 3, output: 15 },
  { provider: "anthropic", model: /^claude-opus-4(?:-|$)/, input: 15, output: 75 },
];

function rateFor(provider: ProviderUsage["provider"], modelId: string | null) {
  if (!modelId) return undefined;
  const normalized = modelId.trim().toLowerCase();
  const model = normalized.split("/").at(-1) ?? "";
  const family = provider === "vercel"
    ? normalized.startsWith("anthropic/") ? "anthropic" : "openai"
    : provider;
  return RATES.find((rate) => rate.provider === family && rate.model.test(model));
}

export function estimateCostUsd(usage: Pick<ProviderUsage, "provider" | "modelId" | "inputTokens" | "outputTokens" | "cachedInputTokens">): { estimatedCostUsd: number | null; pricingVersion: string | null } {
  const rate = rateFor(usage.provider, usage.modelId);
  if (!rate || usage.inputTokens === null || usage.outputTokens === null) return { estimatedCostUsd: null, pricingVersion: null };
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached);
  const cost = (uncached * rate.input + cached * (rate.cachedInput ?? rate.input) + usage.outputTokens * rate.output) / 1_000_000;
  return { estimatedCostUsd: Number(cost.toFixed(8)), pricingVersion: MODEL_PRICING_VERSION };
}
