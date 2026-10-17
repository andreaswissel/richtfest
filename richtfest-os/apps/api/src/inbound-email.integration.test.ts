import { expect, test } from "bun:test";
import express from "express";
import { createInquiriesRouter } from "@richtfest/projects/inquiries";
import { createInboundEmailRouter } from "@richtfest/projects/inbound-email";
import { createInboundEmailWebhook } from "./inbound-email-webhook";
import { createDatabase } from "./db/client";

const url = process.env.BUILDING_EXTRACTION_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

const eml = (input: { from: string; to: string; subject: string; body: string; attachment?: string }) => new TextEncoder().encode(`From: ${input.from}
To: ${input.to}
Subject: ${input.subject}
Date: ${new Date(Date.now() + 60_000).toUTCString()}
Message-ID: <${crypto.randomUUID()}@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

${input.body}
${input.attachment ? `--b1
Content-Type: application/pdf; name="${input.attachment}"
Content-Disposition: attachment; filename="${input.attachment}"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
` : ""}--b1--
`);

(local ? test : test.skip)("forwarded email is filed into the inquiry its address names, or waits in the project inbox", async () => {
  const namespace = `inbound_email_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!); await admin.pool.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(isolated.href);
  const tenant = crypto.randomUUID(), project = crypto.randomUUID(), actor = crypto.randomUUID();
  const domain = "in.test.richtfest.ai";
  const audits: string[] = [], stored = new Map<string, number>();
  const fileStorage = { saveStream: async (key: string, stream: AsyncIterable<Buffer>) => { let size = 0; for await (const chunk of stream) size += chunk.length; stored.set(key, size); return { sizeBytes: size, checksum: "test", mimeType: "x" }; },
    remove: async (key: string) => { stored.delete(key); } } as any;
  const messages = new Map<string, { raw: Uint8Array; recipients: string[] }>();
  const provider = { verify: (payload: string, headers: { signature: string }) => { if (headers.signature !== "valid") throw new Error("bad"); return JSON.parse(payload); },
    fetchRaw: async (id: string) => ({ ...messages.get(id)!, receivedAt: null }) };
  const deps = () => ({ db, tenantId: tenant, actorId: actor, requirePermission() {}, audit: async (_tx: unknown, action: string) => { audits.push(action); },
    validateCustomer: async () => false, customerNames: async () => ({}), fileStorage, inboundEmailDomain: domain }) as any;
  const app = express();
  app.use(createInboundEmailWebhook(db as any, { provider, deps: { db, fileStorage, domain, audit: async (_tx, _tenant, action) => { audits.push(action); }, memberEmails: async () => ["andreas@richtfest.ai"] } }));
  app.use(express.json()); app.use(createInquiriesRouter(deps)); app.use(createInboundEmailRouter(deps));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 500).json({ message: e.message }));
  const server = app.listen(0); const root = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const r = await fetch(root + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const deliver = async (id: string, message: Parameters<typeof eml>[0], signature = "valid") => {
    messages.set(id, { raw: eml(message), recipients: [message.to] });
    const r = await fetch(`${root}/api/inbound-email/resend`, { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": "1", "svix-signature": signature },
      body: JSON.stringify({ type: "email.received", data: { email_id: id, to: [message.to] } }) });
    return { status: r.status, body: await r.json() };
  };
  try {
    for (const table of ["projects_projects", "projects_files", "projects_file_versions", "projects_source_extractions", "projects_source_models",
      "projects_inquiries", "projects_inquiry_entries", "projects_inbound_mailboxes", "projects_inbound_emails",
      ...(await admin.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'projects_building_%'")).rows.map(r => r.tablename)])
      if (/^projects_[a-z_]+$/.test(table)) await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Inbound test',$3)", [project, tenant, actor]);

    const mailbox = await call(`/projects/${project}/inbound-mailbox`, {});
    expect(mailbox.status).toBe(201);
    const address: string = mailbox.body.data.address;
    expect(address).toMatch(/^[a-z2-7]{10}@in\.test\.richtfest\.ai$/);
    expect((await call(`/projects/${project}/inbound-mailbox`, {})).body.data.address).toBe(address);
    const inquiry = (await call(`/projects/${project}/inquiries`, { kind: "general", title: "Bauteile", counterpart: "Architekt", request: { body: "Bitte Angaben" } })).body.data;
    const replyAddress = (await call(`/projects/${project}/inquiries/${inquiry.id}`)).body.data.replyAddress;
    expect(replyAddress).toBe(address.replace("@", `+${inquiry.id.replaceAll("-", "").slice(0, 8)}@`));

    // Unsigned requests are refused before anything is read.
    expect((await deliver("e0", { from: "x@example.com", to: address, subject: "x", body: "x" }, "forged")).status).toBe(401);
    // A reply to the inquiry address is filed there with its attachment; a retry of the same message files nothing twice.
    const reply = { from: "Anna Muster <a.muster@muster-architekten.de>", to: replyAddress, subject: "AW: Bauteile", body: "Außenwände KS 36,5 cm.", attachment: "Angaben.pdf" };
    expect((await deliver("e1", reply)).body.data.status).toBe("filed");
    expect((await deliver("e1", reply)).body.data.status).toBe("duplicate");
    const detail = (await call(`/projects/${project}/inquiries/${inquiry.id}`)).body.data;
    expect(detail.status).toBe("answered");
    expect(detail.entries.map((entry: any) => [entry.kind, entry.direction, entry.subject, entry.fileName])).toEqual([["request", "outgoing", null, null], ["email", "incoming", "AW: Bauteile", "Angaben.pdf"]]);
    const sources = (await pool.query("select f.name, f.source_type, v.mime_type from projects_files f join projects_file_versions v on v.file_id=f.id order by f.name")).rows;
    expect(sources).toEqual([{ name: "Angaben.pdf", source_type: "email", mime_type: "application/pdf" }, { name: `E-Mail ${new Date().toISOString().slice(0, 10)} AW Bauteile.eml`, source_type: "email", mime_type: "message/rfc822" }]);
    expect(stored.size).toBe(2);

    // A member's own CC counts as sent; mail to the project address waits in the inbox until filed or dismissed.
    expect((await deliver("e2", { from: "andreas@richtfest.ai", to: address, subject: "Fwd: Rückfrage", body: "Siehe unten" })).body.data.status).toBe("unfiled");
    expect((await deliver("e3", { from: "spam@example.com", to: address, subject: "Angebot", body: "…" })).body.data.status).toBe("unfiled");
    expect((await deliver("e4", { from: "x@example.com", to: "aaaaaaaaaa@in.test.richtfest.ai", subject: "x", body: "x" })).body.data.status).toBe("unknown_address");
    const inbox = (await call(`/projects/${project}/inbound-mailbox`)).body.data.unfiled.sort((a: any, b: any) => b.subject.localeCompare(a.subject));
    expect(inbox.map((item: any) => [item.subject, item.direction])).toEqual([["Fwd: Rückfrage", "outgoing"], ["Angebot", "incoming"]]);
    expect((await call(`/projects/${project}/inbound-emails/${inbox[0].id}/file`, { inquiryId: inquiry.id })).status).toBe(200);
    expect((await call(`/projects/${project}/inbound-emails/${inbox[0].id}/file`, { inquiryId: inquiry.id })).status).toBe(404);
    expect((await call(`/projects/${project}/inbound-emails/${inbox[1].id}/dismiss`, {})).status).toBe(200);
    expect((await call(`/projects/${project}/inbound-mailbox`)).body.data.unfiled).toEqual([]);
    expect((await call(`/projects/${project}/inquiries/${inquiry.id}`)).body.data).toMatchObject({ status: "waiting", entries: [{}, {}, { direction: "outgoing", subject: "Fwd: Rückfrage" }] });
    expect(audits).toEqual(expect.arrayContaining(["projects.inbound_mailbox.created", "projects.inquiry.email_received", "projects.inquiry.email_filed", "projects.inquiry.email_dismissed"]));
  } finally { server.close(); await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end(); }
}, 60000);
