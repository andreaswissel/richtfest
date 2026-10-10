import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import type { LocationContext, LocationPointCloud } from "@richtfest/shared";
import { boundedBody } from "./location-context";

export const LIDAR_ARCHIVE = "https://gdi.berlin.de/data/a_als/atom/Mitte.zip";
const MAX_COMPRESSED = 350_000_000, MAX_EXPANDED = 900_000_000;
const safe64 = (b: Buffer, offset: number) => {
  const n = Number(b.readBigUInt64LE(offset));
  if (!Number.isSafeInteger(n)) throw new Error("Unsafe ZIP64 offset");
  return n;
};
export type ZipEntry = { name: string; method: number; compressed: number; expanded: number; offset: number; crc: number };
export function zipDirectory(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  for (let p = 0; p < buffer.length;) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
    if (buffer.readUInt16LE(p + 8) & 1) throw new Error("Encrypted ZIP unsupported");
    const nl = buffer.readUInt16LE(p + 28), el = buffer.readUInt16LE(p + 30), cl = buffer.readUInt16LE(p + 32);
    if (p + 46 + nl + el + cl > buffer.length) throw new Error("Truncated ZIP central directory");
    const entry: ZipEntry = { name: buffer.toString("utf8", p + 46, p + 46 + nl), method: buffer.readUInt16LE(p + 10), compressed: buffer.readUInt32LE(p + 20), expanded: buffer.readUInt32LE(p + 24), offset: buffer.readUInt32LE(p + 42), crc: buffer.readUInt32LE(p + 16) };
    for (let q = p + 46 + nl; q < p + 46 + nl + el;) {
      if (q + 4 > p + 46 + nl + el) throw new Error("Invalid ZIP extra field");
      const id = buffer.readUInt16LE(q), length = buffer.readUInt16LE(q + 2), end = q + 4 + length;
      if (end > p + 46 + nl + el) throw new Error("Truncated ZIP extra field");
      if (id === 1) {
        let z = q + 4;
        for (const key of ["expanded", "compressed", "offset"] as const) if (entry[key] === 0xffffffff) {
          if (z + 8 > end) throw new Error("Truncated ZIP64 field");
          entry[key] = safe64(buffer, z); z += 8;
        }
      }
      q = end;
    }
    if ([entry.expanded, entry.compressed, entry.offset].includes(0xffffffff)) throw new Error("Missing ZIP64 field");
    entries.push(entry); p += 46 + nl + el + cl;
  }
  return entries;
}
export async function rangeResponse(url: string, start: number, end: number, total: number, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" }, signal });
  if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${total}` || (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity")) {
    await response.body?.cancel();
    throw new Error("Berlin LiDAR server did not honor exact byte range; full archive download refused. Retry later.");
  }
  return response;
}
async function readRange(start: number, length: number, total: number, signal: AbortSignal) {
  const b = await boundedBody(await rangeResponse(LIDAR_ARCHIVE, start, start + length - 1, total, signal), length);
  if (b.length !== length) throw new Error("Truncated LiDAR range response");
  return b;
}
async function directory(signal: AbortSignal) {
  const head = await fetch(LIDAR_ARCHIVE, { method: "HEAD", signal });
  const total = Number(head.headers.get("content-length"));
  if (!head.ok || !Number.isSafeInteger(total) || total < 65536) throw new Error("Berlin LiDAR archive unavailable; retry later");
  const tail = await readRange(total - 65536, 65536, total, signal);
  const end = tail.lastIndexOf(Buffer.from("504b0506", "hex"));
  if (end < 0 || end + 22 > tail.length || end + 22 + tail.readUInt16LE(end + 20) !== tail.length) throw new Error("Missing ZIP end record");
  let size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
  if (size === 0xffffffff || offset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error("Missing ZIP64 locator");
    const record = await readRange(safe64(tail, locator + 8), 56, total, signal);
    if (record.readUInt32LE(0) !== 0x06064b50) throw new Error("Invalid ZIP64 end record");
    size = safe64(record, 40); offset = safe64(record, 48);
  }
  if (size > 4_000_000 || offset + size > total) throw new Error("ZIP directory exceeds bounded budget");
  return { entries: zipDirectory(await readRange(offset, size, total, signal)), total };
}

type Point = [number, number, number, number];
/** Stream LAS, crop before deterministic reservoir sampling. Classes 3/4/5
 * remain source labels, NOT a tree/building classifier. Ground uses class 2. */
export class LasCrop {
  private buffer = Buffer.alloc(0);
  private offset = 0;
  private header: { pointOffset: number; length: number; format: number; count: number; scale: number[]; origin: number[] } | null = null;
  private seen = 0;
  private random = 123456789;
  private ground: number[] = [];
  private groundSeen = 0;
  readonly points: Point[] = [];
  sourcePointCount = 0;
  constructor(private origin: [number, number], private radius: number, private limit = 200000) {}
  private rand() { this.random ^= this.random << 13; this.random ^= this.random >>> 17; this.random ^= this.random << 5; return (this.random >>> 0) / 4294967296; }
  push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.header) {
      if (this.buffer.length < 375) return;
      const b = this.buffer;
      if (b.toString("ascii", 0, 4) !== "LASF" || b[24] !== 1 || b[25] !== 4) throw new Error("Expected LAS 1.4 source tile");
      const format = b[104]!, length = b.readUInt16LE(105), pointOffset = b.readUInt32LE(96), count = safe64(b, 247) || b.readUInt32LE(107);
      if (format > 10 || length < (format >= 6 ? 30 : 20) || pointOffset < 375 || pointOffset > 1_000_000 || count > 25_000_000) throw new Error("Unsupported LAS format or tile budget (LAZ is not LAS)");
      this.header = { format, length, pointOffset, count, scale: [131,139,147].map(o => b.readDoubleLE(o)), origin: [155,163,171].map(o => b.readDoubleLE(o)) };
      if (!this.header.scale.every(n => Number.isFinite(n) && n > 0) || !this.header.origin.every(Number.isFinite)) throw new Error("Invalid LAS coordinates");
    }
    const h = this.header;
    if (this.offset < h.pointOffset) {
      const skip = Math.min(h.pointOffset - this.offset, this.buffer.length);
      this.buffer = this.buffer.subarray(skip); this.offset += skip;
      if (this.offset < h.pointOffset) return;
    }
    let p = 0;
    while (p + h.length <= this.buffer.length && this.seen < h.count) {
      const x = this.buffer.readInt32LE(p) * h.scale[0]! + h.origin[0]! - this.origin[0];
      const z = this.origin[1] - (this.buffer.readInt32LE(p + 4) * h.scale[1]! + h.origin[1]!);
      const y = this.buffer.readInt32LE(p + 8) * h.scale[2]! + h.origin[2]!;
      const classification = h.format >= 6 ? this.buffer[p + 16]! : this.buffer[p + 15]! & 31;
      if (x * x + z * z <= this.radius ** 2 && Number.isFinite(y)) {
        const point: Point = [x, y, z, classification];
        this.sourcePointCount++;
        if (this.points.length < this.limit) this.points.push(point);
        else { const index = Math.floor(this.rand() * this.sourcePointCount); if (index < this.limit) this.points[index] = point; }
        if (classification === 2) {
          this.groundSeen++;
          if (this.ground.length < 10000) this.ground.push(y);
          else { const index = Math.floor(this.rand() * this.groundSeen); if (index < 10000) this.ground[index] = y; }
        }
      }
      p += h.length; this.seen++;
    }
    this.offset += p; this.buffer = this.buffer.subarray(p);
    // Ignore bounded trailing EVLR data after the declared points.
    if (this.seen === h.count) this.buffer = Buffer.alloc(0);
  }
  finish(): LocationPointCloud {
    if (!this.header || this.seen !== this.header.count) throw new Error("Truncated LAS points");
    if (!this.ground.length || !this.points.length) throw new Error("No ground-class points within site crop; cannot normalize honestly");
    this.ground.sort((a,b) => a-b);
    const groundElevation = this.ground[Math.floor(this.ground.length / 2)]!;
    return { positions: this.points.flatMap(([x,y,z]) => [Math.round(x*1000)/1000, Math.round((y-groundElevation)*1000)/1000, Math.round(z*1000)/1000]), classifications: this.points.map(p => p[3]), groundElevation, sourcePointCount: this.sourcePointCount, sampled: this.sourcePointCount > this.points.length, surveyedAt: "2021-02-24/2021-03-02", sourceUrl: LIDAR_ARCHIVE };
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k=0;k<8;k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export async function fetchLocationLidar(context: LocationContext, signal: AbortSignal): Promise<LocationPointCloud> {
  const { entries, total } = await directory(signal), [e,n] = context.origin, r = context.radius;
  const tiles: ZipEntry[] = [];
  for (let x = Math.floor((e-r)/1000); x <= Math.floor((e+r)/1000); x++) for (let y = Math.floor((n-r)/1000); y <= Math.floor((n+r)/1000); y++) {
    const tile = entries.find(t => t.name === `3dm_33_${x}_${y}_1_be.las`);
    if (!tile) throw new Error("Site LAS tile absent from verified Mitte archive; no substitute data imported");
    tiles.push(tile);
  }
  if (tiles.length !== 1) throw new Error("Site crop spans multiple tiles; bounded single-site importer requires review");
  const crop = new LasCrop(context.origin, r);
  for (const tile of tiles) {
    if (![0,8].includes(tile.method) || tile.compressed > MAX_COMPRESSED || tile.expanded > MAX_EXPANDED) throw new Error("LAS tile exceeds bounded resource budget");
    const local = await readRange(tile.offset, 30, total, signal);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== tile.method) throw new Error("Invalid ZIP local header");
    const start = tile.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const response = await rangeResponse(LIDAR_ARCHIVE, start, start + tile.compressed - 1, total, signal);
    let compressed = 0, expanded = 0, crc = 0xffffffff;
    const bound = new Transform({ transform(chunk, _encoding, cb) { compressed += chunk.length; cb(compressed > tile.compressed ? new Error("Oversized ZIP range") : null, chunk); } });
    const consume = async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) {
        expanded += chunk.length;
        if (expanded > tile.expanded || expanded > MAX_EXPANDED) throw new Error("Oversized expanded LAS tile");
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
        crop.push(chunk);
      }
    };
    if (tile.method === 8) await pipeline(Readable.fromWeb(response.body as any), bound, createInflateRaw(), consume, { signal });
    else await pipeline(Readable.fromWeb(response.body as any), bound, consume, { signal });
    if (compressed !== tile.compressed || expanded !== tile.expanded || ((crc ^ 0xffffffff) >>> 0) !== tile.crc) throw new Error("LAS ZIP size or checksum mismatch");
  }
  return crop.finish();
}
