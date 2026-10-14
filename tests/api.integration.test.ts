import { describe, expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { createApp } from "../richtfest-os/apps/api/src/server";
import { withProviderCredential } from "../richtfest-os/apps/api/src/ai-connections";
import { env } from "../richtfest-os/apps/api/src/env";
import { fileStorage } from "../richtfest-os/apps/api/src/app-hosts";
import { startSourceExtractionWorker } from "../richtfest-apps/projects/src/source-extraction";
import { startArtifactPdfWorker } from "../richtfest-apps/knowledge/src/artifact-pdf-exports";
import { backgroundKnowledgeDeps } from "../richtfest-os/apps/api/src/supervisor-worker";

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? test : test.skip;

test("TypeSafe server fallback requires no encryption but never overrides an invalid scoped credential", async () => {
  const previousServerKey = env.TYPESAFE_API_KEY;
  const previousEncryptionKey = env.AI_CONNECTION_ENCRYPTION_KEY;
  let rows: any[] = [];
  const db = { select: () => ({ from: () => ({ where: async () => rows }) }) } as any;
  let uses = 0;
  const use = async (key: string) => { uses++; return key; };
  try {
    env.TYPESAFE_API_KEY = "typesafe-server-fixture";
    env.AI_CONNECTION_ENCRYPTION_KEY = undefined;
    expect(await withProviderCredential(db, "tenant", "user", "typesafe", use)).toBe("typesafe-server-fixture");
    expect(await withProviderCredential(db, "tenant", "user", "openai", use)).toBeNull();
    rows = [{ userId: "another-user" }];
    expect(await withProviderCredential(db, "tenant", "user", "typesafe", use)).toBe("typesafe-server-fixture");
    for (const userId of ["user", null]) {
      rows = [{ userId, ciphertext: "invalid", iv: "invalid", authTag: "invalid" }];
      await expect(withProviderCredential(db, "tenant", "user", "typesafe", use)).rejects.toThrow();
      env.AI_CONNECTION_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
      await expect(withProviderCredential(db, "tenant", "user", "typesafe", use)).rejects.toThrow();
      env.AI_CONNECTION_ENCRYPTION_KEY = undefined;
    }
    expect(uses).toBe(2);
    rows = [];
    env.TYPESAFE_API_KEY = undefined;
    expect(await withProviderCredential(db, "tenant", "user", "typesafe", use)).toBeNull();
  } finally {
    env.TYPESAFE_API_KEY = previousServerKey;
    env.AI_CONNECTION_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

run("account settings remain readable for older sessions and password enrollment requires fresh verification", async () => {
  const { db, pool } = createDatabase(databaseUrl!);
  const userId = crypto.randomUUID();
  const email = `security-${userId}@richtfest.local`;
  const server = createApp(db, { allowDevAuth: true }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = "";
  const request = (path: string, body?: unknown) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json", origin: "http://localhost:5173" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    await pool.query("insert into os_users(id, email, name) values ($1, $2, 'Security test')", [userId, email]);
    await pool.query("insert into auth_user(id, email, name, email_verified) values ($1, $2, 'Security test', true)", [userId, email]);
    await pool.query(`insert into os_memberships(tenant_id, user_id, role_id, status)
      select m.tenant_id, $1, m.role_id, 'active' from os_memberships m
      join os_users u on u.id = m.user_id where u.email = 'andreas@richtfest.local'`, [userId]);
    expect((await request("/api/account/security")).status).toBe(401);
    const login = await request("/api/auth/dev-login", { email });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    const fresh = await request("/api/account/security");
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).data).toMatchObject({ emailVerified: true, recentlyVerified: true, passwordConfigured: false });

    await pool.query("update auth_session set created_at = now() - interval '2 days' where user_id = $1", [userId]);
    const old = await request("/api/account/security");
    expect(old.status).toBe(200);
    expect((await old.json()).data).toMatchObject({ emailVerified: true, recentlyVerified: false, passwordConfigured: false });
    const sessions = await request("/api/auth/list-sessions");
    expect(sessions.status).toBe(403);
    expect((await sessions.json()).code).toBe("SESSION_NOT_FRESH");
    const staleEnrollment = await request("/api/account/security/password", { newPassword: "Test-only-password-42" });
    expect(staleEnrollment.status).toBe(403);
    expect((await staleEnrollment.json()).error.code).toBe("recent_session_required");

    await pool.query("update auth_session set created_at = now() where user_id = $1", [userId]);
    const invalid = await request("/api/account/security/password", { newPassword: "x".repeat(129) });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("PASSWORD_TOO_LONG");
    const password = `Test-only-password-${userId}`;
    expect((await request("/api/account/security/password", { newPassword: password })).status).toBe(200);
    expect((await (await request("/api/account/security")).json()).data.passwordConfigured).toBe(true);
    expect((await request("/api/account/security/password", { newPassword: password })).status).toBe(409);
    cookie = "";
    expect((await request("/api/auth/sign-in/email", { email, password })).status).toBe(200);
  } finally {
    server.close();
    await pool.query("delete from auth_session where user_id = $1", [userId]);
    await pool.query("delete from auth_account where user_id = $1", [userId]);
    await pool.query("delete from os_memberships where user_id = $1", [userId]);
    await pool.query("delete from auth_user where id = $1", [userId]);
    await pool.query("delete from os_users where id = $1", [userId]);
    await pool.end();
  }
});

describe("accepted API workflow (PostgreSQL)", () => {
  run(
    "creates and reads tenant-scoped customer, project, file, knowledge and approval records",
    async () => {
      const { db, pool } = createDatabase(databaseUrl!);
      const extractionWorker = startSourceExtractionWorker({ db, fileStorage, audit: async () => {}, reportError: () => { throw new Error("Extraction worker failed"); } });
      const providerRequests: any[] = [];
      let providerMode = "success";
      const server = createApp(db, {
        allowDevAuth: true,
        providerFetch: async (_url, init) => {
          providerRequests.push(JSON.parse(String(init.body)));
          if (providerMode === "failure")
            return new Response("upstream secret sk-do-not-store", {
              status: 500,
            });
          const prompt = JSON.parse(
            providerRequests.at(-1).input ??
              providerRequests.at(-1).messages[0].content,
          );
          const inventorySource = prompt.context.sourceInventory?.sources?.find(
            (source: any) => source.name === "plan.txt",
          );
          const resolvedSourceId =
            prompt.toolResults?.[0]?.result?.source?.versionId;
          const output =
            providerMode === "discover" || providerMode === "repeat"
              ? prompt.toolResults?.length
                ? {
                    summary: "The project source was read and is ready for review.",
                    rationale: "The exact immutable version was resolved.",
                    citations: resolvedSourceId ? [resolvedSourceId] : [],
                    tools: [],
                    artifact: null,
                  }
                : {
                    summary: "Resolving the relevant project source.",
                    rationale: "The project inventory identifies the source.",
                    citations: [],
                    tools: Array.from({ length: providerMode === "repeat" ? 2 : 1 }, () => ({
                        name: "resolve_project_source",
                        input: { versionId: providerMode === "repeat" ? prompt.context.sourceVersionIds[0] : inventorySource?.versionId },
                      })),
                    artifact: null,
                  }
              : {
                  summary: "The immutable source excerpt is ready for review.",
                  rationale: "Review uses the selected source version.",
                  citations: prompt.context.sourceVersionIds,
                  tools:
                    providerMode === "forbidden"
                      ? [{ name: "fetch_url", input: { url: "https://example.com" } }]
                      : [],
                  artifact: {
                    title: "Proposed source review",
                    content:
                      "The source says ISO-IFC-SOURCE. This is a proposed note requiring review.",
                    type: "draft",
                  },
                };
          return Response.json({
            id: "fixture-response",
            model: "gpt-4.1-mini-2025-04-14",
            usage: { input_tokens: 123, output_tokens: 37, output_tokens_details: { reasoning_tokens: 11 } },
            output: [
              {
                type: "message",
                content: [
                  { type: "output_text", text: JSON.stringify(output) },
                ],
              },
            ],
            content: [{ type: "text", text: JSON.stringify(output) }],
          });
        },
      }).listen(0);
      const address = server.address() as { port: number };
      const base = `http://127.0.0.1:${address.port}`;
      // Keep this run's persisted authentication rate limits separate from other test runs.
      const clientIp = `127.${Array.from(crypto.getRandomValues(new Uint8Array(3))).join(".")}`;
      const request = async (
        path: string,
        init: RequestInit = {},
        cookie?: string,
      ) => {
        const headers = new Headers(init.headers);
        headers.set("content-type", "application/json");
        headers.set("x-forwarded-for", clientIp);
        if (cookie) headers.set("cookie", cookie);
        const response = await fetch(base + path, { ...init, headers });
        const body = await response.json();
        return {
          response,
          body,
          cookie: response.headers.get("set-cookie")?.split(";")[0],
        };
      };
      const upload = async (projectId: string, cookie: string) => {
        const initiated = await request(
          `/api/projects/${projectId}/files/initiate`,
          {
            method: "POST",
            body: JSON.stringify({
              name: "plan.txt",
              mimeType: "text/plain",
              sizeBytes: 14,
              sourceMetadata: { source: "integration" },
            }),
          },
          cookie,
        );
        expect(initiated.response.status).toBe(201);
        const uploadResponse = await fetch(
          base + initiated.body.data.uploadUrl,
          {
            method: "PUT",
            headers: { cookie, "content-type": "text/plain" },
            body: "ISO-IFC-SOURCE",
          },
        );
        expect(uploadResponse.status).toBe(200);
        const completed = await request(
          initiated.body.data.completeUrl,
          { method: "POST", body: "{}" },
          cookie,
        );
        completed.body.data.versionId = initiated.body.data.versionId;
        return completed;
      };
      const login = async (email: string) => {
        const requested = await request("/api/auth/sign-in/magic-link", {
          method: "POST",
          body: JSON.stringify({ email, callbackURL: "/" }),
        });
        expect(requested.response.status).toBe(200);
        const outbox = (
          await pool.query(
            "select url from os_auth_dev_outbox where email = $1 order by created_at desc limit 1",
            [email],
          )
        ).rows[0] as { url?: string } | undefined;
        expect(outbox?.url).toBeTruthy();
        const issued = new URL(outbox!.url!);
        const verified = await fetch(base + issued.pathname + issued.search, {
          redirect: "manual",
          headers: { "x-forwarded-for": clientIp },
        });
        expect(verified.status).toBe(302);
        return verified.headers.get("set-cookie")?.split(";")[0] ?? "";
      };
      const cookie = await login("andreas@richtfest.local");
      expect(cookie).toContain("better-auth.session_token");
      const customerDetails = {
        name: `Integration customer ${Date.now()}`,
        email: "office@example.com", phone: "+49 30 12345",
        street: "Planstraße 8, Haus B", postalCode: "01234", city: "Dresden", country: "Deutschland",
        billingName: "Planung Holding GmbH", billingStreet: "Kontorweg 42",
        billingPostalCode: "10115", billingCity: "Berlin", billingCountry: "Deutschland",
        invoiceEmail: "invoices@example.com", vatId: "DE123456789", taxNumber: "12/345/67890",
        paymentTerms: "30 days net", notes: "Include purchase order reference",
      };
      const customer = await request(
        "/api/crm/customers",
        {
          method: "POST",
          body: JSON.stringify(customerDetails),
        },
        cookie,
      );
      expect(customer.response.status).toBe(201);
      expect(customer.body.data).toMatchObject(customerDetails);
      const customerPath = `/api/crm/customers/${customer.body.data.id}`;
      const patchedCustomer = await request(customerPath, {
        method: "PATCH", body: JSON.stringify({ city: "Leipzig", invoiceEmail: "", phone: null }),
      }, cookie);
      expect(patchedCustomer.response.status).toBe(200);
      expect(patchedCustomer.body.data).toMatchObject({ ...customerDetails, city: "Leipzig", invoiceEmail: null, phone: null });
      const customerList = await request("/api/crm/customers", {}, cookie);
      expect(customerList.body.data.find((row: any) => row.id === customer.body.data.id)).toMatchObject({
        ...customerDetails, city: "Leipzig", invoiceEmail: null, phone: null,
      });
      for (const invalid of [{ invoiceEmail: "not-an-email" }, { name: " " }, { paymentTerms: "x".repeat(501) }, {}]) {
        expect((await request(customerPath, { method: "PATCH", body: JSON.stringify(invalid) }, cookie)).response.status).toBe(400);
      }
      const minimalCustomer = await request("/api/crm/customers", {
        method: "POST", body: JSON.stringify({ name: `Name only ${Date.now()}` }),
      }, cookie);
      expect(minimalCustomer.response.status).toBe(201);
      expect(minimalCustomer.body.data.billingStreet).toBeNull();
      const customerAudit = await pool.query("select metadata from os_audit_events where action = 'crm.customer.updated' and entity_id = $1", [customer.body.data.id]);
      expect(customerAudit.rows).toHaveLength(1);
      expect(customerAudit.rows[0].metadata.fields.sort()).toEqual(["city", "invoiceEmail", "phone"]);
      expect(JSON.stringify(customerAudit.rows)).not.toContain("Leipzig");
      const project = await request(
        "/api/projects",
        {
          method: "POST",
          body: JSON.stringify({
            name: `Integration project ${Date.now()}`,
            customerId: customer.body.data.id,
          }),
        },
        cookie,
      );
      expect(project.response.status).toBe(201);
      const file = await upload(project.body.data.id, cookie);
      expect(file.response.status).toBe(200);
      expect(file.body.data.sizeBytes).toBeGreaterThan(0);
      expect(file.body.data.downloadUrl).toContain("/download");
      const conversation = await request(
        "/api/knowledge/conversations",
        {
          method: "POST",
          body: JSON.stringify({
            title: "Jour fixe",
            projectId: project.body.data.id,
          }),
        },
        cookie,
      );
      expect(conversation.response.status).toBe(201);
      const message = await request(
        `/api/knowledge/conversations/${conversation.body.data.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            body: "Use the source plan",
            sourceRef: "drive://plan.txt",
          }),
        },
        cookie,
      );
      expect(message.response.status).toBe(201);
      const conversationId = conversation.body.data.id;
      const projectId = project.body.data.id;
      const versionId = file.body.data.versionId;
      const secondMessage = await request(
        `/api/knowledge/conversations/${conversationId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            body: "Follow-up exact version",
            parentMessageId: message.body.data.id,
            sourceVersionIds: [versionId],
          }),
        },
        cookie,
      );
      expect(secondMessage.response.status).toBe(201);
      const paged = await request(
        `/api/knowledge/conversations/${conversationId}/messages?limit=1`,
        {},
        cookie,
      );
      expect(paged.body.data.items).toHaveLength(1);
      expect(paged.body.data.nextCursor).toBe(secondMessage.body.data.id);
      const older = await request(
        `/api/knowledge/conversations/${conversationId}/messages?before=${paged.body.data.nextCursor}&limit=1`,
        {},
        cookie,
      );
      expect(older.body.data.items[0].id).toBe(message.body.data.id);
      const searched = await request(
        `/api/knowledge/conversations/${conversationId}/messages?q=Follow-up`,
        {},
        cookie,
      );
      expect(searched.body.data.items).toHaveLength(1);
      const direct = await request(
        `/api/knowledge/conversations/${conversationId}/messages/${message.body.data.id}`,
        {},
        cookie,
      );
      expect(direct.body.data.id).toBe(message.body.data.id);
      const read = await request(
        `/api/knowledge/conversations/${conversationId}/read`,
        {
          method: "PUT",
          body: JSON.stringify({
            lastReadMessageId: secondMessage.body.data.id,
            meaningfulMessageId: message.body.data.id,
            composerDraft: "Keep this draft",
          }),
        },
        cookie,
      );
      expect(read.response.status).toBe(200);
      const restored = await request(
        `/api/knowledge/conversations/${conversationId}/messages`,
        {},
        cookie,
      );
      expect(restored.body.data.readState.meaningfulMessageId).toBe(
        message.body.data.id,
      );
      expect(restored.body.data.readState.composerDraft).toBe(
        "Keep this draft",
      );
      const artifact = await request(
        "/api/knowledge/artifacts",
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            title: "Review note",
            type: "document",
            content: "Revision one",
            sourceVersionIds: [versionId],
          }),
        },
        cookie,
      );
      expect(artifact.response.status).toBe(201);
      const revision = await request(
        `/api/knowledge/artifacts/${artifact.body.data.artifact.id}/revisions`,
        {
          method: "POST",
          body: JSON.stringify({
            title: "Review note",
            content: "Revision two",
            sourceVersionIds: [versionId],
          }),
        },
        cookie,
      );
      expect(revision.body.data.version).toBe(2);
      const staleReview = await request(
        `/api/knowledge/artifacts/${artifact.body.data.artifact.id}/review`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedRevisionId: artifact.body.data.revision.id,
          }),
        },
        cookie,
      );
      expect(staleReview.response.status).toBe(409);
      const foreignProjectForReview = await request(
        "/api/projects",
        {
          method: "POST",
          body: JSON.stringify({ name: `Review boundary ${Date.now()}` }),
        },
        cookie,
      );
      const foreignArtifact = await request(
        "/api/knowledge/artifacts",
        {
          method: "POST",
          body: JSON.stringify({
            projectId: foreignProjectForReview.body.data.id,
            title: "Different project finding",
            type: "document",
            content: "Must not approve the other artifact",
            sourceVersionIds: [],
          }),
        },
        cookie,
      );
      const crossProjectReview = await request(
        `/api/knowledge/artifacts/${artifact.body.data.artifact.id}/review`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedRevisionId: foreignArtifact.body.data.revision.id,
          }),
        },
        cookie,
      );
      expect(crossProjectReview.response.status).toBe(409);
      const reviewedArtifact = await request(
        `/api/knowledge/artifacts/${artifact.body.data.artifact.id}/review`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevisionId: revision.body.data.id }),
        },
        cookie,
      );
      expect(reviewedArtifact.response.status).toBe(200);
      expect(reviewedArtifact.body.data.artifact.status).toBe("approved");
      expect(reviewedArtifact.body.data.reviewedKnowledge.status).toBe(
        "approved",
      );
      expect(
        reviewedArtifact.body.data.reviewedKnowledge.sourceRefs[0],
      ).toEqual({
        kind: "source_version",
        sourceVersionId: versionId,
        artifactId: artifact.body.data.artifact.id,
        artifactRevisionId: revision.body.data.id,
      });
      const foreignDraft = await request(
        "/api/knowledge/drafts",
        {
          method: "POST",
          body: JSON.stringify({
            title: "Different project draft",
            body: "Must stay outside this project's reviewed knowledge.",
            projectId: foreignProjectForReview.body.data.id,
            sourceRefs: [],
          }),
        },
        cookie,
      );
      expect(foreignDraft.response.status).toBe(201);
      const projectKnowledge = await request(
        `/api/knowledge/drafts?projectId=${projectId}`,
        {},
        cookie,
      );
      expect(
        projectKnowledge.body.data.some(
          (item: any) =>
            item.id === reviewedArtifact.body.data.reviewedKnowledge.id,
        ),
      ).toBe(true);
      expect(
        projectKnowledge.body.data.some(
          (item: any) => item.id === foreignDraft.body.data.id,
        ),
      ).toBe(false);
      const repeatedReview = await request(
        `/api/knowledge/artifacts/${artifact.body.data.artifact.id}/review`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevisionId: revision.body.data.id }),
        },
        cookie,
      );
      expect(repeatedReview.response.status).toBe(409);
      const annotation = await request(
        "/api/knowledge/annotations",
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            artifactRevisionId: artifact.body.data.revision.id,
            page: 1,
            quote: "Revision one",
            body: "Review this selection",
            conversationId,
          }),
        },
        cookie,
      );
      expect(annotation.response.status).toBe(201);
      expect(annotation.body.data.message.annotationId).toBe(
        annotation.body.data.annotation.id,
      );
      const annotatedArtifact = await request(
        `/api/knowledge/artifacts/${artifact.body.data.artifact.id}`,
        {},
        cookie,
      );
      expect(annotatedArtifact.body.data.revisions).toHaveLength(2);
      expect(
        annotatedArtifact.body.data.annotations[0].artifactRevisionId,
      ).toBe(artifact.body.data.revision.id);
      const newVersion = await request(
        `/api/projects/${projectId}/files/${file.body.data.id}/versions/initiate`,
        {
          method: "POST",
          body: JSON.stringify({
            mimeType: "text/plain",
            sizeBytes: 11,
            sourceMetadata: { source: "revision" },
          }),
        },
        cookie,
      );
      expect(newVersion.response.status).toBe(201);
      expect(newVersion.body.data.version).toBe(2);
      expect(newVersion.body.data.versionId).not.toBe(versionId);
      expect(
        (
          await fetch(base + newVersion.body.data.uploadUrl, {
            method: "PUT",
            headers: { cookie, "content-type": "text/plain" },
            body: "VERSION-TWO",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            newVersion.body.data.completeUrl,
            { method: "POST", body: "{}" },
            cookie,
          )
        ).response.status,
      ).toBe(200);
      expect(
        await (
          await fetch(base + file.body.data.downloadUrl, {
            headers: { cookie },
          })
        ).text(),
      ).toBe("ISO-IFC-SOURCE");
      expect(
        await (
          await fetch(
            base +
              `/api/projects/${projectId}/files/${file.body.data.id}/versions/2/download`,
            { headers: { cookie } },
          )
        ).text(),
      ).toBe("VERSION-TWO");
      const unavailable = await request(
        "/api/knowledge/runs",
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            conversationId,
            goal: "Calculate external sound insulation",
            provider: "openai",
            intent: "calculation",
          }),
        },
        cookie,
      );
      expect(unavailable.body.data.status).toBe("validated_tool_unavailable");
      const deniedApproval = await request(
        `/api/knowledge/runs/${unavailable.body.data.id}/approve`,
        { method: "POST", body: JSON.stringify({ decision: "approved" }) },
        cookie,
      );
      expect(deniedApproval.response.status).toBe(409);
      const otherProject = await request(
        "/api/projects",
        { method: "POST", body: JSON.stringify({ name: "Other project" }) },
        cookie,
      );
      const crossProject = await request(
        "/api/knowledge/runs",
        {
          method: "POST",
          body: JSON.stringify({
            projectId: otherProject.body.data.id,
            conversationId,
            goal: "Review",
            provider: "openai",
          }),
        },
        cookie,
      );
      expect(crossProject.response.status).toBe(404);
      const crossSource = await request(
        "/api/knowledge/annotations",
        {
          method: "POST",
          body: JSON.stringify({
            projectId: otherProject.body.data.id,
            sourceVersionId: versionId,
            body: "Wrong project",
          }),
        },
        cookie,
      );
      expect(crossSource.response.status).toBe(404);
      const task = await request(
        "/api/knowledge/tasks",
        {
          method: "POST",
          body: JSON.stringify({
            title: "Verify source plan",
            conversationId: conversation.body.data.id,
          }),
        },
        cookie,
      );
      expect(task.response.status).toBe(201);
      const draft = await request(
        "/api/knowledge/drafts",
        {
          method: "POST",
          body: JSON.stringify({
            title: "Manual source note",
            body: "Review the IFC source.",
            projectId: project.body.data.id,
            sourceRefs: [file.body.data.id],
          }),
        },
        cookie,
      );
      expect(draft.response.status).toBe(201);
      const approved = await request(
        `/api/knowledge/drafts/${draft.body.data.id}/approve`,
        { method: "POST", body: "{}" },
        cookie,
      );
      expect(approved.response.status).toBe(200);
      expect(approved.body.data.status).toBe("approved");
      const lucaCookie = await login("luca@richtfest.local");
      const lucaDrafts = await request(
        `/api/knowledge/drafts?projectId=${project.body.data.id}`,
        {},
        lucaCookie,
      );
      expect(lucaDrafts.response.status).toBe(200);
      expect(
        lucaDrafts.body.data.some(
          (item: any) =>
            item.id === draft.body.data.id && item.status === "approved",
        ),
      ).toBe(true);
      const company = await request("/api/knowledge/drafts", {
        method: "POST", body: JSON.stringify({ title: "Company procedure", body: "## Evidence\n\nCheck the source before approval." }),
      }, cookie);
      expect(company.response.status).toBe(201);
      const companyPath = `/api/knowledge/drafts/${company.body.data.id}`;
      const companyList = await request("/api/knowledge/drafts?scope=company", {}, cookie);
      expect(companyList.response.status).toBe(200);
      expect(companyList.body.data.find((row: any) => row.id === company.body.data.id)).toMatchObject({ title: "Company procedure", status: "draft" });
      expect(companyList.body.data.some((row: any) => row.id === draft.body.data.id)).toBe(false);
      expect(companyList.body.data.every((row: any) => !("body" in row))).toBe(true);
      expect((await request(`${companyPath}`, {}, cookie)).body.data).toMatchObject({ body: company.body.data.body, projectId: null, canApprove: true });
      expect((await request(`/api/knowledge/drafts?scope=company&projectId=${project.body.data.id}`, {}, cookie)).response.status).toBe(400);
      expect((await request(`/api/knowledge/drafts?projectId=${project.body.data.id}`, {}, cookie)).body.data.some((row: any) => row.id === company.body.data.id)).toBe(false);
      expect((await request(`${companyPath}/approve`, { method: "POST", body: "{}" }, cookie)).response.status).toBe(200);
      expect((await request(companyPath, {}, cookie)).body.data.status).toBe("approved");
      expect((await request("/api/knowledge/drafts?scope=company", {}, cookie)).body.data.find((row: any) => row.id === company.body.data.id).status).toBe("approved");
      expect((await pool.query("select id from os_audit_events where action = 'knowledge.draft.approved' and entity_id = $1", [company.body.data.id])).rows).toHaveLength(1);
      const outsiderCookie = await login("outsider@other.local");
      await pool.query("insert into os_role_permissions (role_id, permission) select r.id, 'richtfest-os:use' from os_roles r join os_tenants t on t.id = r.tenant_id where t.name = 'Outsider' on conflict do nothing");
      expect((await request(customerPath, { method: "PATCH", body: JSON.stringify({ name: "Forbidden" }) }, outsiderCookie)).response.status).toBe(403);
      // Give the other tenant read/write access to test isolation independently of permissions.
      await pool.query("insert into os_role_permissions (role_id, permission) select r.id, p.key from os_roles r join os_tenants t on t.id = r.tenant_id cross join os_permissions p where t.name = 'Outsider' and p.key in ('crm:read', 'crm:write', 'knowledge:read', 'knowledge:write') on conflict do nothing");
      try {
        expect((await request(companyPath, {}, outsiderCookie)).response.status).toBe(404);
        expect((await request("/api/knowledge/drafts?scope=company", {}, outsiderCookie)).body.data.some((row: any) => row.id === company.body.data.id)).toBe(false);
        const outsiderDraft = await request("/api/knowledge/drafts", {
          method: "POST", body: JSON.stringify({ title: "Other company", body: "Not shared across tenants." }),
        }, outsiderCookie);
        expect(outsiderDraft.response.status).toBe(201);
        const outsiderDraftPath = `/api/knowledge/drafts/${outsiderDraft.body.data.id}`;
        expect((await request(outsiderDraftPath, {}, outsiderCookie)).body.data.canApprove).toBe(false);
        expect((await request(`${outsiderDraftPath}/approve`, { method: "POST", body: "{}" }, outsiderCookie)).response.status).toBe(403);
        expect((await request(outsiderDraftPath, {}, cookie)).response.status).toBe(404);
        expect((await request(customerPath, { method: "PATCH", body: JSON.stringify({ name: "Wrong tenant" }) }, outsiderCookie)).response.status).toBe(404);
        const otherCustomers = await request("/api/crm/customers", {}, outsiderCookie);
        expect(otherCustomers.response.status).toBe(200);
        expect(otherCustomers.body.data.some((row: any) => row.id === customer.body.data.id)).toBe(false);
        expect((await request("/api/crm/customers", {}, cookie)).body.data.find((row: any) => row.id === customer.body.data.id).name).toBe(customerDetails.name);
      } finally {
        await pool.query("delete from os_role_permissions where role_id in (select r.id from os_roles r join os_tenants t on t.id = r.tenant_id where t.name = 'Outsider') and permission in ('crm:read', 'crm:write', 'knowledge:read', 'knowledge:write', 'richtfest-os:use')");
      }
      const outsiderProject = await request(
        `/api/projects/${project.body.data.id}`,
        {},
        outsiderCookie,
      );
      expect([403, 404]).toContain(outsiderProject.response.status);
      const outsiderReview = await request(
        `/api/knowledge/artifacts/${artifact.body.data.artifact.id}/review`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevisionId: revision.body.data.id }),
        },
        outsiderCookie,
      );
      expect([403, 404]).toContain(outsiderReview.response.status);
      for (const path of [
        `/api/knowledge/workspaces/${projectId}`,
        `/api/knowledge/conversations/${conversationId}/messages`,
        `/api/knowledge/artifacts/${artifact.body.data.artifact.id}`,
        `/api/knowledge/artifacts/${artifact.body.data.artifact.id}/revisions/${revision.body.data.id}/pdf`,
      ])
        expect([403, 404]).toContain(
          (await request(path, {}, outsiderCookie)).response.status,
        );
      const settingsBefore = await request(
        "/api/settings/ai-connections",
        {},
        cookie,
      );
      expect(settingsBefore.response.status).toBe(200);
      expect(settingsBefore.body.data.providers.some((p: any) => p.provider === "typesafe")).toBe(true);
      for (const provider of settingsBefore.body.data.providers)
        expect(provider.server).toEqual({ configured: provider.provider === "typesafe" && Boolean(env.TYPESAFE_API_KEY) });
      if (process.env.AI_CONNECTION_ENCRYPTION_KEY) {
        const decisionWorkspace = { apiKey: "typesafe-test-workspace-secret" };
        const decisionPersonal = { apiKey: "typesafe-test-personal-secret" };
        const saveDecision = (scope: string, value: unknown, session = cookie) => request(
          `/api/settings/ai-connections/typesafe/${scope}`,
          { method: "PUT", body: JSON.stringify(value) }, session);
        for (const apiKey of [undefined, "short", " ", "a".repeat(501)])
          expect((await saveDecision("workspace", { apiKey })).response.status).toBe(400);
        expect((await saveDecision("workspace", decisionWorkspace, outsiderCookie)).response.status).toBe(403);
        expect((await saveDecision("workspace", decisionWorkspace)).response.status).toBe(200);
        expect((await saveDecision("personal", { apiKey: ` ${decisionPersonal.apiKey} ` }, lucaCookie)).response.status).toBe(200);
        expect((await request("/api/agent/settings", {
          method: "PUT", body: JSON.stringify({ provider: "typesafe" }),
        }, cookie)).response.status).toBe(400);
        const decisionSettings = await request("/api/settings/ai-connections", {}, lucaCookie);
        expect(decisionSettings.body.data.providers.find((p: any) => p.provider === "typesafe")).toMatchObject({
          personal: { configured: true }, workspace: { configured: true }, effectiveSource: "personal",
          server: { configured: Boolean(env.TYPESAFE_API_KEY) },
        });
        await pool.query("insert into os_role_permissions (role_id, permission) select r.id, 'richtfest-os:use' from os_roles r join os_tenants t on t.id=r.tenant_id where t.name='Outsider' on conflict do nothing");
        try {
          const outsiderDecision = await request("/api/settings/ai-connections", {}, outsiderCookie);
          expect(outsiderDecision.response.status).toBe(200);
          expect(outsiderDecision.body.data.providers.find((p: any) => p.provider === "typesafe")).toMatchObject({
            personal: { configured: false }, workspace: { configured: false },
            server: { configured: Boolean(env.TYPESAFE_API_KEY) }, effectiveSource: env.TYPESAFE_API_KEY ? "server" : null,
          });
        } finally {
          await pool.query("delete from os_role_permissions where role_id in (select r.id from os_roles r join os_tenants t on t.id=r.tenant_id where t.name='Outsider') and permission='richtfest-os:use'");
        }
        for (const value of [decisionWorkspace.apiKey, decisionPersonal.apiKey, env.TYPESAFE_API_KEY].filter(Boolean))
          expect(JSON.stringify(decisionSettings.body)).not.toContain(value!);
        const storedDecision = await pool.query("select c.tenant_id, c.user_id, c.ciphertext, c.iv, c.auth_tag from os_ai_connections c join os_users u on u.id=c.user_id where c.provider='typesafe' and u.email=$1", ["luca@richtfest.local"]);
        const personalDecision = storedDecision.rows.find((row: any) => row.user_id !== null);
        expect(personalDecision).toBeDefined();
        expect(JSON.stringify(storedDecision.rows)).not.toContain(decisionPersonal.apiKey);
        const useDecision = (userId: string) => withProviderCredential(db, personalDecision.tenant_id, userId, "typesafe", async value => value);
        expect(await useDecision(personalDecision.user_id)).toBe(decisionPersonal.apiKey);
        expect(await useDecision(crypto.randomUUID())).toBe(decisionWorkspace.apiKey);
        await expect(withProviderCredential(db, personalDecision.tenant_id, personalDecision.user_id, "typesafe",
          async () => { throw new Error("Scoped credential rejected"); })).rejects.toThrow("Scoped credential rejected");
        expect((await request("/api/settings/ai-connections/typesafe/personal", { method: "DELETE" }, lucaCookie)).response.status).toBe(200);
        expect(await useDecision(personalDecision.user_id)).toBe(decisionWorkspace.apiKey);
        expect((await request("/api/settings/ai-connections/typesafe/workspace", { method: "DELETE" }, cookie)).response.status).toBe(200);
        expect(await useDecision(personalDecision.user_id)).toBe(env.TYPESAFE_API_KEY ?? null);
        const decisionRemoved = await request("/api/settings/ai-connections", {}, lucaCookie);
        expect(decisionRemoved.body.data.providers.find((p: any) => p.provider === "typesafe").effectiveSource)
          .toBe(env.TYPESAFE_API_KEY ? "server" : null);
        const workspace = await request(
          "/api/settings/ai-connections/openai/workspace",
          {
            method: "PUT",
            body: JSON.stringify({ apiKey: "sk-test-workspace-secret" }),
          },
          cookie,
        );
        expect(workspace.response.status).toBe(200);
        const settingsAfter = await request(
          "/api/settings/ai-connections",
          {},
          cookie,
        );
        expect(JSON.stringify(settingsAfter.body)).not.toContain(
          "sk-test-workspace-secret",
        );
        expect(
          settingsAfter.body.data.providers.find(
            (p: any) => p.provider === "openai",
          ).effectiveSource,
        ).toBe("workspace");
        const personal = await request(
          "/api/settings/ai-connections/anthropic/personal",
          {
            method: "PUT",
            body: JSON.stringify({ apiKey: "sk-test-personal-secret" }),
          },
          lucaCookie,
        );
        expect(personal.response.status).toBe(200);
        const lucaSettings = await request(
          "/api/settings/ai-connections",
          {},
          lucaCookie,
        );
        expect(
          lucaSettings.body.data.providers.find(
            (p: any) => p.provider === "anthropic",
          ).effectiveSource,
        ).toBe("personal");
        const outsiderWorkspace = await request(
          "/api/settings/ai-connections/openai/workspace",
          {
            method: "PUT",
            body: JSON.stringify({ apiKey: "sk-outsider-secret" }),
          },
          outsiderCookie,
        );
        expect(outsiderWorkspace.response.status).toBe(403);
        const ready = await request(
          "/api/agent/readiness?provider=anthropic",
          {},
          lucaCookie,
        );
        expect(ready.response.status).toBe(200);
        expect(ready.body.data.credentialsConfigured).toBe(true);
        expect(ready.body.data.executionAvailable).toBe(true);
        const run = await request(
          "/api/agent/run",
          { method: "POST", body: JSON.stringify({ provider: "anthropic" }) },
          lucaCookie,
        );
        expect(run.response.status).toBe(400);
        const runRequest = {
          projectId,
          conversationId,
          messageId: secondMessage.body.data.id,
          goal: "Review the selected source",
          provider: "openai",
          sourceVersionIds: [versionId],
        };
        const completedRun = async (mode: string) => {
          providerMode = mode;
          const started = await request(
            "/api/knowledge/runs",
            { method: "POST", body: JSON.stringify(runRequest) },
            cookie,
          );
          expect(started.response.status).toBe(201);
          let result: any;
          for (let i = 0; i < 100; i++) {
            result = await request(
              `/api/knowledge/runs/${started.body.data.id}`,
              {},
              cookie,
            );
            if (!["queued", "running"].includes(result.body.data.run.status))
              return result.body.data;
            await Bun.sleep(20);
          }
          throw new Error("Run did not finish");
        };
        const proposed = await completedRun("success");
        expect(proposed.run.status).toBe("needs_review");
        expect(proposed.artifacts).toHaveLength(1);
        expect(proposed.artifacts[0].status).toBe("draft");
        expect(proposed.attempts).toHaveLength(1);
        expect(proposed.attempts[0]).toMatchObject({ phase: "direct", attemptNumber: 1, status: "completed", usageStatus: "reported" });
        expect(proposed.attempts[0].settings).toMatchObject({ adapter: "direct", maxRetries: 0, timeoutMs: 180000 });
        expect(proposed.attempts[0].settings.promptHash).toMatch(/^[a-f0-9]{64}$/);
        expect(proposed.attempts[0].response.modelId).toBe("gpt-4.1-mini-2025-04-14");
        expect(proposed.usage.calls[0]).toMatchObject({ attemptId: proposed.attempts[0].id, inputTokens: 123, outputTokens: 37 });
        expect([403, 404]).toContain((await request(`/api/knowledge/runs/${proposed.run.id}`, {}, outsiderCookie)).response.status);
        expect(JSON.stringify(providerRequests)).toContain("ISO-IFC-SOURCE");
        expect(JSON.stringify(providerRequests)).not.toContain("VERSION-TWO");
        const repeated = await completedRun("repeat");
        expect(repeated.run.status).toBe("needs_review");
        const followup = JSON.parse(providerRequests.at(-1).input);
        expect(followup.context.sources).toHaveLength(0);
        expect(followup.toolResults).toHaveLength(1);
        expect(followup.toolResults[0].result.content.text).toBe("ISO-IFC-SOURCE");
        providerMode = "discover";
        const discoveryStart = providerRequests.length;
        const discoveryRun = await request(
          "/api/knowledge/runs",
          {
            method: "POST",
            body: JSON.stringify({
              ...runRequest,
              goal: "Inspect the relevant project data",
              sourceVersionIds: [],
            }),
          },
          cookie,
        );
        expect(discoveryRun.response.status).toBe(201);
        let discoveryResult: any;
        for (let i = 0; i < 100; i++) {
          discoveryResult = await request(
            `/api/knowledge/runs/${discoveryRun.body.data.id}`,
            {},
            cookie,
          );
          if (!['queued', 'running'].includes(discoveryResult.body.data.run.status))
            break;
          await Bun.sleep(20);
        }
        const discoveryRequests = providerRequests.slice(discoveryStart).map((body) =>
          JSON.parse(body.input ?? body.messages[0].content),
        );
        expect(discoveryRequests).toHaveLength(2);
        expect(discoveryRequests[0]!.context.sources).toEqual([]);
        expect(
          discoveryRequests[0]!.context.sourceInventory.sources[0],
        ).toMatchObject({
          name: "plan.txt",
          versionId: newVersion.body.data.versionId,
          version: 2,
        });
        expect(JSON.stringify(discoveryRequests[1]!.toolResults)).toContain(
          "VERSION-TWO",
        );
        expect(discoveryResult.body.data.run.status).toBe("needs_review");
        expect(discoveryResult.body.data.attempts.map((attempt: any) => attempt.phase)).toEqual(["direct", "tool_followup"]);
        const unread = await request(
          `/api/knowledge/workspaces/${projectId}`,
          {},
          cookie,
        );
        expect(
          unread.body.data.conversations.find(
            (c: any) => c.id === conversationId,
          ).unreadCount,
        ).toBeGreaterThan(0);
        const stream = await fetch(
          base + `/api/knowledge/runs/${proposed.run.id}/events/stream`,
          { headers: { cookie } },
        );
        expect(await stream.text()).toContain("event: activity");
        expect((await completedRun("forbidden")).run.status).toBe("failed");
        const failed = await completedRun("failure");
        expect(failed.run.status).toBe("failed");
        expect(failed.attempts).toHaveLength(1);
        expect(failed.attempts[0]).toMatchObject({ status: "failed", usageStatus: "missing", providerStatus: 500 });
        expect(failed.usage.calls).toHaveLength(0);
        expect(JSON.stringify(failed)).not.toContain("sk-do-not-store");
        for (const evaluation of [{ correctness: 0 }, { correctness: 6 }, { usefulness: 1.5 }, {}, { rework: "unknown" }]) {
          expect((await request(`/api/knowledge/runs/${proposed.run.id}/approve`, {
            method: "POST", body: JSON.stringify({ decision: "approved", evaluation }),
          }, cookie)).response.status).toBe(400);
        }
        expect([403, 404]).toContain((await request(`/api/knowledge/runs/${proposed.run.id}/approve`, {
          method: "POST", body: JSON.stringify({ decision: "approved", evaluation: { correctness: 5 } }),
        }, outsiderCookie)).response.status);
        const review = await request(
          `/api/knowledge/runs/${proposed.run.id}/approve`,
          { method: "POST", body: JSON.stringify({ decision: "approved", note: "Verified source", evaluation: { correctness: 5, completeness: 2, rework: "minor" } }) },
          cookie,
        );
        expect(review.body.data.run.status).toBe("approved");
        const reviewed = (await request(`/api/knowledge/runs/${proposed.run.id}`, {}, cookie)).body.data;
        expect(reviewed.approvals[0].evaluation).toEqual({ rubricVersion: 1, correctness: 5, completeness: 2, rework: "minor" });
        expect(reviewed.approvals[0].evaluatedOutput.summary).toBe(proposed.run.outputSummary);
        const originalRevision = (await pool.query("select id from knowledge_artifact_revisions where artifact_id=$1 and version=1", [proposed.artifacts[0].id])).rows[0].id;
        expect(reviewed.approvals[0].evaluatedOutput.artifactRevisionIds).toEqual([originalRevision]);
        const rejected = await request(`/api/knowledge/runs/${discoveryResult.body.data.run.id}/approve`, {
          method: "POST", body: JSON.stringify({ decision: "rejected", note: "Needs a usable draft", evaluation: { usefulness: 1, rework: "major" } }),
        }, cookie);
        expect(rejected.body.data.approval).toMatchObject({ note: "Needs a usable draft", evaluation: { usefulness: 1, rework: "major", rubricVersion: 1 } });
        const unscored = await completedRun("success");
        const unscoredReview = await request(`/api/knowledge/runs/${unscored.run.id}/approve`, {
          method: "POST", body: JSON.stringify({ decision: "approved" }),
        }, cookie);
        expect(unscoredReview.body.data.approval.evaluation).toBeNull();
        const audit = (
          await pool.query(
            "select actor_type, metadata from os_audit_events where run_id=$1",
            [proposed.run.id],
          )
        ).rows;
        expect(audit.some((r) => r.actor_type === "agent")).toBe(true);
        expect(JSON.stringify(audit)).not.toContain("sk-test-workspace-secret");
      } else {
        const save = await request(
          "/api/settings/ai-connections/openai/personal",
          { method: "PUT", body: JSON.stringify({ apiKey: "sk-test-secret" }) },
          cookie,
        );
        expect(save.response.status).toBe(503);
        expect(save.body.error.code).toBe("encryption_unconfigured");
      }
      const team = await request("/api/access/team", {}, cookie);
      expect(team.response.status).toBe(200);
      const invitedEmail = `invite-${Date.now()}@richtfest.local`;
      const invitation = await request(
        "/api/access/invitations",
        {
          method: "POST",
          body: JSON.stringify({
            name: "Invited integration user",
            email: invitedEmail,
            roleId: team.body.data.roles[0].id,
            expiresInDays: 1,
          }),
        },
        cookie,
      );
      expect(invitation.response.status).toBe(201);
      const invitationState = (
        await pool.query(
          "select m.status, i.id from os_memberships m join os_users u on u.id = m.user_id join os_invitations i on i.email = u.email and i.tenant_id = m.tenant_id where u.email = $1 order by i.created_at desc limit 1",
          [invitedEmail],
        )
      ).rows[0];
      expect(invitationState.status).toBe("invited");
      const issuedLink = (
        await pool.query(
          "select url from os_auth_dev_outbox where email = $1 order by created_at desc limit 1",
          [invitedEmail],
        )
      ).rows[0].url as string;
      const cancelled = await request(
        `/api/access/invitations/${invitationState.id}/cancel`,
        { method: "POST", body: "{}" },
        cookie,
      );
      expect(cancelled.response.status).toBe(200);
      const cancelledLink = new URL(issuedLink);
      const redeemedAfterCancellation = await fetch(
        base + cancelledLink.pathname + cancelledLink.search,
        { redirect: "manual", headers: { "x-forwarded-for": clientIp } },
      );
      const cancelledCookie =
        redeemedAfterCancellation.headers.get("set-cookie")?.split(";")[0] ??
        "";
      const cancelledMe = await request("/api/auth/me", {}, cancelledCookie);
      expect(cancelledMe.response.status).toBe(401);
      // Re-invite this test's member for offboarding, leaving the shared seed user active.
      const reinvited = await request(
        "/api/access/invitations",
        {
          method: "POST",
          body: JSON.stringify({
            name: "Invited integration user",
            email: invitedEmail,
            roleId: team.body.data.roles[0].id,
          }),
        },
        cookie,
      );
      expect(reinvited.response.status).toBe(201);
      const memberCookie = await login(invitedEmail);
      expect((await request("/api/auth/me", {}, memberCookie)).response.status).toBe(200);
      const offboarded = await request(
        `/api/access/members/${invitation.body.data.userId}/offboard`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "Integration verification" }),
        },
        cookie,
      );
      expect(offboarded.response.status).toBe(200);
      const memberAfterOffboarding = await request(
        "/api/auth/me",
        {},
        memberCookie,
      );
      expect(memberAfterOffboarding.response.status).toBe(401);
      expect((await request("/api/auth/me", {}, lucaCookie)).response.status).toBe(200);
      server.close();
      await extractionWorker.stop();
      await pool.end();
    },
    20_000,
  );
});

