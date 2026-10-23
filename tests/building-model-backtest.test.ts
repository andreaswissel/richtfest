import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acousticNormPackSchema } from "../richtfest-shared/src/acoustic-norm-pack";
import { buildingBacktestCandidateSchema } from "../richtfest-apps/knowledge/src/building-backtest";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const root = resolve(import.meta.dir, "..");
// All coefficients below are invented public test data, never a licensed pack.
const term = { fromPct: 0, gradientDivisor: 1, constant: 0, speedFactor: 0, speedCapKmh: null, speedDivisor: 1 };
const law = { slope: 1, intercept: 0, minKgM2: 1, maxKgM2: 1000, minInclusive: true, maxInclusive: true, ref: "synthetic" };
const pack = acousticNormPackSchema.parse({
  id: "synthetic-building-cli",
  rls19: { edition: "synthetic", sourceHeightM: 1,
    emission: { car: { a: 1, b: 1, c: 1 }, truck1: { a: 1, b: 1, c: 1 }, truck2: { a: 1, b: 1, c: 1 } },
    speed: { minimumKmh: 1, unrestrictedCarKmh: 1, truckCapKmh: { motorway: 1, other: 1 } },
    standardTraffic: {}, surfaces: {}, referenceSurface: "mastic_asphalt",
    gradient: { clampPct: 1, car: { downhill: term, uphill: term }, truck1: { downhill: term, uphill: term }, truck2: { downhill: term, uphill: term } },
    sourceLineLanes: { offsets: [0], manyLanesFromOuter: 0 },
    propagation: { divergenceConstantDb: 0, airAbsorptionDivisorM: 1, ground: { maxDb: 0, heightFactor: 0, distanceTermM: 0 } } },
  din4109: { edition: "synthetic", exteriorLevelAdditionDb: 0, nightSurchargeDb: 0, railReductionDb: 0, turnedAwayReductionDb: { open: 0, closed: 0 } },
  din4109_32: { edition: "synthetic", masonryWallDensity: [{ mortar: "normal", factor: 1, offset: 0, minRdk: 0, maxRdk: 10, minExclusive: false, ref: "synthetic" }],
    concreteDensityKgM3: { plain: 1, reinforced: 1 }, massLaws: { dense: [law], lightweight_concrete: [law], aerated_concrete: [law] },
    perforated: { maxThicknessMm: 1, clayMinRdkAboveMaxThickness: 1, blockMinRdk: 1 }, roundingDecimals: 1 },
  din4109_interior: {
    editions: { requirements: "synthetic", method: "synthetic", junctions: "synthetic", screeds: "synthetic" },
    requirements: { walls: {}, ceilings: {}, doors: { to_dwelling_hallway: { rwMinDb: 30, ref: "synthetic" } } },
    door: { uncertaintyDb: 4, ref: "synthetic" },
    airborne: { referenceLengthM: 1, referenceAbsorptionM2: 1, minSeparatingAreaM2: 1, labEdgeLengthM: { horizontal: 1, vertical: 1 },
      tJunction: { k12: { constant: 0, square: 0 }, k13: { breakM: 0, below: { constant: 0, linear: 0, square: 0 }, above: { constant: 0, linear: 0 } } },
      uncertaintyDb: 0, refs: { total: "synthetic", direct: "synthetic", flanking: "synthetic", kijMin: "synthetic", dnw: "synthetic", lightweight: "synthetic", junction: "synthetic", uncertainty: "synthetic" } },
    impact: { bareSlab: { constant: 0, slope: 0, minKgM2: 1, maxKgM2: 1000, ref: "synthetic" },
      flanking: { constant: 0, slope: 0, minSlabKgM2: 1, maxSlabKgM2: 1000, minFlankingKgM2: 1, maxFlankingKgM2: 1000, ref: "synthetic" },
      screeds: {}, uncertaintyDb: 0, refs: { total: "synthetic", uncertainty: "synthetic" } }, roundingDecimals: 1 },
});

