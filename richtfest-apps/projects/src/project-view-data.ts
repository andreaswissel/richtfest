import { and, desc, eq } from "drizzle-orm";
import { boundedProjectViewData, unavailableProjectViewData, type ProjectPlanningItem, type ProjectViewContext, type ProjectViewData } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { inquiries, inquiryEntries, projectLocations, projectPlanning, projects } from "./schema";
import { readNoiseSources } from "./noise-sources";

/** Read-only saved records; never starts location research, mailbox provisioning or calculations. */
export async function readProjectViewData(d: AppDeps, context: ProjectViewContext): Promise<ProjectViewData> {
  d.requirePermission("projects:read");
  const { projectId, view, selection } = context;
  const [project] = await d.db.select({ id: projects.id, name: projects.name, status: projects.status,
    street: projects.street, postalCode: projects.postalCode, city: projects.city, country: projects.country,
    customerId: projects.customerId, leadId: projects.leadId, delegateId: projects.delegateId }).from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.tenantId, d.tenantId))).limit(1);
  if (!project) return unavailableProjectViewData("project_not_found");
  if (view === "details") return boundedProjectViewData({ project });
  if (view === "overview") {
    const [planning] = await d.db.select({ revision: projectPlanning.revision, currentPhase: projectPlanning.currentPhase,
      items: projectPlanning.items, updatedAt: projectPlanning.updatedAt }).from(projectPlanning)
      .where(and(eq(projectPlanning.projectId, projectId), eq(projectPlanning.tenantId, d.tenantId))).limit(1);
    if (!planning) return selection.planningItem ? unavailableProjectViewData("selection_not_found")
      : boundedProjectViewData({ project, planning: { status: "not_saved" } });
    const items = (planning.items as ProjectPlanningItem[]).filter(item => !item.archived
      && (!selection.planningItem || item.id === selection.planningItem)
      && (!selection.phase || item.phase === selection.phase)
      && (!selection.discipline || item.discipline === selection.discipline)
      && (selection.planningFilter !== "open" || item.status !== "done")
      && (selection.planningFilter !== "review" || item.status === "in_review"));
    if (selection.planningItem && !items.length) return unavailableProjectViewData("selection_not_found");
    return boundedProjectViewData({ project, planning: { ...planning, matchingItemCount: items.length, items: items.slice(0, 40) } }, items.length > 40);
  }
  if (view === "inquiries") {
    const rows = await d.db.select({ id: inquiries.id, kind: inquiries.kind, title: inquiries.title,
      counterpart: inquiries.counterpart, status: inquiries.status, updatedAt: inquiries.updatedAt }).from(inquiries)
      .where(and(eq(inquiries.projectId, projectId), eq(inquiries.tenantId, d.tenantId),
        selection.inquiry ? eq(inquiries.id, selection.inquiry) : undefined))
      .orderBy(desc(inquiries.updatedAt), desc(inquiries.id)).limit(selection.inquiry ? 1 : 41);
    if (!selection.inquiry) return boundedProjectViewData({ inquiries: rows.slice(0, 40) }, rows.length > 40);
    if (!rows.length) return unavailableProjectViewData("selection_not_found");
    // Only user-visible thread fields. No inbound email envelope, reply address or mailbox token.
    const entries = await d.db.select({ id: inquiryEntries.id, kind: inquiryEntries.kind, direction: inquiryEntries.direction,
      subject: inquiryEntries.subject, body: inquiryEntries.body, fileId: inquiryEntries.fileId, occurredAt: inquiryEntries.occurredAt })
      .from(inquiryEntries).where(and(eq(inquiryEntries.inquiryId, rows[0].id), eq(inquiryEntries.tenantId, d.tenantId)))
      .orderBy(desc(inquiryEntries.occurredAt), desc(inquiryEntries.id)).limit(21);
    return boundedProjectViewData({ inquiry: rows[0], entries: entries.slice(0, 20).reverse(), entryOrder: "oldest_first_of_latest_20" }, entries.length > 20);
  }
  if (view === "noise") {
    const all = await readNoiseSources(d, projectId);
    const sources = selection.source ? all.filter(source => source.id === selection.source) : all;
    if (selection.source && !sources.length) return unavailableProjectViewData("selection_not_found");
    return boundedProjectViewData({ sourceCount: sources.length, sources: sources.slice(0, 40).map(source => selection.source
      ? { id: source.id, kind: source.kind, name: source.name, inputs: source.inputs, missing: source.missing, inquiryId: source.inquiryId }
      : { id: source.id, kind: source.kind, name: source.name, missing: source.missing }) }, sources.length > 40);
  }
  if (view === "location") {
    const [location] = await d.db.select({ revision: projectLocations.revision, scene: projectLocations.scene,
      contextStatus: projectLocations.contextStatus, context: projectLocations.context, updatedAt: projectLocations.updatedAt })
      .from(projectLocations).where(and(eq(projectLocations.projectId, projectId), eq(projectLocations.tenantId, d.tenantId))).limit(1);
    return boundedProjectViewData({ project, location: location ?? { status: "not_saved" } });
  }
  if (["building-model", "fire-protection", "sources", "workspace"].includes(view))
    return { status: "existing_context", authority: "untrusted_saved_project_data", truncated: false };
  return unavailableProjectViewData("unsupported_view");
}
