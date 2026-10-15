import { and, eq, inArray, sql } from "drizzle-orm";
import type { SourceImageReceipt } from "@richtfest/shared";
import type { AppDeps, SourceExtractionDeps } from "./deps";
import {
  buildingBuildings,
  buildingExtractionJobs,
  buildingModels,
  buildingPlanSources,
  buildingRevisions,
  buildingStoreys,
  fileVersions,
  files,
  sourceExtractions,
  sourceModels,
  sourcePages,
} from "./schema";

type PageDisposition = {
  page: number;
  classification: "floor_plan" | "non_floor_plan" | "unresolved";
  pageType: string | null;
  confidence: number | null;
  reason: string;
};

type ImageClassification = {
  totalPages?: number | null;
  attemptedPages?: number;
  completedPages?: number;
  receipts?: SourceImageReceipt[];
};

const automaticBuildingKey = "automatic:uploaded-plans";
const pageStoreyKey = (versionId: string, page: number) => `automatic:plan:${versionId}:page:${page}`;
const savedFloorTitleMarker = "__RICHTFEST_SAVED_FLOOR_PLAN_TITLE__";
const savedNonFloorTitleMarker = "__RICHTFEST_SAVED_NON_FLOOR_TITLE__";

/**
 * Convert bounded upload-time visual triage into an honest page register.
 * Only a completed, sufficiently confident floor-plan classification queues
 * geometry extraction. Everything else remains explicitly non-floor or
 * unresolved; a missing receipt is never treated as proof of absence.
 */
