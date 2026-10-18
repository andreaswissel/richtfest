import type { SiteAssessmentInput } from "@richtfest/shared";
import { api } from "../../api";
import type { AdoptedEvidence } from "./site-evidence-panel";
import type { BerlinPlan, BerlinSiteContext } from "./site-lookups";

type Draft = Omit<SiteAssessmentInput, "baseRevision">;
type Locator = NonNullable<SiteAssessmentInput["siteLocator"]>;
type Source = { versionId: string; pages: number | null };
type Claim = { key: string };
type Proposal = { id: string; status: string; error?: string | null; payload: { constraints: Claim[]; planningFacts: Claim[] } | null };
export type PlanProvider = "openai" | "anthropic";
export type PlanExtraction = {
  plan: string;
  status: "extracted" | "empty" | "unconfigured" | "failed";
  constraints: NonNullable<AdoptedEvidence["constraint"]>[];
  facts: NonNullable<AdoptedEvidence["constraint"]>[];
  message?: string;
};
/** Figures a B-Plan sets that the capacity check needs; the plan sheet's Nutzungsschablone carries them. */
export const PLAN_FIGURES = ["grz", "gfz", "maxFullStoreys"] as const;
const MAX_TEXT_PAGES = 8;

/** The adopted plan covering the address, when the summary should read it: B-Plan (or unresolved) basis with figures missing. */
export function planToRead(draft: Draft, context: BerlinSiteContext | null): BerlinPlan | null {
  if (!context || context.planStatus !== "available" || draft.planningBasis === "section34") return null;
  if (PLAN_FIGURES.every((key) => draft.constraints[key].value !== null)) return null;
  const covering = context.plans.filter((p) => p.containsAddress);
  const adopted = covering.find((p) => p.status === "adopted");
  return adopted?.documentUrl ? adopted : null;
}

/**
 * Reads the covering plan through the existing evidence workflow: imports the official PDF into the project's
 * sources, asks the explicitly selected provider for cited figures, and records each figure it uses as an
 * adopted proposal. The values still enter the draft unreviewed, with the page and quote as their source.
 */
export async function extractPlanFigures(projectId: string, locator: Locator | undefined, plan: BerlinPlan, provider: PlanProvider, draft: Draft): Promise<PlanExtraction> {
  const path = `/feasibility/projects/${projectId}/evidence`;
  const result: PlanExtraction = { plan: plan.name, status: "empty", constraints: [], facts: [] };
  try {
    const source = await api<Source>(`${path}/import`, { url: plan.documentUrl, ...(locator ? { mapOrigin: locator.origin, mapLabel: locator.label } : {}) }, "POST");
    const pageCount = Math.max(1, source.pages ?? 1);
    const interpret = (pages: number[], visual: boolean) => api<Proposal>(`${path}/interpret`, { versionId: source.versionId, pages, provider, visual }, "POST");
    let proposal = await interpret(Array.from({ length: Math.min(MAX_TEXT_PAGES, pageCount) }, (_, i) => i + 1), false);
    if (proposal.status === "unconfigured") return { ...result, status: "unconfigured" };
    // Plan sheets are usually scans: without cited text figures, read the first sheet as an image.
    if (proposal.status !== "completed" || !proposal.payload?.constraints.length) proposal = await interpret([1], true);
    if (proposal.status === "unconfigured") return { ...result, status: "unconfigured" };
    if (proposal.status !== "completed" || !proposal.payload) return { ...result, status: "failed", message: proposal.error ?? undefined };
    const adopt = async (collection: "constraints" | "planningFacts", index: number) =>
      (await api<AdoptedEvidence>(`${path}/proposals/${proposal.id}/review`, { collection, index, decision: "adopted" }, "POST")).constraint;
    const taken = new Set<string>();
    for (const [index, claim] of proposal.payload.constraints.entries()) {
      const key = claim.key as keyof Draft["constraints"];
      if (taken.has(key) || !(key in draft.constraints) || draft.constraints[key].value !== null) continue;
      taken.add(key);
      const value = await adopt("constraints", index);
      if (value) result.constraints.push(value);
    }
    for (const [index, claim] of proposal.payload.planningFacts.entries()) {
      const key = claim.key as keyof NonNullable<Draft["planningFacts"]>;
      if (taken.has(key) || draft.planningFacts?.[key]?.value) continue;
      taken.add(key);
      const value = await adopt("planningFacts", index);
      if (value) result.facts.push(value);
    }
    return { ...result, status: result.constraints.length || result.facts.length ? "extracted" : "empty" };
  } catch (error) {
    return { ...result, status: "failed", message: (error as Error).message };
  }
}

/** Building form from the plan's text ("geschlossene Bauweise", "g", "offene Bauweise", "o"), or null when not stated. */
export function planBuildingForm(value: string): "closed" | "open" | null {
  const text = value.toLowerCase();
  if (/geschlossen|closed|\bg\b/.test(text)) return "closed";
  if (/offen|open|\bo\b/.test(text)) return "open";
  return null;
}
