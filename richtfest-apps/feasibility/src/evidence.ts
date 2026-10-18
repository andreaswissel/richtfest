import { z } from "zod";
import { SITE_ASSESSMENT_CONSTRAINT_KEYS, SITE_ASSESSMENT_OPTIONAL_CONSTRAINT_KEYS, siteAssessmentInputSchema, createEmptySiteAssessmentInput } from "@richtfest/shared";
export const evidenceRequestSchema = z.object({ versionId: z.string().uuid(), pages: z.array(z.number().int().min(1).max(10000)).min(1).max(8).transform(p => [...new Set(p)].sort((a,b)=>a-b)), provider: z.enum(["openai", "anthropic"]), visual: z.boolean().default(false) }).strict().refine(v => !v.visual || v.pages.length === 1, "Visual interpretation requires one exact page");
export type EvidenceRequest = z.infer<typeof evidenceRequestSchema>;
export type EvidenceSource = { fileId: string; versionId: string; name: string; version: number; status: string; pages: number | null; documentTypeProposal?: import("@richtfest/shared").DocumentTypeProposal };
export type EvidencePage = { page: number; text: string };
export const PLANNING_FACT_KEYS = ["landUse", "buildingForm", "roofForm", "heightRule", "encroachments"] as const;
const planningFact = z.object({key:z.enum(PLANNING_FACT_KEYS),value:z.string().trim().min(1).max(2000),page:z.number().int().positive(),quote:z.string().trim().max(1500),reason:z.string().trim().min(1).max(2000),evidenceKind:z.enum(["text","image"])}).strict();
export const evidenceOutputSchema = z.object({ constraints: z.array(z.object({ key: z.enum([...SITE_ASSESSMENT_CONSTRAINT_KEYS, ...SITE_ASSESSMENT_OPTIONAL_CONSTRAINT_KEYS]), value: z.number().finite().min(0).max(1e9), page: z.number().int().positive(), quote: z.string().trim().max(1500), reason: z.string().trim().min(1).max(2000), evidenceKind: z.enum(["text", "image"]) }).strict()).max(20), planningFacts:z.array(planningFact).max(20).default([]), limitations: z.array(z.string().max(1000)).max(20) }).strict();
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
      const input = createEmptySiteAssessmentInput(); (input.constraints as Record<string, { value: number | null; source: string; sourceDate: string | null; kind: string; reviewed: boolean }>)[claim.key] = { value: claim.value, source: "", sourceDate: null, kind: "assessment", reviewed: false };
      siteAssessmentInputSchema.parse(input);
    }
  }
  return output;
}
export type EvidenceHost = {
  listSources(projectId: string): Promise<EvidenceSource[]>;
  importOfficialPdf(projectId: string, url: string): Promise<EvidenceSource>;
  interpret(projectId: string, input: EvidenceRequest): Promise<{ status: "completed"; output: EvidenceOutput; model: string } | { status: "unconfigured" }>;
} & Partial<PlanLinesHost>;

/** Baugrenze/Baulinie tracing: one plan page cropped around the aligned parcel; coordinates are crop-normalised (x right, y down). */
const crop = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.01).max(1), height: z.number().min(0.01).max(1) }).strict()
  .refine(c => c.x + c.width <= 1.0001 && c.y + c.height <= 1.0001, "Crop must stay on the page");
const unit = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
/** `site` is the aligned parcel outline in the same crop coordinates, so the model knows which window matters. */
export const planLinesRequestSchema = z.object({ versionId: z.string().uuid(), page: z.number().int().min(1).max(10000), provider: z.enum(["openai", "anthropic"]), crop, site: z.array(z.tuple([z.number().min(-1).max(2), z.number().min(-1).max(2)])).min(3).max(200) }).strict();
export type PlanLinesRequest = z.infer<typeof planLinesRequestSchema>;
export const planLinesOutputSchema = z.object({
  baugrenzen: z.array(z.object({ points: z.array(unit).min(3).max(200), reason: z.string().trim().min(1).max(1000) }).strict()).max(10),
  baulinien: z.array(z.object({ points: z.array(unit).min(2).max(200), reason: z.string().trim().min(1).max(1000) }).strict()).max(10),
  limitations: z.array(z.string().max(1000)).max(20),
}).strict();
export type PlanLinesOutput = z.infer<typeof planLinesOutputSchema>;
export type PlanLinesHost = { traceLines(projectId: string, input: PlanLinesRequest): Promise<{ status: "completed"; output: PlanLinesOutput; model: string } | { status: "unconfigured" }> };
