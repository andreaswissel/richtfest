import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ok, buildingExtractionRequestSchema, buildingExtractionReviewSchema } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { buildingModels, buildingStoreys, buildingRooms, buildingElements, buildingExtractionJobs as jobs, buildingExtractionCandidates as candidates,
  buildingRevisions, buildingReconciliations, buildingProposals, buildingReviews, buildingSupersededSources, fileVersions, files } from "./schema";
import { reviewedCandidateGeometry } from "./room-use-classifier";
import { buildingExtractorVersion } from "./plan-extraction";
import { candidateOutlinesOverlap, candidateReviewScore, candidateReviewScoreVersion } from "./candidate-review-score";

const uuid=z.string().uuid();
const error=(status:number,code:string,message:string)=>Object.assign(new Error(message),{status,code});
async function lockedModel(tx:any,d:AppDeps,projectId:string,baseRevision:number) {
  const [model]=await tx.select().from(buildingModels).where(and(eq(buildingModels.projectId,projectId),eq(buildingModels.tenantId,d.tenantId))).for("update");
  if(!model)throw error(404,"not_found","Building model not found");
  if(model.revision!==baseRevision)throw error(409,"revision_conflict","The building model changed; reload before saving.");
  return model;
}

const bulkScope = z.object({ baseRevision: z.number().int().nonnegative(), sourceVersionId: uuid,
  modelState: z.enum(["existing", "proposed", "demolition"]), threshold: z.number().int().min(0).max(100) }).strict();
const bulkAdoption = bulkScope.extend({ scoreVersion: z.string(), candidateIds: z.array(uuid).min(1).max(1000)
  .refine(ids => new Set(ids).size === ids.length, "Candidate IDs must be unique") }).strict();
type BulkScope = z.infer<typeof bulkScope>;
const sourceIdentity = (candidate: any, job: any) => `plan:${job.storeyId}:${job.page}:${candidate.sourceKey}`;

/** Shared single/batch review persistence. The caller owns locks and revision/audit scope. */
async function persistCandidateReview(tx: any, d: AppDeps, model: any, candidate: any, job: any,
  input: z.infer<typeof buildingExtractionReviewSchema>) {
  if(candidate.status!=="unreviewed")throw error(409,"already_reviewed","Candidate was already reviewed");
  if(!job || !["room","element"].includes(candidate.entityType))throw error(422,"invalid_candidate","Unsupported extraction candidate");
  const table=candidate.entityType==="room"?buildingRooms:buildingElements;
  const sourceEntityKey=sourceIdentity(candidate,job);
  const [reconciled]=await tx.select({id:buildingReconciliations.id}).from(buildingReconciliations).where(and(eq(buildingReconciliations.modelId,model.id),
    eq(buildingReconciliations.tenantId,d.tenantId),eq(buildingReconciliations.sourceVersionId,job.sourceVersionId),eq(buildingReconciliations.sourceEntityKey,sourceEntityKey))).limit(1);
  if(reconciled)throw error(409,"already_reconciled","This plan source entity was already reviewed from another extraction run; reload the building model.");
  let entity:any=null;
  if(input.decision==="approved") {
    if(input.targetEntityId) {
      [entity]=await tx.select().from(table).where(and(eq(table.id,input.targetEntityId),eq(table.modelId,model.id),eq(table.storeyId,job.storeyId),eq(table.tenantId,d.tenantId)));
      if(!entity)throw error(422,"invalid_target","Reconciliation target must have the same entity type on the selected storey");
    } else {
      const [storey]=await tx.select().from(buildingStoreys).where(and(eq(buildingStoreys.id,job.storeyId),eq(buildingStoreys.modelId,model.id),eq(buildingStoreys.tenantId,d.tenantId)));
      if(!storey)throw error(422,"invalid_storey","Source storey no longer exists");
      // Identity/geometry review does not approve separately inferred area or room use.
      const reviewedGeometry=reviewedCandidateGeometry(candidate.geometry as Record<string,unknown>);
      [entity]=await tx.insert(table).values({tenantId:d.tenantId,modelId:model.id,storeyId:job.storeyId,
        ...(candidate.entityType==="element"?{buildingId:storey.buildingId,
          kind:reviewedGeometry.quality==="draft_wall"?"draft_wall":reviewedGeometry.quality==="construction_fragment_assembly"?"source_construction_fragment":"source_footprint"}:{}),
        stableKey:`extraction:${candidate.id}`,name:input.name??candidate.name,
        constructionState:reviewedGeometry.quality==="draft_wall"&&(reviewedGeometry.constructionState==="retained"||reviewedGeometry.constructionState==="demolished")?reviewedGeometry.constructionState:"unknown",
        geometry:{...reviewedGeometry,source:{sourceVersionId:job.sourceVersionId,page:job.page},evidence:candidate.evidence},createdBy:d.actorId}).returning();
    }
  }
  // Explicit reconciliation never overwrites accepted geometry, name or use.
  await tx.insert(buildingReconciliations).values({tenantId:d.tenantId,modelId:model.id,sourceVersionId:job.sourceVersionId,
    sourceEntityKey,targetEntityType:candidate.entityType,targetEntityId:entity?.id??null,
    method:"manual",status:input.decision==="approved"?"accepted":"rejected",reviewedBy:d.actorId,reviewedAt:new Date(),createdBy:d.actorId});
  const [proposal]=await tx.insert(buildingProposals).values({tenantId:d.tenantId,modelId:model.id,proposalType:`plan_${candidate.entityType}_candidate`,targetEntityType:entity?candidate.entityType:null,targetEntityId:entity?.id??null,
    expectedRevision:input.baseRevision,payload:{candidateId:candidate.id,name:input.name??candidate.name,evidence:candidate.evidence,geometryQuality:(candidate.geometry as any).quality},status:input.decision,createdBy:d.actorId}).returning();
  await tx.insert(buildingReviews).values({tenantId:d.tenantId,proposalId:proposal.id,decision:input.decision,reviewedBy:d.actorId});
  const [saved]=await tx.update(candidates).set({status:input.decision,name:input.name??candidate.name,targetEntityId:entity?.id??null,reviewedBy:d.actorId,reviewedAt:new Date()}).where(eq(candidates.id,candidate.id)).returning();
  return {candidate:saved,entity};
}

