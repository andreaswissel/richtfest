import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { featureFlags } from "@richtfest/shared";
import { recordAudit } from "../audit";
import { createDatabase, type Database } from "../db/client";
import { memberships, userFeatureFlags, users } from "../db/schema";

// Operator-only: enable, disable or list per-user feature flags for one workspace member.
//   bun run feature-flag enable feasibility_financial_study person@example.com
//   bun run feature-flag disable feasibility_financial_study person@example.com
//   bun run feature-flag list [person@example.com]
const email = z.string().trim().toLowerCase().email();
const command = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["enable", "disable"]), flag: z.enum(featureFlags), email }),
  z.object({ action: z.literal("list"), email: email.optional() }),
]);

/** The user's single workspace membership; sessions require exactly one (see middleware/auth.ts). */
async function member(db: Database, address: string) {
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(sql`lower(${users.email})`, address)).limit(1);
  if (!user) throw new Error(`No Richtfest user with email ${address}`);
  const rows = await db.select({ tenantId: memberships.tenantId }).from(memberships).where(eq(memberships.userId, user.id));
  if (rows.length !== 1) throw new Error(`${address} must have exactly one workspace membership (found ${rows.length})`);
  return { userId: user.id, email: user.email, tenantId: rows[0]!.tenantId };
}

export async function runFeatureFlagCommand(db: Database, argv: string[]) {
  const [action, first, second] = argv;
  const input = command.parse(action === "list" ? { action, email: first } : { action, flag: first, email: second });
  if (input.action === "list") {
    const rows = await db.select({ email: users.email, tenantId: userFeatureFlags.tenantId, flag: userFeatureFlags.flag, createdAt: userFeatureFlags.createdAt })
      .from(userFeatureFlags).innerJoin(users, eq(users.id, userFeatureFlags.userId))
      .where(input.email ? eq(sql`lower(${users.email})`, input.email) : undefined).orderBy(users.email, userFeatureFlags.flag);
    return { flags: rows };
  }
  const target = await member(db, input.email);
  return db.transaction(async (tx) => {
    const scope = and(eq(userFeatureFlags.tenantId, target.tenantId), eq(userFeatureFlags.userId, target.userId), eq(userFeatureFlags.flag, input.flag));
    const changed = input.action === "enable"
      ? await tx.insert(userFeatureFlags).values({ tenantId: target.tenantId, userId: target.userId, flag: input.flag, enabledBy: null }).onConflictDoNothing().returning()
      : await tx.delete(userFeatureFlags).where(scope).returning();
    // Idempotent: repeating a command changes nothing and records no further audit event.
    if (changed.length) {
      await recordAudit(tx, null, target.tenantId, `access.feature_flag.${input.action}d`, "user", target.userId,
        { flag: input.flag, email: target.email }, { actorType: "system" });
    }
    return { action: input.action, flag: input.flag, email: target.email, tenantId: target.tenantId, userId: target.userId, changed: changed.length > 0 };
  });
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const { db, pool } = createDatabase(process.env.DATABASE_URL);
  try {
    console.log(JSON.stringify(await runFeatureFlagCommand(db, process.argv.slice(2)), null, 2));
  } finally {
    await pool.end();
  }
}
