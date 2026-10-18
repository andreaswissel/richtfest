import { createRequire } from "node:module";
import { feasibilityScenarioInputs, feasibilityUnits, type FeasibilityResult, type FeasibilityStudy, type FeasibilityValue } from "@richtfest/shared";

type ReportInput = {
  project: { name: string; address: string | null };
  study: FeasibilityStudy;
  results: FeasibilityResult[];
  method: string;
  language: "de" | "en";
};

const text = {
  de: {
    title: "Machbarkeit · Erste wirtschaftliche Einschätzung", revision: "Stand", scenario: "Szenario", existing: "Bestand erhalten", densify: "Nachverdichtung & Sanierung", new_build: "Neubau",
    residual: "Residualwert Grundstück", perParcel: "je m² Grundstück", headroom: "Spielraum ggü. Kaufpreis", revenue: "Erlös", construction: "Bau- und Sanierungskosten", financing: "Finanzierung",
    marketing: "Vermarktung", profit: "Entwicklergewinn", totalCosts: "Gesamtkosten ohne Grundstück", livingArea: "Wohnfläche", incomplete: "Unvollständig", missing: "Fehlende Eingaben",
    inputs: "Eingaben", site: "Grundstück", source: "Quelle", entered: "Eingabe", standard: "Kalkulations-Standard", building_model: "Gebäudemodell", site_assessment: "Grundstücksprüfung", reviewed: "geprüft", unreviewed: "ungeprüft",
    sale: "Verkauf", rent: "Vermietung (kapitalisiert)", revenueMode: "Verwertung", notes: "Anmerkungen", indicative: "Vorläufig: {count} verwendete Eingaben sind noch ungeprüft.",
    disclaimer: "Indikative Residualwertrechnung (Methode {method}) aus den sichtbaren Eingaben. Keine Verkehrswertermittlung, kein Beleihungswert und keine Genehmigungsplanung. Richtwerte aus Kalkulations-Standards sind Erfahrungswerte und projektspezifisch zu prüfen.",
    invalid: "Ungültige Eingaben", parcelArea: "Grundstücksfläche", askingPrice: "Kaufpreis", acquisitionCostRate: "Erwerbsnebenkosten",
    existingLivingArea: "Bestandswohnfläche", renovationCost: "Sanierungskosten", newGrossFloorArea: "Neue Geschossfläche", livingAreaRatio: "Wohnflächenfaktor", constructionCost: "Baukosten KG 300–700",
    contingencyRate: "Wagnis", demolitionCost: "Abbruch / Freimachung", otherCost: "Sonstige Kosten", salePrice: "Verkaufspreis", monthlyRent: "Miete", operatingCostRate: "Bewirtschaftung",
    capitalizationRate: "Kapitalisierungszins", financingRate: "Finanzierung", marketingRate: "Vermarktung", subsidies: "Fördermittel", profitRate: "Entwicklergewinn",
  },
  en: {
    title: "Feasibility · First economic assessment", revision: "Revision", scenario: "Scenario", existing: "Keep existing", densify: "Densify & renovate", new_build: "New build",
    residual: "Residual land value", perParcel: "per m² parcel", headroom: "Headroom vs. asking price", revenue: "Revenue", construction: "Construction and renovation costs", financing: "Financing",
    marketing: "Marketing", profit: "Developer profit", totalCosts: "Total costs excluding land", livingArea: "Living area", incomplete: "Incomplete", missing: "Missing inputs",
    inputs: "Inputs", site: "Site", source: "Source", entered: "Entered", standard: "Calculation standard", building_model: "Building model", site_assessment: "Site assessment", reviewed: "reviewed", unreviewed: "unreviewed",
    sale: "Sale", rent: "Rental (capitalised)", revenueMode: "Exit", notes: "Notes", indicative: "Preliminary: {count} inputs used are not reviewed yet.",
    disclaimer: "Indicative residual land value calculation (method {method}) from the visible inputs. Not a market valuation, lending value or permit planning. Calculation standards are experience values to verify per project.",
    invalid: "Invalid inputs", parcelArea: "Parcel area", askingPrice: "Asking price", acquisitionCostRate: "Acquisition costs",
    existingLivingArea: "Existing living area", renovationCost: "Renovation cost", newGrossFloorArea: "New floor area", livingAreaRatio: "Living area ratio", constructionCost: "Construction cost KG 300–700",
    contingencyRate: "Contingency", demolitionCost: "Demolition / site clearance", otherCost: "Other costs", salePrice: "Sale price", monthlyRent: "Rent", operatingCostRate: "Operating costs",
    capitalizationRate: "Capitalisation rate", financingRate: "Financing", marketingRate: "Marketing", subsidies: "Subsidies", profitRate: "Developer profit",
  },
} as const;

