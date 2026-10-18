import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createRouter } from "@richtfest/feasibility";
import type { AppDeps } from "@richtfest/feasibility/deps";
import { createEmptySiteAssessmentInput } from "@richtfest/shared";

// Explicit opt-in; never uses the application's DATABASE_URL or modifies its data.
const url = process.env.SITE_ASSESSMENT_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Site assessment integration tests require a dedicated _test database");
const suite = url ? describe : describe.skip;
suite("site assessment PostgreSQL API", () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  const tenantId = crypto.randomUUID(), otherTenant = crypto.randomUUID(), projectId = crypto.randomUUID(), actorId = crypto.randomUUID();
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let origin = "";
  let failAudit = false;
  beforeAll(async () => {
    await pool.query("CREATE TABLE IF NOT EXISTS site_assessment_test_audit (tenant_id uuid, entity_id uuid, metadata jsonb)");
    const app = express(); app.use(express.json());
    app.use(createRouter(req => ({
      db, tenantId: req.headers["x-other-tenant"] ? otherTenant : tenantId, actorId,
      requirePermission: permission => { if (permission === "projects:write" && req.headers["x-read-only"]) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
      can: () => !req.headers["x-read-only"],
      project: async id => id === projectId && !req.headers["x-other-tenant"] ? { id, name: "Local test", address: "Berlin" } : null,
      siteFigures: async () => ({ parcelArea: null, grz: null, gfz: null, existingGrossFloorArea: null }),
      audit: async (tx, _action, _type, entityId, metadata) => {
        if (failAudit) throw new Error("Audit unavailable");
        await tx.execute(sql`INSERT INTO site_assessment_test_audit VALUES (${tenantId}::uuid, ${entityId}::uuid, ${JSON.stringify(metadata)}::jsonb)`);
      },
    } as AppDeps)));
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? (err.name === "ZodError" ? 400 : 500)).json({ error: err.code ?? err.message }));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(async () => {
    await pool.query("DELETE FROM feasibility_site_assessments WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM site_assessment_test_audit WHERE tenant_id = $1", [tenantId]);
    await new Promise<void>(resolve => server.close(() => resolve())); await pool.end();
  });
  const request = (input?: unknown, headers: Record<string,string> = {}) => fetch(`${origin}/projects/${projectId}/site-assessment`, { method: input ? "PUT" : "GET", headers: { "content-type": "application/json", ...headers }, body: input ? JSON.stringify(input) : undefined });
  test("defaults, scope, access, concurrency, snapshots and atomic audit rollback", async () => {
    const initial = await (await request()).json(); expect(initial.data.assessment.revision).toBe(0); expect(initial.data.result.status).toBe("incomplete");
    const input = createEmptySiteAssessmentInput();
    expect((await request({ ...input, constraints: {} })).status).toBe(400);
    expect((await request({ ...input, constraints: { ...input.constraints, parcelArea: { ...input.constraints.parcelArea, value: "NaN" } } })).status).toBe(400);
    expect((await request({ ...input, jurisdiction: "BY" })).status).toBe(400);
    expect((await request(input, { "x-read-only": "1" })).status).toBe(403);
    expect((await request(undefined, { "x-other-tenant": "1" })).status).toBe(404);
    expect((await request(input, { "x-other-tenant": "1" })).status).toBe(404);
    const first = await Promise.all([request({ ...input, notes: "first" }), request({ ...input, notes: "racing" })]);
    expect(first.map(r => r.status).sort()).toEqual([200, 409]);
    const loaded = (await (await request()).json()).data;
    const saved = loaded.assessment; expect(saved.revision).toBe(1);
    expect(loaded.result.missing).not.toContain("");
    expect(loaded.result.missing).toContain("constraints.parcelArea.value");
    const revision2 = { ...input, baseRevision: 1, notes: "second" };
    const updates = await Promise.all([request(revision2), request(revision2)]);
    expect(updates.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await request(revision2)).status).toBe(409);
    failAudit = true;
    expect((await request({ ...input, baseRevision: 2, notes: "must roll back" })).status).toBe(500);
    failAudit = false;
    expect((await (await request()).json()).data.assessment).toMatchObject({ revision: 2, notes: "second" });
    const revisions = await pool.query("SELECT revision, input FROM feasibility_site_assessment_revisions WHERE tenant_id=$1 ORDER BY revision", [tenantId]);
    expect(revisions.rows.map(r => r.revision)).toEqual([1, 2]);
    expect(revisions.rows[0].input.notes).toBe(saved.notes); expect(revisions.rows[1].input.notes).toBe("second");
    expect(revisions.rows[0].input.baseRevision).toBeUndefined();
    const audit = await pool.query("SELECT * FROM site_assessment_test_audit WHERE tenant_id=$1", [tenantId]); expect(audit.rowCount).toBe(2);
  });
});
