import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { PLAN_HEIGHT_VERSION, planHeightOutputSchema, type PlanHeightExtraction, type PlanHeightPage } from "@richtfest/shared/plan-heights";
import type { SourceExtractionDeps } from "./deps";
import { buildingSupersededSources, fileVersions, files, sourceModels, sourcePages } from "./schema";
import { extractSourceVisual } from "./source-text";

const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

/** Validate the quoted number independently of the provider's interpretation of its endpoints. */
export function readPlanHeightOutput(raw: unknown, text: string) {
  const output = planHeightOutputSchema.parse(raw);
  const source = normalize(text);
  const rejected = output.observations.filter(observation => {
    const quote = normalize(observation.quote);
    const numbers = [...quote.matchAll(/[+-]?\d+(?:[.,]\d+)?/g)].map(match => Number(match[0].replace(",", ".")));
    const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A naked 9.54 quote must not match the tail of 19.54 or lose a minus sign.
    const exact = new RegExp(`(?<![\\d.,+\\-])${escaped}(?![\\d.,])`).test(source);
    return !exact || !numbers.includes(observation.value);
  });
  return { observations: output.observations.filter(observation => !rejected.includes(observation)),
    gaps: [...output.gaps, ...(rejected.length ? [`${rejected.length} observations rejected: the quoted text or printed numeric value was not supported by this page.`] : [])] };
}

export function selectHeightPages(pages: { page: number; text: string }[], floorPages: number[], receipts: any[] = []) {
  const candidates = pages.filter(page => !floorPages.includes(page.page) && (
    /\b(schnitt|ansicht|building\s+section|elevation)\b/i.test(page.text)
    || receipts.some(receipt => receipt.page === page.page && receipt.status === "completed"
      && receipt.answers?.page_type?.confidence >= 0.6 && ["section", "elevation"].includes(receipt.answers.page_type.choice))
  )).sort((a, b) => a.page - b.page);
  return { selected: candidates.slice(0, 6), omittedPages: candidates.slice(6).map(page => page.page) };
}

