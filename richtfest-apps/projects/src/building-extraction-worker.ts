import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { SourceExtractionDeps } from "./deps";
import { buildingExtractionJobs as jobs, buildingExtractionCandidates as candidates, fileVersions } from "./schema";
import { extractPlanLabels } from "./plan-extraction";
import { proposeRoomUses } from "./room-use-classifier";
import { ensureAutomaticPlanExtractions } from "./automatic-building-model";

export async function runBuildingExtraction(d: SourceExtractionDeps, signal: AbortSignal) {
  // Upload-time source extraction/classification and plan geometry use separate
  // durable workers. Bridge one terminal source into its page-scoped jobs before
  // claiming ordinary extraction work; a planner failure must not starve jobs
  // that were already queued manually or by a previous pass.
  try { await ensureAutomaticPlanExtractions(d, signal); } catch { d.reportError(); }
  const token = crypto.randomUUID();
  const job = await d.db.transaction(async (tx: any) => {
    const [row] = await tx.select().from(jobs).where(and(inArray(jobs.status,["queued","running"]),sql`(${jobs.leaseUntil} is null or ${jobs.leaseUntil} < now())`)).orderBy(jobs.createdAt).limit(1).for("update",{skipLocked:true});
    if (!row) return null;
    await tx.update(jobs).set({status:"running",attempts:row.attempts+1,leaseToken:token,leaseUntil:new Date(Date.now()+10*60_000),
      result:{phase:"extracting_geometry",inference:{provider:"typesafe",active:false,configured:null}},updatedAt:new Date()}).where(eq(jobs.id,row.id));
    await d.audit(tx,row.tenantId,"projects.building.extraction.started",row.sourceVersionId,{jobId:row.id}); return row;
  });
  if (!job) return false;
  const owned = and(eq(jobs.id,job.id),eq(jobs.tenantId,job.tenantId),eq(jobs.leaseToken,token));
  try {
    if (job.attempts >= 3) throw new Error("Recovery exhausted");
    const [source] = await d.db.select().from(fileVersions).where(and(eq(fileVersions.id,job.sourceVersionId),eq(fileVersions.tenantId,job.tenantId),eq(fileVersions.status,"ready")));
    if (!source?.storageKey) throw new Error("Source unavailable");
    const bounded = AbortSignal.any([signal,AbortSignal.timeout(6*60_000)]);
    const stream = await d.fileStorage.read(source.storageKey,bounded); if (!stream) throw new Error("Source unavailable");
    const result = await extractPlanLabels(stream,job.page,bounded);
    const existing = await d.db.select({sourceKey:candidates.sourceKey,status:candidates.status,geometry:candidates.geometry}).from(candidates)
      .where(and(eq(candidates.jobId,job.id),eq(candidates.tenantId,job.tenantId)));
    const current = new Map(existing.map((row:any)=>[row.sourceKey,row]));
    const eligibleLabels = result.labels.filter(label => {
      const row=current.get(label.sourceKey) as any;
      return !row || (row.status==="unreviewed" && !(row.geometry as any)?.roomUseProposal);
    });
    await d.db.update(jobs).set({result:{phase:"preparing_draft",candidateCount:result.labels.length+result.footprints.length,
      inference:{provider:"typesafe",active:Boolean(d.executeDecision && eligibleLabels.length),configured:null}},updatedAt:new Date()}).where(owned);
    const classification = await proposeRoomUses({tenantId:job.tenantId,actorId:job.createdBy,
      labels:eligibleLabels,signal:bounded,executeDecision:d.executeDecision});
    const classified = new Map(classification.labels.map(label=>[label.sourceKey,label]));
    result.labels=result.labels.map(label=>classified.get(label.sourceKey)??label);
    await d.db.transaction(async (tx:any) => {
      const [current] = await tx.select().from(jobs).where(owned).for("update"); if (!current) return;
      const activeKeys=[...result.labels,...result.footprints].map(c=>c.sourceKey);
      // Preserve accepted history; obsolete unreviewed hypotheses are superseded on extractor upgrades.
      if(activeKeys.length) await tx.update(candidates).set({status:"superseded"}).where(and(eq(candidates.jobId,job.id),eq(candidates.tenantId,job.tenantId),eq(candidates.status,"unreviewed"),notInArray(candidates.sourceKey,activeKeys)));
      for (const candidate of [...result.labels,...result.footprints]) await tx.insert(candidates).values({tenantId:job.tenantId,modelId:job.modelId,jobId:job.id,
        sourceKey:candidate.sourceKey,entityType:candidate.entityType,name:candidate.name,geometry:candidate.geometry,
        evidence:[{kind:"page",sourceVersionId:job.sourceVersionId,page:job.page,region:candidate.geometry.planRegion,quote:candidate.quote,...("layerId" in candidate?{layerId:candidate.layerId,layerName:candidate.layerName}:{})}]}).onConflictDoNothing();
      // Upgrades may revisit an existing unreviewed candidate. Add the proposal
      // without modifying any reviewed candidate or canonical room.
      for (const label of classification.labels) if ((label.geometry as any).roomUseProposal)
        await tx.update(candidates).set({geometry:label.geometry}).where(and(eq(candidates.jobId,job.id),eq(candidates.tenantId,job.tenantId),
          eq(candidates.sourceKey,label.sourceKey),eq(candidates.status,"unreviewed")));
      const {labels,footprints,...summary}=result;
      const candidateCount=labels.length+footprints.length;
      const unresolvedAnchorCount=labels.filter(l=>l.geometry.quality==="anchor").length;
      const roomHypothesisCount=labels.length-unresolvedAnchorCount;
      const sourceAreaObservationCount=labels.filter(l=>Boolean((l.geometry as any).printedArea)).length;
      const draftWallCount=footprints.filter(f=>(f.geometry as any).quality==="draft_wall").length;
      const constructionFragmentCount=footprints.filter(f=>(f.geometry as any).quality==="construction_fragment_assembly").length;
      await tx.update(jobs).set({status:"complete",result:{...summary,phase:"complete",candidateCount,
        roomAnchorCount:unresolvedAnchorCount,roomCandidateCount:labels.length,roomHypothesisCount,unresolvedAnchorCount,
        elementAssemblyCount:footprints.length,constructionAssemblyCount:constructionFragmentCount,
        draftWallCount,constructionFragmentCount,
        elementFootprintCount:result.topologyCoverage.sourceFootprintCount,rawFootprintCount:result.topologyCoverage.sourceFootprintCount,
        sourceAreaObservationCount,inference:{provider:"typesafe",active:false,
          configured:classification.outcome==="classified"?true:classification.outcome==="unconfigured"?false:null,
          outcome:classification.outcome}},leaseToken:null,leaseUntil:null,updatedAt:new Date()}).where(owned);
      await d.audit(tx,job.tenantId,"projects.building.extraction.completed",job.sourceVersionId,{jobId:job.id,candidateCount,
        roomUseClassification:{outcome:classification.outcome,uniqueLabelCount:classification.uniqueLabelCount,
          classifiedLabelCount:classification.classifiedLabelCount,provider:"typesafe",model:"jev-1.13.0",usage:classification.usage}});
    });
  } catch {
    await d.db.transaction(async (tx:any) => {
      const status = signal.aborted || job.attempts < 2 ? "queued" : "failed";
      const updated = await tx.update(jobs).set({status,leaseToken:null,leaseUntil:status==="queued"?new Date(Date.now()+5000):null,
        result:{phase:status==="queued"?"retrying":"failed",retryable:status==="queued",attempts:job.attempts+1,
          inference:{provider:"typesafe",active:false,configured:null},
          reason:"PDF analysis could not complete: source, page, processing tools or deadline unavailable. Original evidence is unchanged; automatic recovery is bounded."},updatedAt:new Date()}).where(owned).returning();
      if (updated.length) await d.audit(tx,job.tenantId,`projects.building.extraction.${status}`,job.sourceVersionId,{jobId:job.id});
    });
  }
  return true;
}
export function startBuildingExtractionWorker(d: SourceExtractionDeps) {
  const controller=new AbortController(); let active:Promise<void>|null=null;
  const tick=()=>{if(active||controller.signal.aborted)return;active=runBuildingExtraction(d,controller.signal).then(()=>{},()=>d.reportError()).finally(()=>{active=null;});};
  const timer=setInterval(tick,1000);timer.unref();tick();
  return {async stop(){clearInterval(timer);controller.abort();await active;}};
}
