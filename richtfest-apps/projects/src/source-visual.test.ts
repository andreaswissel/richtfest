import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sourceVisualRequestSchema, type SourceVisual } from "@richtfest/shared";
import { extractSourceVisual } from "./source-text";

const exec = promisify(execFile);
const request = { versionId: crypto.randomUUID(), page: 1 };
const stream = (data: Uint8Array) => (async function* () { yield data; })();

// No fonts, external resources or customer data. PDF coordinates start at bottom-left:
// page 1 has red above blue; page 2 has green above yellow, on a portrait sheet.
function twoPagePdf(width = 120) {
  const drawings = [`1 0 0 rg 0 100 ${width} 100 re f 0 0 1 rg 0 0 ${width} 100 re f`,
    `0 1 0 rg 0 100 ${width} 100 re f 1 1 0 rg 0 0 ${width} 100 re f`];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    ...drawings.flatMap((drawing, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 200] /Resources << >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`,
    ])];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function pixels(result: SourceVisual, directory: string) {
  expect(result.status).toBe("available");
  expect(result.image?.mediaType).toBe("image/jpeg");
  const path = join(directory, "result.jpg");
  await writeFile(path, Buffer.from(result.image!.data, "base64"));
  const { stdout: dimensions } = await exec("identify", ["-format", "%w %h", path]);
  const { stdout: samples } = await exec("convert", [path, "-resize", "1x2!", "-depth", "8", "rgb:-"], { encoding: "buffer" });
  return { dimensions: dimensions.split(" ").map(Number), samples: [...samples] };
}

test("visual PDF contract renders the requested original page and top-left normalized crop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-visual-test-"));
  try {
    const pdf = twoPagePdf();
    const first = await extractSourceVisual(stream(pdf), "application/pdf", "synthetic.pdf", request);
    expect(first).toMatchObject({ ...request, scope: "pdf_page" });
    const a = await pixels(first, directory);
    expect(a.dimensions[1]).toBe(1568);
    expect(a.dimensions[0]).toBeLessThan(a.dimensions[1]!);
    expect(a.samples[0]).toBeGreaterThan(200);
    expect(a.samples[5]).toBeGreaterThan(200);
    const second = await extractSourceVisual(stream(pdf), "application/pdf", "synthetic.pdf", { ...request, page: 2 });
    expect(second).toMatchObject({ ...request, page: 2, scope: "pdf_page" });
    const b = await pixels(second, directory);
    expect(b.samples[1]).toBeGreaterThan(240);
    expect(b.samples[0]).toBeLessThan(30);
    expect(b.samples[3]).toBeGreaterThan(200);
    const crop = { x: 0.1, y: 0.05, width: 0.5, height: 0.25 };
    const cropped = await extractSourceVisual(stream(pdf), "application/pdf", "synthetic.pdf", { ...request, page: 2, crop });
    expect(cropped).toMatchObject({ ...request, page: 2, crop, scope: "pdf_page" });
    const c = await pixels(cropped, directory);
    expect(c.dimensions[0]! / c.dimensions[1]!).toBeCloseTo(1.2, 1);
    for (const offset of [0, 3]) {
      expect(c.samples[offset]).toBeLessThan(10);
      expect(c.samples[offset + 1]).toBeGreaterThan(245);
      expect(c.samples[offset + 2]).toBeLessThan(10);
    }
    expect(cropped.reason).toContain("unreviewed");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

test("visual crop uses normalized top-left coordinates on a narrow asymmetric page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-visual-crop-test-"));
  try {
    const crop = { x: 0.1, y: 0.05, width: 0.5, height: 0.25 };
    const result = await extractSourceVisual(stream(twoPagePdf(40)), "application/pdf", "narrow.pdf", { ...request, page: 2, crop });
    expect(result).toMatchObject({ ...request, page: 2, crop, scope: "pdf_page" });
    const prepared = await pixels(result, directory);
    expect(prepared.dimensions[0]! / prepared.dimensions[1]!).toBeCloseTo(0.4, 1);
    for (const offset of [0, 3]) {
      expect(prepared.samples[offset]).toBeLessThan(10);
      expect(prepared.samples[offset + 1]).toBeGreaterThan(245);
      expect(prepared.samples[offset + 2]).toBeLessThan(10);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

test("visual request rejects malformed coordinates; nonexistent pages and invalid sources return no image", async () => {
  for (const invalid of [{ versionId: "bad" }, { page: 0 }, { page: 1.5 },
    { crop: { x: -0.1, y: 0, width: 0.5, height: 0.5 } },
    { crop: { x: 0.8, y: 0, width: 0.3, height: 0.5 } },
    { crop: { x: 0, y: 0.9, width: 0.3, height: 0.2 } },
    { crop: { x: 0, y: 0, width: 0, height: 1 } }, { extra: true }]) {
    expect(sourceVisualRequestSchema.safeParse({ ...request, ...invalid }).success).toBe(false);
    await expect(extractSourceVisual(stream(twoPagePdf()), "application/pdf", "synthetic.pdf", { ...request, ...invalid } as typeof request)).rejects.toThrow();
  }
  for (const [data, mime, name, page] of [[twoPagePdf(), "application/pdf", "synthetic.pdf", 3],
    [Buffer.from("invalid PDF"), "application/pdf", "invalid.pdf", 1],
    [Buffer.from("invalid raster"), "image/png", "invalid.png", 1],
    [Buffer.from("text"), "text/plain", "source.txt", 1]] as const) {
    const result = await extractSourceVisual(stream(data), mime, name, { ...request, page });
    expect(result).toMatchObject({ versionId: request.versionId, page, status: "unavailable" });
    expect(result.image).toBeUndefined();
  }
});

test("standalone raster inspection works with no OCR executable and accepts only page one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-visual-no-ocr-"));
  const originalPath = process.env.PATH;
  try {
    const { stdout: png } = await exec("convert", ["-size", "80x40", "xc:red", "png:-"], { encoding: "buffer" });
    for (const tool of ["identify", "convert"]) {
      const { stdout } = await exec("which", [tool]);
      await symlink(stdout.trim(), join(directory, tool));
    }
    process.env.PATH = directory;
    expect(Bun.which("tesseract", { PATH: directory })).toBeNull();
    // Strict providers encode an omitted optional tool argument as null.
    const result = await extractSourceVisual(stream(png), "image/png", "synthetic.png", { ...request, crop: null });
    expect(result).toMatchObject({ ...request, crop: null, status: "available", scope: "image" });
    expect(result.image?.data).toBeTruthy();
    const missing = await extractSourceVisual(stream(png), "image/png", "synthetic.png", { ...request, page: 2 });
    expect(missing.status).toBe("unavailable");
    expect(missing.image).toBeUndefined();
  } finally {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});
