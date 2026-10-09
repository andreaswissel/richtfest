const AFFINITY_MAGIC = new Uint8Array([0x00, 0xff, 0x4b, 0x41]);
const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const DEFAULT_MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 16 * 1024 * 1024;
const INITIAL_CANDIDATE_CAPACITY = 64 * 1024;

export type AffinityPreviewOptions = {
  maxPreviewBytes?: number;
};

type CandidateResult = "continue" | "invalid" | "complete";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC_TABLE.length; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

function updateCrc(crc: number, value: number): number {
  return (CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8)) >>> 0;
}

function isChunkTypeByte(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
}

function readU32(bytes: Uint8Array): number {
  return (
    bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3]
  );
}

class PngCandidate {
  private readonly maxBytes: number;
  private bytes: Uint8Array;
  private length = 0;
  private phase: "length" | "type" | "data" | "crc" = "length";
  private readonly lengthBytes = new Uint8Array(4);
  private lengthOffset = 0;
  private chunkLength = 0;
  private readonly typeBytes = new Uint8Array(4);
  private typeOffset = 0;
  private chunkType = "";
  private dataOffset = 0;
  private crcOffset = 0;
  private crc = 0xffffffff;
  private readonly crcBytes = new Uint8Array(4);
  private readonly ihdrBytes = new Uint8Array(13);
  private ihdrOffset = 0;
  private sawIhdr = false;
  private width = 0;
  private height = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
    this.bytes = new Uint8Array(Math.min(INITIAL_CANDIDATE_CAPACITY, maxBytes));
  }

  addSignature(): CandidateResult {
    for (const value of PNG_SIGNATURE) {
      if (!this.append(value)) return "invalid";
    }
    return "continue";
  }

  consume(value: number): CandidateResult {
    if (!this.append(value)) return "invalid";

    if (this.phase === "length") {
      this.lengthBytes[this.lengthOffset++] = value;
      if (this.lengthOffset !== 4) return "continue";
      this.chunkLength = readU32(this.lengthBytes);
      if (this.chunkLength > this.maxBytes - this.length - 8) return "invalid";
      this.phase = "type";
      this.typeOffset = 0;
      return "continue";
    }

    if (this.phase === "type") {
      this.typeBytes[this.typeOffset++] = value;
      this.crc = updateCrc(this.crc, value);
      if (this.typeOffset !== 4) return "continue";
      if (!this.typeBytes.every(isChunkTypeByte)) return "invalid";
      this.chunkType = String.fromCharCode(...this.typeBytes);
      if (!this.sawIhdr && this.chunkType !== "IHDR") return "invalid";
      if (
        this.chunkType === "IHDR" &&
        (this.sawIhdr || this.chunkLength !== 13)
      )
        return "invalid";
      if (this.chunkType === "IEND" && this.chunkLength !== 0) return "invalid";
      this.dataOffset = 0;
      this.ihdrOffset = 0;
      this.phase = this.chunkLength === 0 ? "crc" : "data";
      this.crcOffset = 0;
      return "continue";
    }

    if (this.phase === "data") {
      this.crc = updateCrc(this.crc, value);
      if (this.chunkType === "IHDR") this.ihdrBytes[this.ihdrOffset++] = value;
      this.dataOffset++;
      if (this.dataOffset !== this.chunkLength) return "continue";
      this.crcOffset = 0;
      this.phase = "crc";
      return "continue";
    }

    this.crcBytes[this.crcOffset++] = value;
    if (this.crcOffset !== 4) return "continue";
    if (~this.crc >>> 0 !== readU32(this.crcBytes)) return "invalid";

    if (this.chunkType === "IHDR") {
      this.width = readU32(this.ihdrBytes);
      this.height = readU32(this.ihdrBytes.subarray(4, 8));
      if (
        this.width === 0 ||
        this.height === 0 ||
        this.width > 16_384 ||
        this.height > 16_384 ||
        BigInt(this.width) * BigInt(this.height) > BigInt(MAX_PREVIEW_PIXELS)
      )
        return "invalid";
      this.sawIhdr = true;
    }
    if (!this.sawIhdr) return "invalid";
    if (this.chunkType === "IEND") return "complete";

    this.lengthOffset = 0;
    this.crc = 0xffffffff;
    this.phase = "length";
    return "continue";
  }

  get area(): bigint {
    return BigInt(this.width) * BigInt(this.height);
  }

  get result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }

  private append(value: number): boolean {
    if (this.length >= this.maxBytes) return false;
    if (this.length === this.bytes.length) {
      const nextLength = Math.min(this.maxBytes, this.bytes.length * 2);
      if (nextLength <= this.bytes.length) return false;
      const next = new Uint8Array(nextLength);
      next.set(this.bytes);
      this.bytes = next;
    }
    this.bytes[this.length++] = value;
    return true;
  }
}

function appendSearchByte(
  search: Uint8Array,
  length: number,
  value: number,
): number {
  if (length < search.length) search[length++] = value;
  else {
    search.copyWithin(0, 1);
    search[search.length - 1] = value;
  }
  return length;
}

function isSignature(search: Uint8Array, length: number): boolean {
  if (length !== PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index++)
    if (search[index] !== PNG_SIGNATURE[index]) return false;
  return true;
}

/**
 * Extracts the largest complete embedded PNG preview from an Affinity file.
 *
 * The source is consumed once and is never buffered in full. Affinity files
 * start with 00 FF 4B 41; malformed candidates and candidates over the cap
 * are skipped. "Largest" means pixel area from the PNG IHDR dimensions.
 */
export async function extractAffinityPreview(
  stream: AsyncIterable<Uint8Array>,
  options: AffinityPreviewOptions = {},
): Promise<Uint8Array | null> {
  const maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES;
  if (
    !Number.isSafeInteger(maxPreviewBytes) ||
    maxPreviewBytes < PNG_SIGNATURE.length + 12
  )
    throw new RangeError("maxPreviewBytes is too small");

  let prefixLength = 0;
  let candidate: PngCandidate | null = null;
  let best: { area: bigint; bytes: Uint8Array } | null = null;
  const search = new Uint8Array(PNG_SIGNATURE.length);
  let searchLength = 0;

  for await (const chunk of stream) {
    for (const value of chunk) {
      if (prefixLength < AFFINITY_MAGIC.length) {
        if (value !== AFFINITY_MAGIC[prefixLength]) return null;
        prefixLength++;
        continue;
      }

      if (candidate) {
        const current = candidate;
        const result = current.consume(value);
        if (result === "complete") {
          const bytes = current.result;
          if (!best || current.area > best.area)
            best = { area: current.area, bytes };
          candidate = null;
          searchLength = 0;
          continue;
        }
        if (result === "continue") continue;
        candidate = null;
        searchLength = 0;
      }

      searchLength = appendSearchByte(search, searchLength, value);
      if (isSignature(search, searchLength)) {
        const started = new PngCandidate(maxPreviewBytes);
        searchLength = 0;
        if (started.addSignature() === "continue") candidate = started;
      }
    }
  }

  return best?.bytes ?? null;
}
