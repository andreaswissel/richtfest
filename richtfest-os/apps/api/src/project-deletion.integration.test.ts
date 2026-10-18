import { expect, test } from "bun:test";
import express from "express";
import { createRouter } from "@richtfest/projects";
import { deleteProjectKnowledge } from "@richtfest/knowledge/project-deletion";
import { deleteProjectFeasibility } from "@richtfest/feasibility/project-deletion";
import { runProjectDeletionCleanup } from "@richtfest/projects/project-deletion-worker";
import { createDatabase } from "./db/client";

const url = process.env.PROJECT_DELETION_TEST_DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
(local ? test : test.skip)("project deletion is tenant-scoped, transactional and retries object cleanup after commit", async () => {
  const namespace = `project_deletion_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!);
  await admin.pool.query(`create schema ${namespace}`);
  const isolated = new URL(url!); isolated.searchParams.set("options", `-c search_path=${namespace}`);
  const { db, pool } = createDatabase(isolated.href);
  const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID(), actor = crypto.randomUUID();
  let allowed = true, failAudit = false, failStorage = true;
  const removed: string[] = [];
  const fileStorage = { remove: async (key: string) => { if (failStorage) throw new Error("bucket unavailable"); removed.push(key); } } as any;
  const deps = () => ({ db, tenantId: tenant, actorId: actor, requirePermission: (permission: string) => {
    expect(permission).toBe("projects:write"); if (!allowed) throw Object.assign(new Error("Forbidden"), { status: 403 });
  }, audit: async (tx: any, action: string, _kind: string, id: string) => {
    if (failAudit) throw new Error("audit failed");
    await tx.execute((await import("drizzle-orm")).sql`insert into test_audits values (${action}, ${id})`);
  }, deleteLinkedProjectData: async (tx: any, projectId: string, sourceIds: string[]) => {
    const keys = await deleteProjectKnowledge(tx, tenant, projectId, sourceIds); await deleteProjectFeasibility(tx, tenant, projectId); return keys;
  }, validateCustomer: async () => true, customerNames: async () => ({}), fileStorage });
  const app = express(); app.use(express.json()); app.use(createRouter(deps));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? (e.name === "ZodError" ? 400 : 500)).json({ error: { code: e.code }, message: e.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const root = `http://127.0.0.1:${(server.address() as any).port}`;
  const remove = (id: string) => fetch(`${root}/projects/${id}`, { method: "DELETE" });
  const count = async (table: string) => Number((await pool.query(`select count(*) from ${table}`)).rows[0].count);
  try {
    // Clone real table definitions and their foreign keys into a disposable schema.
    const tables = (await admin.pool.query("select tablename from pg_tables where schemaname='public' and (tablename = 'project_planning' or tablename like 'projects_%' or tablename like 'knowledge_%' or tablename like 'feasibility_%')")).rows;
    for (const { tablename } of tables) await pool.query(`create table ${tablename} (like public.${tablename} including all)`);
    const constraints = (await admin.pool.query("select c.conname,t.relname,pg_get_constraintdef(c.oid) definition from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' and c.contype='f' and (t.relname = 'project_planning' or t.relname like 'projects_%' or t.relname like 'knowledge_%' or t.relname like 'feasibility_%')")).rows;
    for (const c of constraints) await pool.query(`alter table ${c.relname} add constraint ${c.conname} ${c.definition.replaceAll('public.', namespace + '.')}`);
    await pool.query("create table test_audits(action text, id uuid)");
    const project = crypto.randomUUID(), foreign = crypto.randomUUID(), file = crypto.randomUUID(), version = crypto.randomUUID(), chat = crypto.randomUUID(), model = crypto.randomUUID();
    await pool.query("insert into projects_projects(id,tenant_id,name,created_by) values($1,$2,'Delete fixture',$3),($4,$5,'Other tenant',$3)", [project,tenant,actor,foreign,otherTenant]);
    await pool.query("insert into project_planning(tenant_id,project_id,items) values($1,$2,'[]')", [tenant,project]);
    await pool.query("insert into projects_members(project_id,tenant_id,user_id) values($1,$2,$3)", [project,tenant,actor]);
    await pool.query("insert into projects_files(id,tenant_id,project_id,name,source_type,created_by) values($1,$2,$3,'plan.pdf','upload',$4)",[file,tenant,project,actor]);
    await pool.query("insert into projects_file_versions(id,tenant_id,file_id,version,status,storage_key,created_by) values($1,$2,$3,1,'pending','fixture-key',$4)",[version,tenant,file,actor]);
    expect((await remove(foreign)).status).toBe(404);
    allowed = false; expect((await remove(project)).status).toBe(403); allowed = true;
    expect((await remove("invalid")).status).toBe(400);
    expect((await remove(project)).status).toBe(409);
    expect(await count("projects_files")).toBe(1);
    await pool.query("update projects_file_versions set status='ready'");
    await pool.query("insert into projects_building_models(id,tenant_id,project_id,created_by) values($1,$2,$3,$4)",[model,tenant,project,actor]);
    await pool.query("insert into projects_building_buildings(tenant_id,model_id,stable_key,name,created_by) values($1,$2,'b','Building',$3)",[tenant,model,actor]);
    await pool.query("insert into knowledge_conversations(id,tenant_id,project_id,title,created_by) values($1,$2,$3,'Chat',$4)",[chat,tenant,project,actor]);
    await pool.query("insert into knowledge_messages(tenant_id,conversation_id,author_id,body) values($1,$2,$3,'hello')",[tenant,chat,actor]);
    await pool.query("insert into knowledge_tasks(tenant_id,project_id,conversation_id,title,created_by) values($1,$2,$3,'Task',$4)",[tenant,project,chat,actor]);
    await pool.query("insert into feasibility_studies(tenant_id,project_id,site,scenarios,created_by,updated_by) values($1,$2,'{}','[]',$3,$3)",[tenant,project,actor]);
    const run = crypto.randomUUID();
    await pool.query("insert into knowledge_agent_runs(id,tenant_id,project_id,conversation_id,goal,provider,status,correlation_id,requested_by) values($1,$2,$3,$4,'Test','openai','running',$1,$5)",[run,tenant,project,chat,actor]);
    const busy = await remove(project); expect(busy.status).toBe(409); expect((await busy.json()).error.code).toBe("project_busy");
    await pool.query("update knowledge_agent_runs set status='unconfigured' where id=$1",[run]);
    const sharedDraft = crypto.randomUUID();
    await pool.query("insert into knowledge_drafts(id,tenant_id,title,body,source_refs,created_by) values($1,$2,'Shared','Evidence',$3,$4)",[sharedDraft,tenant,JSON.stringify([file]),actor]);
    const referenced = await remove(project); expect(referenced.status).toBe(409); expect((await referenced.json()).error.code).toBe("project_sources_in_use");
    await pool.query("delete from knowledge_drafts where id=$1",[sharedDraft]);
    failAudit = true; expect((await remove(project)).status).toBe(500); failAudit = false;
    expect(await count("knowledge_messages")).toBe(1);
    expect(await count("projects_deleted_objects")).toBe(0);
    expect((await remove(project)).status).toBe(200);
    expect(await count("projects_projects")).toBe(1);
    for (const table of ["project_planning","projects_files","projects_file_versions","projects_members","projects_building_models","projects_building_buildings","knowledge_conversations","knowledge_messages","knowledge_tasks","feasibility_studies"])
      expect(await count(table)).toBe(0);
    expect(await count("test_audits")).toBe(1);
    expect(await count("projects_deleted_objects")).toBe(1);
    expect(removed).toEqual([]);
    const worker = { db, fileStorage, reportError() {} };
    expect(await runProjectDeletionCleanup(worker)).toBe(false);
    expect(await count("projects_deleted_objects")).toBe(1);
    expect((await pool.query("select attempts from projects_deleted_objects")).rows[0].attempts).toBe(1);
    failStorage = false; await pool.query("update projects_deleted_objects set retry_at=now() - interval '1 second'");
    expect(await runProjectDeletionCleanup(worker)).toBe(true);
    expect(removed).toEqual(["fixture-key"]);
    expect(await count("projects_deleted_objects")).toBe(0);
    expect((await remove(project)).status).toBe(404);
  } finally {
    server.closeAllConnections(); server.close(); await pool.end();
    await admin.pool.query(`drop schema ${namespace} cascade`); await admin.pool.end();
  }
}, 30000);
