import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { SourceExtractionDeps } from "./deps";
import { buildingExtractionJobs as jobs, buildingExtractionCandidates as candidates, buildingColourLegends, buildingModels, buildingRevisions, buildingSelectionMasks, buildingSupersededSources, fileVersions } from "./schema";
import { buildingExtractorVersion, extractPlanLabels } from "./plan-extraction";
export { buildingExtractorVersion };

/** A planner's outline edit outlives re-extraction: the new run refreshes evidence and QC around it. */
const keepOutlineEdit = (geometry: any, previous: any) => {
  if (!previous?.outlineEdit) return geometry;
  const { parts: _parts, polygons: _polygons, ...rest } = geometry;
  return { ...rest, quality: previous.quality, polygon: previous.polygon, holes: previous.holes, planRegion: previous.planRegion, outlineEdit: previous.outlineEdit };
};
import { proposeRoomUses } from "./room-use-classifier";
import { ensureAutomaticPlanExtractions } from "./automatic-building-model";

/** Superseded plan sets are out of the model: never claim or upgrade their jobs. */
const notSuperseded = () => sql`not exists (select 1 from ${buildingSupersededSources} as superseded
  where superseded.model_id=${jobs.modelId} and superseded.source_version_id=${jobs.sourceVersionId})`;

