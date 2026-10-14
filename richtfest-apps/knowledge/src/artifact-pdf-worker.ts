import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { artifactPdf, type ArtifactPdfInput } from "./artifact-pdf";

/** PDF layout/composition is CPU-heavy; never run it on the HTTP event loop. */
export async function renderArtifactPdf(input: ArtifactPdfInput): Promise<Buffer> {
  const { readSourcePdf, ...data } = input;
  const worker = new Worker(new URL("./artifact-pdf-worker.ts", import.meta.url), { workerData: data, env: {} });
  let timeout: ReturnType<typeof setTimeout>;
  let finished = false;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("PDF preparation timed out")), 8 * 60_000);
      worker.on("error", reject);
      worker.on("exit", () => reject(new Error("PDF preparation interrupted")));
      worker.on("message", async message => {
        if (message.kind === "done") resolve(Buffer.from(message.bytes));
        else if (message.kind === "failed") reject(Object.assign(new Error(message.message), {
          status: message.status, code: message.code,
        }));
        else if (message.kind === "source") {
          // The host still owns access and bucket reads; the worker receives no credentials.
          try {
            const bytes = input.sourceVersionIds.includes(message.versionId)
              ? await readSourcePdf?.(input.projectId, message.versionId) : null;
            if (!finished) worker.postMessage({ id: message.id, bytes: bytes ?? null });
          } catch {
            if (!finished) worker.postMessage({ id: message.id, bytes: null });
          }
        }
      });
    });
  } finally {
    finished = true;
    clearTimeout(timeout!);
    await worker.terminate();
  }
}

if (!isMainThread) {
  let nextId = 0;
  const readSourcePdf = (_projectId: string, versionId: string) => new Promise<Buffer | null>(resolve => {
    const id = nextId++;
    const listener = (message: { id: number; bytes: Uint8Array | null }) => {
      if (message.id !== id) return;
      parentPort!.off("message", listener);
      resolve(message.bytes ? Buffer.from(message.bytes) : null);
    };
    parentPort!.on("message", listener);
    parentPort!.postMessage({ kind: "source", id, versionId });
  });
  artifactPdf({ ...workerData, readSourcePdf }).then(
    bytes => parentPort!.postMessage({ kind: "done", bytes }),
    error => parentPort!.postMessage({ kind: "failed", message: error.message,
      status: error.status, code: error.code }),
  );
}
