import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { extractPlanLabels, buildingExtractorVersion } from "../richtfest-apps/projects/src/plan-extraction";
import { calculateCandidates } from "../richtfest-apps/projects/src/candidate-calculations";
import { buildingBacktestCandidateSchema } from "../richtfest-apps/knowledge/src/building-backtest";
import { acousticNormPackSchema } from "../richtfest-shared/src/acoustic-norm-pack";
import { calculateAcoustics } from "../richtfest-apps/acoustics/src/calculations";
import { massiveWallRw } from "../richtfest-apps/acoustics/src/massive-wall";
import { airborneSoundInsulation, impactSoundLevel, interiorRequirements } from "../richtfest-apps/acoustics/src/interior-sound";

// Fresh source bytes only: no saved model, reference answers, provider, network or database.
// This is a calibration runner, not evidence that the operator has never seen the answers.
try {
  const { values } = parseArgs({ options: {
    source: { type: "string" }, page: { type: "string" }, out: { type: "string" }, "case-id": { type: "string" },
    "room-key": { type: "string", multiple: true }, "acoustic-pack": { type: "string" },
  } });
  if (!values.source || !values.out || !values["case-id"]?.trim() || !Number.isInteger(Number(values.page)) || Number(values.page) <= 0
    || values["room-key"]?.some(key => !key.trim()) || (values["acoustic-pack"] !== undefined && !values["acoustic-pack"].trim())) throw new Error("Invalid arguments");
  const input = { source: values.source, out: values.out, page: Number(values.page), "case-id": values["case-id"].trim(), "room-key": values["room-key"] };
  if (new Set(input["room-key"]).size !== (input["room-key"]?.length ?? 0)) throw new Error("Duplicate room selectors");
  // Reserve the run before extraction. Failure leaves a visible, non-overwritable partial run.
  await mkdir(input.out, { mode: 0o700 });
  const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  const save = (name: string, bytes: string | Uint8Array) => writeFile(join(input.out, name), bytes, { flag: "wx", mode: 0o600 });
  // A separately configured method pack supplies coefficients, never project facts.
  // Retain its identity/hash, not the licensed coefficient content in the export.
  const packBytes = values["acoustic-pack"] ? await Bun.file(values["acoustic-pack"]).text() : null;
  const pack = packBytes !== null ? acousticNormPackSchema.parse(JSON.parse(packBytes)) : null;
  const acousticPack = pack && packBytes ? { id: pack.id, sha256: hash(packBytes),
    interiorAvailable: Boolean(pack.din4109_interior && pack.din4109_32) } : null;
  const interiorSound: NonNullable<Parameters<typeof calculateCandidates>[2]>["interiorSound"] = pack?.din4109_interior && pack.din4109_32 ? {
    requirements: (level: Parameters<typeof interiorRequirements>[1]) => interiorRequirements(pack, level),
    massiveRw: (input: Parameters<typeof massiveWallRw>[1]) => massiveWallRw(pack, input),
    airborne: (input: Parameters<typeof airborneSoundInsulation>[1]) => airborneSoundInsulation(pack, input),
    impact: (input: Parameters<typeof impactSoundLevel>[1]) => impactSoundLevel(pack, input),
    lightweightRow: (key: string) => pack.din4109_33?.rows.find(row => row.key === key) ?? null,
  } : null;
  // Freeze the bytes used for both hashing and extraction; a changed original cannot race the manifest.
  const sourceBytes = await Bun.file(input.source).bytes();
  const source = { id: basename(input.source), sha256: hash(sourceBytes), format: "pdf" as const };
  await save("source.pdf", sourceBytes);
  const root = resolve(import.meta.dir, "..");
  const paths = ["scripts/run-plan-candidate-backtest.ts", "richtfest-apps/knowledge/src/building-backtest.ts", "bun.lock"];
  for (const directory of ["richtfest-apps/projects/src", "richtfest-apps/acoustics/src", "richtfest-shared/src"])
    for await (const path of new Bun.Glob("**/*.ts").scan(join(root, directory)))
      if (!path.endsWith(".test.ts") && !path.startsWith("test-fixtures/")) paths.push(`${directory}/${path}`);
  const codeHashes = await Promise.all(paths.sort().map(async path => ({ path, sha256: hash(await Bun.file(join(root, path)).bytes()) })));
  const engineVersion = `sha256:${hash(json(codeHashes))}`;
  const request = { version: 1, caseId: input["case-id"], source, page: input.page, roomKeys: input["room-key"] ?? null, acousticPack };
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
  try { preview = calculateCandidates(model, scope, { interiorSound }); }
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
  const selectedIds = new Set(keys.map(id));
  const rooms = preview?.exterior.rooms.filter(room => selectedIds.has(room.id)) ?? [];
  const labels = new Set(rooms.map(room => room.label));
  const batch = preview?.exterior.batch;
  const inventory = batch?.inventory.filter(room => labels.has(room.roomId)) ?? [];
  const exterior = batch && inventory.length ? calculateAcoustics({ ...batch, inventory,
    rooms: batch.rooms.filter(room => labels.has(room.room.id)) }) : null;
  const interior = preview && "walls" in preview.interior ? preview.interior.walls.filter(wall => wall.rooms.every(room => selectedIds.has(room.id))) : [];
  const interiorMethodBlocker = interiorSound ? null : pack ? "interior_or_massive_catalogue_missing" : "acoustic_pack_not_supplied";
  const acousticBytes = json({ version: 1, reviewStatus: "unreviewed", source, scope, acousticPack,
    selectedRoomKeys: keys, missingRoomKeys: keys.filter(key => !extraction.labels.some(room => room.sourceKey === key)),
    unavailableRoomKeys: keys.filter(key => !rooms.some(room => room.id === id(key))), previewBlocker: blocker,
    geometry: preview?.geometry.filter(room => selectedIds.has(room.id)) ?? [], rooms, exterior, interior,
    interiorMethodAvailable: Boolean(interiorSound), interiorMethodBlocker,
    unsupportedChecks: ["cross_storey_airborne", "impact", "building_services", "whole_building_completeness"],
    limitations: ["Only selected same-page room pairs are considered. No ceiling/impact/service proof or whole-building completeness is implied.",
      "Printed areas and traced polygon areas remain separate observations. Neither is silently adjusted to match the other.",
      "Room uses and connections are source-derived proposals. Missing height, facade noise, material, rating or junction inputs are not defaulted.",
      "The method pack supplies coefficients only; loading it does not establish applicability, licensing or engineering approval."] });
  await save("acoustics.json", acousticBytes);
  artifacts.push({ id: "acoustics", sha256: hash(acousticBytes) });
  const acousticReceipt = { ...receipt, outputSha256: hash(acousticBytes) };
  // A concept work sheet, not a fabricated completed concept. Values and gaps
  // come from the executed projection; the writer never receives reference answers.
  const cell = (value: unknown) => String(value ?? "offen").replace(/[|\r\n]/g, " ");
  const concept = ["# Schallschutz – Quellenbasierter Arbeitsstand", "",
    "Ungeprüfter Entwurf, kein freigegebener Nachweis. Keine Referenzberechnung als Eingabe verwendet.",
    `Quelle: ${source.id}, PDF-Seite ${input.page}, SHA-256 ${source.sha256}.`,
    `Bereich: ${keys.length} ausgewählte Raumkennungen; keine Aussage zur Vollständigkeit des Gebäudes.`, "",
    "## Raum- und Bauteilprüfung", "", "| Raum | Polygonfläche m² | Gedruckte Fläche m² (ungeprüft) | Lichte Höhe m | Offene Außenlärm-Eingaben |", "| --- | ---: | ---: | ---: | --- |",
    ...keys.map(key => { const geometry = preview?.geometry.find(room => room.id === id(key)), room = rooms.find(room => room.id === id(key));
      return `| ${cell(room?.label ?? key)} | ${cell(geometry?.areaM2?.toFixed(3))} | ${cell(geometry?.printedArea?.value)} | ${cell(geometry?.clearHeight)} | ${cell(room?.gaps.join(", ") ?? blocker ?? "Raum fehlt")} |`; }),
    "", "## Innenlärm", "",
    interiorSound ? `${interior.length} raumbezogene Trennwandprüfungen mit konfigurierter Methode ausgeführt; fehlende Eingaben bleiben gesperrt.`
      : `Rechenmethode nicht verfügbar (${interiorMethodBlocker}). Separaten vollständigen Normenpack bereitstellen; daraus folgen keine Projektwerte.`,
    ...interior.map(wall => `- ${cell(wall.rooms.map(room => rooms.find(selected => selected.id === room.id)?.label ?? room.name).join(" ↔ "))}: Länge ${wall.lengthM} m; Fläche ${cell(wall.areaM2)} m²; Ergebnis ${wall.result?.status === "calculated" ? `${wall.result.quantity} ${wall.result.valueDb} dB (ungeprüft)` : "nicht berechenbar"}; offene Eingaben: ${cell(wall.gaps.map(gap => JSON.stringify(gap)).join("; "))}.`),
    "", "## Außenlärm", "",
    exterior?.batch ? `${exterior.batch.rooms.filter(room => room.status === "calculated").length}/${exterior.batch.rooms.length} inventarisierte Räume berechenbar. Vollständige Eingaben und Ergebnisse: acoustics.json.`
      : "Keine vollständige schutzbedürftige Rauminventur für diesen Ausschnitt. Fehlende Raumzuordnung nicht als bestanden gewertet.",
    "", "## Ausstehende Nachweise", "",
    "- Plan-/Schnittzuordnung, lichte Höhen und Flächenbezug klären; zeichnerische und gedruckte Mengen getrennt prüfen.",
    "- Anwendbare Anforderungen und nutzungsbezogene Außenlärmpegel aus eigenständigen Projektquellen herleiten, nicht aus Kartenfarben oder Referenzantworten.",
    "- Tatsächliche Trenn-/Flankenbauteile, Decken, Anschlussdetails, Öffnungen und Einbau-Schalldämmwerte belegen.",
    "- Trittschall, haustechnische Anlagen und weitere Räume sind nicht durch diesen Seitenausschnitt nachgewiesen.",
    "- Fachliche Freigabe steht aus; diese Liste bestätigt keine Norm-/Rechtsanwendbarkeit.", ""].join("\n");
  await save("noise-concept.md", concept);
  artifacts.push({ id: "noise-concept", sha256: hash(concept) });
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
      { id: "exterior:provided", outcome: "blocked", value: null, unit: "dB", evidence, artifactId: "acoustics", calculation: acousticReceipt, review: null,
        note: `Executed exterior inventory: ${inventory.length} selected protected-room proposals; ${exterior?.batch?.rooms.filter(room => room.status === "calculated").length ?? 0} numeric results. Missing source inputs and per-room gaps are retained in acoustics.json; no aggregate replaces missing rooms.` },
      { id: "interior:provided", outcome: interiorSound ? "blocked" : "unsupported", value: null, unit: "dB", evidence, artifactId: "acoustics", calculation: acousticReceipt, review: null,
        note: interiorSound ? `Executed ${interior.length} same-page separating-wall checks. Materials, heights, slabs and junction gaps remain explicit; no whole-building interior result.`
          : `Interior method unavailable (${interiorMethodBlocker}). Geometry and input coverage are exported; no interior calculation claimed.` },
      ...["fire-concept", "noise-concept"].map(concept => ({ id: concept, outcome: "blocked", value: null, unit: null, evidence,
        artifactId: concept === "noise-concept" ? "noise-concept" : null, calculation: null, review: null,
        note: "No releasable concept from geometry alone. The acoustic work sheet records executed inputs/gaps, not completed engineering or independent artifact review." })),
    ] });
  await save("candidate.json", json(candidate));
  await save("execution.json", json({ version: 1, engineVersion, extractorVersion: buildingExtractorVersion, codeHashes, runtime: Bun.version,
    elapsedMs: performance.now() - started, sourceBytesVerified: true, modelExecution: false, providerCalls: 0,
    roomUseClassifier: "deterministic_name_proposals", savedModelInputs: false, referenceInputs: false, acousticPack,
    extractedRooms: extraction.labels.length, includedRooms: preview?.geometry.length ?? 0,
    excludedCandidates: preview?.excluded ?? [], selectedRoomChecks: keys.length,
    limitations: ["Calibration only: source-only execution does not prove a blinded operator or a held-out case.",
      "No provider-based room-use classification is invoked. Acoustic methods run only when explicitly configured; missing project facts are not supplied by the pack.",
      "Single-page isolation containers do not establish building/storey inventory or cross-storey geometry.",
      "Supplied room-key selectors freeze evaluation scope only; other rooms remain in extraction and preview artifacts."] }));
  console.log(`Source-only extraction saved: ${extraction.labels.length} rooms, ${preview?.geometry.length ?? 0} usable outlines, ${keys.length} selected checks. Score separately; no engineering approval.`);
} catch {
  console.error("Plan replay failed. Use --source original.pdf --page N --case-id ID [--room-key KEY ...] [--acoustic-pack PRIVATE_JSON] --out NEW_DIRECTORY. No reference or saved model input is accepted. Existing output is never overwritten; inspect partial files before retrying.");
  process.exitCode = 2;
}
