import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { knowledgeDeps } from "../richtfest-os/apps/api/src/app-hosts";
import { workspaceRouter } from "../richtfest-apps/knowledge/src/workspace";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const integration = process.env.DATABASE_URL ? test : test.skip;
integration("workspace returns scoped historical citation names and terminal child diagnostics; PDF renders exact revision", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID(), actor = crypto.randomUUID();
  const project = crypto.randomUUID(), otherProject = crypto.randomUUID(), file = crypto.randomUUID(), otherFile = crypto.randomUUID();
  const source = crypto.randomUUID(), latest = crypto.randomUUID(), foreign = crypto.randomUUID();
  const thread = crypto.randomUUID(), artifact = crypto.randomUUID(), revision = crypto.randomUUID();
  const parent = crypto.randomUUID(), child = crypto.randomUUID(), unrelated = crypto.randomUUID();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { id: actor, tenantId: req.headers["x-other"] ? otherTenant : tenant, permissions: new Set(["knowledge:read", "knowledge:write", "projects:read"]) };
    next();
  });
  app.use(workspaceRouter(req => knowledgeDeps(db, req)));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 500).json({ error: e.code ?? "failed" }));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const directory = await mkdtemp(join(tmpdir(), "workspace-output-"));
  try {
    await pool.query(`insert into projects_projects(id,tenant_id,name,created_by) values($1,$3,'Own',$4),($2,$3,'Other project',$4)`, [project, otherProject, tenant, actor]);
    await pool.query(`insert into projects_files(id,tenant_id,project_id,name,source_type,created_by) values($1,$5,$3,'Schallschutz Müller.pdf','upload',$6),($2,$5,$4,'PRIVATE OTHER PROJECT.pdf','upload',$6)`, [file, otherFile, project, otherProject, tenant, actor]);
    for (const [id, fileId, version] of [[source, file, 1], [latest, file, 2], [foreign, otherFile, 1]])
      await pool.query(`insert into projects_file_versions(id,tenant_id,file_id,version,status,created_by) values($1,$2,$3,$4,'ready',$5)`, [id, tenant, fileId, version, actor]);
    await pool.query(`insert into knowledge_conversations(id,tenant_id,project_id,title,created_by) values($1,$2,$3,'Test',$4)`, [thread, tenant, project, actor]);
    const content = `## Maßnahmen\n\n| Bauteil | Anforderung |\n| --- | --- |\n| Decke | R′w ≥ 53 dB |\n\nQuelle [${source}]. Nicht verfügbar [${foreign}].`;
    await pool.query(`insert into knowledge_artifacts(id,tenant_id,project_id,title,type,created_by) values($1,$2,$3,'Concept','draft',$4)`, [artifact, tenant, project, actor]);
    await pool.query(`insert into knowledge_artifact_revisions(id,tenant_id,artifact_id,version,title,content,source_version_ids,created_by) values($1,$2,$3,1,'Concept',$4,$5,$6)`, [revision, tenant, artifact, content, JSON.stringify([source, foreign]), actor]);
    await pool.query(`insert into knowledge_messages(tenant_id,conversation_id,author_id,actor_kind,body,source_version_ids) values($1,$2,$3,'agent',$4,$5)`, [tenant, thread, actor, `Draft ready [${source}].`, JSON.stringify([source, foreign])]);
    for (const [id, owner] of [[parent, null], [child, parent], [unrelated, null]])
      await pool.query(`insert into knowledge_agent_runs(id,tenant_id,project_id,conversation_id,parent_run_id,specialist_role,goal,provider,status,error,requested_by,correlation_id) values($1,$2,$3,$4,$5,$6,'Test','openai',$7,'phase=specialist; category=validation',$8,$9)`, [id, tenant, project, thread, owner, owner ? "source_reviewer" : null, owner ? "cancelled" : "failed", actor, crypto.randomUUID()]);
    for (const [owner, time] of [[child, "2026-01-01"], [unrelated, "2026-01-02"]])
      await pool.query(`insert into knowledge_agent_run_events(tenant_id,run_id,event_type,result_summary,params_summary,created_at) values($1,$2,'provider_call_failed','specialist',$3,$4)`, [tenant, parent, JSON.stringify({ runId: owner, callId: crypto.randomUUID(), attempt: 3, diagnostics: { errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", issues: [{ code: "too_big", path: ["summary"], maximum: 10000, message: "SECRET" }] } }), time]);
    const details = (await (await fetch(`${url}/artifacts/${artifact}`)).json() as any).data;
    expect(details.revisions[0].sourceReferences).toEqual([{ versionId: source, fileName: "Schallschutz Müller.pdf", version: 1 }]);
    const messages = (await (await fetch(`${url}/conversations/${thread}/messages`)).json() as any).data.items;
    expect(messages[0].sourceReferences).toEqual(details.revisions[0].sourceReferences);
    const workspace = (await (await fetch(`${url}/workspaces/${project}`)).json() as any).data;
    const failed = workspace.runs.find((run: any) => run.id === parent);
    expect(failed.failureRole).toBe("source_reviewer");
    expect(JSON.parse(failed.failureEvent.paramsSummary).runId).toBe(child);
    expect(failed.failureEvent.paramsSummary).not.toContain("SECRET");
    const secondThread = crypto.randomUUID();
    await pool.query(`insert into knowledge_conversations(id,tenant_id,project_id,title,created_by) values($1,$2,$3,'Other thread',$4)`, [secondThread, tenant, project, actor]);
    await pool.query(`update knowledge_artifacts set run_id=$1 where id=$2`, [child, artifact]);
    await pool.query(`update knowledge_agent_runs set created_at='2020-01-01' where id=$1`, [child]);
    for (let index = 0; index < 51; index++)
      await pool.query(`insert into knowledge_agent_runs(tenant_id,project_id,conversation_id,goal,provider,status,requested_by,correlation_id) values($1,$2,$3,'Newer unrelated run','openai','failed',$4,$5)`, [tenant, project, secondThread, actor, crypto.randomUUID()]);
    const scoped = (await (await fetch(`${url}/workspaces/${project}`)).json() as any).data;
    expect(scoped.runs.some((run: any) => run.id === child)).toBe(false);
    expect(scoped.artifacts[0]).toMatchObject({ id: artifact, conversationId: thread, runId: child, preview: content.slice(0, 500), version: 1 });
    const noteBody = { projectId: project, artifactRevisionId: revision, body: "Verify the requirement before revising.", quote: "Maßnahmen", selection: { start: 0, end: 9 } };
    const note = async (body: any, headers = {}) => fetch(`${url}/annotations`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await note({ ...noteBody, conversationId: secondThread })).status).toBe(409);
    expect((await note(noteBody, { "x-other": "1" })).status).toBe(404);
    const savedResponse = await note(noteBody);
    expect(savedResponse.status).toBe(201);
    const saved = (await savedResponse.json() as any).data;
    expect(saved.message.conversationId).toBe(thread);
    const annotated = (await (await fetch(`${url}/artifacts/${artifact}`)).json() as any).data;
    expect(annotated.artifact.conversationId).toBe(thread);
    expect(annotated.annotations).toHaveLength(1);
    expect(annotated.annotations[0]).toMatchObject({ artifactRevisionId: revision, quote: "Maßnahmen", selection: { start: 0, end: 9 }, messageId: saved.message.id });
    const pdf = await fetch(`${url}/artifacts/${artifact}/revisions/${revision}/pdf`);
    expect(pdf.status).toBe(200);
    await writeFile(join(directory, "result.pdf"), Buffer.from(await pdf.arrayBuffer()));
    const extracted = Bun.spawnSync(["pdftotext", "-layout", join(directory, "result.pdf"), "-"]);
    expect(extracted.exitCode).toBe(0);
    expect(extracted.stdout.toString()).toContain("Schallschutz Müller.pdf · v1");
    expect(extracted.stdout.toString()).toContain("R′w ≥ 53 dB");
    expect(extracted.stdout.toString()).not.toContain("PRIVATE OTHER PROJECT");
    expect(extracted.stdout.toString()).not.toContain(source);
    expect((await fetch(`${url}/artifacts/${artifact}`, { headers: { "x-other": "1" } })).status).toBe(404);
    expect((await fetch(`${url}/artifacts/${artifact}/revisions/${revision}/pdf`, { headers: { "x-other": "1" } })).status).toBe(404);
    // Exact saved payload drives attachments; foreign and unavailable sources fail closed.
    const conceptPayload = (versionId: string) => ({ template: {
      id: "exterior-noise-concept", version: 1,
      attachments: [{ versionId, pageStart: 1, pageEnd: 1, label: "Plan", section: "plans" }],
    } });
    await pool.query(`update projects_file_versions set mime_type='application/pdf', storage_key=$2 where id in ($1,$3)`, [source, `missing-${crypto.randomUUID()}.pdf`, foreign]);
    const deps = knowledgeDeps(db, { actor: { id: actor, tenantId: tenant, permissions: new Set(["knowledge:read", "projects:read"]) } } as any);
    expect(await deps.readSourcePdf!(project, foreign)).toBeNull();
    expect(await deps.readSourcePdf!(project, crypto.randomUUID())).toBeNull();
    for (const versionId of [foreign, source]) {
      await pool.query(`update knowledge_artifact_revisions set payload=$2 where id=$1`, [revision, JSON.stringify(conceptPayload(versionId))]);
      const failedExport = await fetch(`${url}/artifacts/${artifact}/revisions/${revision}/pdf`);
      expect(failedExport.status).toBe(422);
      expect(await failedExport.json()).toEqual({ error: "invalid_pdf_attachment" });
    }
  } finally {
    server.close();
    for (const table of ["os_audit_events", "knowledge_annotations", "knowledge_agent_run_events", "knowledge_agent_runs", "knowledge_messages", "knowledge_conversations", "knowledge_artifact_revisions", "knowledge_artifacts", "projects_file_versions", "projects_files", "projects_projects"])
      await pool.query(`delete from ${table} where tenant_id=$1`, [tenant]);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
