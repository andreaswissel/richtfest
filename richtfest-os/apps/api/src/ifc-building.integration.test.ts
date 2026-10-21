import { expect, test } from "bun:test";
import express from "express";
import { createBuildingModelRouter } from "@richtfest/projects/building-model";
import { createDatabase } from "./db/client";

const url = process.env.BUILDING_EXTRACTION_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

(local ? test : test.skip)("IFC preview/import: source isolation, atomic draft, explicit storeys, retries and stale revisions", async () => {
  const namespace = `ifc_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!); await admin.pool.query(`CREATE SCHEMA ${namespace}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(isolated.href);
  const tenant = crypto.randomUUID(), project = crypto.randomUUID(), actor = crypto.randomUUID(), file = crypto.randomUUID(), version = crypto.randomUUID();
  const bytes = new Uint8Array(await Bun.file(new URL("../../../../richtfest-apps/projects/src/fixtures/building-model.ifc", import.meta.url)).arrayBuffer());
  let allow = true, failAudit = false;
  const app = express(); app.use(express.json());
  app.use(createBuildingModelRouter(() => ({ db, tenantId: tenant, actorId: actor,
    requirePermission: () => { if (!allow) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
    audit: async () => { if (failAudit) throw new Error("audit unavailable"); }, validateCustomer: async () => false, customerNames: async () => ({}),
    fileStorage: { read: async () => (async function* () { yield bytes; })() } as any })));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/projects/${project}/building-model/ifc`;
  const call = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const count = async (table: string) => Number((await pool.query(`select count(*) n from ${table}`)).rows[0].n);
  try {
    for (const table of ["projects_projects", "projects_files", "projects_file_versions", "projects_building_models", "projects_building_buildings", "projects_building_storeys", "projects_building_rooms", "projects_building_elements", "projects_building_revisions"])
      await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await pool.query("insert into projects_projects (id,tenant_id,name,created_by) values ($1,$2,'IFC test',$3)", [project, tenant, actor]);
    await pool.query("insert into projects_files (id,tenant_id,project_id,name,source_type,created_by) values ($1,$2,$3,'model.ifc','upload',$4)", [file, tenant, project, actor]);
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,1,'ready','test','application/x-ifc',$4)", [version, tenant, file, actor]);
    const input = { sourceVersionId: version, baseRevision: 0, storeyExpressIds: [20] };
    allow = false; expect((await call("preview", input)).status).toBe(403); allow = true;
    expect((await call("preview", { sourceVersionId: crypto.randomUUID() })).status).toBe(404);
    await pool.query("update projects_files set tenant_id=$1", [crypto.randomUUID()]);
    expect((await call("import", input)).status).toBe(404);
    await pool.query("update projects_files set tenant_id=$1", [tenant]);
    await pool.query("update projects_files set project_id=$1", [crypto.randomUUID()]);
    expect((await call("preview", input)).status).toBe(404);
    await pool.query("update projects_files set project_id=$1", [project]);
    await pool.query("update projects_file_versions set status='pending'");
    expect((await call("import", input)).status).toBe(404);
    await pool.query("update projects_file_versions set status='ready'");
    const preview = await call("preview", { sourceVersionId: version }); expect(preview.status).toBe(200);
    expect((await preview.json()).data.entities.filter((e: any) => e.entityType === "storey")).toHaveLength(2);
    expect(await count("projects_building_models")).toBe(0);
    expect((await call("import", { ...input, storeyExpressIds: [] })).status).toBe(400);
    expect((await call("import", { ...input, storeyExpressIds: [999] })).status).toBe(422);
    expect((await call("import", { ...input, storeyExpressIds: [25] })).status).toBe(422);
    failAudit = true; expect((await call("import", input)).status).toBe(500); failAudit = false;
    expect(await count("projects_building_models")).toBe(0);
    const concurrent = await Promise.all([call("import", input), call("import", input)]);
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 201]);
    expect(await count("projects_building_models")).toBe(1);
    expect(await count("projects_building_storeys")).toBe(1);
    expect(await count("projects_building_rooms")).toBe(1);
    expect(await count("projects_building_elements")).toBe(2);
    expect(await count("projects_building_revisions")).toBe(1);
    const room = (await pool.query("select * from projects_building_rooms")).rows[0];
    expect(room).toMatchObject({ name: "Room with shaft · Room", construction_state: "unknown", room_use: null });
    expect(room.geometry).toMatchObject({ coordinateSpace: "ifc-metre", source: { kind: "ifc", sourceVersionId: version, expressId: 30, globalId: "room" } });
    await pool.query("update projects_building_rooms set name='Reviewed name'");
    expect((await call("import", input)).status).toBe(200);
    expect((await pool.query("select name from projects_building_rooms")).rows[0].name).toBe("Reviewed name");
    expect((await call("import", { ...input, storeyExpressIds: [20, 25] })).status).toBe(409);
    const second = crypto.randomUUID();
    await pool.query("insert into projects_file_versions (id,tenant_id,file_id,version,status,storage_key,mime_type,created_by) values ($1,$2,$3,2,'ready','test','application/x-ifc',$4)", [second, tenant, file, actor]);
    expect((await call("import", { ...input, sourceVersionId: second })).status).toBe(409);
    expect(await count("projects_building_buildings")).toBe(1);
    expect((await call("import", { ...input, sourceVersionId: second, baseRevision: 1 })).status).toBe(201);
    expect(await count("projects_building_buildings")).toBe(2);
    expect((await pool.query("select name from projects_building_rooms where id=$1", [room.id])).rows[0].name).toBe("Reviewed name");
  } finally {
    server.close(); await pool.end(); await admin.pool.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.pool.end();
  }
}, 30_000);
