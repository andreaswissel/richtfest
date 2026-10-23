import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "../richtfest-shared/node_modules/zod";
import { buildingEvidenceSchema, buildingReviewStatusSchema, buildingPropertyProvenanceSchema, buildingConstructionStateSchema,
  buildingPropertyValueSchema, buildingComponentProperties, type Point2, type SitePlanPage } from "../richtfest-shared/src";
import { assessFirePlan } from "../richtfest-shared/src/fire-plan";
import { acousticNormPackSchema } from "../richtfest-shared/src/acoustic-norm-pack";
import { buildingBacktestCandidateSchema } from "../richtfest-apps/knowledge/src/building-backtest";
import { assembleFireProtectionSnapshot } from "../richtfest-apps/projects/src/fire-protection";
import { assembleInteriorSoundSnapshot } from "../richtfest-apps/projects/src/interior-sound-proof";
import { assembleExteriorNoiseProof, type ProofAssemblyInput } from "../richtfest-apps/projects/src/exterior-noise-proof";
import type { AppDeps } from "../richtfest-apps/projects/src/deps";
import { calculateAcoustics } from "../richtfest-apps/acoustics/src/calculations";
import { massiveWallRw } from "../richtfest-apps/acoustics/src/massive-wall";
import { airborneSoundInsulation, impactSoundLevel, interiorRequirements, liningImprovement, impactOtherDirections,
  stairImpact, timberImpact, serviceNoise, doorSoundInsulation, doorCriteria } from "../richtfest-apps/acoustics/src/interior-sound";

// Portable, deliberately narrow projection of readModel, not a database dump.
// Unknown envelope/row fields are errors rather than silently discarded inputs.
const uuid = z.string().uuid(), text = z.string().trim().min(1), finite = z.number().finite();
const pageNumber = z.number().int().positive(), revision = z.number().int().nonnegative();
const point = z.object({ x: finite.min(0).max(1), y: finite.min(0).max(1) }).strict();
const locator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), sourceVersionId: uuid, page: pageNumber }).strict(),
  z.object({ kind: z.literal("ifc"), sourceVersionId: uuid, expressId: pageNumber, attribute: text }).strict(),
]);
const geometry = z.object({ source: locator, polygon: z.array(point).min(3).optional(), holes: z.array(z.array(point).min(3)).optional() }).strict();
const entity = { id: uuid, name: text, constructionState: buildingConstructionStateSchema, geometry: geometry.nullable().optional() };
const version = z.object({ version: pageNumber, reviewRevision: revision.default(0), value: buildingPropertyValueSchema,
  reviewStatus: buildingReviewStatusSchema, provenance: buildingPropertyProvenanceSchema, evidence: z.array(buildingEvidenceSchema),
  unit: text.nullable().optional() }).strict();
