import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceText } from "@richtfest/shared";

const BYTE_LIMIT = 32 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024;
const DEADLINE_MS = 300_000;
// Bound raster memory across concurrent requests, not just within one PDF.
let activeOcr = 0;
async function ocrSlot(deadline: number) {
  while (activeOcr >= 2) {
    if (Date.now() >= deadline) throw new Error("OCR resource wait exceeded deadline");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  activeOcr++;
}
function command(file: string, args: string[], deadline: number, maxBuffer = TEXT_LIMIT * 4) {
  const timeout = Math.min(45_000, deadline - Date.now());
  if (timeout <= 0) throw new Error("PDF processing deadline exceeded");
  return new Promise<string>((resolve, reject) => {
    execFile(file, args, {
      timeout, maxBuffer, killSignal: "SIGKILL",
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
function meaningful(text: string) {
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}

export async function extractSourceText(
  stream: AsyncIterable<Uint8Array>,
  mimeType: string,
  name: string,
  range: { pageStart?: number; pageEnd?: number } = {},
  // Upload worker persists each page before continuing. No aggregate text cap
  // in this mode: the cap applies per page, and reads have their own budget.
  savePage?: (page: number, content: SourceText) => Promise<void>,
): Promise<SourceText> {
  const pdf = mimeType === "application/pdf" || /\.pdf$/i.test(name);
  const text = mimeType.startsWith("text/") || /\.(ifc|txt|csv|json|md)$/i.test(name);
  if (!pdf && !text) return { status: "unsupported", reason: "Text extraction is not available for this format." };
  let directory: string | undefined;
  let persistenceFailed = false;
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      if (pdf && bytes + buffer.length > BYTE_LIMIT) return {
        status: "extraction_too_large",
        reason: "PDF text processing is limited to 32 MiB; the original upload remains available.",
      };
      const take = Math.min(buffer.length, (pdf ? BYTE_LIMIT : 65536) - bytes);
      chunks.push(buffer.subarray(0, take));
      bytes += take;
      if (!pdf && bytes >= 65536) return { status: "available", text: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    const data = Buffer.concat(chunks);
    if (!pdf) return { status: "available", text: data.toString("utf8"), truncated: false };
    const deadline = Date.now() + DEADLINE_MS;
    directory = await mkdtemp(join(tmpdir(), "richtfest-pdf-"));
    const input = join(directory, "source.pdf");
    await writeFile(input, data);
    const info = await command("pdfinfo", [input], deadline, 65536);
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!Number.isInteger(pages) || pages < 1) throw new Error("Invalid PDF page count");
    const pageStart = range.pageStart ?? 1;
    const requestedEnd = range.pageEnd ?? pages;
    if (!Number.isInteger(pageStart) || !Number.isInteger(requestedEnd) || pageStart < 1 || pageStart > pages || requestedEnd < pageStart)
      return { status: "extraction_failed", pages, reason: "Invalid PDF page range." };
    const pageLimit = Math.min(pages, requestedEnd);
    let content = "";
    let lastPage = pageStart - 1;
    let readable = false;
    const limitations = ["Text only: visual drawings, table relationships and completeness are not verified. OCR (German + English) is unverified transcription: dimensions, acoustic values and other numerical claims require comparison with the original page. Blank pages cannot be distinguished reliably from unreadable drawings."];
    let oversized = false;
    for (let page = pageStart; page <= pageLimit; page++) {
      if (Date.now() >= deadline) { limitations.push(`Processing deadline reached before page ${page}.`); break; }
      let lines = "";
      let provenance = "Native text";
      let pageOversized = false;
      try {
        // Layout mode retains line breaks and column spacing useful for construction tables.
        lines = (await command("pdftotext", ["-f", String(page), "-l", String(page), "-layout", "-enc", "UTF-8", input, "-"], deadline)).replace(/\f/g, "").trimEnd();
        if (!meaningful(lines)) {
          await ocrSlot(deadline);
          try {
            const prefix = join(directory, "page");
            // Architectural sheets contain small, scattered labels: a low-resolution
            // render plus paragraph segmentation loses even clearly visible room names.
            const pageInfo = await command("pdfinfo", ["-f", String(page), "-l", String(page), input], deadline, 65536);
            const size = pageInfo.match(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/m);
            if (!size) throw new Error("PDF page dimensions unavailable");
            const pixels = Math.min(5000, Math.ceil(Math.max(Number(size[1]), Number(size[2])) * 300 / 72));
            await command("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-scale-to", String(pixels), "-png", input, prefix], deadline, 65536);
            await command("tesseract", [prefix + ".png", prefix, "-l", "deu+eng", "--psm", "11"], deadline, 65536);
            if ((await stat(prefix + ".txt")).size > TEXT_LIMIT * 4)
              throw Object.assign(new Error("OCR output exceeds processing limit"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
            const output = await readFile(prefix + ".txt");
            lines = output.toString("utf8").trimEnd();
            provenance = meaningful(lines) ? "OCR: German + English; unverified" : "Blank or unreadable: no meaningful native or OCR text; manual review required";
          } finally {
            activeOcr--;
            await Promise.all([rm(join(directory, "page.png"), { force: true }), rm(join(directory, "page.txt"), { force: true })]);
          }
        }
      } catch (error) {
        // A maxBuffer failure must not silently substitute a partial page.
        if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          oversized = true;
          pageOversized = true;
          limitations.push(`Page ${page} exceeds the 256 Ki-character extracted-text limit; no partial page was included.`);
          if (!savePage) break;
        }
        lines = "";
        provenance = "Extraction/OCR failed: unreadable; manual review required";
        limitations.push(`Page ${page} extraction/OCR failed (tool failure or deadline).`);
      }
      const pageText = `\n[Page ${page}]\n[${provenance}]\n${lines}\n`;
      if (pageText.length > TEXT_LIMIT) {
        oversized = true;
        pageOversized = true;
        limitations.push(`Page ${page} exceeds the 256 Ki-character extracted-text limit; no partial page was included.`);
        if (!savePage) break;
      }
      if (!savePage && content.length + pageText.length > TEXT_LIMIT) {
        limitations.push(`256 Ki-character text ceiling reached before page ${page}; no partial page was included.`);
        break;
      }
      if (savePage) {
        try {
          await savePage(page, {
            status: pageOversized ? "extraction_too_large" : meaningful(lines) ? "available" : "extraction_failed",
            text: pageOversized ? undefined : pageText,
            pages,
            reason: limitations[0] + (pageOversized ? " Page exceeds the 256 Ki-character text limit; no partial page was saved." : ""),
          });
        } catch (error) {
          persistenceFailed = true;
          throw error;
        }
      } else content += pageText;
      readable ||= !pageOversized && meaningful(lines);
      lastPage = page;
    }
    const truncated = lastPage < pages;
    if (pageStart > 1) limitations.push(`Explicit page range excludes pages 1–${pageStart - 1}.`);
    if (lastPage === pageLimit && pageLimit < pages) limitations.push("Explicit page range excludes later pages.");
    return {
      status: oversized ? "extraction_too_large" : readable ? "available" : "extraction_failed",
      text: content || undefined, pages, truncated,
      coverage: { pageStart, pageEnd: lastPage, totalPages: pages, truncated, nextPage: lastPage < pages ? lastPage + 1 : null },
      reason: limitations.join(" "),
    };
  } catch (error) {
    if (persistenceFailed) throw error;
    return { status: "extraction_failed", reason: "The immutable source could not be extracted (invalid PDF, unavailable tools or processing deadline). Open the source for manual review." };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
