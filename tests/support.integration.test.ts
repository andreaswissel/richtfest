import { expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { createApp } from "../richtfest-os/apps/api/src/server";

const integration = process.env.DATABASE_URL && process.env.AI_CONNECTION_ENCRYPTION_KEY ? test : test.skip;
integration("help proposals require submission; reports are durable, idempotent and scoped for coding-agent retrieval", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID();
  const identities: { id: string; role: string; tenant: string; email: string; cookie?: string }[] = [];
  let mode = "help", calls = 0;
  const server = createApp(db, { allowDevAuth: true, providerFetch: async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init.body)), context = JSON.parse(body.input).context;
    expect(context.documentation.some((doc: any) => doc.content.includes("Project workspace"))).toBe(true);
    expect(context.navigation.connections).toBe("/settings");
    expect(body.instructions).toContain("application help agent");
    if (mode === "failure") return new Response("sk-private-upstream-error", { status: 500 });
    const output = {
      summary: mode === "help" ? "Open Settings to configure your connection." : "Review the report before submitting it.",
      openui: mode === "unsafe" ? 'root = ArtifactAction("Open", "550e8400-e29b-41d4-a716-446655440000")' : 'root = Callout("Check Settings for your provider connection.")',
      proposal: mode === "help" ? null : { kind: "bug", title: "Upload never finishes", description: "Steps: upload a PDF. Expected: ready. Actual: spinner remains.", pagePath: "/projects" },
    };
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  } }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, identity?: typeof identities[number], body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", origin: process.env.BETTER_AUTH_URL ?? "http://localhost:3000", ...(identity?.cookie ? { cookie: identity.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  try {
    for (const t of [tenant, otherTenant]) await pool.query("INSERT INTO os_tenants (id,name) VALUES ($1,'Support integration')", [t]);
    for (const [index, t] of [tenant, tenant, otherTenant, tenant].entries()) {
      const identity = { id: crypto.randomUUID(), role: crypto.randomUUID(), tenant: t, email: `support-${crypto.randomUUID()}@richtfest.local` };
      identities.push(identity);
      await pool.query("INSERT INTO os_users (id,name,email) VALUES ($1,'Support tester',$2)", [identity.id, identity.email]);
      await pool.query("INSERT INTO auth_user (id,name,email,email_verified) VALUES ($1,'Support tester',$2,true)", [identity.id, identity.email]);
      await pool.query("INSERT INTO os_roles (id,tenant_id,name) VALUES ($1,$2,$3)", [identity.role, t, `Test ${index}`]);
      await pool.query("INSERT INTO os_memberships (tenant_id,user_id,role_id) VALUES ($1,$2,$3)", [t, identity.id, identity.role]);
      const permissions = index === 3 ? [] : index === 0 || index === 2 ? ["richtfest-os:use", "access:manage", "agent:run"] : ["richtfest-os:use"];
      for (const permission of permissions) await pool.query("INSERT INTO os_role_permissions (role_id,permission) VALUES ($1,$2)", [identity.role, permission]);
      const login = await request("/auth/dev-login", undefined, { email: identity.email });
      expect(login.status).toBe(200);
      identities[index]!.cookie = login.cookie;
    }
    const [admin, member, outsider, noAccess] = identities;
    expect((await request("/support/reports")).status).toBe(401);
    expect((await request("/support/reports", noAccess)).status).toBe(403);
    expect((await request("/support", admin)).body.data.readiness.configured).toBe(false);
    const conversation = (await request("/support/conversations", admin, {})).body.data;
    const path = `/support/conversations/${conversation.id}`;
    const unavailable = await request(`${path}/messages`, admin, { id: crypto.randomUUID(), body: "How do I connect an AI provider?" });
    expect(unavailable.body.data.message.status).toBe("unconfigured");
    expect(calls).toBe(0);
    expect((await request(path, member)).status).toBe(404);
    expect((await request(path, outsider)).status).toBe(404);
    const memberChat = (await request("/support/conversations", member, {})).body.data;
    expect((await request(`/support/conversations/${memberChat.id}/messages`, member, { id: crypto.randomUUID(), body: "Hello" })).status).toBe(403);

    const manual = { id: crypto.randomUUID(), kind: "feature", title: "Filter projects by status", description: "Show active projects without hiding archived evidence.", pagePath: "/projects" };
    expect((await request("/support/reports", member, { ...manual, pagePath: "//outside.invalid" })).status).toBe(400);
    const filed = await request("/support/reports", member, manual);
    expect(filed.status).toBe(200);
    expect(filed.body.data.id).toBe(manual.id);
    expect((await request("/support/reports", member, manual)).body.data.id).toBe(manual.id);
    expect((await request("/support/reports", member, { ...manual, title: "Different report" })).status).toBe(409);
    expect((await request(`/support/reports/${manual.id}`, outsider)).status).toBe(404);
    expect((await request(`/support/reports/${manual.id}`, member, { status: "resolved" }, "PATCH")).status).toBe(403);

    expect((await request("/settings/ai-connections/openai/personal", admin, { apiKey: "sk-support-test-placeholder" }, "PUT")).status).toBe(200);
    const helpRequest = { id: crypto.randomUUID(), body: "Where do I configure an AI connection?" };
    const helped = await request(`${path}/messages`, admin, helpRequest);
    expect(helped.body.data.message.status).toBe("completed");
    expect(helped.body.data.message.proposal).toBeNull();
    expect(helped.body.data.message.openui).toContain("Callout");
    expect(helped.body.data.message.sources[0].path).toBe("/docs/workflows/project-onboarding");
    expect((await request(`${path}/messages`, admin, helpRequest)).body.data.message.id).toBe(helped.body.data.message.id);
    expect(calls).toBe(1);
    expect((await request(`${path}/messages`, admin, { ...helpRequest, body: "Changed request" })).status).toBe(409);
    mode = "bug";
    const proposed = (await request(`${path}/messages`, admin, { id: crypto.randomUUID(), body: "The PDF upload keeps spinning. Please file a bug." })).body.data.message;
    expect(proposed.proposal.title).toBe("Upload never finishes");
    expect((await request("/support/reports?kind=bug", admin)).body.data.items).toEqual([]);
    expect((await request("/support/reports", member, { ...manual, id: crypto.randomUUID(), messageId: proposed.id })).status).toBe(404);
    const reviewed = { ...proposed.proposal, title: "PDF upload spinner remains", id: crypto.randomUUID(), messageId: proposed.id };
    const [first, duplicate] = await Promise.all([request("/support/reports", admin, reviewed), request("/support/reports", admin, { ...reviewed, id: crypto.randomUUID() })]);
    expect(first.status).toBe(200);
    expect(duplicate.body.data.id).toBe(first.body.data.id);
    const report = first.body.data;
    expect(report.title).toBe(reviewed.title);
    expect(report.url).toBe(`/help?report=${report.id}`);
    expect((await request(path, admin)).body.data.messages.find((m: any) => m.id === proposed.id).reportId).toBe(report.id);
    expect((await request(`/support/reports/${report.id}`, member)).status).toBe(404);
    expect((await request(`/support/reports/${report.id}`, outsider, { status: "resolved" }, "PATCH")).status).toBe(404);
    expect((await request(`/support/reports/${report.id}`, admin, { status: "in_progress" }, "PATCH")).body.data.status).toBe("in_progress");

    const page1 = (await request("/support/reports?limit=1", admin)).body.data;
    const page2 = (await request(`/support/reports?limit=1&cursor=${page1.nextCursor}`, admin)).body.data;
    expect(new Set([...page1.items, ...page2.items].map((r: any) => r.id))).toEqual(new Set([manual.id, report.id]));
    expect(page2.nextCursor).toBeNull();
    expect((await request("/support/reports?kind=bug&status=open", admin)).body.data.items).toEqual([]);
    expect((await request("/support/reports?kind=bug&status=in_progress", admin)).body.data.items.map((r: any) => r.id)).toEqual([report.id]);
    expect((await request("/support/reports", member)).body.data.items.map((r: any) => r.id)).toEqual([manual.id]);
    expect((await request("/support/reports", outsider)).body.data.items).toEqual([]);
    for (mode of ["unsafe", "failure"]) {
      const failed = await request(`${path}/messages`, admin, { id: crypto.randomUUID(), body: "Try another answer" });
      expect(failed.body.data.message.status).toBe("failed");
      expect(failed.body.data.message.openui).toBeNull();
      expect(JSON.stringify(failed.body)).not.toContain("sk-private");
    }
    const audit = await pool.query("SELECT action FROM os_audit_events WHERE tenant_id=$1 AND entity_id=$2", [tenant, report.id]);
    expect(audit.rows.map((r: any) => r.action).sort()).toEqual(["support.report.filed", "support.report.updated"]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    // Only this test's fresh tenant IDs are touched.
    for (const t of [tenant, otherTenant]) {
      await pool.query("DELETE FROM support_reports WHERE tenant_id=$1", [t]);
      await pool.query("DELETE FROM support_messages WHERE conversation_id IN (SELECT id FROM support_conversations WHERE tenant_id=$1)", [t]);
      await pool.query("DELETE FROM support_conversations WHERE tenant_id=$1", [t]);
      for (const table of ["os_audit_events", "os_ai_connections", "os_memberships"]) await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [t]);
      await pool.query("DELETE FROM os_role_permissions WHERE role_id IN (SELECT id FROM os_roles WHERE tenant_id=$1)", [t]);
      await pool.query("DELETE FROM os_roles WHERE tenant_id=$1", [t]);
      await pool.query("DELETE FROM os_tenants WHERE id=$1", [t]);
    }
    for (const identity of identities) {
      await pool.query("DELETE FROM auth_session WHERE user_id=$1", [identity.id]);
      await pool.query("DELETE FROM auth_user WHERE id=$1", [identity.id]);
      await pool.query("DELETE FROM os_users WHERE id=$1", [identity.id]);
    }
    await pool.end();
  }
}, 30000);
