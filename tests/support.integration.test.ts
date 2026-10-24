import { expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { createApp } from "../richtfest-os/apps/api/src/server";

const integration = process.env.DATABASE_URL && process.env.AI_CONNECTION_ENCRYPTION_KEY ? test : test.skip;
integration("help proposals require submission; reports are durable, idempotent and scoped for coding-agent retrieval", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID();
  const projectId = crypto.randomUUID(), foreignProjectId = crypto.randomUUID();
  const identities: { id: string; role: string; tenant: string; email: string; cookie?: string }[] = [];
  let mode = "help", calls = 0;
  let expectedContext: { pagePath?: string; projectId?: string } = {};
  const server = createApp(db, { allowDevAuth: true, providerFetch: async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init.body)), context = JSON.parse(body.input).context;
    expect(context.documentation.some((doc: any) => doc.content.includes("Project workspace"))).toBe(true);
    expect(context.navigation.connections).toBe("/settings");
    expect(body.instructions).toContain("application help agent");
    expect(context.currentContext).toEqual(expectedContext);
    expect(body.instructions).toContain("unsaved inputs");
    expect(body.instructions).toContain("proactively offer help");
    if (mode === "failure") return new Response("sk-private-upstream-error", { status: 500 });
    const output: any = {
      summary: mode === "help" ? "Open Settings to configure your connection." : "Review the report before submitting it.",
      openui: mode === "unsafe" ? 'root = ArtifactAction("Open", "550e8400-e29b-41d4-a716-446655440000")' : 'root = Callout("Check Settings for your provider connection.")',
      proposal: mode === "help" ? null : { kind: "bug", title: "Upload never finishes", description: "Steps: upload a PDF. Expected: ready. Actual: spinner remains.", pagePath: "/projects" },
    };
    if (mode === "acoustic") {
      expect(body.instructions).toContain("Wo kann ich ein Schallschutzkonzept erstellen");
      expect(body.instructions).toContain("Report mode");
      expect(context.availableFeatures).toContain("building-model");
      expect(context.documentation.some((doc: any) => doc.content.includes("Sound insulation") && doc.content.includes("Report"))).toBe(true);
      output.summary = "Bereite im Gebäudemodell Quellen, Räume und Bauteile mit geprüften Schallschutzeingaben vor. Erstelle anschließend im Projektchat mit Report einen quellenbezogenen Konzeptentwurf zur menschlichen Prüfung, keinen geprüften Schallschutznachweis. Soll ich dir helfen, das Berichtsziel und fehlende Unterlagen zu formulieren?";
      output.openui = 'root = MissingInput("Berichtsziel", "Was soll das Schallschutzkonzept abdecken?")';
      output.proposal = null;
      output.suggestions = [{ featureKey: "building-model", title: "Gebäudemodell vorbereiten" }, { featureKey: "project-chat", title: "Projektchat öffnen" }];
    }
    if (mode === "feedback") output.proposal = { kind: "feedback", title: "Navigation ist unübersichtlich", description: "Ich finde die Berichtsfunktion schwer.", pagePath: "/" };
    if (mode === "unknown-feature") output.suggestions = [{ featureKey: "invented-engineering-tool", title: "Calculate" }];
    if (mode === "provider-url") output.suggestions = [{ featureKey: "help", title: "Open", path: "https://outside.invalid" }];
    if (mode === "cross-project-url") output.suggestions = [{ featureKey: "project-chat", title: "Open", path: `/projects/${foreignProjectId}` }];
    if (mode === "too-many") output.suggestions = Array.from({ length: 7 }, () => ({ featureKey: "help", title: "Help" }));
    if (mode === "duplicate-feature") output.suggestions = [{ featureKey: "help", title: "Help" }, { featureKey: "help", title: "Again" }];
    if (mode === "denied-feature") {
      expect(context.availableFeatures).not.toContain("project-chat");
      output.suggestions = [{ featureKey: "project-chat", title: "Open" }];
    }
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  } }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, identity?: typeof identities[number], body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", origin: process.env.BETTER_AUTH_URL ?? "http://localhost:3000", ...(identity?.cookie ? { cookie: identity.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  try {
    for (const t of [tenant, otherTenant]) await pool.query("INSERT INTO os_tenants (id,name) VALUES ($1,'Support integration')", [t]);
    for (const [index, t] of [tenant, tenant, otherTenant, tenant, tenant].entries()) {
      const identity = { id: crypto.randomUUID(), role: crypto.randomUUID(), tenant: t, email: `support-${crypto.randomUUID()}@richtfest.local` };
      identities.push(identity);
      await pool.query("INSERT INTO os_users (id,name,email) VALUES ($1,'Support tester',$2)", [identity.id, identity.email]);
      await pool.query("INSERT INTO auth_user (id,name,email,email_verified) VALUES ($1,'Support tester',$2,true)", [identity.id, identity.email]);
      await pool.query("INSERT INTO os_roles (id,tenant_id,name) VALUES ($1,$2,$3)", [identity.role, t, `Test ${index}`]);
      await pool.query("INSERT INTO os_memberships (tenant_id,user_id,role_id) VALUES ($1,$2,$3)", [t, identity.id, identity.role]);
      const permissions = index === 3 ? [] : index === 0 || index === 2 ? ["richtfest-os:use", "access:manage", "agent:run", "projects:read", "knowledge:read"] : index === 4 ? ["richtfest-os:use", "agent:run"] : ["richtfest-os:use"];
      for (const permission of permissions) await pool.query("INSERT INTO os_role_permissions (role_id,permission) VALUES ($1,$2)", [identity.role, permission]);
      const login = await request("/auth/dev-login", undefined, { email: identity.email });
      expect(login.status).toBe(200);
      identities[index]!.cookie = login.cookie;
    }
    const [admin, member, outsider, noAccess, agentOnly] = identities;
    await pool.query("INSERT INTO projects_projects (id,tenant_id,name,created_by) VALUES ($1,$2,'Help project',$3),($4,$5,'Foreign project',$6)", [projectId, tenant, admin!.id, foreignProjectId, otherTenant, outsider!.id]);
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

    mode = "acoustic";
    const acousticRequest = { id: crypto.randomUUID(), body: "Wo kann ich ein Schallschutzkonzept erstellen", pagePath: `/projects/${projectId}?view=building-model`, projectId };
    expectedContext = { pagePath: acousticRequest.pagePath, projectId };
    const acoustic = (await request(`${path}/messages`, admin, acousticRequest)).body.data.message;
    expect(acoustic.status).toBe("completed");
    expect(acoustic.body).toContain("Report");
    expect(acoustic.body).toContain("Soll ich dir helfen");
    expect(acoustic.openui).toBe('root = MissingInput("Berichtsziel", "Was soll das Schallschutzkonzept abdecken?")');
    expect(acoustic.proposal).toBeNull();
    const appSources = acoustic.sources.filter((s: any) => !s.path.startsWith("/docs/"));
    expect(appSources).toEqual([
      { title: "Gebäudemodell vorbereiten", path: `/projects/${projectId}?view=building-model` },
      { title: "Projektchat öffnen", path: `/projects/${projectId}?view=workspace` },
    ]);
    const beforeRetry = calls;
    expect((await request(`${path}/messages`, admin, acousticRequest)).body.data.message.id).toBe(acoustic.id);
    expect(calls).toBe(beforeRetry);
    expect((await request(`${path}/messages`, admin, { ...acousticRequest, pagePath: "/" })).status).toBe(409);
    const savedMessages = (await request(path, admin)).body.data.messages;
    expect(savedMessages.find((m: any) => m.id === acoustic.id).openui).toBe(acoustic.openui);
    expect(savedMessages.find((m: any) => m.id === acoustic.id).sources).toEqual(acoustic.sources);
    expect(savedMessages.find((m: any) => m.id === acousticRequest.id).sources).toEqual([
      { title: "Current page", path: acousticRequest.pagePath }, { title: "Current project", path: `/projects/${projectId}` },
    ]);
    expect((await request("/support/reports", admin)).body.data.items).toHaveLength(2);

    expectedContext = { pagePath: "/" };
    const home = (await request(`${path}/messages`, admin, { id: crypto.randomUUID(), body: acousticRequest.body, pagePath: "/" })).body.data.message;
    expect(home.status).toBe("completed");
    expect(home.sources.filter((s: any) => !s.path.startsWith("/docs/")).map((s: any) => s.path)).toEqual(["/projects", "/projects"]);
    const beforeInvalid = calls;
    for (const [context, status] of [
      [{ projectId: foreignProjectId }, 404],
      [{ projectId: crypto.randomUUID() }, 404],
      [{ projectId, pagePath: `/projects/${foreignProjectId}` }, 400],
      [{ pagePath: `/projects/${foreignProjectId}` }, 404],
      [{ pagePath: "//outside.invalid" }, 400],
      [{ pagePath: "/foo/..//outside.invalid" }, 400],
      [{ pagePath: "/%2foutside.invalid" }, 400],
      [{ pagePath: `/${"a".repeat(500)}` }, 400],
      [{ projectId: "not-a-project" }, 400],
    ] as const) {
      expect((await request(`${path}/messages`, admin, { id: crypto.randomUUID(), body: "Help", ...context })).status).toBe(status);
    }
    expect(calls).toBe(beforeInvalid);
    expect((await request(`${path}/messages`, outsider, { id: crypto.randomUUID(), body: "Help", projectId })).status).toBe(404);
    const agentChat = (await request("/support/conversations", agentOnly, {})).body.data;
    const agentPath = `/support/conversations/${agentChat.id}/messages`;
    expect((await request(agentPath, agentOnly, { id: crypto.randomUUID(), body: "Help", projectId })).status).toBe(403);
    expect((await request(agentPath, agentOnly, { id: crypto.randomUUID(), body: "Help", pagePath: `/projects/${projectId}` })).status).toBe(403);
    expect((await request("/settings/ai-connections/openai/personal", agentOnly, { apiKey: "sk-support-test-placeholder" }, "PUT")).status).toBe(200);
    expectedContext = {};
    mode = "denied-feature";
    expect((await request(agentPath, agentOnly, { id: crypto.randomUUID(), body: "Open project chat" })).body.data.message.status).toBe("failed");

    for (mode of ["unsafe", "failure", "unknown-feature", "provider-url", "cross-project-url", "too-many", "duplicate-feature"]) {
      const failed = await request(`${path}/messages`, admin, { id: crypto.randomUUID(), body: "Try another answer" });
      expect(failed.body.data.message.status).toBe("failed");
      expect(failed.body.data.message.openui).toBeNull();
      expect(failed.body.data.message.sources).toEqual([]);
      expect(JSON.stringify(failed.body)).not.toContain("sk-private");
    }
    const audit = await pool.query("SELECT action FROM os_audit_events WHERE tenant_id=$1 AND entity_id=$2", [tenant, report.id]);
    expect(audit.rows.map((r: any) => r.action).sort()).toEqual(["support.report.filed", "support.report.updated"]);

    mode = "feedback";
    const feedback = (await request(`${path}/messages`, admin, { id: crypto.randomUUID(), body: "Die Navigation ist unübersichtlich; ich möchte Feedback senden." })).body.data.message;
    expect(feedback.proposal.kind).toBe("feedback");
    expect((await request("/support/reports?kind=feedback", admin)).body.data.items).toEqual([]);
    const feedbackSubmission = { ...feedback.proposal, id: crypto.randomUUID(), messageId: feedback.id };
    const submittedFeedback = await request("/support/reports", admin, feedbackSubmission);
    expect(submittedFeedback.status).toBe(200);
    expect((await request("/support/reports", admin, feedbackSubmission)).body.data.id).toBe(submittedFeedback.body.data.id);
    expect((await request("/support/reports", admin, { ...feedbackSubmission, description: "Changed" })).status).toBe(409);
    expect((await request("/support/reports?kind=feedback", admin)).body.data.items.map((r: any) => r.id)).toEqual([feedbackSubmission.id]);
    expect((await request(`/support/reports/${feedbackSubmission.id}`, member)).status).toBe(404);
    expect((await request(`/support/reports/${feedbackSubmission.id}`, outsider)).status).toBe(404);
    const feedbackAudit = await pool.query("SELECT action FROM os_audit_events WHERE tenant_id=$1 AND entity_id=$2", [tenant, feedbackSubmission.id]);
    expect(feedbackAudit.rows.map((r: any) => r.action)).toEqual(["support.report.filed"]);
    // Restarting a scan discovers later inserts and updates, regardless of UUID ordering.
    expect((await request("/support/reports", admin)).body.data.items).toHaveLength(3);

    // A continuing help chat must not require a hidden "new conversation" control.
    const continuing = (await request("/support/conversations", admin, {})).body.data;
    await pool.query(`INSERT INTO support_messages (conversation_id, role, body, created_at)
      SELECT $1, 'user', 'Saved message ' || n, now() - interval '1 hour' + n * interval '1 second'
      FROM generate_series(1, 201) AS n`, [continuing.id]);
    mode = "help";
    expectedContext = {};
    const continued = await request(`/support/conversations/${continuing.id}/messages`, admin, { id: crypto.randomUUID(), body: "Continue helping me" });
    expect(continued.status).toBe(200);
    expect(continued.body.data.message.status).toBe("completed");
    const recent = (await request(`/support/conversations/${continuing.id}`, admin)).body.data.messages;
    expect(recent).toHaveLength(100);
    expect(recent[0].body).toBe("Saved message 104");
    expect(recent.at(-2).body).toBe("Continue helping me");
    expect(recent.at(-1).id).toBe(continued.body.data.message.id);
    expect((await pool.query("SELECT count(*)::int AS count FROM support_messages WHERE conversation_id=$1", [continuing.id])).rows[0].count).toBe(203);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    // Only this test's fresh tenant IDs are touched.
    for (const t of [tenant, otherTenant]) {
      await pool.query("DELETE FROM support_reports WHERE tenant_id=$1", [t]);
      await pool.query("DELETE FROM support_messages WHERE conversation_id IN (SELECT id FROM support_conversations WHERE tenant_id=$1)", [t]);
      await pool.query("DELETE FROM support_conversations WHERE tenant_id=$1", [t]);
      await pool.query("DELETE FROM projects_projects WHERE tenant_id=$1", [t]);
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

integration("semantic feature navigation covers unrelated tasks and filters every destination by read permissions", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenant = crypto.randomUUID(), user = crypto.randomUUID(), role = crypto.randomUUID(), projectId = crypto.randomUUID();
  const email = `support-navigation-${user}@richtfest.local`;
  let cookie = "", suggestedKeys: string[] = [], captured: any;
  const server = createApp(db, { allowDevAuth: true, providerFetch: async (_url, init) => {
    captured = JSON.parse(JSON.parse(String(init.body)).input);
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      summary: "Öffne die passende Ansicht. Soll ich dir beim nächsten Schritt helfen?", proposal: null,
      suggestions: suggestedKeys.map(featureKey => ({ featureKey, title: `Open ${featureKey}` })),
    }) }] }] });
  } }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", origin: process.env.BETTER_AUTH_URL ?? "http://localhost:3000", cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const grants = async (permissions: string[]) => {
    await pool.query("DELETE FROM os_role_permissions WHERE role_id=$1", [role]);
    for (const permission of ["richtfest-os:use", "agent:run", ...permissions]) await pool.query("INSERT INTO os_role_permissions (role_id,permission) VALUES ($1,$2)", [role, permission]);
  };
  const common = ["overview", "team", "connections", "agent-models", "account", "help"];
  const projectFeatures = ["projects", "building-model", "project-sources", "project-inquiries", "project-noise", "project-feasibility", "fire-protection"];
  try {
    await pool.query("INSERT INTO os_tenants (id,name) VALUES ($1,'Support navigation')", [tenant]);
    await pool.query("INSERT INTO os_users (id,name,email) VALUES ($1,'Navigation tester',$2)", [user, email]);
    await pool.query("INSERT INTO auth_user (id,name,email,email_verified) VALUES ($1,'Navigation tester',$2,true)", [user, email]);
    await pool.query("INSERT INTO os_roles (id,tenant_id,name) VALUES ($1,$2,'Navigation reader')", [role, tenant]);
    await pool.query("INSERT INTO os_memberships (tenant_id,user_id,role_id) VALUES ($1,$2,$3)", [tenant, user, role]);
    await pool.query("INSERT INTO projects_projects (id,tenant_id,name,created_by) VALUES ($1,$2,'Navigation project',$3)", [projectId, tenant, user]);
    await grants(["projects:read", "knowledge:read", "crm:read", "components:read"]);
    const login = await request("/auth/dev-login", { email });
    expect(login.status).toBe(200);
    cookie = login.cookie!;
    expect((await request("/settings/ai-connections/openai/personal", { apiKey: "sk-navigation-test-placeholder" }, "PUT")).status).toBe(200);
    const chat = (await request("/support/conversations", {})).body.data;
    const messagePath = `/support/conversations/${chat.id}/messages`;
    for (const [question, key, destination] of [
      ["Wo finde ich die Ansprechpartner unserer Auftraggeber?", "customers", "/customers"],
      ["Ich suche geprüfte Hersteller-Bauteile statt unserer Projektdokumente.", "components", "/components"],
      ["Wo kann ich firmenweite freigegebene Hinweise lesen?", "company-knowledge", "/knowledge"],
    ]) {
      suggestedKeys = [key!];
      const answer = (await request(messagePath, { id: crypto.randomUUID(), body: question, pagePath: "/" })).body.data.message;
      expect(answer.status).toBe("completed");
      expect(answer.proposal).toBeNull();
      expect(answer.sources.filter((source: any) => !source.path.startsWith("/docs/"))).toEqual([{ title: `Open ${key}`, path: destination }]);
      expect(captured.goal).toBe(question);
      expect(captured.context.availableFeatures).toContain(key);
      expect(captured.context.featureDescriptions[key!].length).toBeGreaterThan(10);
      expect(captured.context.documentation.some((doc: any) => doc.path === "/docs/workflows/components" && doc.content.includes("catalog"))).toBe(true);
      expect(captured.context.documentation.some((doc: any) => doc.path === "/docs/platform/governance" && doc.content.includes("Company knowledge"))).toBe(true);
    }
    // Read-only actors can inspect models/team/profiles; edit grants are not invented.
    expect(captured.context.navigation["agent-profiles"]).toBe("/settings/agents");
    expect(captured.context.navigation["agent-models"]).toBe("/settings/models");
    expect(captured.context.navigation.team).toBe("/team");
    const projectRoutes = { "project-sources": "sources", "project-inquiries": "inquiries", "project-noise": "noise", "project-feasibility": "feasibility", "project-analytics": "analytics", "fire-protection": "fire-protection" };
    suggestedKeys = Object.keys(projectRoutes);
    const projectAnswer = (await request(messagePath, { id: crypto.randomUUID(), body: "Zeig mir die Projektbereiche", projectId })).body.data.message;
    expect(projectAnswer.status).toBe("completed");
    expect(projectAnswer.sources.filter((source: any) => !source.path.startsWith("/docs/")).map((source: any) => source.path)).toEqual(Object.values(projectRoutes).map(view => `/projects/${projectId}?view=${view}`));
    for (const [permissions, expected] of [
      [[], common],
      [["projects:read"], [...common, ...projectFeatures]],
      [["knowledge:read"], [...common, "company-knowledge", "agent-profiles"]],
      [["projects:read", "knowledge:read"], [...common, ...projectFeatures, "company-knowledge", "agent-profiles", "project-chat", "project-analytics"]],
    ]) {
      await grants(permissions!);
      suggestedKeys = [];
      const answer = (await request(messagePath, { id: crypto.randomUUID(), body: "Welche Bereiche kann ich öffnen?" })).body.data.message;
      expect(answer.status).toBe("completed");
      expect(captured.context.availableFeatures.sort()).toEqual(expected!.slice().sort());
      expect(Object.keys(captured.context.navigation).sort()).toEqual(expected!.slice().sort());
      expect(Object.keys(captured.context.featureDescriptions).sort()).toEqual(expected!.slice().sort());
    }
    await grants(["projects:read"]);
    for (const forbidden of ["project-chat", "project-analytics", "company-knowledge", "agent-profiles", "customers", "components"]) {
      suggestedKeys = [forbidden];
      const answer = (await request(messagePath, { id: crypto.randomUUID(), body: "Open the requested view", projectId })).body.data.message;
      expect(captured.context.availableFeatures).not.toContain(forbidden);
      expect(answer.status).toBe("failed");
      expect(answer.sources).toEqual([]);
    }
    expect((await request("/support/reports")).body.data.items).toEqual([]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.query("DELETE FROM support_messages WHERE conversation_id IN (SELECT id FROM support_conversations WHERE tenant_id=$1)", [tenant]);
    for (const table of ["support_conversations", "projects_projects", "os_audit_events", "os_ai_connections", "os_memberships"]) await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
    await pool.query("DELETE FROM os_role_permissions WHERE role_id=$1", [role]);
    await pool.query("DELETE FROM os_roles WHERE id=$1", [role]);
    await pool.query("DELETE FROM os_tenants WHERE id=$1", [tenant]);
    await pool.query("DELETE FROM auth_session WHERE user_id=$1", [user]);
    await pool.query("DELETE FROM auth_user WHERE id=$1", [user]);
    await pool.query("DELETE FROM os_users WHERE id=$1", [user]);
    await pool.end();
  }
}, 30000);
