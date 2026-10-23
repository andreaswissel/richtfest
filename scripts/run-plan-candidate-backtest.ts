import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { extractPlanLabels, buildingExtractorVersion } from "../richtfest-apps/projects/src/plan-extraction";
import { calculateCandidates } from "../richtfest-apps/projects/src/candidate-calculations";
import { buildingBacktestCandidateSchema } from "../richtfest-apps/knowledge/src/building-backtest";

// Fresh source bytes only: no saved model, reference answers, provider, network or database.
// This is a calibration runner, not evidence that the operator has never seen the answers.
try {
  const { values } = parseArgs({ options: {
    source: { type: "string" }, page: { type: "string" }, out: { type: "string" }, "case-id": { type: "string" },
    "room-key": { type: "string", multiple: true },
  } });
  if (!values.source || !values.out || !values["case-id"]?.trim() || !Number.isInteger(Number(values.page)) || Number(values.page) <= 0
    || values["room-key"]?.some(key => !key.trim())) throw new Error("Invalid arguments");
  const input = { source: values.source, out: values.out, page: Number(values.page), "case-id": values["case-id"].trim(), "room-key": values["room-key"] };
  if (new Set(input["room-key"]).size !== (input["room-key"]?.length ?? 0)) throw new Error("Duplicate room selectors");
  // Reserve the run before extraction. Failure leaves a visible, non-overwritable partial run.
  await mkdir(input.out, { mode: 0o700 });
  const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  const save = (name: string, bytes: string | Uint8Array) => writeFile(join(input.out, name), bytes, { flag: "wx", mode: 0o600 });
  // Freeze the bytes used for both hashing and extraction; a changed original cannot race the manifest.
  const sourceBytes = await Bun.file(input.source).bytes();
  const source = { id: basename(input.source), sha256: hash(sourceBytes), format: "pdf" as const };
  await save("source.pdf", sourceBytes);
  const root = resolve(import.meta.dir, "..");
  const paths = ["scripts/run-plan-candidate-backtest.ts", "richtfest-apps/knowledge/src/building-backtest.ts", "bun.lock"];
  for (const directory of ["richtfest-apps/projects/src", "richtfest-shared/src"])
    for await (const path of new Bun.Glob("**/*.ts").scan(join(root, directory)))
      if (!path.endsWith(".test.ts") && !path.startsWith("test-fixtures/")) paths.push(`${directory}/${path}`);
  const codeHashes = await Promise.all(paths.sort().map(async path => ({ path, sha256: hash(await Bun.file(join(root, path)).bytes()) })));
  const engineVersion = `sha256:${hash(json(codeHashes))}`;
  const request = { version: 1, caseId: input["case-id"], source, page: input.page, roomKeys: input["room-key"] ?? null };
  const requestBytes = json(request);
  await save("input.json", requestBytes);
  const started = performance.now();
  const extraction = await extractPlanLabels(createReadStream(join(input.out, "source.pdf")), input.page, AbortSignal.timeout(6 * 60_000));
  // Stable, page-qualified evaluation identities; these are not project database IDs.
  const id = (key: string) => {
    const value = hash(`${source.sha256}:${input.page}:${key}`);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
  };
  const scope = { sourceVersionId: id("source"), page: input.page, storeyId: id("storey") };
  const jobId = id("job");
  const candidates = [...extraction.labels, ...extraction.footprints].map(row => ({ ...row, id: id(row.sourceKey), jobId, status: "unreviewed",
    evidence: [{ kind: "page", sourceVersionId: scope.sourceVersionId, page: input.page, quote: row.quote, region: row.geometry.planRegion }] }));
  const { selectionMask: _mask, ...extracted } = extraction;
  const extractionBytes = json(extracted);
  await save("extraction.json", extractionBytes);
  // Containers are for page isolation only, not an assertion of one building/storey or its level.
  const model = { model: { id: id("model"), revision: 0 }, buildings: [{ id: id("building") }],
    storeys: [{ id: scope.storeyId, buildingId: id("building"), levelIndex: null }],
    rooms: [], elements: [], properties: [], relationships: [], conflicts: [], extractionCandidates: candidates,
    planSources: [{ ...scope, alignmentStatus: "unreviewed" }],
    extractions: [{ ...scope, id: jobId, status: "complete", extractorVersion: buildingExtractorVersion,
      updatedAt: "1970-01-01T00:00:00.000Z", result: extracted }] };
  let preview: ReturnType<typeof calculateCandidates> | null = null;
  let blocker: string | null = null;
  try { preview = calculateCandidates(model, scope); }
  catch (error) {
    if (!(error instanceof Error) || (error as Error & { code?: string }).code !== "candidate_preview_unavailable") throw error;
    blocker = error.message;
  }
  const previewBytes = json({ preview, blocker });
  await save("preview.json", previewBytes);
  const artifacts = [{ id: "extraction", sha256: hash(extractionBytes) }, { id: "preview", sha256: hash(previewBytes) }];
  const receipt = { tool: "richtfest-plan-candidate-preview", version: engineVersion,
    inputSha256: hash(requestBytes), outputSha256: hash(previewBytes) };
  const evidence = [{ kind: "page" as const, sourceId: source.id, page: input.page }];
  const keys = input["room-key"] ?? extraction.labels.map(row => row.sourceKey);
  const observations = keys.map(key => {
    const room = extraction.labels.find(row => row.sourceKey === key);
    const geometry = preview?.geometry.find(row => row.id === id(key));
    const area = geometry?.areaM2 ?? null;
    return { id: `room:${input.page}/${key}:area`, outcome: area === null ? "blocked" : "complete", value: area, unit: "m²",
      evidence: room ? evidence : [], artifactId: "preview", calculation: receipt, review: null,
      note: room ? `${room.name}: polygon minus holes at extracted scale; not a reviewed net/credited area. ${area === null ? blocker ?? "No usable calculation outline." : "Source identity and area basis still need review."}`
        : "Requested source-key room is missing on this page; retained as a failed-coverage observation, not omitted." };
  });
  const candidate = buildingBacktestCandidateSchema.parse({ version: 1, caseId: request.caseId, runIds: [], sources: [source], artifacts,
    observations: [...observations,
      { id: "building:class", outcome: "blocked", value: null, unit: null, evidence, artifactId: "preview", calculation: receipt, review: null,
        note: "Plan extraction does not establish jurisdiction, mean-terrain fire height, units or Sonderbau. No saved/reference classification is borrowed." },
      { id: "exterior:provided", outcome: "blocked", value: null, unit: "dB", evidence, artifactId: "preview", calculation: receipt, review: null,
        note: "No facade noise assignment, verified room height, complete envelope or component performance is supplied by this geometry-only run." },
      { id: "interior:provided", outcome: "unsupported", value: null, unit: "dB", evidence, artifactId: "preview", calculation: receipt, review: null,
        note: "This offline runner has no acoustic norm-pack host. Materials, junctions and heights are also absent; no interior calculation executed." },
      ...["fire-concept", "noise-concept"].map(concept => ({ id: concept, outcome: "blocked", value: null, unit: null, evidence,
        artifactId: null, calculation: null, review: null, note: "No releasable concept from geometry alone. Engineering inputs and independent artifact review are missing." })),
    ] });
  await save("candidate.json", json(candidate));
  await save("execution.json", json({ version: 1, engineVersion, extractorVersion: buildingExtractorVersion, codeHashes, runtime: Bun.version,
    elapsedMs: performance.now() - started, sourceBytesVerified: true, modelExecution: false, providerCalls: 0,
    roomUseClassifier: "not_run", savedModelInputs: false, referenceInputs: false,
    extractedRooms: extraction.labels.length, includedRooms: preview?.geometry.length ?? 0,
    excludedCandidates: preview?.excluded ?? [], selectedRoomChecks: keys.length,
    limitations: ["Calibration only: source-only execution does not prove a blinded operator or a held-out case.",
      "No provider-based room-use classification or acoustic norm-pack host is invoked.",
      "Single-page isolation containers do not establish building/storey inventory or cross-storey geometry.",
      "Supplied room-key selectors freeze evaluation scope only; other rooms remain in extraction and preview artifacts."] }));
  console.log(`Source-only extraction saved: ${extraction.labels.length} rooms, ${preview?.geometry.length ?? 0} usable outlines, ${keys.length} selected checks. Score separately; no engineering approval.`);
} catch {
  console.error("Plan replay failed. Use --source original.pdf --page N --case-id ID [--room-key KEY ...] --out NEW_DIRECTORY. No reference or saved model input is accepted. Existing output is never overwritten; inspect partial files before retrying.");
  process.exitCode = 2;
}
