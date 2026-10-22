import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fireBacktestHash, fireBacktestJson, firePlanBacktestSchema, runFirePlanBacktest } from "../richtfest-apps/knowledge/src/fire-plan-backtest";

// Deliberately no reference argument, model call, network or database access.
try {
  const { values } = parseArgs({ options: { input: { type: "string" }, out: { type: "string" }, source: { type: "string", multiple: true } } });
  if (!values.input || !values.out || !values.source?.length) throw new Error("Missing arguments");
  const rawInput = await Bun.file(values.input).text();
  const input = firePlanBacktestSchema.parse(JSON.parse(rawInput));
  if (values.source.length !== input.sources.length || new Set(values.source.map(path => basename(path))).size !== values.source.length)
    throw new Error("Source files must match the manifest exactly");
  for (const path of values.source) {
    const expected = input.sources.find(source => source.id === basename(path));
    const digest = createHash("sha256");
    for await (const chunk of Bun.file(path).stream()) digest.update(chunk);
    if (!expected || digest.digest("hex") !== expected.sha256) throw new Error("Source bytes do not match manifest");
  }
  const root = resolve(import.meta.dir, "..");
  const codeFiles = ["richtfest-shared/src/fire-protection.ts", "richtfest-shared/src/fire-protection-schema.ts",
    "richtfest-shared/src/fire-plan.ts", "richtfest-apps/knowledge/src/fire-plan-backtest.ts", "scripts/run-fire-plan-backtest.ts"];
  const codeHashes = await Promise.all(codeFiles.map(async path => ({ path, sha256: fireBacktestHash(await Bun.file(join(root, path)).bytes()) })));
  const engineVersion = `sha256:${fireBacktestHash(JSON.stringify(codeHashes.slice(0, 3).map(({ path, sha256 }) => ({ name: basename(path), sha256 }))))}`;
  const result = runFirePlanBacktest(input, engineVersion);
  await mkdir(values.out, { mode: 0o700 });
  const files: Record<string, string> = {
    "input.json": result.inputBytes, "assessment.json": result.assessmentBytes,
    "candidate.json": fireBacktestJson(result.candidate),
    "execution.json": fireBacktestJson({ version: 1, engineVersion, codeHashes, runtime: Bun.version,
      originalInputSha256: fireBacktestHash(rawInput), normalizedInputSha256: fireBacktestHash(result.inputBytes),
      modelExecution: false, sourceBytesVerified: true }),
  };
  if (result.concept !== null) files["fire-concept.txt"] = result.concept;
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(values.out, name), bytes, { flag: "wx", mode: 0o600 });
  console.log(`Replay saved. Engine ${engineVersion}. Score candidate.json separately; execution is not a passing backtest or concept approval.`);
} catch {
  // Validation errors may contain private plan data. Do not print raw inputs.
  console.error("Fire replay failed. Use --input plan.json --source original.pdf [--source model.ifc] --out NEW_DIRECTORY. Check schema, unique source basenames and hashes. Existing output is never overwritten; inspect partial files before retrying.");
  process.exitCode = 2;
}
