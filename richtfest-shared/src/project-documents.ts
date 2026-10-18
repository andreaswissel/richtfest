import { z } from "zod";

/** What a project document holds, so it can flow to where it is used. */
export const documentTypeSchema = z.enum(["plans", "construction_description", "development_plan", "acoustic_report", "fire_safety_concept",
  "noise_data", "permit", "correspondence", "other"]);
export type DocumentType = z.infer<typeof documentTypeSchema>;
/** A person's confirmed type wins; otherwise the inference, which stays unreviewed. */
export type DocumentTypeState = { documentType: DocumentType | null; provenance: "manual" | "inferred" | null; reason: string | null };

/** Content-derived upload proposal; never an approval or a planning determination. */
export type DocumentTypeProposal = {
  versionId: string;
  documentType: DocumentType | null;
  kind: "development_plan" | "preliminary_permit" | "permit" | "building_encumbrance" | "right_of_way" | "cadastral" | null;
  reviewStatus: "unreviewed";
  status: "proposed" | "unknown" | "ambiguous";
  evidence: Array<{ page: number; quote: string }>;
};
