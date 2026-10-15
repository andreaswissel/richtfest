import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPdf } from "./artifact-pdf";
import { PDFDocument } from "pdf-lib";
import { acousticDatasetSchema, renderAcousticCalculationReceipts } from "@richtfest/shared";

test("renders paginated Markdown with Unicode, named revisions and safe missing citations", async () => {
  const known = "11111111-1111-4111-8111-111111111111";
  const missing = "22222222-2222-4222-8222-222222222222";
  const rows = Array.from({ length: 110 }, (_, i) =>
    `| Bauteil ${i + 1} | Außenwände prüfen | R′w ≥ 53 dB; L′n,w ≤ 46 dB |`).join("\n");
  const pdf = await artifactPdf({
    title: "Schallschutz – Entwurf für Müller", version: 3, projectId: "project",
    status: "Draft / In review",
    sources: [{ versionId: known, fileName: "Prüfbericht Außenwand.pdf", version: 7 }],
    sourceVersionIds: [known, missing],
    content: `# Konzept\n\n**Wichtige Prüfung** für Größe, Türen und Fußböden. [${known}, ${missing}]\n\n- Wand prüfen\n- Decke prüfen\n\n1. Entwurf lesen\n2. Freigabe prüfen\n\n| Bauteil | Maßnahme | Akustik |\n| --- | --- | --- |\n${rows}\n\nAbschluss nach der Tabelle.\n\n<script>EXECUTABLE_SENTINEL</script>\n\n![IMAGE_SENTINEL](https://invalid.example/image.png)`,
  });
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  const directory = await mkdtemp(join(tmpdir(), "artifact-pdf-"));
  try {
    const path = join(directory, "concept.pdf");
    await writeFile(path, pdf);
    const extraction = Bun.spawnSync(["pdftotext", "-layout", path, "-"]);
    expect(extraction.exitCode).toBe(0);
    const text = extraction.stdout.toString();
    for (const value of ["Müller", "Wichtige Prüfung", "Größe", "Türen", "Fußböden",
      "Prüfbericht Außenwand.pdf", "v7", "Source unavailable", "Source register",
      "Draft / In review", "Revision 3", "R′w ≥ 53 dB", "L′n,w ≤ 46 dB",
      "Wand prüfen", "2. Freigabe prüfen", "Bauteil 110", "Abschluss nach der Tabelle."])
      expect(text).toContain(value);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toContain("EXECUTABLE_SENTINEL");
    expect(text).not.toContain("IMAGE_SENTINEL");
    const pages = text.split("\f").filter(page => page.trim());
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) {
      expect(page).toContain("Draft / In review");
      expect(page).toContain("richtfest");
    }
    // Every row survives table pagination, including the last row.
    for (let i = 1; i <= 110; i++) expect(text).toMatch(new RegExp(`Bauteil ${i}\\s`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concept report includes original mixed-size sources, accurate contents and rejects unavailable evidence", async () => {
  const versionId = "11111111-1111-4111-8111-111111111111";
  const source = await PDFDocument.create();
  source.addPage([595, 842]).drawText("ORIGINAL CALCULATION - source signature only", { x: 40, y: 740, size: 16 });
  source.addPage([842, 595]).drawText("ORIGINAL LANDSCAPE PLAN", { x: 40, y: 500, size: 20 });
  const bytes = Buffer.from(await source.save());
  const template = {
    id: "exterior-noise-concept" as const, version: 1 as const, language: "en" as const,
    project: { name: "Müller building", number: "P-42", client: "Client", designer: "Designer", author: "Specialist", date: "2026-10-12" },
    preliminaryRemarks: "Draft for review.", exteriorNoiseAssessment: "No calculation performed.",
    planningLaw: "Development plan referenced.", components: "| Component | Value |\n| --- | --- |\n| Wall | 53 dB |",
    plans: "Imported plan follows.", sourcesAndRevisions: "Version 7 only.", openIssues: "Review required.", calculationAppendix: "Imported calculation follows.",
    attachments: [
      { versionId, pageStart: 2, pageEnd: 2, label: "Plan", section: "plans" },
      { versionId, pageStart: 1, pageEnd: 1, label: "Calculation", section: "calculationAppendix" },
    ],
  };
  const content = `# Acoustic concept · Exterior noise\n\nTemplate 1 · Draft\n\n| Project information | Value |\n| --- | --- |\n| Project | Müller building |\n\n## Contents\n\n- old contents\n\n## 1. Preliminary remarks\n\nDraft for review.\n\n## 2. Exterior-noise assessment\n\nNo calculation performed.\n\n## 3. Development plan\n\nDevelopment plan referenced.\n\n## 4. Component specifications\n\n${template.components}\n\n## 5. Exterior-noise plans\n\nImported plan follows.\n\n## Sources and revisions\n\nVersion 7 only.\n\n## Appendix · Calculation evidence\n\nImported calculation follows.`;
  const input = { title: "Acoustic concept", content, template,
    version: 4, status: "proposed", projectId: "project", sourceVersionIds: [versionId],
    sources: [{ versionId, fileName: "Prüfbericht Müller.pdf", version: 7 }],
    readSourcePdf: async (project: string, version: string) => {
      expect(project).toBe("project"); expect(version).toBe(versionId); return bytes;
    },
  };
  const pdf = await artifactPdf(input);
  const document = await PDFDocument.load(pdf);
  expect(document.getAuthor()).toBe("Richtfest");
  expect(document.getTitle()).toBe(input.title);
  expect(document.getPages().some(page => page.getWidth() === 842 && page.getHeight() === 659)).toBe(true);
  expect(document.getPages().some(page => page.getWidth() === 595 && page.getHeight() === 906)).toBe(true);
  const directory = await mkdtemp(join(tmpdir(), "concept-report-"));
  try {
    const path = join(directory, "report.pdf");
    await writeFile(path, pdf);
    const extraction = Bun.spawnSync(["pdftotext", "-layout", path, "-"]);
    expect(extraction.exitCode).toBe(0);
    const pages = extraction.stdout.toString().split("\f").filter(page => page.trim());
    expect(pages[0]).toContain("Müller building");
    expect(pages[0]).not.toContain("Contents");
    expect(pages[1]).toContain("Contents");
    for (let i = 0; i < pages.length; i++) expect(pages[i]).toContain(`${i + 1} / ${pages.length}`);
    for (const [index, page] of pages.entries()) {
      if (index > 1 && /Exterior-noise plans/.test(page))
        expect(pages[1]).toMatch(new RegExp(`Exterior-noise plans\\s+${index + 1}\\b`));
      if (page.includes("ORIGINAL")) {
        expect(page).toContain("IMPORTED UNVERIFIED SOURCE");
        expect(page).toContain("Prüfbericht Müller.pdf");
        expect(page).toContain("v7");
        expect(page).not.toContain("richtfest");
      } else expect(page).toContain("richtfest");
    }
    if (process.env.PDF_REVIEW_PATH) await writeFile(process.env.PDF_REVIEW_PATH, pdf);
  } finally { await rm(directory, { recursive: true, force: true }); }
  await expect(artifactPdf({ ...input, sources: [] })).rejects.toMatchObject({ status: 422 });
  await expect(artifactPdf({ ...input, sourceVersionIds: [] })).rejects.toMatchObject({ status: 422 });
  await expect(artifactPdf({ ...input, readSourcePdf: async () => null })).rejects.toMatchObject({ status: 422 });
  await expect(artifactPdf({ ...input, readSourcePdf: async () => Buffer.from("not a PDF") })).rejects.toMatchObject({ status: 422 });
  await expect(artifactPdf({ ...input, template: { ...template, attachments: [{ ...template.attachments[0], pageEnd: 3 }] } })).rejects.toMatchObject({ status: 422 });
});

test("concept deduplicates only byte-identical overlapping pages after validating every alias", async () => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const source = await PDFDocument.create();
  for (let i = 1; i <= 3; i++) source.addPage(i === 2 ? [842, 595] : [595, 842])
    .drawText(`ORIGINAL PAGE ${i}`, { x: 48, y: 400 });
  const bytes = Buffer.from(await source.save());
  // Same page artwork and extracted text, but different complete source bytes.
  source.setTitle("Different original metadata");
  const different = Buffer.from(await source.save());
  expect(bytes.equals(different)).toBe(false);
  const attachments = [
    { versionId: ids[0], pageStart: 1, pageEnd: 2, label: "First evidence", section: "plans" },
    { versionId: ids[1], pageStart: 2, pageEnd: 3, label: "Alias evidence", section: "calculationAppendix" },
    { versionId: ids[0], pageStart: 1, pageEnd: 2, label: "Same revision again", section: "calculationAppendix" },
    { versionId: ids[2], pageStart: 1, pageEnd: 3, label: "Distinct bytes", section: "calculationAppendix" },
  ];
  const reads: string[] = [];
  const input = {
    title: "Deduplication review", version: 5, status: "proposed", projectId: "project",
    content: "# Report\n\nUnchanged prose.\n\n## 1. Exterior-noise plans\n\nPlans.\n\n## 2. Calculation evidence\n\nEvidence.",
    template: { id: "exterior-noise-concept", version: 1, language: "en", attachments },
    sources: ids.map((versionId, i) => ({ versionId, fileName: "Same name.pdf", version: i + 1 })),
    sourceVersionIds: ids,
    readSourcePdf: async (_project: string, id: string) => {
      reads.push(id); return id === ids[2] ? different : bytes;
    },
  };
  const pdf = await artifactPdf(input);
  expect(reads).toEqual(ids);
  const document = await PDFDocument.load(pdf);
  const manifest = JSON.parse(document.getSubject()!);
  expect(manifest).toContainEqual(expect.objectContaining({ versionId: ids[1], sourcePages: [2, 2], retainedReportPage: 5 }));
  expect(manifest).toContainEqual(expect.objectContaining({ versionId: ids[1], sourcePages: [3, 3], retainedAttachment: null }));
  const directory = await mkdtemp(join(tmpdir(), "dedup-report-"));
  try {
    const path = join(directory, "report.pdf");
    await writeFile(path, pdf);
    const extraction = Bun.spawnSync(["pdftotext", "-layout", path, "-"]);
    expect(extraction.exitCode).toBe(0);
    const text = extraction.stdout.toString();
    const pages = text.split("\f").filter(page => page.trim());
    expect(pages).toHaveLength(12);
    expect(pages.filter(page => page.includes("ORIGINAL PAGE"))).toHaveLength(6);
    for (let i = 1; i <= 3; i++) expect(text.match(new RegExp(`ORIGINAL PAGE ${i}`, "g"))).toHaveLength(2);
    expect(text).toContain("Alias evidence");
    expect(text).toContain("Same revision again");
    expect(text).toContain("report pages 5");
    expect(text).toContain("report pages 4–5");
    expect(pages[1]).toMatch(/Calculation evidence\s+6\b/);
    expect(pages[6]).toContain("Cross-reference");
    for (let i = 0; i < pages.length; i++) expect(pages[i]).toContain(`${i + 1} / ${pages.length}`);
    if (process.env.PDF_DEDUP_REVIEW_PATH) await writeFile(process.env.PDF_DEDUP_REVIEW_PATH, pdf);
  } finally { await rm(directory, { recursive: true, force: true }); }
  await expect(artifactPdf({ ...input, readSourcePdf: async (_p, id) => id === ids[1] ? null : bytes })).rejects.toMatchObject({ status: 422 });
  await expect(artifactPdf({ ...input, sources: input.sources.filter(s => s.versionId !== ids[1]) })).rejects.toMatchObject({ status: 422 });
  await expect(artifactPdf({ ...input, sourceVersionIds: [ids[0], ids[2]] })).rejects.toMatchObject({ status: 422 });
  await expect(artifactPdf({ ...input, template: { ...input.template, attachments: attachments.map(a => a.versionId === ids[1] ? { ...a, pageEnd: 4 } : a) } })).rejects.toMatchObject({ status: 422 });
});

test("Nachweis PDF preserves saved arithmetic, boundary signs, blocked rooms and scenario notes", async () => {
  const versionId = "11111111-1111-4111-8111-111111111111";
  const provenance = { kind: "source", versionId, page: 12, excerpt: "Synthetic input schedule, not project evidence." };
  // S_s = 0.8 S_G; base requirement 35, allowance 2. Single-element Rw = total Rw.
  const rooms = [36.9999, 37, 37.5, 37.5001].map((rwDb, i) => ({
    standard: "DIN 4109-1/-2:2018-01", room: { id: `R${i + 1}`, use: "residential_accommodation_classroom", floorAreaM2: 10, provenance },
    applicability: { assessment: "standard_exterior_noise", basis: "Synthetic applicability", provenance },
    envelopeComplete: true, elementsComplete: true, flanking: { assessment: "negligible", provenance },
    facades: [{ id: "F1", areaM2: 8, provenance, noise: { metric: "La", levelDb: 65, basis: "Synthetic assessed La", provenance } }],
    elements: [{ kind: "area", id: "W1", facadeId: "F1", areaM2: 8, rwDb, construction: "window_or_door",
      ratingBasis: "installed_configuration", configuration: "Synthetic installed window", provenance }],
  }));
  rooms.push({ ...structuredClone(rooms[0]!), room: { ...rooms[0]!.room, id: "Unsupported" }, flanking: { assessment: "required", provenance } });
  const inventory = [...rooms.map(r => ({ roomId: r.room.id, provenance })), { roomId: "Missing", provenance }];
  const common = { engine: "richtfest-acoustics", version: 1, unit: "dB", reviewStatus: "not_reviewed",
    formula: "R_w,ges = -10 log10(sum(n_i * 10^(-R_e,i,w/10)))", reference: "https://example.invalid/method",
    intermediates: [], limitations: [] };
  // Saved results are independent fixtures: the exporter must not recalculate them.
  const results = rooms.map((room, i) => ({ roomId: room.room.id, status: i === 4 ? "unsupported" : "calculated", result: {
    ...common, input: { ...room, method: "exterior_noise_facade" }, method: "exterior_noise_facade",
    status: i === 4 ? "unsupported" : "calculated", value: i === 4 ? null : room.elements[0]!.rwDb,
    limitations: i === 4 ? ["Flanking is required or unresolved."] : [],
    ...(i === 4 ? {} : { exteriorNoise: { baseRequiredDb: 35, geometryCorrectionDb: 0, prognosisUncertaintyDb: 2, targetRwDb: 37,
      marginDb: [-0.0001, 0, 0.5, 0.5001][i], comparison: i === 0 ? "below_numeric_target" : "meets_numeric_target" } }),
  } }));
  const dataset = acousticDatasetSchema.parse({ version: 1, basedOn: { artifactId: crypto.randomUUID(), revisionId: crypto.randomUUID() },
    blockers: ["Confirm the source geometry before release."], receipt: {
      ...common, method: "exterior_noise_batch", status: "unsupported", value: null,
      input: { method: "exterior_noise_batch", scope: "Synthetic verification · not a customer project", inventory, rooms },
      batch: { complete: false, issues: ["Missing: calculation inputs are missing."], rooms: [...results, { roomId: "Missing", status: "missing_input", result: null }] },
      receiptId: crypto.randomUUID(),
    },
  });
  const input = { title: "Schallschutznachweis · Synthetische Prüfvariante", version: 3, status: "draft", projectId: "project",
    acousticDataset: dataset, sourceVersionIds: [versionId], sources: [{ versionId, fileName: "Synthetic inputs.pdf", version: 2 }],
    content: `# Variantenänderungen\n\nGrund: synthetic scenario reason retained.\n\n| Feld | Bisher | Variante |\n| --- | --- | --- |\n| window Rw | 36 | 36.9999 |\n\n${renderAcousticCalculationReceipts([dataset.receipt], "de")}\n\nAfterword retained.`,
  };
  const pdf = await artifactPdf(input);
  const directory = await mkdtemp(join(tmpdir(), "nachweis-pdf-"));
  try {
    const path = join(directory, "report.pdf"); await writeFile(path, pdf);
    const extraction = Bun.spawnSync(["pdftotext", "-layout", path, "-"]);
    expect(extraction.exitCode).toBe(0);
    const text = extraction.stdout.toString();
    const pages = text.split("\f").filter(p => p.trim());
    expect(pages[0]).toContain("Prüfbericht");
    expect(pages[1]).toContain("Prüfbericht");
    expect(pages[2]).toContain("Schallschutznachweis · Außenlärm");
    const review = pages.slice(0, 2).join("\n");
    expect(review).toContain("6 deklarierte Räume");
    expect(review).toContain("2 offen"); expect(review).toContain("1 unter Ziel");
    expect(review).toMatch(/2 mit 0–0,5 dB\s+Reserve/);
    expect(review).toMatch(/R1 · Unter Ziel · Reserve -0,000100 dB/);
    expect(review.indexOf("Missing · Nicht berechenbar")).toBeLessThan(review.indexOf("R1 · Unter Ziel"));
    expect(review.indexOf("R1 · Unter Ziel")).toBeLessThan(review.indexOf("R2 · Reserve"));
    for (const id of ["R1", "R2", "R3", "R4", "Unsupported", "Missing"]) expect(text).toContain(`Raum ${id}`);
    expect(text).toContain("35,000"); expect(text).toContain("36.9999");
    expect(text).toContain("Flanking is required or unresolved");
    expect(text).toContain("Berechnungseingaben fehlen");
    expect(text).toContain("Synthetic inputs.pdf"); expect(text).toContain("Seite 12");
    expect(text).toContain("synthetic scenario reason retained"); expect(text).toContain("Afterword retained");
    expect(text).not.toContain("Source unavailable"); expect(text).not.toContain(versionId);
    for (const [i, p] of pages.entries()) expect(p).toContain(`${i + 1} / ${pages.length}`);
    for (const match of review.matchAll(/(R\d) ·[^\n]*Seite (\d+)/g))
      expect(pages[Number(match[2]) - 1]).toContain(`Raum ${match[1]}`);
    if (process.env.NACHWEIS_REVIEW_PATH) await writeFile(process.env.NACHWEIS_REVIEW_PATH, pdf);
    // Unmatched historical prose is never silently replaced by a different dataset.
    const historical = await artifactPdf({ ...input, content: "Historical prose retained without reconstruction." });
    await writeFile(path, historical);
    const legacyText = Bun.spawnSync(["pdftotext", path, "-"]).stdout.toString();
    expect(legacyText).toContain("Historical prose retained"); expect(legacyText).not.toContain("Prüfbericht");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("two-page Prüfbericht overflows explicitly while the Nachweis retains all 100 declared rooms", async () => {
  const provenance = { kind: "assumption", reason: "Synthetic missing-input inventory" };
  const inventory = Array.from({ length: 100 }, (_, i) => ({ roomId: `ROOM-${String(i + 1).padStart(3, "0")}`, provenance }));
  const dataset = acousticDatasetSchema.parse({ version: 1, blockers: [], basedOn: null, receipt: {
    engine: "richtfest-acoustics", version: 1, unit: "dB", reviewStatus: "not_reviewed", method: "exterior_noise_batch",
    status: "unsupported", value: null, formula: "No aggregate dB result", reference: "https://example.invalid/method", intermediates: [], limitations: [],
    input: { method: "exterior_noise_batch", scope: "Overflow fixture", inventory, rooms: [] },
    batch: { complete: false, issues: ["Calculation inputs are missing."],
      rooms: inventory.map(({ roomId }) => ({ roomId, status: "missing_input", result: null })) }, receiptId: crypto.randomUUID(),
  } });
  const pdf = await artifactPdf({ title: "Overflow verification", content: renderAcousticCalculationReceipts([dataset.receipt], "de"),
    version: 1, status: "historical revision", projectId: "project", sourceVersionIds: [], sources: [], acousticDataset: dataset });
  const directory = await mkdtemp(join(tmpdir(), "nachweis-overflow-"));
  try {
    const path = join(directory, "report.pdf"); await writeFile(path, pdf);
    const extraction = Bun.spawnSync(["pdftotext", "-layout", path, "-"]);
    expect(extraction.exitCode).toBe(0);
    const text = extraction.stdout.toString(), pages = text.split("\f").filter(p => p.trim());
    expect(pages[2]).toContain("Schallschutznachweis · Außenlärm");
    expect(pages[1]).toMatch(/\d+ von 100 priorisierten Raumbefunden/);
    expect(pages[1]).toMatch(/\d+ weitere Befunde/);
    for (const r of inventory) expect(text).toContain(`Raum ${r.roomId}`);
    for (const [i, p] of pages.entries()) expect(p).toContain(`historical revision · Revision 1 · ${i + 1} / ${pages.length}`);
    if (process.env.NACHWEIS_OVERFLOW_REVIEW_PATH) await writeFile(process.env.NACHWEIS_OVERFLOW_REVIEW_PATH, pdf);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
