import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { syntheticPlanPdf } from "../richtfest-apps/projects/src/test-fixtures/synthetic-plan";

const root = resolve(import.meta.dir, "..");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
async function clean(path: string) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await clean(join(path, entry.name));
  await rm(path, { recursive: true, force: true });
}
const declaration = () => ({ schema: "richtfest-building-model-preparation", version: 1, caseId: "fresh-asymmetric",
  building: { key: "building-a", name: "Building A" }, sources: [{ id: "original.pdf", pages: [
    { page: 1, buildingKey: "building-a", region: { x: 0, y: 0, width: 1, height: 1 }, storey: { key: "ground", name: "Ground", level: 0 }, scaleDenominator: 100 },
    { page: 2, buildingKey: "building-a", region: { x: 0, y: 0, width: 1, height: 1 }, storey: { key: "upper", name: "Upper", level: 1 }, scaleDenominator: 200 },
  ] }] });
function pdfObjects(objects: string[]) {
  let bytes = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(bytes, "latin1")); bytes += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(bytes, "latin1");
  return Buffer.from(bytes + `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1");
}
function asymmetricPdf() {
  const objects = (bytes: Uint8Array) => [...Buffer.from(bytes).toString("latin1").matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj/g)].map(m => m[1]!);
  const first = objects(syntheticPlanPdf({ unitFill: true }));
  const second = objects(syntheticPlanPdf({ scale: 200, page: [841.89, 1190.55], curvedBay: true }));
  // Share the fixture's identical font and OCG resources. pdfunite drops the second
  // source's OCG catalog, making its actual construction layer disappear to extraction.
  first[1] = "<< /Type /Pages /Kids [3 0 R 10 0 R] /Count 2 >>";
  first.push(second[2]!.replace("/Contents 4 0 R", "/Contents 11 0 R"), second[3]!);
  return pdfObjects(first);
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "prepare-building-"));
  await Bun.write(join(dir, "original.pdf"), asymmetricPdf());
  const prepare = async (config: unknown, name = "prepared") => {
    await Bun.write(join(dir, "mapping.json"), JSON.stringify(config));
    return command([process.execPath, "scripts/prepare-building-model-backtest.ts", "--config", join(dir, "mapping.json"),
      "--source", join(dir, "original.pdf"), "--out", join(dir, name)]);
  };
  const replay = (name = "prepared") => command([process.execPath, "scripts/run-building-model-backtest.ts", "--input", join(dir, name, "dossier.json"),
    "--source", join(dir, name, "sources/original.pdf"), "--out", join(dir, `${name}-replay`)]);
  const read = (file: string, name = "prepared") => Bun.file(join(dir, name, file)).json();
  return { dir, prepare, replay, read };
}

test("fresh asymmetric multi-page PDF is projected once per source/page and accepted by the unchanged strict replay CLI", async () => {
  const { dir, prepare, replay, read } = await setup();
  try {
    const original = await Bun.file(join(dir, "original.pdf")).bytes();
    expect(await prepare(declaration())).toMatchObject({ code: 0, stderr: "" });
    const dossier = await read("dossier.json"), extraction = await read("extractions.json"), receipt = await read("preparation.json");
    expect(dossier.sources[0].sha256).toBe(hash(original));
    expect(await Bun.file(join(dir, "prepared/sources/original.pdf")).bytes()).toEqual(original);
    expect(dossier.pages).toHaveLength(2);
    expect(dossier.pages[0].scale.pageAspectRatio).toBeGreaterThan(1);
    expect(dossier.pages[1].scale.pageAspectRatio).toBeLessThan(1);
    expect(dossier.pages.map((p: any) => p.scale.denominator)).toEqual([100, 200]);
    const rooms = dossier.model.storeys.map((s: any) => dossier.model.rooms.filter((r: any) => r.storeyId === s.id));
    expect(rooms[0].length).toBeGreaterThan(0); expect(rooms[1].length).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) {
      expect(rooms[i].every((r: any) => r.geometry.source.page === i + 1)).toBe(true);
      const room = rooms[i].find((r: any) => r.name === "Wohnen");
      expect(room).toBeDefined();
      const traced = extraction[i].candidates.find((c: any) => c.name === "Wohnen");
      expect(room.geometry.polygon).toEqual(traced.geometry.polygon);
      expect(traced.evidence[0].page).toBe(i + 1);
      expect(receipt.coverage[i].projectedIds).toContainEqual({ candidateId: traced.id, entityId: room.id });
    }
    expect(new Set(dossier.model.rooms.map((r: any) => r.id)).size).toBe(dossier.model.rooms.length);
    expect(rooms[0].find((r: any) => r.name === "Schlafen").geometry.polygon)
      .not.toEqual(rooms[1].find((r: any) => r.name === "Schlafen").geometry.polygon);
    expect(dossier.model.planSources.every((p: any) => p.alignmentStatus === "unreviewed")).toBe(true);
    expect(dossier.model.extractions.every((p: any) => p.result.scaleObservation.status === "unreviewed")).toBe(true);
    expect(dossier.model.properties.every((p: any) => !p.reviewed && p.current.reviewStatus === "unreviewed")).toBe(true);
    expect(dossier.model.properties.some((p: any) => ["clearRoomHeight", "material", "bulkDensity", "soundReductionIndex"].includes(p.propertyKey))).toBe(false);
    expect(dossier.model.relationships.filter((r: any) => r.relationshipType === "under_storey")).toHaveLength(1);
    expect(dossier.model.relationships.every((r: any) => r.reviewStatus === "unreviewed")).toBe(true);
    expect(receipt).toMatchObject({ providerCalls: 0, networkCalls: 0, databaseCalls: 0, referenceInputs: false, wholeBuildingCompleteness: false });
    expect(await replay()).toMatchObject({ code: 0, stderr: "" });
    const candidate = await read("candidate.json", "prepared-replay");
    expect(candidate.observations.every((o: any) => ["blocked", "unsupported"].includes(o.outcome) && o.review === null)).toBe(true);
    expect(candidate.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fire_concept:draft", outcome: "blocked" }),
      expect.objectContaining({ id: "noise_concept:draft", outcome: "blocked" }),
      expect.objectContaining({ id: "fire:scope:second-escape-route", outcome: "unsupported" }),
      expect.objectContaining({ id: "fire:scope:fire-brigade-access", outcome: "unsupported" }),
      expect.objectContaining({ id: "fire:scope:garage-components", outcome: "unsupported" }),
      expect.objectContaining({ id: "interior_stair:declared_scope", value: null }),
      expect.objectContaining({ id: "interior_service:declared_scope", value: null }),
    ]));
    expect(dossier.checks.some((c: any) => ["structural", "thermal"].includes(c.kind))).toBe(false);
    const assessment = await read("assessment.json", "prepared-replay");
    // All fire observations, including blocked component and route results, have
    // declarations; successful results are not the source of the requested scope.
    for (const observation of assessment.fire.observations)
      expect(candidate.observations).toContainEqual(expect.objectContaining({ id: `fire:${observation.id}`, unit: observation.unit }));
    expect(candidate.observations).toContainEqual(expect.objectContaining({
      id: `fire:component:${dossier.model.elements[0].storeyId}/${dossier.model.elements[0].id}:required`, outcome: "blocked", value: null,
    }));
    expect(candidate.observations).toContainEqual(expect.objectContaining({
      id: `fire:route:${dossier.model.rooms[0].storeyId}/${dossier.model.rooms[0].id}:length`, outcome: "blocked", value: null, unit: "m",
    }));
    expect(assessment.exterior).toHaveLength(2);
    // Bathrooms/corridors are not protected living rooms; their gaps need not request heights.
    expect(assessment.exterior.every((p: any) => p.rooms.filter((r: any) => r.kind?.value === "living").every((r: any) => r.gaps.includes("clear_height")))).toBe(true);
    const inventory = await read("inventory.json");
    for (const page of inventory.pages) {
      const living = page.candidates.find((c: any) => c.name === "Wohnen");
      expect(living).toMatchObject({ status: "included", reason: null, printedArea: { value: 53 } });
      expect(living.polygonAreaM2).toBeGreaterThan(0);
      expect(living.polygonAreaM2).not.toBe(living.printedArea.value);
    }
    const manifest = await read("manifest.json");
    expect(receipt.runtime).toEqual({ bun: Bun.version, platform: process.platform, arch: process.arch });
    expect(receipt.engineVersion).toBe(`sha256:${hash(new TextEncoder().encode(JSON.stringify(receipt.codeHashes, null, 2) + "\n"))}`);
    expect(manifest.engineVersion).toBe(receipt.engineVersion);
    expect(receipt.codeHashes.map((c: any) => c.path)).toEqual(expect.arrayContaining([
      "scripts/prepare-building-model-backtest.ts", "bun.lock", "richtfest-apps/knowledge/src/building-backtest.ts",
      "richtfest-apps/projects/src/candidate-calculations.ts", "richtfest-apps/acoustics/src/calculations.ts", "richtfest-shared/src/fire-plan.ts",
    ]));
    expect(receipt.codeHashes.every((c: any) => !c.path.endsWith(".test.ts") && !c.path.includes("/test-fixtures/"))).toBe(true);
    for (const file of receipt.codeHashes) expect(hash(await Bun.file(join(root, file.path)).bytes())).toBe(file.sha256);
    for (const file of manifest.files) expect(hash(await Bun.file(join(dir, "prepared", file.path)).bytes())).toBe(file.sha256);
    expect((await stat(join(dir, "prepared"))).mode & 0o777).toBe(0o500);
    expect((await prepare(declaration())).code).toBe(2);
    expect(hash(await Bun.file(join(dir, "prepared/sources/original.pdf")).bytes())).toBe(hash(original));
  } finally { await clean(dir); }
}, 120_000);

test("missing, ambiguous and foreign mappings fail instead of choosing pages, buildings or levels", async () => {
  const { dir, prepare } = await setup();
  try {
    const bad: any[] = [];
    const change = (fn: (c: any) => void) => { const c = declaration(); fn(c); bad.push(c); };
    change(c => delete c.sources[0].pages[0].storey);
    change(c => delete c.sources[0].pages[0].storey.level);
    change(c => delete c.sources[0].pages[0].region);
    change(c => c.sources[0].pages[0].region.width = 2);
    change(c => c.sources[0].pages[1].page = 1);
    change(c => c.sources[0].pages[1].storey.key = "ground");
    change(c => c.sources[0].pages[1].storey.level = 0);
    change(c => c.sources[0].pages[0].buildingKey = "foreign");
    change(c => c.reference = { answers: [] });
    change(c => c.sources[0].pages.pop());
    change(c => c.sources[0].pages.push({ page: 3, omit: "Does not exist" }));
    for (const [i, config] of bad.entries()) expect((await prepare(config, `bad-${i}`)).code).toBe(2);
  } finally { await clean(dir); }
}, 120_000);

test("omitted pages remain declared coverage and nullable levels never infer a cross-storey link", async () => {
  const { dir, prepare, replay, read } = await setup();
  try {
    const config: any = declaration();
    config.sources[0].pages[0].storey.level = null;
    config.sources[0].pages[1] = { page: 2, omit: "Section outside declared plan scope" };
    expect(await prepare(config)).toMatchObject({ code: 0, stderr: "" });
    const dossier = await read("dossier.json"), receipt = await read("preparation.json");
    expect(dossier.model.storeys[0].levelIndex).toBeNull();
    expect(dossier.model.relationships.some((r: any) => r.relationshipType === "under_storey")).toBe(false);
    expect(receipt.coverage).toContainEqual(expect.objectContaining({ page: 2, status: "omitted", omit: "Section outside declared plan scope" }));
    expect(dossier.checks).toContainEqual(expect.objectContaining({ kind: "source_coverage", resultId: `${dossier.sources[0].versionId}:2` }));
    expect(await replay()).toMatchObject({ code: 0, stderr: "" });
  } finally { await clean(dir); }
}, 120_000);

test("two buildings share a source page but disjoint regions never share entities; boundary-crossing outlines are not assigned by centre", async () => {
  const { dir, prepare, replay, read } = await setup();
  try {
    const objects = [...Buffer.from(syntheticPlanPdf()).toString("latin1").matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj/g)].map(m => m[1]!);
    const original = objects[3]!.match(/stream\n([\s\S]*)\nendstream/)![1]!;
    const stream = `${original}\nq 1 0 0 1 600 0 cm\n${original}\nQ`;
    objects[3] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
    await Bun.write(join(dir, "original.pdf"), pdfObjects(objects));
    for (const [index, key] of ["front", "rear"].entries()) {
      const config = declaration(); config.sources[0]!.pages.pop();
      config.building = { key, name: key };
      config.sources[0]!.pages[0]!.buildingKey = key;
      config.sources[0]!.pages[0]!.region = { x: index * .5, y: 0, width: .5, height: 1 };
      expect(await prepare(config, key)).toMatchObject({ code: 0, stderr: "" });
      expect(await replay(key)).toMatchObject({ code: 0, stderr: "" });
      const dossier = await read("dossier.json", key), inventory = await read("inventory.json", key);
      expect(dossier.model.rooms.length).toBeGreaterThan(0);
      expect(dossier.model.rooms.every((r: any) => r.geometry.polygon.every((p: any) => p.x >= index * .5 && p.x <= (index + 1) * .5))).toBe(true);
      expect(inventory.pages[0].candidates.some((c: any) => c.reason === "outside_building_region")).toBe(true);
      expect(dossier.model.properties.some((p: any) => ["exteriorSurfacesComplete", "fireRole", "clearRoomHeight", "material"].includes(p.propertyKey))).toBe(false);
    }
    const front = await read("dossier.json", "front"), rear = await read("dossier.json", "rear");
    expect(front.sources).toEqual(rear.sources);
    expect(front.scope.buildingId).not.toBe(rear.scope.buildingId);
    expect(front.model.rooms.some((r: any) => rear.model.rooms.some((s: any) => s.id === r.id))).toBe(false);
    const config = declaration(); config.sources[0]!.pages.pop(); config.sources[0]!.pages[0]!.region.width = .3;
    expect(await prepare(config, "crossing")).toMatchObject({ code: 0, stderr: "" });
    const inventory = await read("inventory.json", "crossing"), raw = await read("extractions.json", "crossing");
    const living = inventory.pages[0].candidates.find((c: any) => c.name === "Wohnen" && c.reason === "crosses_building_region");
    expect(living).toMatchObject({ status: "excluded", entityId: null });
    const ring = raw[0].candidates.find((c: any) => c.id === living.id).geometry.polygon;
    const xs = ring.map((p: any) => p.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeLessThan(.3);
    expect(Math.max(...xs)).toBeGreaterThan(.3);
    expect(await replay("crossing")).toMatchObject({ code: 0, stderr: "" });
  } finally { await clean(dir); }
}, 120_000);

// A valid text-only source with a room label but no scale/dimensions or wall outlines.
function unscaledPdf() {
  const stream = "BT /F1 12 Tf 50 100 Td (Wohnen) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  return pdfObjects(objects);
}
test("missing metric scale still produces a strict replayable dossier with blocked scope, declared domains and draft concepts", async () => {
  const { dir, prepare, replay, read } = await setup();
  try {
    await Bun.write(join(dir, "original.pdf"), unscaledPdf());
    const config: any = declaration(); config.sources[0].pages.pop(); delete config.sources[0].pages[0].scaleDenominator;
    expect(await prepare(config)).toMatchObject({ code: 0, stderr: "" });
    const dossier = await read("dossier.json"), receipt = await read("preparation.json");
    expect(dossier.pages).toEqual([]); expect(dossier.model.rooms).toEqual([]); expect(dossier.model.elements).toEqual([]);
    expect(receipt.coverage[0]).toMatchObject({ status: "blocked", reason: "missing_metric_scale" });
    expect(receipt.coverage[0].excluded.length).toBeGreaterThan(0);
    expect(dossier.checks.map((c: any) => c.kind)).toEqual(expect.arrayContaining(["fire", "interior_wall", "exterior_room", "interior_stair", "interior_service", "whole_building", "source_coverage", "fire_concept", "noise_concept"]));
    expect(await replay()).toMatchObject({ code: 0, stderr: "" });
    const candidate = await read("candidate.json", "prepared-replay"), storeyId = dossier.model.storeys[0].id;
    for (const kind of ["wall", "ceiling", "door"]) for (const key of ["required", "status"])
      expect(candidate.observations).toContainEqual(expect.objectContaining({
        id: `fire:component:${storeyId}/declared_${kind}_inventory:${key}`, value: null, outcome: "blocked",
      }));
    expect(candidate.observations).toContainEqual(expect.objectContaining({
      id: `fire:route:${storeyId}/declared_room_inventory:length`, value: null, outcome: "blocked",
    }));
    expect(candidate.observations).toContainEqual(expect.objectContaining({ id: "fire:scope:second-escape-route", outcome: "unsupported" }));
  } finally { await clean(dir); }
}, 120_000);