/** One bounded, durable pass. A claim is recorded before any provider request; unknown outcomes never auto-retry. */
export async function runPlanHeightExtraction(d: SourceExtractionDeps, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const token = crypto.randomUUID();
  const claimed = await d.db.transaction(async (tx: any) => {
    const [row] = await tx.select({ source: sourceModels, version: fileVersions, file: files }).from(sourceModels)
      .innerJoin(fileVersions, and(eq(fileVersions.id, sourceModels.versionId), eq(fileVersions.tenantId, sourceModels.tenantId)))
      .innerJoin(files, and(eq(files.id, fileVersions.fileId), eq(files.tenantId, sourceModels.tenantId)))
      .where(and(eq(fileVersions.status, "ready"), eq(files.purpose, "project_evidence"),
        sql`(${sourceModels.metadata}->'heightExtraction'->>'status' = 'queued'
          or (${sourceModels.metadata}->'heightExtraction'->>'status' = 'processing'
            and (${sourceModels.metadata}->'heightExtraction'->>'claimedAt')::timestamptz < now() - interval '20 minutes'))`,
        sql`not exists (select 1 from ${buildingSupersededSources} s where s.tenant_id=${sourceModels.tenantId}
          and s.source_version_id=${sourceModels.versionId})`))
      .orderBy(sourceModels.createdAt).limit(1).for("update", { of: sourceModels, skipLocked: true });
    if (!row) return null;
    const previous = row.source.metadata.heightExtraction as PlanHeightExtraction;
    if (previous.status === "processing") {
      await tx.update(sourceModels).set({ metadata: { ...row.source.metadata, heightExtraction: { ...previous, status: "partial", token: null } }, updatedAt: new Date() })
        .where(and(eq(sourceModels.versionId, row.version.id), eq(sourceModels.tenantId, row.source.tenantId)));
      await d.audit(tx, row.source.tenantId, "projects.building.heights.interrupted", row.version.id, { extractorVersion: PLAN_HEIGHT_VERSION, automaticRetry: false });
      return { interrupted: true } as const;
    }
    await tx.update(sourceModels).set({ metadata: { ...row.source.metadata, heightExtraction: {
      ...previous, status: "processing", token, claimedAt: new Date().toISOString(),
    } }, updatedAt: new Date() }).where(and(eq(sourceModels.versionId, row.version.id), eq(sourceModels.tenantId, row.source.tenantId)));
    return row;
  });
  if (!claimed) return false;
  if ("interrupted" in claimed) return true;
  const { source, version, file } = claimed;
  const where = and(eq(sourceModels.versionId, version.id), eq(sourceModels.tenantId, source.tenantId));
  let receipt: PlanHeightExtraction = { version: PLAN_HEIGHT_VERSION, status: "processing", pages: [], token, claimedAt: new Date().toISOString() };
  const save = async () => d.db.transaction(async (tx: any) => {
    const [current] = await tx.select().from(sourceModels).where(where).for("update");
    if (current?.metadata?.heightExtraction?.token !== token) throw new Error("Height extraction claim lost");
    await tx.update(sourceModels).set({ metadata: { ...current.metadata, heightExtraction: receipt }, updatedAt: new Date() }).where(where);
  });
  try {
    const pageRows: { page: number; text: string }[] = await d.db.select({ page: sourcePages.page,
      text: sql<string>`left(coalesce(${sourcePages.content}->>'text',''), 60000)` }).from(sourcePages)
      .where(and(eq(sourcePages.versionId, version.id), eq(sourcePages.tenantId, source.tenantId))).orderBy(sourcePages.page).limit(500);
    const selection = selectHeightPages(pageRows, (source.metadata as any)?.automaticBuildingModel?.floorPlanPages ?? [],
      (source.metadata as any)?.imageClassification?.receipts ?? []);
    receipt.selectedPages = selection.selected.map(page => page.page);
    receipt.omittedPages = selection.omittedPages;
    await save();
    for (const page of selection.selected) {
      signal.throwIfAborted();
      const entry: PlanHeightPage = { page: page.page, status: "outcome_unknown", observations: [], gaps: ["Height reading was interrupted; no automatic provider retry."] };
      receipt.pages.push(entry);
      await save();
      if (!d.structureDocument) {
        Object.assign(entry, { status: "unconfigured", gaps: ["No configured height-reading provider adapter."] });
        break;
      }
      const stream = version.storageKey && await d.fileStorage.read(version.storageKey, signal);
      const visual = stream && await extractSourceVisual(stream, version.mimeType ?? "application/pdf", file.name,
        { versionId: version.id, page: page.page }, signal);
      if (!visual || visual.status !== "available" || !visual.image) {
        Object.assign(entry, { status: "unavailable", gaps: ["The original section/elevation could not be rendered. No height was guessed."] });
        await save();
        continue;
      }
      const result = await d.structureDocument({ tenantId: source.tenantId, actorId: (source.metadata as any)?.heightExtraction?.requestedBy ?? version.createdBy,
        versionId: version.id, task: "plan_heights", pages: [page], image: { ...visual.image, scope: "image" } });
      if ("metadata" in result) entry.metadata = { ...result.metadata,
        inputHash: createHash("sha256").update(JSON.stringify({ versionId: version.id, ...page, image: visual.image.data, extractorVersion: PLAN_HEIGHT_VERSION })).digest("hex") };
      if (result.status === "completed") {
        Object.assign(entry, { status: "completed", ...readPlanHeightOutput(result.output, page.text) });
      } else Object.assign(entry, { status: result.status, gaps: [`Height reading ${result.status}; no automatic provider retry.`] });
      await save();
      if (result.status === "unconfigured" || result.status === "forbidden") break;
    }
    receipt.status = !selection.selected.length ? "unavailable"
      : receipt.pages.length === selection.selected.length && receipt.pages.every(page => page.status === "completed") && !selection.omittedPages.length ? "complete" : "partial";
  } catch {
    receipt.status = "partial";
  }
  receipt.token = null;
  await save();
  await d.audit(d.db, source.tenantId, "projects.building.heights.completed", version.id,
    { status: receipt.status, extractorVersion: receipt.version, pages: receipt.pages.map(page => ({ page: page.page, status: page.status, observations: page.observations.length, metadata: page.metadata })), omittedPages: receipt.omittedPages });
  return true;
}
