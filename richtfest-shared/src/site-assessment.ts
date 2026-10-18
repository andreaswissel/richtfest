import { z } from "zod";
import { siteGeometryInputSchema } from "./site-geometry-model";
import { siteReferenceSchema } from "./site-references";
export const siteAssessmentMethod = "berlin_arithmetic_v1" as const;
export const SITE_ASSESSMENT_CONSTRAINT_KEYS = ["parcelArea", "grz", "gfz", "buildableFootprint", "maxFullStoreys", "additionalGrossArea", "additionalCountableArea"] as const;
export const SITE_ASSESSMENT_CHECK_KEYS = ["planningBasis", "bauweise", "height", "setbacks", "rights", "heritage"] as const;
export type SiteAssessmentConstraintKey = typeof SITE_ASSESSMENT_CONSTRAINT_KEYS[number];
export type SiteAssessmentCheckKey = typeof SITE_ASSESSMENT_CHECK_KEYS[number];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const d = new Date(value); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value; }, "Invalid date");
export const siteAssessmentConstraintSchema = z.object({ value: z.number().finite().min(0).max(1e9).nullable(), source: z.string().trim().max(2000), sourceDate: date.nullable(), kind: z.enum(["official", "calculated", "estimated", "assessment"]), reviewed: z.boolean() }).strict();
const constraint = <T extends z.ZodTypeAny>(value: T) => siteAssessmentConstraintSchema.extend({ value: value.nullable() });
const check = z.object({ status: z.enum(["unresolved", "confirmed", "not_applicable"]), note: z.string().trim().max(2000), source: z.string().trim().max(2000) }).strict();
export const siteAssessmentInputSchema = z.object({
  baseRevision: z.number().int().min(0), jurisdiction: z.literal("BE"), planningBasis: z.enum(["b_plan", "section34", "unresolved"]),
  constraints: z.object({ parcelArea: constraint(z.number().finite().positive().max(1e9)), grz: constraint(z.number().finite().min(0).max(1)), gfz: constraint(z.number().finite().min(0).max(100)), buildableFootprint: constraint(z.number().finite().min(0).max(1e9)), maxFullStoreys: constraint(z.number().int().min(1).max(200)), additionalGrossArea: siteAssessmentConstraintSchema, additionalCountableArea: siteAssessmentConstraintSchema }).strict(),
  checks: z.object(Object.fromEntries(SITE_ASSESSMENT_CHECK_KEYS.map(key => [key, check])) as Record<SiteAssessmentCheckKey, typeof check>).strict(),
  geometry: siteGeometryInputSchema.nullable().optional(),
  siteLocator: z.object({origin:z.tuple([z.number().min(350000).max(430000),z.number().min(5780000).max(5860000)]),label:z.string().min(1).max(300),source:z.string().max(2000),reviewed:z.boolean()}).strict().optional(),
  designRules: z.object({maxHeight:z.number().finite().positive().nullable(),heightNotSpecified:z.boolean(),buildingForm:z.enum(["open","closed","deviating","unresolved"]),source:z.string().max(2000),sourceDate:date.nullable(),reviewed:z.boolean()}).strict().optional(),
  planningFacts: z.record(z.enum(["landUse", "buildingForm", "roofForm", "heightRule", "encroachments"]), z.object({ value:z.string().max(4000), source:z.string().max(2000), sourceDate:date.nullable(), reviewed:z.boolean(), kind:z.enum(["official","calculated","estimated","assessment"]) }).strict()).optional(),
  references: z.array(siteReferenceSchema).max(100), notes: z.string().max(10000), upside: z.object({ maxFullStoreys: constraint(z.number().int().min(1).max(200)), note: z.string().trim().max(2000) }).strict().nullable(),
}).strict();
export type SiteAssessmentInput = z.infer<typeof siteAssessmentInputSchema>;
export type SiteAssessmentConstraint = z.infer<typeof siteAssessmentConstraintSchema>;
export type SiteAssessmentCapacity = { footprint: number; fullFloorArea: number; countableFloorArea: number; grossFloorArea: number; gfzCapacity: number; unusedGfzCapacity: number; limits: { id: "grz" | "buildableFootprint" | "maxFullStoreys" | "gfz"; capacity: number; unit: "footprint_m2" | "full_floor_m2" }[]; bindingConstraints: string[] };
export type SiteAssessmentResult = { method: typeof siteAssessmentMethod; status: "incomplete" | "indicative" | "reviewed"; missing: string[]; limitations: string[]; baseline: SiteAssessmentCapacity | null; upside: SiteAssessmentCapacity | null; upsideStatus: "indicative" | null };
export function createEmptySiteAssessmentInput(): SiteAssessmentInput {
  return { baseRevision: 0, jurisdiction: "BE", planningBasis: "unresolved", constraints: Object.fromEntries(SITE_ASSESSMENT_CONSTRAINT_KEYS.map(key => [key, { value: null, source: "", sourceDate: null, kind: "assessment", reviewed: false }])) as SiteAssessmentInput["constraints"], checks: Object.fromEntries(SITE_ASSESSMENT_CHECK_KEYS.map(key => [key, { status: "unresolved", note: "", source: "" }])) as SiteAssessmentInput["checks"], references: [], notes: "", upside: null };
}
/** Arithmetic capacity of a supplied envelope, never a geometry solver or permission verdict. */
export function calculateSiteAssessment(raw: SiteAssessmentInput): SiteAssessmentResult {
  const parsed = siteAssessmentInputSchema.safeParse(raw);
  const result: SiteAssessmentResult = { method: siteAssessmentMethod, status: "incomplete", missing: [], limitations: ["arithmetic_envelope_only", "not_permit_or_placement"], baseline: null, upside: null, upsideStatus: null };
  if (!parsed.success) { result.missing = parsed.error.issues.map(issue => issue.path.join(".")); return result; }
  const input = parsed.data, values = input.constraints;
  for (const key of SITE_ASSESSMENT_CONSTRAINT_KEYS) {
    const item = values[key];
    if (item.value === null) result.missing.push(`constraints.${key}.value`);
    if (!item.reviewed || !item.source || !item.sourceDate) result.missing.push(`constraints.${key}.evidence`);
  }
  if (input.planningBasis === "unresolved") result.missing.push("planningBasis");
  if (input.planningBasis === "section34") {
    result.limitations.push("section34_comparison_only");
    if (!input.references.length) result.missing.push("references");
    input.references.forEach((reference, index) => {
      if (!reference.source.trim() || !reference.label.trim() || !reference.note.trim()) result.missing.push(`references.${index}`);
    });
  }
  for (const key of SITE_ASSESSMENT_CHECK_KEYS) { const c = input.checks[key]; if (c.status === "unresolved" || !c.source || !c.note || (key === "planningBasis" && c.status !== "confirmed")) result.missing.push(`checks.${key}`); }
  if (result.missing.some(key => key.endsWith(".evidence"))) result.limitations.push("unreviewed_evidence");
  if (result.missing.some(key => key.startsWith("checks.") || key === "planningBasis")) result.limitations.push("unresolved_checks");
  if (SITE_ASSESSMENT_CONSTRAINT_KEYS.some(key => values[key].value === null)) return result;
  const n = Object.fromEntries(SITE_ASSESSMENT_CONSTRAINT_KEYS.map(key => [key, values[key].value])) as Record<SiteAssessmentConstraintKey, number>;
  if (n.additionalCountableArea > n.additionalGrossArea) { result.limitations.push("inconsistent_extra_area"); result.missing.push("constraints.additionalCountableArea"); return result; }
  const gfzCapacity = n.parcelArea * n.gfz;
  if (n.additionalCountableArea > gfzCapacity) { result.limitations.push("extra_area_exceeds_gfz"); result.missing.push("constraints.additionalCountableArea"); return result; }
  const capacity = (storeys: number): SiteAssessmentCapacity => {
    const grzFootprint = n.parcelArea * n.grz, footprint = Math.min(grzFootprint, n.buildableFootprint), envelopeCapacity = footprint * storeys, available = gfzCapacity - n.additionalCountableArea, fullFloorArea = Math.min(envelopeCapacity, available);
    const equal = (a: number, b: number) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
    const bindingConstraints: string[] = [];
    if (equal(fullFloorArea, envelopeCapacity)) { if (equal(footprint, grzFootprint)) bindingConstraints.push("grz"); if (equal(footprint, n.buildableFootprint)) bindingConstraints.push("buildableFootprint"); bindingConstraints.push("maxFullStoreys"); }
    if (equal(fullFloorArea, available)) bindingConstraints.push("gfz");
    return { footprint, fullFloorArea, countableFloorArea: fullFloorArea + n.additionalCountableArea, grossFloorArea: fullFloorArea + n.additionalGrossArea, gfzCapacity, unusedGfzCapacity: Math.max(0, gfzCapacity - fullFloorArea - n.additionalCountableArea), limits: [{ id: "grz", capacity: grzFootprint, unit: "footprint_m2" }, { id: "buildableFootprint", capacity: n.buildableFootprint, unit: "footprint_m2" }, { id: "maxFullStoreys", capacity: envelopeCapacity, unit: "full_floor_m2" }, { id: "gfz", capacity: available, unit: "full_floor_m2" }], bindingConstraints };
  };
  result.baseline = capacity(n.maxFullStoreys); result.status = result.missing.length ? "indicative" : "reviewed";
  if (input.upside) { result.limitations.push("upside_requires_separate_review"); if (input.upside.maxFullStoreys.value !== null) { result.upside = capacity(input.upside.maxFullStoreys.value); result.upsideStatus = "indicative"; } }
  return result;
}