function pdf() {
  const streams = ["20 50 60 30 re S\n20 80 60 2 re f", "10 50 30 30 re S\n10 80 30 2 re f"];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    ...streams.flatMap((stream, i) => [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${i ? 100 : 200} 100] /Contents ${i ? 6 : 4} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`])];
  let bytes = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(bytes.length); bytes += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = bytes.length;
  return bytes + `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
const ifc = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('synthetic'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
const source = (page: number) => ({ kind: "page", sourceVersionId: id(90), page });
const rectangle = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
function fixture(): any {
  let next = 200;
  const property = (entityId: string, propertyKey: string, value: unknown, page = 1) => ({ id: id(next++), entityId, propertyKey,
    current: { version: 1, reviewRevision: 0, reviewStatus: "unreviewed", provenance: "extracted", value, evidence: [source(page)] }, reviewed: null });
  const storeys = [0, 1].map(i => ({ id: id(2 + i), buildingId: id(1), name: i ? "Upper" : "Ground", levelIndex: i, constructionState: "existing" }));
  const rooms = storeys.map((s, i) => ({ id: id(10 + i), storeyId: s.id, name: `Room ${i + 1}`, constructionState: "existing",
    geometry: { source: source(i + 1), polygon: rectangle(.1, .2, .3, .3) } }));
  const walls = storeys.map((s, i) => ({ id: id(20 + i), buildingId: id(1), storeyId: s.id, roomId: null, kind: "draft_wall", name: `Wall ${i + 1}`, constructionState: "existing",
    geometry: { source: source(i + 1), polygon: rectangle(.1, .18, .3, .02) } }));
  const door = { id: id(30), buildingId: id(1), storeyId: id(2), roomId: id(10), kind: "door", name: "Entrance", constructionState: "existing" };
  const scales = [{ pageAspectRatio: 2, metresPerPageHeight: 10, denominator: 100 }, { pageAspectRatio: 1, metresPerPageHeight: 20, denominator: 200 }];
  const relationships = walls.flatMap((wall, i) => [
    { id: id(next++), fromEntityId: wall.id, toEntityId: rooms[i]!.id, relationshipType: "separates", reviewStatus: "unreviewed", metadata: { side: 0 } },
    { id: id(next++), fromEntityId: wall.id, toEntityId: id(1), relationshipType: "faces_exterior", reviewStatus: "unreviewed", metadata: { side: 1 } },
  ]);
  relationships.push({ id: id(next++), fromEntityId: door.id, toEntityId: walls[0]!.id, relationshipType: "opening_in", reviewStatus: "unreviewed", metadata: { side: 0 } });
  const check = (kind: string, resultId: string, entityIds: string[], unit: string | null) => ({ id: `${kind}:${resultId}`, kind, resultId, entityIds, unit });
  return { schema: "richtfest-building-model-backtest", version: 1, caseId: "two-storey-synthetic", runIds: [],
    sources: [{ id: "original.pdf", versionId: id(90), sha256: digest(pdf()), format: "pdf" }, { id: "model.ifc", versionId: id(91), sha256: digest(ifc), format: "ifc" }],
    model: { model: { id: id(99), revision: 7 }, buildings: [{ id: id(1), name: "Building", constructionState: "existing" }], storeys, rooms, elements: [...walls, door], relationships,
      properties: [property(door.id, "doorRole", "to_dwelling_hallway"), property(door.id, "soundReductionIndex", 42.7), property(door.id, "soundReductionIndexBasis", "Synthetic test declaration"),
        ...storeys.map((s, i) => property(s.id, "clearRoomHeight", 2.5 + i, i + 1)), ...rooms.map((r, i) => property(r.id, "exteriorNoiseRoom", "living", i + 1))],
      conflicts: [], planSources: storeys.map((s, i) => ({ storeyId: s.id, sourceVersionId: id(90), page: i + 1, alignmentStatus: "reviewed" })),
      extractions: storeys.map((s, i) => ({ id: id(70 + i), storeyId: s.id, sourceVersionId: id(90), page: i + 1, status: "complete", updatedAt: "2026-10-22T00:00:00Z",
        result: { pageScale: scales[i], scaleObservation: { status: "confirmed" } } })) },
    pages: storeys.map((s, i) => ({ sourceVersionId: id(90), page: i + 1, fileName: "original.pdf", storey: { id: s.id, name: s.name, levelIndex: s.levelIndex }, scale: scales[i],
      walls: [{ id: walls[i]!.id, name: walls[i]!.name, exterior: true, ring: walls[i]!.geometry.polygon.map(p => [p.x * scales[i]!.pageAspectRatio * scales[i]!.metresPerPageHeight, p.y * scales[i]!.metresPerPageHeight]) }] })),
    scope: { buildingId: id(1), storeyIds: storeys.map(s => s.id), roomIds: rooms.map(r => r.id), elementIds: [...walls.map(w => w.id), door.id] },
    fireMode: "candidate_preview", exterior: { enabled: false, levels: [] },
    checks: [check("interior_door", door.id, [door.id, rooms[0]!.id], "dB"), check("exterior_room", rooms[0]!.id, [rooms[0]!.id], "dB"),
      check("exterior_room", rooms[1]!.id, [rooms[1]!.id], "dB"), check("fire", "building:class", [id(1)], null),
      check("interior_ceiling_impact", "missing-slab", [rooms[1]!.id], "dB"), check("whole_building", "completeness", [id(1)], null)] };
}

async function clean(path: string) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await clean(join(path, entry.name));
  await rm(path, { recursive: true, force: true });
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "building-replay-"));
  await Bun.write(join(directory, "original.pdf"), pdf()); await Bun.write(join(directory, "model.ifc"), ifc);
  await Bun.write(join(directory, "pack.json"), JSON.stringify(pack));
  const run = async (input: any, name: string, withPack = true) => {
    await Bun.write(join(directory, "dossier.json"), JSON.stringify(input));
    const args = [process.execPath, "scripts/run-building-model-backtest.ts", "--input", join(directory, "dossier.json"),
      "--source", join(directory, "original.pdf"), "--source", join(directory, "model.ifc"), "--out", join(directory, name),
      ...(withPack ? ["--acoustic-pack", join(directory, "pack.json")] : [])];
    const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr, out: join(directory, name), read: (file: string) => Bun.file(join(directory, name, file)).json() };
  };
  return { directory, run };
}

