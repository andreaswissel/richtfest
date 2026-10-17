import { Router, type Request } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { componentDataRequest, dataRequestProgress, ok, type ComponentRequestGroup } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { files, fileVersions, inquiries, inquiryEntries, projects, sourcePages } from "./schema";
import { modelForProject, proposeStatedComponentData, readComponentRecords } from "./building-model-router";

/**
 * Inquiries are tickets to a stakeholder (usually the architect). Each bundles
 * the request as sent and every email, call note and document exchanged about
 * it. Component data inquiries measure their progress against the current
 * building model, so an answer entered anywhere counts.
 */
const send = (res: any, status: number, body: any) => res.status(status).json(body);
const uuid = z.string().uuid();
const notFound = (res: any) => send(res, 404, { data: null, error: { code: "not_found" }, message: "Inquiry not found" });

const entryInput = z.object({
  kind: z.enum(["email", "call", "note", "document"]),
  direction: z.enum(["outgoing", "incoming", "internal"]),
  subject: z.string().trim().max(500).nullable().optional(),
  body: z.string().max(100_000).nullable().optional(),
  fileId: uuid.nullable().optional(),
  occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine(input => Boolean(input.body?.trim() || input.fileId), { message: "An entry needs text or a file" });

/** Sending moves the ticket to waiting; anything received makes it answered. Closed tickets stay closed until reopened. */
const statusAfter = (current: string, direction: string) => current === "closed" || direction === "internal" ? current : direction === "outgoing" ? "waiting" : "answered";

/**
 * Text a reply states itself: quoted earlier messages ("> …", "Am … schrieb",
 * "-----Original Message-----") are dropped, so values Richtfest asked about
 * are never read back as answers.
 */
export function replyText(body: string) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const cut = lines.findIndex((raw, index) => {
    const line = raw.trim();
    return /^-{2,}\s*(?:original|ursprüngliche)\s*(?:message|nachricht)/i.test(line) || /^(?:am|on)\s.+(?:schrieb|wrote)\s*.*:$/i.test(line)
      // An Outlook header block after the reply ("Von: …") starts the quoted message.
      || /^(?:von|from)\s*:\s/i.test(line) && lines.slice(0, index).some(prior => prior.trim());
  });
  return (cut >= 0 ? lines.slice(0, cut) : lines).filter(line => !line.trimStart().startsWith(">")).join("\n").trim();
}

const inquiryFor = async (d: AppDeps, projectId: string, inquiryId: string, tx = d.db) =>
  (await tx.select().from(inquiries).where(and(eq(inquiries.id, inquiryId), eq(inquiries.projectId, projectId), eq(inquiries.tenantId, d.tenantId))).limit(1))[0];

const fileInProject = async (d: AppDeps, projectId: string, fileId: string) =>
  (await d.db.select({ id: files.id }).from(files).where(and(eq(files.id, fileId), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId))).limit(1))[0];

