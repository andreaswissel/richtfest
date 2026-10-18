import { and, eq } from "drizzle-orm";
import { isFeatureFlag, type FeatureFlagKey } from "@richtfest/shared";
import { userFeatureFlags } from "./db/schema";
import type { Database } from "./db/client";

/** Known flags enabled for this user in this workspace. Rows for retired keys are ignored. */
export async function featureFlagsFor(db: Database, tenantId: string, userId: string): Promise<FeatureFlagKey[]> {
  const rows = await db.select({ flag: userFeatureFlags.flag }).from(userFeatureFlags)
    .where(and(eq(userFeatureFlags.tenantId, tenantId), eq(userFeatureFlags.userId, userId)));
  return rows.map(row => row.flag).filter(isFeatureFlag).sort();
}

/** Read per request, so enabling or disabling a flag applies without a new sign-in. */
export async function hasFeatureFlag(db: Database, tenantId: string, userId: string, flag: FeatureFlagKey): Promise<boolean> {
  const [row] = await db.select({ flag: userFeatureFlags.flag }).from(userFeatureFlags)
    .where(and(eq(userFeatureFlags.tenantId, tenantId), eq(userFeatureFlags.userId, userId), eq(userFeatureFlags.flag, flag))).limit(1);
  return !!row;
}