describe("saved building model public offline CLI", () => {
  test("executes real interior engine, keeps asymmetric storeys, review blockers, sources and immutable receipts", async () => {
    const { directory, run } = await setup();
    try {
      const input = fixture(), result = await run(input, "run");
      expect(result.stderr).toBe(""); expect(result.code).toBe(0);
      const assessment = await result.read("assessment.json");
      expect(assessment.interior.available).toBe(true);
      const door = assessment.interior.doors[0];
      expect(door.result.status).toBe("calculated");
      // Independent arithmetic, not a second call to the engine under test.
      expect(door.result.marginDb).toBeCloseTo(42.7 - 4 - 30, 8);
      expect(door.result.meets).toBe(true);
      expect(assessment.exterior.map((p: any) => p.rooms[0].floorAreaM2)).toEqual([18, 36]);
      expect(assessment.exterior.map((p: any) => p.rooms[0].facades[0].areaM2)).toEqual([15, 21]);
      expect(assessment.fireSnapshot.plan.storeys.map((s: any) => s.geometryReviewed)).toEqual([false, false]);
      expect(assessment.exterior.every((p: any) => p.rooms[0].gaps.includes("facade_level"))).toBe(true);
      const candidate = buildingBacktestCandidateSchema.parse(await result.read("candidate.json"));
      expect(candidate.observations.map(o => o.id)).toEqual(input.checks.map((c: any) => c.id));
      expect(candidate.observations[0]).toMatchObject({ outcome: "blocked", value: 42.7, review: null });
      expect(candidate.observations.find(o => o.id.includes("missing-slab"))).toMatchObject({ outcome: "blocked", value: null });
      expect(candidate.observations.at(-1)).toMatchObject({ outcome: "unsupported", value: null });
      const receipt = await result.read("execution.json");
      expect(receipt).toMatchObject({ providerCalls: 0, networkCalls: 0, databaseCalls: 0, savedModelInputs: true, wholeBuildingCompleteness: false });
      expect(receipt.acousticPack).toEqual({ id: pack.id, sha256: digest(JSON.stringify(pack)) });
      expect(receipt.codeHashes.some((c: any) => c.path.endsWith("interior-sound-proof.ts"))).toBe(true);
      for (const file of (await result.read("manifest.json")).files) {
        expect(digest(await Bun.file(join(result.out, file.path)).bytes())).toBe(file.sha256);
        expect((await stat(join(result.out, file.path))).mode & 0o777).toBe(0o400);
      }
      expect((await stat(result.out)).mode & 0o777).toBe(0o500);
      expect(await Bun.file(join(result.out, "sources/original.pdf")).text()).toBe(pdf());
      expect(await Bun.file(join(result.out, "sources/model.ifc")).text()).toBe(ifc);
      const before = digest(await Bun.file(join(result.out, "candidate.json")).bytes());
      expect((await run(input, "run")).code).toBe(2);
      expect(digest(await Bun.file(join(result.out, "candidate.json")).bytes())).toBe(before);
      expect(await Bun.file(join(result.out, "pack.json")).exists()).toBe(false);
      const requestHash = digest(await Bun.file(join(result.out, "request.json")).bytes());
      expect(candidate.observations[0]!.calculation!.inputSha256).toBe(requestHash);
      expect(receipt.requestSha256).toBe(requestHash);
      const changedPack = structuredClone(pack);
      changedPack.din4109_interior!.door!.uncertaintyDb = 5;
      await Bun.write(join(directory, "pack.json"), JSON.stringify(changedPack));
      const changed = await run(input, "changed-pack"); expect(changed.code).toBe(0);
      expect((await changed.read("execution.json")).inputSha256).toBe(receipt.inputSha256);
      expect((await changed.read("execution.json")).requestSha256).not.toBe(requestHash);
      expect((await changed.read("assessment.json")).interior.doors[0].result.marginDb).toBeCloseTo(7.7, 8);
    } finally { await clean(directory); }
  });

  test("missing pack and project inputs preserve every declaration and both concept worksheets", async () => {
    const { directory, run } = await setup();
    try {
      const input = fixture(); input.model.properties = [];
      input.checks.push(...["fire", "noise"].map(name => ({ id: `${name}_concept:draft`, kind: `${name}_concept`, resultId: "draft", entityIds: [id(1)], unit: null })));
      const result = await run(input, "no-pack", false); expect(result.code).toBe(0);
      const candidate = await result.read("candidate.json");
      expect(candidate.observations).toHaveLength(input.checks.length);
      expect(candidate.observations[0]).toMatchObject({ outcome: "unsupported", value: null });
      for (const name of ["fire", "noise"]) {
        expect(await Bun.file(join(result.out, `${name}-concept.md`)).text()).toContain("unreviewed concept worksheet");
        expect(candidate.observations.find((o: any) => o.id === `${name}_concept:draft`))
          .toMatchObject({ outcome: "blocked", artifactId: `${name}-concept`, review: null });
        expect(candidate.artifacts.find((a: any) => a.id === `${name}-concept`).sha256)
          .toBe(digest(await Bun.file(join(result.out, `${name}-concept.md`)).bytes()));
      }
      const withPack = await run(input, "missing-inputs"); expect(withPack.code).toBe(0);
      expect((await withPack.read("candidate.json")).observations[0]).toMatchObject({ outcome: "blocked", value: null });
    } finally { await clean(directory); }
  });

  test("reviewed-first values, conflicts, rejections and scoped entities never borrow other facts", async () => {
    const { directory, run } = await setup();
    try {
      const input = fixture(), rw = input.model.properties.find((p: any) => p.propertyKey === "soundReductionIndex");
      rw.reviewed = { ...rw.current, reviewStatus: "approved" };
      rw.current = { ...rw.current, version: 2, value: 99, reviewStatus: "proposed" };
      const approved = await run(input, "approved"); expect(approved.code).toBe(0);
      expect((await approved.read("assessment.json")).interior.doors[0].rw.value).toBe(42.7);
      input.model.conflicts = [{ entityId: id(30), propertyKey: "soundReductionIndex" }];
      const conflict = await run(input, "conflict"); expect(conflict.code).toBe(0);
      expect((await conflict.read("assessment.json")).interior.doors[0].result).toBeNull();
      input.model.conflicts = []; rw.current.reviewStatus = "rejected";
      const rejectedProposal = await run(input, "rejected-proposal"); expect(rejectedProposal.code).toBe(0);
      expect((await rejectedProposal.read("assessment.json")).interior.doors[0].rw.value).toBe(42.7);
      rw.reviewed = null;
      input.model.relationships.find((r: any) => r.relationshipType === "opening_in").reviewStatus = "rejected";
      const rejected = await run(input, "rejected"); expect(rejected.code).toBe(0);
      expect((await rejected.read("assessment.json")).interior.doors[0]).toMatchObject({ rw: null, wall: null, result: null });
      input.scope.storeyIds = [id(2)]; input.scope.roomIds = [id(10)]; input.scope.elementIds = [id(20), id(30)];
      input.checks = input.checks.filter((c: any) => !c.entityIds.includes(id(11)));
      const scoped = await run(input, "scoped"); expect(scoped.code).toBe(0);
      const assessment = await scoped.read("assessment.json");
      expect(assessment.pages).toHaveLength(1); expect(assessment.exterior).toHaveLength(1);
      expect(assessment.fireSnapshot.plan.storeys).toHaveLength(1);
    } finally { await clean(directory); }
  });

  test("source-backed exterior levels execute the engine, but partial scoped envelopes remain blocked", async () => {
    const { directory, run } = await setup();
    try {
      const input = fixture();
      let next = 900;
      const add = (entityId: string, propertyKey: string, value: unknown) => input.model.properties.push({ id: id(next++), entityId, propertyKey,
        current: { version: 1, reviewRevision: 0, reviewStatus: "approved", provenance: "extracted", value, evidence: [source(1)] }, reviewed: null });
      add(id(1), "exteriorNoiseApplicability", "standard_exterior_noise"); add(id(1), "exteriorNoiseFlanking", "negligible");
      for (const n of [10, 11]) add(id(n), "exteriorSurfacesComplete", true);
      for (const n of [20, 21]) { add(id(n), "construction", "masonry"); add(id(n), "soundReductionIndex", 50); }
      add(id(30), "openingArea", 2);
      input.exterior = { enabled: true, levels: [20, 21].map((n, i) => ({ wallId: id(n), source: source(i + 1), dayDb: 60,
        sleepingDb: 65, compass: "N", basis: "calculated", reviewStatus: "unreviewed" })) };
      const result = await run(input, "exterior"); expect(result.code).toBe(0);
      const assessment = await result.read("assessment.json");
      const first = assessment.exterior[0].calculation.batch.rooms[0];
      expect(first.status).toBe("calculated");
      const expected = -10 * Math.log10(13 / 15 * 10 ** (-50 / 10) + 2 / 15 * 10 ** (-42.7 / 10));
      expect(first.result.value).toBeCloseTo(expected, 8);
      expect((await result.read("candidate.json")).observations[1]).toMatchObject({ outcome: "blocked", value: first.result.value });
      input.scope.elementIds = input.scope.elementIds.filter((v: string) => v !== id(30));
      input.checks = input.checks.filter((c: any) => !c.entityIds.includes(id(30)));
      const partial = await run(input, "partial"); expect(partial.code).toBe(0);
      const room = (await partial.read("assessment.json")).exterior[0].rooms[0];
      expect(room.gaps).toContain("surfaces_unconfirmed");
      expect((await partial.read("candidate.json")).observations[0]).toMatchObject({ outcome: "blocked", value: null });
    } finally { await clean(directory); }
  });

  test("scales traced opening spans on their own page without marking partial facades complete", async () => {
    const { directory, run } = await setup();
    try {
      const input = fixture();
      input.model.elements[0].geometry.polygon = rectangle(.1, .18, .1, .02);
      input.pages[0].walls[0].ring = input.model.elements[0].geometry.polygon.map((p: any) => [p.x * 20, p.y * 10]);
      input.model.elements[2].geometry = { source: source(1), polygon: rectangle(.2, .18, .1, .02) };
      input.fireMode = "reviewed";
      const result = await run(input, "opening"); expect(result.code).toBe(0);
      const assessment = await result.read("assessment.json");
      expect(assessment.exterior[0].rooms[0].facades[0].lengthM).toBe(4);
      expect(assessment.exterior[0].rooms[0].gaps).toContain("surfaces_unconfirmed");
      expect(assessment.exterior[1].rooms[0].facades[0].lengthM).toBe(6);
      expect(assessment.fireSnapshot.plan.storeys.map((s: any) => s.geometryReviewed)).toEqual([true, true]);
    } finally { await clean(directory); }
  });

  test("a service receiving-use default is not exported as a sourced calculation", async () => {
    const { directory, run } = await setup();
    try {
      const input = fixture(), serviceId = id(31);
      const servicePack = structuredClone(pack);
      servicePack.din4109_interior!.requirements.services = { sanitary: { living: { maxDb: 35, ref: "synthetic" } } };
      await Bun.write(join(directory, "pack.json"), JSON.stringify(servicePack));
      input.model.elements.push({ id: serviceId, buildingId: id(1), storeyId: id(2), roomId: id(10), kind: "installation", name: "Synthetic installation", constructionState: "existing" });
      input.scope.elementIds.push(serviceId);
      for (const [n, [propertyKey, value]] of Object.entries({ installationKind: "sanitary", installationProof: "level", serviceSoundLevel: 20 }).entries())
        input.model.properties.push({ id: id(900 + n), entityId: serviceId, propertyKey, current: { version: 1, reviewRevision: 0,
          reviewStatus: "unreviewed", provenance: "extracted", value, evidence: [source(1)] }, reviewed: null });
      input.checks.push({ id: `interior_service:${serviceId}`, kind: "interior_service", resultId: serviceId, entityIds: [serviceId], unit: "dB" });
      const result = await run(input, "service"); expect(result.code).toBe(0);
      const assessment = await result.read("assessment.json");
      expect(assessment.interior.services[0]).toMatchObject({ receivingUse: null, requirement: null, result: null });
      expect(assessment.replayBlockers).toContainEqual({ entityId: serviceId, reason: "service_receiving_use_missing" });
      expect((await result.read("candidate.json")).observations.at(-1)).toMatchObject({ outcome: "blocked", value: null });
    } finally { await clean(directory); }
  });

  test("rejects tampered sources, IDs, page mapping, scales, fabricated walls and undeclared input fields", async () => {
    const { directory, run } = await setup();
    try {
      const mutations: Array<(input: any) => void> = [
        i => i.sources[0].sha256 = "0".repeat(64), i => i.model.rooms[0].geometry.source.sourceVersionId = id(999),
        i => i.model.rooms[0].geometry.source.page = 2, i => i.pages[0].scale.pageAspectRatio = 1,
        i => i.pages[0].walls[0].ring[0][0] += 1, i => i.pages[0].storey.id = id(3),
        i => i.model.rooms.push(i.model.rooms[0]), i => i.sources[1].versionId = i.sources[0].versionId,
        i => i.model.relationships[0].toEntityId = id(999), i => i.reference = { answer: 42 },
        i => i.model.relationships.find((r: any) => r.relationshipType === "faces_exterior").toEntityId = id(3),
        i => i.pages[0].walls = [], i => i.checks = [],
        i => i.model.properties[1].current.value = "42.7",
        i => i.exterior = { enabled: true, levels: [{ wallId: id(20), dayDb: 60, sleepingDb: 60, compass: "N", basis: "calculated", reviewStatus: "approved" }] },
      ];
      for (const [n, mutate] of mutations.entries()) {
        const input = fixture(); mutate(input);
        const result = await run(input, `invalid-${n}`);
        expect(result.code, `mutation ${n}`).toBe(2);
        expect(result.stderr).not.toContain("answer");
        expect(await Bun.file(join(result.out, "candidate.json")).exists()).toBe(false);
      }
    } finally { await clean(directory); }
  }, 30000);
});
