import { eq, and } from "drizzle-orm";
import { createDatabase } from "./db/client";
import { env } from "./env";
import { memberships, permissions, rolePermissions, roles, tenants, users } from "./db/schema";
import { permissions as permissionKeys } from "@richtfest/shared";
import { authUser } from "./db/auth-schema";

const { db, pool } = createDatabase(env.DATABASE_URL);
const seed = async () => {
  const findOrCreateTenant = async (name: string) => {
    const existing = (await db.select().from(tenants).where(eq(tenants.name, name)).limit(1))[0];
    if (existing) return existing;
    return (await db.insert(tenants).values({ name }).returning())[0];
  };
  const tenant = await findOrCreateTenant("Alpha");
  const outsider = await findOrCreateTenant("Outsider");
  for (const key of permissionKeys) await db.insert(permissions).values({ key, description: `Permission ${key}` }).onConflictDoNothing();
  const [adminRole] = await db.insert(roles).values({ tenantId: tenant.id, name: "Admin", description: "Full Alpha access" }).onConflictDoNothing().returning();
  const role = adminRole ?? (await db.select().from(roles).where(and(eq(roles.tenantId, tenant.id), eq(roles.name, "Admin"))).limit(1))[0];
  const [outsiderRole] = await db.insert(roles).values({ tenantId: outsider.id, name: "Member", description: "Outsider access" }).onConflictDoNothing().returning();
  const outsiderMemberRole = outsiderRole ?? (await db.select().from(roles).where(and(eq(roles.tenantId, outsider.id), eq(roles.name, "Member"))).limit(1))[0];
  for (const key of permissionKeys) await db.insert(rolePermissions).values({ roleId: role.id, permission: key }).onConflictDoNothing();
  const [andreas] = await db.insert(users).values({ email: "andreas@richtfest.local", name: "Andreas" }).onConflictDoNothing().returning();
  const [luca] = await db.insert(users).values({ email: "luca@richtfest.local", name: "Luca" }).onConflictDoNothing().returning();
  const [outsiderUser] = await db.insert(users).values({ email: "outsider@other.local", name: "Outsider" }).onConflictDoNothing().returning();
  const andreasUser = andreas ?? (await db.select().from(users).where(eq(users.email, "andreas@richtfest.local")).limit(1))[0];
  const lucaUser = luca ?? (await db.select().from(users).where(eq(users.email, "luca@richtfest.local")).limit(1))[0];
  const otherUser = outsiderUser ?? (await db.select().from(users).where(eq(users.email, "outsider@other.local")).limit(1))[0];
  for (const user of [andreasUser, lucaUser, otherUser]) await db.insert(authUser).values({ id: user.id, email: user.email, name: user.name, emailVerified: true }).onConflictDoNothing();
  await db.insert(memberships).values([{ tenantId: tenant.id, userId: andreasUser.id, roleId: role.id }, { tenantId: tenant.id, userId: lucaUser.id, roleId: role.id }, { tenantId: outsider.id, userId: otherUser.id, roleId: outsiderMemberRole.id }]).onConflictDoNothing();
  console.log(JSON.stringify({ tenant: tenant.name, users: [andreasUser.email, lucaUser.email], outsider: otherUser.email }));
};
seed().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
