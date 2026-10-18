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
  // A full stop ends a sentence unless it closes an abbreviation (incl. "ü. NHN"); a numbered clause or a blank line always starts a new one.
  .split(/(?<!\b(?:Nr|Abs|bzw|ggf|gem|vgl|Ziff|Kap|Tab|Anl|S|ca|z\.\s?B|u\.\s?a|d\.\s?h))(?<!\sü\.)(?<=[.;])\s+(?=[A-ZÄÖÜ(])|\n(?=\s*\d+(?:\.\d+)*\.?\s)|\n\s*\n/)
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

/**
 * Art und Maß der baulichen Nutzung stated in a Bebauungsplan's text: the
 * Baugebiet type, GRZ, GFZ, number of Vollgeschosse, building, ridge and eave
 * heights and the Bauweise. Deterministic and literal like the noise reader:
 * only what a sentence states is kept, with the Baugebiet it names. Values
 * entered only in the Planzeichnung (Nutzungsschablone) are not visible here.
 * Nothing is checked against the building; see zoningLimits in
 * @richtfest/shared for the approved numbers a later check would use.
 */
export const developmentPlanZoningMethod = "bebauungsplan_zoning_v1";

export type ZoningKey = "bebauungsplanAreaType" | "bebauungsplanGrz" | "bebauungsplanGfz" | "bebauungsplanStoreys" | "bebauungsplanHeight" | "bebauungsplanBauweise";
export type ZoningStatement = { key: ZoningKey; label: string; page: number; quote: string };
export type DevelopmentPlanZoning = {
  /** BauNVO area codes as stated, e.g. "WA" or "WA 1". */
  areaTypes: string[];
  grz: string[];
  gfz: string[];
  storeys: string[];
  heights: string[];
  bauweise: string[];
  statements: ZoningStatement[];
  /** One compact proposal per building property; absent when the text states nothing for it. */
  values: Partial<Record<ZoningKey, string>>;
};

/** BauNVO area types by name; abbreviations are only read next to a name or in a sentence that sets the type. */
const areaTypes: Array<{ code: string; name: RegExp }> = [
  { code: "WS", name: /Kleinsiedlungsgebiet/i },
  { code: "WR", name: /reine[ns]?\s+Wohngebiet/i },
  { code: "WA", name: /allgemeine[ns]?\s+Wohngebiet/i },
  { code: "WB", name: /besondere[ns]?\s+Wohngebiet/i },
  { code: "MDW", name: /d(?:ö|oe)rfliche[ns]?\s+Wohngebiet/i },
  { code: "MD", name: /Dorfgebiet/i },
  { code: "MI", name: /Mischgebiet/i },
  { code: "MU", name: /urbane[ns]?\s+Gebiet/i },
  { code: "MK", name: /Kerngebiet/i },
  { code: "GE", name: /Gewerbegebiet/i },
  { code: "GI", name: /Industriegebiet/i },
  { code: "SO", name: /Sondergebiet/i },
];
const areaCodeRegex = /\b(MDW|WS|WR|WA|WB|MD|MI|MU|MK|GE|GI|SO)(?:\s*(\d{1,2}(?:\.\d)?))?\b/g;
const setsAreaType = /festgesetzt|Art\s+der\s+baulichen\s+Nutzung/i;
const zoningSentence = /gebiet|Grundfl(?:ä|ae)chenzahl|\bGRZ\b|Geschossfl(?:ä|ae)chenzahl|\bGFZ\b|Vollgeschoss|(?:Geb(?:ä|ae)ude|First|Trauf|Wand)h(?:ö|oe)he|Oberkante|Bauweise|Einzelh(?:ä|ae)user|Doppelh(?:ä|ae)user|Hausgruppen/i;
const grzRegex = /Grundfl(?:ä|ae)chenzahl|\bGRZ\b/gi;
const gfzRegex = /Geschossfl(?:ä|ae)chenzahl|\bGFZ\b/gi;
// GRZ cannot exceed 1; requiring a decimal comma keeps paragraph numbers (§ 19 Abs. 4) out.
const grzValue = /\b(0,\d{1,2}|1,0)\b/g;
const gfzValue = /\b(\d,\d{1,2})\b/g;
// A value belongs to the nearest keyword before it: windows end at the next parameter.
const nextParameter = /Grundfl(?:ä|ae)chenzahl|\bGRZ\b|Geschossfl(?:ä|ae)chenzahl|\bGFZ\b|Vollgeschoss|h(?:ö|oe)he\b|Oberkante|Bauweise/gi;
// Case-sensitive so a lone "i" or "kein" is not a count; a word may start a sentence capitalised.
const word = (value: string) => `[${value[0].toUpperCase()}${value[0]}]${value.slice(1)}`;
const numberWords: Record<string, number> = { ein: 1, eine: 1, eins: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10 };
const storeyNumber = String.raw`(?:\d{1,2}|X|IX|VIII|VII|VI|IV|V|III|II|I|${["ein(?:e|s)?", "zwei", "drei", "vier", "f(?:ü|ue)nf", "sechs", "sieben", "acht", "neun", "zehn"].map(word).join("|")})`;
const storeyQualifier = String.raw`(${["h(?:ö|oe)chstens", "maximal", "max\\.", "bis\\s+zu", "zwingend", "mindestens"].map(word).join("|")})`;
const storeyRegex = new RegExp(String.raw`(?:${storeyQualifier}\s+)?\b(${storeyNumber})(?:\s*(?:-|–|bis)\s*(${storeyNumber}))?\s+(?:zul(?:ä|ae)ssige\w*\s+)?Vollgeschoss`, "g");
const storeyAfterRegex = new RegExp(String.raw`Vollgeschosse?\w*\s*(?::|betr(?:ä|ae)gt|von|wird\s+auf)?\s*(?:${storeyQualifier}\s+)?\b(${storeyNumber})\b(?:\s*(?:-|–|bis)\s*(${storeyNumber})\b)?(?:\s*\((H(?:ö|oe)chstma(?:ß|ss)|zwingend|Mindestma(?:ß|ss))\))?`, "g");
const heightRegex = /(Geb(?:ä|ae)udeh(?:ö|oe)he|Firsth(?:ö|oe)he|Traufh(?:ö|oe)he|Wandh(?:ö|oe)he|Oberkante)([^\n;]{0,70}?)(\d{1,3}(?:,\d{1,2})?)\s*m\b(\s*(?:ü(?:ber|\.)\s*(?:NHN|NN)))?/gi;
const bauweiseRegex = /\b(offene|geschlossene|abweichende)[nr]?\s+Bauweise|\bnur\s+(Einzel-\s*und\s+Doppelh(?:ä|ae)user|Einzelh(?:ä|ae)user|Doppelh(?:ä|ae)user|Hausgruppen)/gi;

const romanValue = (value: string) => { const index = roman.indexOf(value.toUpperCase()); return index >= 0 ? index + 1 : value.toUpperCase() === "VIII" ? 8 : value.toUpperCase() === "IX" ? 9 : value.toUpperCase() === "X" ? 10 : null; };
const storeyCount = (value: string) => /^\d+$/.test(value) ? Number(value) : romanValue(value) ?? numberWords[value.toLowerCase()] ?? null;
const toRoman = (count: number) => ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][count - 1] ?? String(count);
const qualifierOf = (raw: string | undefined) => !raw ? null : /zwingend/i.test(raw) ? "zwingend" : /mindest/i.test(raw) ? "mindestens" : "höchstens";
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** The last Baugebiet code a sentence names before a position, so "im WA 2 0,35" keeps its area. */
const areaBefore = (sentence: string, index: number) => {
  let area: string | null = null;
  for (const match of sentence.slice(0, index).matchAll(areaCodeRegex)) area = match[2] ? `${match[1]} ${match[2]}` : match[1];
  return area;
};
/** Values after each mention of a keyword in a sentence, up to the next mention. */
const valuesAfter = (sentence: string, keyword: RegExp, value: RegExp) => {
  const starts = [...sentence.matchAll(keyword)].map(match => match.index! + match[0].length);
  return starts.flatMap(start => {
    const next = [...sentence.slice(start).matchAll(nextParameter)][0]?.index;
    return [...sentence.slice(start, start + Math.min(next ?? Infinity, 120)).matchAll(value)].map(match => ({ value: match[1], index: start + match.index! }));
  });
};
const withArea = (value: string, area: string | null) => area ? `${value} (${area})` : value;
/** Several values without a Baugebiet each are reported as found, never assigned. */
const joinValues = (values: string[]) => !values.length ? undefined
  : `${values.join(" · ")}${values.length > 1 && values.some(value => !/\)$/.test(value)) ? " (Zuordnung zum Baufeld in der Planzeichnung prüfen)" : ""}`.slice(0, 300);

