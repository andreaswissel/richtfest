import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import PostalMime from "postal-mime";
import { ok } from "@richtfest/shared";
import type { AppDeps, InboundEmailDeps } from "./deps";
import { statusAfter } from "./inquiry-status";
import { registerStoredFile, storeProjectFileBytes } from "./project-files";
import { files, inboundEmails, inboundMailboxes, inquiries, inquiryEntries, projects } from "./schema";

/**
 * Forwarding addresses. Each project has one address, <token>@<domain>; each
 * inquiry is reached at <token>+<first 8 characters of its id>@<domain>. Mail to
 * an inquiry's address is filed there; mail to the project address waits in
 * the project's inbox for a person. The original email and its attachments
 * become project sources either way.
 */
const tokenAlphabet = "abcdefghijklmnopqrstuvwxyz234567";
export const newMailboxToken = () => [...randomBytes(10)].map(byte => tokenAlphabet[byte % 32]).join("");
export const inquiryRef = (inquiryId: string) => inquiryId.replaceAll("-", "").slice(0, 8);
export const mailboxAddress = (token: string, domain: string, inquiryId?: string) => `${token}${inquiryId ? `+${inquiryRef(inquiryId)}` : ""}@${domain}`;

const addressPattern = /[^\s<>"',;]+@[^\s<>"',;]+/g;
/** The mailbox token and optional inquiry reference of the first recipient at the inbound domain. */
export function parseForwardingAddress(recipients: string[], domain: string) {
  for (const address of recipients.flatMap(value => value.match(addressPattern) ?? [])) {
    const [local, host] = address.toLowerCase().split("@");
    if (host !== domain.toLowerCase()) continue;
    const match = local.match(/^([a-z2-7]{10})(?:\+([0-9a-f]{8}))?$/);
    if (match) return { address: address.toLowerCase(), token: match[1], inquiryRef: match[2] ?? null };
  }
  return null;
}

const htmlToText = (html: string) => html.replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/\n{3,}/g, "\n\n").trim();
const safeName = (value: string) => value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);

export type ReceivedEmail = { provider: string; providerEmailId: string; recipients: string[]; raw: Uint8Array; receivedAt?: string | null };
export type ReceiveResult = { status: "filed" | "unfiled" | "duplicate" | "unknown_address"; inboundEmailId?: string; inquiryId?: string | null };

const isUniqueViolation = (error: unknown) => (error as { code?: string; cause?: { code?: string } })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505";

/** Files one received email. Idempotent per provider message, so webhook retries are harmless. */
export async function receiveInboundEmail(deps: InboundEmailDeps, input: ReceivedEmail): Promise<ReceiveResult> {
  const target = parseForwardingAddress(input.recipients, deps.domain);
  if (!target) return { status: "unknown_address" };
  const [mailbox] = await deps.db.select().from(inboundMailboxes).where(eq(inboundMailboxes.token, target.token)).limit(1);
  if (!mailbox) return { status: "unknown_address" };
  const known = async () => (await deps.db.select({ id: inboundEmails.id }).from(inboundEmails)
    .where(and(eq(inboundEmails.provider, input.provider), eq(inboundEmails.providerEmailId, input.providerEmailId))).limit(1))[0];
  const prior = await known();
  if (prior) return { status: "duplicate", inboundEmailId: prior.id };

  const email = await PostalMime.parse(input.raw);
  const from = email.from && "address" in email.from ? email.from : null;
  const members = new Set((await deps.memberEmails(mailbox.tenantId)).map(value => value.toLowerCase()));
  const direction = from?.address && members.has(from.address.toLowerCase()) ? "outgoing" as const : "incoming" as const;
  const sent = email.date ? new Date(email.date) : null;
  const receivedAt = sent && !Number.isNaN(sent.getTime()) ? sent : input.receivedAt ? new Date(input.receivedAt) : new Date();
  const subject = email.subject?.trim() || null;
  const body = (email.text?.trim() || (email.html ? htmlToText(email.html) : "")).replace(/\r\n/g, "\n") || null;
  const [inquiry] = target.inquiryRef ? await deps.db.select().from(inquiries).where(and(eq(inquiries.tenantId, mailbox.tenantId), eq(inquiries.projectId, mailbox.projectId),
    like(sql`replace(${inquiries.id}::text, '-', '')`, `${target.inquiryRef}%`))).limit(1) : [];

  // System context: rows are attributed to the person who set up the address; audit records the system actor.
  const d = { tenantId: mailbox.tenantId, actorId: mailbox.createdBy, fileStorage: deps.fileStorage,
    audit: (tx: any, action: string, entityType: string, entityId: string, metadata?: unknown) => deps.audit(tx, mailbox.tenantId, action, entityType, entityId, metadata) };
  const day = receivedAt.toISOString().slice(0, 10);
  const stored = [await storeProjectFileBytes(d, mailbox.projectId, { name: `E-Mail ${day} ${safeName(subject ?? from?.address ?? "")}`.trim() + ".eml", mimeType: "message/rfc822", bytes: input.raw })];
  for (const attachment of email.attachments.filter(item => item.filename && !item.related && item.disposition !== "inline")) {
    const content = attachment.content;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content instanceof ArrayBuffer ? new Uint8Array(content) : content;
    stored.push(await storeProjectFileBytes(d, mailbox.projectId, { name: safeName(attachment.filename!) || "Anhang", mimeType: attachment.mimeType || "application/octet-stream", bytes }));
  }
  try {
    return await deps.db.transaction(async (tx: any) => {
      const source = { sourceType: "email", sourceRef: target.address, sourceMetadata: { email: { from: from?.address ?? null, subject, messageId: email.messageId ?? null, receivedAt: receivedAt.toISOString() } } };
      const registered = [];
      for (const item of stored) registered.push(await registerStoredFile(tx, d, mailbox.projectId, item, source));
      const [emailFile, ...attachmentFiles] = registered;
      const [row] = await tx.insert(inboundEmails).values({ tenantId: mailbox.tenantId, projectId: mailbox.projectId, provider: input.provider, providerEmailId: input.providerEmailId,
        messageId: email.messageId ?? null, recipient: target.address, fromAddress: from?.address ?? null, fromName: from?.name || null, direction, subject, body, receivedAt,
        fileId: emailFile.fileId, attachmentFileIds: attachmentFiles.map(file => file.fileId), status: inquiry ? "filed" : "unfiled", inquiryId: inquiry?.id ?? null,
        handledAt: inquiry ? new Date() : null }).returning();
      if (inquiry) await fileIntoInquiry(tx, d, { inquiry, email: row, linkedFileId: (attachmentFiles.find(file => /\.pdf$/i.test(file.name) || file.mimeType === "application/pdf") ?? emailFile).fileId });
      await d.audit(tx, "projects.inquiry.email_received", "project_inbound_email", row.id, { projectId: mailbox.projectId, inquiryId: inquiry?.id ?? null, direction,
        attachments: attachmentFiles.length, filed: Boolean(inquiry) });
      return { status: inquiry ? "filed" : "unfiled", inboundEmailId: row.id, inquiryId: inquiry?.id ?? null } as ReceiveResult;
    });
  } catch (error) {
    await Promise.all(stored.map(item => deps.fileStorage.remove(item.file.storageKey).catch(() => {})));
    if (isUniqueViolation(error)) { const again = await known(); if (again) return { status: "duplicate", inboundEmailId: again.id }; }
    throw error;
  }
}

