import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { PDFDocument } from "pdf-lib";
import { evaluateBuildingBacktest } from "./building-backtest";
import { fireBacktestHash, fireBacktestJson, firePlanBacktestSchema, runFirePlanBacktest } from "./fire-plan-backtest";

type Plan = z.infer<typeof firePlanBacktestSchema>;
const rectangle = (width: number, height: number, x = 0) => [{ x, y: 0 }, { x: x + width, y: 0 }, { x: x + width, y: height }, { x, y: height }];
function fixture(): Plan {
  const evidence = [{ kind: "page" as const, sourceId: "plan.pdf", page: 1 }];
  return {
    version: 1, caseId: "synthetic-fire", sources: [{ id: "plan.pdf", format: "pdf", sha256: "a".repeat(64) }], runIds: [],
    building: { evidence, input: { state: "RP", height: 10, detached: false, dwellings: 3, otherUnits: 0,
      usableArea: 600, largestUnitArea: 401, unitsGrossArea: 600, storeysAboveGround: 4, specialUse: "none", garageArea: 0 },
      fullStoreys: 4, smokeVent: "top_opening", garageEnclosure: null },
    storeys: [{ id: "EG", evidence, geometryReviewed: true,
      rooms: [
        { id: "living", role: "habitable", unit: "A", basement: false, roomUse: "living", smokeVent: null, polygon: rectangle(6, 8) },
        { id: "stairs", role: "necessary_stairwell", unit: null, basement: false, roomUse: "stairs", smokeVent: null, polygon: rectangle(2, 8, -2) },
        { id: "isolated", role: "habitable", unit: "B", basement: false, roomUse: "living", smokeVent: null, polygon: rectangle(3, 4, 20) },
      ],
      walls: [{ id: "stair-wall", basement: false, loadBearing: false, actual: "hf",
        faces: [{ exterior: false, roomIds: ["living"] }, { exterior: false, roomIds: ["stairs"] }] }],
      ceilings: [{ id: "slab", basement: false, actual: null }],
      doors: [{ id: "entry", point: { x: 0, y: 0 }, rooms: ["living", "stairs"], actual: "DS" }],
    }, { id: "OG", evidence: [{ ...evidence[0]!, page: 2 }], geometryReviewed: true,
      rooms: [{ id: "long", role: "habitable", unit: "C", basement: false, roomUse: "living", smokeVent: null, polygon: rectangle(36, 3) }],
      walls: [], ceilings: [], doors: [{ id: "exit", point: { x: 0, y: 0 }, rooms: ["long", null], actual: null }],
    }],
  };
}

// Independently specified answers: 6-8-10 triangle; sqrt(36² + 3²) = 36.12478…;
// LBauO RP GK4, Treppenraumwand hf+M, top-opening stairwell T30-RS, slab hf.
// The reference's isolated room has an exit at (20, 0), deliberately omitted
// from the candidate snapshot. Its 3-4-5 route must fail until that door exists.
// No values or check IDs are copied from engine output.
function reference(plan: Plan, version: string) {
  const answers: Array<[string, string | number | boolean | null, string | null]> = [
    ["building:class", 4, null], ["building:deliverable", "konzept", null], ["building:review", "psv", null],
    ["component:EG/stair-wall:required", "hf_m", null], ["component:EG/stair-wall:status", "not_met", null],
    ["component:EG/slab:required", "hf", null], ["component:EG/slab:status", "open", null],
    ["component:EG/entry:required", "T30_RS", null], ["component:EG/entry:status", "not_met", null],
    ["component:OG/exit:required", "none", null], ["component:OG/exit:status", "none", null],
    ["route:EG/living:length", 10, "m"], ["route:EG/living:withinLimit", true, null],
    ["route:EG/isolated:length", 5, "m"], ["route:EG/isolated:withinLimit", true, null],
    ["route:OG/long:length", 36.12, "m"], ["route:OG/long:withinLimit", false, null],
    ["building:water", 1600, "l/min"],
    ["scope:second-escape-route", true, null], ["scope:fire-brigade-access", true, null], ["scope:garage-components", true, null],
    ["fire-concept", null, null],
  ];
  return { version: 1, caseId: plan.caseId, split: "synthetic", sources: plan.sources, review: null,
    checks: answers.map(([id, expectedValue, unit]) => ({ id, expectedValue, unit, stage: id === "fire-concept" ? "concept" : "fire",
      description: `Synthetic contract: ${id}`, critical: true, expectedOutcome: "complete", tolerance: 0,
      evidenceRequired: true, tool: { name: "richtfest-fire-protection", version }, humanReviewRequired: id === "fire-concept" })) };
}
const observation = (result: ReturnType<typeof runFirePlanBacktest>, id: string) => result.candidate.observations.find(item => item.id === id)!;

