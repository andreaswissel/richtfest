import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { createAgentPresetsRouter, resolveAgentPreset } from "../richtfest-os/apps/api/src/agent-presets";
import { withSupervisorCancellation, cancelSupervisorExecution } from "../richtfest-os/apps/api/src/supervisor-execution";
import { agentPresetConfigSchema } from "../richtfest-shared/src/index";
import { agentProfilesRouter, defaultProfiles, snapshotAgentProfiles } from "../richtfest-apps/knowledge/src/agent-profiles";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";
const integration = process.env.DATABASE_URL ? test : test.skip;
const model = {modelId:"test-model",maxOutputTokens:1024,maxSteps:2};
const policy = {supervisor:model,specialists:{source_reviewer:model,requirements_reviewer:model},maxParallel:2,maxTasks:3,maxRevisions:1};

integration("supported agent profiles save and reload independently without changing existing guidance", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const deps = { db, tenantId, actorId, requirePermission: () => {}, audit: async () => {} } as unknown as AppDeps;
  const app = express();
  app.use(express.json());
  app.use(agentProfilesRouter(() => deps));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: "rejected" }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const profile of defaultProfiles()) {
      const response = await fetch(`${base}/agent-profiles/${profile.key}`, { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: `Guidance for ${profile.key}`, triggerPhrases: [profile.key], knowledgeIds: [] }) });
      expect(response.status).toBe(200);
    }
    const snapshot = await snapshotAgentProfiles(deps);
    const response: any = await (await fetch(`${base}/agent-profiles`)).json();
    for (const profile of response.data.profiles) {
      expect(profile.instructions).toBe(`Guidance for ${profile.key}`);
      expect(profile.version).toBe(1);
    }
    const updated = await fetch(`${base}/agent-profiles/sound_insulation`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Revised acoustic guidance", triggerPhrases: [], knowledgeIds: [] }) });
    expect(updated.status).toBe(200);
    const after: any = await (await fetch(`${base}/agent-profiles`)).json();
    expect(after.data.profiles.find((p: any) => p.key === "sound_insulation").version).toBe(2);
    expect(after.data.profiles.find((p: any) => p.key === "source_reviewer").instructions).toBe("Guidance for source_reviewer");
    expect(snapshot.find(p => p.key === "sound_insulation")!.instructions).toBe("Guidance for sound_insulation");
  } finally {
    server.close();
    await pool.query("delete from knowledge_agent_profiles where tenant_id=$1", [tenantId]);
    await pool.end();
  }
});

integration("workspace presets enforce admin/provider boundaries and snapshot versioned policy",async()=>{
  const {db,pool}=createDatabase(process.env.DATABASE_URL!);
  const tenantId=crypto.randomUUID(),actorId=crypto.randomUUID(),otherTenant=crypto.randomUUID();
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{(req as any).actor={id:actorId,tenantId:req.headers["x-test-other"]?otherTenant:tenantId,permissions:new Set(req.headers["x-test-readonly"]?[]:["access:manage"])};next();});
  app.use(createAgentPresetsRouter(db));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??400).json({error:"rejected"}));
  const server=app.listen(0);
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const put=(body:any,headers:Record<string,string>={},provider="openai")=>fetch(`${base}/agent/presets/${provider}/medium`,{method:"PUT",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
  try{
    expect((await put(policy,{"x-test-readonly":"1"})).status).toBe(403);
    expect((await put({...policy,maxParallel:8})).status).toBe(400);
    expect((await put({...policy,supervisor:{...model,reasoningEffort:"high"}},{},"anthropic")).status).toBe(400);
    expect((await put(policy)).status).toBe(200);
    const snapshot=await resolveAgentPreset(db,tenantId,"medium","openai");
    expect(snapshot.version).toBe(1);
    expect((await put({...policy,supervisor:{...model,modelId:"new-model"}})).status).toBe(200);
    const updated=await resolveAgentPreset(db,tenantId,"medium","openai");
    expect(updated.version).toBe(2);
    expect(snapshot.supervisor.modelId).toBe("test-model");
    const other=await (await fetch(`${base}/agent/presets?provider=openai`,{headers:{"x-test-other":"1"}})).json() as any;
    expect(other.data.presets.every((p:any)=>p.source==="vendor")).toBe(true);
    await fetch(`${base}/agent/presets/openai/medium`,{method:"DELETE"});
    const reset=await (await fetch(`${base}/agent/presets?provider=openai`)).json() as any;
    expect(reset.data.presets.find((p:any)=>p.effort==="medium").version).toBe(3);
    expect(reset.data.presets.find((p:any)=>p.effort==="medium").source).toBe("vendor");
    expect(agentPresetConfigSchema.safeParse({...policy,supervisor:{...model,reasoningEffort:"ultra"}}).success).toBe(false);
  }finally{server.close();await pool.query("delete from os_agent_presets where tenant_id=$1",[tenantId]);await pool.query("delete from os_audit_events where tenant_id=$1",[tenantId]);await pool.end();}
});

