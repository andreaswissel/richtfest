// Bound raw evidence separately from the small accumulated findings and profile
// context. Bytes are a conservative size bound, not a reported token count.
const SOURCE_BYTES_PER_BATCH = 48 * 1024;
const SOURCES_PER_BATCH = 3;

export function batchSpecialistSources<T extends { text: string; truncated?: boolean }>(sources: T[], byteLimit = SOURCE_BYTES_PER_BATCH) {
  if (!Number.isInteger(byteLimit) || byteLimit < 4) throw new Error("Source batch budget must fit a UTF-8 code point");
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
      if (batch.length === SOURCES_PER_BATCH || byteLimit - used < 4) flush();
      let end = Math.min(bytes.length, start + byteLimit - used);
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

/** Pack complete saved pages against serialized input size, without a file-count cap. */
export function batchSectionSources<T extends { text: string; truncated?: boolean }>(sources: T[], byteLimit: number,
  sizeOf: (batch: T[]) => number = batch => Buffer.byteLength(JSON.stringify(batch), "utf8")) {
  type Slice = ReturnType<typeof batchSpecialistSources<T>>[number][number];
  const batches: Slice[][] = [];
  let batch: Slice[] = [];
  for (const source of sources) {
    const totalBytes = Buffer.byteLength(source.text, "utf8");
    let startByte = 0;
    // Saved PDF extraction puts an original page marker at the start of a line.
    for (const text of source.text.split(/(?=^\[Page \d+\])/m).filter(Boolean)) {
      const endByte = startByte + Buffer.byteLength(text, "utf8");
      const page: Slice = { ...source, text, extractionTruncated: source.truncated === true,
        truncated: source.truncated || startByte > 0 || endByte < totalBytes,
        textRange: { startByte, endByte, totalBytes } };
      let pieces = [page];
      if (sizeOf([page]) > byteLimit) {
        // An oversized page/text-only source still needs a lossless UTF-8 split.
        // JSON can expand one byte to six (e.g. a control character as \u0001).
        const allowance = Math.floor((byteLimit - sizeOf([{ ...page, text: "" }]) - 128) / 6);
        if (allowance < 4) throw new Error("Source metadata exceeds the model input budget.");
        pieces = batchSpecialistSources([page], allowance).flat().map(piece => ({ ...piece,
          extractionTruncated: page.extractionTruncated,
          textRange: { startByte: startByte + piece.textRange.startByte, endByte: startByte + piece.textRange.endByte, totalBytes },
        }));
      }
      for (const piece of pieces) {
        if (batch.length && sizeOf([...batch, piece]) > byteLimit) { batches.push(batch); batch = []; }
        if (sizeOf([piece]) > byteLimit) throw new Error("Source metadata exceeds the model input budget.");
        batch.push(piece);
      }
      startByte = endByte;
    }
  }
  if (batch.length) batches.push(batch);
  return batches.length ? batches : [[]];
}
