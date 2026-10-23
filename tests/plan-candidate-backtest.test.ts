import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syntheticPlanPdf } from "../richtfest-apps/projects/src/test-fixtures/synthetic-plan";
import { buildingBacktestCandidateSchema } from "../richtfest-apps/knowledge/src/building-backtest";
import { acousticNormPackSchema } from "../richtfest-shared/src/acoustic-norm-pack";

// Deliberately invented numbers, not licensed content or expected engineering answers.
// This is a real schema-valid CLI pack, not a mocked calculation host.
const term = { fromPct: 0, gradientDivisor: 1, constant: 0, speedFactor: 0, speedCapKmh: null, speedDivisor: 1 };
const massLaw = { slope: 1, intercept: 0, minKgM2: 1, maxKgM2: 1000, minInclusive: true, maxInclusive: true, ref: "synthetic" };
const syntheticPack = acousticNormPackSchema.parse({
  id: "synthetic-cli-not-a-standard",
  rls19: {
    edition: "synthetic", sourceHeightM: 1,
    emission: { car: { a: 1, b: 1, c: 1 }, truck1: { a: 1, b: 1, c: 1 }, truck2: { a: 1, b: 1, c: 1 } },
    speed: { minimumKmh: 1, unrestrictedCarKmh: 1, truckCapKmh: { motorway: 1, other: 1 } },
    standardTraffic: {}, surfaces: {}, referenceSurface: "mastic_asphalt",
    gradient: { clampPct: 1, car: { downhill: term, uphill: term }, truck1: { downhill: term, uphill: term }, truck2: { downhill: term, uphill: term } },
    sourceLineLanes: { offsets: [0], manyLanesFromOuter: 0 },
    propagation: { divergenceConstantDb: 0, airAbsorptionDivisorM: 1, ground: { maxDb: 0, heightFactor: 0, distanceTermM: 0 } },
  },
  din4109: { edition: "synthetic", exteriorLevelAdditionDb: 0, nightSurchargeDb: 0, railReductionDb: 0, turnedAwayReductionDb: { open: 0, closed: 0 } },
  din4109_32: {
    edition: "synthetic", masonryWallDensity: [{ mortar: "normal", factor: 1, offset: 0, minRdk: 0, maxRdk: 10, minExclusive: false, ref: "synthetic" }],
    concreteDensityKgM3: { plain: 1, reinforced: 1 }, massLaws: { dense: [massLaw], lightweight_concrete: [massLaw], aerated_concrete: [massLaw] },
    perforated: { maxThicknessMm: 1, clayMinRdkAboveMaxThickness: 1, blockMinRdk: 1 }, roundingDecimals: 1,
  },
  din4109_interior: {
    editions: { requirements: "synthetic", method: "synthetic", junctions: "synthetic", screeds: "synthetic" },
    requirements: { walls: { apartment_partition: { rwMinDb: 1, ref: "synthetic" } }, ceilings: {} },
    airborne: {
      referenceLengthM: 1, referenceAbsorptionM2: 1, minSeparatingAreaM2: 1, labEdgeLengthM: { horizontal: 1, vertical: 1 },
      tJunction: { k12: { constant: 0, square: 0 }, k13: { breakM: 0, below: { constant: 0, linear: 0, square: 0 }, above: { constant: 0, linear: 0 } } },
      uncertaintyDb: 0, refs: { total: "synthetic", direct: "synthetic", flanking: "synthetic", kijMin: "synthetic", dnw: "synthetic", lightweight: "synthetic", junction: "synthetic", uncertainty: "synthetic" },
    },
    impact: {
      bareSlab: { constant: 0, slope: 0, minKgM2: 1, maxKgM2: 1000, ref: "synthetic" },
      flanking: { constant: 0, slope: 0, minSlabKgM2: 1, maxSlabKgM2: 1000, minFlankingKgM2: 1, maxFlankingKgM2: 1000, ref: "synthetic" },
      screeds: {}, uncertaintyDb: 0, refs: { total: "synthetic", uncertainty: "synthetic" },
    },
    roundingDecimals: 1,
  },
});

