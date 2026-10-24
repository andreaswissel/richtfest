import { expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createEmptySiteAssessmentInput, type ProjectPlanningItem, type ProjectView } from "@richtfest/shared";
import { buildProjectViewPath, parseProjectViewPath } from "@richtfest/shared/project-view-context";
import { readProjectViewData } from "@richtfest/projects/project-view-data";
import { readFeasibilityProjectViewData } from "@richtfest/feasibility/project-view-data";
import { projects, projectPlanning, inquiries, inquiryEntries, inboundMailboxes, noiseSources, noiseSourceValues, projectLocations } from "@richtfest/projects/schema";
import { feasibilityStudies, siteAssessments } from "@richtfest/feasibility/schema";
import { projectViewForRun } from "../../../../richtfest-apps/knowledge/src/project-view-context";
import { conversations, messages, agentRuns } from "@richtfest/knowledge/schema";
import { createDatabase } from "./db/client";
import { userFeatureFlags } from "./db/schema";
import { knowledgeDeps, projectsDeps } from "./app-hosts";
import { feasibilityDeps } from "./feasibility-host";

const url = process.env.DATABASE_URL;
const integration = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ? test : test.skip;

integration("saved project-view owner reads and host adapter fence selections, tenant, permissions and financial flag", async () => {
  const { db, pool } = createDatabase(url!);
  const tenantId = crypto.randomUUID(), foreignTenant = crypto.randomUUID(), actorId = crypto.randomUUID();
  const projectId = crypto.randomUUID(), otherProject = crypto.randomUUID(), foreignProject = crypto.randomUUID();
  const req = { actor: { id: actorId, tenantId, permissions: new Set(["projects:read", "knowledge:read"]) } } as any;
  const context = (view: ProjectView, selection: Record<string, string> = {}, project = projectId) =>
    parseProjectViewPath(project, buildProjectViewPath(project, new URLSearchParams({ view, ...selection })))!;
  const host = knowledgeDeps(db, req);
  const read = async (view: ProjectView, selection: Record<string, string> = {}, project = projectId) => {
    const result = await host.projectViewData!(context(view, selection, project));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
    return result;
  };
  try {
    await db.insert(projects).values([
      { id: projectId, tenantId, createdBy: actorId, name: "Saved project", street: "Saved street 2", city: "Berlin", status: "planning" },
      { id: otherProject, tenantId, createdBy: actorId, name: "Other project private data" },
      { id: foreignProject, tenantId: foreignTenant, createdBy: actorId, name: "Foreign tenant private data" },
    ]);
    const details = await readProjectViewData(projectsDeps(db, req), context("details"));
    expect(details).toMatchObject({ status: "available", truncated: false, data: { project: { name: "Saved project", street: "Saved street 2", city: "Berlin" } } });
    expect(await read("details")).toEqual(details);
    expect(await read("details", {}, foreignProject)).toMatchObject({ status: "unavailable", reason: "project_not_found" });
    expect(await read("overview")).toMatchObject({ data: { planning: { status: "not_saved" } } });
    expect(await read("location")).toMatchObject({ data: { location: { status: "not_saved" } } });
    await db.insert(projectLocations).values({ tenantId, projectId, revision: 3, scene: { objects: [], planningNotes: "Saved setback discussion" } });
    expect(await read("location")).toMatchObject({ data: { location: { revision: 3, scene: { planningNotes: "Saved setback discussion" } } } });

    const item: ProjectPlanningItem = { id: crypto.randomUUID(), title: "Acoustic concept", phase: "concept", discipline: "physics",
      kind: "deliverable", status: "in_review", owner: "Saved owner", dueDate: null, notes: "Needs review", module: "building-model", dependsOn: [], archived: false };
    const otherItem = { ...item, id: crypto.randomUUID(), discipline: "architecture" as const, title: "Other discipline" };
    await db.insert(projectPlanning).values({ tenantId, projectId, currentPhase: "concept", revision: 4,
      items: [item, otherItem, { ...item, id: crypto.randomUUID(), phase: "permit", title: "Later phase" }] });
    expect(await read("overview", { phase: "concept", discipline: "physics" })).toMatchObject({ data: { planning: { revision: 4, currentPhase: "concept", items: [item], matchingItemCount: 1 } } });
    expect(await read("overview", { planningItem: otherItem.id })).toMatchObject({ data: { planning: { items: [otherItem] } } });
    expect(await read("overview", { planningItem: crypto.randomUUID() })).toMatchObject({ status: "unavailable", reason: "selection_not_found" });

    const inquiryIds = Array.from({ length: 4 }, () => crypto.randomUUID());
    await db.insert(inquiries).values(inquiryIds.map((id, index) => ({ id, projectId: index === 2 ? otherProject : projectId,
      tenantId: index === 3 ? foreignTenant : tenantId, kind: "general" as const, title: `Inquiry ${index}`, counterpart: "Architect", createdBy: actorId })));
    await db.insert(inquiryEntries).values(inquiryIds.map((id, index) => ({ tenantId: index === 3 ? foreignTenant : tenantId,
      inquiryId: id, kind: "note" as const, direction: "internal" as const, body: `Saved thread ${index}`, createdBy: actorId })));
    // Even a malformed foreign-tenant entry attached to the selected inquiry is excluded.
    await db.insert(inquiryEntries).values({ tenantId: foreignTenant, inquiryId: inquiryIds[0]!, kind: "note", direction: "internal", body: "PRIVATE WRONG TENANT ENTRY", createdBy: actorId });
    await db.insert(inboundMailboxes).values({ tenantId, projectId, token: "private-mailbox-token-view-test", createdBy: actorId });
    const selectedInquiry = await read("inquiries", { inquiry: inquiryIds[0]! });
    expect(selectedInquiry).toMatchObject({ status: "available", data: { inquiry: { id: inquiryIds[0] }, entries: [{ body: "Saved thread 0" }] } });
    expect(JSON.stringify(selectedInquiry)).not.toContain("private-mailbox-token");
    expect(JSON.stringify(selectedInquiry)).not.toContain("PRIVATE WRONG TENANT");
    const inquiryList = await read("inquiries");
    expect((inquiryList.data as any).inquiries.map((row: any) => row.id).sort()).toEqual(inquiryIds.slice(0, 2).sort());
    expect(JSON.stringify(inquiryList)).not.toContain("Saved thread");
    for (const id of inquiryIds.slice(2)) expect(await read("inquiries", { inquiry: id })).toMatchObject({ status: "unavailable", reason: "selection_not_found" });

    const noiseIds = Array.from({ length: 4 }, () => crypto.randomUUID());
    await db.insert(noiseSources).values(noiseIds.map((id, index) => ({ id, projectId: index === 2 ? otherProject : projectId,
      tenantId: index === 3 ? foreignTenant : tenantId, kind: "road" as const, name: `Saved road ${index}`, createdBy: actorId })));
    await db.insert(noiseSourceValues).values([1, 2].map(version => ({ tenantId, sourceId: noiseIds[0]!, key: "dailyTraffic", version,
      value: 1000 * version, unit: "vehicles/day", basis: "Saved count", createdBy: actorId })));
    expect(await read("noise", { source: noiseIds[0]! })).toMatchObject({ data: { sources: [{ id: noiseIds[0], inputs: { dailyTraffic: { value: 2000, version: 2, basis: "Saved count" } } }] } });
    const noiseList = await read("noise");
    expect((noiseList.data as any).sources.map((row: any) => row.id).sort()).toEqual(noiseIds.slice(0, 2).sort());
    expect(JSON.stringify(noiseList)).not.toContain("dailyTraffic\":{");
    for (const id of noiseIds.slice(2)) expect(await read("noise", { source: id })).toMatchObject({ status: "unavailable", reason: "selection_not_found" });

    const feasibility = feasibilityDeps(db, req);
    expect(await readFeasibilityProjectViewData(feasibility, context("feasibility"))).toMatchObject({ status: "unavailable", reason: "not_saved" });
    const { baseRevision: _, ...siteInput } = createEmptySiteAssessmentInput();
    await db.insert(siteAssessments).values([
      { tenantId, projectId, input: siteInput, revision: 7, createdBy: actorId, updatedBy: actorId },
      { tenantId: foreignTenant, projectId, input: siteInput, revision: 99, createdBy: actorId, updatedBy: actorId },
    ]);
    expect(await read("feasibility", { study: "site" })).toMatchObject({ status: "available", data: { study: "site", savedInputs: { revision: 7 }, results: "not_included" } });
    expect(await read("feasibility", {}, otherProject)).toMatchObject({ status: "unavailable", reason: "not_saved" });
    expect(await read("feasibility", {}, foreignProject)).toMatchObject({ status: "unavailable", reason: "project_not_found" });
    expect(await read("feasibility", { study: "financial" })).toMatchObject({ status: "unavailable", reason: "feature_disabled" });
    await db.insert(userFeatureFlags).values({ tenantId, userId: actorId, flag: "feasibility_financial_study" });
    expect(await read("feasibility", { study: "financial" })).toMatchObject({ status: "unavailable", reason: "not_saved" });
    await db.insert(feasibilityStudies).values([
      { tenantId, projectId, site: {}, scenarios: [], notes: "Saved financial notes", revision: 5, createdBy: actorId, updatedBy: actorId },
      { tenantId: foreignTenant, projectId, site: {}, scenarios: [], notes: "PRIVATE FINANCIAL", revision: 99, createdBy: actorId, updatedBy: actorId },
    ]);
    expect(await read("feasibility", { study: "financial" })).toMatchObject({ status: "available", data: { savedInputs: { revision: 5, notes: "Saved financial notes" } } });
    await db.delete(userFeatureFlags).where(eq(userFeatureFlags.tenantId, tenantId));
    expect(await read("feasibility", { study: "financial" })).toMatchObject({ status: "unavailable", reason: "feature_disabled" });
    for (const view of ["details", "inquiries", "noise", "feasibility"] as const) {
      const denied = knowledgeDeps(db, { actor: { ...req.actor, permissions: new Set() } } as any);
      await expect(denied.projectViewData!(context(view))).rejects.toMatchObject({ status: 403 });
    }
    expect(await read("knowledge")).toMatchObject({ status: "unavailable", reason: "unsupported_view" });
    expect(await read("sources")).toMatchObject({ status: "existing_context" });

    // Knowledge's existing analytics reader is invoked only for the exact initiating message.
    const [thread] = await db.insert(conversations).values({ tenantId, projectId, title: "Saved analytics", createdBy: actorId }).returning();
    const [message] = await db.insert(messages).values({ tenantId, conversationId: thread!.id, authorId: actorId,
      actorKind: "user", body: "How much work?", sourceRef: context("analytics").path }).returning();
    await db.insert(agentRuns).values({ tenantId, projectId: otherProject, provider: "openai", goal: "PRIVATE OTHER PROJECT RUN", status: "failed", requestedBy: actorId, correlationId: crypto.randomUUID() });
    const analytics = await projectViewForRun(host, { projectId, conversationId: thread!.id, messageId: message!.id });
    expect(analytics?.savedData).toMatchObject({ status: "available", data: { summary: { runCount: 0 }, runs: [] } });
    expect(JSON.stringify(analytics)).not.toContain("PRIVATE OTHER PROJECT RUN");
    // Row and string limits remain explicit, including multi-byte content.
    await db.insert(inquiryEntries).values(Array.from({ length: 25 }, () => ({ tenantId, inquiryId: inquiryIds[0]!,
      kind: "note" as const, direction: "internal" as const, body: "🏗️".repeat(6000), createdBy: actorId })));
    expect((await read("inquiries", { inquiry: inquiryIds[0]! })).truncated).toBe(true);
  } finally {
    for (const table of [messages, conversations, agentRuns, userFeatureFlags, feasibilityStudies, siteAssessments,
      inquiryEntries, inboundMailboxes, noiseSourceValues, noiseSources, inquiries, projectPlanning, projectLocations, projects])
      await db.delete(table).where(inArray(table.tenantId, [tenantId, foreignTenant]));
    await pool.end();
  }
});