export async function runBuildingExtraction(d: SourceExtractionDeps, signal: AbortSignal, options: { plan?: boolean; onPlanned?: (found: boolean) => void } = {}) {
  // Upload-time source extraction/classification and plan geometry use separate
  // durable workers. Bridge one terminal source into its page-scoped jobs before
  // claiming ordinary extraction work; a planner failure must not starve jobs
  // that were already queued manually or by a previous pass.
  if (options.plan ?? true) try { options.onPlanned?.(await ensureAutomaticPlanExtractions(d, signal)); } catch { options.onPlanned?.(false); d.reportError(); }
  const token = crypto.randomUUID();
  const job = await d.db.transaction(async (tx: any) => {
    const [row] = await tx.select().from(jobs).where(and(inArray(jobs.status,["queued","running"]),sql`(${jobs.leaseUntil} is null or ${jobs.leaseUntil} < now())`,notSuperseded())).orderBy(jobs.createdAt).limit(1).for("update",{skipLocked:true});
    if (!row) return null;
    await tx.update(jobs).set({status:"running",attempts:row.attempts+1,leaseToken:token,leaseUntil:new Date(Date.now()+10*60_000),
      result:{phase:"extracting_geometry",inference:{provider:"typesafe",active:false,configured:null}},updatedAt:new Date()}).where(eq(jobs.id,row.id));
    await d.audit(tx,row.tenantId,"projects.building.extraction.started",row.sourceVersionId,{jobId:row.id}); return row;
  });
  if (!job) return upgradeOutdatedExtraction(d);
  const owned = and(eq(jobs.id,job.id),eq(jobs.tenantId,job.tenantId),eq(jobs.leaseToken,token));
  try {
    if (job.attempts >= 3) throw new Error("Recovery exhausted");
    const [source] = await d.db.select().from(fileVersions).where(and(eq(fileVersions.id,job.sourceVersionId),eq(fileVersions.tenantId,job.tenantId),eq(fileVersions.status,"ready")));
    if (!source?.storageKey) throw new Error("Source unavailable");
    const bounded = AbortSignal.any([signal,AbortSignal.timeout(6*60_000)]);
    const stream = await d.fileStorage.read(source.storageKey,bounded); if (!stream) throw new Error("Source unavailable");
    // The plan set's colour legend, as a person set it; without one the extractor suggests the DIN colours.
    const [legend] = await d.db.select({entries:buildingColourLegends.entries}).from(buildingColourLegends)
      .where(and(eq(buildingColourLegends.modelId,job.modelId),eq(buildingColourLegends.tenantId,job.tenantId),eq(buildingColourLegends.sourceVersionId,job.sourceVersionId))).limit(1);
    const result = await extractPlanLabels(stream,job.page,bounded,{colourLegend:Array.isArray(legend?.entries)?legend.entries as any:[]});
    const existing = await d.db.select({sourceKey:candidates.sourceKey,status:candidates.status,geometry:candidates.geometry}).from(candidates)
      .where(and(eq(candidates.jobId,job.id),eq(candidates.tenantId,job.tenantId)));
    const existingBySource = new Map(existing.map((row:any)=>[row.sourceKey,row]));
    const eligibleLabels = result.labels.filter(label => {
      const row=existingBySource.get(label.sourceKey) as any;
      return !row || (row.status==="unreviewed" && !(row.geometry as any)?.roomUseProposal);
    });
    await d.db.update(jobs).set({result:{phase:"preparing_draft",candidateCount:result.labels.length+result.footprints.length,
      inference:{provider:"typesafe",active:Boolean(d.executeDecision && eligibleLabels.length),configured:null}},updatedAt:new Date()}).where(owned);
    const classification = await proposeRoomUses({tenantId:job.tenantId,actorId:job.createdBy,
      labels:eligibleLabels,signal:bounded,executeDecision:d.executeDecision});
    const classified = new Map(classification.labels.map(label=>[label.sourceKey,label]));
    result.labels=result.labels.map(label=>classified.get(label.sourceKey)??label);
    await d.db.transaction(async (tx:any) => {
      const [currentJob] = await tx.select().from(jobs).where(owned).for("update"); if (!currentJob) return;
      // Rewriting a hypothesis a reviewer may have open must fence their baseRevision.
      // Lock the model before candidate rows (the review route's lock order).
      const hadUnreviewed=existing.some((row:any)=>row.status==="unreviewed");
      if(hadUnreviewed) await tx.select({id:buildingModels.id}).from(buildingModels).where(and(eq(buildingModels.id,job.modelId),eq(buildingModels.tenantId,job.tenantId))).for("update");
      let refreshed=0;
      const activeKeys=[...result.labels,...result.footprints].map(c=>c.sourceKey);
      // Preserve accepted history; obsolete unreviewed hypotheses are superseded on extractor upgrades.
      if(activeKeys.length) refreshed+=(await tx.update(candidates).set({status:"superseded"}).where(and(eq(candidates.jobId,job.id),eq(candidates.tenantId,job.tenantId),eq(candidates.status,"unreviewed"),notInArray(candidates.sourceKey,activeKeys),sql`${candidates.geometry}->'outlineEdit' is null`)).returning({id:candidates.id})).length;
      for (const candidate of [...result.labels,...result.footprints]) {
        const previous=existingBySource.get(candidate.sourceKey) as any;
        const previousProposal=previous?.status==="unreviewed"&&(previous.geometry as any)?.roomUseProposal;
        const geometry=keepOutlineEdit(previousProposal?{...candidate.geometry,roomUseProposal:previousProposal}:candidate.geometry,previous?.status==="unreviewed"?previous.geometry:null);
        const evidence=[{kind:"page",sourceVersionId:job.sourceVersionId,page:job.page,region:candidate.geometry.planRegion,quote:candidate.quote,...("layerId" in candidate?{layerId:candidate.layerId,layerName:candidate.layerName}:{})}];
        await tx.insert(candidates).values({tenantId:job.tenantId,modelId:job.modelId,jobId:job.id,
          sourceKey:candidate.sourceKey,entityType:candidate.entityType,name:candidate.name,geometry,evidence}).onConflictDoNothing();
        const updated=await tx.update(candidates).set({name:candidate.name,geometry,evidence}).where(and(eq(candidates.jobId,job.id),eq(candidates.tenantId,job.tenantId),
          eq(candidates.sourceKey,candidate.sourceKey),eq(candidates.status,"unreviewed"))).returning({id:candidates.id});
        if(previous?.status==="unreviewed") refreshed+=updated.length;
      }
      // Upgrades may revisit an existing unreviewed candidate. Add the proposal
      // without modifying any reviewed candidate or canonical room.
      for (const label of classification.labels) if ((label.geometry as any).roomUseProposal)
        await tx.update(candidates).set({geometry:keepOutlineEdit(label.geometry,(existingBySource.get(label.sourceKey) as any)?.geometry)}).where(and(eq(candidates.jobId,job.id),eq(candidates.tenantId,job.tenantId),
          eq(candidates.sourceKey,label.sourceKey),eq(candidates.status,"unreviewed")));
      const {labels,footprints,selectionMask,...summary}=result;
      const mask={tenantId:job.tenantId,modelId:job.modelId,extractorVersion:buildingExtractorVersion,gridSize:selectionMask.gridSize,encoding:selectionMask.encoding,data:selectionMask.data,
        pageAspectRatio:String(result.pageScale.pageAspectRatio),metresPerPageHeight:result.pageScale.metresPerPageHeight==null?null:String(result.pageScale.metresPerPageHeight),updatedAt:new Date()};
      await tx.insert(buildingSelectionMasks).values({jobId:job.id,...mask}).onConflictDoUpdate({target:buildingSelectionMasks.jobId,set:mask});
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
      let modelRevision:number|undefined;
      if(hadUnreviewed&&refreshed){
        [{revision:modelRevision}]=await tx.update(buildingModels).set({revision:sql`${buildingModels.revision} + 1`,updatedAt:new Date()})
          .where(eq(buildingModels.id,job.modelId)).returning({revision:buildingModels.revision});
        await tx.insert(buildingRevisions).values({tenantId:job.tenantId,modelId:job.modelId,revision:modelRevision,status:"draft",
          label:"Automatic plan extraction refreshed",createdBy:job.createdBy}).onConflictDoNothing();
      }
      await d.audit(tx,job.tenantId,"projects.building.extraction.completed",job.sourceVersionId,{jobId:job.id,candidateCount,
        ...(modelRevision!==undefined?{modelRevision,refreshedUnreviewedCandidateCount:refreshed}:{}),
        roomUseClassification:{outcome:classification.outcome,uniqueLabelCount:classification.uniqueLabelCount,
          classifiedLabelCount:classification.classifiedLabelCount,provider:"typesafe",model:"jev-1.13.0",usage:classification.usage}});
    });
  } catch {
    await d.db.transaction(async (tx:any) => {
      const status = signal.aborted || job.attempts < 2 ? "queued" : "failed";
      // A shutdown/deploy interruption is not a failed attempt: refund the claim's increment.
      const updated = await tx.update(jobs).set({status,...(signal.aborted?{attempts:sql`greatest(${jobs.attempts} - 1, 0)`}:{}),leaseToken:null,leaseUntil:status==="queued"?new Date(Date.now()+5000):null,
        result:{phase:status==="queued"?"retrying":"failed",retryable:status==="queued",attempts:signal.aborted?job.attempts:job.attempts+1,
          inference:{provider:"typesafe",active:false,configured:null},
          reason:"PDF analysis could not complete: source, page, processing tools or deadline unavailable. Original evidence is unchanged; automatic recovery is bounded."},updatedAt:new Date()}).where(owned).returning();
      if (updated.length) await d.audit(tx,job.tenantId,`projects.building.extraction.${status}`,job.sourceVersionId,{jobId:job.id});
    });
  }
  return true;
}
/** While the queue is idle, requeue one finished job produced by an older
 * extractor so every existing plan follows the current parser. The page job is
 * reused, so accepted and rejected candidates keep their history; a legacy
 * duplicate whose page already has a current-version job is left alone. */