// Three independently labelled apartments, each a 4 × 4 m cell. Two shared
// 20 cm walls make the both-selected rule observable (the standard fixture is
// one apartment, so its internal partitions correctly have no acoustic checks).
function threeApartmentPdf() {
  const k = 72 / 25.4 * 10;
  const rect = (x: number, y: number, w: number, h: number) => `${100 + x * k} ${100 + y * k} ${w * k} ${h * k} re f`;
  const text = (label: string, x: number, y: number) => `BT /F1 9 Tf ${100 + x * k} ${100 + y * k} Td (${label}) Tj ET`;
  const stream = [
    "/OC /fill BDC 0.9 g", ...[0, 4.2, 8.4].map(x => rect(x, 0, 4, 4) + "*"), "EMC",
    "/OC /wall BDC 0.25 g", rect(-0.2, -0.2, 12.8, 0.2), rect(-0.2, 4, 12.8, 0.2),
    ...[-0.2, 4, 8.2, 12.4].map(x => rect(x, 0, 0.2, 4)), "EMC",
    "/OC /label BDC 0 g", ...[0, 4.2, 8.4].flatMap((x, i) => [text("Wohnen", x + 1, 2.5), text("16,00 m\\262", x + 1, 2), text(`WE ${i + 1}`, x + 1, 1)]),
    text("M 1:100", 14, 0), "EMC",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R 7 0 R 8 0 R] /D << /ON [6 0 R 7 0 R 8 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 700] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /Properties << /wall 6 0 R /fill 7 0 R /label 8 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /OCG /Name (Konstruktion) >>", "<< /Type /OCG /Name (F\\374llfl\\344chen) >>", "<< /Type /OCG /Name (Beschriftung) >>",
  ];
  let pdf = "%PDF-1.6\n";
  const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(pdf); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

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
    expect(preview.exterior.batch.inventory.map((room: any) => room.roomId).sort()).toEqual(["Schlafen", "Wohnen"]);
    expect(preview.exterior.batch.rooms).toEqual([]);
    const acousticBytes = await Bun.file(join(output, "acoustics.json")).text();
    const acoustic = JSON.parse(acousticBytes);
    expect(acoustic).toMatchObject({ reviewStatus: "unreviewed", acousticPack: null, interiorMethodAvailable: false });
    expect(acoustic.exterior.batch.complete).toBe(false);
    expect(acoustic.exterior.batch.rooms).toHaveLength(2);
    expect(acoustic.exterior.batch.rooms.every((room: any) => room.status === "missing_input" && room.result === null)).toBe(true);
    expect(candidate.observations.find(row => row.id === "interior:provided")?.outcome).toBe("unsupported");
    expect(candidate.artifacts.find(row => row.id === "acoustics")!.sha256).toBe(createHash("sha256").update(acousticBytes).digest("hex"));
    const concept = await Bun.file(join(output, "noise-concept.md")).text();
    expect(concept).toContain("0/2 inventarisierte Räume berechenbar");
    expect(concept).toContain("kein freigegebener Nachweis");
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
    expect(await Bun.file(join(missing, "acoustics.json")).json()).toMatchObject({
      missingRoomKeys: ["not-on-this-page"], exterior: null, rooms: [], geometry: [],
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);

test("configured CLI keeps missing project facts blocked and scopes both sides of interior checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-candidate-pack-"));
  const script = resolve(import.meta.dir, "../scripts/run-plan-candidate-backtest.ts");
  try {
    const source = join(directory, "plan.pdf"), packPath = join(directory, "pack.json");
    await Bun.write(source, threeApartmentPdf());
    const packBytes = JSON.stringify(syntheticPack);
    await Bun.write(packPath, packBytes);
    const invoke = (output: string, ...args: string[]) => Bun.spawnSync([process.execPath, script,
      "--source", source, "--page", "1", "--case-id", "synthetic-pack", "--acoustic-pack", packPath, "--out", output, ...args]);
    const full = join(directory, "full");
    expect(invoke(full).exitCode).toBe(0);
    const acoustic = await Bun.file(join(full, "acoustics.json")).json();
    const candidate = buildingBacktestCandidateSchema.parse(await Bun.file(join(full, "candidate.json")).json());
    expect(acoustic).toMatchObject({ interiorMethodAvailable: true, interiorMethodBlocker: null, missingRoomKeys: [], unavailableRoomKeys: [],
      acousticPack: { id: syntheticPack.id, sha256: createHash("sha256").update(packBytes).digest("hex"), interiorAvailable: true } });
    expect(acoustic.geometry).toHaveLength(3);
    for (const room of acoustic.geometry) expect(room.areaM2).toBeCloseTo(16, 1);
    expect(acoustic.geometry.every((room: any) => room.clearHeight === null)).toBe(true);
    // The drawing has partitions, but no room heights, materials or installed ratings.
    expect(acoustic.interior.length).toBeGreaterThan(0);
    expect(acoustic.interior.every((wall: any) => wall.result === null && wall.areaM2 === null && wall.gaps.some((gap: any) => gap.code === "clear_height"))).toBe(true);
    expect(acoustic.exterior.batch.rooms).toHaveLength(3);
    expect(acoustic.exterior.batch.rooms.every((room: any) => room.status === "missing_input" && room.result === null)).toBe(true);
    expect(candidate.observations.find(row => row.id === "interior:provided")).toMatchObject({ outcome: "blocked", value: null });
    expect(candidate.observations.every(row => row.review === null)).toBe(true);
    const extraction = await Bun.file(join(full, "extraction.json")).json();
    const firstKey = extraction.labels.find((room: any) => room.geometry.groupLabel === "WE 1").sourceKey;
    const secondKey = extraction.labels.find((room: any) => room.geometry.groupLabel === "WE 2").sourceKey;
    for (const [name, keys] of [["one", [firstKey]], ["pair", [firstKey, secondKey]]] as const) {
      const output = join(directory, name);
      expect(invoke(output, ...keys.flatMap(key => ["--room-key", key]), "--room-key", "missing").exitCode).toBe(0);
      const scoped = await Bun.file(join(output, "acoustics.json")).json();
      expect(scoped.geometry).toHaveLength(keys.length);
      expect(scoped.missingRoomKeys).toEqual(["missing"]);
      expect(scoped.exterior.batch.rooms).toHaveLength(keys.length);
      expect(scoped.exterior.batch.rooms.every((room: any) => room.status === "missing_input" && room.result === null)).toBe(true);
      if (name === "one") expect(scoped.interior).toEqual([]);
      else {
        expect(scoped.interior).toHaveLength(1);
        expect(scoped.interior[0].rooms.map((room: any) => room.id).sort()).toEqual(scoped.geometry.map((room: any) => room.id).sort());
      }
      expect((await Bun.file(join(output, "preview.json")).json()).preview.geometry).toHaveLength(3);
      const bytes = await Bun.file(join(output, "acoustics.json")).text();
      expect(bytes).not.toContain('"massLaws"');
      expect(bytes).not.toContain('"tJunction"');
      const selected = buildingBacktestCandidateSchema.parse(await Bun.file(join(output, "candidate.json")).json());
      expect(selected.observations.find(row => row.id === "room:1/missing:area")).toMatchObject({ outcome: "blocked", value: null, evidence: [] });
      expect(selected.observations.find(row => row.id === "interior:provided")?.calculation?.outputSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    const { din4109_interior: _interior, ...partialPack } = syntheticPack;
    await Bun.write(packPath, JSON.stringify(partialPack));
    const partial = join(directory, "partial");
    expect(invoke(partial).exitCode).toBe(0);
    expect(await Bun.file(join(partial, "acoustics.json")).json()).toMatchObject({ interiorMethodAvailable: false, interiorMethodBlocker: "interior_or_massive_catalogue_missing", interior: [] });
    expect((await Bun.file(join(partial, "candidate.json")).json()).observations.find((row: any) => row.id === "interior:provided").outcome).toBe("unsupported");
    // A supplied empty/malformed pack must fail closed, not silently become unconfigured.
    for (const [name, bytes] of [["empty", ""], ["invalid", '{"private":"do-not-log"}']]) {
      await Bun.write(packPath, bytes!);
      const failed = invoke(join(directory, name!));
      expect(failed.exitCode).toBe(2);
      expect(failed.stderr.toString()).not.toContain("do-not-log");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 180_000);