integration("Mastra model calls abort on persisted cancellation or steering and deny revoked access",async()=>{
  const {db,pool}=createDatabase(process.env.DATABASE_URL!);
  const tenantId=crypto.randomUUID(),actorId=crypto.randomUUID(),roleId=crypto.randomUUID(),runId=crypto.randomUUID();
  try{
    await pool.query("insert into os_tenants(id,name) values($1,'Cancellation test')",[tenantId]);
    await pool.query("insert into os_users(id,email,name) values($1,$2,'Cancellation test')",[actorId,`${actorId}@fixture.invalid`]);
    await pool.query("insert into os_roles(id,tenant_id,name) values($1,$2,'Test')",[roleId,tenantId]);
    await pool.query("insert into os_memberships(tenant_id,user_id,role_id) values($1,$2,$3)",[tenantId,actorId,roleId]);
    for(const permission of ["richtfest-os:use","agent:run","knowledge:read","knowledge:write","projects:read"])await pool.query("insert into os_role_permissions(role_id,permission) values($1,$2)",[roleId,permission]);
    await pool.query("insert into knowledge_agent_runs(id,tenant_id,goal,provider,status,correlation_id,requested_by) values($1,$2,'Test','openai','running',$3,$4)",[runId,tenantId,crypto.randomUUID(),actorId]);
    await pool.query("insert into knowledge_supervisor_runs(run_id,tenant_id,model_policy,lease_until) values($1,$2,$3,now()+interval '1 hour')",[runId,tenantId,JSON.stringify({...policy,effort:"medium",provider:"openai",source:"vendor",version:1})]);
    const waitForAbort=(signal:AbortSignal)=>new Promise<boolean>(resolve=>{signal.addEventListener("abort",()=>resolve(true),{once:true});});
    expect(await withSupervisorCancellation(db,tenantId,actorId,runId,async signal=>{
      const waiting=waitForAbort(signal);
      await pool.query("update knowledge_agent_runs set status='cancelled' where id=$1",[runId]);
      return waiting;
    })).toBe(true);
    await pool.query("update knowledge_agent_runs set status='running' where id=$1",[runId]);
    expect(await withSupervisorCancellation(db,tenantId,actorId,runId,async signal=>{
      const waiting=waitForAbort(signal);await pool.query("update knowledge_supervisor_runs set generation=generation+1 where run_id=$1",[runId]);return waiting;
    })).toBe(true);
    expect(await withSupervisorCancellation(db,tenantId,actorId,runId,async signal=>{const waiting=waitForAbort(signal);cancelSupervisorExecution(runId);return waiting;})).toBe(true);
    await pool.query("delete from os_role_permissions where role_id=$1 and permission='projects:read'",[roleId]);
    let invoked=false;
    await expect(withSupervisorCancellation(db,tenantId,actorId,runId,async()=>{invoked=true;})).rejects.toThrow("access");
    expect(invoked).toBe(false);
  }finally{
    await pool.query("delete from knowledge_supervisor_runs where run_id=$1",[runId]);await pool.query("delete from knowledge_agent_runs where id=$1",[runId]);
    await pool.query("delete from os_role_permissions where role_id=$1",[roleId]);await pool.query("delete from os_memberships where tenant_id=$1",[tenantId]);await pool.query("delete from os_roles where id=$1",[roleId]);await pool.query("delete from os_users where id=$1",[actorId]);await pool.query("delete from os_tenants where id=$1",[tenantId]);await pool.end();
  }
},10000);
