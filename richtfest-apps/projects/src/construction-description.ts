import type { ComponentConstruction, WallRole } from "@richtfest/shared";

/**
 * Component statements from a construction description (Baubeschreibung).
 * Deterministic: a statement names a wall role or the ceilings and states
 * construction, material, thickness or bulk density in the same passage.
 * A value is kept only when the passage states it once; anything ambiguous is
 * left out rather than guessed. Results are proposals for review.
 */
export const constructionDescriptionMethod = "baubeschreibung_v1";

export type ComponentTarget = { componentType: "wall"; wallRole: WallRole } | { componentType: "ceiling"; wallRole: null };
export type ComponentStatement = ComponentTarget & {
  values: Partial<{ construction: ComponentConstruction; material: string; thickness: number; bulkDensity: number }>;
  quote: string; page: number;
};

// Order matters: the more specific heading wins where one passage could match several.
const targets: Array<{ target: ComponentTarget; pattern: RegExp }> = [
  { target: { componentType: "wall", wallRole: "apartment_partition" }, pattern: /wohnungstrennw(?:and|ände|aende)/i },
  { target: { componentType: "wall", wallRole: "stairwell" }, pattern: /treppen(?:haus|raum)(?:wand|wände|waende)|w(?:ände|aende)\s+(?:zum|zu)\s+treppen(?:haus|raum)/i },
  { target: { componentType: "wall", wallRole: "corridor_partition" }, pattern: /flurtrennw(?:and|ände|aende)|w(?:ände|aende)\s+(?:zum|zu)\s+(?:flur|laubengang|gemeinschaftsflur)/i },
  { target: { componentType: "wall", wallRole: "exterior" }, pattern: /au(?:ß|ss)enw(?:and|ände|aende)/i },
  { target: { componentType: "wall", wallRole: "internal" }, pattern: /(?:nichttragende\s+)?innenw(?:and|ände|aende)|trennw(?:ände|aende)\s+innerhalb\s+(?:der|einer)\s+wohnung/i },
  { target: { componentType: "ceiling", wallRole: null }, pattern: /wohnungstrenndecken?|geschossdecken?|^\s*(?:\d+(?:\.\d+)*\.?\s+)?decken?\b/im },
];

// Words match in any case; abbreviations such as KS or STB only in capitals.
const materials: Array<{ pattern: RegExp; material: string; construction: ComponentConstruction }> = [
  { pattern: /[Kk]alksand(?:stein|vollstein|lochstein)|KALKSAND|\bKS[VL]?\b/, material: "Kalksandstein", construction: "masonry" },
  { pattern: /[Pp]orenbeton|PORENBETON/, material: "Porenbeton", construction: "masonry" },
  { pattern: /[Hh]ochlochziegel|HOCHLOCHZIEGEL|\bHLZ\b/, material: "Hochlochziegel", construction: "masonry" },
  { pattern: /[Ll]eichtbeton|LEICHTBETON/, material: "Leichtbeton", construction: "masonry" },
  { pattern: /(?<![Hh]ochloch)[Zz]iegel|(?<!HOCHLOCH)ZIEGEL/, material: "Ziegel", construction: "masonry" },
  { pattern: /[Ss]tahlbeton|STAHLBETON|\bSt[Bb]\b|\bSTB\b/, material: "Stahlbeton", construction: "concrete" },
  { pattern: /[Gg]ipskarton|[Gg]ipsfaser|[Mm]etallst(?:ä|ae)nder|[Ss]t(?:ä|ae)nderwand|[Tt]rockenbau|\bGK\b/, material: "Gipskarton-Ständerwand", construction: "drywall" },
  { pattern: /[Bb]rettsperrholz|[Hh]olzrahmen|[Hh]olzst(?:ä|ae)nder/, material: "Holz", construction: "timber" },
];

