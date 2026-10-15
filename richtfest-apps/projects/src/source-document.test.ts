import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buildSourceDocumentPage, savedSourceDocumentPage, withSourceDocumentPage, prepareSourceDocumentLayers } from "./source-document";
import { inspectPdfLayers } from "./pdf-layers";
import { createSourceModelRouter } from "./source-model-router";

const versionId = "11111111-1111-4111-8111-111111111111";
const text = "[Page 1]\n[Native text]\n  Küche  😀 Bad\r\n\tWand";
test("literal blocks preserve Unicode byte offsets and stable IDs without physical geometry", () => {
  const content = { status: "available" as const, text };
  const model = buildSourceDocumentPage(versionId, 1, content);
  expect(model).toEqual(buildSourceDocumentPage(versionId, 1, content));
  expect(model.rawTextSha256).toBe(createHash("sha256").update(text).digest("hex"));
  expect(model.positionSpace).toBe("extracted_text_grid");
  expect(model.origin).toBe("native_text");
  expect(model.blocks.map(block => block.text)).toEqual(["[Page 1]", "[Native text]", "Küche", "😀 Bad", "Wand"]);
  for (const block of model.blocks) {
    expect(Buffer.from(text).subarray(block.startByte, block.endByte).toString()).toBe(block.text);
    expect(block).not.toHaveProperty("planRegion");
    expect(block.layerAssociation).toBe("unknown");
  }
  expect(withSourceDocumentPage(versionId, 1, withSourceDocumentPage(versionId, 1, content))).toEqual(withSourceDocumentPage(versionId, 1, content));
});
test("saved page validation rejects changed source, missing blocks, and wrong version", () => {
  const content = withSourceDocumentPage(versionId, 1, { status: "available", text });
  expect(() => savedSourceDocumentPage(versionId, 1, { ...content, text: text + "!" })).toThrow();
  expect(() => savedSourceDocumentPage(versionId, 1, { ...content, documentModel: { ...content.documentModel!, blocks: [] } })).toThrow();
  expect(() => savedSourceDocumentPage(versionId, 1, { ...content, documentModel: { ...content.documentModel!,
    blocks: content.documentModel!.blocks.map(block => ({ ...block, column: block.column + 1 })) } })).toThrow();
  expect(() => savedSourceDocumentPage("22222222-2222-4222-8222-222222222222", 1, content)).toThrow();
  expect(buildSourceDocumentPage(versionId, 1, { status: "available", text, truncated: true }).status).toBe("incomplete");
});
test("failed PDF inspection remains unknown with original hash, cached layers do not reread storage", async () => {
  const bytes = Buffer.from("not a PDF");
  const result = await inspectPdfLayers(Readable.from([bytes]));
  expect(result.status).toBe("unavailable");
  expect(result.originalPdfSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  const reused = await prepareSourceDocumentLayers({ name: "plan.pdf", mimeType: "application/pdf", storageKey: "x" },
    { read: async () => { throw new Error("must not reread"); } }, result);
  expect(reused).toEqual(result);
});

test("PDF layer directory preserves hidden display intent without claiming text association", async () => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [4 0 R 5 0 R] /D << /Order [(Plans) 4 0 R 5 0 R] /OFF [5 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    "<< /Type /OCG /Name (Visible) >>",
    "<< /Type /OCG /Name (Hidden) >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const result = await inspectPdfLayers(Readable.from([Buffer.from(pdf)]));
  expect(result.status).toBe("detected");
  expect(result.groups.map(group => [group.name, group.defaultVisibility])).toEqual([["Visible", "visible"], ["Hidden", "hidden"]]);
  expect(result.visibilityIntent).toBe("display");
  expect(result.blockAssociation).toBe("unknown");
});

function route(method: string, suffix: string, deps: any) {
  const router: any = createSourceModelRouter(() => deps);
  return router.stack.find((layer: any) => layer.route?.path.endsWith(suffix) && layer.route.methods[method]).route.stack[0].handle;
}
const req = { params: { projectId: versionId, versionId }, body: {}, query: {} };
function database(results: any[], onTransaction = () => {}) {
  const db: any = {
    select: () => {
      const value = results.shift();
      const query: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
      for (const key of ["from", "innerJoin", "where", "for", "orderBy", "offset", "limit"]) query[key] = () => query;
      return query;
    },
    transaction: async (fn: any) => { onTransaction(); return fn(db); },
  };
  return db;
}
test("document reads require permission and a source in the requested project", async () => {
  let error: any;
  await route("get", "/document-model", { requirePermission: () => { throw new Error("forbidden"); } })(req, {}, (e: any) => error = e);
  expect(error.message).toBe("forbidden");
  await route("get", "/document-model", { requirePermission: () => {}, db: database([[]]), tenantId: versionId })(req, {}, (e: any) => error = e);
  expect(error.status).toBe(404);
});
test("PDF preparation happens outside locks and purpose is revalidated before writes", async () => {
  let locked = false, reads = 0, error: any;
  const source = { id: versionId, fileId: versionId, purpose: "project_evidence", name: "plan.pdf", mimeType: "application/pdf", storageKey: "x" };
  const db = database([[source], [{ result: { status: "available" } }], [{ purpose: "comparison" }]], () => { locked = true; });
  await route("post", "/document-model/prepare", { db, tenantId: versionId, requirePermission: () => {},
    fileStorage: { read: async () => { expect(locked).toBe(false); reads++; return Readable.from([Buffer.from("invalid")]); } },
  })(req, {}, (e: any) => error = e);
  expect(reads).toBe(1);
  expect(error.code).toBe("source_purpose_excluded");
});
test("preparation rejects mutation of immutable version metadata before saving", async () => {
  let error: any;
  const source = { id: versionId, fileId: versionId, purpose: "project_evidence", name: "text.txt", mimeType: "text/plain", storageKey: "x" };
  const db = database([[source], [{ result: { status: "available" } }], [{ purpose: "project_evidence" }], [{ id: versionId, storageKey: "changed", mimeType: "text/plain" }]]);
  await route("post", "/document-model/prepare", { db, tenantId: versionId, requirePermission: () => {}, fileStorage: {} })(req, {}, (e: any) => error = e);
  expect(error.code).toBe("source_version_changed");
});