async function bulkPreview(tx: any, d: AppDeps, projectId: string, model: any, input: BulkScope, lock: boolean) {
  const [source]=await tx.select({version:fileVersions,file:files}).from(fileVersions).innerJoin(files,eq(files.id,fileVersions.fileId))
    .where(and(eq(fileVersions.id,input.sourceVersionId),eq(fileVersions.tenantId,d.tenantId),eq(fileVersions.status,"ready"),eq(files.projectId,projectId),eq(files.tenantId,d.tenantId)));
  const [superseded]=await tx.select({id:buildingSupersededSources.id}).from(buildingSupersededSources)
    .where(and(eq(buildingSupersededSources.modelId,model.id),eq(buildingSupersededSources.tenantId,d.tenantId),eq(buildingSupersededSources.sourceVersionId,input.sourceVersionId))).limit(1);
  if(!source || source.version.mimeType!=="application/pdf" || superseded)
    throw error(422,"invalid_source_revision","Choose one active, ready PDF revision in this project");
  // Lock only candidates (model is already locked), avoiding the worker's job/model lock order.
  // Do not repeat the full page extraction result for every candidate on that page.
  const query=tx.select({candidate:candidates,job:{id:jobs.id,sourceVersionId:jobs.sourceVersionId,
    storeyId:jobs.storeyId,page:jobs.page,status:jobs.status}}).from(candidates).innerJoin(jobs,eq(jobs.id,candidates.jobId))
    .where(and(eq(candidates.modelId,model.id),eq(candidates.tenantId,d.tenantId),eq(jobs.modelId,model.id),eq(jobs.tenantId,d.tenantId),eq(jobs.sourceVersionId,input.sourceVersionId)))
    .orderBy(candidates.id);
  const rows:any[]=await (lock?query.for("update",{of:candidates}):query);
  const scoped=rows.filter(({candidate,job})=>{
    if(candidate.status!=="unreviewed" || job.status!=="complete")return false;
    const state=candidate.geometry?.constructionState;
    if(candidate.entityType==="room" || !state || state==="unknown")return true;
    return input.modelState==="proposed"?state==="proposed"||state==="retained"
      :input.modelState==="demolition"?state==="demolished"||state==="retained":state!=="proposed"&&state!=="demolished";
  });
  // Only rooms enter geometry comparison/adoption. Unscored wall fragments must
  // not prevent a normal floor plan with hundreds of fragments from being reviewed.
  const scopedRooms=scoped.filter(({candidate})=>candidate.entityType==="room");
  if(scopedRooms.length>1000)throw error(422,"candidate_scope_overflow","This source has more than 1000 pending rooms; use individual review. No candidates were selected.");
  // These share one transaction connection; PostgreSQL executes them serially.
  const reconciliations=await tx.select().from(buildingReconciliations).where(and(eq(buildingReconciliations.modelId,model.id),eq(buildingReconciliations.tenantId,d.tenantId),eq(buildingReconciliations.sourceVersionId,input.sourceVersionId)));
  const rooms=await tx.select().from(buildingRooms).where(and(eq(buildingRooms.modelId,model.id),eq(buildingRooms.tenantId,d.tenantId)));
  const storeys=await tx.select({id:buildingStoreys.id}).from(buildingStoreys).where(and(eq(buildingStoreys.modelId,model.id),eq(buildingStoreys.tenantId,d.tenantId)));
  const reconciled=new Set(reconciliations.map((row:any)=>row.sourceEntityKey)), storeyIds=new Set(storeys.map((row:any)=>row.id));
  const identities=new Map<string,number>();
  for(const {candidate,job} of rows)if(candidate.status!=="superseded"){
    const key=sourceIdentity(candidate,job);identities.set(key,(identities.get(key)??0)+1);
  }
  const normalize=(name:string)=>name.normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase("de-DE");
  const eligible=[];let excludedCount=0,unscoredCount=0;
  for(const {candidate,job} of scoped){
    const scored=candidateReviewScore(candidate);
    if(scored.score===null){unscoredCount++;continue;}
    const key=sourceIdentity(candidate,job), evidence=candidate.evidence;
    const sourceMatches=Array.isArray(evidence)&&evidence.length>0&&evidence.every((item:any)=>item?.kind==="page"&&item.sourceVersionId===job.sourceVersionId&&item.page===job.page)
      && (!candidate.geometry?.source || (candidate.geometry.source.sourceVersionId===job.sourceVersionId&&candidate.geometry.source.page===job.page));
    const canonicalRisk=rooms.some((room:any)=>room.stableKey===`extraction:${candidate.id}` || (room.storeyId===job.storeyId
      && (normalize(room.name)===normalize(candidate.name) || ((!room.geometry?.source || room.geometry.source.page===job.page)
        && candidateOutlinesOverlap(candidate.geometry,room.geometry)))));
    const competingOutline=scopedRooms.some(other=>other.candidate.id!==candidate.id&&other.job.storeyId===job.storeyId&&other.job.page===job.page
      && candidateOutlinesOverlap(candidate.geometry,other.candidate.geometry));
    if(scored.blocked || scored.score<input.threshold || !sourceMatches || !storeyIds.has(job.storeyId) || candidate.targetEntityId
      || reconciled.has(key) || (identities.get(key)??0)>1 || canonicalRisk || competingOutline){excludedCount++;continue;}
    eligible.push({id:candidate.id,name:candidate.name,page:job.page,entityType:candidate.entityType,score:scored.score,checks:scored.checks});
  }
  return {preview:{...input,scoreVersion:candidateReviewScoreVersion,eligible,excludedCount,unscoredCount},rows};
}

