import { expect, test } from "bun:test";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { permissions } from "../richtfest-shared/src/auth";

const run = process.env.DATABASE_URL ? test : test.skip;

run("first-admin command provisions reviewed email access and refuses an existing workspace", async () => {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  const schema = `bootstrap_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const table of ["os_tenants", "os_users", "auth_user", "os_roles", "os_permissions", "os_role_permissions", "os_memberships", "os_invitations", "os_audit_events"]) {
      await pool.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    const bootstrap = async (email: string) => {
      const child = Bun.spawn(["bun", "richtfest-os/apps/api/src/scripts/bootstrap-admin.ts", email, "First Admin", "Customer workspace"], {
        env: { ...process.env, DATABASE_URL: url.toString() }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const first = await bootstrap("Admin@customer.example");
    expect(first.code).toBe(0);
    const result = JSON.parse(first.stdout);
    expect(result.email).toBe("admin@customer.example");
    const identities = await pool.query(`SELECT u.id, a.id AS auth_id, a.email_verified, m.status FROM ${schema}.os_users u JOIN ${schema}.auth_user a ON u.email=a.email JOIN ${schema}.os_memberships m ON m.user_id=u.id`);
    expect(identities.rows).toEqual([{ id: result.userId, auth_id: result.userId, email_verified: false, status: "invited" }]);
    const grants = await pool.query(`SELECT permission FROM ${schema}.os_role_permissions`);
    expect(grants.rows.map((r) => r.permission).sort()).toEqual([...permissions].sort());
    const audit = await pool.query(`SELECT actor_type, action FROM ${schema}.os_audit_events`);
    expect(audit.rows).toEqual([{ actor_type: "system", action: "access.admin_bootstrapped" }]);
    const invitation = await pool.query(`SELECT email FROM ${schema}.os_invitations WHERE expires_at > now() AND accepted_at IS NULL`);
    expect(invitation.rows).toEqual([{ email: "admin@customer.example" }]);
    const second = await bootstrap("different@customer.example");
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("requires an empty workspace");
    const count = await pool.query(`SELECT count(*)::int AS n FROM ${schema}.os_users`);
    expect(count.rows[0].n).toBe(1);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
}, 30000);
