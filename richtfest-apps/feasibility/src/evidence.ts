import { z } from "zod";
import { SITE_ASSESSMENT_CONSTRAINT_KEYS, siteAssessmentInputSchema, createEmptySiteAssessmentInput } from "@richtfest/shared";
export const evidenceRequestSchema = z.object({ versionId: z.string().uuid(), pages: z.array(z.number().int().min(1).max(10000)).min(1).max(8).transform(p => [...new Set(p)].sort((a,b)=>a-b)), provider: z.enum(["openai", "anthropic"]), visual: z.boolean().default(false) }).strict().refine(v => !v.visual || v.pages.length === 1, "Visual interpretation requires one exact page");
export type EvidenceRequest = z.infer<typeof evidenceRequestSchema>;
export type EvidenceSource = { fileId: string; versionId: string; name: string; version: number; status: string; pages: number | null; documentTypeProposal?: import("@richtfest/shared").DocumentTypeProposal };
export type EvidencePage = { page: number; text: string };
export const PLANNING_FACT_KEYS = ["landUse", "buildingForm", "roofForm", "heightRule", "encroachments"] as const;
const planningFact = z.object({key:z.enum(PLANNING_FACT_KEYS),value:z.string().trim().min(1).max(2000),page:z.number().int().positive(),quote:z.string().trim().max(1500),reason:z.string().trim().min(1).max(2000),evidenceKind:z.enum(["text","image"])}).strict();
export const evidenceOutputSchema = z.object({ constraints: z.array(z.object({ key: z.enum(SITE_ASSESSMENT_CONSTRAINT_KEYS), value: z.number().finite().min(0).max(1e9), page: z.number().int().positive(), quote: z.string().trim().max(1500), reason: z.string().trim().min(1).max(2000), evidenceKind: z.enum(["text", "image"]) }).strict()).max(20), planningFacts:z.array(planningFact).max(20).default([]), limitations: z.array(z.string().max(1000)).max(20) }).strict();
export type EvidenceOutput = z.infer<typeof evidenceOutputSchema>;
export function validateEvidenceOutput(raw: unknown, pages: EvidencePage[], visual: boolean): EvidenceOutput {
  const output = evidenceOutputSchema.parse(raw);
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const claim of [...output.constraints,...output.planningFacts]) {
    const page = pages.find(p => p.page === claim.page);
    if (!page) throw new Error("Proposal cites a page not supplied to the provider");
    if (claim.evidenceKind === "image") { if (!visual) throw new Error("Image evidence was not supplied"); }
    else if (!normalize(claim.quote) || !normalize(page.text).includes(normalize(claim.quote))) throw new Error("Proposal quote does not occur on its cited page");
    if(typeof claim.value === "number") {
      const input = createEmptySiteAssessmentInput(); input.constraints[claim.key as typeof SITE_ASSESSMENT_CONSTRAINT_KEYS[number]].value = claim.value;
      siteAssessmentInputSchema.parse(input);
    }
  }
  return output;
}
export type EvidenceHost = {
  listSources(projectId: string): Promise<EvidenceSource[]>;
  importOfficialPdf(projectId: string, url: string): Promise<EvidenceSource>;
  interpret(projectId: string, input: EvidenceRequest): Promise<{ status: "completed"; output: EvidenceOutput; model: string } | { status: "unconfigured" }>;
};