const number = (raw: string) => Number(raw.replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
const once = <T,>(values: T[]) => { const unique = [...new Set(values)]; return unique.length === 1 ? unique[0] : undefined; };

function readValues(passage: string): ComponentStatement["values"] {
  const values: ComponentStatement["values"] = {};
  const material = once(materials.filter(item => item.pattern.test(passage)).map(item => item.material));
  // "Kalksandstein" also contains "stein"; only one named material per passage counts.
  const found = materials.find(item => item.material === material);
  if (found) { values.material = found.material; values.construction = found.construction; }
  else if (/mauerwerk/i.test(passage) && !materials.some(item => item.pattern.test(passage))) values.construction = "masonry";
  else if (/\bbeton\b/i.test(passage) && !materials.some(item => item.pattern.test(passage))) values.construction = "concrete";
  const thicknesses = [
    ...[...passage.matchAll(/(\d{1,2}(?:[.,]\d)?)\s*cm\b/gi)].map(match => number(match[1])),
    ...[...passage.matchAll(/(\d{2,3})\s*mm\b/gi)].map(match => number(match[1]) / 10),
  ].filter(value => value >= 5 && value <= 80);
  const thickness = once(thicknesses);
  if (thickness !== undefined) values.thickness = thickness;
  const densities = [
    // Rohdichteklasse 1,8 / RDK 2,0 / Rohdichte 1.8 kg/dm³ are in kg/dm³.
    ...[...passage.matchAll(/(?:RDK|Rohdichte(?:klasse)?)\s*[:=]?\s*(\d[.,]\d{1,2})\b(?!\s*\d)/gi)].map(match => Math.round(number(match[1]) * 1000)),
    ...[...passage.matchAll(/(\d{1,2}\.?\d{3})\s*kg\s*\/\s*m(?:³|3)/gi)].map(match => number(match[1])),
  ].filter(value => value >= 300 && value <= 3000);
  const bulkDensity = once(densities);
  if (bulkDensity !== undefined) values.bulkDensity = bulkDensity;
  return values;
}

/** Splits page text into passages at each component heading and reads the values stated there. */
export function readConstructionDescription(pages: Array<{ page: number; text: string }>): ComponentStatement[] {
  const statements: ComponentStatement[] = [];
  for (const { page, text } of pages) {
    const markers = targets.flatMap(({ target, pattern }) => [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map(match => ({ target, index: match.index! })))
      .sort((a, b) => a.index - b.index)
      // A later, less specific heading inside a specific one ("Decken" in "Wohnungstrenndecken") is not a new passage.
      .filter((marker, index, all) => index === 0 || marker.index > all[index - 1].index + 2);
    markers.forEach((marker, index) => {
      // A passage runs to the next component heading, a blank line or 400 characters.
      const end = Math.min(markers[index + 1]?.index ?? text.length, marker.index + 400);
      const raw = text.slice(marker.index, end);
      const passage = raw.split(/\n\s*\n/)[0];
      const values = readValues(passage);
      if (Object.keys(values).length) statements.push({ ...marker.target, values, page, quote: passage.replace(/\s+/g, " ").trim().slice(0, 240) });
    });
  }
  return statements;
}

/**
 * One value per target and field across the whole document. Statements that
 * disagree cancel each other; the field is reported as conflicting instead.
 */
export function mergeComponentStatements(statements: ComponentStatement[]) {
  const key = (target: ComponentTarget) => `${target.componentType}:${target.wallRole}`;
  const merged = new Map<string, { target: ComponentTarget; values: Record<string, { value: unknown; quote: string; page: number }>; conflicts: string[] }>();
  for (const statement of statements) {
    const entry = merged.get(key(statement)) ?? { target: { componentType: statement.componentType, wallRole: statement.wallRole } as ComponentTarget, values: {}, conflicts: [] };
    for (const [field, value] of Object.entries(statement.values)) {
      if (entry.conflicts.includes(field)) continue;
      const existing = entry.values[field];
      if (!existing) entry.values[field] = { value, quote: statement.quote, page: statement.page };
      else if (existing.value !== value) { delete entry.values[field]; entry.conflicts.push(field); }
    }
    merged.set(key(statement), entry);
  }
  return [...merged.values()];
}
