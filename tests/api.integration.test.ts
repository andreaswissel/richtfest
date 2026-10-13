import { describe, expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { createApp } from "../richtfest-os/apps/api/src/server";
import { fileStorage } from "../richtfest-os/apps/api/src/app-hosts";
import { startSourceExtractionWorker } from "../richtfest-apps/projects/src/source-extraction";

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? test : test.skip;

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
            (source: any) => source.name === "plan.ifc",
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
      const request = async (
        path: string,
        init: RequestInit = {},
        cookie?: string,
      ) => {
        const headers = new Headers(init.headers);
        headers.set("content-type", "application/json");
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
              name: "plan.ifc",
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
            sourceRef: "drive://plan.ifc",
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
      if (process.env.AI_CONNECTION_ENCRYPTION_KEY) {
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
        expect(proposed.attempts[0].settings).toMatchObject({ adapter: "direct", maxRetries: 0, timeoutMs: 60000 });
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
          name: "plan.ifc",
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
        { redirect: "manual" },
      );
      const cancelledCookie =
        redeemedAfterCancellation.headers.get("set-cookie")?.split(";")[0] ??
        "";
      const cancelledMe = await request("/api/auth/me", {}, cancelledCookie);
      expect(cancelledMe.response.status).toBe(401);
      const luca = team.body.data.members.find(
        (member: any) => member.email === "luca@richtfest.local",
      );
      const offboarded = await request(
        `/api/access/members/${luca.userId}/offboard`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "Integration verification" }),
        },
        cookie,
      );
      expect(offboarded.response.status).toBe(200);
      const lucaAfterOffboarding = await request(
        "/api/auth/me",
        {},
        lucaCookie,
      );
      expect(lucaAfterOffboarding.response.status).toBe(401);
      server.close();
      await extractionWorker.stop();
      await pool.end();
    },
  );
});
