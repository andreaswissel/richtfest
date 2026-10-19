import { Router, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { evidenceRequestSchema, planLinesRequestSchema } from "./evidence";
import { siteEvidenceProposals } from "./schema";
import { mapLocationSchema, resolveAssessmentLocation } from "./site-location";
import { lookupSiteContext } from "./berlin-site-context";
const uuid = z.string().uuid();
const error = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
export function createEvidenceRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  const deps = async (req: Request, write = false) => {
    const d=getDeps(req); d.requirePermission(write ? "projects:write" : "projects:read");
    const projectId=uuid.parse(req.params.projectId);
    if (!await d.project(projectId)) throw error(404,"not_found","Project not found");
    if (!d.evidence) throw error(503,"not_configured","Source interpretation is unavailable");
    return {d, projectId, host:d.evidence};
  };
  router.get("/projects/:projectId/evidence",async(req,res,next)=>{try{
    const {d,projectId,host}=await deps(req);
    const [sources,proposals]=await Promise.all([host.listSources(projectId),d.db.select().from(siteEvidenceProposals).where(and(eq(siteEvidenceProposals.tenantId,d.tenantId),eq(siteEvidenceProposals.projectId,projectId))).orderBy(desc(siteEvidenceProposals.createdAt)).limit(100)]);
    res.json(ok({sources,proposals,canWrite:d.can("projects:write"),canInterpret:d.can("projects:write")&&d.can("agent:run")}));
  }catch(e){next(e);}});
  router.post("/projects/:projectId/evidence/import",async(req,res,next)=>{try{
    const {d,projectId,host}=await deps(req,true);
    const {url}=z.object({url:z.string().url().max(2000),mapOrigin:mapLocationSchema.shape.mapOrigin.optional(),mapLabel:mapLocationSchema.shape.mapLabel.optional()}).strict().parse(req.body);
    const signal=AbortSignal.timeout(15000);
    const context=await lookupSiteContext(await resolveAssessmentLocation(d,projectId,req.body,signal),signal);
    if(!context.plans.some(p=>p.documentUrl===url||p.explanationUrl===url))throw error(422,"unverified_plan_url","Select a document from the current official plan lookup");
    res.json(ok(await host.importOfficialPdf(projectId,url)));
  }catch(e){next(e);}});
  router.post("/projects/:projectId/evidence/interpret",async(req,res,next)=>{try{
    const {d,projectId,host}=await deps(req,true); d.requirePermission("agent:run");
    const input=evidenceRequestSchema.parse(req.body);
    if(!(await host.listSources(projectId)).some(s=>s.versionId===input.versionId))throw error(404,"not_found","PDF revision not found in project");
    const proposal=await d.db.transaction(async(tx:any)=>{
        if (!(await d.project(projectId, tx))) throw error(404, "not_found", "Project not found");
      const [row]=await tx.insert(siteEvidenceProposals).values({tenantId:d.tenantId,projectId,versionId:input.versionId,provider:input.provider,status:"running",request:input,createdBy:d.actorId}).returning();
      await d.audit(tx,"feasibility.evidence.started","site_evidence_proposal",row.id,{projectId,versionId:input.versionId,provider:input.provider,pages:input.pages});return row;
    });
    let values:any;
    try { const result=await host.interpret(projectId,input); values=result.status==="completed"?{status:result.status,payload:result.output,model:result.model}:{status:"unconfigured",error:"Connect a personal or workspace credential for the selected provider"}; }
    catch { values={status:"failed",error:"Source interpretation failed. Check page availability and provider connection, then retry. No values were applied."}; }
    const saved=await d.db.transaction(async(tx:any)=>{
        if (!(await d.project(projectId, tx))) throw error(404, "not_found", "Project not found");
      const [row]=await tx.update(siteEvidenceProposals).set(values).where(and(eq(siteEvidenceProposals.id,proposal.id),eq(siteEvidenceProposals.tenantId,d.tenantId))).returning();
      await d.audit(tx,"feasibility.evidence.completed","site_evidence_proposal",row.id,{projectId,status:row.status});return row;
    });res.json(ok(saved));
  }catch(e){next(e);}});
  // Traces Baugrenzen and Baulinien on an aligned plan page as an unreviewed proposal; the client maps them onto the site and a person corrects the corners.
  router.post("/projects/:projectId/evidence/lines",async(req,res,next)=>{try{
    const {d,projectId,host}=await deps(req,true); d.requirePermission("agent:run");
    if(!host.traceLines)throw error(503,"not_configured","Plan line tracing is unavailable");
    const input=planLinesRequestSchema.parse(req.body);
    if(!(await host.listSources(projectId)).some(s=>s.versionId===input.versionId))throw error(404,"not_found","PDF revision not found in project");
    const proposal=await d.db.transaction(async(tx:any)=>{
      if (!(await d.project(projectId, tx))) throw error(404, "not_found", "Project not found");
      const [row]=await tx.insert(siteEvidenceProposals).values({tenantId:d.tenantId,projectId,versionId:input.versionId,provider:input.provider,status:"running",request:{kind:"lines",...input},createdBy:d.actorId}).returning();
      await d.audit(tx,"feasibility.plan_lines.started","site_evidence_proposal",row.id,{projectId,versionId:input.versionId,provider:input.provider,page:input.page});return row;
    });
    let values:any;
    try { const result=await host.traceLines(projectId,input); values=result.status==="completed"?{status:result.status,payload:result.output,model:result.model}:{status:"unconfigured",error:"Connect a personal or workspace credential for the selected provider"}; }
    catch { values={status:"failed",error:"Plan line tracing failed. Check the page and provider connection, then retry. No geometry was changed."}; }
    const saved=await d.db.transaction(async(tx:any)=>{
      if (!(await d.project(projectId, tx))) throw error(404, "not_found", "Project not found");
      const [row]=await tx.update(siteEvidenceProposals).set(values).where(and(eq(siteEvidenceProposals.id,proposal.id),eq(siteEvidenceProposals.tenantId,d.tenantId))).returning();
      await d.audit(tx,"feasibility.plan_lines.completed","site_evidence_proposal",row.id,{projectId,status:row.status});return row;
    });res.json(ok(saved));
  }catch(e){next(e);}});
  router.post("/projects/:projectId/evidence/proposals/:proposalId/review",async(req,res,next)=>{try{
    const {d,projectId}=await deps(req,true);const proposalId=uuid.parse(req.params.proposalId);
    const input=z.object({index:z.number().int().min(0).max(19),collection:z.enum(["constraints","planningFacts"]).default("constraints"),decision:z.enum(["adopted","rejected"])}).strict().parse(req.body);
    const saved=await d.db.transaction(async(tx:any)=>{
        if (!(await d.project(projectId, tx))) throw error(404, "not_found", "Project not found");
      const [row]=await tx.select().from(siteEvidenceProposals).where(and(eq(siteEvidenceProposals.id,proposalId),eq(siteEvidenceProposals.tenantId,d.tenantId),eq(siteEvidenceProposals.projectId,projectId))).for("update");
      if(!row||row.status!=="completed"||!row.payload?.[input.collection]?.[input.index])throw error(404,"not_found","Proposal not found");
      const dispositions={...row.dispositions,[`${input.collection}:${input.index}`]:{decision:input.decision,actorId:d.actorId,at:new Date().toISOString()}};
      const [updated]=await tx.update(siteEvidenceProposals).set({dispositions}).where(eq(siteEvidenceProposals.id,row.id)).returning();
      await d.audit(tx,"feasibility.evidence.reviewed","site_evidence_proposal",row.id,{projectId,index:input.index,collection:input.collection,decision:input.decision});return updated;
    });
    const claim=saved.payload[input.collection][input.index];
    const source=`/projects/${projectId}?panel=documents&sourceVersion=${saved.versionId}&page=${claim.page} · proposal ${saved.id} · ${claim.evidenceKind==="text"?claim.quote:claim.reason}`.slice(0,2000);
    res.json(ok({proposal:saved,collection:input.collection,constraint:input.decision==="adopted"?{key:claim.key,value:{value:claim.value,source,sourceDate:null,kind:"assessment",reviewed:false}}:null}));
  }catch(e){next(e);}});
  return router;
}
