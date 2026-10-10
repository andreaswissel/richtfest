import { expect, test } from "bun:test";
import express from "express";
import { sql } from "drizzle-orm";
import { createRouter } from "@richtfest/projects";
import { runLocationJob } from "@richtfest/projects/location-worker";
import { createDatabase } from "./db/client";

const url = process.env.DATABASE_URL;
// Never run this mutation-based integration test against a remote database.
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
(local ? test : test.skip)("location API persists scenes, scopes tenants/permissions, fences revisions and recovers durable jobs", async () => {
  const schema = `location_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!);
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const isolatedUrl = new URL(url!); isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const { db, pool } = createDatabase(isolatedUrl.href);
  const tenant = crypto.randomUUID(), other = crypto.randomUUID(), project = crypto.randomUUID(), actor = crypto.randomUUID();
  let auditCount = 0;
  const app = express(); app.use(express.json());
  app.use("/api", createRouter(req => ({ db, tenantId: req.headers["x-test-tenant"] === "other" ? other : tenant, actorId: actor,
    requirePermission(permission) { if (req.headers["x-test-access"] === "none" || (permission === "projects:write" && req.headers["x-test-access"] === "read")) throw Object.assign(new Error("Forbidden"), { status:403 }); },
    audit: async (tx, action, _type, id) => { await tx.execute(sql`insert into test_audit (action, project_id) values (${action}, ${id})`); auditCount++; },
    validateCustomer: async () => false, customerNames: async () => ({}), fileStorage: {} as any,
  })));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ data:null, error:{code:error.code}, message:error.message }));
  const server = app.listen(0), base = `http://127.0.0.1:${(server.address() as any).port}/api/projects/${project}/location`;
  const request = async (suffix = "", method = "GET", body?: unknown, headers: Record<string,string> = {}) => {
    const r = await fetch(base+suffix, { method, headers: { "content-type":"application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status:r.status, body:await r.json() };
  };
  try {
    await pool.query(`CREATE TABLE projects_projects (id uuid primary key, tenant_id uuid, name text, created_by uuid, status text, customer_id uuid, created_at timestamptz);
      CREATE TABLE test_audit (action text, project_id uuid)`);
    await pool.query(await Bun.file(new URL("../drizzle/0023_project_locations.sql", import.meta.url)).text());
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Location test',$3)", [project,tenant,actor]);
    expect((await request()).body.data).toMatchObject({ revision:0, scene:{objects:[],planningNotes:""}, context:null, contextJob:{status:"idle"}, lidarJob:{status:"idle"} });
    for (const [suffix,method,body] of [["","GET",undefined],["","PUT",{revision:0,scene:{objects:[],planningNotes:"x"}}],["/import","POST",{siteId:"berlin-giersstrasse-20"}],["/lidar","POST",{}],["/lidar","GET",undefined]] as const) {
      expect((await request(suffix,method,body,{"x-test-tenant":"other"})).status).toBe(404);
      expect((await request(suffix,method,body,{"x-test-access":"none"})).status).toBe(403);
    }
    expect((await request("","PUT",{revision:0,scene:{objects:[],planningNotes:"x"}},{"x-test-access":"read"})).status).toBe(403);
    expect((await request("/lidar","POST",{})).status).toBe(409);
    const input = { revision:0,scene:{objects:[],planningNotes:"Durable notes"} };
    const results = await Promise.all([request("","PUT",input),request("","PUT",input)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await request()).body.data).toMatchObject({ revision:1,scene:input.scene });
    expect((await request("/import","POST",{siteId:"wrong"})).status).toBe(400);
    const before = auditCount, queued = await request("/import","POST",{siteId:"berlin-giersstrasse-20"});
    expect(queued.status).toBe(202); expect(queued.body.data.contextJob.status).toBe("queued"); expect(queued.body.data.revision).toBe(1);
    expect((await request("/import","POST",{siteId:"berlin-giersstrasse-20"})).body.data.contextJob.status).toBe("queued"); expect(auditCount).toBe(before+1);
    // Simulated abrupt stop: database retains an expired running job. An aborted
    // upstream request avoids network dependency while exercising claim/recovery.
    await pool.query("update projects_locations set context_status='running', lease_token=$1, lease_until=now()-interval '1 minute'",[crypto.randomUUID()]);
    const controller = new AbortController(); controller.abort();
    const worker = { db, audit: async (tx: any, _tenant: string, action: string, id: string) => { await tx.execute(sql`insert into test_audit (action,project_id) values (${action},${id})`); }, reportError: () => {} };
    expect(await runLocationJob(worker,controller.signal)).toBe(true);
    const recovered = (await request()).body.data; expect(recovered.contextJob.status).toBe("queued"); expect(recovered.contextJob.error).toBeNull(); expect(recovered.scene).toEqual(input.scene);
    // An inconsistent source record fails honestly without inventing a cloud.
    await pool.query("update projects_locations set context_status='ready',lidar_status='queued'");
    expect(await runLocationJob(worker,new AbortController().signal)).toBe(true);
    expect((await request()).body.data.lidarJob).toMatchObject({status:"failed",error:"Location context missing; import first"});
    await pool.query("update projects_locations set context_status='failed'");
    expect((await request("/import","POST",{siteId:"berlin-giersstrasse-20"})).body.data.contextJob.status).toBe("queued");
    await pool.query("update projects_locations set context_status='running',lease_until=now()+interval '1 minute'");
    expect(await runLocationJob(worker,controller.signal)).toBe(false);
    const context = { siteId:"berlin-giersstrasse-20", origin:[397139.418,5824134.851], radius:100 }, cloud = { positions:[0,0,0], classifications:[2], groundElevation:40, sourcePointCount:1, sampled:false, surveyedAt:"2021", sourceUrl:"https://gdi.berlin.de" };
    await pool.query("update projects_locations set context=$1,context_status='ready',lease_until=null",[JSON.stringify(context)]);
    expect((await request("/lidar","POST",{})).body.data.lidarJob.status).toBe("queued");
    expect((await request("/lidar")).status).toBe(409);
    await pool.query("update projects_locations set cloud=$1,lidar_status='ready'",[JSON.stringify(cloud)]);
    expect((await request("/lidar")).body.data).toEqual(cloud);
    expect((await request()).body.data.cloud).toBeUndefined();
    expect(Number((await pool.query("select count(*) from test_audit")).rows[0].count)).toBeGreaterThan(3);
    await pool.query(`CREATE TABLE projects_files (id uuid primary key, tenant_id uuid, project_id uuid);
      CREATE TABLE projects_file_versions (file_id uuid, tenant_id uuid, version integer, status text)`);
    const sourceId = crypto.randomUUID();
    await pool.query("insert into projects_files values ($1,$2,$3)", [sourceId, tenant, project]);
    await pool.query("insert into projects_file_versions values ($1,$2,1,'ready')", [sourceId, tenant]);
    const scene = { objects: [{ id: "ifc", kind: "ifc", label: "Source", note: "", position: [-7.5,0,9.25], size: [3,4,2], rotation: 30, source: { fileId: sourceId, version: 1 } }], planningNotes: "Source-linked IFC" };
    expect((await request("", "PUT", { revision: 1, scene })).status).toBe(200);
    expect((await request()).body.data.scene).toEqual(scene);
    for (const [query, args] of [
      ["update projects_files set tenant_id=$1", [other]],
      ["update projects_files set tenant_id=$1, project_id=$2", [tenant, crypto.randomUUID()]],
      ["update projects_files set project_id=$1; update projects_file_versions set status='pending'", [project]],
    ] as [string, string[]][]) {
      // Separate statements because PostgreSQL prepared queries accept one command.
      for (const statement of query.split(";")) await pool.query(statement, statement.includes("$1") ? args : []);
      expect((await request("", "PUT", { revision: 2, scene })).status).toBe(404);
      expect((await request()).body.data.revision).toBe(2);
    }
  } finally { server.close(); await pool.end(); await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`); await admin.pool.end(); }
}, 30000);
