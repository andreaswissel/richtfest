import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syntheticPlanPdf } from "../richtfest-apps/projects/src/test-fixtures/synthetic-plan";
import { buildingBacktestCandidateSchema } from "../richtfest-apps/knowledge/src/building-backtest";

test("source-only CLI extracts a PDF, retains missing selections, and never borrows reference inputs or approvals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-candidate-backtest-"));
  const script = resolve(import.meta.dir, "../scripts/run-plan-candidate-backtest.ts");
  const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args]);
  try {
    const source = join(directory, "plan.pdf"), output = join(directory, "run");
    const bytes = syntheticPlanPdf({ unitFill: true });
    await Bun.write(source, bytes);
    const args = ["--source", source, "--page", "1", "--case-id", "synthetic-plan", "--out", output];
    const executed = invoke(...args);
    expect(executed.stderr.toString()).not.toContain("Plan replay failed");
    expect(executed.exitCode).toBe(0);
    const candidateBytes = await Bun.file(join(output, "candidate.json")).text();
    const candidate = buildingBacktestCandidateSchema.parse(JSON.parse(candidateBytes));
    const execution = await Bun.file(join(output, "execution.json")).json();
    expect(candidate.sources).toEqual([{ id: "plan.pdf", format: "pdf", sha256: createHash("sha256").update(bytes).digest("hex") }]);
    expect(execution).toMatchObject({ modelExecution: false, providerCalls: 0, savedModelInputs: false, referenceInputs: false, extractedRooms: 5, includedRooms: 5 });
    const previewBytes = await Bun.file(join(output, "preview.json")).text();
    const { preview } = JSON.parse(previewBytes);
    expect(preview.reviewStatus).toBe("unreviewed");
    expect(preview.geometry.every((room: any) => room.clearHeight === null)).toBe(true);
    const living = preview.geometry.find((room: any) => room.name === "Wohnen");
    const bath = preview.geometry.find((room: any) => room.name === "Bad");
    // Nominal source cells are 53 and 13.5 m²; the outlines exclude partition faces.
    expect(living.areaM2).toBeGreaterThan(49);
    expect(living.areaM2).toBeLessThan(53);
    expect(bath.areaM2).toBeGreaterThan(12);
    expect(bath.areaM2).toBeLessThan(13.5);
    expect(preview.fire.assessment.classification.buildingClass).toBeNull();
    expect(preview.exterior.batch).toBeNull();
    expect(candidate.artifacts.find(row => row.id === "preview")!.sha256).toBe(createHash("sha256").update(previewBytes).digest("hex"));
    expect(candidate.observations.filter(row => row.id.startsWith("room:") && row.outcome === "complete")).toHaveLength(5);
    expect(candidate.observations.filter(row => !row.id.startsWith("room:")).every(row => row.outcome !== "complete")).toBe(true);
    expect(candidate.observations.every(row => row.review === null)).toBe(true);
    expect(invoke(...args).exitCode).toBe(2);
    expect(await Bun.file(join(output, "candidate.json")).text()).toBe(candidateBytes);
    expect(invoke(...args, "--reference", "answers.json").exitCode).toBe(2);
    const missing = join(directory, "missing");
    expect(invoke(...args.slice(0, -2), "--out", missing, "--room-key", "not-on-this-page").exitCode).toBe(0);
    const selected = await Bun.file(join(missing, "candidate.json")).json();
    expect(selected.observations[0]).toMatchObject({ id: "room:1/not-on-this-page:area", outcome: "blocked", value: null, evidence: [] });
    expect((await Bun.file(join(missing, "execution.json")).json()).includedRooms).toBe(5);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
