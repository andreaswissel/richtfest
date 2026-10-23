import { and, desc, eq, inArray } from "drizzle-orm";
import { drafts, tasks } from "./schema";
export const dashboardSummary = async (db: any, tenantId: string) => {
  // Keep the existing tenant-wide read scope: responsibility is not authorization.
  const activeTasks = await db.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), inArray(tasks.status, ["open", "in_progress", "needs_review"])) ).orderBy(desc(tasks.createdAt));
  const pendingDrafts = await db.select().from(drafts).where(and(eq(drafts.tenantId, tenantId), eq(drafts.status, "draft"))).orderBy(desc(drafts.createdAt));
  return { tasks: activeTasks, reviewTasks: activeTasks.filter((task: any) => task.status === "needs_review"), pendingDrafts };
};
