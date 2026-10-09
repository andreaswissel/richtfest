import { sql } from "drizzle-orm";
import { z } from "zod";
import { permissions as permissionKeys } from "@richtfest/shared";
import { recordAudit } from "../audit";
import { createDatabase } from "../db/client";
import { authUser } from "../db/auth-schema";
import { invitations, memberships, permissions, rolePermissions, roles, tenants, users } from "../db/schema";

// Operator-only first-account provisioning; never run the development seed in
// production. Sign-in still requires proving email ownership via a magic link.
const [email, name, workspace] = z.tuple([
  z.string().trim().toLowerCase().email(),
  z.string().trim().min(1),
  z.string().trim().min(1),
]).parse(process.argv.slice(2));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const { db, pool } = createDatabase(process.env.DATABASE_URL);
try {
  const result = await db.transaction(async (tx) => {
    // Serialize concurrent attempts, including attempts with different emails.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(74819321)`);
    if ((await tx.select({ id: tenants.id }).from(tenants).limit(1)).length ||
        (await tx.select({ id: users.id }).from(users).limit(1)).length ||
        (await tx.select({ id: authUser.id }).from(authUser).limit(1)).length) {
      throw new Error("First-admin bootstrap requires an empty workspace. Use Team invitations for existing workspaces.");
    }
    const [tenant] = await tx.insert(tenants).values({ name: workspace }).returning();
    for (const key of permissionKeys) {
      await tx.insert(permissions).values({ key, description: `Permission ${key}` }).onConflictDoNothing();
    }
    const [role] = await tx.insert(roles).values({ tenantId: tenant.id, name: "Admin", description: "Full workspace access" }).returning();
    await tx.insert(rolePermissions).values(permissionKeys.map((permission) => ({ roleId: role.id, permission })));
    const [user] = await tx.insert(users).values({ email, name }).returning();
    await tx.insert(authUser).values({ id: user.id, email, name, emailVerified: false });
    await tx.insert(memberships).values({ tenantId: tenant.id, userId: user.id, roleId: role.id, status: "invited" });
    const [invitation] = await tx.insert(invitations).values({
      tenantId: tenant.id, email, roleId: role.id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).returning();
    await recordAudit(tx, null, tenant.id, "access.admin_bootstrapped", "user", user.id,
      { email, roleId: role.id, invitationId: invitation.id }, { actorType: "system" });
    return { email, workspace, userId: user.id, tenantId: tenant.id, status: "invited" };
  });
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
