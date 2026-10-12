import type { AppDeps } from "./deps";

/** Agent execution waits without provider calls; the source HTTP API stays fast. */
export async function resolveRunSource(d: AppDeps, projectId: string,
  input: Parameters<AppDeps["resolveSource"]>[1], assertActive: () => Promise<unknown>) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    await assertActive();
    const result = await d.resolveSource(projectId, input);
    if ((result as { content?: { status?: string } })?.content?.status !== "processing") return result;
    if (Date.now() >= deadline) throw new Error("Source extraction is still in progress. Retry the run after upload processing completes.");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/** Read saved PDF pages to the end of the requested range, never just search hits. */
export async function resolveCompleteRunSource(d: AppDeps, projectId: string,
  input: { versionId: string; pageStart?: number; pageEnd?: number }, assertActive: () => Promise<unknown>) {
  const first: any = await resolveRunSource(d, projectId, { ...input, pageStart: input.pageStart ?? 1 }, assertActive);
  if (first?.status !== "resolved" || first.source?.versionId !== input.versionId || !first.content?.coverage) return first;
  const parts = [first.content];
  const end = input.pageEnd ?? first.content.coverage.totalPages;
  let next = first.content.coverage.nextPage;
  let previous = input.pageStart ?? 1;
  while (next !== null && next !== undefined && next <= end) {
    if (next <= previous) throw new Error("Saved source pagination did not advance. Restore source extraction before retrying.");
    previous = next;
    const result: any = await resolveRunSource(d, projectId, { ...input, pageStart: next, pageEnd: end }, assertActive);
    if (result?.status !== "resolved" || result.source?.versionId !== input.versionId || !result.content?.coverage)
      throw new Error("Saved source coverage changed while reading the report.");
    parts.push(result.content);
    next = result.content.coverage.nextPage;
  }
  const pageNumbers = [...new Set<number>(parts.flatMap(part => part.retrieval?.pageNumbers ?? []))].sort((a, b) => a - b);
  const start = input.pageStart ?? 1;
  const complete = parts.every(part => part.status === "available") && pageNumbers.length === end - start + 1
    && pageNumbers.every((page, index) => page === start + index);
  return { ...first, content: { ...first.content,
    text: parts.map(part => part.text ?? "").join("\n"),
    truncated: !complete,
    reason: [...new Set(parts.map(part => part.reason).filter(Boolean))].join("\n"),
    coverage: { pageStart: start, pageEnd: pageNumbers.at(-1) ?? start - 1, totalPages: first.content.coverage.totalPages,
      truncated: !complete, nextPage: null },
    retrieval: { mode: "pages", pageNumbers, characters: parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0) },
  } };
}
