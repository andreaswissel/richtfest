import { z } from "zod";

const text = z.string().trim().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([z.number().finite(), z.boolean(), text]);
const stage = z.enum(["extraction", "acoustics", "fire", "concept", "safety"]);
const outcome = z.enum(["complete", "blocked", "unsupported", "failed"]);
const source = z.object({ id: text, sha256, format: z.enum(["pdf", "ifc"]) }).strict();
const uniqueIds = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
const review = z.object({ reviewer: text, reviewedAt: z.string().datetime(), note: text }).strict();

/** Evaluator-only answers. Never attach this file to the project or model prompt. */
export const buildingBacktestReferenceSchema = z.object({
  version: z.literal(1), caseId: text, split: z.enum(["synthetic", "calibration", "holdout"]),
  review: review.nullable(),
  sources: z.array(source).min(1).refine(uniqueIds, "Source IDs must be unique"),
  checks: z.array(z.object({
    id: text, stage, description: text, critical: z.boolean(),
    expectedOutcome: outcome,
    expectedValue: scalar.nullable(), unit: text.nullable(), tolerance: z.number().finite().nonnegative(),
    evidenceRequired: z.boolean(),
    // The reference author chooses the applicable deterministic method, not the candidate.
    tool: z.object({ name: text, version: text }).strict().nullable(),
    humanReviewRequired: z.boolean(),
  }).strict()).min(1).refine(uniqueIds, "Check IDs must be unique"),
}).strict().superRefine((value, ctx) => {
  for (const [index, check] of value.checks.entries()) {
    if (check.expectedOutcome === "complete" && check.expectedValue === null && !check.humanReviewRequired)
      ctx.addIssue({ code: "custom", path: ["checks", index], message: "Completion needs an expected value or human review" });
    if (check.stage === "concept" && !check.humanReviewRequired)
      ctx.addIssue({ code: "custom", path: ["checks", index], message: "Concept quality needs human review, not keyword matching" });
    if ((check.stage === "acoustics" || check.stage === "fire") && typeof check.expectedValue === "number"
      && check.expectedOutcome === "complete" && !check.tool)
      ctx.addIssue({ code: "custom", path: ["checks", index], message: "Engineering numbers need a versioned deterministic tool" });
    if (typeof check.expectedValue !== "number" && check.tolerance !== 0)
      ctx.addIssue({ code: "custom", path: ["checks", index], message: "Tolerance applies only to numeric values" });
  }
});

const evidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), sourceId: text, page: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("ifc"), sourceId: text, expressId: z.number().int().positive(), attribute: text }).strict(),
]);
export const buildingBacktestCandidateSchema = z.object({
  version: z.literal(1), caseId: text,
  runIds: z.array(text).refine(ids => new Set(ids).size === ids.length, "Run IDs must be unique"),
  sources: z.array(source).min(1).refine(uniqueIds, "Source IDs must be unique"),
  artifacts: z.array(z.object({ id: text, sha256 }).strict()).refine(uniqueIds, "Artifact IDs must be unique"),
  observations: z.array(z.object({
    id: text, outcome, value: scalar.nullable(), unit: text.nullable(),
    evidence: z.array(evidence), artifactId: text.nullable(),
    calculation: z.object({ tool: text, version: text, inputSha256: sha256, outputSha256: sha256 }).strict().nullable(),
    review: review.extend({ verdict: z.enum(["pass", "fail"]), artifactSha256: sha256 }).strict().nullable(),
    note: text,
  }).strict()).refine(uniqueIds, "Observation IDs must be unique"),
}).strict();

/** Scores recorded outputs, not model self-grades. Hashes bind the dossier, not
 * the truth of its contents: a domain reviewer still checks sources/receipts.
 */
