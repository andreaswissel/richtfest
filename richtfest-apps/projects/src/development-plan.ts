/**
 * Noise requirements stated in a Bebauungsplan's text (textliche Festsetzungen,
 * Begründung). Deterministic: only sentences about noise or sound insulation
 * are read, and only what they state literally is kept: Lärmpegelbereiche,
 * maßgebliche Außenlärmpegel, required facade insulation, prescribed measures
 * and the cited DIN 4109 edition. Zones drawn only in the Planzeichnung are
 * not visible here, so several zones are reported as found, never assigned.
 */
export const developmentPlanNoiseMethod = "bebauungsplan_noise_v1";

export type NoiseStatement = { label: string; page: number; quote: string };
export type DevelopmentPlanNoise = {
  noiseZones: string[];
  externalLevels: string[];
  facadeInsulation: string[];
  measures: string[];
  din4109: string[];
  statements: NoiseStatement[];
  /** Compact text for the building's "Bebauungsplan noise requirements"; null when nothing was stated. */
  summary: string | null;
};

const roman = ["I", "II", "III", "IV", "V", "VI", "VII"];
const romanPattern = String.raw`(?:VII|VI|IV|V|III|II|I)`;
const zoneRegex = new RegExp(String.raw`(?:L(?:ä|ae)rmpegelbereich(?:e|en)?|\bLPB)\s*(${romanPattern}(?:\s*(?:,|und|bis|oder|-|–)\s*${romanPattern})*)\b`, "g");
const levelRegex = /ma(?:ß|ss)gebliche[nrs]?\s+Au(?:ß|ss)enl(?:ä|ae)rmpegel[^.\n]{0,60}?(\d{2})(?:\s*(?:-|–|bis)\s*(\d{2}))?\s*dB/gi;
const facadeRegex = /(?:R['’´]?\s*w\s*,\s*(?:ges|res)|(?:erforderliche[ns]?\s+)?(?:gesamte[ns]?\s+)?bewertete[ns]?\s+Bau-?\s*Schalld(?:ä|ae)mm-?\s*Ma(?:ß|ss))[^.\n]{0,40}?(?:≥|>=|von\s+(?:mindestens\s+)?|mindestens\s+|=\s*)?(\d{2})\s*dB/gi;
const dinRegex = /DIN\s*4109(?:\s*[-‑]\s*\d{1,2})?\s*(?::\s*|\(\s*|,\s*)?(?:(?:Ausgabe|Fassung|Stand)\s*:?\s+(?:[A-Za-zäÄ]+\s+)?)?((?:19|20)\d{2})/gi;
const measures: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /schallged(?:ä|ae)mmte\w*\s+(?:L(?:ü|ue)ftung|Be-?\s*und\s+Entl(?:ü|ue)ftung)|fensterunabh(?:ä|ae)ngige\w*\s+L(?:ü|ue)ftung/i, label: "schallgedämmte Lüftung" },
  { pattern: /(?:Schlafr(?:ä|ae)ume|Aufenthaltsr(?:ä|ae)ume|schutzbed(?:ü|ue)rftige\w*\s+R(?:ä|ae)ume)[^.\n]{0,140}l(?:ä|ae)rmabgewandt/i, label: "Grundrissorientierung zur lärmabgewandten Seite" },
  { pattern: /gekippt\w*\s+Fenster|Fenster\w*\s+in\s+Kippstellung/i, label: "Schutz bei gekipptem Fenster" },
  { pattern: /nicht\s+(?:zu\s+)?öffenbar\w*\s+Fenster|festverglas/i, label: "nicht öffenbare Fenster" },
  { pattern: /L(?:ä|ae)rmschutz(?:wand|wall|bebauung)/i, label: "aktiver Lärmschutz (Wand, Wall oder Riegelbebauung)" },
  { pattern: /verglaste\w*\s+(?:Loggien|Balkone|Vorbauten)|Wintergärten|Prallscheibe/i, label: "verglaste Außenbereiche" },
];

const noiseSentence = /l(?:ä|ae)rm|schall|dB\b|DIN\s*4109/i;
const unique = (values: string[]) => [...new Set(values)];
const zoneRange = (text: string) => {
  const found = text.match(new RegExp(romanPattern, "g")) ?? [];
  if (/bis|-|–/.test(text) && found.length === 2) {
    const [from, to] = found.map(value => roman.indexOf(value));
    if (from >= 0 && to > from) return roman.slice(from, to + 1);
  }
  return found;
};

/** Splits page text into sentences; a heading line or a full stop ends one. */
const sentencesOf = (text: string) => text.replace(/\r/g, "")
  // A full stop ends a sentence unless it closes an abbreviation; a numbered clause or a blank line always starts a new one.
  .split(/(?<!\b(?:Nr|Abs|bzw|ggf|gem|vgl|Ziff|Kap|Tab|Anl|S|ca|z\.\s?B|u\.\s?a|d\.\s?h))(?<=[.;])\s+(?=[A-ZÄÖÜ(])|\n(?=\s*\d+(?:\.\d+)*\.?\s)|\n\s*\n/)
  .map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean);

export function readDevelopmentPlanNoise(pages: Array<{ page: number; text: string }>): DevelopmentPlanNoise {
  const result: DevelopmentPlanNoise = { noiseZones: [], externalLevels: [], facadeInsulation: [], measures: [], din4109: [], statements: [], summary: null };
  for (const { page, text } of pages) for (const sentence of sentencesOf(text)) {
    if (!noiseSentence.test(sentence)) continue;
    const labels: string[] = [];
    for (const match of sentence.matchAll(zoneRegex)) { const zones = zoneRange(match[1]); result.noiseZones.push(...zones); labels.push(`Lärmpegelbereich ${zones.join(", ")}`); }
    for (const match of sentence.matchAll(levelRegex)) { const value = match[2] ? `${match[1]}–${match[2]} dB(A)` : `${match[1]} dB(A)`; result.externalLevels.push(value); labels.push(`maßgeblicher Außenlärmpegel ${value}`); }
    for (const match of sentence.matchAll(facadeRegex)) { const value = `R'w,ges ≥ ${match[1]} dB`; result.facadeInsulation.push(value); labels.push(value); }
    for (const measure of measures) if (measure.pattern.test(sentence)) { result.measures.push(measure.label); labels.push(measure.label); }
    for (const match of sentence.matchAll(dinRegex)) { const value = `DIN 4109 (${match[1]})`; result.din4109.push(value); labels.push(`verweist auf ${value}`); }
    for (const label of unique(labels)) result.statements.push({ label, page, quote: sentence.slice(0, 400) });
  }
  result.noiseZones = roman.filter(zone => result.noiseZones.includes(zone));
  result.externalLevels = unique(result.externalLevels);
  result.facadeInsulation = unique(result.facadeInsulation);
  result.measures = unique(result.measures);
  result.din4109 = unique(result.din4109);
  const parts = [
    result.noiseZones.length ? `Lärmpegelbereich${result.noiseZones.length > 1 ? "e" : ""} ${result.noiseZones.join(", ")}${result.noiseZones.length > 1 ? " (Zuordnung zum Baufeld in der Planzeichnung prüfen)" : ""}` : null,
    result.externalLevels.length ? `maßgeblicher Außenlärmpegel ${result.externalLevels.join(", ")}` : null,
    ...result.facadeInsulation,
    ...result.measures,
    ...result.din4109.map(value => `verweist auf ${value}`),
  ].filter(Boolean);
  result.summary = parts.length ? parts.join(" · ").slice(0, 1000) : null;
  return result;
}
