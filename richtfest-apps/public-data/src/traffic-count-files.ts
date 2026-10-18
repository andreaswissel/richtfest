import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";

/**
 * Minimal readers for the file formats count sources publish (ZIP, XLSX,
 * semicolon CSV, ESRI Shapefile + dBASE). Only what the importers need; no
 * formulas, styles or projections beyond ETRS89 / UTM.
 */

const inflate = promisify(inflateRaw);
const MAX_ENTRY_BYTES = 400_000_000;

// --- ZIP ---

export type ZipEntry = { name: string; method: number; compressed: number; expanded: number; offset: number };

export function zipEntries(zip: Buffer): ZipEntry[] {
  let end = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 22 - 65535); p--) if (zip.readUInt32LE(p) === 0x06054b50) { end = p; break; }
  if (end < 0) throw new Error("Not a ZIP archive");
  const count = zip.readUInt16LE(end + 10), start = zip.readUInt32LE(end + 16);
  if (start === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  const entries: ZipEntry[] = [];
  for (let p = start, i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
    if (zip.readUInt16LE(p + 8) & 1) throw new Error("Encrypted ZIP entries are not supported");
    const nl = zip.readUInt16LE(p + 28), el = zip.readUInt16LE(p + 30), cl = zip.readUInt16LE(p + 32);
    entries.push({ name: zip.toString("utf8", p + 46, p + 46 + nl), method: zip.readUInt16LE(p + 10), compressed: zip.readUInt32LE(p + 20), expanded: zip.readUInt32LE(p + 24), offset: zip.readUInt32LE(p + 42) });
    p += 46 + nl + el + cl;
  }
  return entries;
}

export async function zipRead(zip: Buffer, entry: ZipEntry): Promise<Buffer> {
  if (entry.expanded > MAX_ENTRY_BYTES) throw new Error("ZIP entry too large");
  const p = entry.offset;
  if (zip.readUInt32LE(p) !== 0x04034b50) throw new Error("Invalid ZIP local header");
  const start = p + 30 + zip.readUInt16LE(p + 26) + zip.readUInt16LE(p + 28);
  const data = zip.subarray(start, start + entry.compressed);
  const out = entry.method === 0 ? Buffer.from(data) : entry.method === 8 ? await inflate(data) : null;
  if (!out) throw new Error("Unsupported ZIP compression");
  if (out.length !== entry.expanded) throw new Error("ZIP entry size mismatch");
  return out;
}

export async function zipFile(zip: Buffer, match: (name: string) => boolean): Promise<Buffer | null> {
  const entry = zipEntries(zip).find(item => match(item.name));
  return entry ? zipRead(zip, entry) : null;
}

// --- Text ---

const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
export const unescapeXml = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) =>
  code[0] === "#" ? String.fromCodePoint(code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : xmlEntities[code.toLowerCase()]!);

/** ISO-8859-15 differs from windows-1252 in eight positions; BASt CSVs use it. */
const latin9: Record<string, string> = { "¤": "€", "¦": "Š", "¨": "š", "´": "Ž", "¸": "ž", "¼": "Œ", "½": "œ", "¾": "Ÿ" };
export const decodeLatin9 = (bytes: Uint8Array) => new TextDecoder("windows-1252").decode(bytes).replace(/[¤¦¨´¸¼½¾]/g, c => latin9[c]!);

/** Semicolon CSV with optional double quotes; yields header-keyed rows. */
export function* csvRows(text: string, delimiter = ";"): Generator<Record<string, string>> {
  let header: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cell = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quoted) { if (c === "\"" && line[i + 1] === "\"") { cell += "\""; i++; } else if (c === "\"") quoted = false; else cell += c; }
      else if (c === "\"") quoted = true;
      else if (c === delimiter) { cells.push(cell); cell = ""; }
      else cell += c;
    }
    cells.push(cell);
    if (!header) { header = cells.map(item => item.trim()); continue; }
    if (cells.length < header.length - 1) continue; // trailer lines
    yield Object.fromEntries(header.map((key, i) => [key, (cells[i] ?? "").trim()]));
  }
}

/** German-formatted CSV numbers: "69.950" (thousands), "16,4" (decimal), plain "575". Not for XLSX/dBASE values, which use a decimal point. */
export function germanNumber(value: string | null | undefined): number | null {
  const text = value?.trim();
  if (!text || text === "-") return null;
  const normalised = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(text) ? text.replaceAll(".", "").replace(",", ".") : text.includes(",") ? text.replace(",", ".") : text;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}
/** Machine-formatted numbers (XLSX, dBASE); blanks, dashes and overflow markers are null. */
export function plainNumber(value: string | null | undefined): number | null {
  const text = value?.trim();
  if (!text || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// --- XLSX ---

const columnIndex = (ref: string) => { let n = 0; for (const c of ref) { const code = c.charCodeAt(0); if (code < 65 || code > 90) break; n = n * 26 + code - 64; } return n - 1; };
const texts = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1]!)).join("");

