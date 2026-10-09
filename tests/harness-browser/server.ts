/** Isolated acceptance server. Synthetic responses are never enabled by app environment flags. */
import path from "node:path";
import { randomBytes } from "node:crypto";
const settings = await Bun.file("/tmp/richtfest-harness-test-env.json").json();
if (!new URL(settings.DATABASE_URL).hostname.match(/^(127\.0\.0\.1|localhost)$/)) throw new Error("Local fixture database required");
settings.AI_CONNECTION_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
await Bun.write("/tmp/richtfest-harness-test-env.json", JSON.stringify(settings));
Object.assign(process.env, settings);
const { default: express } = await import("../../richtfest-os/apps/api/node_modules/express");
const { createDatabase } = await import("../../richtfest-os/apps/api/src/db/client");
const { createApp } = await import("../../richtfest-os/apps/api/src/server");
const { startSupervisorWorker, backgroundKnowledgeDeps } = await import("../../richtfest-os/apps/api/src/supervisor-worker");
const { permissions } = await import("../../richtfest-shared/src/index");
const { db, pool } = createDatabase(settings.DATABASE_URL);
const saved = await Bun.file("/tmp/richtfest-harness-browser.json").exists() ? await Bun.file("/tmp/richtfest-harness-browser.json").json() : null;
const existing = saved && (await pool.query("select id from os_tenants where id=$1",[saved.tenantId])).rowCount;
const tenantId = existing ? saved.tenantId : crypto.randomUUID(), actorId = existing ? saved.actorId : crypto.randomUUID(), roleId = crypto.randomUUID();
const email = existing ? saved.email : `harness-${actorId.slice(0,8)}@richtfest.local`;
if (!existing) {
await pool.query("insert into os_tenants(id,name) values($1,$2)", [tenantId,"Harness acceptance — synthetic local data"]);
await pool.query("insert into os_users(id,email,name) values($1,$2,$3)", [actorId,email,"Harness QA admin"]);
// Auth schema names and columns are owned by the existing authentication integration.
const { authUser } = await import("../../richtfest-os/apps/api/src/db/auth-schema");
await db.insert(authUser).values({ id:actorId,email,name:"Harness QA admin",emailVerified:true });
await pool.query("insert into os_roles(id,tenant_id,name) values($1,$2,$3)",[roleId,tenantId,"Harness administrator"]);
await pool.query("insert into os_memberships(tenant_id,user_id,role_id) values($1,$2,$3)",[tenantId,actorId,roleId]);
for(const permission of permissions) await pool.query("insert into os_role_permissions(role_id,permission) values($1,$2)",[roleId,permission]);

}

const executeSupervisor: NonNullable<import("../../richtfest-apps/knowledge/src/deps").AppDeps["executeSupervisor"]> = async input => {
  await new Promise(resolve=>setTimeout(resolve,input.phase === "specialist" ? 6000 : 1200));
  if(input.phase === "plan") return {status:"completed",output:{tasks:[
    {role:"source_reviewer",goal:"Synthetic QA: identify available evidence",sourceVersionIds:[]},
    {role:"requirements_reviewer",goal:"Synthetic QA: list missing requirements",sourceVersionIds:[]},
  ]}};
  if(input.phase === "specialist") return {status:"completed",output:{summary:`Synthetic QA result: ${input.goal}. No customer sources were analyzed.`,rationale:"Local acceptance fixture only.",citations:[]}};
  return {status:"completed",output:{decision:"accept",summary:"Synthetic QA supervisor reviewed both specialist results. This verifies the workflow; it is not a construction assessment.",rationale:"Both bounded assignments completed.",citations:[],revisions:[]}};
};
const application = createApp(db,{allowDevAuth:true,providerFetch:async()=>{throw new Error("Live provider calls disabled in QA");},supervisorRuntime:{supervisorEnabled:true,executeSupervisor}});
const app=express();
app.use((req,res,next)=> req.path.startsWith("/api/")||req.path.startsWith("/docs") ? application(req,res,next) : next());
const web=path.resolve(import.meta.dir,"../../richtfest-os/apps/web/dist");
app.use(express.static(web));
app.get("*",(_req,res)=>res.sendFile(path.join(web,"index.html")));
const server=app.listen(Number(settings.PORT),"127.0.0.1");
const worker=await startSupervisorWorker(db,pool,{enabled:true,databaseUrl:settings.DATABASE_URL,resolveDeps:async(t,a)=>({...await backgroundKnowledgeDeps(db,t,a),executeSupervisor})});
await Bun.write("/tmp/richtfest-harness-browser.json",JSON.stringify({email,tenantId,actorId,url:`http://localhost:${settings.PORT}`}));
console.log(`Synthetic harness acceptance server ready at http://localhost:${settings.PORT}`);
process.once("SIGTERM",()=>{void worker.stop().then(()=>{server.close();return pool.end();});});
