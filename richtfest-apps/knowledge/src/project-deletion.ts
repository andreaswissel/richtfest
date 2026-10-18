import { and, eq, inArray, or, sql } from "drizzle-orm";
import * as s from "./schema";

/** Called by the OS host inside the project's deletion transaction. */
export async function deleteProjectKnowledge(tx: any, tenantId: string, projectId: string, sourceIds: string[] = []): Promise<string[]> {
  // Cross-project and company references must survive deletion of their sources.
  // Existing source references are UUIDs or source-linked URLs in JSON/text.
  if (sourceIds.length) {
    const references = sql.join(sourceIds.map(id => sql`${id}`), sql`, `);
    const shared = await tx.execute(sql`
      with refs as (select unnest(array[${references}]::text[]) as id), content as (
        select d.source_refs::text as body from knowledge_drafts d where d.tenant_id=${tenantId} and d.project_id is distinct from ${projectId}::uuid
        union all select m.source_version_ids::text || coalesce(m.source_ref,'') from knowledge_messages m join knowledge_conversations c on c.id=m.conversation_id and c.tenant_id=m.tenant_id where m.tenant_id=${tenantId} and c.project_id is distinct from ${projectId}::uuid
        union all select r.source_version_ids::text from knowledge_agent_runs r where r.tenant_id=${tenantId} and r.project_id is distinct from ${projectId}::uuid and not exists(select 1 from knowledge_conversations c where c.id=r.conversation_id and c.tenant_id=${tenantId} and c.project_id=${projectId})
        union all select r.source_version_ids::text from knowledge_artifact_revisions r join knowledge_artifacts a on a.id=r.artifact_id and a.tenant_id=r.tenant_id where r.tenant_id=${tenantId} and a.project_id<>${projectId}
      ) select 1 from content join refs on strpos(content.body,refs.id)>0 limit 1`);
    if (shared.rows.length) throw Object.assign(new Error("Project sources are referenced by other workspace knowledge. Remove those references before deleting this project."), { status: 409, code: "project_sources_in_use" });
  }
  const scope = (table: any) => and(eq(table.tenantId, tenantId), eq(table.projectId, projectId));
  const conversations = await tx.select().from(s.conversations).where(scope(s.conversations)).for("update");
  const conversationIds = conversations.map((row: any) => row.id);
  const runs = await tx.select().from(s.agentRuns).where(and(eq(s.agentRuns.tenantId, tenantId), or(eq(s.agentRuns.projectId, projectId), ...(conversationIds.length ? [inArray(s.agentRuns.conversationId, conversationIds)] : [])))).for("update");
  if (runs.some((row: any) => ["queued", "running"].includes(row.status)))
    throw Object.assign(new Error("Stop active agents before deleting this project."), { status: 409, code: "project_busy" });
  const artifacts = await tx.select().from(s.artifacts).where(scope(s.artifacts)).for("update");
  const artifactIds = artifacts.map((row: any) => row.id);
  const revisions = artifactIds.length ? await tx.select().from(s.artifactRevisions).where(and(eq(s.artifactRevisions.tenantId, tenantId), inArray(s.artifactRevisions.artifactId, artifactIds))).for("update") : [];
  const revisionIds = revisions.map((row: any) => row.id);
  const exports = revisionIds.length ? await tx.select().from(s.artifactPdfExports).where(and(eq(s.artifactPdfExports.tenantId, tenantId), inArray(s.artifactPdfExports.revisionId, revisionIds))).for("update") : [];
  if (exports.some((row: any) => ["queued", "running"].includes(row.status)))
    throw Object.assign(new Error("Wait for document exports to finish before deleting this project."), { status: 409, code: "project_busy" });
  const runIds = runs.map((row: any) => row.id);
  if (runIds.length) for (const table of [s.supervisorRuns, s.agentRunApprovals, s.agentRunSteps, s.agentRunEvents, s.agentRunUsage, s.agentRunAttempts])
    await tx.delete(table).where(and(eq(table.tenantId, tenantId), inArray(table.runId, runIds)));
  if (runIds.length) await tx.delete(s.agentRuns).where(and(eq(s.agentRuns.tenantId, tenantId), inArray(s.agentRuns.id, runIds)));
  if (conversationIds.length) {
    for (const table of [s.messages, s.conversationReads]) await tx.delete(table).where(and(eq(table.tenantId, tenantId), inArray(table.conversationId, conversationIds)));
    await tx.delete(s.tasks).where(and(eq(s.tasks.tenantId, tenantId), inArray(s.tasks.conversationId, conversationIds)));
  }
  await tx.delete(s.annotations).where(scope(s.annotations));
  if (artifactIds.length) await tx.delete(s.artifactRevisions).where(and(eq(s.artifactRevisions.tenantId, tenantId), inArray(s.artifactRevisions.artifactId, artifactIds)));
  for (const table of [s.artifacts, s.tasks, s.drafts, s.conversations]) await tx.delete(table).where(scope(table));
  return exports.flatMap((row: any) => row.storageKey ? [row.storageKey] : []);
}