test("fire replay scores independent multi-storey answers and retains unreachable, unsupported and unreviewed checks", () => {
  const plan = fixture(), result = runFirePlanBacktest(plan, "test-engine");
  const score = evaluateBuildingBacktest(reference(plan, "test-engine"), result.candidate);
  expect(score.unexpectedIds).toEqual([]);
  expect(score.rows).toHaveLength(22);
  expect(score.rows.filter(row => row.passed)).toHaveLength(16);
  expect(score.criticalFailures).toEqual(["route:EG/isolated:length", "route:EG/isolated:withinLimit",
    "scope:second-escape-route", "scope:fire-brigade-access", "scope:garage-components", "fire-concept"]);
  expect(score.benchmarkEligible).toBe(false);
  expect(observation(result, "route:EG/isolated:length").outcome).toBe("blocked");
  expect(observation(result, "fire-concept").review).toBeNull();
  expect(result.concept).toContain("UNREVIEWED DRAFT");
  expect(result.concept).toContain("route:EG/isolated:length: blocked");
  const assessment = JSON.parse(result.assessmentBytes);
  expect(assessment.routes.map((route: { storeyId: string; roomId: string; length: number }) => [route.storeyId, route.roomId, route.length]))
    .toEqual([["EG", "living", 10], ["OG", "long", 36.12]]);
  expect(result.candidate.artifacts[0]!.sha256).toBe(fireBacktestHash(result.assessmentBytes));
  expect(observation(result, "building:class").calculation?.inputSha256).toBe(fireBacktestHash(result.inputBytes));

  // Correct the deliberately missing source connection, not the expected length.
  plan.storeys[0]!.doors[0]!.rooms = ["living", null];
  plan.storeys[0]!.doors.push({ id: "missing-exit", point: { x: 20, y: 0 }, rooms: ["isolated", null], actual: null });
  const corrected = runFirePlanBacktest(plan, "test-engine");
  expect(observation(corrected, "route:EG/isolated:length")).toMatchObject({ outcome: "complete", value: 5 });
  // Changing a connection also changes the door requirement; no stale assessment is reused.
  expect(observation(corrected, "component:EG/entry:required").value).toBe("none");
  expect(observation(corrected, "fire-concept").review).toBeNull();
});

test("jurisdiction and incomplete inputs cannot produce fallback approvals", () => {
  const plan = fixture();
  plan.building.input.state = "BE";
  const berlin = runFirePlanBacktest(plan, "test-engine");
  expect(observation(berlin, "building:class").value).toBe(5); // 401 m², not RP's GK4.
  expect(observation(berlin, "component:EG/stair-wall:required").value).toBe("fb_nb_m");
  plan.building.input.state = "NW";
  const unsupported = runFirePlanBacktest(plan, "test-engine");
  expect(unsupported.concept).toBeNull();
  expect(observation(unsupported, "component:EG/stair-wall:required")).toMatchObject({ value: null, outcome: "unsupported" });
  plan.building.input.state = "RP";
  plan.building.input.height = null;
  expect(observation(runFirePlanBacktest(plan, "test-engine"), "building:class").outcome).toBe("blocked");
  plan.building.input.height = 10;
  plan.building.smokeVent = null;
  expect(observation(runFirePlanBacktest(plan, "test-engine"), "component:EG/entry:required").outcome).toBe("blocked");
});

