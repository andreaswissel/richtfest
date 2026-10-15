import { expect, test } from "bun:test";
import { summarizeUsageRows } from "../richtfest-apps/knowledge/src/usage";

test("known cost reconciles settled steps with the authoritative priced ledger without inventing usage", () => {
  const attempt = { id: "partial", runId: "run", usageStatus: "missing", settledCostUsd: 2.405285 };
  const ledger = { runId: "run", attemptId: "previous", estimatedCostUsd: 36880805, inputTokens: 10, outputTokens: 5 };
  const partial = summarizeUsageRows([ledger], [attempt]);
  expect(partial.recordedCostUsd).toBeCloseTo(39.286090, 6);
  expect(partial.estimatedCostUsd).toBeNull();
  expect(partial.inputTokens).toBeNull();
  expect(partial.callCount).toBe(1);
  expect(summarizeUsageRows([], [attempt])).toMatchObject({ recordedCostUsd: 2.405285, estimatedCostUsd: null, callCount: 0, totalTokens: null });
  expect(summarizeUsageRows([], [{ ...attempt, settledCostUsd: 0 }]).recordedCostUsd).toBe(0);
  expect(summarizeUsageRows([], [{ ...attempt, settledCostUsd: null }]).recordedCostUsd).toBeNull();
  expect(summarizeUsageRows([], [{ ...attempt, usageStatus: "not_applicable" }]).recordedCostUsd).toBeNull();
  const unpriced = { ...ledger, attemptId: attempt.id, estimatedCostUsd: null, inputTokens: null, outputTokens: null };
  expect(summarizeUsageRows([ledger, unpriced], [attempt])).toMatchObject({ recordedCostUsd: 39.28609, estimatedCostUsd: null, callCount: 2, inputTokens: null });
  // A later complete ledger (including legitimate zero) replaces, never adds to, the receipt.
  for (const cost of [0, 3000000]) {
    const full = summarizeUsageRows([{ ...unpriced, estimatedCostUsd: cost, inputTokens: 1, outputTokens: 2 }], [attempt]);
    expect(full.recordedCostUsd).toBe(cost / 1e6);
    expect(full.estimatedCostUsd).toBe(cost / 1e6);
  }
  // Attempt identity also includes the owning run; an unrelated row cannot suppress a receipt.
  expect(summarizeUsageRows([{ ...ledger, attemptId: attempt.id, runId: "other", estimatedCostUsd: 0 }], [attempt]).recordedCostUsd).toBe(2.405285);
});
