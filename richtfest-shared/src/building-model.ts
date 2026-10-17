import { z } from "zod";

export const buildingEntityTypeSchema = z.enum(["building", "storey", "room", "element"]);
export type BuildingEntityType = z.infer<typeof buildingEntityTypeSchema>;

export const buildingConstructionStateSchema = z.enum(["existing", "retained", "demolished", "proposed", "unknown"]);
export type BuildingConstructionState = z.infer<typeof buildingConstructionStateSchema>;

export const buildingReviewStatusSchema = z.enum(["unreviewed", "proposed", "approved", "rejected", "superseded"]);
export type BuildingReviewStatus = z.infer<typeof buildingReviewStatusSchema>;

export const buildingPropertyProvenanceSchema = z.enum(["deterministic", "extracted", "inferred", "manual"]);
export type BuildingPropertyProvenance = z.infer<typeof buildingPropertyProvenanceSchema>;
export const buildingClaimKindSchema = z.enum(["observed_fact", "requirement", "assumption", "calculation_result"]);
export type BuildingClaimKind = z.infer<typeof buildingClaimKindSchema>;

/** A source revision is always named. Page/region or IFC identity is required; labels alone are not evidence. */
export const buildingEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    sourceVersionId: z.string().uuid(),
    page: z.number().int().positive(),
    region: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() }).optional(),
    layerId: z.string().max(200).optional(),
    layerName: z.string().max(300).optional(),
    quote: z.string().max(4000).optional(),
  }).strict(),
  z.object({
    kind: z.literal("ifc"),
    sourceVersionId: z.string().uuid(),
    expressId: z.number().int().positive(),
    attribute: z.string().min(1).max(200),
  }).strict(),
  // A reply in a project inquiry: an email, call note or other correspondence entry.
  z.object({
    kind: z.literal("correspondence"),
    inquiryId: z.string().uuid(),
    entryId: z.string().uuid(),
    quote: z.string().max(4000).optional(),
  }).strict(),
]);
export type BuildingEvidence = z.infer<typeof buildingEvidenceSchema>;

export const buildingEntityRefSchema = z.object({
  entityType: buildingEntityTypeSchema,
  entityId: z.string().uuid(),
}).strict();
export type BuildingEntityRef = z.infer<typeof buildingEntityRefSchema>;

export const buildingPropertyValueSchema = z.union([
  z.string(), z.number().finite(), z.boolean(), z.record(z.unknown()), z.array(z.unknown()), z.null(),
]);
export type BuildingPropertyValue = z.infer<typeof buildingPropertyValueSchema>;

export const buildingMeasurementMethodSchema = z.enum(["plan", "ifc", "survey", "manual", "derived"]);
export type BuildingMeasurementMethod = z.infer<typeof buildingMeasurementMethodSchema>;
export const buildingMeasurementSchema = z.object({
  value: z.number().finite(), unit: z.string().min(1).max(40), method: buildingMeasurementMethodSchema,
  uncertainty: z.unknown().nullable().optional(), evidence: z.array(buildingEvidenceSchema).max(20).default([]),
}).strict();
export type BuildingMeasurement = z.infer<typeof buildingMeasurementSchema>;

export const buildingModelSummarySchema = z.object({
  projectId: z.string().uuid(),
  modelId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  buildings: z.number().int().nonnegative(),
  storeys: z.number().int().nonnegative(),
  rooms: z.number().int().nonnegative(),
  elements: z.number().int().nonnegative(),
  unresolvedConflicts: z.number().int().nonnegative(),
  pendingProposals: z.number().int().nonnegative(),
}).strict();
export type BuildingModelSummary = z.infer<typeof buildingModelSummarySchema>;

export const buildingDeepLink = (projectId: string, entityType: BuildingEntityType, entityId: string) =>
  `/projects/${projectId}?view=building-model&entity=${entityType}:${entityId}`;

export const buildingExtractionRequestSchema = z.object({
  baseRevision: z.number().int().nonnegative(), sourceVersionId: z.string().uuid(),
  page: z.number().int().positive().max(2147483647), storeyId: z.string().uuid(),
}).strict();
export type BuildingExtractionRequest = z.infer<typeof buildingExtractionRequestSchema>;
export const buildingExtractionReviewSchema = z.object({
  baseRevision: z.number().int().nonnegative(), decision: z.enum(["approved", "rejected"]),
  name: z.string().trim().min(1).max(300).optional(), targetEntityId: z.string().uuid().optional(),
}).strict();
export type BuildingExtractionReview = z.infer<typeof buildingExtractionReviewSchema>;
