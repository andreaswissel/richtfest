import { and, eq } from "drizzle-orm";
import { feasibilityStudies, siteAssessments, siteEvidenceProposals } from "./schema";

/** Revisions cascade with their parent; unrelated projects remain untouched. */
export async function deleteProjectFeasibility(tx: any, tenantId: string, projectId: string) {
  const scope = (table: any) => and(eq(table.tenantId, tenantId), eq(table.projectId, projectId));
  const proposals = await tx.select().from(siteEvidenceProposals).where(scope(siteEvidenceProposals)).for("update");
  if (proposals.some((row: any) => ["running", "queued"].includes(row.status)))
    throw Object.assign(new Error("Wait for site evidence processing to finish before deleting this project."), { status: 409, code: "project_busy" });
  for (const table of [siteEvidenceProposals, siteAssessments, feasibilityStudies]) await tx.delete(table).where(scope(table));
}
