import { createRequire } from "node:module";
import { acousticInputProvenance, sourceReferenceLabel, type AcousticDataset } from "@richtfest/shared";
import type { ArtifactPdfInput } from "./artifact-pdf";

/** Layout of saved arithmetic, not a second calculator or a compliance decision. */
export async function acousticCalculationPdf(input: ArtifactPdfInput, dataset: AcousticDataset, notesPdf?: Buffer) {
  const [{ default: PDFDocument }, { PDFDocument: PDF, rgb }, { default: fontkit }] = await Promise.all([
    import("pdfkit"), import("pdf-lib"), import("@pdf-lib/fontkit"),
  ]);
  const require = createRequire(import.meta.url);
  const fontPath = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
  const doc = new PDFDocument({ size: "A4", margins: { top: 76, bottom: 52, left: 44, right: 44 }, bufferPages: true });
  const bytes = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont("body", fontPath);
  doc.registerFont("bold", require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"));
  const left = 44, width = doc.page.width - 88, bottom = doc.page.height - 58;
  const clean = (s: unknown) => String(s ?? "—").replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[Referenz]");
  const num = (n: number | null | undefined, precision = 3) => n == null ? "—"
    : (n !== 0 && Math.abs(n) < 10 ** -precision ? n.toPrecision(3) : n.toFixed(precision)).replace(".", ",");
  let running = "Prüfbericht · Außenlärm";
  const pageTitles = [running];
  const header = () => {
    doc.font("bold").fontSize(11).fillColor("#222222").text("richtfest.", left, 28, { lineBreak: false });
    doc.font("body").fontSize(8).text(running, 220, 30, { width: width - 176, height: 18, align: "right", ellipsis: true });
    doc.moveTo(left, 55).lineTo(left + width, 55).lineWidth(0.5).strokeColor("#999999").stroke();
    doc.x = left; doc.y = 76;
  };
  // Paint headers after flowing content so page breaks never change its font.
  doc.on("pageAdded", () => pageTitles.push(running));
  const page = () => doc.bufferedPageRange().count;
  const ensure = (height: number) => { if (doc.y + height > bottom) doc.addPage(); };
  const text = (s: string, size = 9, bold = false) => {
    doc.font(bold ? "bold" : "body").fontSize(size).fillColor("#222222");
    ensure(Math.min(80, doc.heightOfString(clean(s), { width, lineGap: 2 })));
    doc.font(bold ? "bold" : "body").fontSize(size).text(clean(s), left, doc.y, { width, lineGap: 2 }); doc.y += 5;
  };
  const heading = (s: string) => { ensure(65); text(s, 13, true); };
  const table = (titles: string[], rows: string[][], fractions: number[]) => {
    const widths = fractions.map(f => f * width);
    const row = (cells: string[], bold: boolean) => {
      doc.font(bold ? "bold" : "body").fontSize(8);
      const h = Math.max(...cells.map((v, i) => doc.heightOfString(clean(v), { width: widths[i]! - 10, lineGap: 1 }))) + 10;
      if (doc.y + h > bottom) { doc.addPage(); if (!bold) row(titles, true); }
      const y = doc.y;
      let x = left;
      cells.forEach((v, i) => {
        doc.font(bold ? "bold" : "body").fontSize(8).fillColor("#222222")
          .text(clean(v), x + 5, y + 4, { width: widths[i]! - 10, lineGap: 1 });
        x += widths[i]!;
      });
      doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(bold ? 0.7 : 0.25).strokeColor("#aaaaaa").stroke();
      doc.y = y + h; doc.x = left;
    };
    row(titles, true); for (const values of rows) row(values, false); doc.y += 9;
  };
  const receipt = dataset.receipt, batch = receipt.batch!;
  const rows = batch.rooms.map((row, index) => {
    const r = row.result;
    const eligible = r && acousticInputProvenance(r.input).some(p => p.kind === "source");
    const numeric = row.status === "calculated" && r?.status === "calculated" && eligible ? r.exteriorNoise : undefined;
    const margin = numeric?.marginDb;
    const rank = margin == null ? 0 : margin < 0 ? 1 : margin <= 0.5 ? 2 : 3;
    const label = ["Nicht berechenbar", "Unter Ziel", "Reserve ≤ 0,5 dB", "Über 0,5 dB Reserve"][rank]!;
    const reason = row.status === "missing_input" ? "Berechnungseingaben fehlen."
      : row.status === "invalid_inventory" ? "Rauminventar widersprüchlich; siehe offene Berechnungspunkte."
      : r?.status === "unsupported" ? r.limitations[0]!
      : !eligible ? "Kein quellenbelegtes Projektergebnis; nur Annahmen."
      : "Kein vollständiger numerischer Vergleich gespeichert.";
    return { ...row, numeric, rank, label, reason, index };
  });
  const evidence = new Map<string, number>();
  const evidenceValues: ReturnType<typeof acousticInputProvenance> = [];
  const cite = (p: typeof evidenceValues[number]) => {
    const key = JSON.stringify(p);
    if (!evidence.has(key)) { evidenceValues.push(p); evidence.set(key, evidenceValues.length); }
    return `[${evidence.get(key)}]`;
  };
  receipt.input.inventory.forEach(r => cite(r.provenance));
  const detailPages = new Map<number, number>();
  const refs: { page: number; y: number; index: number }[] = [];

  // Reserve exactly two pages; full findings and evidence remain in the Nachweis.
  heading("Prüfbericht · Außenlärm");
  text(input.title, 11, true);
  text(`Revision ${input.version} · ${input.status} · ${receipt.input.scope}`);
  text("Rechenstand, keine automatische fachliche Freigabe. Regelwerksanwendung, Eingaben und Freigabe sind fachlich zu prüfen. Die Prioritäten beschreiben nur die numerische Folge, nicht eine rechtliche Bewertung oder Bauteilempfehlung.");
  text(`${rows.length} deklarierte Räume · ${rows.filter(r => r.rank > 0).length} numerisch vergleichbar · ${rows.filter(r => r.rank === 0).length} offen · ${rows.filter(r => r.rank === 1).length} unter Ziel · ${rows.filter(r => r.rank === 2).length} mit 0–0,5 dB Reserve.`, 10, true);
  text("Reihenfolge: fehlende Bewertungsgrundlage → rechnerische Unterschreitung → geringe Reserve. Status aus ungerundeten Werten; 0,5 dB ist eine Prüfpriorität, keine Normgrenze.");
  const findings = rows.filter(r => r.rank < 3).sort((a, b) => a.rank - b.rank
    || (a.numeric?.marginDb ?? 0) - (b.numeric?.marginDb ?? 0) || a.roomId.localeCompare(b.roomId));
  let shown = 0;
  for (const row of findings) {
    const message = `${row.roomId} · ${row.label}${row.numeric ? ` · Reserve ${num(row.numeric.marginDb, 6)} dB` : ""}`;
    doc.font("bold").fontSize(9);
    const height = doc.heightOfString(clean(message), { width: width - 66, lineGap: 2 }) + 31;
    if (doc.y + height > bottom - 190) {
      if (page() === 2) break;
      doc.addPage(); heading("Prüfbericht · Fortsetzung");
    }
    refs.push({ page: page() - 1, y: doc.y, index: row.index });
    doc.font("bold").fontSize(9).text(clean(message), left, doc.y, { width: width - 66, lineGap: 2 }); doc.y += 3;
    text(row.rank === 0 ? "Eingaben / Geltungsbereich klären; vollständiger Grund im Rechenblatt."
      : row.rank === 1 ? "Eingaben und Auslegung anhand des berechneten Fehlbetrags prüfen."
      : "Geringe numerische Reserve fachlich prüfen.", 8);
    shown++;
  }
  if (page() === 1) { doc.addPage(); heading("Prüfbericht · Prüfauftrag"); }
  text(`${shown} von ${findings.length} priorisierten Raumbefunden hier aufgeführt. ${findings.length - shown} weitere Befunde stehen vollständig in der Raumübersicht und den Rechenblättern ab Seite 3.`, 9, true);
  text(`${dataset.blockers.length} übernommene Quellenhinweise; ${batch.issues.length} offene Berechnungspunkte. Volltext und Belege im Anhang. Bauteilwechsel, Formsache und Tag-/Nacht-Alternativen werden ohne geprüfte Varianten nicht behauptet.`);
  text("Freigabeauftrag: Anwendbarkeit und bereits bewertete Außenpegel bestätigen, offene Eingaben klären, negative bzw. knappe Reserven prüfen. Eine vollständige Raumabdeckung bedeutet nicht, dass alle Ziele erreicht oder Eingaben geprüft sind.");

  running = "Schallschutznachweis · Raumübersicht"; doc.addPage();
  heading("Schallschutznachweis · Außenlärm");
  text(`${receipt.input.scope} · ${receipt.engine} v${receipt.version}`);
  text("Erfordernis = Basis + Geometriekorrektur. Vorhanden = gespeicherter Gesamtwert − 2 dB Prognoseabschlag. Anzeige gerundet; Status aus ungerundeten Werten. Keine erneute Berechnung beim PDF-Export.");
  table(["Raum / Inventarbeleg", "Erfordernis\ndB", "Vorhanden\ndB", "Reserve\ndB", "Numerischer Status"], rows.map(row => [
    `${row.roomId} ${cite(receipt.input.inventory[row.index]!.provenance)}`,
    num(row.numeric ? row.numeric.targetRwDb - row.numeric.prognosisUncertaintyDb : null),
    num(row.numeric && row.result?.value != null ? row.result.value - row.numeric.prognosisUncertaintyDb : null),
    num(row.numeric?.marginDb, 6), row.label,
  ]), [0.31, 0.16, 0.16, 0.14, 0.23]);

  for (const row of rows) {
    running = `Raum ${clean(row.roomId)} · Fortsetzung`;
    ensure(160); detailPages.set(row.index, page());
    heading(`Raum ${row.roomId}`);
    const r = row.result;
    if (!r || r.input.method !== "exterior_noise_facade") { text(`${row.label}: ${row.reason}`); continue; }
    const room = r.input;
    const uses = { hospital_bedroom: "Bettenraum", office: "Büro", residential_accommodation_classroom: "Wohn-, Übernachtungs- oder Unterrichtsraum" };
    const terms: Record<string, string> = { standard_exterior_noise: "Regelfall Außenlärm", special_assessment_required: "Sonderbeurteilung erforderlich",
      unknown: "ungeklärt", negligible: "vernachlässigbar", required: "zu berücksichtigen", installed_configuration: "Einbausituation berücksichtigt",
      unadjusted_lab: "unkorrigierter Laborwert", massive: "Massivbau", lightweight: "Leichtbau", window_or_door: "Fenster / Tür" };
    text(`S_G = ${room.room.floorAreaM2} m² · ${uses[room.room.use]} ${cite(room.room.provenance)}`);
    text(`Anwendbarkeit: ${terms[room.applicability.assessment]} – ${room.applicability.basis} ${cite(room.applicability.provenance)}; Flanken: ${terms[room.flanking.assessment]} ${cite(room.flanking.provenance)}. Hülle vollständig: ${room.envelopeComplete ? "ja" : "nein"}; Bauteile vollständig: ${room.elementsComplete ? "ja" : "nein"}.`, 8);
    table(["Fassade", "S_s m²", "La dB", "Bewertungsansatz / Belege"], room.facades.map(f => [
      f.id, String(f.areaM2), String(f.noise.levelDb), `${f.noise.basis} ${cite(f.provenance)} ${cite(f.noise.provenance)}`,
    ]), [0.2, 0.13, 0.12, 0.55]);
    const intermediate = (name: string) => r.intermediates.find(v => v.label === name)?.value;
    if (row.numeric) {
      text(`Basis = max(${num(intermediate("Maximum assessed La"))} − ${num(intermediate("Room-use factor K_Raumart"))}; ${num(intermediate("Minimum base requirement"))}) = ${num(row.numeric.baseRequiredDb)} dB.`, 8);
      text(`K_AL = 10 log10(${num(intermediate("Total exterior area S_s"))} / (0,8 × ${room.room.floorAreaM2})) = ${num(row.numeric.geometryCorrectionDb)} dB.`, 8);
      text(`Anforderung: Basis ${num(row.numeric.baseRequiredDb)} + K_AL ${num(row.numeric.geometryCorrectionDb)} = ${num(row.numeric.targetRwDb - row.numeric.prognosisUncertaintyDb)} dB.`, 10, true);
    }
    table(["Bauteil / Fassade", "Fläche m² / Anzahl", "Rw / Dn,e,w\ndB", "K_LPB\ndB", "R_e,i,w\ndB"], room.elements.map(e => [
      `${e.id} / ${e.facadeId} ${cite(e.provenance)}`,
      e.kind === "area" ? String(e.areaM2) : `${e.count} × ${e.openingAreaM2} (Öffnung)`,
      e.kind === "area" ? `Rw ${e.rwDb}` : `Dn,e,w ${e.dnEWDb}`,
      num(row.numeric ? intermediate(`${e.id}: exposure correction K_LPB`) : null),
      num(row.numeric ? intermediate(`${e.id}: normalized R_e,i,w per element`) : null),
    ]), [0.34, 0.18, 0.18, 0.14, 0.16]);
    for (const e of room.elements) text(`${e.id}: ${e.configuration}; ${terms[e.ratingBasis]}${e.kind === "area" ? `; ${terms[e.construction]}` : "; A0 = 10 m² je Element"} ${cite(e.provenance)}`, 8);
    if (row.numeric) {
      ensure(100);
      text("Berechnung · gespeicherte Rechenschritte", 10, true);
      text("R_e,i,w = Kennwert + 10 log10(S_s / S_i bzw. A0) + K_LPB; bei kleinen Elementen gilt A0 = 10 m² je Element. Beiträge einschließlich Anzahl n_i:", 8);
      table(["Bauteil", "n_i × 10^(−R_e,i,w / 10)"], room.elements.map(e => [e.id,
        String(intermediate(`${e.id}: transmission contribution including count`) ?? "—")]), [0.5, 0.5]);
      text(`R_w,ges = −10 log10(Σ Beiträge) = ${r.value} dB.`, 9);
      text(`Gesamt ${num(r.value)} − ${row.numeric.prognosisUncertaintyDb} dB = ${num(r.value! - row.numeric.prognosisUncertaintyDb)} dB vorhanden.`, 10, true);
      text(`Reserve ${num(row.numeric.marginDb, 6)} dB · ${row.label}`, 10, true);
    } else text(`${row.label}: ${row.reason}`, 10, true);
    if (room.fieldEvidence?.length) table(["Eingabefeld", "Beleg"], room.fieldEvidence.map(e => [e.field, cite(e.provenance)]), [0.8, 0.2]);
  }
  running = "Nachweis · Quellen und Prüfbedarf"; doc.addPage();
  heading("Offene Berechnungspunkte und Quellenhinweise");
  for (const note of [...batch.issues, ...dataset.blockers]) text(note);
  if (!batch.issues.length && !dataset.blockers.length) text("Keine gespeicherten offenen Berechnungspunkte oder Quellenhinweise.");
  heading("Eingabebelege");
  const sources = new Map(input.sources.map(s => [s.versionId.toLowerCase(), s]));
  table(["Nr.", "Herkunft / Fundstelle"], evidenceValues.map((p, i) => {
    const source = p.kind === "source" ? sources.get(p.versionId.toLowerCase()) : undefined;
    return [String(i + 1), p.kind === "source"
      ? `${source ? sourceReferenceLabel(source) : "Quelle nicht verfügbar"} · Seite ${p.page ?? "nicht angegeben"}\n${p.excerpt}`
      : `Annahme: ${p.reason}`];
  }), [0.08, 0.92]);
  heading("Gespeicherte Rechenvorschriften");
  for (const formula of new Set(rows.flatMap(r => r.numeric && r.result ? [r.result.formula] : []))) text(formula, 8);
  heading("Methodengrenzen");
  for (const note of new Set([...receipt.limitations, ...rows.flatMap(r => r.result?.limitations ?? [])])) text(note, 8);
  pageTitles.forEach((title, index) => { doc.switchToPage(index); running = title; header(); });
  for (const ref of refs) {
    doc.switchToPage(ref.page);
    doc.font("body").fontSize(8).text(`Seite ${detailPages.get(ref.index)}`, left + width - 60, ref.y,
      { width: 60, align: "right", lineBreak: false });
  }
  doc.end();
  const result = await PDF.load(await bytes);
  if (notesPdf) {
    const notes = await PDF.load(notesPdf);
    for (const p of await result.copyPages(notes, notes.getPageIndices())) result.addPage(p);
  }
  result.registerFontkit(fontkit);
  const font = await result.embedFont(await Bun.file(fontPath).arrayBuffer(), { subset: true });
  const pages = result.getPages();
  pages.forEach((p, i) => p.drawText(`${clean(input.status)} · Revision ${input.version} · ${i + 1} / ${pages.length}`,
    { x: left, y: 26, size: 8, font, color: rgb(0.4, 0.4, 0.4) }));
  result.setTitle(input.title); result.setAuthor("Richtfest");
  return Buffer.from(await result.save());
}
