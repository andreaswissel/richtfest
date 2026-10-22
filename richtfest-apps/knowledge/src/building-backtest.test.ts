import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildingBacktestModels, evaluateBuildingBacktest } from "./building-backtest";

const sha = "a".repeat(64);
const sources = [{ id: "plan", sha256: sha, format: "pdf" }];
const check = {
  id: "room-1.required-db", stage: "acoustics", description: "Required facade insulation", critical: true,
  expectedOutcome: "complete", expectedValue: 42, unit: "dB", tolerance: 0.1, evidenceRequired: true,
  tool: { name: "exterior-noise", version: "1" }, humanReviewRequired: false,
};
const observation = {
  id: check.id, outcome: "complete", value: 42.1, unit: "dB",
  evidence: [{ kind: "page", sourceId: "plan", page: 2 }], artifactId: null,
  calculation: { tool: "exterior-noise", version: "1", inputSha256: sha, outputSha256: sha },
  review: null, note: "Synthetic arithmetic boundary; not a real building assessment.",
};
const reference = { version: 1, caseId: "synthetic-pdf", split: "synthetic", review: null, sources, checks: [check] };
const candidate = { version: 1, caseId: reference.caseId, runIds: [], sources, artifacts: [], observations: [observation] };
const score = (changes = {}) => evaluateBuildingBacktest(reference, { ...candidate, observations: [{ ...observation, ...changes }] });

test("unrounded tolerance includes both boundaries but not a rounded near miss or wrong units", () => {
  expect(score().passed).toBe(true);
  expect(score({ value: 41.9 }).passed).toBe(true);
  const miss = score({ value: 42.10001 });
  expect(miss.passed).toBe(false);
  expect(miss.rows[0]!.delta).toBeCloseTo(0.10001, 8);
  expect(miss.criticalFailures).toEqual([check.id]);
  expect(score({ unit: "m²" }).rows[0]!.reasons).toContain("unit_mismatch");
  expect(score().stages.find(item => item.stage === "fire")!.score).toBeNull();
  expect(score().benchmarkEligible).toBe(false);
  expect(evaluateBuildingBacktest({ ...reference, checks: [{ ...check, tolerance: 0 }] },
    { ...candidate, observations: [{ ...observation, value: 42.00000000000001 }] }).passed).toBe(false);
});

test("missing, blocked, unsupported and unexpected outputs cannot disappear from coverage", () => {
  const missing = evaluateBuildingBacktest(reference, { ...candidate, observations: [] });
  expect(missing.stages.find(item => item.stage === "acoustics")).toMatchObject({ total: 1, passed: 0, score: 0 });
  for (const outcome of ["blocked", "unsupported", "failed"]) expect(score({ outcome }).passed).toBe(false);
  const unexpected = evaluateBuildingBacktest(reference, { ...candidate, observations: [observation, { ...observation, id: "extra" }] });
  expect(unexpected.passed).toBe(false);
  expect(unexpected.unexpectedIds).toEqual(["extra"]);
  expect(() => evaluateBuildingBacktest(reference, { ...candidate, observations: [observation, observation] })).toThrow();
});

test("revision mismatch, invented citations and unversioned or wrong tools are rejected", () => {
  expect(() => evaluateBuildingBacktest(reference, { ...candidate, sources: [{ ...sources[0], sha256: "b".repeat(64) }] })).toThrow();
  expect(score({ evidence: [] }).passed).toBe(false);
  expect(score({ evidence: [{ kind: "page", sourceId: "other", page: 1 }] }).passed).toBe(false);
  expect(score({ evidence: [{ kind: "ifc", sourceId: "plan", expressId: 1, attribute: "Name" }] }).passed).toBe(false);
  expect(score({ calculation: null }).passed).toBe(false);
  expect(score({ calculation: { ...observation.calculation, version: "2" } }).passed).toBe(false);
  expect(() => evaluateBuildingBacktest({ ...reference, checks: [{ ...check, tool: null }] }, candidate)).toThrow();
});

test("concept quality requires human review bound to the exact artifact, never a heading or self-grade", () => {
  const concept = { ...check, id: "fire-concept", stage: "concept", expectedValue: null, unit: null, tolerance: 0, tool: null, humanReviewRequired: true };
  const expected = { ...reference, checks: [concept] };
  const actual = { ...observation, id: concept.id, value: null, unit: null, calculation: null, artifactId: "concept" };
  const dossier = { ...candidate, artifacts: [{ id: "concept", sha256: sha }], observations: [actual] };
  expect(evaluateBuildingBacktest(expected, dossier).passed).toBe(false);
  const review = { reviewer: "Domain reviewer", reviewedAt: "2026-10-22T10:00:00Z", note: "Checked applicability, measures, citations and gaps", verdict: "pass", artifactSha256: sha };
  expect(evaluateBuildingBacktest(expected, { ...dossier, observations: [{ ...actual, review }] }).passed).toBe(true);
  expect(evaluateBuildingBacktest(expected, { ...dossier, observations: [{ ...actual, review: { ...review, artifactSha256: "b".repeat(64) } }] }).passed).toBe(false);
});

