export type SourceText = {
  status:
    "available" | "unsupported" | "extraction_too_large" | "extraction_failed";
  text?: string;
  truncated?: boolean;
  reason?: string;
  pages?: number;
  coverage?: {
    pageStart: number;
    pageEnd: number;
    totalPages: number;
    truncated: boolean;
    nextPage: number | null;
  };
};
const BYTE_LIMIT = 32 * 1024 * 1024;
export async function extractSourceText(
  stream: AsyncIterable<Uint8Array>,
  mimeType: string,
  name: string,
  range: { pageStart?: number; pageEnd?: number } = {},
): Promise<SourceText> {
  const pdf = mimeType === "application/pdf" || /\.pdf$/i.test(name);
  const text =
    mimeType.startsWith("text/") || /\.(ifc|txt|csv|json|md)$/i.test(name);
  if (!pdf && !text)
    return {
      status: "unsupported",
      reason: "Text extraction is not available for this format.",
    };
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      if (pdf && bytes + buffer.length > BYTE_LIMIT)
        return {
          status: "extraction_too_large",
          reason:
            "PDF text processing is limited to 32 MiB; the original upload remains available.",
        };
      const take = Math.min(buffer.length, (pdf ? BYTE_LIMIT : 65536) - bytes);
      chunks.push(buffer.subarray(0, take));
      bytes += take;
      if (!pdf && bytes >= 65536) {
        truncated = true;
        break;
      }
    }
    const data = Buffer.concat(chunks);
    if (!pdf)
      return { status: "available", text: data.toString("utf8"), truncated };
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(data),
      useSystemFonts: true,
      disableFontFace: true,
    });
    try {
      const document = await task.promise;
      let content = "";
      const pageStart = range.pageStart ?? 1;
      const pageLimit = Math.min(
        document.numPages,
        range.pageEnd ?? pageStart + 9,
        pageStart + 9,
      );
      let lastPage = pageStart - 1;
      for (let page = pageStart; page <= pageLimit; page++) {
        const pageObject = await document.getPage(page);
        const result = await pageObject.getTextContent();
        const lines = result.items
          .flatMap((item) => ("str" in item ? [item.str] : []))
          .join(" ");
        const pageText = `\n[Page ${page}]\n${lines}\n`;
        pageObject.cleanup();
        if (pageText.length > 65536 && content.length === 0)
          return {
            status: "extraction_too_large",
            reason: `Page ${page} exceeds the 64 KiB extracted-text limit; open the immutable source for manual review.`,
            pages: document.numPages,
          };
        if (content.length + pageText.length > 65536) {
          truncated = true;
          break;
        }
        content += pageText;
        lastPage = page;
      }
      return content.trim()
        ? {
            status: "available",
            text: content,
            truncated: truncated || document.numPages > pageLimit,
            pages: document.numPages,
            coverage: {
              pageStart,
              pageEnd: lastPage,
              totalPages: document.numPages,
              truncated: truncated || document.numPages > lastPage,
              nextPage:
                lastPage < Math.min(pageLimit, document.numPages)
                  ? lastPage + 1
                  : lastPage < document.numPages
                    ? lastPage + 1
                    : null,
            },
          }
        : {
            status: "unsupported",
            reason: "This PDF has no extractable text. OCR is not configured.",
          };
    } finally {
      await task.destroy();
    }
  } catch {
    return {
      status: "extraction_failed",
      reason:
        "The immutable source could not be extracted. Open the source for manual review.",
    };
  }
}