const scale = z.object({ pageAspectRatio: finite.positive(), metresPerPageHeight: finite.positive(), denominator: finite.positive().nullable().optional() }).strict();
const planPage = z.object({ sourceVersionId: uuid, page: pageNumber, fileName: text.nullable(),
  storey: z.object({ id: uuid, name: text, levelIndex: finite.nullable() }).strict(),
  scale: scale.extend({ denominator: finite.positive().nullable() }),
  walls: z.array(z.object({ id: uuid, name: text, exterior: z.boolean(), ring: z.array(z.tuple([finite, finite])).min(3) }).strict()),
}).strict();
const dossierSchema = z.object({
  schema: z.literal("richtfest-building-model-backtest"), version: z.literal(1), caseId: text,
  runIds: z.array(text).default([]),
  sources: z.array(z.object({ id: text.refine(id => basename(id) === id && !/[\\/]/.test(id) && id !== "." && id !== ".."),
    versionId: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/), format: z.enum(["pdf", "ifc"]) }).strict()).min(1),
  model: z.object({
    model: z.object({ id: uuid, revision }).strict(),
    buildings: z.array(z.object(entity).strict()),
    storeys: z.array(z.object({ ...entity, buildingId: uuid, levelIndex: finite.nullable() }).strict()),
    rooms: z.array(z.object({ ...entity, storeyId: uuid }).strict()),
    elements: z.array(z.object({ ...entity, buildingId: uuid, storeyId: uuid.nullable(), roomId: uuid.nullable(), kind: text }).strict()),
    properties: z.array(z.object({ id: uuid, entityId: uuid, propertyKey: text, current: version.nullable(), reviewed: version.nullable() }).strict()),
    relationships: z.array(z.object({ id: uuid, fromEntityId: uuid, toEntityId: uuid, relationshipType: text,
      reviewStatus: buildingReviewStatusSchema, metadata: z.record(z.unknown()).nullable() }).strict()),
    conflicts: z.array(z.object({ entityId: uuid, propertyKey: text }).strict()),
    planSources: z.array(z.object({ storeyId: uuid, sourceVersionId: uuid, page: pageNumber,
      alignmentStatus: z.enum(["unknown", "approximate", "unreviewed", "reviewed"]) }).strict()),
    extractions: z.array(z.object({ id: uuid, sourceVersionId: uuid, page: pageNumber, storeyId: uuid, status: z.literal("complete"), updatedAt: z.string().datetime(),
      result: z.object({ pageScale: scale, scaleObservation: z.object({ status: z.enum(["confirmed", "unreviewed", "ambiguous", "missing"]) }).strict() }).strict() }).strict()),
  }).strict(),
  pages: z.array(planPage),
  scope: z.object({ buildingId: uuid, storeyIds: z.array(uuid).min(1), roomIds: z.array(uuid), elementIds: z.array(uuid) }).strict(),
  fireMode: z.enum(["reviewed", "candidate_preview"]),
  exterior: z.object({ enabled: z.boolean(), levels: z.array(z.object({ wallId: uuid, source: locator,
    dayDb: finite, sleepingDb: finite, compass: z.enum(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]),
    basis: z.enum(["calculated", "turned_away"]), reviewStatus: buildingReviewStatusSchema }).strict()) }).strict(),
  // id = kind:resultId, e.g. interior_door:<element UUID> or fire:building:class.
  // Unknown kinds are retained as unsupported; a known kind with no result is blocked.
  checks: z.array(z.object({ id: text, kind: text, resultId: text, entityIds: z.array(uuid).min(1), unit: text.nullable() }).strict()).min(1),
}).strict();
type Dossier = z.infer<typeof dossierSchema>;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function assert(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid replay dossier"); }
function unique(values: string[]) { assert(new Set(values).size === values.length); }
const active = (row: { reviewStatus: string }) => !["rejected", "superseded"].includes(row.reviewStatus);

function validate(input: Dossier) {
  const m = input.model;
  unique(input.sources.map(s => s.id)); unique(input.sources.map(s => s.versionId)); unique(input.runIds); unique(input.checks.map(c => c.id));
  const entities = [...m.buildings, ...m.storeys, ...m.rooms, ...m.elements];
  unique([m.model.id, ...entities.map(e => e.id), ...m.properties.map(p => p.id), ...m.relationships.map(r => r.id), ...m.extractions.map(e => e.id)]);
  const entityIds = new Set(entities.map(e => e.id));
  const sourceOf = (id: string) => input.sources.find(s => s.versionId === id);
  // Check even unused/rejected evidence: no foreign source may enter the frozen dossier.
  const references = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(references); return; }
    const row = value as Record<string, unknown>;
    if ("sourceVersionId" in row) {
      const source = sourceOf(String(row.sourceVersionId)); assert(source);
      if (row.kind === "ifc") assert(source.format === "ifc");
      if ("page" in row || row.kind === "page") assert(source.format === "pdf");
    }
    Object.values(row).forEach(references);
  };
  references(input.model); references(input.pages); references(input.exterior);
  for (const s of m.storeys) assert(m.buildings.some(b => b.id === s.buildingId));
  for (const r of m.rooms) assert(m.storeys.some(s => s.id === r.storeyId));
  for (const e of m.elements) {
    assert(m.buildings.some(b => b.id === e.buildingId));
    if (e.storeyId) assert(m.storeys.some(s => s.id === e.storeyId && s.buildingId === e.buildingId));
    if (e.roomId) assert(m.rooms.some(r => r.id === e.roomId && r.storeyId === e.storeyId));
  }
  unique(m.properties.map(p => `${p.entityId}:${p.propertyKey}`));
  unique(m.conflicts.map(p => `${p.entityId}:${p.propertyKey}`));
  for (const p of [...m.properties, ...m.conflicts]) assert(entityIds.has(p.entityId));
  for (const p of m.properties) {
    const type = m.buildings.some(e => e.id === p.entityId) ? "building" : m.storeys.some(e => e.id === p.entityId) ? "storey"
      : m.rooms.some(e => e.id === p.entityId) ? "room" : "element";
    const spec = (buildingComponentProperties[type] as Record<string, { value: z.ZodTypeAny; unit: string | null }>)[p.propertyKey];
    for (const v of [p.current, p.reviewed]) if (v && spec && v.value !== null) {
      assert(spec.value.safeParse(v.value).success);
      if (v.unit !== undefined) assert(v.unit === spec.unit);
    }
    if (p.reviewed) {
      assert(p.reviewed.reviewStatus === "approved" && p.current && p.reviewed.version <= p.current.version);
      if (p.reviewed.version === p.current.version) assert(json(p.reviewed) === json(p.current));
    }
  }
  for (const r of m.relationships) {
    assert(entityIds.has(r.fromEntityId) && entityIds.has(r.toEntityId));
    const from = m.elements.find(e => e.id === r.fromEntityId);
    if (["separates", "covers"].includes(r.relationshipType)) assert(from && m.rooms.some(room => room.id === r.toEntityId && room.storeyId === from.storeyId));
    if (r.relationshipType === "opening_in") assert(from && m.elements.some(e => e.id === r.toEntityId && e.storeyId === from.storeyId));
    if (r.relationshipType === "under_storey") assert(from && m.storeys.some(s => s.id === r.toEntityId && s.buildingId === from.buildingId));
    if (r.relationshipType === "faces_exterior") assert(from && (r.toEntityId === from.buildingId || r.toEntityId === from.storeyId));
  }
  for (const type of ["opening_in", "under_storey"]) unique(m.relationships.filter(r => r.relationshipType === type && active(r)).map(r => r.fromEntityId));
  const pageKey = (p: { sourceVersionId: string; page: number }) => `${p.sourceVersionId}:${p.page}`;
  unique(m.planSources.map(pageKey)); unique(m.planSources.map(p => p.storeyId));
  unique(m.extractions.map(pageKey)); unique(input.pages.map(pageKey)); unique(input.pages.map(p => p.storey.id));
  for (const p of m.planSources) assert(m.storeys.some(s => s.id === p.storeyId));
  for (const e of m.extractions) assert(m.planSources.some(p => pageKey(p) === pageKey(e) && p.storeyId === e.storeyId));
  // Every geometry belongs to its own storey/page, even when not in execution scope.
  for (const e of [...m.rooms, ...m.elements]) if (e.geometry?.source.kind === "page")
    assert(m.planSources.some(p => p.storeyId === e.storeyId && pageKey(p) === pageKey(e.geometry!.source as { sourceVersionId: string; page: number })));
  for (const p of input.pages) {
    const storey = m.storeys.find(s => s.id === p.storey.id);
    const extraction = m.extractions.find(e => pageKey(e) === pageKey(p));
    assert(storey && storey.name === p.storey.name && storey.levelIndex === p.storey.levelIndex && extraction?.storeyId === storey.id);
    assert(p.fileName === sourceOf(p.sourceVersionId)!.id);
    assert(extraction.result.pageScale.pageAspectRatio === p.scale.pageAspectRatio && extraction.result.pageScale.metresPerPageHeight === p.scale.metresPerPageHeight
      && (extraction.result.pageScale.denominator ?? null) === p.scale.denominator);
    unique(p.walls.map(w => w.id));
    for (const wall of p.walls) {
      const e = m.elements.find(e => e.id === wall.id);
      assert(e && e.storeyId === storey.id && e.name === wall.name && e.constructionState !== "demolished" && ["wall", "draft_wall"].includes(e.kind));
      assert(e.geometry?.source.kind === "page" && pageKey(e.geometry.source) === pageKey(p) && e.geometry.polygon && !e.geometry.holes?.length);
      const expected = e.geometry.polygon.map(pt => [pt.x * p.scale.pageAspectRatio * p.scale.metresPerPageHeight, pt.y * p.scale.metresPerPageHeight]);
      assert(expected.length === wall.ring.length && expected.every((pt, i) => pt.every((n, j) => Math.abs(n - wall.ring[i]![j]!) < 1e-9)));
      assert(wall.exterior === m.relationships.some(r => r.fromEntityId === wall.id && r.relationshipType === "faces_exterior" && active(r)));
    }
    // A supplied page cannot conceal one of its source-backed active walls.
    for (const e of m.elements.filter(e => e.storeyId === storey.id && e.constructionState !== "demolished" && ["wall", "draft_wall"].includes(e.kind) && e.geometry?.polygon))
      assert(p.walls.some(w => w.id === e.id));
  }
  const s = input.scope;
  for (const ids of [s.storeyIds, s.roomIds, s.elementIds]) unique(ids);
  assert(m.buildings.some(b => b.id === s.buildingId && b.constructionState !== "demolished"));
  for (const id of s.storeyIds) assert(m.storeys.some(row => row.id === id && row.buildingId === s.buildingId && row.constructionState !== "demolished"));
  for (const id of s.roomIds) assert(m.rooms.some(row => row.id === id && s.storeyIds.includes(row.storeyId) && row.constructionState !== "demolished"));
  for (const id of s.elementIds) assert(m.elements.some(row => row.id === id && row.buildingId === s.buildingId && row.storeyId && s.storeyIds.includes(row.storeyId)
    && (!row.roomId || s.roomIds.includes(row.roomId)) && row.constructionState !== "demolished"));
  const scopeIds = new Set([s.buildingId, ...s.storeyIds, ...s.roomIds, ...s.elementIds]);
  for (const c of input.checks) { assert(c.id === `${c.kind}:${c.resultId}`); unique(c.entityIds); assert(c.entityIds.every(id => scopeIds.has(id))); }
  unique(input.exterior.levels.map(l => l.wallId));
  for (const l of input.exterior.levels) assert(s.elementIds.includes(l.wallId) && input.pages.some(p => p.walls.some(w => w.id === l.wallId && w.exterior)));
  assert(input.exterior.enabled || input.exterior.levels.length === 0);
  return scopeIds;
}

