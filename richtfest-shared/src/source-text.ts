import { z } from "zod";

/** Human-confirmed full export of an exact original revision; not content approval. */
export type SourcePdfRepresentation = {
  originalVersionId: string;
  pdf: { versionId: string; fileId: string; fileName: string; version: number; mimeType: string; downloadUrl: string };
  confirmedBy: string;
  confirmedAt: string;
};

/** Normalized crop coordinates in the displayed page, with a top-left origin. */
export const sourceVisualRequestSchema = z.object({
  versionId: z.string().uuid(),
  page: z.number().int().positive(),
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
    .refine(c => c.x + c.width <= 1 && c.y + c.height <= 1, "Crop must fit within the page").nullish(),
}).strict();
export type SourceVisualRequest = z.infer<typeof sourceVisualRequestSchema>;
export type SourceVisual = SourceVisualRequest & ({
  status: "available" | "unavailable";
  scope: "pdf_page" | "image" | "affinity_preview";
  reason: string;
  image?: { mediaType: "image/jpeg"; data: string };
} | {
  status: "budget_exhausted";
  reason: string;
  scope?: never;
  image?: never;
});

/** Extracted text is unreviewed evidence, never an approved interpretation. */
export type SourceText = {
  status: "processing" | "available" | "unsupported" | "extraction_too_large" | "extraction_failed";
  text?: string;
  truncated?: boolean;
  reason?: string;
  pages?: number;
  coverage?: {
    pageStart: number;
    pageEnd: number;
    totalPages: number;
    truncated: boolean;
    nextPage: number | null;
  };
  retrieval?: {
    mode: "relevant_passages" | "pages";
    pageNumbers: number[];
    characters: number;
  };
};