export async function upgradeOutdatedExtraction(d: SourceExtractionDeps) {
  return d.db.transaction(async (tx: any) => {
    const current = sql`select 1 from ${jobs} as newer where newer.model_id=${jobs.modelId} and newer.source_version_id=${jobs.sourceVersionId}
      and newer.storey_id=${jobs.storeyId} and newer.page=${jobs.page} and newer.extractor_version=${buildingExtractorVersion}`;
    const [row] = await tx.select().from(jobs).where(and(inArray(jobs.status,["complete","failed"]),sql`${jobs.extractorVersion} <> ${buildingExtractorVersion}`,
      sql`not exists (${current})`,notSuperseded())).orderBy(jobs.updatedAt).limit(1).for("update",{skipLocked:true});
    if (!row) return false;
    await tx.update(jobs).set({extractorVersion:buildingExtractorVersion,status:"queued",attempts:0,leaseToken:null,leaseUntil:null,
      result:{phase:"extracting_geometry",upgradeFrom:row.extractorVersion,inference:{provider:"typesafe",active:false,configured:null}},updatedAt:new Date()}).where(eq(jobs.id,row.id));
    await d.audit(tx,row.tenantId,"projects.building.extraction.upgraded",row.sourceVersionId,{jobId:row.id,previousStatus:row.status,
      previousExtractorVersion:row.extractorVersion,extractorVersion:buildingExtractorVersion,automatic:true});
    return true;
  });
}

export function startBuildingExtractionWorker(d: SourceExtractionDeps) {
  const controller=new AbortController(); let active:Promise<void>|null=null;
  // Idle planner scans are cheap but not free: back off to ~15 s after a pass that found nothing.
  let nextPlanAt=0;
  const onPlanned=(found:boolean)=>{nextPlanAt=found?0:Date.now()+15_000;};
  const tick=()=>{if(active||controller.signal.aborted)return;active=runBuildingExtraction(d,controller.signal,{plan:Date.now()>=nextPlanAt,onPlanned}).then(()=>{},()=>d.reportError()).finally(()=>{active=null;});};
  const timer=setInterval(tick,1000);timer.unref();tick();
  return {async stop(){clearInterval(timer);controller.abort();await active;}};
}
