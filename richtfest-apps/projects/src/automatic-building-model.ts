import { and, eq, inArray, sql } from "drizzle-orm";
import type { SourceImageReceipt } from "@richtfest/shared";
import { PLAN_HEIGHT_VERSION } from "@richtfest/shared/plan-heights";
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
import { buildingExtractorVersion } from "./plan-extraction";

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
const maxPlannerAttempts = 3;
// Postgres ARE word boundaries (\m, \M); kept in sync with the JS title checks below.
const floorTitlePattern = String.raw`\m(grundriss|floor[[:space:]]*plan)\M`;
const nonFloorTitlePattern = String.raw`\m(schnitt|ansicht|lageplan|freifl(ä|ae)chenplan|abstandsfl(ä|ae)chen|einf(ü|ue)genachweis|zeichnerischer[[:space:]]+nachweis|site[[:space:]]*plan|building[[:space:]]*section|elevation)\M`;

/** Preserve the page-scoped job identity across extractor upgrades. The schema's
 * versioned unique key prevents duplicate identical runs, but the product identity
 * is the source page and storey: reviewed candidates must stay on that job. */
export async function ensureAutomaticExtractionJob(tx: any, input: {
  tenantId: string; modelId: string; sourceVersionId: string; storeyId: string; page: number; createdBy: string;
  /** Records the per-job requeue/upgrade in the caller's audit trail, inside `tx`. */
  audit?: (action: string, jobId: string, metadata: Record<string, unknown>) => Promise<void>;
}) {
  const identity = and(eq(buildingExtractionJobs.modelId, input.modelId),
    eq(buildingExtractionJobs.sourceVersionId, input.sourceVersionId), eq(buildingExtractionJobs.storeyId, input.storeyId),
    eq(buildingExtractionJobs.page, input.page));
  const existingJobs = await tx.select().from(buildingExtractionJobs).where(identity).for("update");
  let job = existingJobs.find((candidate: any) => candidate.extractorVersion === buildingExtractorVersion) ?? existingJobs[0];
  if (job && job.extractorVersion !== buildingExtractorVersion && job.status !== "running") {
    const previous = job;
    [job] = await tx.update(buildingExtractionJobs).set({ extractorVersion: buildingExtractorVersion,
      ...(job.status === "queued" ? {} : { status: "queued", attempts: 0, leaseToken: null, leaseUntil: null, result: null }),
      updatedAt: new Date() }).where(eq(buildingExtractionJobs.id, job.id)).returning();
    await input.audit?.(previous.status === "queued" ? "projects.building.extraction.upgraded" : "projects.building.extraction.requeued",
      job.id, { previousStatus: previous.status, previousExtractorVersion: previous.extractorVersion,
        extractorVersion: buildingExtractorVersion, upgrade: true, automatic: true });
  }
  if (!job) [job] = await tx.insert(buildingExtractionJobs).values({ tenantId: input.tenantId, modelId: input.modelId,
    sourceVersionId: input.sourceVersionId, storeyId: input.storeyId, page: input.page,
    extractorVersion: buildingExtractorVersion, status: "queued", createdBy: input.createdBy }).onConflictDoNothing().returning();
  if (!job) [job] = await tx.select().from(buildingExtractionJobs).where(identity).limit(1);
  return job;
}

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
    // Exact saved source text wins over inferred image triage only when its
    // drawing title is unambiguous. Sections cite floor names and floor plans
    // carry section cut markers, so text naming both kinds falls through to the
    // room-label heuristic and image triage.
    const nonFloorMatch = text.match(/\b(schnitt|ansicht|lageplan|freifl[aä]chenplan|abstandsfl[aä]chen|einf[uü]genachweis|zeichnerischer\s+nachweis|site\s*plan|building\s*section|elevation)\b/i)?.[0];
    const floorMatch = text.match(/\b(grundriss|floor\s*plan)\b/i)?.[0];
    if (nonFloorMatch && !floorMatch) {
      result.push({ page, classification: "non_floor_plan", pageType: "other_drawing", confidence: 1,
        reason: `Saved source-page text identifies ${nonFloorMatch}; no floor geometry was extracted.` });
      continue;
    }
    if (floorMatch && !nonFloorMatch) {
      result.push({ page, classification: "floor_plan", pageType: "floor_plan", confidence: 1,
        reason: `Saved source-page text identifies ${floorMatch}; geometry remains an unreviewed draft.` });
      continue;
    }
    const roomLabelCount = text.match(/\b(schlafen|schlafzimmer|kind(?:erzimmer)?|bad|flur|diele|k[uü]che|wohnen|abstell(?:raum)?)\b/gi)?.length ?? 0;
    const hasApartmentSchedule = /\b(WE\s*\d+|Wfl\.?|Wohnfl[aä]che)\b/i.test(text);
    // A floor-plan title with section cut markers is still a floor plan when the sheet labels several rooms.
    if (floorMatch && roomLabelCount >= 3) {
      result.push({ page, classification: "floor_plan", pageType: "floor_plan", confidence: 1,
        reason: `Saved source-page text identifies ${floorMatch} and repeated room labels alongside ${nonFloorMatch}; geometry remains an unreviewed draft.` });
      continue;
    }
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
        // Only sources explicitly enrolled at upload time; never a cross-tenant backfill.
        sql`${sourceModels.metadata}->'automaticBuildingModel' is not null`,
        sql`coalesce(${sourceModels.metadata}->'automaticBuildingModel'->>'status','pending') not in ('planned','partial','unresolved','failed')`,
        sql`(${sourceModels.metadata}->'automaticBuildingModel'->>'status' is distinct from 'processing'
          or coalesce((${sourceModels.metadata}->'automaticBuildingModel'->>'claimedAt')::timestamptz, '-infinity') < now() - interval '10 minutes')`))
      .orderBy(sourceModels.createdAt).limit(1).for("update", { of: sourceModels, skipLocked: true });
    if (!row) return null;
    const previous = (row.sourceModel.metadata as any)?.automaticBuildingModel ?? {};
    const attempts = (Number(previous.attempts) || 0) + 1;
    const where = and(eq(sourceModels.versionId, row.sourceModel.versionId), eq(sourceModels.tenantId, row.sourceModel.tenantId));
    if (attempts > maxPlannerAttempts) {
      // Terminal: a planner pass that keeps failing is never reclaimed again.
      const reason = "Automatic plan processing failed repeatedly; no geometry was guessed. The original PDF is unchanged.";
      await tx.update(sourceModels).set({ metadata: { ...(row.sourceModel.metadata ?? {}), automaticBuildingModel: {
        ...previous, status: "failed", token: null, attempts: attempts - 1, failedAt: new Date().toISOString(), reason,
        provenance: "inferred", reviewStatus: "unreviewed" } }, updatedAt: new Date() }).where(where);
      await d.audit(tx, row.sourceModel.tenantId, "projects.building.automatic_processing.failed", row.sourceModel.versionId,
        { projectId: row.file.projectId, attempts: attempts - 1, reason });
      return { failed: true } as const;
    }
    const metadata = { ...(row.sourceModel.metadata ?? {}), automaticBuildingModel: { ...previous,
      status: "processing", token, attempts, claimedAt: new Date().toISOString(), provenance: "inferred", reviewStatus: "unreviewed",
    } };
    await tx.update(sourceModels).set({ metadata, updatedAt: new Date() }).where(where);
    return row;
  });
  if (!claimed) return false;
  if ("failed" in claimed) return true;
  const { sourceModel, extraction, version, file } = claimed;
  const imageClassification = (sourceModel.metadata as any)?.imageClassification as ImageClassification | undefined;
  const pageCount = typeof (extraction.result as any)?.pages === "number" ? (extraction.result as any).pages
    : typeof imageClassification?.totalPages === "number" ? imageClassification.totalPages : null;
  const textRows = await d.db.select({ page: sourcePages.page,
    // Native PDF text can exceed 200k characters before the title block. Keep
    // the returned payload bounded, but scan a bounded full-page window in SQL
    // so a title beyond the first text chunk still overrides image triage.
    // Floor plans carry section cut markers and sections cite floor names, so a
    // saved marker is emitted only when exactly one drawing kind is present.
    text: sql<string>`left(coalesce(${sourcePages.content}->>'text',''), 8000) || case
      when left(coalesce(${sourcePages.content}->>'text',''), 250000) ~* ${floorTitlePattern}
        and left(coalesce(${sourcePages.content}->>'text',''), 250000) !~* ${nonFloorTitlePattern}
        then ${`\n${savedFloorTitleMarker}`}
      when left(coalesce(${sourcePages.content}->>'text',''), 250000) ~* ${nonFloorTitlePattern}
        and left(coalesce(${sourcePages.content}->>'text',''), 250000) !~* ${floorTitlePattern}
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
        const job = await ensureAutomaticExtractionJob(tx, { tenantId: version.tenantId, modelId: model.id,
          sourceVersionId: version.id, storeyId: storey.id, page: page.page, createdBy: version.createdBy,
          audit: (action, jobId, metadata) => d.audit(tx, version.tenantId, action, version.id,
            { projectId: file.projectId, modelId: model.id, jobId, page: page.page, ...metadata }) });
        if (job) jobIds.push(job.id);
      }
    }
    const status = floorPages.length ? (unresolvedPages.length ? "partial" : "planned") : "unresolved";
    if (changed) {
      const [{ revision }] = await tx.update(buildingModels).set({ revision: sql`${buildingModels.revision} + 1`, updatedAt: new Date() })
        .where(eq(buildingModels.id, model.id)).returning({ revision: buildingModels.revision });
      await tx.insert(buildingRevisions).values({ tenantId: version.tenantId, modelId: model.id, revision,
        status: "draft", label: "Automatic plan pages registered", createdBy: version.createdBy }).onConflictDoNothing();
    }
    const enrollment = (current.metadata as any)?.automaticBuildingModel ?? {};
    const automaticBuildingModel = { status, enrolledAt: enrollment.enrolledAt, attempts: enrollment.attempts, plannedAt: new Date().toISOString(), provenance: "inferred",
      reviewStatus: "unreviewed", modelId: model.id, pageCount, registeredPageCount: pages.length,
      coverageTruncated: pageCount !== null && pageCount > pages.length,
      floorPlanPages: floorPages.map(page => page.page), nonFloorPlanPages: nonFloorPages.map(page => ({ page: page.page,
        pageType: page.pageType, confidence: page.confidence })), unresolvedPages: unresolvedPages.map(page => page.page),
      storeyIds, jobIds, reason: floorPages.length
        ? "Confident floor-plan pages were queued for unreviewed draft geometry. Other pages remain classified or unresolved as listed."
        : "No page met the automatic floor-plan threshold; no geometry was guessed. Page coverage remains available for review." };
    await tx.update(sourceModels).set({ metadata: { ...(current.metadata ?? {}), automaticBuildingModel,
      heightExtraction: (current.metadata as any)?.heightExtraction ?? { version: PLAN_HEIGHT_VERSION, status: "queued", pages: [] },
    }, updatedAt: new Date() })
      .where(and(eq(sourceModels.versionId, version.id), eq(sourceModels.tenantId, version.tenantId)));
    await d.audit(tx, version.tenantId, "projects.building.automatic_processing.planned", version.id,
      { projectId: file.projectId, modelId: model.id, status, pageCount, floorPlanPages: automaticBuildingModel.floorPlanPages,
        nonFloorPlanPages: automaticBuildingModel.nonFloorPlanPages, unresolvedPages: automaticBuildingModel.unresolvedPages,
        jobIds });
  });
  return true;
}
