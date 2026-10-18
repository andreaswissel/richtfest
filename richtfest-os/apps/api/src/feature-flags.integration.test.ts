import { expect, test } from "bun:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createRouter as createFeasibilityRouter } from "@richtfest/feasibility";
import { feasibilityStudies } from "@richtfest/feasibility/schema";
import { projects } from "@richtfest/projects/schema";
import { createDatabase } from "./db/client";
import { auditEvents, memberships, rolePermissions, roles, tenants, userFeatureFlags, users } from "./db/schema";
import { requireOsUse, requireSession } from "./middleware/auth";
import { feasibilityDeps } from "./feasibility-host";
import { featureFlagsFor } from "./feature-flags";
import { runFeatureFlagCommand } from "./scripts/feature-flag";

// Explicit local-only opt-in: never run fixture writes against a deployed database.
const url = process.env.FEATURE_FLAG_TEST_DATABASE_URL;
const integration = url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname) ? test : test.skip;

integration("the financial feasibility study is gated per user by a feature flag, in the API as well as the session", async () => {
  const { db, pool } = createDatabase(url!);
  const tenantId = crypto.randomUUID(), otherTenantId = crypto.randomUUID(), roleId = crypto.randomUUID();
  const flagged = crypto.randomUUID(), plain = crypto.randomUUID(), projectId = crypto.randomUUID();
  const flaggedEmail = `flagged-${flagged}@richtfest.test`;
  const auth = { api: { getSession: async ({ headers }: { headers: Headers }) => { const id = headers.get("x-user"); return id ? { user: { id } } : null; } } };
  const app = express();
  app.use(express.json(), requireSession(db, auth), requireOsUse);
  app.use("/api/feasibility", createFeasibilityRouter((req) => feasibilityDeps(db, req)));
  app.use((error: any, _req: any, res: any, _next: any) =>
    res.status(error instanceof z.ZodError ? 400 : (error.status ?? 500)).json({ data: null, error: error.code, message: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const request = (user: string, path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/feasibility/projects/${projectId}${path}`, {
      method, headers: { "Content-Type": "application/json", "x-user": user }, body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await db.insert(tenants).values([{ id: tenantId, name: "Flag test" }, { id: otherTenantId, name: "Other workspace" }]);
    await db.insert(users).values([
      { id: flagged, email: flaggedEmail, name: "Flagged" },
      { id: plain, email: `plain-${plain}@richtfest.test`, name: "Plain" },
    ]);
    await db.insert(roles).values({ id: roleId, tenantId, name: "Planner" });
    await db.insert(rolePermissions).values(["richtfest-os:use", "projects:read", "projects:write"].map((permission) => ({ roleId, permission })));
    await db.insert(memberships).values([flagged, plain].map((userId) => ({ tenantId, userId, roleId, status: "active" })));
    await db.insert(projects).values({ id: projectId, tenantId, name: "Flag project", createdBy: flagged });

    // Without the flag: the session lists none and every study route is refused, while the site assessment stays open.
    expect(await featureFlagsFor(db, tenantId, flagged)).toEqual([]);
    for (const user of [flagged, plain]) {
      const response = await request(user, "/study");
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("feature_not_enabled");
    }
    expect((await request(plain, "/study", "PUT", {})).status).toBe(403);
    expect((await request(plain, "/study/report.pdf")).status).toBe(403);
    expect((await request(plain, "/site-assessment")).status).toBe(200);

    // A flag row in another workspace never applies.
    await db.insert(userFeatureFlags).values({ tenantId: otherTenantId, userId: flagged, flag: "feasibility_financial_study" });
    expect((await request(flagged, "/study")).status).toBe(403);

    // The operator script enables it idempotently, scoped to the user's workspace, with one system audit event.
    expect(await runFeatureFlagCommand(db, ["enable", "feasibility_financial_study", flaggedEmail.toUpperCase()])).toMatchObject({ changed: true, tenantId, userId: flagged });
    expect(await runFeatureFlagCommand(db, ["enable", "feasibility_financial_study", flaggedEmail])).toMatchObject({ changed: false });
    await expect(runFeatureFlagCommand(db, ["enable", "unknown_flag", flaggedEmail])).rejects.toThrow();
    expect(await featureFlagsFor(db, tenantId, flagged)).toEqual(["feasibility_financial_study"]);
    expect(await featureFlagsFor(db, tenantId, plain)).toEqual([]);
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.entityId, flagged)));
    expect(audit.map((event) => [event.action, event.actorType, event.actorId])).toEqual([["access.feature_flag.enabled", "system", null]]);

    // With the flag: read and save the study; the other member stays gated and cannot overwrite it.
    const initial = await request(flagged, "/study");
    expect(initial.status).toBe(200);
    const { study } = (await initial.json()).data;
    expect(study.revision).toBe(0);
    const input = { baseRevision: 0, site: study.site, scenarios: study.scenarios, notes: "Flagged save" };
    expect((await request(plain, "/study", "PUT", input)).status).toBe(403);
    const saved = await request(flagged, "/study", "PUT", input);
    expect(saved.status).toBe(200);
    expect((await saved.json()).data.study).toMatchObject({ revision: 1, notes: "Flagged save" });
    expect((await request(flagged, "/study/report.pdf")).headers.get("content-type")).toBe("application/pdf");
    expect((await request(plain, "/study")).status).toBe(403);

    // Disabling applies on the next request without a new sign-in; the saved study is kept.
    expect(await runFeatureFlagCommand(db, ["disable", "feasibility_financial_study", flaggedEmail])).toMatchObject({ changed: true });
    expect((await request(flagged, "/study")).status).toBe(403);
    expect((await db.select().from(feasibilityStudies).where(eq(feasibilityStudies.tenantId, tenantId))).map((row) => row.revision)).toEqual([1]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.delete(feasibilityStudies).where(eq(feasibilityStudies.tenantId, tenantId));
    await db.delete(projects).where(eq(projects.tenantId, tenantId));
    await db.delete(userFeatureFlags).where(inArray(userFeatureFlags.userId, [flagged, plain]));
    await db.delete(auditEvents).where(inArray(auditEvents.tenantId, [tenantId, otherTenantId]));
    await db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    await db.delete(roles).where(eq(roles.id, roleId));
    await db.delete(users).where(inArray(users.id, [flagged, plain]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
    await pool.end();
  }
});
