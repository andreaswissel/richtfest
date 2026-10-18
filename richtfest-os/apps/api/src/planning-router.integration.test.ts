import { expect, test } from "bun:test";
import express from "express";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createRouter } from "@richtfest/projects";
import type { ProjectPlanningItem } from "@richtfest/shared";

const url = process.env.PLANNING_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

(local ? test : test.skip)("planning public API preserves phase records, permissions and optimistic writes", async () => {
  const namespace = `planning_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url! });
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(url!);
  isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const pool = new Pool({ connectionString: isolated.href });
  const db = drizzle(pool);
  const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID(), project = crypto.randomUUID(), secondProject = crypto.randomUUID();
  let failAudit = false;
  const app = express();
  app.use(express.json());
  app.use(createRouter(req => ({
    db, tenantId: req.header("x-tenant") ?? tenant, actorId: crypto.randomUUID(),
    requirePermission(permission) {
      if (req.header("x-permissions")?.split(",").includes(permission)) return;
      throw Object.assign(new Error("Permission denied"), { status: 403, code: "forbidden" });
    },
    async audit(tx, action, entityType, entityId, metadata) {
      if (failAudit) throw new Error("Audit unavailable");
      await tx.execute(`INSERT INTO planning_test_audit DEFAULT VALUES`);
      expect(action).toBe("projects.planning.updated");
      expect(entityType).toBe("project");
      expect(entityId).toBe(project);
      expect(metadata).toMatchObject({ purpose: "planning_tracking_not_engineering_approval" });
    },
    validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any,
  })));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? (e.name === "ZodError" ? 400 : 500))
    .json({ data: null, error: { code: e.code ?? "invalid_input" }, message: e.message }));
  const server = app.listen(0);
  const root = `http://127.0.0.1:${(server.address() as any).port}`;
  const path = `/projects/${project}/planning`;
  const call = async (body?: unknown, headers: Record<string, string> = {}, target = path) => {
    const response = await fetch(root + target, {
      method: body === undefined ? "GET" : "PUT",
      headers: { "content-type": "application/json", "x-permissions": "projects:read,projects:write", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const a: ProjectPlanningItem = { id: crypto.randomUUID(), title: "Site constraints", phase: "plot", discipline: "coordination", kind: "decision", status: "open", owner: "Planner", dueDate: "2026-12-01", notes: "Source-linked notes", module: "location", dependsOn: [], archived: false };
  const b: ProjectPlanningItem = { ...a, id: crypto.randomUUID(), title: "Design", phase: "design", discipline: "physics", kind: "deliverable", module: "building-model", dependsOn: [a.id] };
  const input = { expectedRevision: 0, currentPhase: null, items: [a, b] };
  const audits = async () => Number((await pool.query("SELECT count(*) FROM planning_test_audit")).rows[0].count);
  try {
    // Minimal parent fixture is local to this disposable namespace. Apply the
    // actual additive migration, including its FK and uniqueness constraint.
    await pool.query("CREATE TABLE projects_projects (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)");
    await pool.query("INSERT INTO projects_projects VALUES ($1,$2),($3,$2)", [project, tenant, secondProject]);
    await pool.query("CREATE TABLE planning_test_audit (id integer GENERATED ALWAYS AS IDENTITY)");
    await pool.query(await Bun.file(new URL("../drizzle/0052_project_planning.sql", import.meta.url)).text());

    expect((await call()).body.data).toEqual({ revision: 0, currentPhase: null, items: [] });
    expect((await pool.query("SELECT * FROM project_planning")).rowCount).toBe(0);
    expect(await audits()).toBe(0);
    for (const body of [undefined, input]) {
      expect((await call(body, { "x-permissions": "" })).status).toBe(403);
      expect((await call(body, { "x-tenant": otherTenant })).status).toBe(404);
      expect((await call(body, {}, `/projects/${crypto.randomUUID()}/planning`)).status).toBe(404);
      expect((await call(body, {}, "/projects/invalid/planning")).status).toBe(400);
    }
    expect((await call(input, { "x-permissions": "projects:read" })).status).toBe(403);
    expect((await call(undefined, { "x-permissions": "projects:write" })).status).toBe(403);
    // Both concurrent first creation and existing-row edits must have one winner.
    const first = await Promise.all([call(input), call(input)]);
    expect(first.map(r => r.status).sort()).toEqual([200, 409]);
    expect(first.find(r => r.status === 409)!.body.error.code).toBe("planning_conflict");
    expect(await audits()).toBe(1);
    expect((await call()).body.data).toEqual({ revision: 1, currentPhase: null, items: [a, b] });
    expect((await call(undefined, {}, `/projects/${secondProject}/planning`)).body.data.revision).toBe(0);

    const completed = { ...input, expectedRevision: 1, items: [{ ...a, status: "done" }, b] };
    const edits = await Promise.all([call(completed), call(completed)]);
    expect(edits.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await call()).body.data).toEqual({ revision: 2, currentPhase: null, items: completed.items });
    // Completing a plot item leaves the design item and actual phase untouched.
    const phaseChange = { ...completed, expectedRevision: 2, currentPhase: "concept" };
    expect((await call(phaseChange)).body.data.currentPhase).toBe("concept");
    const current = { ...phaseChange, expectedRevision: 3 };
    expect((await call({ ...current, items: [a] })).body.error.code).toBe("planning_items_required");
    expect((await call({ ...current, items: [{ ...a, dependsOn: [crypto.randomUUID()] }, b] })).status).toBe(400);
    expect((await call({ ...current, items: [{ ...a, dependsOn: [b.id] }, b] })).status).toBe(400);
    expect((await call({ ...current, items: [a, a] })).status).toBe(400);
    expect((await call({ ...current, items: [{ ...a, dueDate: "2026-02-30" }, b] })).status).toBe(400);
    expect((await call({ ...current, items: [{ ...a, archived: true }, b] })).status).toBe(400);
    expect(await audits()).toBe(3);
    const archived = { ...current, items: [{ ...a, archived: true }, { ...b, archived: true }] };
    expect((await call(archived)).status).toBe(200);
    expect((await call({ ...archived, expectedRevision: 4, items: [] })).status).toBe(400);
    expect((await call()).body.data).toEqual({ revision: 4, currentPhase: "concept", items: archived.items });
    failAudit = true;
    expect((await call({ ...archived, expectedRevision: 4, currentPhase: "permit" })).status).toBe(500);
    expect((await call()).body.data.revision).toBe(4);
    expect((await call()).body.data.currentPhase).toBe("concept");
    expect(await audits()).toBe(4);
  } finally {
    server.closeAllConnections(); server.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${namespace} CASCADE`);
    await admin.end();
  }
});