export function createBuildingExtractionRouter(getDeps:(req:Request)=>AppDeps) {
  const router=Router();
  router.post("/projects/:projectId/building-model/extractions",async(req,res,next)=>{
    try {
      const d=getDeps(req);d.requirePermission("projects:write");const projectId=uuid.parse(req.params.projectId);
      const input=buildingExtractionRequestSchema.parse(req.body);
      const job=await d.db.transaction(async(tx:any)=>{
        const model=await lockedModel(tx,d,projectId,input.baseRevision);
        const [storey]=await tx.select().from(buildingStoreys).where(and(eq(buildingStoreys.id,input.storeyId),eq(buildingStoreys.modelId,model.id),eq(buildingStoreys.tenantId,d.tenantId)));
        if(!storey)throw error(422,"invalid_storey","Choose a storey in this building model");
        const [source]=await tx.select({version:fileVersions,file:files}).from(fileVersions).innerJoin(files,eq(files.id,fileVersions.fileId)).where(and(eq(fileVersions.id,input.sourceVersionId),eq(fileVersions.tenantId,d.tenantId),eq(fileVersions.status,"ready"),eq(files.projectId,projectId),eq(files.tenantId,d.tenantId)));
        if(!source || !(source.version.mimeType==="application/pdf" || /\.pdf$/i.test(source.file.name)))throw error(422,"invalid_source_revision","Choose a ready PDF revision in this project");
        const identity=and(eq(jobs.modelId,model.id),eq(jobs.sourceVersionId,input.sourceVersionId),eq(jobs.storeyId,input.storeyId),eq(jobs.page,input.page));
        const existingJobs=await tx.select().from(jobs).where(identity).for("update");
        const existing=existingJobs.find((candidate:any)=>candidate.extractorVersion===buildingExtractorVersion)??existingJobs[0];
        if(existing){
          if(!["queued","running"].includes(existing.status)){
            const [requeued]=await tx.update(jobs).set({extractorVersion:buildingExtractorVersion,status:"queued",attempts:0,
              leaseToken:null,leaseUntil:null,result:null,updatedAt:new Date()}).where(eq(jobs.id,existing.id)).returning();
            await d.audit(tx,"projects.building.extraction.requeued","building_extraction",existing.id,
              {projectId,previousStatus:existing.status,upgrade:existing.extractorVersion!==buildingExtractorVersion});return requeued;
          }
          if(existing.status==="queued"&&existing.extractorVersion!==buildingExtractorVersion){
            const [upgraded]=await tx.update(jobs).set({extractorVersion:buildingExtractorVersion,updatedAt:new Date()})
              .where(eq(jobs.id,existing.id)).returning();
            await d.audit(tx,"projects.building.extraction.upgraded","building_extraction",existing.id,
              {projectId,previousStatus:existing.status,previousExtractorVersion:existing.extractorVersion,extractorVersion:buildingExtractorVersion});
            return upgraded;
          }
          return existing;
        }
        const [created]=await tx.insert(jobs).values({tenantId:d.tenantId,modelId:model.id,sourceVersionId:input.sourceVersionId,storeyId:input.storeyId,page:input.page,extractorVersion:buildingExtractorVersion,createdBy:d.actorId}).returning();
        await d.audit(tx,"projects.building.extraction.queued","building_extraction",created.id,{projectId,sourceVersionId:input.sourceVersionId,page:input.page});return created;
      });res.status(202).json(ok(job));
    }catch(e){if((e as any).code && (e as any).status)return res.status((e as any).status).json({data:null,error:{code:(e as any).code},message:(e as Error).message});next(e);}
  });
  router.post("/projects/:projectId/building-model/extraction-candidates/preview",async(req,res,next)=>{
    try {
      const d=getDeps(req);d.requirePermission("projects:write");const projectId=uuid.parse(req.params.projectId);
      const input=bulkScope.parse(req.body);
      const result=await d.db.transaction(async(tx:any)=>{
        const [model]=await tx.select().from(buildingModels).where(and(eq(buildingModels.projectId,projectId),eq(buildingModels.tenantId,d.tenantId)));
        if(!model)throw error(404,"not_found","Building model not found");
        if(model.revision!==input.baseRevision)throw error(409,"revision_conflict","The building model changed; reload before previewing.");
        return (await bulkPreview(tx,d,projectId,model,input,false)).preview;
      },{isolationLevel:"repeatable read",accessMode:"read only"});
      res.json(ok(result));
    }catch(e){if((e as any).code && (e as any).status)return res.status((e as any).status).json({data:null,error:{code:(e as any).code},message:(e as Error).message});next(e);}
  });
  router.post("/projects/:projectId/building-model/extraction-candidates/adopt",async(req,res,next)=>{
    try {
      const d=getDeps(req);d.requirePermission("projects:write");const projectId=uuid.parse(req.params.projectId);
      const {candidateIds,scoreVersion,...scope}=bulkAdoption.parse(req.body);
      if(scoreVersion!==candidateReviewScoreVersion)throw error(409,"score_version_conflict","Geometry checks changed; preview again.");
      const result=await d.db.transaction(async(tx:any)=>{
        const model=await lockedModel(tx,d,projectId,scope.baseRevision);
        const {preview,rows}=await bulkPreview(tx,d,projectId,model,scope,true);
        const eligible=new Map(preview.eligible.map(item=>[item.id,item]));
        if(candidateIds.some(id=>!eligible.has(id)))throw error(409,"candidate_eligibility_changed","A selected candidate is no longer eligible in this scope; preview again. Nothing was adopted.");
        const selected=[...candidateIds].sort(), byId=new Map(rows.map(row=>[row.candidate.id,row]));
        for(const id of selected){
          const {candidate,job}=byId.get(id)!;
          await persistCandidateReview(tx,d,model,candidate,job,{baseRevision:scope.baseRevision,decision:"approved"});
        }
        const revision=model.revision+1;
        await tx.update(buildingModels).set({revision,updatedAt:new Date()}).where(eq(buildingModels.id,model.id));
        await tx.insert(buildingRevisions).values({tenantId:d.tenantId,modelId:model.id,revision,status:"draft",createdBy:d.actorId});
        await d.audit(tx,"projects.building.extraction_candidates.adopted","building_model",model.id,
          {projectId,...scope,scoreVersion,candidateIds:selected,modelRevision:revision,reviewScope:"identity_outline_only",
            candidates:selected.map(id=>eligible.get(id))});
        return {revision,adoptedCount:selected.length,candidateIds:selected};
      });res.json(ok(result));
    }catch(e){if((e as any).code && (e as any).status)return res.status((e as any).status).json({data:null,error:{code:(e as any).code},message:(e as Error).message});next(e);}
  });
  router.post("/projects/:projectId/building-model/extraction-candidates/:candidateId/review",async(req,res,next)=>{
    try {
      const d=getDeps(req);d.requirePermission("projects:write");const projectId=uuid.parse(req.params.projectId),candidateId=uuid.parse(req.params.candidateId);
      const input=buildingExtractionReviewSchema.parse(req.body);
      const result=await d.db.transaction(async(tx:any)=>{
        const model=await lockedModel(tx,d,projectId,input.baseRevision);
        const [candidate]=await tx.select().from(candidates).where(and(eq(candidates.id,candidateId),eq(candidates.modelId,model.id),eq(candidates.tenantId,d.tenantId))).for("update");
        if(!candidate)throw error(404,"not_found","Candidate not found");
        if(candidate.status!=="unreviewed")throw error(409,"already_reviewed","Candidate was already reviewed");
        const [job]=await tx.select().from(jobs).where(and(eq(jobs.id,candidate.jobId),eq(jobs.tenantId,d.tenantId),eq(jobs.modelId,model.id)));
        const {candidate:saved,entity}=await persistCandidateReview(tx,d,model,candidate,job,input);
        const revision=model.revision+1;
        await tx.update(buildingModels).set({revision,updatedAt:new Date()}).where(eq(buildingModels.id,model.id));
        await tx.insert(buildingRevisions).values({tenantId:d.tenantId,modelId:model.id,revision,status:input.decision==="approved"?"approved":"draft",createdBy:d.actorId});
        await d.audit(tx,"projects.building.extraction_candidate.reviewed","building_extraction_candidate",candidate.id,{projectId,decision:input.decision,targetEntityId:entity?.id,modelRevision:revision});
        return {candidate:saved,entity,revision};
      });res.json(ok(result));
    }catch(e){if((e as any).code && (e as any).status)return res.status((e as any).status).json({data:null,error:{code:(e as any).code},message:(e as Error).message});next(e);}
  });return router;
}
