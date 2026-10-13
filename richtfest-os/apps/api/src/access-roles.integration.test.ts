import { expect, test } from "bun:test";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createDatabase } from "./db/client";
import {
  auditEvents,
  memberships,
  rolePermissions,
  roles,
  tenants,
  users,
} from "./db/schema";
import { createAccessRouter } from "./access-routes";
import { requireOsUse, requireSession } from "./middleware/auth";

// Explicit local-only opt-in: never run fixture writes against a deployed database.
const url = process.env.ACCESS_TEST_DATABASE_URL;
const integration =
  url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname)
    ? test
    : test.skip;

integration(
  "workspace roles persist grants, enforce live access and tenant scope, and preserve an active manager",
  async () => {
    const { db, pool } = createDatabase(url!);
    const tenantId = crypto.randomUUID(),
      otherTenantId = crypto.randomUUID();
    const owner = crypto.randomUUID(),
      colleague = crypto.randomUUID(),
      reader = crypto.randomUUID();
    const ownerRole = crypto.randomUUID(),
      otherRole = crypto.randomUUID();
    const managerGrants = ["richtfest-os:use", "access:manage"];
    const readGrants = ["richtfest-os:use", "projects:read"];
    const auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const id = headers.get("x-user");
          return id ? { user: { id } } : null;
        },
      },
    };
    const app = express();
    app.use(express.json(), requireSession(db, auth), requireOsUse);
    app.use(createAccessRouter(db, auth, false));
    app.use((error: any, _req: any, res: any, _next: any) =>
      res
        .status(error instanceof z.ZodError ? 400 : (error.status ?? 500))
        .json({ error: error.code, message: error.message }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const request = (
      path: string,
      method = "GET",
      body?: unknown,
      user = owner,
    ) =>
      fetch(`http://127.0.0.1:${port}/access${path}`, {
        method,
        headers: { "Content-Type": "application/json", "x-user": user },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const team = async (user = owner) =>
      (await (await request("/team", "GET", undefined, user)).json()).data;
    const edit = (
      id: string,
      permissions: string[],
      name = "Coordinator",
      user = owner,
    ) => request(`/roles/${id}`, "PUT", { name, permissions }, user);
    try {
      await db.insert(tenants).values([
        { id: tenantId, name: "Role test" },
        { id: otherTenantId, name: "Other workspace" },
      ]);
      await db.insert(users).values(
        [owner, colleague, reader].map((id) => ({
          id,
          name: id,
          email: `${id}@roles.test`,
        })),
      );
      await db.insert(roles).values([
        { id: ownerRole, tenantId, name: "Coordinator" },
        { id: otherRole, tenantId: otherTenantId, name: "External" },
      ]);
      await db.insert(rolePermissions).values(
        managerGrants.map((permission) => ({
          roleId: ownerRole,
          permission,
        })),
      );
      await db.insert(memberships).values(
        [owner, colleague, reader].map((userId) => ({
          tenantId,
          userId,
          roleId: ownerRole,
        })),
      );

      expect(
        (
          await request("/roles", "POST", {
            name: "Unknown",
            permissions: ["richtfest-os:use", "invented:grant"],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request("/roles", "POST", {
            name: "No OS",
            permissions: ["access:manage"],
          })
        ).status,
      ).toBe(400);
      const created = await request("/roles", "POST", {
        name: " Project reader ",
        description: "View only",
        permissions: readGrants,
      });
      expect(created.status).toBe(201);
      const readRole = (await created.json()).data;
      expect(readRole).toMatchObject({
        tenantId,
        name: "Project reader",
        description: "View only",
        permissions: readGrants,
      });
      expect(
        (
          await request("/roles", "POST", {
            name: "Project reader",
            permissions: readGrants,
          })
        ).status,
      ).toBe(409);
      expect((await edit(readRole.id, readGrants, "Coordinator")).status).toBe(
        409,
      );
      expect((await edit(otherRole, managerGrants)).status).toBe(404);
      expect(
        (await request(`/members/${reader}`, "PATCH", { roleId: otherRole }))
          .status,
      ).toBe(400);
      expect((await team()).roles.map((r: any) => r.id)).not.toContain(
        otherRole,
      );

      // Multiple active managers on the same role do not provide a fallback
      // when removing that role's management permission.
      expect((await edit(ownerRole, readGrants)).status).toBe(409);

      for (const user of [colleague, reader]) {
        expect(
          (await request(`/members/${user}`, "PATCH", { roleId: readRole.id }))
            .status,
        ).toBe(200);
        const view = await team(user);
        expect(view.canManageTeam).toBe(false);
        expect(view.roles.every((r: any) => r.permissions === undefined)).toBe(
          true,
        );
      }
      expect(
        (
          await request(
            "/roles",
            "POST",
            { name: "Escalation", permissions: managerGrants },
            reader,
          )
        ).status,
      ).toBe(403);
      expect(
        (await edit(readRole.id, managerGrants, "Escalation", reader)).status,
      ).toBe(403);
      expect(
        (
          await request(
            `/members/${reader}`,
            "PATCH",
            { roleId: ownerRole },
            reader,
          )
        ).status,
      ).toBe(403);

      // Editing the shared role or reassigning its last manager must roll back.
      expect((await edit(ownerRole, readGrants)).status).toBe(409);
      expect(
        (await request(`/members/${owner}`, "PATCH", { roleId: readRole.id }))
          .status,
      ).toBe(409);
      expect((await team()).canManageTeam).toBe(true);
      expect(
        (await team()).roles
          .find((r: any) => r.id === ownerRole)
          .permissions.sort(),
      ).toEqual([...managerGrants].sort());

      // A non-Admin role can administer access; changes apply to all its members
      // without replacing their sessions, then are revoked on their next request.
      expect(
        (await edit(readRole.id, managerGrants, "Delegated manager")).status,
      ).toBe(200);
      expect((await team(colleague)).canManageTeam).toBe(true);
      expect((await team(reader)).canManageTeam).toBe(true);
      expect(
        (
          await request(
            "/roles",
            "POST",
            { name: "Created by delegate", permissions: readGrants },
            colleague,
          )
        ).status,
      ).toBe(201);
      expect(
        (await edit(readRole.id, readGrants, "Project reader")).status,
      ).toBe(200);
      expect((await team(reader)).canManageTeam).toBe(false);
      expect(
        (
          await request(
            "/roles",
            "POST",
            { name: "Revoked", permissions: readGrants },
            colleague,
          )
        ).status,
      ).toBe(403);

      // Two managers on different roles racing to demote themselves cannot
      // both succeed, even though both requests begin with management access.
      const second = await request("/roles", "POST", {
        name: "Second manager",
        permissions: managerGrants,
      });
      const secondRole = (await second.json()).data.id;
      expect(
        (
          await request(`/members/${colleague}`, "PATCH", {
            roleId: secondRole,
          })
        ).status,
      ).toBe(200);
      const results = await Promise.all([
        edit(ownerRole, readGrants),
        edit(secondRole, readGrants, "Second manager", colleague),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        [
          (await team()).canManageTeam,
          (await team(colleague)).canManageTeam,
        ].filter(Boolean),
      ).toHaveLength(1);

      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, tenantId));
      expect(
        audits.filter((a) => a.action === "access.role.created"),
      ).toHaveLength(3);
      expect(
        audits.filter((a) => a.action === "access.role.updated"),
      ).toHaveLength(3);
      const update = audits.find(
        (a) => a.action === "access.role.updated" && a.entityId === readRole.id,
      )!;
      expect(update.metadata).toMatchObject({
        before: { permissions: expect.arrayContaining(readGrants) },
        after: { permissions: managerGrants },
      });

      const remainingManager = (await team()).canManageTeam ? owner : colleague;
      expect(
        (
          await request(
            `/members/${reader}/offboard`,
            "POST",
            {},
            remainingManager,
          )
        ).status,
      ).toBe(200);
      expect((await request("/team", "GET", undefined, reader)).status).toBe(
        401,
      );
    } finally {
      const createdRoles = await db
        .select({ id: roles.id })
        .from(roles)
        .where(inArray(roles.tenantId, [tenantId, otherTenantId]));
      if (createdRoles.length)
        await db.delete(rolePermissions).where(
          inArray(
            rolePermissions.roleId,
            createdRoles.map((r) => r.id),
          ),
        );
      await db.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
      await db.delete(memberships).where(eq(memberships.tenantId, tenantId));
      await db
        .delete(roles)
        .where(inArray(roles.tenantId, [tenantId, otherTenantId]));
      await db
        .delete(users)
        .where(inArray(users.id, [owner, colleague, reader]));
      await db
        .delete(tenants)
        .where(inArray(tenants.id, [tenantId, otherTenantId]));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    }
  },
);
