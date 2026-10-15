import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { SourceExtractionDeps } from "./deps";
import { buildingExtractionJobs as jobs, buildingExtractionCandidates as candidates, fileVersions } from "./schema";
import { extractPlanLabels } from "./plan-extraction";
import { proposeRoomUses } from "./room-use-classifier";

export async function runBuildingExtraction(d: SourceExtractionDeps, signal: AbortSignal) {
  const token = crypto.randomUUID();
  const job = await d.db.transaction(async (tx: any) => {
    const [row] = await tx.select().from(jobs).where(and(inArray(jobs.status,["queued","running"]),sql`(${jobs.leaseUntil} is null or ${jobs.leaseUntil} < now())`)).orderBy(jobs.createdAt).limit(1).for("update",{skipLocked:true});
    if (!row) return null;
    await tx.update(jobs).set({status:"running",attempts:row.attempts+1,leaseToken:token,leaseUntil:new Date(Date.now()+10*60_000),updatedAt:new Date()}).where(eq(jobs.id,row.id));
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
      await tx.update(jobs).set({status:"complete",result:{...summary,candidateCount,roomAnchorCount:labels.filter(l=>l.geometry.quality==="anchor").length,roomCandidateCount:labels.length,elementAssemblyCount:footprints.length,elementFootprintCount:result.topologyCoverage.sourceFootprintCount},leaseToken:null,leaseUntil:null,updatedAt:new Date()}).where(owned);
      await d.audit(tx,job.tenantId,"projects.building.extraction.completed",job.sourceVersionId,{jobId:job.id,candidateCount,
        roomUseClassification:{outcome:classification.outcome,uniqueLabelCount:classification.uniqueLabelCount,
          classifiedLabelCount:classification.classifiedLabelCount,provider:"typesafe",model:"jev-1.13.0",usage:classification.usage}});
    });
  } catch {
    await d.db.transaction(async (tx:any) => {
      const status = signal.aborted || job.attempts < 2 ? "queued" : "failed";
      const updated = await tx.update(jobs).set({status,leaseToken:null,leaseUntil:status==="queued"?new Date(Date.now()+5000):null,
        result:{reason:"PDF analysis could not complete: source, page, processing tools or deadline unavailable. Original evidence is unchanged; automatic recovery is bounded."},updatedAt:new Date()}).where(owned).returning();
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
