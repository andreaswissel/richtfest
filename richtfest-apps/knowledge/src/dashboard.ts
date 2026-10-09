import { and, desc, eq } from "drizzle-orm";
import { drafts, tasks } from "./schema";
export const dashboardSummary = async (db: any, tenantId: string) => { const openTasks = await db.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "open"))).orderBy(desc(tasks.createdAt)); const pendingDrafts = await db.select().from(drafts).where(and(eq(drafts.tenantId, tenantId), eq(drafts.status, "draft"))).orderBy(desc(drafts.createdAt)); return { tasks: openTasks, pendingDrafts }; };