/** Adds a received email to an inquiry's timeline and moves its status on. */
async function fileIntoInquiry(tx: any, d: { tenantId: string; actorId: string }, input: { inquiry: any; email: any; linkedFileId: string | null }) {
  const [entry] = await tx.insert(inquiryEntries).values({ tenantId: d.tenantId, inquiryId: input.inquiry.id, kind: "email", direction: input.email.direction, subject: input.email.subject,
    body: input.email.body, fileId: input.linkedFileId, inboundEmailId: input.email.id, occurredAt: input.email.receivedAt, createdBy: d.actorId }).returning();
  await tx.update(inquiries).set({ status: statusAfter(input.inquiry.status, input.email.direction), updatedAt: new Date() }).where(eq(inquiries.id, input.inquiry.id));
  return entry;
}

/** The inquiry's reply address, when inbound email is configured and the project has a forwarding address. */
export async function inquiryReplyAddress(d: AppDeps, projectId: string, inquiryId: string) {
  if (!d.inboundEmailDomain) return null;
  const [mailbox] = await d.db.select({ token: inboundMailboxes.token }).from(inboundMailboxes).where(and(eq(inboundMailboxes.projectId, projectId), eq(inboundMailboxes.tenantId, d.tenantId))).limit(1);
  return mailbox ? mailboxAddress(mailbox.token, d.inboundEmailDomain, inquiryId) : null;
}

const uuid = z.string().uuid();
const send = (res: any, status: number, body: any) => res.status(status).json(body);

/** Emails at the project address that no inquiry claimed yet, newest first. */
async function unfiledEmails(d: AppDeps, projectId: string) {
  const rows = await d.db.select().from(inboundEmails).where(and(eq(inboundEmails.projectId, projectId), eq(inboundEmails.tenantId, d.tenantId), eq(inboundEmails.status, "unfiled")))
    .orderBy(desc(inboundEmails.receivedAt)).limit(100);
  const fileIds = (rows as any[]).flatMap(row => [row.fileId, ...row.attachmentFileIds]).filter(Boolean);
  const names = new Map(fileIds.length ? (await d.db.select({ id: files.id, name: files.name }).from(files).where(and(inArray(files.id, fileIds), eq(files.tenantId, d.tenantId)))).map((row: any) => [row.id, row.name]) : []);
  return (rows as any[]).map(row => ({ id: row.id, fromAddress: row.fromAddress, fromName: row.fromName, direction: row.direction, subject: row.subject, body: row.body,
    receivedAt: row.receivedAt, fileId: row.fileId, attachments: row.attachmentFileIds.map((fileId: string) => ({ fileId, name: names.get(fileId) ?? null })) }));
}

