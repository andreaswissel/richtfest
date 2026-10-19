import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ok, buildingExtractionRequestSchema, buildingExtractionReviewSchema } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { buildingModels, buildingStoreys, buildingRooms, buildingElements, buildingExtractionJobs as jobs, buildingExtractionCandidates as candidates,
  buildingRevisions, buildingReconciliations, buildingProposals, buildingReviews, fileVersions, files } from "./schema";
import { reviewedCandidateGeometry } from "./room-use-classifier";
import { buildingExtractorVersion } from "./plan-extraction";

const uuid=z.string().uuid();
const error=(status:number,code:string,message:string)=>Object.assign(new Error(message),{status,code});
async function lockedModel(tx:any,d:AppDeps,projectId:string,baseRevision:number) {
  const [model]=await tx.select().from(buildingModels).where(and(eq(buildingModels.projectId,projectId),eq(buildingModels.tenantId,d.tenantId))).for("update");
  if(!model)throw error(404,"not_found","Building model not found");
  if(model.revision!==baseRevision)throw error(409,"revision_conflict","The building model changed; reload before saving.");
  return model;
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
        if(!job || !["room","element"].includes(candidate.entityType))throw error(422,"invalid_candidate","Unsupported extraction candidate");
        const table=candidate.entityType==="room"?buildingRooms:buildingElements;
        // Another job row for the same source page may already have reconciled this key.
        const sourceEntityKey=`plan:${job.storeyId}:${job.page}:${candidate.sourceKey}`;
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
            // Identity/geometry review does not approve separately inferred
            // printed-area or room-use observations.
            const reviewedGeometry=reviewedCandidateGeometry(candidate.geometry as Record<string,unknown>);
            [entity]=await tx.insert(table).values({tenantId:d.tenantId,modelId:model.id,storeyId:job.storeyId,
              ...(candidate.entityType==="element"?{buildingId:storey.buildingId,
                kind:reviewedGeometry.quality==="draft_wall"?"draft_wall":reviewedGeometry.quality==="construction_fragment_assembly"?"source_construction_fragment":"source_footprint"}:{}),
              stableKey:`extraction:${candidate.id}`,name:input.name??candidate.name,
              // A wall drawn in the colour of an existing or demolished wall keeps that state; anything else is set by a person.
              constructionState:reviewedGeometry.quality==="draft_wall"&&(reviewedGeometry.constructionState==="retained"||reviewedGeometry.constructionState==="demolished")?reviewedGeometry.constructionState:"unknown",
              geometry:{...reviewedGeometry,source:{sourceVersionId:job.sourceVersionId,page:job.page},evidence:candidate.evidence},createdBy:d.actorId}).returning();
          }
        }
        // Explicit reconciliation never overwrites a person's accepted geometry, name or use.
        await tx.insert(buildingReconciliations).values({tenantId:d.tenantId,modelId:model.id,sourceVersionId:job.sourceVersionId,
          sourceEntityKey,targetEntityType:candidate.entityType,targetEntityId:entity?.id??null,
          method:"manual",status:input.decision==="approved"?"accepted":"rejected",reviewedBy:d.actorId,reviewedAt:new Date(),createdBy:d.actorId});
        const [proposal]=await tx.insert(buildingProposals).values({tenantId:d.tenantId,modelId:model.id,proposalType:`plan_${candidate.entityType}_candidate`,targetEntityType:entity?candidate.entityType:null,targetEntityId:entity?.id??null,
          expectedRevision:input.baseRevision,payload:{candidateId,name:input.name??candidate.name,evidence:candidate.evidence,geometryQuality:(candidate.geometry as any).quality},status:input.decision,createdBy:d.actorId}).returning();
        await tx.insert(buildingReviews).values({tenantId:d.tenantId,proposalId:proposal.id,decision:input.decision,reviewedBy:d.actorId});
        const [saved]=await tx.update(candidates).set({status:input.decision,name:input.name??candidate.name,targetEntityId:entity?.id??null,reviewedBy:d.actorId,reviewedAt:new Date()}).where(eq(candidates.id,candidate.id)).returning();
        const revision=model.revision+1;
        await tx.update(buildingModels).set({revision,updatedAt:new Date()}).where(eq(buildingModels.id,model.id));
        await tx.insert(buildingRevisions).values({tenantId:d.tenantId,modelId:model.id,revision,status:input.decision==="approved"?"approved":"draft",createdBy:d.actorId});
        await d.audit(tx,"projects.building.extraction_candidate.reviewed","building_extraction_candidate",candidate.id,{projectId,decision:input.decision,targetEntityId:entity?.id,modelRevision:revision});
        return {candidate:saved,entity,revision};
      });res.json(ok(result));
    }catch(e){if((e as any).code && (e as any).status)return res.status((e as any).status).json({data:null,error:{code:(e as any).code},message:(e as Error).message});next(e);}
  });return router;
}