async function run() {
  const { values: args } = parseArgs({ options: { input: { type: "string" }, source: { type: "string", multiple: true },
    "acoustic-pack": { type: "string" }, out: { type: "string" } } });
  assert(args.input && args.out && args.source?.length);
  assert(args["acoustic-pack"] === undefined || args["acoustic-pack"].trim());
  const inputBytes = await Bun.file(args.input).bytes();
  const input = dossierSchema.parse(JSON.parse(new TextDecoder().decode(inputBytes)));
  const scopeIds = validate(input);
  assert(args.source.length === input.sources.length); unique(args.source.map(path => basename(path)));
  const sources = await Promise.all(args.source.map(async path => {
    const manifest = input.sources.find(s => s.id === basename(path));
    const bytes = await Bun.file(path).bytes(); assert(manifest && hash(bytes) === manifest.sha256);
    return { manifest, bytes };
  }));
  const packBytes = args["acoustic-pack"] ? await Bun.file(args["acoustic-pack"]).bytes() : null;
  const pack = packBytes ? acousticNormPackSchema.parse(JSON.parse(new TextDecoder().decode(packBytes))) : null;
  const acousticPack = pack && packBytes ? { id: pack.id, sha256: hash(packBytes) } : null;
  // Reserve once; neither failed nor completed exports can be overwritten by this CLI.
  await mkdir(args.out, { mode: 0o700 });
  const output = args.out;
  const written: Array<{ path: string; sha256: string }> = [];
  const save = async (path: string, bytes: string | Uint8Array) => {
    await writeFile(join(output, path), bytes, { flag: "wx", mode: 0o400 });
    written.push({ path, sha256: hash(bytes) });
  };
  await save("input.json", inputBytes);
  // Bind the separately supplied method configuration into every calculation receipt.
  const requestBytes = json({ version: 1, inputSha256: hash(inputBytes), acousticPack });
  await save("request.json", requestBytes);
  await mkdir(join(output, "sources"), { mode: 0o700 });
  for (const { manifest, bytes } of sources) await save(`sources/${manifest.id}`, bytes);
  await chmod(join(output, "sources"), 0o500);
  const root = resolve(import.meta.dir, "..");
  const paths = ["scripts/run-building-model-backtest.ts", "richtfest-apps/knowledge/src/building-backtest.ts", "bun.lock"];
  for (const directory of ["richtfest-apps/projects/src", "richtfest-apps/acoustics/src", "richtfest-shared/src"])
    for await (const path of new Bun.Glob("**/*.ts").scan(join(root, directory)))
      if (!path.endsWith(".test.ts") && !path.startsWith("test-fixtures/")) paths.push(`${directory}/${path}`);
  const codeHashes = await Promise.all(paths.sort().map(async path => ({ path, sha256: hash(await Bun.file(join(root, path)).bytes()) })));
  const engineVersion = `sha256:${hash(json(codeHashes))}`;
  const method = pack?.din4109_interior, catalogue = pack?.din4109_32;
  const host: AppDeps["interiorSound"] = pack && method && catalogue ? {
    editions: { ...method.editions, catalogue: catalogue.edition },
    requirements: level => interiorRequirements(pack, level), massiveRw: value => massiveWallRw(pack, value),
    airborne: value => airborneSoundInsulation(pack, value), impact: value => impactSoundLevel(pack, value),
    ...(method.door ? { door: (value: Parameters<typeof doorSoundInsulation>[1]) => doorSoundInsulation(pack, value) } : {}),
    ...(pack.din4109_35?.doors ? { doorCriteria: (value: Parameters<typeof doorCriteria>[1]) => doorCriteria(pack, value) } : {}),
    crossJunctionOffsetM: method.airborne.crossJunction ? method.airborne.crossJunctionOffsetM ?? null : null,
    lining: value => liningImprovement(pack, value), impactOther: value => impactOtherDirections(pack, value),
    stair: value => stairImpact(pack, value), timberImpact: value => timberImpact(pack, value), service: value => serviceNoise(pack, value),
    lightweightOptions: () => (pack.din4109_33?.rows ?? []).map(({ key, ref, kind, description, transmission }) => ({ key, ref, kind, description, transmission })),
    lightweightRow: key => {
      const row = pack.din4109_33?.rows.find(r => r.key === key);
      return row ? { kind: row.kind, ref: `${row.ref} (${pack.din4109_33!.edition})`, description: row.description,
        rwDb: row.rwDb, lnwDb: row.lnwDb, dnfwDb: row.dnfwDb } : null;
    },
  } : null;
  const original = input.model, scope = input.scope;
  const model = { ...original, buildings: original.buildings.filter(r => r.id === scope.buildingId),
    storeys: original.storeys.filter(r => scope.storeyIds.includes(r.id)), rooms: original.rooms.filter(r => scope.roomIds.includes(r.id)),
    elements: original.elements.filter(r => scope.elementIds.includes(r.id)),
    properties: original.properties.filter(p => scopeIds.has(p.entityId)), conflicts: original.conflicts.filter(p => scopeIds.has(p.entityId)),
    relationships: original.relationships.filter(r => scopeIds.has(r.fromEntityId) && scopeIds.has(r.toEntityId) && active(r)),
    planSources: original.planSources.filter(p => scope.storeyIds.includes(p.storeyId)), extractions: original.extractions.filter(p => scope.storeyIds.includes(p.storeyId)) };
  const selected = model.properties.map(p => {
    // Rejecting a newer proposal does not revoke an earlier approved version.
    // Match the production snapshot's reviewed-first contract; conflicts still withhold both.
    const chosen = model.conflicts.some(c => c.entityId === p.entityId && c.propertyKey === p.propertyKey) ? null
      : p.reviewed?.reviewStatus === "approved" ? p.reviewed : p.current && active(p.current) ? p.current : null;
    return { ...p, current: chosen, reviewed: chosen?.reviewStatus === "approved" ? chosen : null };
  });
  model.properties = selected;
  const values = selected.flatMap(p => p.current && active(p.current) && p.current.value !== null
    ? [{ ...p.current, entityId: p.entityId, propertyKey: p.propertyKey, propertyId: p.id }] : []);
  const value = (entityId: string, key: string) => values.find(p => p.entityId === entityId && p.propertyKey === key) ?? null;
  const pages: SitePlanPage[] = input.pages.filter(p => scope.storeyIds.includes(p.storey.id)).map(p => ({ ...p, walls: p.walls.filter(w => scope.elementIds.includes(w.id)) }));
  const levels = model.storeys.map(s => ({ storeyId: s.id, level: model.properties.some(p => p.entityId === s.id && p.propertyKey === "level")
    || model.conflicts.some(c => c.entityId === s.id && c.propertyKey === "level") ? value(s.id, "level")?.value as number | null ?? null : s.levelIndex }));
  unique(levels.filter(l => l.level !== null).map(l => String(l.level)));
  const fireSnapshot = assembleFireProtectionSnapshot(model, input.fireMode);
  const fire = fireSnapshot.available ? assessFirePlan(fireSnapshot.plan, input.fireMode) : null;
  const interior = host ? assembleInteriorSoundSnapshot({ model: model.model, buildingId: scope.buildingId, pages,
    rooms: model.rooms, elements: model.elements, storeys: model.storeys, relationships: model.relationships, values, levels }, host)
    : { available: false as const, reason: "norm_pack_missing" as const };
  // Do not let the live service adapter's convenience default become a sourced room use.
  const replayBlockers: Array<{ entityId: string; reason: string }> = [];
  if (interior.available) for (const check of interior.services) if (!check.receivingUse) {
    check.result = null; check.requirement = null;
    replayBlockers.push({ entityId: check.id, reason: "service_receiving_use_missing" });
  }
  const exterior = pages.map(page => {
    const storey = model.storeys.find(s => s.id === page.storey!.id)!;
    const toMetres = (p: { x: number; y: number }): Point2 => [p.x * page.scale.pageAspectRatio * page.scale.metresPerPageHeight, p.y * page.scale.metresPerPageHeight];
    const rooms = model.rooms.filter(r => r.storeyId === storey.id && r.geometry?.source.kind === "page"
      && r.geometry.source.sourceVersionId === page.sourceVersionId && r.geometry.source.page === page.page);
    const openings = model.elements.filter(e => e.roomId && rooms.some(r => r.id === e.roomId));
    const surfacesComplete = (roomId: string) => {
      const omittedOpening = original.elements.some(e => e.roomId === roomId && e.constructionState !== "demolished"
        && ["window", "door", "small_element", "roof"].includes(e.kind) && !scopeIds.has(e.id));
      const unresolvedFace = original.relationships.some(r => r.toEntityId === roomId && r.relationshipType === "separates"
        && (!active(r) || !page.walls.some(w => w.id === r.fromEntityId)));
      const unhostedOpening = openings.some(e => e.roomId === roomId && ["window", "door", "small_element"].includes(e.kind)
        && !model.relationships.some(r => r.relationshipType === "opening_in" && r.fromEntityId === e.id && page.walls.some(w => w.id === r.toEntityId)));
      return omittedOpening || unresolvedFace || unhostedOpening ? null : value(roomId, "exteriorSurfacesComplete");
    };
    const assembled = assembleExteriorNoiseProof({ sourceLabel: `${page.fileName}:${page.page}`, storeyId: storey.id, labelPrefix: `${storey.id} · `,
      source: { versionId: page.sourceVersionId, page: page.page }, applicability: value(scope.buildingId, "exteriorNoiseApplicability") as any,
      flanking: value(scope.buildingId, "exteriorNoiseFlanking") as any, clearHeight: value(storey.id, "clearRoomHeight") as any,
      rooms: rooms.map(r => ({ id: r.id, name: r.name, roomUse: value(r.id, "roomUse")?.value as string ?? null,
        polygon: r.geometry?.polygon?.map(toMetres) ?? null, holes: r.geometry?.holes?.map(hole => hole.map(toMetres)) ?? [],
        // Empty explicit adjacency suppresses rejected/superseded geometric fallbacks.
        adjacentWallIds: new Set(model.relationships.filter(rel => rel.relationshipType === "separates" && rel.toEntityId === r.id).map(rel => rel.fromEntityId)),
        kind: value(r.id, "exteriorNoiseRoom") as any, surfacesComplete: surfacesComplete(r.id) as any,
        clearHeight: value(r.id, "clearRoomHeight") as any })),
      walls: page.walls.filter(w => w.exterior).map(w => ({ ...w, construction: value(w.id, "construction")?.value ?? null,
        rw: value(w.id, "soundReductionIndex") as any, rwBasis: value(w.id, "soundReductionIndexBasis") as any })),
      levels: new Map(input.exterior.enabled ? input.exterior.levels.filter(l => active(l)).map(l => [l.wallId, l]) : []),
      openings: openings.filter(e => ["window", "door", "small_element"].includes(e.kind)).map(e => ({ id: e.id, name: e.name, roomId: e.roomId!, componentType: e.kind as "window" | "door" | "small_element",
        wallId: model.relationships.find(r => r.relationshipType === "opening_in" && r.fromEntityId === e.id)?.toEntityId ?? null,
        planPolygon: e.geometry?.source.kind === "page" && e.geometry.source.sourceVersionId === page.sourceVersionId && e.geometry.source.page === page.page
          ? e.geometry.polygon?.map(toMetres) ?? null : null,
        area: value(e.id, "openingArea"), rw: value(e.id, "soundReductionIndex"), basis: value(e.id, "soundReductionIndexBasis"),
        count: value(e.id, "elementCount"), dnew: value(e.id, "normalizedLevelDifference"), glazing: value(e.id, "glazing"),
        width: value(e.id, "openingWidth"), height: value(e.id, "openingHeight") })) as ProofAssemblyInput["openings"],
      roofs: openings.filter(e => e.kind === "roof").map(e => ({ id: e.id, name: e.name, roomId: e.roomId!, construction: value(e.id, "construction")?.value,
        area: value(e.id, "surfaceArea"), rw: value(e.id, "soundReductionIndex"), basis: value(e.id, "soundReductionIndexBasis") })) as ProofAssemblyInput["roofs"],
    });
    return { page: { sourceVersionId: page.sourceVersionId, page: page.page }, ...assembled,
      calculation: input.exterior.enabled && assembled.batch ? calculateAcoustics(assembled.batch) : null };
  });
  const limitations = ["Replay of supplied saved-model claims, not independent PDF/IFC extraction or source truth verification.",
    "Declared scope only; no whole-building completeness or engineering approval. Every observation remains blocked pending independent review, even with draft numbers.",
    "The acoustic pack supplies method coefficients only; no licensing or applicability attestation is inferred. No pack tables are exported.",
    "IFC evidence is retained; 2D page geometry cannot be synthesized from IFC coordinates by this runner.",
    "Source-derived plan scale/geometry is compared to the pinned extraction snapshot; hashing cannot establish that its claims match the original drawing."];
  const assessment = { version: 1, reviewStatus: "unreviewed", scope, acousticPack, selectedValues: values, conflicts: model.conflicts,
    relationships: model.relationships, pages, sourceNoiseLevels: input.exterior.levels, fireMode: input.fireMode, fireSnapshot, fire, interior, exterior, replayBlockers, limitations };
  const assessmentBytes = json(assessment);
  await save("assessment.json", assessmentBytes);
  const evidenceFor = (ids: string[]) => {
    const citations = [...model.buildings, ...model.storeys, ...model.rooms, ...model.elements].filter(e => ids.includes(e.id)).flatMap(e => e.geometry ? [e.geometry.source] : []);
    const propertyCitations = values.filter(v => ids.includes(v.entityId)).flatMap(v => v.evidence);
    return [...citations, ...propertyCitations].flatMap(e => {
      if (e.kind !== "page" && e.kind !== "ifc") return [];
      const sourceId = input.sources.find(s => s.versionId === e.sourceVersionId)!.id;
      return [e.kind === "page" ? { kind: "page" as const, sourceId, page: e.page }
        : { kind: "ifc" as const, sourceId, expressId: e.expressId, attribute: e.attribute }];
    });
  };
  type Result = { value: string | number | boolean | null; unit: string | null; unsupported?: boolean; note: string; entityIds: string[] };
  const results = new Map<string, Result>();
  for (const item of fire?.observations ?? []) results.set(`fire:${item.id}`, { ...item, entityIds: item.id.startsWith("building:") || item.id.startsWith("scope:") ? [scope.buildingId]
    : [...scope.roomIds, ...scope.elementIds].filter(id => item.id.includes(id)), unsupported: item.outcome === "unsupported" });
  if (interior.available) {
    const unsupportedGap = (gap: any) => ["no_requirement", "criteria_not_applicable"].includes(typeof gap === "string" ? gap : gap?.code)
      || gap?.code === "element" && ["multi_leaf", "density_class_out_of_range", "perforated_not_homogeneous", "mass_out_of_range", "catalogue_missing", "lightweight_separating", "catalogue_row_unknown"].includes(gap.reason);
    const add = (kind: string, id: string, result: any, gaps: unknown[], entityIds: string[]) => results.set(`${kind}:${id}`, {
      value: result?.status === "calculated" ? result.valueDb ?? result.lnwPrimeDb ?? result.levelDb ?? null : null, unit: "dB", entityIds,
      unsupported: result?.status === "unsupported" || gaps.some(unsupportedGap)
        || kind === "interior_door" && !host?.door && !host?.doorCriteria,
      note: json({ result, gaps }).trim() });
    for (const c of interior.walls) add("interior_wall", c.id, c.result, c.gaps, [c.wallId, ...c.rooms.map(r => r.id)]);
    for (const c of interior.ceilings) { add("interior_ceiling_airborne", c.id, c.airborne, c.gaps, [c.ceilingId, c.room.id]); add("interior_ceiling_impact", c.id, c.impact, c.gaps, [c.ceilingId, c.room.id]); }
    for (const c of interior.doors) add("interior_door", c.id, c.result, c.gaps, [c.id, ...(c.room ? [c.room.id] : [])]);
    for (const c of interior.impacts) add("interior_impact", c.id, c.result, c.gaps, [c.source.id, c.room.id, c.wall.id]);
    for (const c of interior.stairs) add("interior_stair", c.id, c.result, c.gaps, [c.stair.id, ...(c.room ? [c.room.id] : [])]);
    for (const c of interior.services) add("interior_service", c.id, c.result, [...c.gaps, ...(!c.receivingUse ? ["service_receiving_use_missing"] : [])], [c.id]);
  }
  for (const page of exterior) for (const room of page.rooms) {
    const result = page.calculation?.batch?.rooms.find(r => r.roomId === room.label);
    results.set(`exterior_room:${room.id}`, { value: result?.result?.value ?? null, unit: "dB", entityIds: [room.id],
      unsupported: result?.status === "unsupported", note: json({ gaps: room.gaps, result: result ?? null, enabled: input.exterior.enabled }).trim() });
  }
  for (const name of ["fire", "noise"]) results.set(`${name}_concept:draft`, { value: null, unit: null,
    entityIds: [scope.buildingId], note: "Independent review of the exact concept worksheet is required; generated text is not assessment success." });
  const supported = new Set(["fire", "interior_wall", "interior_ceiling_airborne", "interior_ceiling_impact", "interior_door", "interior_impact", "interior_stair", "interior_service", "exterior_room", "fire_concept", "noise_concept"]);
  const receipt = { tool: "richtfest-building-model-replay", version: engineVersion, inputSha256: hash(requestBytes), outputSha256: hash(assessmentBytes) };
  const observations = input.checks.map(check => {
    const found = results.get(check.id);
    if (found) assert(found.entityIds.every(id => check.entityIds.includes(id)) && found.unit === check.unit);
    const unavailable = check.kind.startsWith("interior_") && !interior.available ? interior.reason : null;
    return { id: check.id, outcome: !supported.has(check.kind) || found?.unsupported || unavailable === "norm_pack_missing" ? "unsupported" : "blocked",
      value: found?.value ?? null, unit: check.unit, evidence: evidenceFor(check.entityIds),
      artifactId: check.kind === "fire_concept" ? "fire-concept" : check.kind === "noise_concept" ? "noise-concept" : "assessment",
      calculation: receipt, review: null,
      note: `${found?.note ?? unavailable ?? (supported.has(check.kind) ? "Declared check has no executed result; missing inputs, entity mapping or unsupported geometry." : "Declared path is not supported by this replay adapter.")} Unreviewed replay; not a completed assessment.` };
  });
  for (const name of ["fire", "noise"]) {
    const checks = observations.filter(o => (o.id.startsWith("fire:") || o.id.startsWith("fire_concept:")) === (name === "fire"));
    await save(`${name}-concept.md`, [`# ${name === "fire" ? "Fire protection" : "Sound protection"} — unreviewed concept worksheet`, "",
      "Not an approved concept. Missing and unsupported declarations are retained. No whole-building completeness claim.", "",
      ...checks.map(c => `- ${c.id}: ${c.outcome}; draft value ${c.value ?? "missing"} ${c.unit ?? ""}. ${c.note}`), "",
      name === "fire" ? fire?.concept ?? "No calculable jurisdiction/classification. Establish source-backed building inputs, routes, components and review." : "Review source-backed room uses, heights, noise levels, construction, flanking paths and installation conditions; do not infer missing inputs from the method pack.",
      "", ...limitations.map(l => `- ${l}`), ""].join("\n"));
  }
  const candidate = buildingBacktestCandidateSchema.parse({ version: 1, caseId: input.caseId, runIds: input.runIds,
    sources: input.sources.map(({ versionId: _, ...s }) => s), artifacts: written.filter(f => ["assessment.json", "fire-concept.md", "noise-concept.md"].includes(f.path))
      .map(f => ({ id: f.path.replace(/\.(json|md)$/, ""), sha256: f.sha256 })), observations });
  await save("candidate.json", json(candidate));
  await save("execution.json", json({ version: 1, engineVersion, codeHashes, runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    inputSha256: hash(inputBytes), requestSha256: hash(requestBytes), acousticPack, sourceBytesVerified: true, savedModelInputs: true, modelExecution: false, providerCalls: 0,
    networkCalls: 0, databaseCalls: 0, referenceInputs: false, requestedChecks: input.checks, executedResultIds: [...results.keys()],
    undeclaredResultIds: [...results.keys()].filter(id => !input.checks.some(c => c.id === id)), wholeBuildingCompleteness: false, files: [...written], limitations }));
  // A terminal digest list includes execution.json. It cannot hash itself; verify it independently.
  await save("manifest.json", json({ version: 1, files: [...written] }));
  await chmod(output, 0o500);
  console.log(`Saved ${observations.length} declared observations. Private read-only replay; no engineering approval. Score candidate.json separately.`);
}

try { await run(); }
catch {
  // Validation details can include private project facts or licensed pack content.
  console.error("Building replay failed. Use --input dossier.json --source original.pdf [--source model.ifc] [--acoustic-pack PRIVATE_JSON] --out NEW_DIRECTORY. Check strict schema, source hashes, unique IDs, declared scope and page/source geometry. Existing output is never overwritten; partial runs remain reserved.");
  process.exitCode = 2;
}
