import { derivedWritable, effectiveValue, type ModelProperty } from "./wall-adjacency";

/**
 * Storey level from a floor plan's printed title. Level 0 is the ground floor,
 * upper storeys count up and basements down. Attic and set-back storeys have no
 * number of their own; they sit one above the highest other known storey.
 * Returns null unless the page names exactly one storey.
 */
export type StoreyTitle = { level: number } | { level: "top" };
export type StoreyLevelReading = StoreyTitle & { quote: string };

const ordinal = String.raw`(?:(\d{1,2})\s*\.?\s*)`;
const patterns: Array<{ regex: RegExp; read: (match: RegExpMatchArray) => StoreyTitle }> = [
  { regex: /\b(?:Erdgeschoss|Erdgeschoß|ground\s+floor)\b/gi, read: () => ({ level: 0 }) },
  { regex: /\bEG\b/g, read: () => ({ level: 0 }) },
  { regex: new RegExp(String.raw`\b${ordinal}?(?:Obergeschoss|Obergeschoß)(?:\s*(\d{1,2})\b)?`, "gi"), read: match => ({ level: Number(match[1] ?? match[2] ?? 1) }) },
  { regex: new RegExp(String.raw`\b${ordinal}?OG\b(?:\s*(\d{1,2})\b)?`, "g"), read: match => ({ level: Number(match[1] ?? match[2] ?? 1) }) },
  { regex: /\bOG(\d{1,2})\b/g, read: match => ({ level: Number(match[1]) }) },
  { regex: new RegExp(String.raw`\b${ordinal}?(?:Untergeschoss|Untergeschoß|Kellergeschoss|Kellergeschoß|basement)\b`, "gi"), read: match => ({ level: -Number(match[1] ?? 1) }) },
  { regex: new RegExp(String.raw`\b${ordinal}?(?:UG|KG)\b`, "g"), read: match => ({ level: -Number(match[1] ?? 1) }) },
  { regex: /\b(?:Dachgeschoss|Dachgeschoß|Staffelgeschoss|Staffelgeschoß|attic)\b/gi, read: () => ({ level: "top" }) },
  { regex: /\b(?:DG|SG)\b/g, read: () => ({ level: "top" }) },
];

const readAll = (text: string) => patterns.flatMap(pattern => [...text.matchAll(pattern.regex)].map(match => ({ ...pattern.read(match), quote: match[0].replace(/\s+/g, " ").trim() })));
const distinct = (readings: StoreyLevelReading[]) => [...new Map(readings.map(reading => [String(reading.level), reading])).values()];

export function storeyLevelFromText(text: string): StoreyLevelReading | null {
  // A drawing title ("Grundriss 1. OG") outranks storey names elsewhere on the sheet, such as level marks.
  const titles = [...text.matchAll(/(?:Grundriss|floor\s*plan)\s*[:\-–]?\s*([^\n]{1,40})/gi)].flatMap(match => {
    const found = distinct(readAll(match[1]).filter(reading => match[1].trimStart().startsWith(reading.quote.split(" ")[0])));
    return found.length === 1 ? [{ ...found[0], quote: match[0].replace(/\s+/g, " ").trim() }] : [];
  });
  const titled = distinct(titles);
  if (titled.length === 1) return titled[0];
  if (titled.length > 1) return null;
  const anywhere = distinct(readAll(text));
  return anywhere.length === 1 ? anywhere[0] : null;
}

type Storey = { id: string; buildingId: string; levelIndex: number | null };
export type PlannedStoreyLevel = { storeyId: string; level: number | null; write: boolean; quote: string | null };

/**
 * Effective level per storey and which inferred proposals to write. A level a
 * person entered or reviewed, or the storey's own level, always wins; a title
 * reading only fills the gap. "Top" storeys resolve against the others.
 */
export function planStoreyLevels(input: { storeys: Storey[]; properties: ModelProperty[]; readings: Map<string, StoreyLevelReading> }): PlannedStoreyLevel[] {
  const property = (storeyId: string) => input.properties.find(item => item.entityType === "storey" && item.entityId === storeyId && item.propertyKey === "level");
  const known = new Map<string, number>();
  for (const storey of input.storeys) {
    const entered = effectiveValue(property(storey.id));
    const level = typeof entered === "number" ? entered : storey.levelIndex;
    if (level !== null && level !== undefined) known.set(storey.id, level);
  }
  // Numbered readings first, so an attic can sit above them.
  const proposed = new Map<string, { level: number; quote: string }>();
  for (const storey of input.storeys) {
    const reading = input.readings.get(storey.id);
    if (!known.has(storey.id) && reading && reading.level !== "top") proposed.set(storey.id, { level: reading.level, quote: reading.quote });
  }
  for (const storey of input.storeys) {
    const reading = input.readings.get(storey.id);
    if (known.has(storey.id) || reading?.level !== "top") continue;
    const others = input.storeys.filter(other => other.buildingId === storey.buildingId && other.id !== storey.id)
      .flatMap(other => { const level = known.get(other.id) ?? proposed.get(other.id)?.level; return level === undefined ? [] : [level]; });
    if (others.length) proposed.set(storey.id, { level: Math.max(...others) + 1, quote: reading.quote });
  }
  return input.storeys.map(storey => {
    const level = known.get(storey.id) ?? proposed.get(storey.id)?.level ?? null;
    const quote = proposed.get(storey.id)?.quote ?? null;
    return { storeyId: storey.id, level, quote, write: quote !== null && derivedWritable(property(storey.id), level) };
  });
}
