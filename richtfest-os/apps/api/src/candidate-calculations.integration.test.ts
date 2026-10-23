import { expect, test } from "bun:test";
import express from "express";
import { createBuildingModelRouter } from "@richtfest/projects/building-model";
import { createDatabase } from "./db/client";

const url = process.env.BUILDING_EXTRACTION_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
(local ? test : test.skip)("candidate preview is tenant-scoped and read-only, including canonical geometry", async () => {
  const namespace = `candidate_preview_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!);
  await admin.pool.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(isolated.href);
  const [tenant, other, actor, project, model, building, storey, file, version, job, room] = Array.from({ length: 11 }, () => crypto.randomUUID());
  const app = express(); app.use(express.json());
  let audits = 0;
  app.use(createBuildingModelRouter(req => ({ db, tenantId: req.headers["x-other"] ? other : tenant, actorId: actor,
    requirePermission() { if (req.headers["x-denied"]) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
    audit: async () => { audits++; },
  }) as any));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 400).json({ message: e.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model`;
  const post = (body: unknown, headers = {}) => fetch(`${base}/calculation-preview`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    for (const table of ["projects_projects", "projects_files", "projects_file_versions", "projects_source_extractions", "projects_source_models", "projects_source_pages",
      ...(await admin.pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'projects_building_%'")).rows.map(r => r.tablename)]) {
      if (!/^projects_[a-z_]+$/.test(table)) throw new Error("Unexpected table");
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'Preview test',$3)", [project, tenant, actor]);
    await pool.query("insert into projects_building_models (id,tenant_id,project_id,created_by) values ($1,$2,$3,$4)", [model, tenant, project, actor]);
    await pool.query("insert into projects_building_buildings (id,tenant_id,model_id,stable_key,name,created_by) values ($1,$2,$3,'building','Building',$4)", [building, tenant, model, actor]);
    await pool.query("insert into projects_building_storeys (id,tenant_id,model_id,building_id,stable_key,name,created_by) values ($1,$2,$3,$4,'storey','Storey',$5)", [storey, tenant, model, building, actor]);
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,created_by) values ($1,$2,$3,'plan.pdf','upload',$4)", [file, tenant, project, actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','test','application/pdf',$4)", [version, tenant, file, actor]);
    await pool.query("insert into projects_building_plan_sources (tenant_id,model_id,storey_id,source_version_id,page,created_by) values ($1,$2,$3,$4,2,$5)", [tenant, model, storey, version, actor]);
    await pool.query("insert into projects_building_extractions (id,tenant_id,model_id,storey_id,source_version_id,page,extractor_version,status,result,created_by) values ($1,$2,$3,$4,$5,2,'test','complete',$6,$7)",
      [job, tenant, model, storey, version, JSON.stringify({ pageScale: { metresPerPageHeight: 10, pageAspectRatio: 2 } }), actor]);
    const geometry = { source: { sourceVersionId: version, page: 2 }, quality: "manual_outline",
      polygon: [{ x: .1, y: .2 }, { x: .3, y: .2 }, { x: .3, y: .5 }, { x: .1, y: .5 }] };
    await pool.query("insert into projects_building_rooms (id,tenant_id,model_id,storey_id,stable_key,name,geometry,created_by) values ($1,$2,$3,$4,'room','Room',$5,$6)", [room, tenant, model, storey, JSON.stringify(geometry), actor]);
    const scope = { sourceVersionId: version, page: 2, storeyId: storey };
    const before = await (await fetch(base)).json();
    expect((await post(scope, { "x-other": "1" })).status).toBe(404);
    expect((await post(scope, { "x-denied": "1" })).status).toBe(403);
    expect((await post({ ...scope, page: 3 })).status).toBe(422);
    expect((await post({ ...scope, approve: true })).status).toBe(400);
    const response = await post(scope);
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result.reviewStatus).toBe("unreviewed");
    expect(result.geometry[0].id).toBe(room);
    expect(result.geometry[0].areaM2).toBeCloseTo(12);
    expect(result.geometry[0].clearHeight).toBeNull();
    expect(await (await fetch(base)).json()).toEqual(before);
    expect(audits).toBe(0);
  } finally {
    server.close(); await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end();
  }
});
