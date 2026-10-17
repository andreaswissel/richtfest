import { Router, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { documentTypeSchema, ok, type DocumentType, type DocumentTypeState } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { files, sourceModels, sourcePages } from "./schema";

export type DocumentTypeInference = { documentType: DocumentType; reason: string } | null;

// Checked in order; the first match wins. Titles name the document; body text mentions many other documents.
const rules: Array<{ type: DocumentType; pattern: RegExp }> = [
  { type: "construction_description", pattern: /bau-?\s*beschreibung|leistungsbeschreibung|ausstattungsbeschreibung/i },
  { type: "acoustic_report", pattern: /schall(?:schutz|technisch)\w*\s*(?:gutachten|nachweis|untersuchung|prognose|konzept)|schallgutachten|l(?:ä|ae)rmgutachten|schalltechnische/i },
  { type: "fire_safety_concept", pattern: /brandschutz\w*\s*(?:konzept|nachweis|gutachten)|brandschutzkonzept/i },
  { type: "development_plan", pattern: /bebauungsplan|\bB-?Plan\b|textliche\s+festsetzungen/i },
  { type: "noise_data", pattern: /verkehrsz(?:ä|ae)hlung|verkehrsst(?:ä|ae)rke|verkehrsmengen|\bDTV\b|l(?:ä|ae)rmkart(?:e|ierung)|fluglärm|fluglaerm|zugzahlen/i },
  { type: "permit", pattern: /baugenehmigung|bauschein|genehmigungsbescheid|bauvorbescheid/i },
];
const correspondence = /^(?:\s*(?:von|from|an|to|betreff|subject|gesendet|sent|datum|date)\s*:)|sehr\s+geehrte|mit\s+freundlichen\s+gr(?:ü|ue)(?:ß|ss)en/im;
const drawingTitle = /\b(?:grundriss|schnitt|ansicht|lageplan|floor\s*plan|section|elevation)\b/i;

/**
 * Infers a document type from the file name, the start of its first page and
 * the page types found at upload. Returns null when nothing is clear; a
 * person confirms or corrects every inference.
 */
export function inferDocumentType(input: { name: string; titleText: string; floorPlanPages: number; drawingPages: number; pages: number | null }): DocumentTypeInference {
  const title = input.titleText.slice(0, 800);
  for (const rule of rules) if (rule.pattern.test(input.name)) return { documentType: rule.type, reason: `File name: ${input.name}` };
  if (/\.(eml|msg)$/i.test(input.name)) return { documentType: "correspondence", reason: `File name: ${input.name}` };
  for (const rule of rules) {
    const match = title.match(rule.pattern);
    if (match) return { documentType: rule.type, reason: `Title text: “${match[0]}”` };
  }
  if (input.floorPlanPages > 0) return { documentType: "plans", reason: `${input.floorPlanPages} floor-plan page${input.floorPlanPages === 1 ? "" : "s"} found` };
  if (input.pages && input.drawingPages > 0 && input.drawingPages >= input.pages / 2) return { documentType: "plans", reason: `${input.drawingPages} drawing pages found` };
  const drawing = title.match(drawingTitle);
  if (drawing) return { documentType: "plans", reason: `Title text: “${drawing[0]}”` };
  const letter = title.match(correspondence);
  if (letter) return { documentType: "correspondence", reason: `Title text: “${letter[0].trim()}”` };
  return null;
}


const drawingPageTypes = new Set(["floor_plan", "section", "elevation", "other_drawing"]);

/** Document type per file: a person's confirmed type, otherwise an inference from the latest version. */
export async function documentTypesFor(d: AppDeps, rows: Array<{ fileId: string; name: string; documentType: string | null; versionId: string }>) {
  const versionIds = rows.map(row => row.versionId);
  const [titles, models] = versionIds.length ? await Promise.all([
    d.db.select({ versionId: sourcePages.versionId, text: sql<string>`left(coalesce(${sourcePages.content}->>'text',''), 1500)` }).from(sourcePages)
      .where(and(inArray(sourcePages.versionId, versionIds), eq(sourcePages.tenantId, d.tenantId), eq(sourcePages.page, 1))),
    d.db.select({ versionId: sourceModels.versionId, metadata: sourceModels.metadata }).from(sourceModels)
      .where(and(inArray(sourceModels.versionId, versionIds), eq(sourceModels.tenantId, d.tenantId))),
  ]) : [[], []];
  const titleOf = new Map((titles as any[]).map(row => [row.versionId, String(row.text ?? "")]));
  const pagesOf = new Map((models as any[]).map(row => [row.versionId, row.metadata?.automaticBuildingModel ?? null]));
  return new Map(rows.map((row): [string, DocumentTypeState] => {
    if (row.documentType && documentTypeSchema.safeParse(row.documentType).success) return [row.fileId, { documentType: row.documentType as any, provenance: "manual", reason: null }];
    const pages = pagesOf.get(row.versionId);
    // Saved page text starts with extraction markers; skip them so the title is the document's own first line.
    const title = (titleOf.get(row.versionId) ?? "").replace(/^\s*(?:\[[^\]\n]*\]\s*)+/, "");
    const inferred = inferDocumentType({ name: row.name, titleText: title, floorPlanPages: pages?.floorPlanPages?.length ?? 0,
      drawingPages: (pages?.floorPlanPages?.length ?? 0) + (pages?.nonFloorPlanPages ?? []).filter((page: any) => drawingPageTypes.has(page.pageType)).length,
      pages: pages?.pageCount ?? null });
    return [row.fileId, inferred ? { documentType: inferred.documentType, provenance: "inferred", reason: inferred.reason } : { documentType: null, provenance: null, reason: null }];
  }));
}

export function createDocumentTypesRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  // Confirm or correct a file's document type; null returns it to the inference.
  router.put("/projects/:projectId/files/:fileId/document-type", async (req, res, next) => {
    try {
      const d = getDeps(req); d.requirePermission("projects:write");
      const projectId = z.string().uuid().parse(req.params.projectId), fileId = z.string().uuid().parse(req.params.fileId);
      const input = z.object({ documentType: documentTypeSchema.nullable() }).strict().parse(req.body);
      const updated = await d.db.transaction(async (tx: any) => {
        const [row] = await tx.update(files).set({ documentType: input.documentType, documentTypeReviewedBy: input.documentType ? d.actorId : null, documentTypeReviewedAt: input.documentType ? new Date() : null })
          .where(and(eq(files.id, fileId), eq(files.projectId, projectId), eq(files.tenantId, d.tenantId))).returning();
        if (row) await d.audit(tx, "projects.file.document_type.set", "project_file", fileId, { projectId, documentType: input.documentType });
        return row;
      });
      if (!updated) return res.status(404).json({ data: null, error: { code: "not_found" }, message: "File not found" });
      return res.json(ok({ fileId, documentType: input.documentType }));
    } catch (e) { return next(e); }
  });
  return router;
}
