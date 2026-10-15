import { z } from "zod";
import { sourceVisualRequestSchema } from "./source-text";

export const SOURCE_IMAGE_MODEL = "jev-1.14.0";
export const SOURCE_IMAGE_QUERY_VERSION = "image-triage-v1";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const instructions = z.string().min(1).max(1000);
const probability = z.number().finite().min(0).max(1);
export const sourceImageQuestionsSchema = z.record(id, z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), instructions,
    criteria: z.record(id, z.string().min(1).max(300)).refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 12) }).strict(),
  z.object({ type: z.literal("noul"), instructions }).strict(),
  z.object({ type: z.literal("box"), instructions, presenceQuestion: id }).strict(),
])).refine(v => Object.keys(v).length >= 1 && Object.keys(v).length <= 8)
  .refine(v => Object.values(v).every(q => q.type !== "box" || v[q.presenceQuestion]?.type === "noul"),
    "Every box requires a companion presence Noul question");
export type SourceImageQuestions = z.infer<typeof sourceImageQuestionsSchema>;

/** Shared by upload classification and the tool's default query, permitting exact reuse. */
export const sourceImageClassificationQuestions: SourceImageQuestions = {
  page_type: { type: "choice", instructions: "Classify this page by visible layout. Select mixed or unknown rather than guessing.", criteria: {
    floor_plan: "Floor plan", section: "Building section", elevation: "Building elevation", report: "Report prose",
    table: "Primarily a table or schedule", photograph: "Photograph", correspondence: "Letter or correspondence",
    mixed: "Several equally prominent content types", other: "Another clearly recognizable type", unknown: "Cannot determine",
  } },
  legend: { type: "noul", instructions: "Is a drawing legend visible on this page?" },
  title_block: { type: "noul", instructions: "Is a drawing title block visible on this page?" },
  table: { type: "noul", instructions: "Is a table or schedule visible on this page?" },
};
export const sourceImageQuerySchema = sourceVisualRequestSchema.extend({
  questions: sourceImageQuestionsSchema.optional(),
}).strict();
export type SourceImageQuery = z.infer<typeof sourceImageQuerySchema>;
export const sourceImageAnswersSchema = z.record(id, z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), choice: id, probabilities: z.record(id, probability), confidence: probability }).strict(),
  z.object({ type: z.literal("noul"), noul: probability }).strict(),
  z.object({ type: z.literal("box"), box: z.object({ left: probability, right: probability, top: probability, bottom: probability })
    .strict().refine(b => b.left < b.right && b.top < b.bottom).nullable(), confidence: probability.nullable(),
    presenceProbability: probability }).strict(),
]));
export type SourceImageAnswers = z.infer<typeof sourceImageAnswersSchema>;
export type SourceImageDecision = {
  model: typeof SOURCE_IMAGE_MODEL;
  answers: SourceImageAnswers;
};
export type SourceImageInference = {
  image: { mediaType: "image/jpeg"; data: string };
  questions: SourceImageQuestions;
  signal?: AbortSignal;
};
export type SourceImageReceipt = {
  versionId: string;
  page: number;
  crop?: SourceImageQuery["crop"];
  status: "completed" | "unavailable" | "unconfigured" | "outcome_unknown" | "limit_reached";
  provenance: "inferred";
  semanticInspection: false;
  scope?: "pdf_page" | "image" | "affinity_preview";
  reason: string;
  queryVersion: typeof SOURCE_IMAGE_QUERY_VERSION;
  model: typeof SOURCE_IMAGE_MODEL;
  answers?: SourceImageAnswers;
  reused?: boolean;
};
