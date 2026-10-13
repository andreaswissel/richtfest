import { expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { readSourceText, runSourceExtraction } from "../richtfest-apps/projects/src/source-extraction";
import { readSourceEvidence, readSourceModel, runSourceModel } from "../richtfest-apps/projects/src/source-model";
import { createRouter } from "../richtfest-apps/projects/src/router";
import { knowledgeDeps } from "../richtfest-os/apps/api/src/app-hosts";
import { files, fileVersions, projects, sourceExtractions, sourcePages, sourceModels, sourceFacts } from "../richtfest-apps/projects/src/schema";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import express from "../richtfest-os/apps/api/node_modules/express";
import type { SourceModelDeps } from "../richtfest-apps/projects/src/deps";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = process.env.DATABASE_URL ? test : test.skip;

// Deliberately dense, asymmetric pages: relevance must find the last page, not
// silently return page one or stop extracting after an aggregate text ceiling.
function pdfFixture() {
  const pages = Array.from({ length: 8 }, (_, index) => `BT /F1 12 Tf 20 9000 Td 20 TL
    ${Array.from({ length: 75 }, () => `(${`Background material ${index + 1} `.repeat(45)}) Tj T*`).join("\n")}
    (${index === 7 ? "Acoustic target AL24 thickness 240 mm" : `Other topic ${index + 1}`}) Tj ET`);
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count 8 >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const page of pages) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 10000] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(page)} >>\nstream\n${page}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

run("saved extraction survives unavailable originals, concurrent workers, revisions and interrupted jobs", async () => {
  const admin = createDatabase(process.env.DATABASE_URL!);
  const namespace = `source_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.pool.query(`create schema ${namespace}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(url.toString());
  const tenantId = crypto.randomUUID(), fileId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const first = crypto.randomUUID(), second = crypto.randomUUID(), broken = crypto.randomUUID();
  const originals = new Map<string, Buffer>();
  try {
    await pool.query("create table projects_files (like public.projects_files including all); create table projects_file_versions (like public.projects_file_versions including all)");
    await db.insert(files).values({ id: fileId, tenantId, projectId: crypto.randomUUID(), name: "planning.pdf", sourceType: "upload", createdBy: actorId });
    await db.insert(fileVersions).values([
      { id: first, tenantId, fileId, version: 1, status: "ready", storageKey: first, mimeType: "application/pdf", createdBy: actorId },
      { id: second, tenantId, fileId, version: 2, status: "pending", storageKey: second, mimeType: "application/pdf", createdBy: actorId },
    ]);
    // Use the real migration, including backfill. Pending uploads stay unqueued.
    await pool.query(await Bun.file(new URL("../richtfest-os/apps/api/drizzle/0026_source_extraction.sql", import.meta.url)).text());
    expect((await db.select().from(sourceExtractions)).map(row => row.versionId)).toEqual([first]);
    originals.set(first, pdfFixture());
    const d = {
      db, audit: async () => {}, reportError: () => {},
      fileStorage: { read: async (key: string) => {
        const bytes = originals.get(key);
        if (!bytes) throw new Error("Original intentionally unavailable");
        // Any repeated extraction would now fail, even in another worker.
        originals.delete(key);
        return (async function* () { yield bytes; })();
      } },
    };
    expect((await readSourceText(db, tenantId, first)).status).toBe("processing");
    const claimed = await Promise.all([runSourceExtraction(d, new AbortController().signal), runSourceExtraction(d, new AbortController().signal)]);
    expect(claimed.sort()).toEqual([false, true]);
    const exact = await readSourceText(db, tenantId, first, { pageStart: 8, pageEnd: 8 });
    expect(exact.text).toContain("Acoustic target AL24 thickness 240 mm");
    expect(exact.text).not.toContain("Other topic 1");
    expect(exact.coverage).toEqual({ pageStart: 8, pageEnd: 8, totalPages: 8, truncated: true, nextPage: null });
    const relevant = await readSourceText(db, tenantId, first, { textQuery: "Acoustic AL24" });
    expect(relevant.text).toContain("Acoustic target AL24 thickness 240 mm");
    expect(relevant.text!.length).toBeLessThanOrEqual(16000);
    expect(relevant.retrieval?.pageNumbers).toContain(8);
    expect(relevant.truncated).toBe(true);
    expect((await db.select().from(sourcePages)).reduce((n, row) => n + (row.content.text?.length ?? 0), 0)).toBeGreaterThan(256 * 1024);
    expect(await readSourceText(db, tenantId, first, { pageStart: 8, pageEnd: 8 })).toEqual(exact);
    expect((await readSourceText(db, crypto.randomUUID(), first)).text).toBeUndefined();
    expect((await readSourceText(db, tenantId, first, { pageStart: 9 })).status).toBe("extraction_failed");
    expect(await runSourceExtraction(d, new AbortController().signal)).toBe(false);

    // A new revision has its own result; the prior immutable evidence survives.
    await db.update(files).set({ name: "planning.txt" }).where(eq(files.id, fileId));
    await db.update(fileVersions).set({ status: "ready", mimeType: "text/plain" }).where(eq(fileVersions.id, second));
    await db.insert(sourceExtractions).values({ versionId: second, tenantId });
    originals.set(second, Buffer.from("Revised acoustic target AL30 thickness 300 mm"));
    await runSourceExtraction(d, new AbortController().signal);
    expect((await readSourceText(db, tenantId, second)).text).toContain("AL30 thickness 300 mm");
    expect((await readSourceText(db, tenantId, first, { pageStart: 8, pageEnd: 8 })).text).toContain("AL24 thickness 240 mm");

    // Resume an expired lease after all pages were committed: no original read.
    await db.update(sourceExtractions).set({ status: "running", leaseToken: crypto.randomUUID(), leaseUntil: new Date(0) }).where(eq(sourceExtractions.versionId, first));
    await runSourceExtraction(d, new AbortController().signal);
    expect((await readSourceText(db, tenantId, first, { pageStart: 8, pageEnd: 8 })).text).toContain("AL24 thickness 240 mm");

    // Corrupt input is a persistent terminal outcome, never a read-triggered retry.
    await db.insert(fileVersions).values({ id: broken, tenantId, fileId, version: 3, status: "ready", storageKey: broken, mimeType: "application/pdf", createdBy: actorId });
    await db.insert(sourceExtractions).values({ versionId: broken, tenantId });
    originals.set(broken, Buffer.from("%PDF-corrupt"));
    await runSourceExtraction(d, new AbortController().signal);
    expect((await readSourceText(db, tenantId, broken)).status).toBe("extraction_failed");
    expect(await runSourceExtraction(d, new AbortController().signal)).toBe(false);

    // Recovery starts after the committed page, never replacing its evidence.
    const resumed = crypto.randomUUID();
    await db.insert(fileVersions).values({ id: resumed, tenantId, fileId, version: 4, status: "ready", storageKey: resumed, mimeType: "application/pdf", createdBy: actorId });
    await db.insert(sourceExtractions).values({ versionId: resumed, tenantId, status: "running", nextPage: 2, result: { status: "available", pages: 8 }, leaseToken: crypto.randomUUID(), leaseUntil: new Date(0) });
    await db.insert(sourcePages).values({ versionId: resumed, tenantId, page: 1, content: { status: "available", pages: 8, text: "Previously committed page one" } });
    originals.set(resumed, pdfFixture());
    await runSourceExtraction(d, new AbortController().signal);
    expect((await readSourceText(db, tenantId, resumed, { pageStart: 1, pageEnd: 1 })).text).toBe("Previously committed page one");
    expect((await readSourceText(db, tenantId, resumed, { pageStart: 8, pageEnd: 8 })).text).toContain("AL24 thickness 240 mm");

    const unavailable = crypto.randomUUID();
    await db.insert(fileVersions).values({ id: unavailable, tenantId, fileId, version: 5, status: "ready", storageKey: unavailable, mimeType: "text/plain", createdBy: actorId });
    await db.insert(sourceExtractions).values({ versionId: unavailable, tenantId });
    for (let attempt = 0; attempt < 3; attempt++) {
      await db.update(sourceExtractions).set({ leaseUntil: new Date(0) }).where(eq(sourceExtractions.versionId, unavailable));
      expect(await runSourceExtraction(d, new AbortController().signal)).toBe(true);
    }
    expect((await readSourceText(db, tenantId, unavailable)).status).toBe("extraction_failed");
    expect(await runSourceExtraction(d, new AbortController().signal)).toBe(false);
  } finally {
    await pool.end();
    await admin.pool.query(`drop schema ${namespace} cascade`);
    await admin.pool.end();
  }
}, 30000);

