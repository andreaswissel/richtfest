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