export function createInboundEmailRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  const mailboxFor = async (d: AppDeps, projectId: string, tx = d.db) =>
    (await tx.select().from(inboundMailboxes).where(and(eq(inboundMailboxes.projectId, projectId), eq(inboundMailboxes.tenantId, d.tenantId))).limit(1))[0];

  // The address and the emails waiting in the project's inbox, in one request for the Inquiries view.
  router.get("/projects/:projectId/inbound-mailbox", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:read"); const projectId = uuid.parse(req.params.projectId);
      const mailbox = d.inboundEmailDomain ? await mailboxFor(d, projectId) : null;
      return res.json(ok({ configured: Boolean(d.inboundEmailDomain), address: mailbox ? mailboxAddress(mailbox.token, d.inboundEmailDomain!) : null, unfiled: mailbox ? await unfiledEmails(d, projectId) : [] }));
    } catch (e) { return next(e); }
  });

  // Creates the project's forwarding address once; it stays stable so it can be saved in address books.
  router.post("/projects/:projectId/inbound-mailbox", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write"); const projectId = uuid.parse(req.params.projectId);
      if (!d.inboundEmailDomain) return send(res, 409, { data: null, error: { code: "inbound_email_unconfigured" }, message: "Inbound email is not configured for this workspace" });
      const [project] = await d.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).limit(1);
      if (!project) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Project not found" });
      const mailbox = await d.db.transaction(async (tx: any) => {
        const existing = await mailboxFor(d, projectId, tx);
        if (existing) return existing;
        const [row] = await tx.insert(inboundMailboxes).values({ tenantId: d.tenantId, projectId, token: newMailboxToken(), createdBy: d.actorId }).onConflictDoNothing().returning();
        if (row) await d.audit(tx, "projects.inbound_mailbox.created", "project", projectId, {});
        return row ?? await mailboxFor(d, projectId, tx);
      });
      return send(res, 201, ok({ configured: true, address: mailboxAddress(mailbox.token, d.inboundEmailDomain) }));
    } catch (e) { return next(e); }
  });

  router.post("/projects/:projectId/inbound-emails/:emailId/file", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = uuid.parse(req.params.projectId), emailId = uuid.parse(req.params.emailId);
      const input = z.object({ inquiryId: uuid }).strict().parse(req.body);
      const result = await d.db.transaction(async (tx: any) => {
        const [email] = await tx.select().from(inboundEmails).where(and(eq(inboundEmails.id, emailId), eq(inboundEmails.projectId, projectId), eq(inboundEmails.tenantId, d.tenantId), eq(inboundEmails.status, "unfiled"))).for("update");
        const [inquiry] = await tx.select().from(inquiries).where(and(eq(inquiries.id, input.inquiryId), eq(inquiries.projectId, projectId), eq(inquiries.tenantId, d.tenantId))).limit(1);
        if (!email || !inquiry) return null;
        const pdf = email.attachmentFileIds.length ? (await tx.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, email.attachmentFileIds))).find((file: any) => /\.pdf$/i.test(file.name)) : null;
        const entry = await fileIntoInquiry(tx, d, { inquiry, email, linkedFileId: pdf?.id ?? email.fileId });
        await tx.update(inboundEmails).set({ status: "filed", inquiryId: inquiry.id, handledBy: d.actorId, handledAt: new Date() }).where(eq(inboundEmails.id, emailId));
        await d.audit(tx, "projects.inquiry.email_filed", "project_inbound_email", emailId, { projectId, inquiryId: inquiry.id, entryId: entry.id });
        return { entryId: entry.id, inquiryId: inquiry.id };
      });
      if (!result) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Unfiled email or inquiry not found" });
      return res.json(ok(result));
    } catch (e) { return next(e); }
  });

  // Dismissing keeps the email and its attachments in Sources; only the inbox item goes away.
  router.post("/projects/:projectId/inbound-emails/:emailId/dismiss", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = uuid.parse(req.params.projectId), emailId = uuid.parse(req.params.emailId);
      const done = await d.db.transaction(async (tx: any) => {
        const [row] = await tx.update(inboundEmails).set({ status: "dismissed", handledBy: d.actorId, handledAt: new Date() })
          .where(and(eq(inboundEmails.id, emailId), eq(inboundEmails.projectId, projectId), eq(inboundEmails.tenantId, d.tenantId), eq(inboundEmails.status, "unfiled"))).returning();
        if (row) await d.audit(tx, "projects.inquiry.email_dismissed", "project_inbound_email", emailId, { projectId });
        return row;
      });
      if (!done) return send(res, 404, { data: null, error: { code: "not_found" }, message: "Unfiled email not found" });
      return res.json(ok({ id: emailId, status: "dismissed" }));
    } catch (e) { return next(e); }
  });
  return router;
}