export function evaluateBuildingBacktest(rawReference: unknown, rawCandidate: unknown) {
  const reference = buildingBacktestReferenceSchema.parse(rawReference);
  const candidate = buildingBacktestCandidateSchema.parse(rawCandidate);
  if (candidate.caseId !== reference.caseId) throw new Error("Case IDs differ");
  if (candidate.sources.length !== reference.sources.length || reference.sources.some(expected =>
    !candidate.sources.some(actual => actual.id === expected.id && actual.sha256 === expected.sha256 && actual.format === expected.format)))
    throw new Error("Candidate must use exactly the pinned source revisions");
  const observations = new Map(candidate.observations.map(item => [item.id, item]));
  const sources = new Map(reference.sources.map(item => [item.id, item]));
  const artifacts = new Map(candidate.artifacts.map(item => [item.id, item]));
  const unexpectedIds = candidate.observations.filter(item => !reference.checks.some(check => check.id === item.id)).map(item => item.id);
  const rows = reference.checks.map(check => {
    const actual = observations.get(check.id);
    const reasons: string[] = [];
    let delta: number | null = null;
    if (!actual) reasons.push("missing_observation");
    else {
      if (actual.outcome !== check.expectedOutcome) reasons.push(`outcome_${actual.outcome}`);
      if (check.expectedValue !== null) {
        if (typeof check.expectedValue === "number" && typeof actual.value === "number") {
          delta = actual.value - check.expectedValue;
          // Only absorb floating-point representation error, never reporting precision.
          const epsilon = check.tolerance === 0 ? 0 : Number.EPSILON * Math.max(1, Math.abs(actual.value), Math.abs(check.expectedValue)) * 4;
          if (Math.abs(delta) > check.tolerance + epsilon) reasons.push("value_outside_tolerance");
        } else if (actual.value !== check.expectedValue) reasons.push("value_mismatch");
      }
      if (actual.unit !== check.unit) reasons.push("unit_mismatch");
      if (check.evidenceRequired && !actual.evidence.length) reasons.push("missing_evidence");
      if (actual.evidence.some(item => sources.get(item.sourceId)?.format !== (item.kind === "page" ? "pdf" : "ifc")))
        reasons.push("invalid_source_locator");
      const artifact = actual.artifactId ? artifacts.get(actual.artifactId) : undefined;
      if (actual.artifactId && !artifact) reasons.push("unknown_artifact");
      if (check.tool && (actual.calculation?.tool !== check.tool.name || actual.calculation?.version !== check.tool.version))
        reasons.push("missing_or_wrong_calculation_tool");
      if (check.humanReviewRequired && (!actual.review || actual.review.verdict !== "pass"
        || !artifact || actual.review.artifactSha256 !== artifact.sha256)) reasons.push("missing_or_failed_artifact_review");
    }
    return { id: check.id, stage: check.stage, description: check.description, critical: check.critical,
      passed: reasons.length === 0, reasons, delta, expected: check.expectedValue, actual: actual?.value ?? null,
      outcome: actual?.outcome ?? "missing", note: actual?.note ?? null };
  });
  const stages = stage.options.map(name => {
    const checks = rows.filter(row => row.stage === name);
    return { stage: name, total: checks.length, passed: checks.filter(row => row.passed).length,
      score: checks.length ? checks.filter(row => row.passed).length / checks.length : null,
      gaps: checks.filter(row => !row.passed).map(row => row.id) };
  });
  const passed = rows.every(row => row.passed) && unexpectedIds.length === 0;
  const criticalFailures = rows.filter(row => row.critical && !row.passed).map(row => row.id);
  return { version: 1, caseId: reference.caseId, runIds: candidate.runIds, split: reference.split, passed, criticalFailures, unexpectedIds, stages, rows,
    referenceReviewed: reference.review !== null,
    benchmarkEligible: passed && reference.review !== null && reference.split === "holdout" && stages.every(item => item.total > 0),
    note: "Recorded-output comparison only. Evidence locators and receipt hashes require independent verification. A matching result is not engineering approval or proof of end-to-end execution." };
}

// Parse only allowlisted metadata from the existing GET /api/knowledge/runs/:id
// response. Raw prompts, source text, tool payloads and credentials never export.
const nullableText = text.nullable().optional();
const count = z.number().int().nonnegative().nullable().optional();
const runDetailSchema = z.object({
  run: z.object({ id: text, status: text }),
  attempts: z.array(z.object({
    id: text, runId: text, provider: text, status: text, usageStatus: text,
    phase: text.optional(), startedAt: z.string().datetime().optional(), completedAt: z.string().datetime().nullable().optional(),
    settings: z.object({
      modelId: nullableText, modelRole: nullableText, requestedReasoningEffort: nullableText, reasoningEffort: nullableText,
      appRevision: nullableText, adapter: nullableText, adapterVersion: nullableText,
      instructionsHash: nullableText, promptHash: nullableText, outputSchemaHash: nullableText, toolSchemaHash: nullableText,
      maxOutputTokens: count, maxSteps: count, maxRetries: count, timeoutMs: count,
    }).nullable(),
    response: z.object({ modelId: nullableText }).nullable(),
  })),
  usage: z.object({ calls: z.array(z.object({
    id: text, attemptId: text.nullable(), provider: text, modelId: nullableText,
    inputTokens: count, outputTokens: count,
    estimatedCostUsd: z.number().finite().nonnegative().nullable(), pricingVersion: nullableText,
  })) }),
});

export function buildingBacktestModels(rawDetails: unknown[]) {
  const details = rawDetails.map(raw => runDetailSchema.parse(raw));
  const attempts = details.flatMap(detail => detail.attempts);
  const calls = details.flatMap(detail => detail.usage.calls);
  if (!uniqueIds(attempts) || !uniqueIds(calls)) throw new Error("Run exports overlap; include each attempt/call once");
  const orphanCallIds = calls.filter(call => !attempts.some(attempt => attempt.id === call.attemptId)).map(call => call.id);
  const modelAttempts = attempts.filter(attempt => attempt.usageStatus !== "not_applicable");
  const missingUsageAttempts = modelAttempts.filter(attempt => attempt.usageStatus !== "reported"
    || attempt.status === "running" || !calls.some(call => call.attemptId === attempt.id));
  const priced = calls.filter(call => call.estimatedCostUsd !== null);
  return {
    runs: details.map(detail => detail.run),
    attempts: attempts.map(attempt => ({
      id: attempt.id, runId: attempt.runId, provider: attempt.provider, status: attempt.status, usageStatus: attempt.usageStatus,
      phase: attempt.phase ?? null,
      elapsedMs: attempt.startedAt && attempt.completedAt ? Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt) : null,
      requestedModel: attempt.settings?.modelId ?? null, reportedModel: attempt.response?.modelId ?? null,
      settings: attempt.settings,
    })),
    calls,
    orphanCallIds,
    missingUsageAttemptIds: missingUsageAttempts.map(attempt => attempt.id),
    unpricedCalls: calls.length - priced.length,
    recordedCostUsd: priced.length ? priced.reduce((sum, call) => sum + call.estimatedCostUsd!, 0) : null,
    costComplete: calls.length > 0 && !orphanCallIds.length && !missingUsageAttempts.length && priced.length === calls.length,
    provenanceComplete: modelAttempts.length > 0 && !orphanCallIds.length && modelAttempts.every(attempt =>
      attempt.settings?.modelId && attempt.response?.modelId && attempt.settings?.appRevision
      && attempt.settings?.instructionsHash && attempt.settings?.promptHash),
  };
}