/** Server-only renderer: a one-page comparison plus the inputs and their sources, from the saved revision. */
export async function studyReportPdf(input: ReportInput): Promise<Buffer> {
  const { default: PDFDocument } = await import("pdfkit");
  const require = createRequire(import.meta.url);
  const l = text[input.language];
  const locale = input.language === "de" ? "de-DE" : "en-GB";
  const euro = (value: number | null) => value === null ? "–" : `${Math.round(value).toLocaleString(locale)} €`;
  const number = (value: number | null | undefined, unit: string) => value === null || value === undefined ? "–" : `${value.toLocaleString(locale, { maximumFractionDigits: 2 })} ${unit}`;
  const doc = new PDFDocument({ size: "A4", margins: { top: 48, bottom: 48, left: 48, right: 48 }, bufferPages: true, info: { Title: `${l.title} · ${input.project.name}`, Author: "Richtfest" } });
  const done = new Promise<Buffer>((resolve, reject) => { const chunks: Buffer[] = []; doc.on("data", chunk => chunks.push(Buffer.from(chunk))); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  doc.registerFont("body", require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"));
  doc.registerFont("bold", require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"));
  const width = doc.page.width - 96;
  const heading = (value: string, size = 11) => { doc.moveDown(0.8); doc.font("bold").fontSize(size).fillColor("#111").text(value, 48); doc.moveDown(0.3); };
  /** A row of cells across fixed column widths; returns after the tallest cell. */
  const row = (cells: string[], widths: number[], bold = false, shade = false, align: Array<"left" | "right"> = []) => {
    const y = doc.y, heights = cells.map((cell, index) => doc.font(bold ? "bold" : "body").fontSize(8.5).heightOfString(cell, { width: widths[index]! - 6 }));
    const height = Math.max(...heights) + 6;
    if (y + height > doc.page.height - 60) { doc.addPage(); return row(cells, widths, bold, shade, align); }
    if (shade) doc.rect(48, y, width, height).fill("#f3f4f6");
    let x = 48;
    cells.forEach((cell, index) => { doc.font(bold ? "bold" : "body").fontSize(8.5).fillColor("#111").text(cell, x + 3, y + 3, { width: widths[index]! - 6, align: align[index] ?? (index === 0 ? "left" : "right") }); x += widths[index]!; });
    doc.y = y + height; doc.x = 48;
  };

  doc.font("bold").fontSize(15).fillColor("#111").text(l.title);
  doc.font("body").fontSize(9.5).fillColor("#444").text([input.project.name, input.project.address].filter(Boolean).join(" · "));
  doc.text(`${l.revision} r${input.study.revision}${input.study.updatedAt ? ` · ${new Date(input.study.updatedAt).toLocaleDateString(locale)}` : ""}`);

  const columns = [width * 0.34, width * 0.22, width * 0.22, width * 0.22];
  heading(l.scenario);
  row(["", ...input.results.map(result => l[result.kind])], columns, true, true);
  const line = (label: string, pick: (result: FeasibilityResult) => string, bold = false) => row([label, ...input.results.map(pick)], columns, bold);
  line(l.revenueMode, result => l[input.study.scenarios.find(s => s.kind === result.kind)!.revenueMode]);
  line(l.livingArea, result => number(result.livingArea, "m²"));
  line(l.revenue, result => euro(result.revenue));
  line(l.construction, result => euro(result.constructionCosts));
  line(l.financing, result => euro(result.financing));
  line(l.marketing, result => euro(result.marketing));
  line(l.totalCosts, result => euro(result.totalCosts));
  line(l.profit, result => euro(result.profit));
  line(l.residual, result => result.status === "complete" ? euro(result.residualLandValue) : l.incomplete, true);
  line(l.perParcel, result => result.residualPerParcelArea === null ? "–" : `${euro(result.residualPerParcelArea)}/m²`);
  if (input.study.site.askingPrice?.value != null) line(l.headroom, result => euro(result.headroom), true);
  const missing = input.results.filter(result => result.missing.length);
  for (const result of missing) doc.font("body").fontSize(8).fillColor("#7f1d1d").text(`${l[result.kind]} · ${l.missing}: ${result.missing.map(key => l[key as keyof typeof l] ?? key).join(", ")}`, 48);
  for (const result of input.results) {
    if (result.invalid.length) doc.font("body").fontSize(8).fillColor("#7f1d1d").text(`${l[result.kind]} · ${l.invalid}: ${result.invalid.map(key => l[key as keyof typeof l] ?? key).join(", ")}`, 48);
    if (result.unreviewed.length) doc.font("body").fontSize(8).fillColor("#444").text(`${l[result.kind]} · ${l.indicative.replace("{count}", String(result.unreviewed.length))}`, 48);
  }

  // Only saved inputs belong in a revision report; today's model limits may have changed since it was saved.
  const sourceLabel = (state: FeasibilityValue | undefined) => !state || state.value === null ? "" : `${l[state.source]} · ${state.reviewed ? l.reviewed : l.unreviewed}${state.note ? ` · ${state.note}` : ""}`;
  const inputColumns = [width * 0.3, width * 0.2, width * 0.5];
  heading(`${l.inputs} · ${l.site}`, 10);
  for (const key of ["parcelArea", "askingPrice", "acquisitionCostRate"] as const) {
    const state = input.study.site[key];
    row([l[key], number(state?.value, feasibilityUnits[key]), sourceLabel(state)], inputColumns, false, false, ["left", "right", "left"]);
  }
  for (const scenario of input.study.scenarios) {
    heading(`${l.inputs} · ${l[scenario.kind]} (${l[scenario.revenueMode]})`, 10);
    for (const key of feasibilityScenarioInputs(scenario.kind, scenario.revenueMode)) {
      const state = scenario.values[key];
      row([l[key], number(state?.value, feasibilityUnits[key]), sourceLabel(state)], inputColumns, false, false, ["left", "right", "left"]);
    }
  }
  if (input.study.notes.trim()) { heading(l.notes, 10); doc.font("body").fontSize(8.5).fillColor("#111").text(input.study.notes, 48, doc.y, { width }); }

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index++) {
    doc.switchToPage(index);
    // The footer sits inside the bottom margin; without this pdfkit would start a new page for it.
    doc.page.margins.bottom = 0;
    doc.font("body").fontSize(7).fillColor("#666").text(l.disclaimer.replace("{method}", input.method), 48, doc.page.height - 40, { width: width - 40, lineBreak: true, height: 30 });
    doc.text(`${index + 1}/${range.count}`, 48 + width - 30, doc.page.height - 40, { width: 30, align: "right" });
  }
  doc.end();
  return done;
}
