import { test, expect } from "bun:test";
import express from "express";
import { createRouter as projectsRouter } from "@richtfest/projects";
import { createRouter as knowledgeRouter } from "@richtfest/knowledge";
import { dashboardSummary } from "@richtfest/knowledge";
import { createDatabase } from "./db/client";

const url = process.env.DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
(local ? test : test.skip)("project responsibility preserves access; task review is tracking only", async () => {
  const schema = `responsibility_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(url!);
  await admin.pool.query(`create schema ${schema}`);
  const isolated = new URL(url!);
  isolated.searchParams.set("options", `-c search_path=${schema}`);
  const { db, pool } = createDatabase(isolated.href);
  const tenant = crypto.randomUUID(), other = crypto.randomUUID(), actor = crypto.randomUUID(), delegate = crypto.randomUUID(), project = crypto.randomUUID(), task = crypto.randomUUID();
  let permitted = true;
  const audits: string[] = [];
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    await pool.query(`create table projects_projects (id uuid primary key, tenant_id uuid, customer_id uuid, name text, street text, postal_code text, city text, country text, address_reference jsonb, status text, created_by uuid, created_at timestamptz default now());
      create table projects_members (project_id uuid, tenant_id uuid, user_id uuid, access text, created_at timestamptz default now(), primary key(project_id,user_id));
      create table knowledge_tasks (id uuid primary key default gen_random_uuid(), tenant_id uuid, project_id uuid, conversation_id uuid, title text, status text default 'open', assignee_type text, assignee_id uuid, created_by uuid, created_at timestamptz default now());
      create table knowledge_drafts (id uuid, tenant_id uuid, project_id uuid, category_id uuid, display_title text, source_label text, chapter text, title text, body text, status text, source_refs jsonb, created_by uuid, approved_by uuid, approved_at timestamptz, created_at timestamptz default now());`);
    await pool.query(await Bun.file(new URL("../drizzle/0058_project_responsibility.sql", import.meta.url)).text());
    await pool.query("insert into projects_projects(id,tenant_id,name,status,created_by) values($1,$2,'Disposable','planning',$3)", [project, tenant, actor]);
    await pool.query("insert into projects_members(project_id,tenant_id,user_id,access) values($1,$2,$3,'owner')", [project, tenant, actor]);
    const originalMembers = (await pool.query("select * from projects_members")).rows;
    await pool.query("insert into knowledge_tasks(id,tenant_id,project_id,title,status,assignee_type,assignee_id,created_by) values($1,$2,$3,'Check source geometry','open','user',$4,$5)", [task, tenant, project, delegate, actor]);
    const deps: any = { db, tenantId: tenant, actorId: actor,
      requirePermission: () => { if (!permitted) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
      validateUser: async (id: string) => id === actor || id === delegate,
      validateProject: async (id: string) => id === project,
      audit: async (_tx: any, action: string) => { audits.push(action); },
    };
    const app = express(); app.use(express.json());
    app.use("/projects", projectsRouter(() => deps));
    app.use("/knowledge", knowledgeRouter(() => deps));
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 400).json({ message: err.message }));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const patch = (path: string, body: unknown) => fetch(base + path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const assigned = await patch(`/projects/projects/${project}`, { leadId: actor, delegateId: delegate });
    expect(assigned.status).toBe(200);
    expect((await assigned.json()).data).toMatchObject({ leadId: actor, delegateId: delegate });
    expect((await pool.query("select lead_id, delegate_id from projects_projects where id=$1", [project])).rows[0]).toEqual({ lead_id: actor, delegate_id: delegate });
    expect((await patch(`/projects/projects/${project}`, { leadId: null, delegateId: other })).status).toBe(404);
    expect((await pool.query("select lead_id, delegate_id from projects_projects where id=$1", [project])).rows[0]).toEqual({ lead_id: actor, delegate_id: delegate });
    await Promise.all([patch(`/projects/projects/${project}`, { leadId: delegate }), patch(`/projects/projects/${project}`, { leadId: actor })]);
    const members = (await pool.query("select * from projects_members")).rows;
    expect(members).toEqual(originalMembers);
    expect([actor, delegate]).toContain((await pool.query("select lead_id from projects_projects where id=$1", [project])).rows[0].lead_id);
    expect((await patch(`/projects/projects/${project}`, { delegateId: other })).status).toBe(404);
    expect((await patch(`/knowledge/tasks/${task}`, { assigneeId: other })).status).toBe(404);
    expect((await patch(`/knowledge/tasks/${task}`, { status: "needs_review" })).status).toBe(200);
    const summary = await dashboardSummary(db, tenant);
    expect(summary.tasks.map((row: any) => row.id)).toContain(task);
    expect(summary.reviewTasks.map((row: any) => row.id)).toEqual([task]);
    expect((await dashboardSummary(db, other)).tasks).toHaveLength(0);
    expect(summary.pendingDrafts).toHaveLength(0);
    expect((await patch(`/knowledge/tasks/${task}`, { status: "approved" })).status).toBe(400);
    permitted = false;
    expect((await patch(`/knowledge/tasks/${task}`, { status: "completed" })).status).toBe(403);
    expect((await patch(`/projects/projects/${project}`, { leadId: null })).status).toBe(403);
    permitted = true;
    expect((await patch(`/projects/projects/${project}`, { leadId: null })).status).toBe(200);
    expect((await pool.query("select lead_id, delegate_id from projects_projects where id=$1", [project])).rows[0]).toEqual({ lead_id: null, delegate_id: delegate });
    expect((await patch(`/projects/projects/${project}`, { delegateId: null })).status).toBe(200);
    expect((await pool.query("select lead_id, delegate_id from projects_projects where id=$1", [project])).rows[0]).toEqual({ lead_id: null, delegate_id: null });
    expect((await pool.query("select * from projects_members")).rows).toEqual(originalMembers);
    expect((await patch(`/knowledge/tasks/${task}`, { status: "completed" })).status).toBe(200);
    expect((await dashboardSummary(db, tenant)).reviewTasks).toHaveLength(0);
    // Explicitly unassigned review work must not silently become the creator's assignment.
    const postTask = (body: unknown) => fetch(`${base}/knowledge/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const unassignedResponse = await postTask({ title: "Awaiting engineer account", projectId: project, assigneeId: null });
    expect(unassignedResponse.status).toBe(201);
    const unassigned = (await unassignedResponse.json()).data;
    expect(unassigned).toMatchObject({ assigneeType: "user", assigneeId: null, projectId: project });
    expect((await patch(`/knowledge/tasks/${unassigned.id}`, { status: "needs_review" })).status).toBe(200);
    expect((await dashboardSummary(db, tenant)).reviewTasks).toMatchObject([{ id: unassigned.id, assigneeId: null }]);
    expect((await patch(`/knowledge/tasks/${unassigned.id}`, { assigneeId: delegate })).status).toBe(200);
    const cleared = await patch(`/knowledge/tasks/${unassigned.id}`, { assigneeId: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data).toMatchObject({ assigneeType: "user", assigneeId: null });
    const defaulted = await postTask({ title: "Default remains creator", projectId: project });
    expect(defaulted.status).toBe(201);
    expect((await defaulted.json()).data.assigneeId).toBe(actor);
    expect(audits).toContain("projects.project.updated");
    expect(audits).toContain("knowledge.task.updated");
    expect(audits).toContain("knowledge.task.created");
  } finally {
    server?.close(); await pool.end();
    await admin.pool.query(`drop schema ${schema} cascade`); await admin.pool.end();
  }
});
