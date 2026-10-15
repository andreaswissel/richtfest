import { createHash } from "node:crypto";
import type { SourceDocumentLayers } from "@richtfest/shared";

/** Inspect PDF optional content without rendering, interpreting or changing it.
 * PDF object IDs are scoped to the immutable file, never global layer identities. */
export async function inspectPdfLayers(stream: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<SourceDocumentLayers> {
  const base = { parserVersion: "pdfjs-optional-content-v1" as const, visibilityIntent: "display" as const,
    blockAssociation: "unknown" as const };
  let originalPdfSha256: string | null = null;
  let task: { destroy(): Promise<void> } | undefined;
  const abort = () => { void task?.destroy().catch(() => {}); };
  try {
    const chunks: Uint8Array[] = [];
    const hash = createHash("sha256");
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      hash.update(chunk); chunks.push(chunk);
    }
    const data = new Uint8Array(Buffer.concat(chunks));
    originalPdfSha256 = hash.digest("hex");
    signal?.throwIfAborted();
    // Server-only and lazy: never add the PDF parser to the browser boot path.
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data, useSystemFonts: false, verbosity: 0 });
    task = loading;
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    const pdf = await loading.promise;
    const config = await pdf.getOptionalContentConfig({ intent: "display" });
    // PostgreSQL JSONB cannot store NUL; retain it as a visible escape in labels.
    const label = (value: string) => value.replace(/\0/g, "\\u0000");
    const positions = new Map<string, { order: number; path: string[] }>();
    const collectOrder = (items: unknown[], path: string[]) => {
      for (const item of items) {
        if (typeof item === "string") {
          if (!positions.has(item)) positions.set(item, { order: positions.size, path });
        } else if (item && typeof item === "object" && "order" in item && Array.isArray(item.order)) {
          // Keep grouping labels, including duplicate names, as source metadata.
          const name = "name" in item && typeof item.name === "string" ? item.name : null;
          collectOrder(item.order, name === null ? path : [...path, label(name)]);
        }
      }
    };
    collectOrder(config.getOrder() ?? [], []);
    const groups: SourceDocumentLayers["groups"] = [];
    for (const [id, group] of config) {
      const position = positions.get(id) ?? { order: positions.size + groups.length, path: [] };
      groups.push({ id, name: typeof group.name === "string" ? label(group.name) : null,
        defaultVisibility: typeof group.visible === "boolean" ? group.visible ? "visible" : "hidden" : "unknown",
        ...position });
    }
    groups.sort((a, b) => a.order - b.order);
    return { ...base, originalPdfSha256, status: groups.length ? "detected" : "none", groups };
  } catch {
    // Fail closed: inability to inspect is not evidence of an unlayered PDF.
    return { ...base, originalPdfSha256, status: "unavailable", groups: [],
      reason: "PDF optional-content metadata could not be inspected. Layer presence and visibility remain unknown." };
  } finally {
    signal?.removeEventListener("abort", abort);
    await task?.destroy().catch(() => {});
    (stream as AsyncIterable<Uint8Array> & { destroy?: () => void }).destroy?.();
  }
}
