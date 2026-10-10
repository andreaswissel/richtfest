import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPdf } from "./artifact-pdf";

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
    for (const page of pages) expect(page).toContain("Draft / In review");
    // Every row survives table pagination, including the last row.
    for (let i = 1; i <= 110; i++) expect(text).toMatch(new RegExp(`Bauteil ${i}\\s`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
