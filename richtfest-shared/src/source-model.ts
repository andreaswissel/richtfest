import { z } from "zod";

export const sourceModelEvidencePolicy = "Saved source model facts are already imported; use them directly instead of repeating extraction or requirements discovery. Deterministic IFC values are declarations from the file, not validated calculations. Keep deterministic, extracted and inferred provenance distinct. Each fact has its own reviewStatus: rejected claims must not support a recommendation, unreviewed claims remain proposals, and approved claims do not validate calculations or approve other claims. Preserve conflicting values and exact source revision/page/quote or IFC express IDs. Partial fact retrieval never proves absence or complete source coverage.";

/** Source claims, never a merged or automatically approved engineering model. */
export const sourceValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("number"), value: z.number().finite() }),
  z.object({ type: z.literal("boolean"), value: z.boolean() }),
  z.object({ type: z.literal("logical"), value: z.literal("unknown") }),
  z.object({ type: z.literal("reference"), value: z.string() }),
  z.object({ type: z.literal("structured"), value: z.unknown() }),
]);
export const sourceEntityInput = z.object({
  key: z.string().min(1), kind: z.string().min(1), name: z.string(), globalId: z.string().optional(),
});
export const sourceFactInput = z.object({
  entityKey: z.string().min(1), predicate: z.string().min(1),
  kind: z.enum(["attribute", "property", "quantity", "relationship", "requirement"]),
  value: sourceValueSchema,
  unit: z.record(z.unknown()).nullable(),
  provenance: z.enum(["deterministic", "extracted", "inferred"]),
  evidence: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ifc"), expressId: z.number().int().positive(), attribute: z.string(), dataType: z.string().optional(), relationshipId: z.number().int().positive().optional() }),
    z.object({ kind: z.literal("text"), page: z.number().int().positive(), quote: z.string().min(1) }),
  ]),
});
export type SourceValue = z.infer<typeof sourceValueSchema>;
export type SourceEntityInput = z.infer<typeof sourceEntityInput>;
export type SourceFactInput = z.infer<typeof sourceFactInput>;
export type SourceModelImport = {
  entities: SourceEntityInput[];
  facts: SourceFactInput[];
  metadata: Record<string, unknown>;
};

/** Intentionally narrow, bounded output contract for the one document pass. */
export const documentModelOutput = z.object({
  entities: z.array(sourceEntityInput.extend({ key: z.string().min(1).max(100), kind: z.string().min(1).max(100), name: z.string().max(300) })).max(30),
  facts: z.array(sourceFactInput.extend({
    predicate: z.string().min(1).max(200),
    value: z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), value: z.string().max(1000) }),
      z.object({ type: z.literal("number"), value: z.number().finite() }),
      z.object({ type: z.literal("boolean"), value: z.boolean() }),
    ]),
    unit: z.object({ label: z.string().min(1).max(100) }).strict().nullable(),
    provenance: z.enum(["extracted", "inferred"]),
    evidence: z.object({ kind: z.literal("text"), page: z.number().int().positive(), quote: z.string().min(1).max(1500) }),
  })).max(60),
}).strict();
export type DocumentModelInput = {
  tenantId: string; actorId: string; versionId: string;
  pages: { page: number; text: string }[];
};
export type DocumentModelResult =
  | { status: "unconfigured" | "forbidden" }
  | { status: "failed"; metadata: Record<string, unknown> }
  | { status: "completed"; output: unknown; metadata: Record<string, unknown> };
