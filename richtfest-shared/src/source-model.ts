import { z } from "zod";

export const sourceModelEvidencePolicy = `Saved source model facts are already imported; use them directly instead of repeating extraction or requirements discovery. Deterministic IFC values are declarations from the file, not validated calculations. Keep deterministic, extracted and inferred provenance distinct. Each fact has its own reviewStatus: rejected claims must not support a recommendation, unreviewed claims remain proposals, and approved claims do not validate calculations or approve other claims. Preserve conflicting values and exact source revision/page/quote or IFC express IDs. Partial fact retrieval never proves absence or complete source coverage. An Affinity preview is not the full document. If source.pdfRepresentation is present, explicitly resolve its pdf.versionId for full-document evidence and cite that PDF revision and page, not the native original. The link confirms a matching export only, not engineering or content approval. Without a linked PDF, request a complete PDF export rather than inferring missing pages.
Building-plan reading method (only for building assessments): inventory the supplied revisions, buildings, storeys and sheets first. Cross-reference floor plans with sections, elevations, legends, room schedules and window/door schedules; a floor plan alone rarely supplies heights, tested component ratings or external noise inputs. Use original physical page numbers, not a search hit's position. Read the saved visual page/crop with a registered inspection tool when available; text-only extraction cannot establish walls, room boundaries, adjacency, door connectivity or complete openings. If visual inspection is unavailable, name that gap instead of claiming to have seen the drawing. Check scale separately per sheet against dimension chains; distinguish metres, centimetres, millimetres, net room area and gross unit area. Never transfer one storey's scale, height or facade to another without evidence. Read colors with the actual legend and distinguish retained, demolished and proposed construction. Match room identities by building/storey/unit and stable IDs, not name alone. Reconcile room, wall, opening and roof coverage before marking surfaces complete; a missing room or opening is not a zero-area component.
Before using extracted rooms for calculations, reconcile each relevant outline with its original plan crop: furniture, sanitary fixtures, door leaves and swing arcs are not room boundaries; dimension, section and roof-height guides are not walls. Keep physically open living/hall zones connected and retain their individual labels and printed areas. Compare polygon area minus holes at the sheet's scale against the matching printed area; for a merged space compare against the sum of its zones, not one label. Distinguish geometric floor area, net area and WoFlV-weighted area before declaring a mismatch. Reconcile both sides of every relevant door: a swing needs matching wall/threshold evidence, a double leaf is not two independent room connections, same-room sides do not establish adjacency, and an unknown side is not confirmed outside. Report mismatches, wall crossings, disconnected spaces and missing outlines with stable room IDs and source page/crop references; request review/correction rather than silently repairing, approving or using them as settled calculation inputs. Printed-area agreement alone does not prove correct geometry or connectivity.
Area and stair evidence: when a room explicitly prints GF (Grundfläche) as well as a credited area, keep both observations and compare the geometric footprint against GF, not an assumed two-times multiplier. Roof-height lines and stair projections can explain different area bases but do not establish the deduction formula; require sections or an area schedule before reconciling them. Repeated tread marks, stair arrows and dashed overhead flights are symbols, not proven floor holes or room partitions. Flag symbol-shaped holes and teeth for review; do not erase a real shaft or stairwell void without source evidence. A recovered outline or improved area score is not proof of complete extraction: count unresolved rooms and inspect changed connections as well as area errors.
For IFC, inspect saved units, spatial containment, placements, space boundaries, openings and property/quantity provenance. Preserve source revision plus express ID/attribute (and GlobalId when supplied). An IfcSpace name, declared quantity, material or fire-rating property is a source claim, not proof of complete geometry or a tested assembly. Missing IfcSpace/boundaries, unsupported geometry and truncated retrieval stay explicit gaps; do not invent a complete room inventory from a rendering.
Select tools by the current phase's registered capability and input contract, never by a plausible tool name. Separate extraction, reviewed model inputs, deterministic calculation and draft concept authoring. For acoustics distinguish environmental rating levels, assessed facade La, exterior insulation and interior airborne/impact/services checks; never substitute Lden for La, glass Rw for window Rw, or Rw for Dn,e,w. Use available proposal/catalogue/Nachweis tools for their documented scope and retain their exact results, versions, inputs and open items. A general validated_calculation placeholder is not an executable engineering tool. Never fill an unavailable calculation with model arithmetic or present a partial draft as complete.
For fire protection establish the federal state, applicable code edition, building use/Sonderbau, height of the highest possible habitable floor over mean ground (not roof height), unit count and gross unit areas before classification. Distinguish required component resistance/door closure from evidence of provided performance. Trace escape routes through reviewed doors at the reviewed scale; do not substitute straight-line distance, infer an independent second escape route, or assume fire-brigade access. When context.fireProtection.toolAvailable is true and a fire draft is requested, call prepare_fire_protection_assessment({}). It reads saved building-model inputs, not model-supplied numbers, and creates a source-linked partial draft with exact calculations, code editions, engine/input/output hashes and open items. Reuse the returned artifact link and results; do not recalculate, approve, or describe it as complete. Pending inferred properties are not calculation inputs. Missing inputs must be entered/reviewed in the building model; Team cannot mutate or approve that model. In Team, assign fire assessment to requirements_reviewer or construction_law; the saved inputs' sources must all be in that call's readable source scope. A blocked scope is not permission to add withheld reference answers. Chat cannot create fire drafts; ask the user to choose Team. Report and Calculation currently use acoustic templates, not a fire workflow. Berlin and Rheinland-Pfalz are the only supported jurisdictions; IFC escape routes, second escape routes, fire-brigade access and garage component checks remain unsupported. A written draft must expose missing evidence, unresolved deviations and unperformed checks, with human review before issue. Never use a reference assessment's answers as project inputs in a held-out backtest.`;

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
    z.object({ kind: z.literal("image"), scope: z.enum(["image", "affinity_preview"]), description: z.string().min(1).max(1500) }),
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

/** Intentionally narrow output contract per bounded evidence batch (at most six). */
export const documentModelOutput = z.object({
  entities: z.array(sourceEntityInput.extend({ key: z.string().min(1).max(100), kind: z.string().min(1).max(100), name: z.string().max(300) })).max(5),
  facts: z.array(sourceFactInput.extend({
    predicate: z.string().min(1).max(200),
    value: z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), value: z.string().max(1000) }),
      z.object({ type: z.literal("number"), value: z.number().finite() }),
      z.object({ type: z.literal("boolean"), value: z.boolean() }),
    ]),
    unit: z.object({ label: z.string().min(1).max(100) }).strict().nullable(),
    provenance: z.enum(["extracted", "inferred"]),
    evidence: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), page: z.number().int().positive(), quote: z.string().min(1).max(1500) }),
      z.object({ kind: z.literal("image"), scope: z.enum(["image", "affinity_preview"]), description: z.string().min(1).max(1500) }),
    ]),
  })).max(10),
}).strict();
export type DocumentModelInput = {
  tenantId: string; actorId: string; versionId: string;
  pages: { page: number; text: string }[];
  image?: { mediaType: "image/jpeg"; data: string; scope: "image" | "affinity_preview" };
};
export type DocumentModelResult =
  | { status: "unconfigured" | "forbidden" }
  | { status: "failed"; metadata: Record<string, unknown> }
  | { status: "completed"; output: unknown; metadata: Record<string, unknown> };
