import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractSourceText } from "@richtfest/projects/source-text";
async function* bytes(value: Uint8Array) {
  yield value;
}
// Small generated PDFs, including a genuine raster image XObject (no hidden text).
function fixturePdf(streams: string[], image?: Buffer, mediaBox = "0 0 600 300") {
  const objects: Buffer[] = [];
  const add = (value: string | Buffer) => objects.push(Buffer.from(value));
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${streams.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${streams.length} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const imageId = 4 + streams.length * 2;
  for (const stream of streams) {
    const contentsId = objects.length + 2;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Scan ${imageId} 0 R >>` : ""} >> /Contents ${contentsId} 0 R >>`);
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  if (image) add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n`), image, Buffer.from("\nendstream")]));
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
    parts.push(Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"));
  }
  const xref = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(parts);
}
const native = (value: string) => `BT /F1 12 Tf 20 260 Td (${value}) Tj 0 -20 Td (Thickness 240 mm) Tj ET`;

test("reads all 14 native pages, preserves lines and explicit original-page ranges", async () => {
  const pdf = fixturePdf(Array.from({ length: 14 }, (_, i) => native(`Distinct source ${i + 1}`)));
  const full = await extractSourceText(bytes(pdf), "application/pdf", "source.pdf");
  expect(full.status).toBe("available");
  expect(full.text).toContain("Distinct source 1\nThickness 240 mm");
  expect(full.text).toContain("Distinct source 14");
  expect(full.text).not.toContain("[OCR:");
  expect(full.coverage).toEqual({ pageStart: 1, pageEnd: 14, totalPages: 14, truncated: false, nextPage: null });
  const ranged = await extractSourceText(bytes(pdf), "application/pdf", "source.pdf", { pageStart: 11, pageEnd: 12 });
  expect(ranged.text).toContain("[Page 11]");
  expect(ranged.text).not.toContain("[Page 1]");
  expect(ranged.text).not.toContain("Distinct source 14");
  expect(ranged.coverage).toEqual({ pageStart: 11, pageEnd: 12, totalPages: 14, truncated: true, nextPage: 13 });
  const tail = await extractSourceText(bytes(pdf), "application/pdf", "source.pdf", { pageStart: 13 });
  expect(tail.text).toContain("Distinct source 14");
  expect(tail.coverage?.nextPage).toBeNull();
});

test("real German/English scanned PDF OCR and mixed native/scanned/blank provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-fixture-"));
  try {
    const imageFile = join(directory, "scan.rgb");
    await promisify(execFile)("magick", ["-size", "1200x600", "xc:white", "-font", "DejaVu-Sans", "-pointsize", "42", "-fill", "black", "-annotate", "+60+140", "Außenwand Stärke 240 mm", "-annotate", "+60+240", "English wall thickness 240 mm", "-depth", "8", `rgb:${imageFile}`], { timeout: 10000 });
    const raster = await readFile(imageFile);
    const scan = "q 600 0 0 300 0 0 cm /Scan Do Q";
    const scanned = await extractSourceText(bytes(fixturePdf([scan], raster)), "application/pdf", "scan.pdf");
    expect(scanned.status).toBe("available");
    expect(scanned.text).toContain("Außenwand");
    expect(scanned.text).toContain("Stärke 240 mm");
    expect(scanned.text).toContain("English wall thickness 240 mm");
    expect(scanned.text).toContain("OCR: German + English; unverified");
    const mixed = await extractSourceText(bytes(fixturePdf([native("Native evidence"), scan, ""], raster)), "application/pdf", "mixed.pdf");
    expect(mixed.status).toBe("available");
    expect(mixed.text).toContain("[Page 1]\n[Native text]");
    expect(mixed.text).toContain("[Page 2]\n[OCR:");
    expect(mixed.text).toContain("[Page 3]\n[Blank or unreadable:");
    expect(mixed.coverage?.pageEnd).toBe(3);
    expect(mixed.reason).toContain("visual drawings");
    const blank = await extractSourceText(bytes(fixturePdf([""])), "application/pdf", "blank.pdf");
    expect(blank.status).toBe("extraction_failed");
    expect(blank.text).toContain("Blank or unreadable");
    expect(blank.coverage?.nextPage).toBeNull();
    // Exercise an actual subprocess failure without mocking extraction internals.
    for (const tool of ["pdfinfo", "pdftotext", "pdftoppm"])
      await symlink(Bun.which(tool)!, join(directory, tool));
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = directory; // Deliberately no Tesseract.
      const failed = await extractSourceText(bytes(fixturePdf([native("Still readable"), scan], raster)), "application/pdf", "failure.pdf");
      expect(failed.status).toBe("available");
      expect(failed.text).toContain("[Page 2]\n[Extraction/OCR failed:");
      expect(failed.reason).toContain("Page 2 extraction/OCR failed");
      expect(failed.coverage?.pageEnd).toBe(2);
    } finally { process.env.PATH = previousPath; }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

test("honest whole-page text ceiling, oversized page, corrupt PDF, invalid ranges and input guard", async () => {
  // Large engineering sheets keep dense fixture text inside actual page bounds.
  const dense = (count: number) => `BT /F1 12 Tf 20 9000 Td 20 TL ${Array.from({ length: count }, () => `(${"Wall ".repeat(200)}) Tj T*`).join("\n")} ET`;
  const bounded = await extractSourceText(bytes(fixturePdf([dense(190), dense(190)], undefined, "0 0 10000 10000")), "application/pdf", "dense.pdf");
  expect(bounded.status).toBe("available");
  expect(bounded.text!.length).toBeLessThanOrEqual(256 * 1024);
  expect(bounded.text?.includes("[Page 2]")).toBe(false);
  expect(bounded.coverage).toEqual({ pageStart: 1, pageEnd: 1, totalPages: 2, truncated: true, nextPage: 2 });
  expect(bounded.reason).toContain("ceiling");
  const oversized = await extractSourceText(bytes(fixturePdf([dense(360)], undefined, "0 0 10000 10000")), "application/pdf", "large.pdf");
  expect(oversized.status).toBe("extraction_too_large");
  expect(oversized.text).toBeUndefined();
  expect(oversized.coverage?.nextPage).toBe(1);
  expect(oversized.reason).toContain("no partial page");
  expect((await extractSourceText(bytes(Buffer.from("%PDF-corrupt")), "application/pdf", "bad.pdf")).status).toBe("extraction_failed");
  expect((await extractSourceText(bytes(fixturePdf([native("Valid")])), "application/pdf", "range.pdf", { pageStart: 0 })).reason).toContain("Invalid PDF page range");
  expect((await extractSourceText(bytes(new Uint8Array(32 * 1024 * 1024 + 1)), "application/pdf", "huge.pdf")).reason).toContain("32 MiB");
  expect((await extractSourceText(bytes(new Uint8Array()), "image/png", "drawing.png")).status).toBe("extraction_failed");
});

test("reads standalone raster images and Publisher previews without claiming full document coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-source-fixture-"));
  const exec = promisify(execFile);
  try {
    const png = join(directory, "labels.png");
    await exec("convert", ["-size", "1200x600", "xc:none", "-font", "DejaVu-Sans", "-pointsize", "42", "-fill", "black", "-annotate", "+60+140", "Außenwand Stärke 240 mm", "-annotate", "+60+240", "Window width 1350 mm", png]);
    for (const extension of ["png", "jpg", "webp", "bmp"]) {
      const input = join(directory, `labels.${extension}`);
      if (extension !== "png") await exec("convert", [png, "-background", "white", "-alpha", "remove", input]);
      const result = await extractSourceText(bytes(await readFile(input)), "application/octet-stream", `labels.${extension}`);
      expect(result.status).toBe("available");
      expect(result.text).toContain("Außenwand Stärke 240 mm");
      expect(result.text).toContain("Window width 1350 mm");
      expect(result.text).toContain("OCR: German + English; unverified");
      expect(result.truncated).toBe(false);
    }
    const preview = await readFile(png);
    const publisher = Buffer.concat([Buffer.from([0, 255, 75, 65]), Buffer.alloc(100), preview]);
    const partial = await extractSourceText(bytes(publisher), "application/octet-stream", "concept.afpub");
    expect(partial.status).toBe("available");
    expect(partial.text).toContain("Window width 1350 mm");
    expect(partial.text).toContain("embedded preview only; not the full document");
    expect(partial.reason).toContain("Export the full document as PDF");
    expect(partial.truncated).toBe(true);
    expect(partial.pages).toBeUndefined();
    expect(partial.coverage).toBeUndefined();
    const missing = await extractSourceText(bytes(publisher.subarray(0, 104)), "application/octet-stream", "no-preview.afpub");
    expect(missing.status).toBe("unsupported");
    expect(missing.reason).toContain("No usable embedded Affinity Publisher preview");
    expect(missing.text).toBeUndefined();
    expect((await extractSourceText(bytes(preview), "image/png", "scan.png", { pageStart: 2 })).status).toBe("extraction_failed");

    const blank = join(directory, "blank.png");
    await exec("convert", ["-size", "200x100", "xc:white", blank]);
    const unreadable = await extractSourceText(bytes(await readFile(blank)), "image/png", "blank.png");
    expect(unreadable.status).toBe("extraction_failed");
    expect(unreadable.reason).toContain("No meaningful text");
    expect(unreadable.text).toBeUndefined();
    const fake = await extractSourceText(bytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), "image/png", "fake.png");
    expect(fake.status).toBe("extraction_failed");
    expect(fake.reason).toContain("not a valid supported raster image");
    expect((await extractSourceText(bytes(Buffer.alloc(32 * 1024 * 1024 + 1)), "image/png", "large.png")).status).toBe("extraction_too_large");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

test("animated images expose first-frame-only coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "animated-source-fixture-"));
  try {
    const input = join(directory, "animated.webp");
    await promisify(execFile)("convert", ["-size", "800x300", "-font", "DejaVu-Sans", "-pointsize", "42", "-fill", "black", "-delay", "100", "xc:white", "-annotate", "+40+100", "First frame 240 mm", "(", "xc:white", "-annotate", "+40+100", "Hidden frame 930 mm", ")", "-loop", "0", input]);
    const result = await extractSourceText(bytes(await readFile(input)), "image/webp", "animated.webp");
    expect(result.status).toBe("available");
    expect(result.text).toContain("First frame 240 mm");
    expect(result.text).not.toContain("Hidden frame 930 mm");
    expect(result.truncated).toBe(true);
    expect(result.reason).toContain("Only the first image frame");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 10000);
function tinyPdf() {
  const stream = "BT /F1 12 Tf 20 50 Td (Source wall type AL24) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(result.length);
    result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const offset = result.length;
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  return new TextEncoder().encode(result);
}
test("extracts actual PDF text with immutable page coverage", async () => {
  const result = await extractSourceText(
    bytes(tinyPdf()),
    "application/pdf",
    "source.pdf",
  );
  expect(result.status).toBe("available");
  expect(result.text).toContain("Source wall type AL24");
  expect(result.coverage).toEqual({
    pageStart: 1,
    pageEnd: 1,
    totalPages: 1,
    truncated: false,
    nextPage: null,
  });
});
test("bounds text processing without changing source upload size", async () => {
  const result = await extractSourceText(
    bytes(new TextEncoder().encode("a".repeat(70000))),
    "text/plain",
    "source.ifc",
  );
  expect(result.text?.length).toBe(65536);
  expect(result.truncated).toBe(true);
});
test("mocked provider receives extracted PDF evidence and proposes a draft", async () => {
  const { callProvider } = await import("./provider-runtime");
  const source = await extractSourceText(
    bytes(tinyPdf()),
    "application/pdf",
    "source.pdf",
  );
  const output = await callProvider(
    { provider: "openai", goal: "Review source", context: { source } },
    "sk-test-placeholder",
    async (_url, init) => {
      expect(String(init.body)).toContain("Source wall type AL24");
      return Response.json({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  summary: "Review AL24",
                  rationale: "Exact source excerpt",
                  citations: [],
                  tools: [],
                  artifact: {
                    title: "Source review",
                    content: "Source wall type AL24 requires review",
                    type: "draft",
                  },
                }),
              },
            ],
          },
        ],
      });
    },
  );
  expect((output as any).artifact.type).toBe("draft");
});
