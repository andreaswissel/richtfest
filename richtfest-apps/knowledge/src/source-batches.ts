// Bound raw evidence separately from the small accumulated findings and profile
// context. Bytes are a conservative size bound, not a reported token count.
const SOURCE_BYTES_PER_BATCH = 48 * 1024;
const SOURCES_PER_BATCH = 3;

export function batchSpecialistSources<T extends { text: string; truncated?: boolean }>(sources: T[]) {
  type Slice = T & { extractionTruncated: boolean; textRange: { startByte: number; endByte: number; totalBytes: number } };
  const batches: Slice[][] = [];
  let batch: Slice[] = [];
  let used = 0;
  const flush = () => {
    if (batch.length) batches.push(batch);
    batch = [];
    used = 0;
  };
  for (const source of sources) {
    const bytes = Buffer.from(source.text, "utf8");
    let start = 0;
    while (start < bytes.length) {
      if (batch.length === SOURCES_PER_BATCH || SOURCE_BYTES_PER_BATCH - used < 4) flush();
      let end = Math.min(bytes.length, start + SOURCE_BYTES_PER_BATCH - used);
      // Never split a UTF-8 code point. Prefer a line boundary when it does not
      // leave more than half the available space unused.
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      if (end < bytes.length) {
        const newline = bytes.lastIndexOf(10, end - 1);
        if (newline >= start + (end - start) / 2) end = newline + 1;
      }
      batch.push({
        ...source,
        text: bytes.subarray(start, end).toString("utf8"),
        truncated: source.truncated || start > 0 || end < bytes.length,
        extractionTruncated: source.truncated === true,
        textRange: { startByte: start, endByte: end, totalBytes: bytes.length },
      });
      used += end - start;
      start = end;
      if (start < bytes.length) flush();
    }
  }
  flush();
  // A source-free assignment still reports its coverage gaps in one call.
  return batches.length ? batches : [[]];
}
