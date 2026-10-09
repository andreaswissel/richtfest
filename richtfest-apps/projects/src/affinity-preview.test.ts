import { expect, test } from "bun:test";
import { extractAffinityPreview } from "./affinity-preview";

const MAGIC = new Uint8Array([0, 0xff, 0x4b, 0x41]);
const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC_TABLE.length; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes)
    crc = (CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8)) >>> 0;
  return ~crc >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const result = new Uint8Array(4 + body.length + 4);
  new DataView(result.buffer).setUint32(0, data.length);
  result.set(body, 4);
  new DataView(result.buffer).setUint32(4 + body.length, crc32(body));
  return result;
}

function png(
  width: number,
  height: number,
  filler = new Uint8Array(),
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const pieces = [
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    ...(filler.length ? [chunk("IDAT", filler)] : []),
    chunk("IEND", new Uint8Array()),
  ];
  const output = new Uint8Array(
    pieces.reduce((total, piece) => total + piece.length, 0),
  );
  let offset = 0;
  for (const piece of pieces) {
    output.set(piece, offset);
    offset += piece.length;
  }
  return output;
}

function affinity(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    MAGIC.length + parts.reduce((total, part) => total + part.length, 0),
  );
  output.set(MAGIC);
  let offset = MAGIC.length;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function* fragmented(value: Uint8Array, size = 3) {
  for (let offset = 0; offset < value.length; offset += size)
    yield value.subarray(offset, Math.min(value.length, offset + size));
}

test("extracts the largest valid PNG across fragmented input", async () => {
  const small = png(32, 32, new Uint8Array([1]));
  const large = png(640, 480, new Uint8Array([2, 3, 4]));
  const result = await extractAffinityPreview(
    fragmented(affinity(small, large), 2),
  );
  expect(result).not.toBeNull();
  expect(Array.from(result!)).toEqual(Array.from(large));
});

test("rejects a missing Affinity header and truncated candidate", async () => {
  expect(
    await extractAffinityPreview(fragmented(new Uint8Array([1, 2, 3, 4]))),
  ).toBeNull();
  const incomplete = affinity(
    PNG_SIGNATURE,
    new Uint8Array([0, 0, 0, 13]),
    new TextEncoder().encode("IHDR"),
  );
  expect(await extractAffinityPreview(fragmented(incomplete))).toBeNull();
});

test("skips malformed CRC candidates and continues scanning", async () => {
  const malformed = png(400, 400);
  malformed[malformed.length - 1] ^= 0xff;
  const valid = png(100, 90);
  expect(
    await extractAffinityPreview(fragmented(affinity(malformed, valid), 1)),
  ).toEqual(valid);
});

test("rejects oversized candidates without retaining the whole source", async () => {
  const oversized = png(1000, 1000, new Uint8Array(80));
  const valid = png(10, 20);
  expect(
    await extractAffinityPreview(fragmented(affinity(oversized, valid), 7), {
      maxPreviewBytes: oversized.length - 1,
    }),
  ).toEqual(valid);
});

test("skips previews with unsafe image dimensions", async () => {
  const unsafe = png(20_000, 20_000);
  const valid = png(100, 100);
  expect(
    await extractAffinityPreview(fragmented(affinity(unsafe, valid), 13)),
  ).toEqual(valid);
});