export function readDevelopmentPlanZoning(pages: Array<{ page: number; text: string }>): DevelopmentPlanZoning {
  const result: DevelopmentPlanZoning = { areaTypes: [], grz: [], gfz: [], storeys: [], heights: [], bauweise: [], statements: [], values: {} };
  const keep = (key: ZoningKey, label: string, page: number, sentence: string) => result.statements.push({ key, label, page, quote: sentence.slice(0, 400) });
  for (const { page, text } of pages) for (const sentence of sentencesOf(text)) {
    if (!zoningSentence.test(sentence)) continue;
    const labels = new Map<string, ZoningKey>();
    const named = areaTypes.filter(type => type.name.test(sentence));
    // "Im WA 2 gilt …" mentions an area; a name or a festsetzen sentence states its type.
    if (named.length || setsAreaType.test(sentence)) {
      const codes = [...sentence.matchAll(areaCodeRegex)].map(match => match[2] ? `${match[1]} ${match[2]}` : match[1]);
      // A name without its abbreviation still states the type.
      for (const code of unique([...codes, ...named.map(type => type.code).filter(code => !codes.some(value => value.split(" ")[0] === code))])) {
        result.areaTypes.push(code); labels.set(`Baugebiet ${code}`, "bebauungsplanAreaType");
      }
    }
    const exceeds = /(?:ü|ue)berschrit|(?:Ü|Ue)berschreitung/i.test(sentence);
    for (const { value, index } of valuesAfter(sentence, grzRegex, grzValue)) {
      const stated = withArea(exceeds ? `bis ${value} bei Überschreitung nach § 19 Abs. 4 BauNVO` : value, areaBefore(sentence, index));
      result.grz.push(stated); labels.set(`GRZ ${stated}`, "bebauungsplanGrz");
    }
    for (const { value, index } of valuesAfter(sentence, gfzRegex, gfzValue)) {
      const stated = withArea(value, areaBefore(sentence, index)); result.gfz.push(stated); labels.set(`GFZ ${stated}`, "bebauungsplanGfz");
    }
    const storeyMatches = [...sentence.matchAll(storeyRegex)].map(match => ({ qualifier: match[1], from: match[2], to: match[3], index: match.index! }));
    if (!storeyMatches.length) for (const match of sentence.matchAll(storeyAfterRegex)) storeyMatches.push({ qualifier: match[1] ?? match[4], from: match[2], to: match[3], index: match.index! });
    for (const match of storeyMatches) {
      const from = storeyCount(match.from), to = match.to ? storeyCount(match.to) : null;
      if (!from || from > 30 || (to !== null && (to <= from || to > 30))) continue;
      const qualifier = to ? null : qualifierOf(match.qualifier);
      const stated = withArea(to ? `${toRoman(from)}–${toRoman(to)}` : qualifier ? `${qualifier} ${toRoman(from)}` : toRoman(from), areaBefore(sentence, match.index));
      result.storeys.push(stated); labels.set(`Vollgeschosse ${stated}`, "bebauungsplanStoreys");
    }
    for (const match of sentence.matchAll(heightRegex)) {
      // "Die maximale Gebäudehöhe beträgt …" qualifies before the keyword, "Traufhöhe max. …" after it.
      const between = sentence.slice(Math.max(0, match.index! - 20), match.index!) + match[2];
      const qualifier = /mindest/i.test(between) ? "min." : /h(?:ö|oe)chst|max|zul(?:ä|ae)ssig|bis/i.test(between) ? "max." : null;
      const kind = capitalize(match[1].replace(/oe/g, "ö").replace(/ae/g, "ä").toLowerCase());
      const stated = withArea(`${kind}${qualifier ? ` ${qualifier}` : ""} ${match[3]} m${match[4] ? " ü. NHN" : ""}`, areaBefore(sentence, match.index!));
      result.heights.push(stated); labels.set(stated, "bebauungsplanHeight");
    }
    for (const match of sentence.matchAll(bauweiseRegex)) {
      const stated = withArea(match[1] ? `${match[1].toLowerCase()} Bauweise` : `nur ${match[2].replace(/ae/g, "ä")}`, areaBefore(sentence, match.index!));
      result.bauweise.push(stated); labels.set(stated, "bebauungsplanBauweise");
    }
    for (const [label, key] of labels) keep(key, label, page, sentence);
  }
  result.areaTypes = unique(result.areaTypes);
  // A bare code is dropped when the same type is also stated with its number.
  result.areaTypes = result.areaTypes.filter(code => code.includes(" ") || !result.areaTypes.some(other => other.startsWith(`${code} `)));
  result.grz = unique(result.grz); result.gfz = unique(result.gfz); result.storeys = unique(result.storeys);
  result.heights = unique(result.heights); result.bauweise = unique(result.bauweise);
  const values: Array<[ZoningKey, string | undefined]> = [
    ["bebauungsplanAreaType", result.areaTypes.length ? result.areaTypes.join(", ").slice(0, 300) : undefined],
    ["bebauungsplanGrz", joinValues(result.grz)],
    ["bebauungsplanGfz", joinValues(result.gfz)],
    ["bebauungsplanStoreys", joinValues(result.storeys)],
    ["bebauungsplanHeight", result.heights.length ? result.heights.join(" · ").slice(0, 300) : undefined],
    ["bebauungsplanBauweise", result.bauweise.length ? result.bauweise.join(" · ").slice(0, 300) : undefined],
  ];
  result.values = Object.fromEntries(values.filter(([, value]) => value));
  return result;
}