run("upload models are persisted once, IFC bypasses AI, and source claims remain revision-scoped and reviewed separately", async () => {
  const admin = createDatabase(process.env.DATABASE_URL!);
  const namespace = `model_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.pool.query(`create schema ${namespace}`);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(url.toString());
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const ifcFile = crypto.randomUUID(), ifcVersion = crypto.randomUUID();
  const originals = new Map<string, Buffer>();
  const audits: string[] = [];
  let providerCalls = 0, reads = 0, accessTenant = tenantId, mayApprove = true;
  let deniedPermission = "", failRecoveryAudit = false;
  let visualProvenance = "inferred", wrongImageScope = false;
  const signal = new AbortController().signal;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  const d: SourceModelDeps = {
    db, reportError: () => {}, audit: async (_tx, _tenant, action) => { audits.push(action); },
    fileStorage: { read: async key => {
      reads++;
      const data = originals.get(key);
      if (!data) throw new Error("No original available; a read must use persisted evidence");
      originals.delete(key);
      return (async function* () { yield data; })();
    } },
    structureDocument: async input => {
      providerCalls++;
      expect(input.pages.reduce((n, page) => n + page.text.length, 0)).toBeLessThanOrEqual(24000);
      expect(input.actorId).toBe(actorId);
      if (input.image) {
        expect(input.image.mediaType).toBe("image/jpeg");
        expect(Buffer.from(input.image.data, "base64").subarray(0, 2)).toEqual(Buffer.from([255, 216]));
        return { status: "completed", metadata: {}, output: {
          entities: [{ key: "illustration", kind: "diagram", name: "Source illustration" }],
          facts: [{ entityKey: "illustration", predicate: "appearance", kind: "attribute", value: { type: "text", value: "Visible source illustration" }, unit: null,
            provenance: visualProvenance, evidence: { kind: "image", scope: wrongImageScope ? "affinity_preview" : input.image.scope, description: "Visible shapes in the supplied illustration" } }],
        } };
      }
      return { status: "completed", metadata: { provider: "mock", usage: { inputTokens: 10, outputTokens: 5 } },
        output: { entities: [{ key: "wall-a", kind: "wall", name: "Wall A" }], facts: [240, 300].map(value => ({
          entityKey: "wall-a", predicate: "thickness", kind: "requirement", value: { type: "number", value }, unit: { label: "mm" }, provenance: "extracted",
          evidence: { kind: "text", page: 1, quote: `Wall A thickness ${value} mm` },
        })) } };
    },
  };
  try {
    await pool.query("create table projects_files (like public.projects_files including all); create table projects_file_versions (like public.projects_file_versions including all); create table projects_projects (like public.projects_projects including all)");
    await db.insert(projects).values({ id: projectId, tenantId, name: "Model test", createdBy: actorId });
    await db.insert(files).values({ id: ifcFile, tenantId, projectId, name: "declared.ifc", sourceType: "upload", createdBy: actorId });
    await db.insert(fileVersions).values({ id: ifcVersion, tenantId, fileId: ifcFile, version: 1, status: "ready", storageKey: ifcVersion, mimeType: "application/octet-stream", createdBy: actorId });
    for (const migration of ["0026_source_extraction", "0027_source_model", "0037_source_representations"]) await pool.query(await Bun.file(new URL(`../richtfest-os/apps/api/drizzle/${migration}.sql`, import.meta.url)).text());
    expect((await db.select().from(sourceModels)).map(row => row.versionId)).toEqual([ifcVersion]);
    originals.set(ifcVersion, Buffer.from(`ISO-10303-21;
HEADER; FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1'); FILE_NAME('test.ifc','',(),(),'test','test',''); FILE_SCHEMA(('IFC4')); ENDSEC;
DATA;
#1=IFCPROJECT('project',$,'Project',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#10=IFCWALL('wall',$,'Wall A',$,$,$,$,$,.NOTDEFINED.);
#20=IFCPROPERTYSINGLEVALUE('Thickness',$,IFCLENGTHMEASURE(240.),$);
#21=IFCPROPERTYSET('properties',$,'Dimensions',$,(#20));
#22=IFCRELDEFINESBYPROPERTIES('relation',$,$,$,(#10),#21);
ENDSEC; END-ISO-10303-21;`));
    const ifcInput = { name: "declared.ifc", mimeType: "application/octet-stream", textQuery: "Thickness" };
    expect((await readSourceEvidence(db, tenantId, ifcVersion, ifcInput)).status).toBe("processing");
    expect(await runSourceModel(d, signal)).toBe(false); // Wait for upload extraction routing.
    await runSourceExtraction(d, signal);
    expect(reads).toBe(0); // Raw STEP never enters the text/OCR pipeline.
    expect((await Promise.all([runSourceModel(d, signal), runSourceModel(d, signal)])).sort()).toEqual([false, true]);
    const imported = await readSourceModel(db, tenantId, ifcVersion, { query: "Thickness", limit: 1 });
    expect(imported).toMatchObject({ status: "complete", method: "ifc", nextOffset: null });
    expect((await readSourceModel(db, tenantId, ifcVersion, { limit: 1 }))!.nextOffset).toBe(1);
    expect(imported!.facts[0].fact).toMatchObject({ predicate: "instance.Dimensions.Thickness", value: { type: "number", value: 240 },
      provenance: "deterministic", reviewStatus: "unreviewed", evidence: { kind: "ifc", expressId: 20, relationshipId: 22 } });
    expect(imported!.facts[0].fact.unit).toMatchObject({ source: "project-default", candidates: [{ Prefix: { value: "MILLI" }, Name: { value: "METRE" } }] });
    const originalEvidence = await readSourceEvidence(db, tenantId, ifcVersion, ifcInput);
    expect(originalEvidence.text).toContain('"value":240');
    expect(await readSourceEvidence(db, tenantId, ifcVersion, ifcInput)).toEqual(originalEvidence);
    expect(await readSourceModel(db, crypto.randomUUID(), ifcVersion)).toBeNull();
    expect(reads).toBe(1); expect(providerCalls).toBe(0);

    const contentTypes = new Map<string, string>();
    const app = express(); app.use(express.json());
    app.use("/api", createRouter(() => ({
      db, tenantId: accessTenant, actorId,
      requirePermission: permission => { if (permission === deniedPermission || (permission === "knowledge:approve" && !mayApprove)) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
      audit: async (_tx, action) => { if (failRecoveryAudit && action === "projects.source.reprocessing.queued") throw new Error("Audit unavailable"); audits.push(action); }, validateCustomer: async () => false, customerNames: async () => ({}),
      fileStorage: { kind: "bucket", ...d.fileStorage, initiate: async () => ({ uploadUrl: "/unused", headers: {}, expiresAt: new Date().toISOString() }),
        head: async key => ({ sizeBytes: originals.get(key)!.length, checksum: "fixture", mimeType: contentTypes.get(key)! }),
        saveStream: async () => { throw new Error("unused"); }, remove: async () => {}, download: async () => null },
    })));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ message: error.message }));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const upload = async (text: string | Buffer, fileId?: string, name = "requirements.txt", mimeType = "text/plain") => {
      const response = await post(`/api/projects/${projectId}/files${fileId ? `/${fileId}/versions` : ""}/initiate`, { name, mimeType });
      expect(response.status).toBe(201);
      const { data } = await response.json();
      const [source] = await db.select().from(fileVersions).where(eq(fileVersions.id, data.versionId));
      originals.set(source.storageKey!, Buffer.from(text));
      contentTypes.set(source.storageKey!, mimeType);
      expect((await post(data.completeUrl, {})).status).toBe(200);
      expect((await db.select().from(sourceModels).where(eq(sourceModels.versionId, data.versionId)))[0].status).toBe("queued");
      await runSourceExtraction(d, signal);
      return data;
    };
    // Single-batch fixture for review/read behavior; multi-batch collision and
    // atomic rejection are covered through runSourceModel in source-model.test.ts.
    const document = await upload("Wall A thickness 240 mm\nAlternate Wall A thickness 300 mm\n" + "Other material. ".repeat(100));
    await Promise.all([runSourceModel(d, signal), runSourceModel(d, signal)]);
    expect(providerCalls).toBe(1);
    const modelPath = `/api/projects/${projectId}/source-versions/${document.versionId}/model`;
    const response = await fetch(`${base}${modelPath}`); expect(response.status).toBe(200);
    const model = (await response.json()).data;
    expect(model.facts.map((row: any) => row.fact.value.value).sort()).toEqual([240, 300]); // No last-writer wins.
    expect(model.metadata).toMatchObject({ inputCharacters: 1658, usage: { inputTokens: 10, outputTokens: 5 } });
    const fact = model.facts[0].fact;
    const reviewPath = `/api/projects/${projectId}/source-versions/${document.versionId}/facts/${fact.id}/review`;
    const review = { expectedRevision: 0, status: "approved", note: "Checked against original" };
    mayApprove = false; expect((await post(reviewPath, review)).status).toBe(403); mayApprove = true;
    accessTenant = crypto.randomUUID(); expect((await fetch(`${base}${modelPath}`)).status).toBe(404);
    expect((await post(reviewPath, review)).status).toBe(404); accessTenant = tenantId;
    expect((await fetch(`${base}${modelPath.replace(projectId, crypto.randomUUID())}`)).status).toBe(404);
    const reviewed = await post(reviewPath, review); expect(reviewed.status).toBe(200);
    expect((await reviewed.json()).data).toMatchObject({ reviewedBy: actorId, reviewStatus: "approved", reviewRevision: 1, value: fact.value });
    expect((await post(reviewPath, review)).status).toBe(409);
    const host = knowledgeDeps(db, { actor: { id: actorId, tenantId, permissions: new Set(["projects:read", "knowledge:read"]) } } as any);
    const resolved: any = await host.resolveSource(projectId, { versionId: document.versionId, textQuery: "thickness" });
    expect(resolved.content.text).toContain('"reviewStatus":"approved"');
    expect(resolved.content.text).toContain('"reviewStatus":"unreviewed"');
    expect(resolved.content.text).not.toContain("Other material");
    const pages: any = await host.resolveSource(projectId, { versionId: document.versionId, pageStart: 1, pageEnd: 1 });
    expect(pages.content.text).toContain("Other material");
    expect(await runSourceModel(d, signal)).toBe(false); expect(providerCalls).toBe(1);
    expect(audits).toContain("projects.source.fact.reviewed");

    const next = await upload("Wall A thickness 240 mm\nWall A thickness 300 mm", document.fileId);
    await runSourceModel(d, signal);
    expect(providerCalls).toBe(2);
    expect((await readSourceModel(db, tenantId, next.versionId))!.facts.every((r: any) => r.fact.reviewStatus === "unreviewed")).toBe(true);
    expect((await db.select().from(sourceFacts).where(eq(sourceFacts.id, fact.id)))[0].reviewStatus).toBe("approved");
    // A crash after a provider request must not silently charge for another attempt.
    const interrupted = await upload("Wall A thickness 240 mm\nWall A thickness 300 mm");
    await db.update(sourceModels).set({ status: "running", leaseToken: crypto.randomUUID(), leaseUntil: new Date(0) }).where(eq(sourceModels.versionId, interrupted.versionId));
    await runSourceModel(d, signal); expect(providerCalls).toBe(2);
    expect((await readSourceModel(db, tenantId, interrupted.versionId))!.status).toBe("failed");
    // Quote hallucination rejects the whole proposal, with no partial approved data.
    const invalid = await upload("This page contains no thickness values");
    await runSourceModel(d, signal); expect(providerCalls).toBe(3);
    expect(await readSourceModel(db, tenantId, invalid.versionId)).toMatchObject({ status: "failed", facts: [], metadata: { usage: { inputTokens: 10 } } });
    expect(await runSourceModel(d, signal)).toBe(false);

    const recoveryPath = (id: string) => `/api/projects/${projectId}/source-versions/${id}/reprocess`;
    const recovery = () => post(recoveryPath(interrupted.versionId), {});
    const versionsBefore = await db.select().from(fileVersions);
    const pagesBefore = await db.select().from(sourcePages).where(eq(sourcePages.versionId, interrupted.versionId));
    const extractionBefore = (await db.select().from(sourceExtractions).where(eq(sourceExtractions.versionId, interrupted.versionId)))[0];
    for (const permission of ["projects:read", "projects:write", "agent:run"]) {
      deniedPermission = permission;
      expect((await recovery()).status).toBe(403);
    }
    deniedPermission = "";
    accessTenant = crypto.randomUUID(); expect((await recovery()).status).toBe(404); accessTenant = tenantId;
    expect((await post(recoveryPath(interrupted.versionId).replace(projectId, crypto.randomUUID()), {})).status).toBe(404);
    // Recovery never overwrites a successful source or its human review, even
    // when a stale/failed model record coexists with already persisted facts.
    const reviewedBefore = await db.select().from(sourceFacts).where(eq(sourceFacts.versionId, document.versionId));
    expect((await post(recoveryPath(document.versionId), {})).status).toBe(409);
    await db.update(sourceModels).set({ status: "failed" }).where(eq(sourceModels.versionId, document.versionId));
    expect((await post(recoveryPath(document.versionId), {})).status).toBe(409);
    expect(await db.select().from(sourceFacts).where(eq(sourceFacts.versionId, document.versionId))).toEqual(reviewedBefore);
    await db.update(sourceModels).set({ status: "complete" }).where(eq(sourceModels.versionId, document.versionId));
    failRecoveryAudit = true; expect((await recovery()).status).toBe(500); failRecoveryAudit = false;
    expect((await readSourceModel(db, tenantId, interrupted.versionId))!.status).toBe("failed");
    const auditCount = audits.filter(action => action === "projects.source.reprocessing.queued").length;
    const queued = await Promise.all([recovery(), recovery()]);
    expect(queued.map(response => response.status).sort()).toEqual([202, 409]);
    expect((await queued.find(response => response.status === 202)!.json()).data).toEqual({ versionId: interrupted.versionId, extraction: "complete", model: "queued" });
    expect(audits.filter(action => action === "projects.source.reprocessing.queued")).toHaveLength(auditCount + 1);
    expect(await db.select().from(fileVersions)).toEqual(versionsBefore);
    expect(await db.select().from(sourcePages).where(eq(sourcePages.versionId, interrupted.versionId))).toEqual(pagesBefore);
    expect((await db.select().from(sourceExtractions).where(eq(sourceExtractions.versionId, interrupted.versionId)))[0]).toEqual(extractionBefore);
    const readsBeforeRetry = reads;
    await runSourceModel(d, signal);
    expect(reads).toBe(readsBeforeRetry);
    expect((await readSourceModel(db, tenantId, interrupted.versionId))!.status).toBe("complete");

    // Failed extraction resets atomically, but original storage and version
    // identity remain untouched. Both queued and running records fence retries.
    await db.update(sourceExtractions).set({ status: "failed", attempts: 3, nextPage: 2, result: { status: "extraction_failed", reason: "fixture" } }).where(eq(sourceExtractions.versionId, invalid.versionId));
    failRecoveryAudit = true; expect((await post(recoveryPath(invalid.versionId), {})).status).toBe(500); failRecoveryAudit = false;
    expect((await db.select().from(sourcePages).where(eq(sourcePages.versionId, invalid.versionId))).length).toBeGreaterThan(0);
    expect((await post(recoveryPath(invalid.versionId), {})).status).toBe(202);
    expect((await db.select().from(sourceExtractions).where(eq(sourceExtractions.versionId, invalid.versionId)))[0]).toMatchObject({ status: "queued", attempts: 0, nextPage: 1, result: null, leaseToken: null, leaseUntil: null });
    expect(await db.select().from(sourcePages).where(eq(sourcePages.versionId, invalid.versionId))).toEqual([]);
    expect((await post(recoveryPath(invalid.versionId), {})).status).toBe(409);
    await db.update(sourceModels).set({ status: "running" }).where(eq(sourceModels.versionId, invalid.versionId));
    expect((await post(recoveryPath(invalid.versionId), {})).status).toBe(409);
    expect(await db.select().from(fileVersions)).toEqual(versionsBefore);
    // Settle this deliberately broken fixture before the OCR worker cases.
    await db.update(sourceExtractions).set({ status: "failed" }).where(eq(sourceExtractions.versionId, invalid.versionId));
    await db.update(sourceModels).set({ status: "failed" }).where(eq(sourceModels.versionId, invalid.versionId));

    // Real OCR travels through upload completion, durable extraction, and both
    // agent evidence paths. Preview limitations must survive model indexing.
    const { stdout: image } = await promisify(execFile)("convert", ["-size", "1000x400", "xc:white", "-font", "DejaVu-Sans", "-pointsize", "38", "-fill", "black", "-annotate", "+40+100", "Wall A thickness 240 mm", "-annotate", "+40+200", "Wall A thickness 300 mm", "png:-"], { encoding: "buffer", maxBuffer: 1024 * 1024 });
    for (const previewOnly of [false, true]) {
      const input = previewOnly ? Buffer.concat([Buffer.from([0, 255, 75, 65]), image]) : image;
      const name = previewOnly ? "concept.afpub" : "scan.png";
      const mimeType = previewOnly ? "application/octet-stream" : "image/png";
      const uploaded = await upload(input, undefined, name, mimeType);
      expect((await host.resolveSource(projectId, { versionId: uploaded.versionId }) as any).content.status).toBe("processing");
      const text: any = await host.resolveSource(projectId, { versionId: uploaded.versionId, pageStart: 1, pageEnd: 1 });
      expect(text.content.status).toBe("available");
      expect(text.content.text).toContain("Wall A thickness 240 mm");
      expect(text.content.truncated).toBe(previewOnly);
      expect(text.content.reason).toContain("unverified transcription");
      const [source] = await db.select().from(fileVersions).where(eq(fileVersions.id, uploaded.versionId));
      originals.set(source.storageKey!, input); // One additional upload-time visual read.
      await runSourceModel(d, signal);
      const indexed: any = await host.resolveSource(projectId, { versionId: uploaded.versionId, textQuery: "unrelated acoustic requirements" });
      expect(indexed.content.text).toContain('"provenance":"inferred"');
      expect(indexed.content.text).toContain('"reviewStatus":"unreviewed"');
      expect(indexed.content.text).toContain('"kind":"image"');
      expect(indexed.content.reason).toContain("unverified transcription");
      if (previewOnly) {
        expect(indexed.content.reason).toContain("embedded preview only; not the full document");
        expect(indexed.content.model.metadata.sourcePages).toBeNull();
      }
      const saved: any = await host.resolveSource(projectId, { versionId: uploaded.versionId, pageStart: 1, pageEnd: 1 });
      expect(saved.content.text).toContain("Wall A thickness 300 mm");
      expect(saved.content.truncated).toBe(previewOnly);
    }
    const { stdout: drawing } = await promisify(execFile)("convert", ["-size", "400x200", "xc:white", "-fill", "blue", "-draw", "rectangle 20,20 120,160", "-fill", "red", "-draw", "circle 260,100 300,100", "png:-"], { encoding: "buffer" });
    for (const scenario of ["valid", "extracted", "wrong_scope"]) {
      visualProvenance = scenario === "extracted" ? "extracted" : "inferred";
      wrongImageScope = scenario === "wrong_scope";
      const uploaded = await upload(drawing, undefined, "drawing.png", "image/png");
      expect((await readSourceText(db, tenantId, uploaded.versionId)).status).toBe("extraction_failed");
      const [source] = await db.select().from(fileVersions).where(eq(fileVersions.id, uploaded.versionId));
      originals.set(source.storageKey!, drawing);
      const before = providerCalls;
      await runSourceModel(d, signal);
      expect(providerCalls).toBe(before + 1);
      const result: any = await host.resolveSource(projectId, { versionId: uploaded.versionId, textQuery: "acoustics" });
      if (scenario === "valid") {
        expect(result.content.status).toBe("available");
        expect(result.content.text).toContain("Visible source illustration");
        const readsBefore = reads;
        expect(await host.resolveSource(projectId, { versionId: uploaded.versionId, textQuery: "acoustics" })).toEqual(result);
        expect(reads).toBe(readsBefore);
      } else {
        expect(result.content.model.status).toBe("failed");
        expect(result.content.text).toBeUndefined();
      }
    }
    expect(await runSourceExtraction(d, signal)).toBe(false);
  } finally {
    server?.closeAllConnections(); server?.close();
    await pool.end(); await admin.pool.query(`drop schema ${namespace} cascade`); await admin.pool.end();
  }
}, 30000);

run("Affinity PDF links require confirmation and preserve exact revisions, access and evidence identity", async () => {
  const admin = createDatabase(process.env.DATABASE_URL!);
  const namespace = `pairing_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.pool.query(`create schema ${namespace}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(url.toString());
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  let accessTenant = tenantId, deniedPermission = "", failAudit = false;
  const audits: string[] = [];
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    await pool.query("create table projects_files (like public.projects_files including all); create table projects_file_versions (like public.projects_file_versions including all); create table projects_projects (like public.projects_projects including all)");
    await db.insert(projects).values({ id: projectId, tenantId, name: "Pairing test", createdBy: actorId });
    for (const migration of ["0026_source_extraction", "0027_source_model", "0037_source_representations"])
      await pool.query(await Bun.file(new URL(`../richtfest-os/apps/api/drizzle/${migration}.sql`, import.meta.url)).text());
    const source = async (name: string, mimeType: string, scope = projectId, tenant = tenantId, status = "ready") => {
      const fileId = crypto.randomUUID(), versionId = crypto.randomUUID();
      await db.insert(files).values({ id: fileId, tenantId: tenant, projectId: scope, name, sourceType: "upload", createdBy: actorId });
      await db.insert(fileVersions).values({ id: versionId, fileId, tenantId: tenant, version: 1, mimeType, status, storageKey: versionId, createdBy: actorId });
      return { fileId, versionId };
    };
    const original = await source("report.afpub", "application/octet-stream");
    const pdf = await source("matching-export.pdf", "application/pdf");
    const replacement = await source("corrected-export.pdf", "application/pdf");
    const foreign = await source("foreign.pdf", "application/pdf", projectId, crypto.randomUUID());
    const otherProject = await source("other-project.pdf", "application/pdf", crypto.randomUUID());
    const pending = await source("pending.pdf", "application/pdf", projectId, tenantId, "pending");
    const notPdf = await source("deceptive.pdf", "text/plain");
    await db.insert(sourceExtractions).values({ versionId: pdf.versionId, tenantId });
    await runSourceExtraction({ db, audit: async () => {}, reportError: () => {}, fileStorage: {
      read: async () => (async function* () { yield pdfFixture(); })(),
    } }, new AbortController().signal);
    const host = knowledgeDeps(db, { actor: { id: actorId, tenantId, permissions: new Set(["projects:read", "knowledge:read"]) } } as any);
    const originalBefore: any = await host.resolveSource(projectId, { versionId: original.versionId });
    const app = express(); app.use(express.json());
    app.use("/api", createRouter(() => ({ db, tenantId: accessTenant, actorId,
      requirePermission: (permission: string) => { if (permission === deniedPermission) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
      audit: async (_tx: any, action: string) => { if (failAudit) throw new Error("Audit unavailable"); audits.push(action); },
    }) as any));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ message: error.message }));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/projects/${projectId}`;
    const path = `${base}/source-versions/${original.versionId}/pdf-representation`;
    const send = (body: unknown, method = "PUT", target = path) => fetch(target, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const body = { pdfVersionId: pdf.versionId, expectedPdfVersionId: null, confirmed: true };
    const getOriginal = async () => (await (await fetch(`${base}/source-versions/${original.versionId}`)).json()).data;
    expect((await send({ ...body, confirmed: false })).status).toBe(400);
    for (const permission of ["projects:read", "projects:write"]) {
      deniedPermission = permission; expect((await send(body)).status).toBe(403);
    }
    deniedPermission = "";
    accessTenant = crypto.randomUUID(); expect((await send(body)).status).toBe(404); accessTenant = tenantId;
    expect((await send(body, "PUT", path.replace(projectId, crypto.randomUUID()))).status).toBe(404);
    for (const invalid of [foreign, otherProject, pending, notPdf])
      expect((await send({ ...body, pdfVersionId: invalid.versionId })).status).toBe(404);
    expect((await send({ ...body, pdfVersionId: original.versionId })).status).toBe(400);
    expect((await send(body, "PUT", path.replace(original.versionId, pdf.versionId))).status).toBe(400);
    failAudit = true; expect((await send(body)).status).toBe(500); failAudit = false;
    expect((await getOriginal()).pdfRepresentation).toBeNull();
    const versionsBefore = await db.select().from(fileVersions);
    expect((await Promise.all([send(body), send(body)])).map(r => r.status).sort()).toEqual([200, 409]);
    expect((await getOriginal()).pdfRepresentation).toMatchObject({ originalVersionId: original.versionId, pdf: { versionId: pdf.versionId, version: 1 }, confirmedBy: actorId });
    expect(audits).toEqual(["projects.source.pdf_representation.confirmed"]);
    expect(await db.select().from(fileVersions)).toEqual(versionsBefore);
    const resolved: any = await host.resolveSource(projectId, { versionId: original.versionId });
    expect(resolved.content).toEqual(originalBefore.content); // No silent substitution of PDF evidence.
    expect(resolved.source.versionId).toBe(original.versionId);
    const evidence: any = await host.resolveSource(projectId, { versionId: resolved.source.pdfRepresentation.pdf.versionId, pageStart: 8, pageEnd: 8 });
    expect(evidence.source.versionId).toBe(pdf.versionId);
    expect(evidence.content.text).toContain("Acoustic target AL24 thickness 240 mm");
    expect(evidence.authority).toBe("unreviewed_source");
    const newPdfId = crypto.randomUUID(), newOriginalId = crypto.randomUUID();
    await db.insert(fileVersions).values({ id: newPdfId, fileId: pdf.fileId, tenantId, version: 2, status: "ready", mimeType: "application/pdf", createdBy: actorId });
    const inventory = await host.listProjectSources(projectId);
    expect(inventory.sources.map(s => s.versionId)).toContain(pdf.versionId); // Historical export remains discoverable.
    expect(inventory.sources.map(s => s.versionId)).toContain(newPdfId);
    expect((await getOriginal()).pdfRepresentation.pdf.versionId).toBe(pdf.versionId);
    await db.insert(fileVersions).values({ id: newOriginalId, fileId: original.fileId, tenantId, version: 2, status: "ready", mimeType: "application/octet-stream", createdBy: actorId });
    const latest = (await (await fetch(`${base}/files`)).json()).data.find((f: any) => f.id === original.fileId);
    expect(latest).toMatchObject({ versionId: newOriginalId, pdfRepresentation: null });
    const versions = (await (await fetch(`${base}/files/${original.fileId}/versions`)).json()).data;
    expect(versions.find((v: any) => v.id === original.versionId).pdfRepresentation.pdf.versionId).toBe(pdf.versionId);
    expect((await send({ ...body, pdfVersionId: replacement.versionId })).status).toBe(409);
    expect((await send({ ...body, pdfVersionId: replacement.versionId, expectedPdfVersionId: pdf.versionId })).status).toBe(200);
    expect((await send({ expectedPdfVersionId: pdf.versionId }, "DELETE")).status).toBe(409);
    failAudit = true; expect((await send({ expectedPdfVersionId: replacement.versionId }, "DELETE")).status).toBe(500); failAudit = false;
    expect((await getOriginal()).pdfRepresentation.pdf.versionId).toBe(replacement.versionId);
    expect((await send({ expectedPdfVersionId: replacement.versionId }, "DELETE")).status).toBe(200);
    expect((await getOriginal()).pdfRepresentation).toBeNull();
    expect(audits).toEqual(["projects.source.pdf_representation.confirmed", "projects.source.pdf_representation.confirmed", "projects.source.pdf_representation.removed"]);

    // A reference/comparison file remains inspectable by a person, but cannot
    // enter agent evidence through a filename, exact ID, PDF link or visual tool.
    expect((await send(body)).status).toBe(200);
    const purposePath = `${base}/files/${pdf.fileId}/purpose`;
    const classify = (purpose: string, expectedPurpose = "project_evidence", target = purposePath) => send({ purpose, expectedPurpose }, "PATCH", target);
    const immutableVersions = await db.select().from(fileVersions);
    deniedPermission = "projects:write"; expect((await classify("reference_report")).status).toBe(403); deniedPermission = "";
    accessTenant = crypto.randomUUID(); expect((await classify("reference_report")).status).toBe(404); accessTenant = tenantId;
    expect((await classify("reference_report", "project_evidence", purposePath.replace(projectId, crypto.randomUUID()))).status).toBe(404);
    expect((await classify("unknown")).status).toBe(400);
    failAudit = true; expect((await classify("reference_report")).status).toBe(500); failAudit = false;
    expect(await host.validateSourceVersion(projectId, pdf.versionId)).toBe(true);
    let previous = "project_evidence";
    for (const purpose of ["reference_report", "comparison_only"]) {
      expect((await classify(purpose, previous)).status).toBe(200);
      expect((await classify(purpose, previous)).status).toBe(409);
      const human = (await (await fetch(`${base}/source-versions/${pdf.versionId}`)).json()).data;
      expect(human).toMatchObject({ purpose, versionId: pdf.versionId });
      expect(human.downloadUrl).toContain(pdf.fileId);
      expect((await getOriginal()).pdfRepresentation.pdf.versionId).toBe(pdf.versionId);
      const evidenceInventory = await host.listProjectSources(projectId);
      expect(evidenceInventory.sources.map(s => s.versionId)).not.toContain(pdf.versionId);
      expect(evidenceInventory.sources.map(s => s.versionId)).not.toContain(newPdfId);
      expect(await host.validateSourceVersion(projectId, pdf.versionId)).toBe(false);
      expect(await host.validateSourceVersion(projectId, newPdfId)).toBe(false);
      for (const input of [{ versionId: pdf.versionId }, { fileId: pdf.fileId }, { query: "matching-export" }])
        expect((await host.resolveSource(projectId, input) as any).status).toBe("missing_input");
      expect((await host.resolveSource(projectId, { versionId: original.versionId }) as any).source.pdfRepresentation).toBeNull();
      expect(await host.readSourcePdf!(projectId, pdf.versionId)).toBeNull();
      await expect(host.inspectSource!(projectId, { versionId: pdf.versionId, page: 1 }, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
      const visualHost = knowledgeDeps(db, { actor: { id: actorId, tenantId, permissions: new Set(["projects:read", "knowledge:read", "agent:run"]) } } as any);
      await expect(visualHost.inspectSource!(projectId, { versionId: pdf.versionId, page: 1 }, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
      expect(await host.sourceReferences(projectId, [pdf.versionId])).toMatchObject([{ versionId: pdf.versionId }]);
      previous = purpose;
    }
    expect(await db.select().from(fileVersions)).toEqual(immutableVersions);
    expect(audits.filter(action => action === "projects.file.purpose.updated")).toHaveLength(2);
  } finally {
    server?.closeAllConnections(); server?.close();
    await pool.end(); await admin.pool.query(`drop schema ${namespace} cascade`); await admin.pool.end();
  }
}, 30000);