/** Rows of the named worksheet as arrays of cell strings (shared and inline strings resolved). */
export async function* xlsxRows(zip: Buffer, sheetName: string): AsyncGenerator<string[]> {
  const entries = zipEntries(zip), read = async (name: string) => { const entry = entries.find(item => item.name === name); return entry ? (await zipRead(zip, entry)).toString("utf8") : null; };
  const workbook = await read("xl/workbook.xml"), rels = await read("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("Not an XLSX workbook");
  const sheet = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(m => m[0]).find(tag => unescapeXml(/\bname="([^"]*)"/.exec(tag)?.[1] ?? "") === sheetName);
  const relId = sheet && /\br:id="([^"]*)"/.exec(sheet)?.[1];
  const target = relId && [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(tag => tag.includes(`Id="${relId}"`))?.match(/\bTarget="([^"]*)"/)?.[1];
  if (!target) throw new Error(`Worksheet ${sheetName} not found`);
  const shared = [...((await read("xl/sharedStrings.xml")) ?? "").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map(m => texts(m[1] ?? ""));
  const entry = entries.find(item => item.name === `xl/${target.replace(/^\/?xl\//, "")}`);
  if (!entry) throw new Error(`Worksheet ${sheetName} missing`);
  const body = await zipRead(zip, entry);
  const open = Buffer.from("<row"), close = Buffer.from("</row>");
  for (let p = body.indexOf(open); p >= 0;) {
    const tagEnd = body.indexOf(">", p);
    if (tagEnd < 0) break;
    if (body[tagEnd - 1] === 0x2f) { p = body.indexOf(open, tagEnd); continue; } // <row/>
    const end = body.indexOf(close, tagEnd);
    if (end < 0) break;
    const xml = body.toString("utf8", tagEnd + 1, end), row: string[] = [];
    for (const cell of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1]!, inner = cell[2] ?? "", ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1], v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      row[columnIndex(ref)] = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? texts(inner) : unescapeXml(v ?? "");
    }
    yield Array.from(row, value => value ?? "");
    p = body.indexOf(open, end);
  }
}

// --- Shapefile ---

export type ShapeGeometry = { type: "Point"; coordinates: [number, number] } | { type: "MultiLineString"; coordinates: Array<Array<[number, number]>> } | null;

/** Geometries of a .shp in record order (points and polylines, Z/M ignored). */
export function* shpGeometries(shp: Buffer): Generator<ShapeGeometry> {
  if (shp.readInt32BE(0) !== 9994) throw new Error("Not a shapefile");
  for (let p = 100; p + 8 <= shp.length;) {
    const length = shp.readInt32BE(p + 4) * 2, c = p + 8;
    p = c + length;
    const type = shp.readInt32LE(c);
    if (type === 0) { yield null; continue; }
    if (type === 1 || type === 11 || type === 21) { yield { type: "Point", coordinates: [shp.readDoubleLE(c + 4), shp.readDoubleLE(c + 12)] }; continue; }
    if (type !== 3 && type !== 13 && type !== 23) throw new Error(`Unsupported shape type ${type}`);
    const parts = shp.readInt32LE(c + 36), points = shp.readInt32LE(c + 40), first = c + 44, xy = first + parts * 4;
    const lines: Array<Array<[number, number]>> = [];
    for (let i = 0; i < parts; i++) {
      const from = shp.readInt32LE(first + i * 4), to = i + 1 < parts ? shp.readInt32LE(first + (i + 1) * 4) : points;
      const line: Array<[number, number]> = [];
      for (let k = from; k < to; k++) line.push([shp.readDoubleLE(xy + k * 16), shp.readDoubleLE(xy + k * 16 + 8)]);
      if (line.length >= 2) lines.push(line);
    }
    yield lines.length ? { type: "MultiLineString", coordinates: lines } : null;
  }
}

/** dBASE III records keyed by field name; text decoded per the .cpg or the language driver byte. */
export function* dbfRecords(dbf: Buffer, codepage?: string | null): Generator<Record<string, string> | null> {
  const count = dbf.readUInt32LE(4), headerLength = dbf.readUInt16LE(8), recordLength = dbf.readUInt16LE(10);
  const utf8 = /utf-?8/i.test(codepage ?? "") || (!codepage && dbf[29] === 0);
  const decoder = new TextDecoder(utf8 ? "utf-8" : "windows-1252");
  const fields: Array<{ name: string; length: number }> = [];
  for (let p = 32; p + 32 <= headerLength && dbf[p] !== 0x0d; p += 32) fields.push({ name: dbf.toString("latin1", p, p + 11).replace(/\0[\s\S]*$/, ""), length: dbf[p + 16]! });
  for (let i = 0; i < count; i++) {
    const start = headerLength + i * recordLength;
    if (start + recordLength > dbf.length) break;
    if (dbf[start] === 0x2a) { yield null; continue; } // deleted
    const record: Record<string, string> = {};
    let p = start + 1;
    for (const field of fields) { record[field.name] = decoder.decode(dbf.subarray(p, p + field.length)).trim(); p += field.length; }
    yield record;
  }
}

// --- Coordinates ---

/** ETRS89 / UTM (GRS80) -> [longitude, latitude]; sub-metre accuracy, enough to match counts to road axes. */
export function utmToLonLat(zone: number, easting: number, northing: number): [number, number] {
  const a = 6378137, e2 = 0.00669438002290, k0 = 0.9996, ep = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const mu = northing / k0 / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), t1 = Math.tan(p1) ** 2, c1 = ep * Math.cos(p1) ** 2;
  const r1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, d = (easting - 500000) / (n1 * k0);
  const latitude = p1 - (n1 * Math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep - 3 * c1 ** 2) * d ** 6 / 720);
  const longitude = (zone * 6 - 183) * Math.PI / 180 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep + 24 * t1 ** 2) * d ** 5 / 120) / Math.cos(p1);
  return [Math.round(longitude * 180 / Math.PI * 1e7) / 1e7, Math.round(latitude * 180 / Math.PI * 1e7) / 1e7];
}
