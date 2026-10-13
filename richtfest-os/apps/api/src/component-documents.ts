import { mkdtemp, rm, open } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { HttpError } from "./middleware/auth";
import { fileStorage } from "./file-storage";

export async function storeComponentPdf(tenantId: string, componentId: string, stream: NodeJS.ReadableStream, sha256: string, pages: number) {
  const directory = await mkdtemp(join(tmpdir(), "component-pdf-"));
  const filename = join(directory, "source.pdf");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let key: string | undefined;
  const invalid = () => new HttpError(400, "invalid_pdf", "PDF bytes must match the declared checksum and page count and be unencrypted");
  try {
    await pipeline(stream as any, new Transform({ transform(chunk, _encoding, callback) {
      sizeBytes += chunk.length; hash.update(chunk); callback(null, chunk);
    } }), createWriteStream(filename, { flags: "wx" }));
    if (!sizeBytes || hash.digest("hex") !== sha256) throw invalid();
    const file = await open(filename, "r");
    const header = Buffer.alloc(5);
    try { await file.read(header, 0, 5, 0); } finally { await file.close(); }
    if (header.toString() !== "%PDF-") throw invalid();
    const info = await new Promise<string>((resolve, reject) => {
      execFile("pdfinfo", [filename], { timeout: 45_000, maxBuffer: 65536, killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C" } },
        (error, stdout) => error ? reject(invalid()) : resolve(stdout));
    });
    if (!/^Encrypted:\s+no\s*$/m.test(info) || Number(info.match(/^Pages:\s+(\d+)/m)?.[1]) !== pages) throw invalid();
    const adapter = fileStorage;
    key = `${tenantId}/${componentId}/${randomUUID()}/${randomUUID()}`;
    if (adapter.kind === "bucket") {
      try {
        const upload = await adapter.initiate(key, "application/pdf", "");
        const response = await fetch(upload.uploadUrl, { method: "PUT", headers: { ...upload.headers, "content-length": String(sizeBytes) }, body: Bun.file(filename), redirect: "error" });
        if (!response.ok) throw new Error("Upload failed");
      } catch { throw new HttpError(502, "storage_failed", "PDF storage failed"); }
    } else {
      await adapter.saveStream(key, createReadStream(filename), "application/pdf");
    }
    return { storageKey: key, sizeBytes };
  } catch (error) {
    if (key) await fileStorage.remove(key);
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