export function classifyPlanPages(input: {
  pageCount: number | null;
  imageClassification?: ImageClassification | null;
  pageTexts?: Map<number, string>;
}): PageDisposition[] {
  const receipts = input.imageClassification?.receipts ?? [];
  const receiptByPage = new Map(receipts.map(receipt => [receipt.page, receipt]));
  const count = Math.max(1, Math.min(500, input.pageCount ?? input.imageClassification?.totalPages ?? (receipts.length || 1)));
  const result: PageDisposition[] = [];
  for (let page = 1; page <= count; page++) {
    const text = input.pageTexts?.get(page) ?? "";
    if (text.includes(savedFloorTitleMarker)) {
      result.push({ page, classification: "floor_plan", pageType: "floor_plan", confidence: 1,
        reason: "Saved source-page text identifies a floor-plan drawing title; geometry remains an unreviewed draft." });
      continue;
    }
    if (text.includes(savedNonFloorTitleMarker)) {
      result.push({ page, classification: "non_floor_plan", pageType: "other_drawing", confidence: 1,
        reason: "Saved source-page text identifies a non-floor drawing title; no floor geometry was extracted." });
      continue;
    }
    // Exact saved source text wins over inferred image triage when its drawing
    // title is explicit. Negative drawing types are checked first because
    // section/elevation sheets commonly contain floor names as annotations.
    if (/\b(schnitt|ansicht|lageplan|freifl[aä]chenplan|abstandsfl[aä]chen|einf[uü]genachweis|zeichnerischer\s+nachweis|site\s*plan|building\s*section|elevation)\b/i.test(text)) {
      const match = text.match(/\b(schnitt|ansicht|lageplan|freifl[aä]chenplan|abstandsfl[aä]chen|einf[uü]genachweis|zeichnerischer\s+nachweis|site\s*plan|building\s*section|elevation)\b/i)?.[0] ?? "drawing title";
      result.push({ page, classification: "non_floor_plan", pageType: "other_drawing", confidence: 1,
        reason: `Saved source-page text identifies ${match}; no floor geometry was extracted.` });
      continue;
    }
    if (/\b(grundriss|floor\s*plan)\b/i.test(text)) {
      const match = text.match(/\b(grundriss|floor\s*plan)\b/i)?.[0] ?? "floor plan";
      result.push({ page, classification: "floor_plan", pageType: "floor_plan", confidence: 1,
        reason: `Saved source-page text identifies ${match}; geometry remains an unreviewed draft.` });
      continue;
    }
    const roomLabelCount = text.match(/\b(schlafen|schlafzimmer|kind(?:erzimmer)?|bad|flur|diele|k[uü]che|wohnen|abstell(?:raum)?)\b/gi)?.length ?? 0;
    const hasApartmentSchedule = /\b(WE\s*\d+|Wfl\.?|Wohnfl[aä]che)\b/i.test(text);
    if (roomLabelCount >= 3 && hasApartmentSchedule) {
      result.push({ page, classification: "floor_plan", pageType: "floor_plan", confidence: 1,
        reason: "Saved source-page text contains repeated room labels and an apartment-area schedule; geometry remains an unreviewed draft." });
      continue;
    }
    const receipt = receiptByPage.get(page);
    const answer = receipt?.status === "completed" ? receipt.answers?.page_type : undefined;
    if (answer?.type !== "choice") {
      result.push({ page, classification: "unresolved", pageType: null, confidence: null,
        reason: receipt?.reason ?? "No completed page-type classification is available; this page remains unresolved." });
      continue;
    }
    const confident = answer.confidence >= 0.6;
    if (confident && answer.choice === "floor_plan") {
      result.push({ page, classification: "floor_plan", pageType: answer.choice, confidence: answer.confidence,
        reason: "Upload-time image triage classified this page as a floor plan; geometry remains an unreviewed draft." });
    } else if (confident && !["unknown", "mixed"].includes(answer.choice)) {
      result.push({ page, classification: "non_floor_plan", pageType: answer.choice, confidence: answer.confidence,
        reason: `Upload-time image triage classified this page as ${answer.choice}; no floor geometry was extracted.` });
    } else {
      result.push({ page, classification: "unresolved", pageType: answer.choice, confidence: answer.confidence,
        reason: "Page type was mixed, unknown or below the automatic 60% confidence threshold." });
    }
  }
  return result;
}
/** Create the durable draft shell as soon as an ordinary PDF upload completes. */
export async function bootstrapAutomaticBuildingModel(tx: any, d: Pick<AppDeps, "tenantId" | "actorId" | "audit">,
  input: { projectId: string; sourceVersionId: string; fileName: string }) {
  let [model] = await tx.select().from(buildingModels)
    .where(and(eq(buildingModels.tenantId, d.tenantId), eq(buildingModels.projectId, input.projectId))).limit(1);
  let created = false;
  if (!model) {
    [model] = await tx.insert(buildingModels).values({ tenantId: d.tenantId, projectId: input.projectId,
      revision: 1, createdBy: d.actorId }).onConflictDoNothing().returning();
    if (!model) [model] = await tx.select().from(buildingModels)
      .where(and(eq(buildingModels.tenantId, d.tenantId), eq(buildingModels.projectId, input.projectId))).limit(1);
    else {
      created = true;
      await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: model.id,
        revision: 1, status: "draft", label: "Automatic plan processing", createdBy: d.actorId }).onConflictDoNothing();
    }
  }
  if (!model) throw new Error("Automatic building model could not be initialized");
  let createdBuilding = false;
  let [building] = await tx.select().from(buildingBuildings)
    .where(and(eq(buildingBuildings.modelId, model.id), eq(buildingBuildings.tenantId, d.tenantId),
      eq(buildingBuildings.stableKey, automaticBuildingKey))).limit(1);
  if (!building) {
    [building] = await tx.insert(buildingBuildings).values({ tenantId: d.tenantId, modelId: model.id,
      stableKey: automaticBuildingKey, name: "Uploaded plans (draft)", constructionState: "unknown",
      geometry: { quality: "unreviewed_source_container", sourceVersionId: input.sourceVersionId }, createdBy: d.actorId })
      .onConflictDoNothing().returning();
    createdBuilding = Boolean(building);
  }
  if (createdBuilding && !created) {
    // A source container added to an existing model is a real draft-model
    // change and must participate in optimistic revision fencing.
    const [{ revision }] = await tx.update(buildingModels).set({ revision: sql`${buildingModels.revision} + 1`, updatedAt: new Date() })
      .where(eq(buildingModels.id, model.id)).returning({ revision: buildingModels.revision });
    model = { ...model, revision };
    await tx.insert(buildingRevisions).values({ tenantId: d.tenantId, modelId: model.id, revision,
      status: "draft", label: "Automatic plan source attached", createdBy: d.actorId }).onConflictDoNothing();
  }
  if (!building) [building] = await tx.select().from(buildingBuildings)
    .where(and(eq(buildingBuildings.modelId, model.id), eq(buildingBuildings.tenantId, d.tenantId),
      eq(buildingBuildings.stableKey, automaticBuildingKey))).limit(1);
  await d.audit(tx, "projects.building.automatic_processing.queued", "building_model", model.id,
    { projectId: input.projectId, sourceVersionId: input.sourceVersionId, fileName: input.fileName, created, createdBuilding });
  return { model, building };
}

/**
 * Plan one terminal source-classification result per tick. This is idempotent:
 * plan sources, storeys and jobs use stable source/page identities, while the
 * source-model metadata is the durable planner receipt and recovery claim.
 */
