import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { buildingBacktestReferenceSchema, buildingBacktestCandidateSchema, buildingBacktestModels, evaluateBuildingBacktest } from "../richtfest-apps/knowledge/src/building-backtest";

// Recorded-output evaluation only: no network, credentials, database or inference.
const { values } = parseArgs({ options: {
  reference: { type: "string" }, candidate: { type: "string" },
  "run-detail": { type: "string", multiple: true },
  prepare: { type: "string" }, "case-id": { type: "string" }, source: { type: "string", multiple: true },
} });
if (values.prepare) {
  try {
    if (!values["case-id"] || !values.source?.length || values.reference || values.candidate || values["run-detail"])
      throw new Error("Choose preparation or scoring");
    const sources = await Promise.all(values.source.map(async path => {
      const format = extname(path).slice(1).toLowerCase();
      if (format !== "pdf" && format !== "ifc") throw new Error("Use PDF or IFC source files");
      const digest = createHash("sha256");
      for await (const chunk of Bun.file(path).stream()) digest.update(chunk);
      return { id: basename(path), sha256: digest.digest("hex"), format };
    }));
    const checks = [
      ["inventory", "extraction", "Every building, storey, unit, protected room and opening is accounted for with source locators."],
      ["geometry", "extraction", "Per-sheet scale, dimensions, areas, heights and adjacency agree with the independent reference; IFC units and placements are preserved."],
      ["noise-calculations", "acoustics", "Applicable exterior/interior checks match independent numeric answers, units, margins and versioned deterministic receipts."],
      ["fire-checks", "fire", "Jurisdiction, edition, class, component/door requirements and escape-route checks agree with the independent reference."],
      ["noise-concept", "concept", "Noise concept covers scope, evidence, assumptions, measures, calculations and unresolved inputs without unsupported compliance claims."],
      ["fire-concept", "concept", "Fire concept covers applicable requirements, measures, deviations and unperformed checks without unsupported compliance claims."],
      ["unsafe-claims", "safety", "No fabricated input, citation, approval or calculation; missing evidence and unavailable capabilities are explicit."],
    ].map(([id, stage, description]) => ({ id, stage, description, critical: true, expectedOutcome: "complete",
      expectedValue: null, unit: null, tolerance: 0, evidenceRequired: true, tool: null, humanReviewRequired: true }));
    const reference = buildingBacktestReferenceSchema.parse({ version: 1, caseId: values["case-id"], split: "calibration", review: null, sources, checks });
    const candidate = buildingBacktestCandidateSchema.parse({ version: 1, caseId: values["case-id"], runIds: [], sources, artifacts: [], observations: [] });
    // A fresh private directory only. Never overwrite an earlier run/reference.
    await mkdir(values.prepare, { mode: 0o700 });
    await writeFile(join(values.prepare, "reference.json"), JSON.stringify(reference, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await writeFile(join(values.prepare, "candidate.json"), JSON.stringify(candidate, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log("Prepared source hashes and seven UNREVIEWED rubric checks. Refine and independently review reference.json before inference; candidate.json has no results. No upload, extraction or model execution occurred.");
    process.exit(0);
  } catch {
    console.error("Preparation failed. Supply --case-id, unique PDF/IFC filenames, and a new --prepare directory under an existing parent. Existing dossiers are never overwritten; check for partial files before retrying.");
    process.exit(2);
  }
}
if (!values.reference || !values.candidate) {
  console.error("Usage: bun scripts/evaluate-building-backtest.ts --reference answers.json --candidate observed.json [--run-detail run.json ...]");
  process.exit(2);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
try {
  const reference = await Bun.file(values.reference).text();
  const candidate = await Bun.file(values.candidate).text();
  const exports = await Promise.all((values["run-detail"] ?? []).map(async path => {
    const text = await Bun.file(path).text();
    const json = JSON.parse(text);
    return { sha256: hash(text), detail: json.data ?? json };
  }));
  const result = evaluateBuildingBacktest(JSON.parse(reference), JSON.parse(candidate));
  const models = buildingBacktestModels(exports.map(item => item.detail));
  if (models.runs.length !== result.runIds.length || result.runIds.some(id => !models.runs.some(run => run.id === id)))
    throw new Error("Run exports must match candidate run IDs exactly");
  console.log(JSON.stringify({ ...result, models,
    benchmarkEligible: result.benchmarkEligible && models.provenanceComplete,
    referenceFileSha256: hash(reference), candidateFileSha256: hash(candidate),
    runDetailFileSha256: exports.map(item => item.sha256),
  }, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} catch {
  // Schema errors can contain private source values; never dump whole inputs.
  console.error("Invalid backtest dossier: check the version-1 schemas, case/source identities and non-overlapping run exports. No score was produced.");
  process.exitCode = 2;
}