export function createInquiriesRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();

  router.get("/projects/:projectId/inquiries", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); const projectId = uuid.parse(req.params.projectId);
      const rows = await d.db.select({ inquiry: inquiries, entries: sql<number>`(select count(*)::int from ${inquiryEntries} where ${inquiryEntries.inquiryId} = ${inquiries.id})` })
        .from(inquiries).where(and(eq(inquiries.projectId, projectId), eq(inquiries.tenantId, d.tenantId))).orderBy(desc(inquiries.updatedAt));
      const records = rows.some((row: any) => row.inquiry.kind === "component_data") ? await readComponentRecords(d, projectId) : [];
      return res.json(ok(rows.map((row: any) => ({ ...row.inquiry, entryCount: row.entries,
        progress: row.inquiry.kind === "component_data" ? dataRequestProgress(row.inquiry.items, records) : null }))));
    } catch (e) { return next(e); }
  });

  router.get("/projects/:projectId/inquiries/:inquiryId", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read");
      const projectId = uuid.parse(req.params.projectId), inquiryId = uuid.parse(req.params.inquiryId);
      const inquiry = await inquiryFor(d, projectId, inquiryId);
      if (!inquiry) return notFound(res);
      const entries = await d.db.select({ entry: inquiryEntries, fileName: files.name }).from(inquiryEntries).leftJoin(files, eq(files.id, inquiryEntries.fileId))
        .where(and(eq(inquiryEntries.inquiryId, inquiryId), eq(inquiryEntries.tenantId, d.tenantId))).orderBy(asc(inquiryEntries.occurredAt), asc(inquiryEntries.createdAt));
      const progress = inquiry.kind === "component_data" ? dataRequestProgress(inquiry.items as ComponentRequestGroup[], await readComponentRecords(d, projectId)) : null;
      return res.json(ok({ ...inquiry, progress, entries: entries.map((row: any) => ({ ...row.entry, fileName: row.fileName ?? null })) }));
    } catch (e) { return next(e); }
  });

  // A component data inquiry snapshots what is missing or unconfirmed now; the request text is what was sent.
  router.post("/projects/:projectId/inquiries", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(req.params.projectId);
      const input = z.object({
        kind: z.enum(["component_data", "general"]),
        title: z.string().trim().min(1).max(300),
        counterpart: z.string().trim().min(1).max(200),
        request: z.object({ subject: z.string().trim().max(500).nullable().optional(), body: z.string().max(100_000) }).strict().nullable().optional(),
      }).strict().parse(req.body);
      let items: ComponentRequestGroup[] = [];
      if (input.kind === "component_data") {
        if (!(await modelForProject(d, projectId))) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
        items = componentDataRequest(await readComponentRecords(d, projectId));
        if (!items.length) return send(res, 422, { data: null, error: { code: "nothing_to_request" }, message: "Every wall and ceiling already has its inputs" });
      } else if (!(await d.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).limit(1))[0]) {
        return send(res, 404, { data: null, error: { code: "not_found" }, message: "Project not found" });
      }
      const created = await d.db.transaction(async (tx: any) => {
        const [row] = await tx.insert(inquiries).values({ tenantId: d.tenantId, projectId, kind: input.kind, title: input.title, counterpart: input.counterpart,
          status: input.request ? "waiting" : "open", items, createdBy: d.actorId }).returning();
        if (input.request) await tx.insert(inquiryEntries).values({ tenantId: d.tenantId, inquiryId: row.id, kind: "request", direction: "outgoing",
          subject: input.request.subject ?? null, body: input.request.body, createdBy: d.actorId });
        await d.audit(tx, "projects.inquiry.created", "project_inquiry", row.id, { projectId, kind: input.kind, counterpart: input.counterpart,
          groups: items.length, fields: items.reduce((sum, group) => sum + group.fields.length, 0), requestSent: Boolean(input.request) });
        return row;
      });
      return send(res, 201, ok(created));
    } catch (e) { return next(e); }
  });

  router.patch("/projects/:projectId/inquiries/:inquiryId", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = uuid.parse(req.params.projectId), inquiryId = uuid.parse(req.params.inquiryId);
      const input = z.object({ status: z.enum(["open", "waiting", "answered", "closed"]).optional(), title: z.string().trim().min(1).max(300).optional(),
        counterpart: z.string().trim().min(1).max(200).optional() }).strict().parse(req.body);
      const updated = await d.db.transaction(async (tx: any) => {
        const [row] = await tx.update(inquiries).set({ ...input, updatedAt: new Date(), ...(input.status ? { closedAt: input.status === "closed" ? new Date() : null } : {}) })
          .where(and(eq(inquiries.id, inquiryId), eq(inquiries.projectId, projectId), eq(inquiries.tenantId, d.tenantId))).returning();
        if (row) await d.audit(tx, "projects.inquiry.updated", "project_inquiry", inquiryId, { projectId, fields: Object.keys(input), status: input.status });
        return row;
      });
      if (!updated) return notFound(res);
      return res.json(ok(updated));
    } catch (e) { return next(e); }
  });

  // Emails, call notes, documents and internal notes; each one keeps the ticket's status current.
  router.post("/projects/:projectId/inquiries/:inquiryId/entries", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = uuid.parse(req.params.projectId), inquiryId = uuid.parse(req.params.inquiryId);
      const input = entryInput.parse(req.body);
      if (input.kind === "note" && input.direction !== "internal") return send(res, 400, { data: null, error: { code: "invalid_direction" }, message: "Notes are internal" });
      if (input.fileId && !(await fileInProject(d, projectId, input.fileId))) return send(res, 422, { data: null, error: { code: "invalid_file" }, message: "The file is not part of this project" });
      const created = await d.db.transaction(async (tx: any) => {
        const inquiry = await inquiryFor(d, projectId, inquiryId, tx);
        if (!inquiry) return null;
        const [entry] = await tx.insert(inquiryEntries).values({ tenantId: d.tenantId, inquiryId, kind: input.kind, direction: input.direction, subject: input.subject ?? null,
          body: input.body?.trim() ? input.body : null, fileId: input.fileId ?? null, occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(), createdBy: d.actorId }).returning();
        const status = statusAfter(inquiry.status, input.direction);
        await tx.update(inquiries).set({ status, updatedAt: new Date() }).where(eq(inquiries.id, inquiryId));
        await d.audit(tx, "projects.inquiry.entry_added", "project_inquiry", inquiryId, { projectId, entryId: entry.id, kind: input.kind, direction: input.direction, fileId: input.fileId ?? null, status });
        return { entry, status };
      });
      if (!created) return notFound(res);
      return send(res, 201, ok(created));
    } catch (e) { return next(e); }
  });

  // Reads the component data an entry states (its own text and an attached document) as unreviewed proposals.
  router.post("/projects/:projectId/inquiries/:inquiryId/entries/:entryId/read-components", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = uuid.parse(req.params.projectId), inquiryId = uuid.parse(req.params.inquiryId), entryId = uuid.parse(req.params.entryId);
      const input = z.object({ baseRevision: z.number().int().nonnegative() }).strict().parse(req.body);
      const inquiry = await inquiryFor(d, projectId, inquiryId);
      const [entry] = inquiry ? await d.db.select().from(inquiryEntries).where(and(eq(inquiryEntries.id, entryId), eq(inquiryEntries.inquiryId, inquiryId), eq(inquiryEntries.tenantId, d.tenantId))).limit(1) : [];
      if (!entry) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Entry not found" });
      if (entry.direction !== "incoming") return send(res, 422, { data: null, error: { code: "not_a_reply" }, message: "Only received entries state component data" });
      const modelRow = await modelForProject(d, projectId);
      if (!modelRow) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Building model not found" });
      // Page 0 is the entry's own text; pages 1… come from the attached document's latest ready version.
      const pages: Array<{ page: number; text: string }> = [];
      if (entry.body) { const text = replyText(entry.body); if (text) pages.push({ page: 0, text }); }
      let versionId: string | null = null;
      if (entry.fileId) {
        const [version] = await d.db.select({ id: fileVersions.id }).from(fileVersions).where(and(eq(fileVersions.fileId, entry.fileId), eq(fileVersions.tenantId, d.tenantId), eq(fileVersions.status, "ready")))
          .orderBy(desc(fileVersions.version)).limit(1);
        if (version) {
          versionId = version.id;
          const rows = await d.db.select({ page: sourcePages.page, text: sql<string>`left(coalesce(${sourcePages.content}->>'text',''), 60000)` }).from(sourcePages)
            .where(and(inArray(sourcePages.versionId, [version.id]), eq(sourcePages.tenantId, d.tenantId))).orderBy(asc(sourcePages.page));
          pages.push(...rows.map((row: any) => ({ page: Number(row.page), text: String(row.text) })));
        }
      }
      if (!pages.some(page => page.text.trim())) return send(res, 422, { data: null, error: { code: "no_text" }, message: "The entry has no readable text yet" });
      const result = await proposeStatedComponentData(d, projectId, modelRow.model, input.baseRevision, pages,
        stated => stated.page === 0 || !versionId ? { kind: "correspondence", inquiryId, entryId, quote: stated.quote } : { kind: "page", sourceVersionId: versionId, page: stated.page, quote: stated.quote },
        { inquiryId, entryId, sourceVersionId: versionId }, "projects.inquiry.reply_read");
      if ((result as any).conflict !== undefined) return send(res, 409, { data: { currentRevision: (result as any).conflict }, error: { code: "revision_conflict" }, message: "The building model changed; reload before saving." });
      return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  return router;
}