export async function ensureAutomaticPlanExtractions(d: SourceExtractionDeps, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const token = crypto.randomUUID();
  const claimed = await d.db.transaction(async (tx: any) => {
    const [row] = await tx.select({ sourceModel: sourceModels, extraction: sourceExtractions, version: fileVersions,
      file: files }).from(sourceModels)
      .innerJoin(sourceExtractions, and(eq(sourceExtractions.versionId, sourceModels.versionId), eq(sourceExtractions.tenantId, sourceModels.tenantId)))
      .innerJoin(fileVersions, and(eq(fileVersions.id, sourceModels.versionId), eq(fileVersions.tenantId, sourceModels.tenantId)))
      .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, sourceModels.tenantId)))
      .where(and(inArray(sourceModels.status, ["complete", "unsupported", "failed", "unconfigured", "outcome_unknown", "limit_reached"]),
        inArray(sourceExtractions.status, ["complete", "failed"]), eq(fileVersions.status, "ready"),
        eq(files.purpose, "project_evidence"),
        sql`(${fileVersions.mimeType} = 'application/pdf' or ${files.name} ~* '\\.pdf$')`,
        sql`coalesce(${sourceModels.metadata}->'automaticBuildingModel'->>'status','pending') not in ('planned','partial','unresolved')`,
        sql`(${sourceModels.metadata}->'automaticBuildingModel'->>'status' is distinct from 'processing'
          or coalesce((${sourceModels.metadata}->'automaticBuildingModel'->>'claimedAt')::timestamptz, '-infinity') < now() - interval '10 minutes')`))
      .orderBy(sourceModels.createdAt).limit(1).for("update", { of: sourceModels, skipLocked: true });
    if (!row) return null;
    const metadata = { ...(row.sourceModel.metadata ?? {}), automaticBuildingModel: {
      status: "processing", token, claimedAt: new Date().toISOString(), provenance: "inferred", reviewStatus: "unreviewed",
    } };
    await tx.update(sourceModels).set({ metadata, updatedAt: new Date() })
      .where(and(eq(sourceModels.versionId, row.sourceModel.versionId), eq(sourceModels.tenantId, row.sourceModel.tenantId)));
    return row;
  });
  if (!claimed) return false;
  const { sourceModel, extraction, version, file } = claimed;
  const imageClassification = (sourceModel.metadata as any)?.imageClassification as ImageClassification | undefined;
  const pageCount = typeof (extraction.result as any)?.pages === "number" ? (extraction.result as any).pages
    : typeof imageClassification?.totalPages === "number" ? imageClassification.totalPages : null;
  const textRows = await d.db.select({ page: sourcePages.page,
    // Native PDF text can exceed 200k characters before the title block. Keep
    // the returned payload bounded, but scan a bounded full-page window in SQL
    // so a title beyond the first text chunk still overrides image triage.
    text: sql<string>`left(coalesce(${sourcePages.content}->>'text',''), 8000) || case
      when left(coalesce(${sourcePages.content}->>'text',''), 250000) ~* '(grundriss|floor[[:space:]]*plan)'
        then ${`\n${savedFloorTitleMarker}`}
      when left(coalesce(${sourcePages.content}->>'text',''), 250000) ~* '(schnitt|ansicht|lageplan|freifl(ä|ae)chenplan|abstandsfl(ä|ae)chen|einf(ü|ue)genachweis|zeichnerischer[[:space:]]+nachweis|site[[:space:]]*plan|building[[:space:]]*section|elevation)'
        then ${`\n${savedNonFloorTitleMarker}`}
      else '' end` }).from(sourcePages)
    .where(and(eq(sourcePages.versionId, version.id), eq(sourcePages.tenantId, version.tenantId)));
  const pageTexts = new Map<number, string>(textRows.map((row: any) => [Number(row.page), String(row.text ?? "")]));
  const pages = classifyPlanPages({ pageCount, imageClassification, pageTexts });
  const floorPages = pages.filter(page => page.classification === "floor_plan");
  const nonFloorPages = pages.filter(page => page.classification === "non_floor_plan");
  const unresolvedPages = pages.filter(page => page.classification === "unresolved");
  await d.db.transaction(async (tx: any) => {
    const [current] = await tx.select().from(sourceModels).where(and(eq(sourceModels.versionId, version.id),
      eq(sourceModels.tenantId, version.tenantId))).for("update");
    if ((current?.metadata as any)?.automaticBuildingModel?.token !== token) return;
    const { model, building } = await bootstrapAutomaticBuildingModel(tx, {
      tenantId: version.tenantId, actorId: version.createdBy,
      audit: (auditTx, action, entityType, entityId, metadata) =>
        d.audit(auditTx, version.tenantId, action, version.id, { entityType, entityId, ...metadata as any }),
    }, { projectId: file.projectId, sourceVersionId: version.id, fileName: file.name });
    const existingSources = await tx.select().from(buildingPlanSources).where(and(eq(buildingPlanSources.modelId, model.id),
      eq(buildingPlanSources.tenantId, version.tenantId), eq(buildingPlanSources.sourceVersionId, version.id)));
    const sourcesByPage = new Map(existingSources.map((source: any) => [source.page, source]));
    const storeyIds: string[] = [];
    const jobIds: string[] = [];
    let changed = false;
    for (const page of pages) {
      let storey: any = null;
      if (page.classification === "floor_plan") {
        [storey] = await tx.select().from(buildingStoreys).where(and(eq(buildingStoreys.buildingId, building.id),
          eq(buildingStoreys.stableKey, pageStoreyKey(version.id, page.page)), eq(buildingStoreys.tenantId, version.tenantId))).limit(1);
        if (!storey) {
          [storey] = await tx.insert(buildingStoreys).values({ tenantId: version.tenantId, modelId: model.id,
          buildingId: building.id, stableKey: pageStoreyKey(version.id, page.page), name: `Plan page ${page.page} (draft)`,
          levelIndex: null, constructionState: "unknown", geometry: { quality: "unreviewed_page_hypothesis",
            sourceVersionId: version.id, page: page.page }, createdBy: version.createdBy }).onConflictDoNothing().returning();
          changed ||= Boolean(storey);
        }
        if (storey) storeyIds.push(storey.id);
      }
      if (!sourcesByPage.has(page.page)) {
        await tx.insert(buildingPlanSources).values({ tenantId: version.tenantId,
          modelId: model.id, storeyId: storey?.id ?? null, sourceVersionId: version.id, page: page.page,
          pageCount, alignmentStatus: "unknown", layers: [{ kind: "automatic_page_classification", ...page,
            provenance: "inferred", semanticInspection: false, reviewStatus: "unreviewed" }], createdBy: version.createdBy });
        changed = true;
      }
      if (storey) {
        const [job] = await tx.insert(buildingExtractionJobs).values({ tenantId: version.tenantId, modelId: model.id,
          sourceVersionId: version.id, storeyId: storey.id, page: page.page, extractorVersion: "topology-v3",
          status: "queued", createdBy: version.createdBy }).onConflictDoNothing().returning();
        if (job) jobIds.push(job.id);
        else {
          const [existing] = await tx.select({ id: buildingExtractionJobs.id }).from(buildingExtractionJobs).where(and(
            eq(buildingExtractionJobs.modelId, model.id), eq(buildingExtractionJobs.sourceVersionId, version.id),
            eq(buildingExtractionJobs.storeyId, storey.id), eq(buildingExtractionJobs.page, page.page),
            eq(buildingExtractionJobs.extractorVersion, "topology-v3"))).limit(1);
          if (existing) jobIds.push(existing.id);
        }
      }
    }
    const status = floorPages.length ? (unresolvedPages.length ? "partial" : "planned") : "unresolved";
    if (changed) {
      const [{ revision }] = await tx.update(buildingModels).set({ revision: sql`${buildingModels.revision} + 1`, updatedAt: new Date() })
        .where(eq(buildingModels.id, model.id)).returning({ revision: buildingModels.revision });
      await tx.insert(buildingRevisions).values({ tenantId: version.tenantId, modelId: model.id, revision,
        status: "draft", label: "Automatic plan pages registered", createdBy: version.createdBy }).onConflictDoNothing();
    }
    const automaticBuildingModel = { status, plannedAt: new Date().toISOString(), provenance: "inferred",
      reviewStatus: "unreviewed", modelId: model.id, pageCount, registeredPageCount: pages.length,
      coverageTruncated: pageCount !== null && pageCount > pages.length,
      floorPlanPages: floorPages.map(page => page.page), nonFloorPlanPages: nonFloorPages.map(page => ({ page: page.page,
        pageType: page.pageType, confidence: page.confidence })), unresolvedPages: unresolvedPages.map(page => page.page),
      storeyIds, jobIds, reason: floorPages.length
        ? "Confident floor-plan pages were queued for unreviewed draft geometry. Other pages remain classified or unresolved as listed."
        : "No page met the automatic floor-plan threshold; no geometry was guessed. Page coverage remains available for review." };
    await tx.update(sourceModels).set({ metadata: { ...(current.metadata ?? {}), automaticBuildingModel }, updatedAt: new Date() })
      .where(and(eq(sourceModels.versionId, version.id), eq(sourceModels.tenantId, version.tenantId)));
    await d.audit(tx, version.tenantId, "projects.building.automatic_processing.planned", version.id,
      { projectId: file.projectId, modelId: model.id, status, pageCount, floorPlanPages: automaticBuildingModel.floorPlanPages,
        nonFloorPlanPages: automaticBuildingModel.nonFloorPlanPages, unresolvedPages: automaticBuildingModel.unresolvedPages,
        jobIds });
  });
  return true;
}
