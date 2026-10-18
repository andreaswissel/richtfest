import { and, eq } from "drizzle-orm";
import { projects } from "./schema";

/** Keep a project alive through a child-write transaction, including deletion races. */
export async function lockProject(tx: any, tenantId: string, projectId: string) {
  const [project] = await tx.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId))).for("key share");
  if (!project) throw Object.assign(new Error("Project not found"), { status: 404, code: "not_found" });
}
