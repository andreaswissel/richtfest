import { z } from "zod";

/** A proposed deliverable, distinct from the short conversational handoff. */
export const agentDocumentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(60000),
}).strict();

export type SourceReference = { versionId: string; fileName: string; version: number };

export function sourceReferenceLabel(source: SourceReference) {
  return `${source.fileName} · v${source.version}`;
}

/** Resolve bracketed immutable-version citations, never model-authored names or URLs. */
export function formatSourceCitations(
  text: string,
  projectId: string,
  sources: SourceReference[],
  unavailable = "Source unavailable",
) {
  const byId = new Map(sources.map(source => [source.versionId.toLowerCase(), source]));
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const escape = (value: string) => value.replace(/[\\`*_[\]<>|]/g, "\\$&").replace(/[\r\n]/g, " ");
  return text.replace(/\[([^\]\n]+)\](?!\()/g, (original, citation: string) => {
    if (!citation.match(uuid)) return original;
    return citation.replace(uuid, id => {
      const source = byId.get(id.toLowerCase());
      return source
        ? `[${escape(sourceReferenceLabel(source))}](/projects/${encodeURIComponent(projectId)}?panel=documents&sourceVersion=${encodeURIComponent(source.versionId)})`
        : escape(unavailable);
    });
  });
}
