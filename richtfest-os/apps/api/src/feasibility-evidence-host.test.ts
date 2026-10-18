import { expect, test } from "bun:test";
import crypto from "node:crypto";
import { createDatabase } from "./db/client";
import { env } from "./env";
import { vendorPreset } from "./agent-presets";
import { createFeasibilityEvidenceHost } from "./feasibility-evidence-host";
import type { AppDeps } from "@richtfest/projects/deps";
const url=process.env.SITE_ASSESSMENT_TEST_DATABASE_URL;
const local=url&&["localhost","127.0.0.1"].includes(new URL(url).hostname)&&new URL(url).pathname.endsWith("_test");
(local?test:test.skip)("planning interpreter uses exact project pages and personal-before-workspace provider credentials",async()=>{
 const schema=`evidence_test_${crypto.randomUUID().replaceAll("-","")}`;
 const admin=createDatabase(url!);await admin.pool.query(`CREATE SCHEMA ${schema}`);
 const isolated=new URL(url!);isolated.searchParams.set("options",`-c search_path=${schema}`);const {db,pool}=createDatabase(isolated.href);
 const tenantId=crypto.randomUUID(),actorId=crypto.randomUUID(),projectId=crypto.randomUUID(),fileId=crypto.randomUUID(),versionId=crypto.randomUUID();
 const key=crypto.randomBytes(32),oldEncryption=env.AI_CONNECTION_ENCRYPTION_KEY;env.AI_CONNECTION_ENCRYPTION_KEY=key.toString("base64");
 let output:any={constraints:[{key:"grz",value:.4,page:2,quote:"GRZ 0,4",reason:"Use table requires applicability review",evidenceKind:"text"}],planningFacts:[],limitations:[]};let headers:Headers;let calls=0;let body:any;
 const host=createFeasibilityEvidenceHost(db,{tenantId,actorId} as AppDeps,async(_url,init)=>{calls++;headers=new Headers(init.headers);body=JSON.parse(init.body as string);return Response.json({model:body.model,content:[{type:"text",text:JSON.stringify(output)}]});});
 const input={versionId,pages:[2],provider:"anthropic" as const,visual:false};
 const credential=async(user:string|null,value:string)=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv);const data=Buffer.concat([cipher.update(value),cipher.final()]);await pool.query("INSERT INTO os_ai_connections VALUES($1,$2,$3,'anthropic',$4,$5,$6,$7,now())",[crypto.randomUUID(),tenantId,user,data.toString("base64"),iv.toString("base64"),cipher.getAuthTag().toString("base64"),actorId]);};
 try{
  await pool.query(`CREATE TABLE projects_files(id uuid,tenant_id uuid,project_id uuid,name text,source_type text,purpose text,source_ref text,document_type text,document_type_reviewed_by uuid,document_type_reviewed_at timestamptz,created_by uuid,created_at timestamptz);
  CREATE TABLE projects_file_versions(id uuid,tenant_id uuid,file_id uuid,version int,status text,source_metadata jsonb,checksum text,storage_key text,size_bytes int,mime_type text,created_by uuid,created_at timestamptz);
  CREATE TABLE projects_source_pages(tenant_id uuid,version_id uuid,page int,content jsonb);
  CREATE TABLE os_ai_connections(id uuid,tenant_id uuid,user_id uuid,provider text,ciphertext text,iv text,auth_tag text,created_by uuid,updated_at timestamptz);
  CREATE TABLE os_agent_presets(id uuid,tenant_id uuid,provider text,effort text,version int,config jsonb,updated_by uuid,updated_at timestamptz);`);
  await pool.query("INSERT INTO projects_files(id,tenant_id,project_id,name) VALUES($1,$2,$3,'Plan.pdf')",[fileId,tenantId,projectId]);
  await pool.query("INSERT INTO projects_file_versions(id,tenant_id,file_id,version,status,storage_key,mime_type) VALUES($1,$2,$3,1,'ready','key','application/pdf')",[versionId,tenantId,fileId]);
  await pool.query("INSERT INTO projects_source_pages VALUES($1,$2,2,$3)",[tenantId,versionId,JSON.stringify({status:"available",text:"GRZ 0,4",truncated:false})]);
  expect(await host.interpret(projectId,input)).toEqual({status:"unconfigured"});expect(calls).toBe(0);
  const config=vendorPreset("anthropic","high");config.supervisor.modelId="test-model";config.specialists.source_reviewer.modelId="test-model";config.specialists.requirements_reviewer.modelId="test-model";
  await pool.query("INSERT INTO os_agent_presets VALUES($1,$2,'anthropic','high',1,$3,$4,now())",[crypto.randomUUID(),tenantId,JSON.stringify(config),actorId]);
  await credential(null,"workspace-secret");await credential(actorId,"personal-secret");
  expect(await host.interpret(projectId,input)).toMatchObject({status:"completed",output});expect(headers!.get("x-api-key")).toBe("personal-secret");
  expect(JSON.parse(body.messages[0].content).context.pages).toEqual([{page:2,text:"GRZ 0,4"}]);
  await expect(host.interpret(crypto.randomUUID(),input)).rejects.toThrow("PDF revision not found");
  output={...output,constraints:[{...output.constraints[0],quote:"invented"}]};await expect(host.interpret(projectId,input)).rejects.toThrow("quote");
  await pool.query("DELETE FROM os_ai_connections WHERE user_id=$1",[actorId]);output={constraints:[],planningFacts:[],limitations:[]};await host.interpret(projectId,input);expect(headers!.get("x-api-key")).toBe("workspace-secret");
 }finally{env.AI_CONNECTION_ENCRYPTION_KEY=oldEncryption;await pool.end();await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);await admin.pool.end();}
});
test("official plan import accepts only the Berlin and named district plan hosts",async()=>{
 const host=createFeasibilityEvidenceHost({} as never,{} as AppDeps);
 for(const url of ["https://gis-broker.de/bplaene/a.pdf","https://evil.gis-broker.de/bplaene/a.pdf","https://mitte.gis-broker.de.evil.example/a.pdf","http://mitte.gis-broker.de/bplaene/a.pdf"])
  await expect(host.importOfficialPdf("p",url)).rejects.toThrow("approved official Berlin hosts");
 // An allowed host passes the host check and fails only at the (stubbed) download.
 const original=globalThis.fetch;globalThis.fetch=(async()=>new Response(null,{status:404})) as unknown as typeof fetch;
 try{await expect(host.importOfficialPdf("p","https://mitte.gis-broker.de/bplaene/0100062a.pdf")).rejects.toThrow("unavailable");}finally{globalThis.fetch=original;}
});