test("a deliberate safety abstention passes only an expected abstention", () => {
  const safety = { ...check, stage: "safety", expectedOutcome: "blocked", expectedValue: null, unit: null, tolerance: 0, evidenceRequired: false, tool: null };
  const expected = { ...reference, checks: [safety] };
  const actual = { ...observation, outcome: "blocked", value: null, unit: null, calculation: null, evidence: [] };
  expect(evaluateBuildingBacktest(expected, { ...candidate, observations: [actual] }).passed).toBe(true);
  expect(evaluateBuildingBacktest(expected, { ...candidate, observations: [{ ...actual, outcome: "complete" }] }).passed).toBe(false);
});

const run = {
  run: { id: "root", status: "completed", goal: "Private source material" },
  attempts: [{ id: "attempt-1", runId: "root", provider: "openai", status: "completed", usageStatus: "reported",
    settings: { modelId: "requested-alias", reasoningEffort: "high", appRevision: "revision-1", instructionsHash: sha, promptHash: sha,
      credential: "never-export", prompt: "private-prompt" }, response: { modelId: "reported-snapshot" } }],
  usage: { calls: [{ id: "call-1", attemptId: "attempt-1", provider: "openai", modelId: "usage-model",
    inputTokens: 100, outputTokens: 30, estimatedCostUsd: 0.003, pricingVersion: "test" }] },
};

test("provenance separates requested and reported models, includes failed attempts, and strips raw/private payloads", () => {
  const result = buildingBacktestModels([run]);
  expect(result.attempts[0]).toMatchObject({ requestedModel: "requested-alias", reportedModel: "reported-snapshot" });
  expect(result.provenanceComplete).toBe(true);
  expect(result.recordedCostUsd).toBe(0.003);
  expect(result.costComplete).toBe(true);
  for (const value of ["never-export", "private-prompt", "Private source material"]) expect(JSON.stringify(result)).not.toContain(value);
  const partial = buildingBacktestModels([{ ...run, attempts: [...run.attempts,
    { ...run.attempts[0], id: "attempt-2", status: "failed", response: null }] }]);
  expect(partial.attempts[1]!.reportedModel).toBeNull();
  expect(partial.provenanceComplete).toBe(false);
  expect(partial.costComplete).toBe(false);
  expect(partial.missingUsageAttemptIds).toEqual(["attempt-2"]);
  expect(buildingBacktestModels([{ ...run, attempts: [{ ...run.attempts[0], usageStatus: "missing" }] }]).costComplete).toBe(false);
  expect(buildingBacktestModels([{ ...run, attempts: [] }])).toMatchObject({ orphanCallIds: ["call-1"], provenanceComplete: false, costComplete: false });
  expect(buildingBacktestModels([])).toMatchObject({ provenanceComplete: false, costComplete: false, recordedCostUsd: null });
  expect(() => buildingBacktestModels([run, run])).toThrow();
});

test("CLI prepares pinned PDF/IFC dossiers without overwriting, then distinguishes missing, matching and invalid results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "building-backtest-"));
  const script = resolve(import.meta.dir, "../../../scripts/evaluate-building-backtest.ts");
  const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args]);
  try {
    const pdf = "%PDF-1.4\n% Synthetic hash fixture, not an extraction fixture\n";
    await Bun.write(join(directory, "plan.pdf"), pdf);
    await Bun.write(join(directory, "model.ifc"), "ISO-10303-21;\nEND-ISO-10303-21;");
    const target = join(directory, "case");
    const prepare = () => invoke("--prepare", target, "--case-id", "fixture", "--source", join(directory, "plan.pdf"), "--source", join(directory, "model.ifc"));
    expect(prepare().exitCode).toBe(0);
    const referencePath = join(target, "reference.json"), candidatePath = join(target, "candidate.json");
    const original = await Bun.file(referencePath).text();
    expect(JSON.parse(original).sources[0].sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect(JSON.parse(original).sources[1].format).toBe("ifc");
    expect(prepare().exitCode).toBe(2);
    expect(await Bun.file(referencePath).text()).toBe(original);
    const score = () => invoke("--reference", referencePath, "--candidate", candidatePath);
    const missing = score();
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout.toString()).criticalFailures).toHaveLength(7);
    const actual = await Bun.file(candidatePath).json();
    actual.artifacts = [{ id: "report", sha256: sha }];
    actual.observations = JSON.parse(original).checks.map((item: { id: string }) => ({
      id: item.id, outcome: "complete", value: null, unit: null,
      evidence: [{ kind: "page", sourceId: "plan.pdf", page: 1 }], artifactId: "report", calculation: null,
      review: { reviewer: "Synthetic test", reviewedAt: "2026-10-22T10:00:00Z", verdict: "pass", artifactSha256: sha, note: "Not a real domain review" },
      note: "Synthetic observation only",
    }));
    await Bun.write(candidatePath, JSON.stringify(actual));
    expect(score().exitCode).toBe(0);
    expect(JSON.parse(score().stdout.toString()).benchmarkEligible).toBe(false);
    actual.runIds = ["missing-run-export"];
    await Bun.write(candidatePath, JSON.stringify(actual));
    const invalid = score();
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout.toString()).toBe("");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
