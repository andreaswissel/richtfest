import { expect, test } from "bun:test";
import { resolveCompleteDocumentModel } from "./source-evidence";
import type { AppDeps } from "./deps";
const versionId = "11111111-1111-4111-8111-111111111111";
const page = (n: number) => ({ version: 1, parserVersion: "text-grid-v1", versionId, page: n,
  rawTextSha256: "a".repeat(64), rawTextBytes: 0, origin: "unknown", status: "available", sourceStatus: "available",
  positionSpace: "extracted_text_grid", blocks: [], limitations: [] });
const model = (pages: any[], nextOffset: number | null) => ({ version: 1, versionId, pages, nextOffset,
  layersPrepared: false, layers: { status: "unavailable", parserVersion: "pdfjs-optional-content-v1",
    visibilityIntent: "display", originalPdfSha256: null, groups: [], blockAssociation: "unknown" },
  coverage: { extractionStatus: "complete", totalPages: 2, savedPages: 2, preparedPages: 2, unpreparedPages: 0,
    unreadablePages: 0, incompletePages: 0, complete: true, semanticCompleteness: false } });
const deps = (models: any[]) => ({ resolveSource: async () => ({ status: "resolved", source: { versionId },
  content: { documentModel: models.shift() } }) }) as unknown as AppDeps;
test("complete document reader keeps original page identity and explicitly nonsemantic completeness", async () => {
  const result = await resolveCompleteDocumentModel(deps([model([page(1)], 1), model([page(2)], null)]), versionId, versionId, async () => {});
  expect(result?.pages.map(p => p.page)).toEqual([1, 2]);
  expect(result?.coverage.semanticCompleteness).toBe(false);
});
test("document reader rejects duplicate pages, changing coverage and stalled pagination", async () => {
  expect(await resolveCompleteDocumentModel(deps([model([page(1)], 1), model([page(1)], null)]), versionId, versionId, async () => {})).toBeNull();
  await expect(resolveCompleteDocumentModel(deps([model([page(1)], 1), model([page(2)], 1)]), versionId, versionId, async () => {})).rejects.toThrow("pagination");
  const changed = model([page(2)], null); changed.coverage.totalPages = 3;
  await expect(resolveCompleteDocumentModel(deps([model([page(1)], 1), changed]), versionId, versionId, async () => {})).rejects.toThrow("changed");
});
