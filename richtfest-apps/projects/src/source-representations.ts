import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { SourcePdfRepresentation } from "@richtfest/shared";
import { files, fileVersions, projects, sourceRepresentations } from "./schema";

/** Read only explicit, still-ready pairings. Confirmation attests a matching full export, not content approval. */
export async function readPdfRepresentations(
  db: any, tenantId: string, projectId: string, versionIds: string[],
): Promise<Record<string, SourcePdfRepresentation>> {
  if (!versionIds.length) return {};
  const original = alias(fileVersions, "representation_original");
  const originalFile = alias(files, "representation_original_file");
  const pdf = alias(fileVersions, "representation_pdf");
  const pdfFile = alias(files, "representation_pdf_file");
  const rows = await db.select({ link: sourceRepresentations, originalName: originalFile.name, pdf, pdfFile })
    .from(sourceRepresentations)
    .innerJoin(original, and(eq(original.id, sourceRepresentations.originalVersionId), eq(original.tenantId, tenantId), eq(original.status, "ready")))
    .innerJoin(originalFile, and(eq(originalFile.id, original.fileId), eq(originalFile.tenantId, tenantId), eq(originalFile.projectId, projectId)))
    .innerJoin(projects, and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)))
    .innerJoin(pdf, and(eq(pdf.id, sourceRepresentations.pdfVersionId), eq(pdf.tenantId, tenantId), eq(pdf.status, "ready"), eq(pdf.mimeType, "application/pdf")))
    .innerJoin(pdfFile, and(eq(pdfFile.id, pdf.fileId), eq(pdfFile.tenantId, tenantId), eq(pdfFile.projectId, projectId)))
    .where(and(eq(sourceRepresentations.tenantId, tenantId), inArray(sourceRepresentations.originalVersionId, versionIds)));
  const result: Record<string, SourcePdfRepresentation> = {};
  for (const row of rows) {
    if (!/\.afpub$/i.test(row.originalName) || row.link.originalVersionId === row.pdf.id) continue;
    result[row.link.originalVersionId] = {
      originalVersionId: row.link.originalVersionId,
      pdf: { versionId: row.pdf.id, fileId: row.pdfFile.id, fileName: row.pdfFile.name,
        version: row.pdf.version, mimeType: row.pdf.mimeType,
        downloadUrl: `/api/projects/${projectId}/files/${row.pdfFile.id}/versions/${row.pdf.version}/download` },
      confirmedBy: row.link.confirmedBy,
      confirmedAt: row.link.confirmedAt.toISOString(),
    };
  }
  return result;
}