test("missing scale review, unknown connections and IFC routes stay blocked without erasing rooms", () => {
  for (const change of [
    (plan: Plan) => { plan.storeys[0]!.geometryReviewed = false; },
    (plan: Plan) => { plan.storeys[0]!.rooms[0]!.polygon = null; },
    (plan: Plan) => { plan.storeys[0]!.doors[0]!.rooms = null; },
  ]) {
    const plan = fixture(); change(plan);
    expect(observation(runFirePlanBacktest(plan, "test-engine"), "route:EG/living:length")).toMatchObject({ outcome: "blocked", value: null });
  }
  const ifc = fixture();
  ifc.sources.push({ id: "model.ifc", format: "ifc", sha256: "b".repeat(64) });
  ifc.storeys[0]!.evidence = [{ kind: "ifc", sourceId: "model.ifc", expressId: 42, attribute: "Representation" }];
  expect(observation(runFirePlanBacktest(ifc, "test-engine"), "route:EG/living:length").outcome).toBe("unsupported");
  const malformed = fixture();
  malformed.storeys[0]!.doors[0]!.rooms = ["living", "invented-exit"];
  expect(() => runFirePlanBacktest(malformed, "test-engine")).toThrow();
});

test("CLI verifies source bytes, saves reproducible receipts, scores failures and never overwrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fire-replay-"));
  const script = resolve(import.meta.dir, "../../../scripts/run-fire-plan-backtest.ts");
  const scoreScript = resolve(import.meta.dir, "../../../scripts/evaluate-building-backtest.ts");
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("Synthetic fire replay input, page 1. Geometry supplied separately; no extraction tested.");
    pdf.addPage().drawText("Synthetic fire replay input, page 2.");
    const bytes = await pdf.save();
    const plan = fixture(); plan.sources[0]!.sha256 = fireBacktestHash(bytes);
    const input = join(directory, "plan.json"), source = join(directory, "plan.pdf"), out = join(directory, "output");
    await Bun.write(input, fireBacktestJson(plan)); await Bun.write(source, bytes);
    const run = (target = out) => Bun.spawnSync([process.execPath, script, "--input", input, "--source", source, "--out", target]);
    const first = run(); expect(first.exitCode).toBe(0);
    const candidatePath = join(out, "candidate.json"), candidate = await Bun.file(candidatePath).json();
    const execution = await Bun.file(join(out, "execution.json")).json();
    expect(execution).toMatchObject({ modelExecution: false, sourceBytesVerified: true });
    const receipt = candidate.observations[0].calculation;
    expect(receipt.inputSha256).toBe(fireBacktestHash(await Bun.file(join(out, "input.json")).text()));
    expect(receipt.outputSha256).toBe(fireBacktestHash(await Bun.file(join(out, "assessment.json")).text()));
    expect((await stat(candidatePath)).mode & 0o777).toBe(0o600);
    const expected = join(directory, "reference.json");
    await Bun.write(expected, fireBacktestJson(reference(plan, execution.engineVersion)));
    const score = Bun.spawnSync([process.execPath, scoreScript, "--reference", expected, "--candidate", candidatePath]);
    expect(score.exitCode).toBe(1);
    expect(JSON.parse(score.stdout.toString()).criticalFailures).toHaveLength(6);
    const original = await Bun.file(candidatePath).text();
    expect(run().exitCode).toBe(2);
    expect(await Bun.file(candidatePath).text()).toBe(original);
    await Bun.write(source, "changed source revision");
    const rejected = join(directory, "rejected");
    expect(run(rejected).exitCode).toBe(2);
    expect(await Bun.file(join(rejected, "candidate.json")).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
