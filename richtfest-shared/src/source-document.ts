import { z } from "zod";

export const SOURCE_DOCUMENT_PARSER_VERSION = "text-grid-v1" as const;
export const sourceDocumentLayersSchema = z.object({
  status: z.enum(["detected", "none", "unavailable"]),
  parserVersion: z.literal("pdfjs-optional-content-v1"),
  visibilityIntent: z.literal("display"),
  originalPdfSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  groups: z.array(z.object({ id: z.string(), name: z.string().nullable(),
    defaultVisibility: z.enum(["visible", "hidden", "unknown"]), order: z.number().int().nonnegative(),
    path: z.array(z.string()),
  }).strict()),
  reason: z.string().optional(),
  blockAssociation: z.literal("unknown"),
}).strict();
export type SourceDocumentLayers = z.infer<typeof sourceDocumentLayersSchema>;

export const sourceDocumentBlockSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().positive(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  layerAssociation: z.literal("unknown"),
}).strict();

/** Byte offsets address the unchanged saved text, not bytes in the PDF file.
 * Line/column are one-based Unicode-code-point positions in extracted text.
 * Tabs count as one character; positions are never physical PDF coordinates. */
export const sourceDocumentPageSchema = z.object({
  version: z.literal(1),
  parserVersion: z.literal(SOURCE_DOCUMENT_PARSER_VERSION),
  versionId: z.string().uuid(),
  page: z.number().int().positive(),
  rawTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rawTextBytes: z.number().int().nonnegative(),
  origin: z.enum(["native_text", "ocr", "unknown"]),
  status: z.enum(["available", "incomplete", "unreadable"]),
  sourceStatus: z.enum(["processing", "available", "unsupported", "extraction_too_large", "extraction_failed"]),
  positionSpace: z.literal("extracted_text_grid"),
  blocks: z.array(sourceDocumentBlockSchema),
  limitations: z.array(z.string()),
}).strict();
export type SourceDocumentPage = z.infer<typeof sourceDocumentPageSchema>;
export type SourceDocumentBlock = z.infer<typeof sourceDocumentBlockSchema>;

export const sourceDocumentModelSchema = z.object({
  version: z.literal(1),
  versionId: z.string().uuid(),
  pages: z.array(sourceDocumentPageSchema),
  layers: sourceDocumentLayersSchema,
  layersPrepared: z.boolean(),
  coverage: z.object({
    extractionStatus: z.string(),
    totalPages: z.number().int().positive().nullable(),
    savedPages: z.number().int().nonnegative(),
    preparedPages: z.number().int().nonnegative(),
    unpreparedPages: z.number().int().nonnegative(),
    unreadablePages: z.number().int().nonnegative(),
    incompletePages: z.number().int().nonnegative(),
    complete: z.boolean(),
    semanticCompleteness: z.literal(false),
  }).strict(),
  nextOffset: z.number().int().nonnegative().nullable(),
}).strict();
export type SourceDocumentModel = z.infer<typeof sourceDocumentModelSchema>;