run("PDFs prepare before downloading and keep revision/status boundaries through cache reuse and recovery", async () => {
  const { db, pool } = createDatabase(databaseUrl!);
  const server = createApp(db, { allowDevAuth: true }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let worker: ReturnType<typeof startArtifactPdfWorker> | undefined;
  let projectId: string | undefined;
  let cookie = "";
  const request = (path: string, body?: unknown) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (path: string, body?: unknown) => {
    const response = await request(path, body);
    expect(response.ok).toBe(true);
    return (await response.json()).data;
  };
  const saved = async (id: string) => (await pool.query(
    "select * from knowledge_artifact_pdf_exports where revision_id=$1", [id])).rows[0];
  const text = (bytes: Buffer) => {
    const result = Bun.spawnSync(["pdftotext", "-", "-"], { stdin: bytes });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  try {
    const login = await request("/api/auth/dev-login", { email: "andreas@richtfest.local" });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    projectId = (await json("/api/projects", { name: "PDF cache integration" })).id;
    const { artifact, revision } = await json("/api/knowledge/artifacts", {
      projectId, title: "First saved report", content: "Original evidence survives.",
    });
    const endpoint = (id: string) => `/api/knowledge/artifacts/${artifact.id}/revisions/${id}/pdf`;
    expect(["queued", "running", "ready"]).toContain((await saved(revision.id)).status);
    worker = startArtifactPdfWorker({ db,
      resolveDeps: (tenantId, actorId) => backgroundKnowledgeDeps(db, tenantId, actorId),
      reportError: () => {},
    });
    const deadline = Date.now() + 15_000;
    while ((await saved(revision.id)).status !== "ready" && Date.now() < deadline) await Bun.sleep(100);
    expect((await saved(revision.id)).status).toBe("ready");
    await worker.stop();
    const before = await saved(revision.id);
    const storedChunks: Buffer[] = [];
    for await (const chunk of (await fileStorage.read(before.storage_key))!) storedChunks.push(Buffer.from(chunk));
    const storedBytes = Buffer.concat(storedChunks);
    // A new HTTP request after the worker stops must use durable bytes, not process memory.
    const downloads = await Promise.all([request(endpoint(revision.id)), request(endpoint(revision.id))]);
    for (const response of downloads) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toContain("First-saved-report-v1.pdf");
      expect(Buffer.from(await response.arrayBuffer()).equals(storedBytes)).toBe(true);
    }
    expect(text(storedBytes)).toContain("Status: draft");
    expect((await saved(revision.id)).storage_key).toBe(before.storage_key);
    expect((await fetch(base + endpoint(revision.id))).status).toBe(401);
    expect((await request(endpoint(crypto.randomUUID()))).status).toBe(404);

    await json(`/api/knowledge/artifacts/${artifact.id}/review`, { expectedRevisionId: revision.id });
    const approved = Buffer.from(await (await request(endpoint(revision.id))).arrayBuffer());
    expect(text(approved)).toContain("Status: approved");
    expect(text(approved)).toContain("Original evidence survives.");
    const second = await json(`/api/knowledge/artifacts/${artifact.id}/revisions`, {
      title: "Changed report", content: "Different second-revision evidence.",
    });
    const historical = text(Buffer.from(await (await request(endpoint(revision.id))).arrayBuffer()));
    expect(historical).toContain("Status: historical revision");
    expect(historical).toContain("Original evidence survives.");
    expect(historical).not.toContain("Different second-revision evidence.");
    // Simulate interruption after claiming a job; the persisted expired lease must recover.
    await pool.query("update knowledge_artifact_pdf_exports set status='running', lease_token=$2, lease_until=now()-interval '1 minute' where revision_id=$1",
      [second.id, crypto.randomUUID()]);
    const current = text(Buffer.from(await (await request(endpoint(second.id))).arrayBuffer()));
    expect(current).toContain("Status: draft");
    expect(current).toContain("Revision 2");
    expect(current).toContain("Different second-revision evidence.");
    // A lost saved object must rebuild, not deliver a successful empty download.
    await fileStorage.remove((await saved(second.id)).storage_key);
    const recovered = await request(endpoint(second.id));
    expect(recovered.status).toBe(200);
    expect(text(Buffer.from(await recovered.arrayBuffer()))).toContain("Different second-revision evidence.");
  } finally {
    await worker?.stop();
    server.close();
    if (projectId) {
      const exports = await pool.query(`select e.storage_key from knowledge_artifact_pdf_exports e
        join knowledge_artifact_revisions r on r.id=e.revision_id join knowledge_artifacts a on a.id=r.artifact_id where a.project_id=$1`, [projectId]);
      for (const row of exports.rows) if (row.storage_key) await fileStorage.remove(row.storage_key);
      await pool.query("delete from knowledge_artifact_revisions where artifact_id in (select id from knowledge_artifacts where project_id=$1)", [projectId]);
      await pool.query("delete from knowledge_artifacts where project_id=$1", [projectId]);
      await pool.query("delete from knowledge_drafts where project_id=$1", [projectId]);
      await pool.query("delete from projects_projects where id=$1", [projectId]);
    }
    await pool.end();
  }
}, 30_000);
