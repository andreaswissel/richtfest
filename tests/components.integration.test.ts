import { expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { createApp } from "../richtfest-os/apps/api/src/server";
import { componentsDeps } from "../richtfest-os/apps/api/src/components-host";
import { knowledgeDeps } from "../richtfest-os/apps/api/src/app-hosts";
import { searchReviewedComponents } from "../richtfest-apps/components/src/queries";
import { componentImportInput } from "../richtfest-shared/src/components";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileStorage } from "../richtfest-os/apps/api/src/file-storage";

// Tiny, valid one-page PDF with computed xref offsets; no binary fixture on disk.
function pdfFixture(label: string) {
  const content = `BT /F1 12 Tf 20 100 Td (${label}) Tj ET\n`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const integration = process.env.DATABASE_URL ? test : test.skip;
integration("component HTTP imports retain evidence and review history, enforce concurrency, permissions and tenant scope", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID();
  const identities: { id: string; role: string; tenant: string; email: string; cookie?: string; permissions: string[] }[] = [];
  const server = createApp(db, { allowDevAuth: true }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = async (path: string, identity?: typeof identities[number], body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", origin: process.env.BETTER_AUTH_URL ?? "http://localhost:3000", ...(identity?.cookie ? { cookie: identity.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  try {
    for (const t of [tenant, otherTenant]) await pool.query("INSERT INTO os_tenants (id,name) VALUES ($1,'Components integration')", [t]);
    for (const [index, t] of [tenant, tenant, otherTenant, tenant].entries()) {
      const permissions = index === 1 ? ["richtfest-os:use", "components:read"] : index === 3 ? ["richtfest-os:use"] : ["richtfest-os:use", "components:read", "components:import", "components:review"];
      const identity = { id: crypto.randomUUID(), role: crypto.randomUUID(), tenant: t, email: `components-${crypto.randomUUID()}@richtfest.local`, permissions };
      identities.push(identity);
      await pool.query("INSERT INTO os_users (id,name,email) VALUES ($1,'Component tester',$2)", [identity.id, identity.email]);
      await pool.query("INSERT INTO auth_user (id,name,email,email_verified) VALUES ($1,'Component tester',$2,true)", [identity.id, identity.email]);
      await pool.query("INSERT INTO os_roles (id,tenant_id,name) VALUES ($1,$2,$3)", [identity.role, t, `Test ${index}`]);
      await pool.query("INSERT INTO os_memberships (tenant_id,user_id,role_id) VALUES ($1,$2,$3)", [t, identity.id, identity.role]);
      for (const permission of permissions) await pool.query("INSERT INTO os_role_permissions (role_id,permission) VALUES ($1,$2)", [identity.role, permission]);
      const login = await request("/auth/dev-login", undefined, { email: identity.email });
      expect(login.status).toBe(200); identities[index]!.cookie = login.cookie;
      const session = await request("/auth/me", identities[index]);
      expect(session.status).toBe(200);
      expect(session.body.data.permissions.toSorted()).toEqual(permissions.toSorted());
    }
    const [admin, reader, outsider, denied] = identities;
    const queryDeps = (identity: typeof identities[number]) => componentsDeps(db, { actor: { id: identity.id, tenantId: identity.tenant, permissions: new Set(identity.permissions) } } as any);
    const agentContext = (identity: typeof identities[number]) => knowledgeDeps(db, { actor: { id: identity.id, tenantId: identity.tenant, permissions: new Set(identity.permissions) } } as any).componentContext!("Compare REHAU windows for this project");
    expect((await request("/components")).status).toBe(401);
    expect((await request("/components", denied)).status).toBe(403);
    expect((await request("/components?q=&category=&reviewStatus=&offset=0", admin)).status).toBe(200);
    const template = componentImportInput.parse((await request("/components/starter", admin)).body.data);
    const data = template.records[0]!.data;
    const input = { records: [{ data, expectedRevisionId: null }] };
    expect((await request("/components/import", reader, input)).status).toBe(403);
    const invalid = structuredClone(input); invalid.records[0]!.data.facts[0]!.sourceId = "missing-source";
    expect((await request("/components/import", admin, invalid)).status).toBe(400);
    const [first, duplicate] = await Promise.all([request("/components/import", admin, input), request("/components/import", admin, input)]);
    expect(first.status).toBe(200); expect(duplicate.body.data.items[0].revisionId).toBe(first.body.data.items[0].revisionId);
    const original = first.body.data.items[0];
    expect((await searchReviewedComponents(queryDeps(admin), { id: original.id })).items).toEqual([]);
    const review = { expectedRevisionId: original.revisionId, expectedReviewVersion: 0, status: "reviewed", note: "Evidence and conditions checked" };
    expect((await request(`/components/${original.id}/review`, reader, review)).status).toBe(403);
    expect((await request(`/components/${original.id}/review`, admin, review)).body.data.reviewVersion).toBe(1);
    expect((await request(`/components/${original.id}/review`, admin, review)).status).toBe(409);
    const idempotent = (await request("/components/import", admin, input)).body.data.items[0];
    expect(idempotent.reviewStatus).toBe("reviewed"); expect(idempotent.reviewVersion).toBe(1);
    const match = await searchReviewedComponents(queryDeps(admin), { query: "Fenster REHAU" });
    expect(match.items[0]!.revisionId).toBe(original.revisionId); expect(match.items[0]!.data.facts).toEqual(data.facts);
    expect(await agentContext(admin)).toMatchObject({ status: "available", items: [{ revisionId: original.revisionId, data: { facts: data.facts } }] });
    expect(await agentContext(denied)).toEqual({ status: "forbidden", items: [] });
    expect(await agentContext(outsider)).toMatchObject({ status: "available", items: [] });
    expect((await searchReviewedComponents(queryDeps(outsider), { id: original.id })).items).toEqual([]);
    await expect(searchReviewedComponents(queryDeps(denied), {})).rejects.toThrow();
    expect((await request(`/components/${original.id}`, outsider)).status).toBe(404);
    expect((await request(`/components/${original.id}/review`, outsider, review)).status).toBe(404);
    const changed: { records: { data: typeof data; expectedRevisionId: string | null }[] } = { records: [{ data: { ...data, name: `${data.name} revised` }, expectedRevisionId: null }] };
    expect((await request("/components/import", admin, changed)).status).toBe(409);
    changed.records[0]!.expectedRevisionId = original.revisionId;
    const revised = (await request("/components/import", admin, changed)).body.data.items[0];
    expect(revised.revision).toBe(2); expect(revised.reviewStatus).toBe("unreviewed"); expect(revised.reviewVersion).toBe(0);
    expect((await request("/components/import", admin, input)).status).toBe(409);
    expect((await request(`/components/${original.id}/review`, admin, { ...review, expectedReviewVersion: 1 })).status).toBe(409);
    expect((await searchReviewedComponents(queryDeps(admin), { id: original.id })).items).toEqual([]);
    expect(await agentContext(admin)).toMatchObject({ items: [] });
    const history = (await request(`/components/${original.id}`, admin)).body.data.history;
    expect(history.map((r: any) => r.revision)).toEqual([2, 1]); expect(history[1].reviewStatus).toBe("reviewed");
    expect((await request("/components/import-starter", admin, {})).body.data.items).toHaveLength(3);
    expect((await request("/components/import-starter", admin, {})).body.data.items).toHaveLength(0);
    expect((await request(`/components/${original.id}`, admin)).body.data.component.revisionId).toBe(revised.revisionId);
    const page = (await request("/components?limit=1", admin)).body.data;
    expect(page.items).toHaveLength(1); expect(page.nextOffset).toBe(1);
    expect((await request("/components?limit=51", admin)).status).toBe(400);
    expect((await request("/components?category=floor_slab", admin)).body.data.items).toHaveLength(3);
    expect((await request("/components", outsider)).body.data.items).toEqual([]);
    const audit = await pool.query("SELECT action FROM os_audit_events WHERE tenant_id=$1 AND entity_id=$2", [tenant, original.id]);
    expect(audit.rows.map((r: any) => r.action).sort()).toEqual(["components.imported", "components.imported", "components.reviewed"]);

    const pdf = pdfFixture("Preserved evidence"), nextPdf = pdfFixture("Changed evidence");
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const pdfData = structuredClone(data);
    pdfData.key = "pdf-test";
    pdfData.sources = [{ ...data.sources[0]!, sha256: sha(pdf), pages: 1 }];
    pdfData.facts = [{ ...data.facts[0]!, sourceId: pdfData.sources[0]!.id, page: 1 }];
    const imported = await request("/components/import", admin, { records: [{ data: pdfData, expectedRevisionId: null }] });
    expect(imported.status).toBe(200);
    const pdfRecord = imported.body.data.items[0];
    const url = (r: any, sourceId = pdfData.sources[0]!.id) => `/components/${r.id}/revisions/${r.revisionId}/sources/${encodeURIComponent(sourceId)}/pdf`;
    const upload = async (r: any, bytes: Buffer, actor = admin, mime = "application/pdf", sourceId?: string) => {
      const response = await fetch(`${base}${url(r, sourceId)}`, { method: "PUT", headers: { "content-type": mime, origin: process.env.BETTER_AUTH_URL ?? "http://localhost:3000", cookie: actor!.cookie! }, body: bytes });
      return { status: response.status, body: await response.json() };
    };
    const download = (r: any, actor = reader, sourceId?: string) => fetch(`${base}${url(r, sourceId)}`, { headers: { cookie: actor!.cookie! } });
    expect((await download(pdfRecord)).status).toBe(404);
    expect((await upload(pdfRecord, pdf, reader)).status).toBe(403);
    expect((await upload(pdfRecord, pdf, denied)).status).toBe(403);
    expect((await upload(pdfRecord, pdf, outsider)).status).toBe(404);
    expect((await upload(pdfRecord, pdf, admin, "text/plain")).status).toBe(415);
    expect((await upload(pdfRecord, pdf, admin, "application/pdf", "unknown")).status).toBe(404);
    expect((await upload({ ...pdfRecord, revisionId: original.revisionId }, pdf)).status).toBe(404);
    expect((await upload(pdfRecord, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(pdfRecord, nextPdf)).status).toBe(400);
    expect((await request(`/components/${pdfRecord.id}`, admin)).body.data.documents).toEqual([]);
    const uploaded = await upload(pdfRecord, pdf);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.data).toMatchObject({ sha256: sha(pdf), pages: 1, sizeBytes: pdf.length });
    expect(Object.keys(uploaded.body.data).sort()).toEqual(["createdAt", "id", "pages", "sha256", "sizeBytes"]);
    const duplicates = await Promise.all([upload(pdfRecord, pdf), upload(pdfRecord, pdf)]);
    expect(duplicates.map(r => r.body.data.id)).toEqual([uploaded.body.data.id, uploaded.body.data.id]);
    const preserved = await download(pdfRecord);
    expect(preserved.status).toBe(200);
    expect(preserved.headers.get("content-type")).toBe("application/pdf");
    expect(preserved.headers.get("cache-control")).toBe("private, no-store");
    expect(preserved.headers.get("x-content-type-options")).toBe("nosniff");
    expect(preserved.headers.get("content-disposition")).toStartWith("inline;");
    expect(Buffer.from(await preserved.arrayBuffer())).toEqual(pdf);
    expect((await download(pdfRecord, outsider)).status).toBe(404);
    expect((await download(pdfRecord, denied)).status).toBe(403);
    const pdfDetail = (await request(`/components/${pdfRecord.id}`, reader)).body.data;
    expect(pdfDetail.component).toEqual(pdfRecord); // Attachment never reviews or revises.
    expect(pdfDetail.documents).toEqual([uploaded.body.data]);
    const newData = { ...pdfData, sources: [{ ...pdfData.sources[0]!, sha256: sha(nextPdf) }] };
    const newRecord = (await request("/components/import", admin, { records: [{ data: newData, expectedRevisionId: pdfRecord.revisionId }] })).body.data.items[0];
    expect((await download(newRecord)).status).toBe(404);
    expect((await upload(pdfRecord, pdf)).status).toBe(409);
    expect(Buffer.from(await (await download(pdfRecord)).arrayBuffer())).toEqual(pdf);
    expect((await upload(newRecord, nextPdf)).status).toBe(200);
    expect(Buffer.from(await (await download(newRecord)).arrayBuffer())).toEqual(nextPdf);
    expect(Buffer.from(await (await download(pdfRecord)).arrayBuffer())).toEqual(pdf);
    const pdfHistory = (await request(`/components/${pdfRecord.id}`, reader)).body.data;
    expect(pdfHistory.documents).toHaveLength(2);
    expect(pdfHistory.history[1].data.sources[0].sha256).toBe(sha(pdf));
    const pdfAudit = await pool.query("SELECT action FROM os_audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='components.pdf_uploaded'", [tenant, pdfRecord.id]);
    expect(pdfAudit.rows).toHaveLength(2);

    // Keep an actual HTTP body incomplete while another import advances the record.
    const racePdf = pdfFixture("Concurrent evidence");
    const raceData = { ...pdfData, sources: [{ ...pdfData.sources[0]!, sha256: sha(racePdf) }] };
    const raceRecord = (await request("/components/import", admin, { records: [{ data: raceData, expectedRevisionId: newRecord.revisionId }] })).body.data.items[0];
    let finishUpload!: () => void;
    const racedUpload = new Promise<number>((resolve, reject) => {
      const pending = httpRequest(`${base}${url(raceRecord)}`, { method: "PUT", headers: { "content-type": "application/pdf", "content-length": racePdf.length, cookie: admin!.cookie!, origin: process.env.BETTER_AUTH_URL ?? "http://localhost:3000" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode!));
      });
      pending.on("error", reject);
      pending.write(racePdf.subarray(0, 32));
      finishUpload = () => pending.end(racePdf.subarray(32));
    });
    await Bun.sleep(100);
    try {
      expect((await request("/components/import", admin, { records: [{ data: { ...raceData, name: "Concurrent revision" }, expectedRevisionId: raceRecord.revisionId }] })).status).toBe(200);
    } finally { finishUpload(); }
    expect(await racedUpload).toBe(409);
    expect((await request(`/components/${pdfRecord.id}`, reader)).body.data.documents).toHaveLength(2);
    expect((await download(raceRecord)).status).toBe(404);

    for (const [key, bytes, pages, checksum] of [
      ["wrong-pages", pdf, 2, sha(pdf)], ["forged-pdf", Buffer.from("%PDF-1.4\nnot a PDF"), 1, sha(Buffer.from("%PDF-1.4\nnot a PDF"))],
      ["not-pdf", Buffer.from("not a PDF"), 1, sha(Buffer.from("not a PDF"))], ["link-only", pdf, 1, null],
    ] as const) {
      const invalidRecord = (await request("/components/import", admin, { records: [{ data: { ...pdfData, key, sources: [{ ...pdfData.sources[0]!, pages, sha256: checksum }] }, expectedRevisionId: null }] })).body.data.items[0];
      expect((await upload(invalidRecord, bytes)).status).toBe(400);
      expect((await download(invalidRecord)).status).toBe(404);
      expect((await request(`/components/${invalidRecord.id}`, reader)).body.data.documents).toEqual([]);
    }
    const storedKeys = (await pool.query("SELECT storage_key FROM components_documents WHERE tenant_id=$1", [tenant])).rows;
    expect(storedKeys).toHaveLength(2);
    for (const row of storedKeys) expect(row.storage_key).toMatch(new RegExp(`^${tenant}/${pdfRecord.id}/[a-f0-9-]{36}/[a-f0-9-]{36}$`));
    if (fileStorage.kind === "local") {
      const files = await readdir(join(process.env.FILE_STORAGE_PATH ?? "./.data/files", tenant), { recursive: true, withFileTypes: true });
      expect(files.filter(entry => entry.isFile())).toHaveLength(4); // No objects left from duplicates or the losing race.
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const t of [tenant, otherTenant]) {
      const stored = await pool.query("SELECT storage_key FROM components_documents WHERE tenant_id=$1", [t]);
      for (const row of stored.rows) await componentsDeps(db, { actor: { id: identities[0]?.id, tenantId: t, permissions: new Set() } } as any).removePdf(row.storage_key);
      await pool.query("DELETE FROM components_documents WHERE tenant_id=$1", [t]);
      await pool.query("UPDATE components_components SET current_revision_id=NULL WHERE tenant_id=$1", [t]);
      for (const table of ["components_revisions", "components_components", "os_audit_events", "os_memberships"]) await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [t]);
      await pool.query("DELETE FROM os_role_permissions WHERE role_id IN (SELECT id FROM os_roles WHERE tenant_id=$1)", [t]);
      await pool.query("DELETE FROM os_roles WHERE tenant_id=$1", [t]); await pool.query("DELETE FROM os_tenants WHERE id=$1", [t]);
    }
    for (const identity of identities) {
      await pool.query("DELETE FROM auth_session WHERE user_id=$1", [identity.id]); await pool.query("DELETE FROM auth_user WHERE id=$1", [identity.id]); await pool.query("DELETE FROM os_users WHERE id=$1", [identity.id]);
    }
    await pool.end();
  }
}, 30000);
