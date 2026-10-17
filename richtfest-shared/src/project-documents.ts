import { z } from "zod";

/** What a project document holds, so it can flow to where it is used. */
export const documentTypeSchema = z.enum(["plans", "construction_description", "development_plan", "acoustic_report", "fire_safety_concept",
  "noise_data", "permit", "correspondence", "other"]);
export type DocumentType = z.infer<typeof documentTypeSchema>;
/** A person's confirmed type wins; otherwise the inference, which stays unreviewed. */
export type DocumentTypeState = { documentType: DocumentType | null; provenance: "manual" | "inferred" | null; reason: string | null };
