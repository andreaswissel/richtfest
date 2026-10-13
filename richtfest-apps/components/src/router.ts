import { Router, type Request } from "express";
import { and, eq, desc, asc, sql, inArray } from "drizzle-orm";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ok, fail, componentImportInput, componentReviewInput, componentCategory, componentReviewStatus } from "@richtfest/shared";
import { components, revisions, documents } from "./schema";
import { currentRows, record, textFilter } from "./queries";
import { starter } from "./starter";
import type { AppDeps } from "./deps";

class Conflict extends Error {}
const documentRecord = (row: any) => ({ id: row.id, sha256: row.sha256, pages: row.pages, sizeBytes: Number(row.sizeBytes), createdAt: row.createdAt.toISOString() });
// Sort object keys recursively; source/fact array order remains meaningful.
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function importRecords(d: AppDeps, input: z.infer<typeof componentImportInput>, missingOnly = false) {
  return d.db.transaction(async (tx: any) => {
    const items = [];
    for (const entry of [...input.records].sort((a, b) => a.data.key.localeCompare(b.data.key, "en"))) {
      // Transaction-scoped key lock also protects a key that does not exist yet.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${d.tenantId + ":" + entry.data.key}, 0))`);
      let [identity] = await tx.select().from(components).where(and(eq(components.tenantId, d.tenantId), eq(components.key, entry.data.key))).for("update");
      const [current] = identity ? await tx.select().from(revisions).where(and(eq(revisions.tenantId, d.tenantId), eq(revisions.id, identity.currentRevisionId))) : [];
      if (missingOnly && identity) continue;
      const fingerprint = createHash("sha256").update(canonical(entry.data)).digest("hex");
      if (current?.fingerprint === fingerprint) { items.push(record(current)); continue; }
      if ((current?.id ?? null) !== entry.expectedRevisionId) throw new Conflict("Component revision changed; reload before importing");
      if (!identity) [identity] = await tx.insert(components).values({ tenantId: d.tenantId, key: entry.data.key, createdBy: d.actorId }).returning();
      const [revision] = await tx.insert(revisions).values({ tenantId: d.tenantId, componentId: identity.id, revision: (current?.revision ?? 0) + 1,
        data: entry.data, fingerprint, createdBy: d.actorId }).returning();
      await tx.update(components).set({ currentRevisionId: revision.id }).where(and(eq(components.tenantId, d.tenantId), eq(components.id, identity.id)));
      await d.audit(tx, "components.imported", "component", identity.id, { revisionId: revision.id, revision: revision.revision, key: entry.data.key });
      items.push(record(revision));
    }
    return { items };
  });
}
export function createRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  const handle = (fn: (req: Request, res: any, d: AppDeps) => Promise<any>) => async (req: Request, res: any, next: any) => {
    try { const d = getDeps(req); d.requirePermission("components:read"); await fn(req, res, d); }
    catch (e) { if (e instanceof Conflict) return res.status(409).json(fail("conflict", e.message)); return next(e); }
  };
  router.get("/starter", handle(async (_req, res) => res.json(ok(starter))));
  router.post("/import", handle(async (req, res, d) => { d.requirePermission("components:import"); res.json(ok(await importRecords(d, componentImportInput.parse(req.body)))); }));
  router.post("/import-starter", handle(async (_req, res, d) => { d.requirePermission("components:import"); res.json(ok(await importRecords(d, starter, true))); }));
  const pdfPath = "/:id/revisions/:revisionId/sources/:sourceId/pdf";
  const sourceFor = async (req: Request, d: AppDeps) => {
    const id = z.string().uuid().parse(req.params.id), revisionId = z.string().uuid().parse(req.params.revisionId);
    const [identity] = await d.db.select().from(components).where(and(eq(components.tenantId, d.tenantId), eq(components.id, id)));
    const [revision] = identity ? await d.db.select().from(revisions).where(and(eq(revisions.tenantId, d.tenantId), eq(revisions.componentId, id), eq(revisions.id, revisionId))) : [];
    const source = revision?.data.sources.find((s: any) => s.id === req.params.sourceId);
    return source ? { identity, revision, source } : null;
  };
  router.put(pdfPath, handle(async (req, res, d) => {
    d.requirePermission("components:import");
    const match = await sourceFor(req, d);
    if (!match) return res.status(404).json(fail("not_found", "Component source not found"));
    if (match.identity.currentRevisionId !== match.revision.id) throw new Conflict("PDF upload requires the current revision");
    if (!match.source.sha256 || !match.source.pages) return res.status(400).json(fail("invalid_source", "Source requires a checksum and PDF page count"));
    if (!req.is("application/pdf")) return res.status(415).json(fail("invalid_pdf", "Upload application/pdf bytes"));
    const stored = await d.storePdf(req, match.identity.id, match.source.sha256, match.source.pages);
    let published = false;
    try {
      const result = await d.db.transaction(async (tx: any) => {
        const [identity] = await tx.select().from(components).where(and(eq(components.tenantId, d.tenantId), eq(components.id, match.identity.id))).for("update");
        if (identity?.currentRevisionId !== match.revision.id) throw new Conflict("Component revision changed during PDF upload");
        const [existing] = await tx.select().from(documents).where(and(eq(documents.tenantId, d.tenantId), eq(documents.componentId, identity.id), eq(documents.sha256, match.source.sha256)));
        if (existing) {
          if (existing.pages !== match.source.pages) throw new Conflict("Archived PDF page count does not match the source");
          return existing;
        }
        const [document] = await tx.insert(documents).values({ tenantId: d.tenantId, componentId: identity.id, sha256: match.source.sha256, pages: match.source.pages, sizeBytes: String(stored.sizeBytes), storageKey: stored.storageKey }).returning();
        await d.audit(tx, "components.pdf_uploaded", "component", identity.id, { documentId: document.id, revisionId: match.revision.id, sourceId: match.source.id, sha256: document.sha256, sizeBytes: stored.sizeBytes });
        return document;
      });
      published = result.storageKey === stored.storageKey;
      res.json(ok(documentRecord(result)));
    } finally { if (!published) await d.removePdf(stored.storageKey); }
  }));
  router.get(pdfPath, handle(async (req, res, d) => {
    const match = await sourceFor(req, d);
    if (!match?.source.sha256 || !match.source.pages) return res.status(404).json(fail("not_found", "Preserved PDF not found"));
    const [document] = await d.db.select().from(documents).where(and(eq(documents.tenantId, d.tenantId), eq(documents.componentId, match.identity.id), eq(documents.sha256, match.source.sha256), eq(documents.pages, match.source.pages)));
    const stream = document ? await d.readPdf(document.storageKey) : null;
    if (!stream) return res.status(404).json(fail("not_found", "Preserved PDF not found"));
    res.set({ "Content-Type": "application/pdf", "Content-Length": String(document.sizeBytes), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": 'inline; filename="source.pdf"' });
    await pipeline(Readable.from(stream), res);
  }));
  router.get("/", handle(async (req, res, d) => {
    const q = z.object({ q: z.string().trim().max(200).optional(), category: componentCategory.or(z.literal("")).optional(), reviewStatus: componentReviewStatus.or(z.literal("")).optional(),
      offset: z.coerce.number().int().min(0).max(1000000).default(0), limit: z.coerce.number().int().min(1).max(50).default(30) }).parse(req.query);
    const rows = await currentRows(d).where(and(eq(components.tenantId, d.tenantId), q.q ? textFilter(q.q) : undefined,
      q.category ? sql`${revisions.data}->>'category' = ${q.category}` : undefined, q.reviewStatus ? eq(revisions.reviewStatus, q.reviewStatus) : undefined))
      .orderBy(asc(components.key)).offset(q.offset).limit(q.limit + 1);
    res.json(ok({ items: rows.slice(0, q.limit).map((r: any) => record(r.row)), nextOffset: rows.length > q.limit ? q.offset + q.limit : null, canImport: d.canImport, canReview: d.canReview }));
  }));
  router.get("/:id", handle(async (req, res, d) => {
    const id = z.string().uuid().parse(req.params.id);
    const [current] = await currentRows(d).where(and(eq(components.tenantId, d.tenantId), eq(components.id, id)));
    if (!current) return res.status(404).json(fail("not_found", "Component not found"));
    const history = await d.db.select().from(revisions).where(and(eq(revisions.tenantId, d.tenantId), eq(revisions.componentId, id))).orderBy(desc(revisions.revision)).limit(50);
    const hashes = [...new Set<string>([current.row, ...history].flatMap((r: any) => r.data.sources.map((s: any) => s.sha256).filter(Boolean)))];
    const archived = hashes.length ? await d.db.select().from(documents).where(and(eq(documents.tenantId, d.tenantId), eq(documents.componentId, id), inArray(documents.sha256, hashes))) : [];
    res.json(ok({ component: record(current.row), history: history.map(record), documents: archived.map(documentRecord), canImport: d.canImport, canReview: d.canReview }));
  }));
  router.post("/:id/review", handle(async (req, res, d) => {
    d.requirePermission("components:review"); const id = z.string().uuid().parse(req.params.id); const input = componentReviewInput.parse(req.body);
    const result = await d.db.transaction(async (tx: any) => {
      const [identity] = await tx.select().from(components).where(and(eq(components.tenantId, d.tenantId), eq(components.id, id))).for("update");
      if (!identity) return null;
      const [current] = await tx.select().from(revisions).where(and(eq(revisions.tenantId, d.tenantId), eq(revisions.id, identity.currentRevisionId)));
      if (!current || current.id !== input.expectedRevisionId || current.reviewVersion !== input.expectedReviewVersion) throw new Conflict("Component review changed; reload before reviewing");
      const [updated] = await tx.update(revisions).set({ reviewStatus: input.status, reviewVersion: current.reviewVersion + 1, reviewNote: input.note, reviewedAt: new Date(), reviewedBy: d.actorId })
        .where(and(eq(revisions.tenantId, d.tenantId), eq(revisions.id, current.id))).returning();
      await d.audit(tx, "components.reviewed", "component", id, { revisionId: current.id, status: input.status,
        previousStatus: current.reviewStatus, note: input.note, reviewVersion: updated.reviewVersion });
      return record(updated);
    });
    if (!result) return res.status(404).json(fail("not_found", "Component not found"));
    res.json(ok(result));
  }));
  return router;
}
