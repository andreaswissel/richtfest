import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "../richtfest-shared/node_modules/zod";
import { extractPlanLabels, buildingExtractorVersion } from "../richtfest-apps/projects/src/plan-extraction";
import { projectCandidates } from "../richtfest-apps/projects/src/candidate-calculations";
import { planStoreyLevels } from "../richtfest-apps/projects/src/storey-levels";
import { planStoreyCeilings, storeyCeilingMethod } from "../richtfest-apps/projects/src/storey-ceilings";
import { polygonArea } from "../richtfest-apps/projects/src/exterior-noise-proof";

const text = z.string().trim().min(1), pageNumber = z.number().int().positive();
const fileName = text.refine(id => basename(id) === id && !/[\\/]/.test(id) && id !== "." && id !== "..");
const regionSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine(r => r.x + r.width <= 1 && r.y + r.height <= 1, "Region must lie inside the source page");
/** Every PDF page must be mapped or explicitly omitted. One page per storey is the replay contract. */
export const preparationSchema = z.object({
  schema: z.literal("richtfest-building-model-preparation"), version: z.literal(1), caseId: text,
  building: z.object({ key: text, name: text }).strict(),
  sources: z.array(z.object({ id: fileName,
    pages: z.array(z.union([
      z.object({ page: pageNumber, omit: text }).strict(),
      z.object({ page: pageNumber, buildingKey: text, region: regionSchema,
        storey: z.object({ key: text, name: text, level: z.number().int().nullable() }).strict(),
        scaleDenominator: z.number().finite().positive().optional(),
      }).strict(),
    ])).min(1),
  }).strict()).min(1),
}).strict();
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// UUIDs are deterministically qualified by frozen source version, page and source key.
const uuid = (...parts: unknown[]) => {
  const h = hash(JSON.stringify(parts));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function unique(values: unknown[], message: string) { assert(new Set(values).size === values.length, message); }
function regionExclusion(geometry: any, region: z.infer<typeof regionSchema>): string | null {
  const ring = geometry?.polygon, box = geometry?.planRegion;
  const points = Array.isArray(ring) && ring.length >= 3 ? ring : box
    ? [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }] : [];
  if (!points.length || points.some((p: any) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return "region_geometry_missing";
  const x = points.map((p: any) => p.x), y = points.map((p: any) => p.y);
  const left = Math.min(...x), right = Math.max(...x), top = Math.min(...y), bottom = Math.max(...y);
  // Bounding-box containment in a convex rectangle contains every edge, not merely its centre.
  if (left >= region.x && right <= region.x + region.width && top >= region.y && bottom <= region.y + region.height) return null;
  return right < region.x || left > region.x + region.width || bottom < region.y || top > region.y + region.height
    ? "outside_building_region" : "crosses_building_region";
}

async function run() {
  const { values: args } = parseArgs({ options: { config: { type: "string" }, source: { type: "string", multiple: true }, out: { type: "string" } } });
  assert(args.config && args.source?.length && args.out, "arguments");
  const configBytes = await Bun.file(args.config).bytes();
  const config = preparationSchema.parse(JSON.parse(new TextDecoder().decode(configBytes)));
  unique(config.sources.map(s => s.id), "duplicate source");
  unique(args.source.map(p => basename(p)), "duplicate source path");
  assert(args.source.length === config.sources.length, "source count");
  const mapped = config.sources.flatMap(s => s.pages.flatMap(p => "storey" in p ? [{ ...p, sourceId: s.id }] : []));
  assert(mapped.length, "no mapped storeys");
  unique(mapped.map(p => p.storey.key), "ambiguous storey mapping");
  unique(mapped.flatMap(p => p.storey.level === null ? [] : [p.storey.level]), "ambiguous storey level");
  for (const source of config.sources) {
    unique(source.pages.map(p => p.page), "ambiguous page mapping");
    assert(source.pages.some(p => "storey" in p), "each source needs a mapped page to establish its page count");
    for (const page of source.pages) if ("storey" in page) assert(page.buildingKey === config.building.key, "foreign building mapping");
  }
  // Read once, then only use these exact bytes, including for extraction and the replay copy.
  const sources = await Promise.all(config.sources.map(async source => {
    const path = args.source!.find(path => basename(path) === source.id);
    assert(path, "source filename mismatch");
    const bytes = await Bun.file(path).bytes();
    assert(new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-", "PDF required");
    const sha256 = hash(bytes);
    return { ...source, bytes, sha256, versionId: uuid("source", source.id, sha256) };
  }));
  await mkdir(args.out, { mode: 0o700 });
  const written: Array<{ path: string; sha256: string }> = [];
  const save = async (path: string, bytes: string | Uint8Array) => {
    await writeFile(join(args.out!, path), bytes, { flag: "wx", mode: 0o400 });
    written.push({ path, sha256: hash(bytes) });
  };
  await save("config.json", configBytes);
  await mkdir(join(args.out, "sources"), { mode: 0o700 });
  for (const source of sources) await save(`sources/${source.id}`, source.bytes);
  await chmod(join(args.out, "sources"), 0o500);
  const buildingId = uuid(config.caseId, "building", config.building.key);
  const model: Parameters<typeof projectCandidates>[0] = {
    model: { id: uuid(buildingId, "model"), revision: 0 },
    buildings: [{ id: buildingId, name: config.building.name, constructionState: "unknown" }],
    storeys: mapped.map(p => ({ id: uuid(buildingId, "storey", p.storey.key), buildingId, name: p.storey.name,
      levelIndex: p.storey.level, constructionState: "unknown" })),
    rooms: [], elements: [], properties: [], relationships: [], conflicts: [], planSources: [], extractions: [], extractionCandidates: [],
  };
  // Explicit levels only. Printed titles cannot silently choose or renumber a storey.
  const levels = planStoreyLevels({ storeys: model.storeys, properties: [], readings: new Map() });
  const pages: any[] = [], coverage: any[] = [], extractions: any[] = [], inventory: any[] = [];
  const updatedAt = new Date().toISOString();
  const relationship = (from: string, to: string, type: string, metadata: unknown) => ({
    id: uuid("relationship", from, to, type, metadata), fromEntityId: from, toEntityId: to,
    relationshipType: type, reviewStatus: "unreviewed", metadata,
  });
  for (const source of sources) {
    let pageCount: number | null = null;
    for (const declaration of source.pages) {
      if ("omit" in declaration) { coverage.push({ sourceVersionId: source.versionId, ...declaration, status: "omitted" }); continue; }
      const storey = model.storeys.find(s => s.id === uuid(buildingId, "storey", declaration.storey.key))!;
      const locator = { kind: "page", sourceVersionId: source.versionId, page: declaration.page };
      const scope = { sourceVersionId: source.versionId, page: declaration.page, storeyId: storey.id };
      const extracted = await extractPlanLabels((async function* () { yield source.bytes; })(), declaration.page,
        AbortSignal.timeout(180_000), { scaleDenominator: declaration.scaleDenominator });
      pageCount = extracted.pageCount;
      const candidates = [...extracted.labels, ...extracted.footprints].map(c => ({
        id: uuid(source.versionId, declaration.page, c.entityType, c.sourceKey), jobId: uuid("extraction", source.versionId, declaration.page),
        entityType: c.entityType, sourceKey: c.sourceKey, name: c.name, geometry: c.geometry, status: "unreviewed",
        evidence: [{ ...locator, region: c.geometry.planRegion, quote: c.quote,
          ...("layerId" in c ? { layerId: c.layerId, layerName: c.layerName } : {}) }],
      }));
      unique(candidates.map(c => c.id), "duplicate candidate identity");
      // Full extraction retains excluded candidates, printed areas, topology and source evidence outside the narrow replay schema.
      extractions.push({ ...scope, extractorVersion: buildingExtractorVersion, reviewStatus: "unreviewed", result: extracted, candidates });
      const regionExcluded = candidates.flatMap(c => {
        const reason = regionExclusion(c.geometry, declaration.region);
        return reason ? [{ id: c.id, reason }] : [];
      });
      const scopedCandidates = candidates.filter(c => !regionExcluded.some(e => e.id === c.id));
      const recordInventory = (excluded: Array<{ id: string; reason: string }>, ids = new Map<string, string>()) => {
        const scale = extracted.pageScale;
        const area = (ring: Array<{ x: number; y: number }>) => polygonArea(ring.map(p => [p.x * scale.pageAspectRatio * scale.metresPerPageHeight!, p.y * scale.metresPerPageHeight!]));
        inventory.push({ ...scope, region: declaration.region, reviewStatus: "unreviewed", candidates: candidates.map(c => {
          const g = c.geometry as any;
          return { id: c.id, entityId: ids.get(c.id) ?? null, sourceKey: c.sourceKey, entityType: c.entityType, name: c.name,
            geometryQuality: g.quality, status: ids.has(c.id) ? "included" : "excluded", reason: excluded.find(e => e.id === c.id)?.reason ?? null,
            printedArea: g.printedArea ?? null, printedGrossArea: g.printedGrossArea ?? null, areaZones: g.openSpace?.zones ?? [],
            polygonAreaM2: scale.metresPerPageHeight && g.polygon?.length >= 3 ? area(g.polygon) - (g.holes ?? []).reduce((sum: number, hole: any) => sum + area(hole), 0) : null,
            evidence: c.evidence };
        }) });
      };
      model.planSources.push({ ...scope, alignmentStatus: "unreviewed" });
      model.relationships.push(relationship(storey.id, buildingId, "declared_storey_mapping", {
        ...locator, method: "explicit_cli_declaration", sourceReviewed: false, declaration,
      }));
      const level = levels.find(l => l.storeyId === storey.id)!.level;
      if (level !== null) model.properties.push({ id: uuid(storey.id, "level"), entityId: storey.id, propertyKey: "level", reviewed: null,
        current: { version: 1, reviewRevision: 0, value: level, provenance: "manual", reviewStatus: "unreviewed", evidence: [] } });
      const scale = extracted.pageScale;
      if (!(scale.metresPerPageHeight && scale.metresPerPageHeight > 0 && scale.pageAspectRatio > 0)) {
        const excluded = [...regionExcluded, ...scopedCandidates.map(c => ({ id: c.id, reason: "missing_metric_scale" }))];
        coverage.push({ ...scope, region: declaration.region, status: "blocked", reason: "missing_metric_scale", excluded });
        recordInventory(excluded);
        continue;
      }
      // A scale explicitly supplied at this CLI is not a source-reviewed scale.
      const scaleStatus = declaration.scaleDenominator ? "unreviewed" : extracted.scaleObservation?.status ?? "missing";
      const pageScale = { ...scale, denominator: extracted.scaleObservation?.denominator ?? null };
      const job = { id: uuid("extraction", source.versionId, declaration.page), ...scope, status: "complete", updatedAt,
        extractorVersion: buildingExtractorVersion, result: { ...extracted, pageScale, scaleObservation: { status: scaleStatus },
          topologyCoverage: { ...extracted.topologyCoverage, openingEvidence: extracted.topologyCoverage.openingEvidence
            .filter(o => !regionExclusion({ planRegion: o.closure }, declaration.region)) } } };
      const projected = projectCandidates({ ...model, properties: [], relationships: [], extractions: [job], extractionCandidates: scopedCandidates }, scope);
      // Projection IDs for openings intentionally retain the existing preview API. Remap only at the UUID-only portable boundary.
      const ids = new Map([...projected.rooms, ...projected.elements].map(e => [e.id, uuid(source.versionId, declaration.page, "projected", e.id)]));
      const geometry = (g: any) => ({ source: locator, ...(g?.polygon ? { polygon: g.polygon } : {}), ...(g?.holes ? { holes: g.holes } : {}) });
      const entity = (e: any) => ({ id: ids.get(e.id)!, name: e.name, constructionState: e.constructionState ?? "unknown", geometry: geometry(e.geometry) });
      const rooms = projected.rooms.map(r => ({ ...entity(r), storeyId: storey.id }));
      const elements = projected.elements.map(e => ({ ...entity(e), buildingId, storeyId: storey.id, roomId: ids.get(e.roomId) ?? null, kind: e.kind }));
      const relationships = projected.relationships.map(r => relationship(ids.get(r.fromEntityId)!, ids.get(r.toEntityId) ?? r.toEntityId,
        r.relationshipType, r.metadata));
      model.rooms.push(...rooms); model.elements.push(...elements); model.relationships.push(...relationships);
      model.properties.push(...projected.properties.map(p => ({ id: uuid(ids.get(p.entityId), p.propertyKey), entityId: ids.get(p.entityId)!,
        propertyKey: p.propertyKey, reviewed: null, current: { ...p.current, version: 1, reviewRevision: 0 } })));
      model.extractions.push({ id: job.id, ...scope, status: "complete", updatedAt, result: { pageScale, scaleObservation: { status: scaleStatus } } });
      pages.push({ sourceVersionId: source.versionId, page: declaration.page, fileName: source.id,
        storey: { id: storey.id, name: storey.name, levelIndex: storey.levelIndex }, scale: pageScale,
        walls: elements.filter(e => ["wall", "draft_wall"].includes(e.kind)).map(e => ({ id: e.id, name: e.name,
          exterior: relationships.some(r => r.fromEntityId === e.id && r.relationshipType === "faces_exterior"),
          ring: e.geometry.polygon.map((p: { x: number; y: number }) => [p.x * scale.pageAspectRatio * scale.metresPerPageHeight!, p.y * scale.metresPerPageHeight!]) })) });
      const excluded = [...regionExcluded, ...projected.excluded];
      recordInventory(excluded, ids);
      coverage.push({ ...scope, region: declaration.region, status: "projected_unreviewed", excluded, used: projected.used,
        projectedIds: [...ids].map(([candidateId, entityId]) => ({ candidateId, entityId })), openings: projected.openings.summary });
    }
    assert(pageCount !== null && source.pages.length === pageCount && source.pages.every(p => p.page <= pageCount!), "missing or nonexistent page declarations");
  }
  // These are inventory hypotheses, not extracted slabs. Only explicit consecutive levels link storeys.
  const ceilings = planStoreyCeilings({ storeys: model.storeys, rooms: model.rooms, elements: model.elements });
  for (const ceiling of ceilings) {
    const id = uuid(ceiling.source.sourceVersionId, ceiling.source.page, ceiling.stableKey);
    model.elements.push({ id, name: ceiling.name, buildingId, storeyId: ceiling.storeyId, roomId: null, kind: "ceiling",
      constructionState: "unknown", geometry: { source: { kind: "page", ...ceiling.source } } });
    const metadata = { ...ceiling.source, method: storeyCeilingMethod, sourceReviewed: false, hypothesis: "inventory_only_not_source_slab" };
    for (const roomId of ceiling.roomIds) model.relationships.push(relationship(id, roomId, "covers", metadata));
    if (ceiling.upperStoreyId) model.relationships.push(relationship(id, ceiling.upperStoreyId, "under_storey", metadata));
  }
  const checks: Array<{ id: string; kind: string; resultId: string; entityIds: string[]; unit: string | null }> = [];
  const check = (kind: string, resultId: string, entityIds: string[], unit: string | null = null) => {
    const id = `${kind}:${resultId}`;
    if (!checks.some(c => c.id === id)) checks.push({ id, kind, resultId, entityIds, unit });
  };
  // Declare the fire engine's public result IDs from source inventory, not from
  // successful calculations. Unknown roles/ratings/routes must retain their checks.
  for (const key of ["class", "deliverable", "review"]) check("fire", `building:${key}`, [buildingId]);
  check("fire", "building:water", [buildingId], "l/min");
  for (const key of ["second-escape-route", "fire-brigade-access", "garage-components"])
    check("fire", `scope:${key}`, [buildingId]);
  for (const storey of model.storeys) {
    for (const kind of ["wall", "ceiling", "door"]) {
      const elements = model.elements.filter(e => e.storeyId === storey.id && (e.kind === "draft_wall" ? "wall" : e.kind) === kind);
      const declared = elements.length ? elements.map(e => ({ resultId: e.id, entityId: e.id }))
        : [{ resultId: `declared_${kind}_inventory`, entityId: storey.id }];
      for (const element of declared) for (const key of ["required", "status"])
        check("fire", `component:${storey.id}/${element.resultId}:${key}`, [element.entityId]);
    }
    const rooms = model.rooms.filter(r => r.storeyId === storey.id);
    const declared = rooms.length ? rooms.map(r => ({ resultId: r.id, entityId: r.id }))
      : [{ resultId: "declared_room_inventory", entityId: storey.id }];
    for (const room of declared) {
      check("fire", `route:${storey.id}/${room.resultId}:length`, [room.entityId], "m");
      check("fire", `route:${storey.id}/${room.resultId}:withinLimit`, [room.entityId]);
    }
  }
  for (const room of model.rooms) check("exterior_room", room.id, [room.id], "dB");
  for (const e of model.elements) {
    if (e.kind === "door") check("interior_door", e.id, [e.id, ...(e.roomId ? [e.roomId] : [])], "dB");
    if (e.kind === "ceiling") for (const r of model.relationships.filter(r => r.fromEntityId === e.id && r.relationshipType === "covers"))
      for (const kind of ["interior_ceiling_airborne", "interior_ceiling_impact"]) check(kind, `${e.id}:${r.toEntityId}`, [e.id, r.toEntityId], "dB");
    if (["wall", "draft_wall"].includes(e.kind)) {
      const rooms = [...new Set<string>(model.relationships.filter(r => r.fromEntityId === e.id && r.relationshipType === "separates").map(r => r.toEntityId))];
      for (let a = 0; a < rooms.length; a++) for (let b = a + 1; b < rooms.length; b++) {
        check("interior_wall", `${e.id}:${rooms[a]}:${rooms[b]}`, [e.id, rooms[a]!, rooms[b]!], "dB");
        check("interior_wall", `${e.id}:${rooms[b]}:${rooms[a]}`, [e.id, rooms[a]!, rooms[b]!], "dB");
      }
    }
  }
  // Domain declarations must survive empty geometry, missing scale and absent method packs.
  for (const kind of ["interior_wall", "interior_ceiling_airborne", "interior_ceiling_impact", "interior_door", "interior_impact", "interior_stair", "interior_service", "exterior_room"])
    if (!checks.some(c => c.kind === kind)) check(kind, "declared_scope", [buildingId], "dB");
  for (const kind of ["whole_building", "source_mapping"]) check(kind, "declared_scope", [buildingId]);
  for (const kind of ["fire_concept", "noise_concept"]) check(kind, "draft", [buildingId]);
  for (const c of coverage) if (c.status !== "projected_unreviewed" || c.excluded?.length)
    check("source_coverage", `${c.sourceVersionId}:${c.page}`, [c.storeyId ?? buildingId]);
  const { extractionCandidates: _, ...portable } = model;
  const dossier = { schema: "richtfest-building-model-backtest", version: 1, caseId: config.caseId, runIds: [],
    sources: sources.map(s => ({ id: s.id, versionId: s.versionId, sha256: s.sha256, format: "pdf" })), model: portable, pages,
    scope: { buildingId, storeyIds: model.storeys.map(s => s.id), roomIds: model.rooms.map(r => r.id), elementIds: model.elements.map(e => e.id) },
    fireMode: "candidate_preview", exterior: { enabled: true, levels: [] }, checks };
  await save("dossier.json", json(dossier));
  await save("extractions.json", json(extractions));
  await save("inventory.json", json({ version: 1, reviewStatus: "unreviewed", pages: inventory,
    areaComparison: "Printed observations and independently measured polygon areas are distinct. No fitting, agreement threshold or approval is applied by this preparation." }));
  // Match the strict replay's source-only execution identity convention. This
  // binds the projection/geometry methods as well as the preparation entrypoint.
  const root = resolve(import.meta.dir, "..");
  const paths = ["scripts/prepare-building-model-backtest.ts", "richtfest-apps/knowledge/src/building-backtest.ts", "bun.lock"];
  for (const directory of ["richtfest-apps/projects/src", "richtfest-apps/acoustics/src", "richtfest-shared/src"])
    for await (const path of new Bun.Glob("**/*.ts").scan(join(root, directory)))
      if (!path.endsWith(".test.ts") && !path.startsWith("test-fixtures/")) paths.push(`${directory}/${path}`);
  const codeHashes = await Promise.all(paths.sort().map(async path => ({ path, sha256: hash(await Bun.file(join(root, path)).bytes()) })));
  const engineVersion = `sha256:${hash(json(codeHashes))}`;
  await save("preparation.json", json({ version: 1, extractorVersion: buildingExtractorVersion, engineVersion, codeHashes,
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch }, reviewStatus: "unreviewed",
    sourceBytesVerified: true, providerCalls: 0, networkCalls: 0, databaseCalls: 0, referenceInputs: false,
    wholeBuildingCompleteness: false, mapping: config, levels, ceilings, coverage, files: [...written],
    limitations: ["Explicit CLI building/storey/level/scale declarations are not source-reviewed facts.",
      "Ceilings are inventory hypotheses, not traced slabs. No heights, materials, acoustic values or approvals are supplied.",
      "Only mapped pages are extracted. Omitted pages, excluded candidates and missing-scale pages remain visible.",
      "Building regions use full outline containment; crossing candidates are excluded, never assigned by centre or clipped. One dossier represents one explicitly declared building.",
      "Cross-storey alignment is unreviewed; no coordinate registration or complete envelope is established."] }));
  await save("manifest.json", json({ version: 1, engineVersion, files: [...written] }));
  await chmod(args.out, 0o500);
  console.log(`Prepared ${mapped.length} explicitly mapped storeys and ${checks.length} declared checks. Unreviewed source-only dossier; replay dossier.json with the frozen sources.`);
}

if (import.meta.main) try { await run(); }
catch {
  console.error("Building preparation failed. Use --config mapping.json --source original.pdf [--source other.pdf] --out NEW_DIRECTORY. Declare every page (mapping with normalized region, or omit reason), unique storeys/levels and the explicit building key. Inputs must be source PDFs only. Existing/partial output is never overwritten.");
  process.exitCode = 2;
}
