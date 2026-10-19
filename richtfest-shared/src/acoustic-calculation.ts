import { z } from "zod";

// Provenance is supplied by the agent, not proof that a number was reviewed.
const provenance = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), versionId: z.string().uuid(), page: z.number().int().positive().nullable(), excerpt: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("assumption"), reason: z.string().trim().min(1).max(1000) }).strict(),
]);
const visualCrop = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine(c => c.x + c.width <= 1 && c.y + c.height <= 1, "Crop must fit within the page");
/** A visually inferred room/unit relationship. This is a review candidate, never calculation provenance. */
export const exteriorNoiseVisualCandidateSchema = z.object({
  apartmentLabel: z.string().trim().min(1).max(200).nullable(),
  roomLabel: z.string().trim().min(1).max(200).nullable(),
  mapping: z.string().trim().min(1).max(1000),
  provenance: z.object({
    kind: z.literal("visual_inspection"), versionId: z.string().uuid(), page: z.number().int().positive(),
    crop: visualCrop.nullable(), receiptId: z.string().uuid(), imageHash: z.string().regex(/^[a-f0-9]{64}$/i),
  }).strict(),
  // An explicitly printed value from the inspected page. This remains a
  // candidate until a separate human decision approves this exact observation.
  floorAreaObservation: z.object({ valueM2: z.number().finite().min(1e-6).max(1000000),
    basis: z.literal("explicitly_printed"), reviewStatus: z.literal("unreviewed") }).strict().optional(),
  reviewStatus: z.literal("unreviewed"),
}).strict();
export type ExteriorNoiseVisualCandidate = z.infer<typeof exteriorNoiseVisualCandidateSchema>;
const visualCandidateKey = z.string().regex(/^[a-f0-9]{64}$/);
const visualMappingReviewFields = {
  candidateKey: visualCandidateKey,
  actorId: z.string().uuid(), at: z.string().datetime(), reason: z.string().trim().min(1).max(1000),
};
export const acousticVisualMappingReviewSchema = z.discriminatedUnion("decision", [
  z.object({ ...visualMappingReviewFields, decision: z.literal("confirmed"), roomId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ ...visualMappingReviewFields, decision: z.literal("rejected") }).strict(),
]);
export type AcousticVisualMappingReview = z.infer<typeof acousticVisualMappingReviewSchema>;
const acousticVisualAreaReviewFields = {
  candidateKey: visualCandidateKey, observationKey: visualCandidateKey,
  actorId: z.string().uuid(), at: z.string().datetime(), reason: z.string().trim().min(1).max(1000),
};
export const acousticVisualAreaReviewSchema = z.discriminatedUnion("decision", [
  z.object({ ...acousticVisualAreaReviewFields, decision: z.literal("approved"), roomId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ ...acousticVisualAreaReviewFields, decision: z.literal("rejected") }).strict(),
]);
export type AcousticVisualAreaReview = z.infer<typeof acousticVisualAreaReviewSchema>;
const label = z.string().trim().min(1).max(200);
const level = z.number().finite().min(-200).max(300);
const observation = z.object({ label, levelDb: level, provenance }).strict();
const soundContext = {
  receiver: label.describe("Same receiver/location for every input; no propagation is calculated."),
  weighting: z.enum(["A", "C", "Z"]).describe("All levels must already have this frequency weighting and the same 20 µPa reference."),
};

export const sumSoundLevelsSchema = z.object({
  ...soundContext,
  period: label.describe("Common assessment period; do not add day and night or unrelated measurements."),
  uncorrelatedSources: z.literal(true),
  sources: z.array(observation).min(1).max(100),
}).strict();
export const equivalentSoundLevelSchema = z.object({
  ...soundContext,
  intervals: z.array(observation.extend({
    durationSeconds: z.number().finite().min(1e-9).max(31557600),
  }).strict()).min(1).max(100).describe("Non-overlapping intervals that fully cover the requested period; each level is that interval's Leq, not Lmax."),
}).strict();
export const compositeSoundReductionSchema = z.object({
  bandCentreHz: z.number().finite().positive().max(100000),
  bandwidth: z.enum(["octave", "third_octave"]),
  elements: z.array(z.object({
    label,
    areaM2: z.number().finite().min(1e-9).max(1000000),
    reductionDb: z.number().finite().min(0).max(300).describe("Positive sound reduction R in the specified band. Never Rw, R'w, STC or Dn,e,w."),
    provenance,
  }).strict()).min(1).max(100).describe("Side-by-side elements, not layers in series; same frequency band and incident field. No flanking."),
}).strict();

const area = z.number().finite().min(1e-6).max(1000000);
export const exteriorNoiseRoomSchema = z.object({
  standard: z.literal("DIN 4109-1/-2:2018-01"),
  room: z.object({
    id: label, use: z.enum(["hospital_bedroom", "residential_accommodation_classroom", "office"]),
    floorAreaM2: area, provenance,
  }).strict(),
  applicability: z.object({
    assessment: z.enum(["standard_exterior_noise", "special_assessment_required", "unknown"]),
    basis: label.describe("Project applicability and jurisdiction rationale. Aircraft-law, special low-frequency and other excluded cases require special assessment."),
    provenance,
  }).strict(),
  envelopeComplete: z.boolean().describe("All exterior surfaces bounding this room, including roofs and differently oriented facades, are listed."),
  facades: z.array(z.object({
    id: label, areaM2: area, provenance,
    noise: z.object({
      metric: z.literal("La"), levelDb: z.number().finite().min(0).max(150),
      basis: label.describe("Already assessed design exterior level, including relevant source/time corrections. Not raw Leq, Lden or a noise-zone label. This tool adds no noise corrections."),
      provenance,
    }).strict(),
  }).strict()).min(1).max(20),
}).strict();

const facadeElement = { id: label, facadeId: label, provenance,
  ratingBasis: z.enum(["installed_configuration", "unadjusted_lab", "unknown"]),
  // As long as the building model's Rw basis, which it carries.
  configuration: z.string().trim().min(1).max(500).describe("Evidence for installed size, joints and operating state; ventilation at design airflow, shading in the assessed state. Include corrections in the supplied rating, not twice."),
};
export const exteriorNoiseFacadeSchema = exteriorNoiseRoomSchema.extend({
  fieldEvidence: z.array(z.object({ field: label, provenance }).strict()).max(3000).optional(),
  elementsComplete: z.boolean().describe("All opaque areas, windows, doors, shading, ventilators and openings are represented without double counting."),
  flanking: z.object({ assessment: z.enum(["negligible", "required", "unknown"]), provenance }).strict(),
  elements: z.array(z.discriminatedUnion("kind", [
    z.object({ ...facadeElement, kind: z.literal("area"), areaM2: area,
      rwDb: z.number().finite().min(0).max(100),
      construction: z.enum(["massive", "lightweight", "window_or_door", "unknown"]),
    }).strict(),
    z.object({ ...facadeElement, kind: z.literal("small"), dnEWDb: z.number().finite().min(0).max(100),
      count: z.number().int().min(1).max(100),
      openingAreaM2: z.number().finite().min(0).max(1000000).describe("Physical opening area PER element, used only for geometry accounting; acoustic normalization always uses A0 = 10 m²."),
    }).strict(),
  ])).min(1).max(100),
}).strict();

/** The declared inventory is independent of available calculation inputs. */
export const exteriorNoiseBatchSchema = z.object({
  scope: label,
  // Project reconciliation combines multiple bounded extraction packets.
  inventory: z.array(z.object({ roomId: label, provenance }).strict()).min(1).max(1000),
  rooms: z.array(exteriorNoiseFacadeSchema).max(1000),
}).strict();

/** Source-reading output, never calculation results or reference answers. */
export const exteriorNoiseFactFields: Record<string, Record<string, z.ZodType>> = {
  room: exteriorNoiseRoomSchema.shape.room.omit({ id: true, provenance: true }).shape,
  applicability: exteriorNoiseRoomSchema.shape.applicability.omit({ provenance: true }).shape,
  flanking: exteriorNoiseFacadeSchema.shape.flanking.omit({ provenance: true }).shape,
  coverage: { standard: exteriorNoiseRoomSchema.shape.standard,
    envelopeComplete: z.boolean(), elementsComplete: z.boolean() },
  facade: { areaM2: area },
  noise: exteriorNoiseRoomSchema.shape.facades.element.shape.noise.omit({ provenance: true }).shape,
  element: { ...exteriorNoiseFacadeSchema.shape.elements.element.options[0].omit({ id: true, provenance: true }).shape,
    ...exteriorNoiseFacadeSchema.shape.elements.element.options[1].omit({ id: true, provenance: true }).shape,
    kind: z.enum(["area", "small"]) },
};
export const exteriorNoiseFactSchema = z.object({
  roomId: label,
  target: z.enum(["room", "applicability", "flanking", "coverage", "facade", "noise", "element"]),
  id: label,
  field: label,
  value: z.union([z.string(), z.number().finite(), z.boolean()]),
  provenance,
}).strict().superRefine((fact, ctx) => {
  const fields = exteriorNoiseFactFields[fact.target]!;
  if (!Object.hasOwn(fields, fact.field) || !fields[fact.field]!.safeParse(fact.value).success)
    ctx.addIssue({ code: "custom", path: ["value"], message: "Invalid acoustic field or value", params: { acoustic: "invalid_fact_value" } });
  if (["room", "coverage", "applicability", "flanking"].includes(fact.target) && fact.id !== fact.roomId)
    ctx.addIssue({ code: "custom", path: ["id"], message: "Room-level facts must use the room ID", params: { acoustic: "room_fact_id" } });
});
export type ExteriorNoiseFact = z.infer<typeof exteriorNoiseFactSchema>;
export const acousticFactKey = (fact: Pick<ExteriorNoiseFact, "roomId" | "target" | "id" | "field">) =>
  JSON.stringify([fact.roomId, fact.target, fact.id, fact.field]);

export const exteriorNoiseExtractionSchema = z.object({
  inventory: exteriorNoiseBatchSchema.shape.inventory.min(0).max(100),
  rooms: exteriorNoiseBatchSchema.shape.rooms.max(100),
  // Preserved alongside text-backed extraction, but deliberately excluded from calculation input.
  visualCandidates: z.array(exteriorNoiseVisualCandidateSchema).max(100).optional(),
  facts: z.array(exteriorNoiseFactSchema).max(5000).optional(),
  blockers: z.array(z.object({ roomId: label.nullable(), reason: z.string().min(1).max(1000) }).strict()).max(100),
}).strict();

/** Provider contract: copy source identities from this packet, never generate UUIDs. */
export function scopedExteriorNoiseExtractionSchema(versionIds: string[]) {
  const ids = [...new Set(versionIds.map(id => z.string().uuid().parse(id)))];
  const source = provenance.options[0].extend({
    versionId: ids.length ? z.enum(ids as [string, ...string[]]) : z.string().uuid(),
  });
  const facade = exteriorNoiseFacadeSchema.shape.facades.element;
  const elements = exteriorNoiseFacadeSchema.shape.elements.element.options;
  const room = exteriorNoiseFacadeSchema.extend({
    room: exteriorNoiseFacadeSchema.shape.room.extend({ provenance: source }),
    applicability: exteriorNoiseFacadeSchema.shape.applicability.extend({ provenance: source }),
    flanking: exteriorNoiseFacadeSchema.shape.flanking.extend({ provenance: source }),
    facades: z.array(facade.extend({ provenance: source, noise: facade.shape.noise.extend({ provenance: source }) })).min(1).max(20),
    elements: z.array(z.discriminatedUnion("kind", [
      elements[0].extend({ provenance: source }), elements[1].extend({ provenance: source }),
    ])).min(1).max(100),
    fieldEvidence: z.array(z.object({ field: label, provenance: source }).strict()).max(3000).optional(),
  });
  // Refinements are not part of the provider's JSON schema. Expose each field's
  // actual type/enum there too, rather than inviting arbitrary scalar values.
  const variants = Object.entries(exteriorNoiseFactFields).flatMap(([target, fields]) =>
    Object.entries(fields).map(([field, value]) => exteriorNoiseFactSchema.innerType().extend({
      target: z.literal(target), field: z.literal(field), value, provenance: source,
    })));
  const fact = z.union(variants as [typeof variants[number], typeof variants[number], ...typeof variants[number][]]).superRefine((value, ctx) => {
    const result = exteriorNoiseFactSchema.safeParse(value);
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue);
  });
  return exteriorNoiseExtractionSchema.extend({
    inventory: z.array(z.object({ roomId: label, provenance: source }).strict()).max(ids.length ? 100 : 0),
    rooms: z.array(room).max(ids.length ? 100 : 0),
    visualCandidates: z.array(exteriorNoiseVisualCandidateSchema.extend({
      provenance: exteriorNoiseVisualCandidateSchema.shape.provenance.extend({
        versionId: ids.length ? z.enum(ids as [string, ...string[]]) : z.string().uuid(),
      }),
    })).max(ids.length ? 100 : 0).optional(),
    facts: z.array(fact).max(ids.length ? 5000 : 0).optional(),
  });
}

export const acousticInputReviewSchema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  packets: z.array(exteriorNoiseExtractionSchema),
  resolutions: z.array(z.object({ fact: exteriorNoiseFactSchema, reason: z.string().trim().min(1).max(1000),
    actorId: z.string().uuid(), at: z.string().datetime() }).strict()),
  // Optional for old persisted review snapshots; these decisions add identity only, never numeric evidence.
  visualMappings: z.array(acousticVisualMappingReviewSchema).default([]),
  // Approval history is separate from identity mapping and always retains the exact observation key.
  visualAreaReviews: z.array(acousticVisualAreaReviewSchema).default([]),
  inventoryConfirmation: z.object({ actorId: z.string().uuid(), at: z.string().datetime(), reason: z.string() }).nullable(),
}).strict();
export type AcousticInputReview = z.infer<typeof acousticInputReviewSchema>;

const singleAcousticCalculationSchema = z.discriminatedUnion("method", [
  sumSoundLevelsSchema.extend({ method: z.literal("sum_sound_levels") }).strict(),
  equivalentSoundLevelSchema.extend({ method: z.literal("equivalent_sound_level") }).strict(),
  compositeSoundReductionSchema.extend({ method: z.literal("composite_sound_reduction") }).strict(),
  exteriorNoiseRoomSchema.extend({ method: z.literal("exterior_noise_room_requirement") }).strict(),
  exteriorNoiseFacadeSchema.extend({ method: z.literal("exterior_noise_facade") }).strict(),
]);
export const acousticCalculationSchema = z.discriminatedUnion("method", [
  ...singleAcousticCalculationSchema.options,
  exteriorNoiseBatchSchema.extend({ method: z.literal("exterior_noise_batch") }).strict(),
]);
export type AcousticCalculationInput = z.infer<typeof acousticCalculationSchema>;

/** Every input evidence record, shared by authorization and report citation retention. */
export function acousticInputProvenance(input: AcousticCalculationInput): z.infer<typeof provenance>[] {
  switch (input.method) {
    case "sum_sound_levels": return input.sources.map(o => o.provenance);
    case "equivalent_sound_level": return input.intervals.map(o => o.provenance);
    case "composite_sound_reduction": return input.elements.map(o => o.provenance);
    case "exterior_noise_batch": return [...input.inventory.map(r => r.provenance),
      ...input.rooms.flatMap(room => acousticInputProvenance({ ...room, method: "exterior_noise_facade" }))];
    default: return [input.room.provenance, input.applicability.provenance,
      ...input.facades.flatMap(f => [f.provenance, f.noise.provenance]),
      ...(input.method === "exterior_noise_facade" ? [input.flanking.provenance, ...input.elements.map(e => e.provenance),
        ...(input.fieldEvidence ?? []).map(e => e.provenance)] : []),
    ];
  }
}

const singleAcousticCalculationResultSchema = z.object({
  engine: z.literal("richtfest-acoustics"),
  version: z.literal(1),
  method: z.enum(["sum_sound_levels", "equivalent_sound_level", "composite_sound_reduction", "exterior_noise_room_requirement", "exterior_noise_facade"]),
  input: singleAcousticCalculationSchema,
  status: z.enum(["calculated", "unsupported"]).default("calculated"),
  value: z.number().finite().nullable(),
  unit: z.enum(["dB", "dB(A)", "dB(C)", "dB(Z)"]),
  formula: z.string(),
  reference: z.string().url(),
  intermediates: z.array(z.object({ label: z.string(), value: z.number().finite(), unit: z.string() }).strict()),
  exteriorNoise: z.object({
    baseRequiredDb: z.number().finite(), geometryCorrectionDb: z.number().finite(),
    prognosisUncertaintyDb: z.literal(2), targetRwDb: z.number().finite(),
    marginDb: z.number().finite().nullable(),
    comparison: z.enum(["not_evaluated", "meets_numeric_target", "below_numeric_target"]),
  }).strict().optional(),
  limitations: z.array(z.string()),
  reviewStatus: z.literal("not_reviewed"),
}).strict();
export const acousticCalculationResultSchema = singleAcousticCalculationResultSchema.extend({
  method: z.enum(["sum_sound_levels", "equivalent_sound_level", "composite_sound_reduction", "exterior_noise_room_requirement", "exterior_noise_facade", "exterior_noise_batch"]),
  input: acousticCalculationSchema,
  batch: z.object({
    complete: z.boolean(),
    issues: z.array(z.string()),
    rooms: z.array(z.object({
      roomId: label,
      status: z.enum(["calculated", "unsupported", "missing_input", "invalid_inventory"]),
      result: singleAcousticCalculationResultSchema.nullable(),
    }).strict()),
  }).strict().optional(),
}).strict();
export type AcousticCalculationResult = z.infer<typeof acousticCalculationResultSchema>;
export const acousticCalculationReceiptSchema = acousticCalculationResultSchema.extend({ receiptId: z.string().uuid() });
export type AcousticCalculationReceipt = z.infer<typeof acousticCalculationReceiptSchema>;

/** Server-saved input/result pair. Approval belongs to its exact artifact revision. */
export const acousticDatasetSchema = z.object({
  version: z.literal(1),
  receipt: acousticCalculationReceiptSchema.extend({
    method: z.literal("exterior_noise_batch"),
    input: exteriorNoiseBatchSchema.extend({ method: z.literal("exterior_noise_batch") }),
  }),
  blockers: z.array(z.string()),
  basedOn: z.object({ artifactId: z.string().uuid(), revisionId: z.string().uuid() }).nullable(),
}).strict();
export type AcousticDataset = z.infer<typeof acousticDatasetSchema>;

export const acousticScenarioInputSchema = z.object({
  expectedRevisionId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  reason: z.string().trim().min(1).max(1000),
  adjustments: z.array(z.object({
    roomId: label,
    target: z.enum(["room", "facade", "noise", "element"]),
    id: label,
    field: z.enum(["floorAreaM2", "areaM2", "levelDb", "rwDb", "dnEWDb", "count", "openingAreaM2"]),
    value: z.number().finite(),
  }).strict()).max(1000),
}).strict();
export type AcousticScenarioInput = z.infer<typeof acousticScenarioInputSchema>;

/** Project-report context only; the durable execution ledger remains unchanged.
 * Keep unsupported attempts so writers can explain their blocking reasons.
 * Source provenance is declared evidence, not a claim of professional review.
 */
export function selectAcousticCalculationReportReceipts(receipts: readonly AcousticCalculationReceipt[]): AcousticCalculationReceipt[] {
  return receipts.map(receipt => acousticCalculationReceiptSchema.parse(receipt)).filter(receipt =>
    receipt.status === "unsupported" || acousticInputProvenance(receipt.input).some(p => p.kind === "source"));
}

/** Render saved arithmetic, never ask a writer to recalculate or transcribe it. */
export function renderAcousticCalculationReceipts(receipts: AcousticCalculationReceipt[], language: "de" | "en") {
  const reportReceipts = selectAcousticCalculationReportReceipts(receipts);
  const t = (de: string, en: string) => language === "de" ? de : en;
  const cell = (value: unknown) => String(value ?? "—").replace(/[\\`*_{}<>#!|\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
  const fields = (value: unknown, path = ""): string[] => {
    if (value && typeof value === "object") {
      if ("kind" in value && value.kind === "source") {
        const p = provenance.parse(value);
        if (p.kind === "source") return [`| ${cell(path)} | [${p.versionId}] · ${t("Seite", "Page")} ${p.page ?? "—"} · ${cell(p.excerpt)} |`];
      }
      if ("kind" in value && value.kind === "assumption") {
        const p = provenance.parse(value);
        if (p.kind === "assumption") return [`| ${cell(path)} | ${t("Annahme", "Assumption")}: ${cell(p.reason)} |`];
      }
      return Object.entries(value).flatMap(([key, child]) => fields(child, path ? `${path}.${key}` : key));
    }
    return [`| ${cell(path)} | ${cell(value)} |`];
  };
  const table = (heading: string, rows: string[]) => `**${heading}**\n\n| ${t("Feld", "Field")} | ${t("Wert", "Value")} |\n| --- | --- |\n${rows.join("\n")}`;
  const exclusionNotice = reportReceipts.length < receipts.length ? t(
    "Reine Annahmeberechnungen ohne Quellenbeleg sind keine Projektergebnisse und wurden ausgeschlossen; sie bleiben im Ausführungsprotokoll erhalten.",
    "Assumption-only calculations without source evidence are not project results and were excluded; they remain in the execution ledger.",
  ) : "";
  return [exclusionNotice, ...reportReceipts.map((raw, index) => {
    const receipt = acousticCalculationReceiptSchema.parse(raw);
    if (receipt.input.method === "exterior_noise_batch" && receipt.batch) {
      const batch = receipt.batch;
      const evidence = new Map<string, number>();
      const evidenceRows: string[] = [];
      const cite = (p: z.infer<typeof provenance>) => {
        const key = JSON.stringify(p);
        if (!evidence.has(key)) {
          const n = evidence.size + 1;
          evidence.set(key, n);
          evidenceRows.push(`| ${n} | ${p.kind === "source" ? `[${p.versionId}] · ${t("Seite", "Page")} ${p.page ?? "—"} · ${cell(p.excerpt)}` : `${t("Annahme", "Assumption")}: ${cell(p.reason)}`} |`);
        }
        return evidence.get(key)!;
      };
      const display = (n: number | null | undefined) => n == null ? "—" : n.toFixed(3);
      const terms: Record<string, string> = {
        hospital_bedroom: t("Bettenraum", "Hospital bedroom"),
        residential_accommodation_classroom: t("Wohn-, Übernachtungs- oder Unterrichtsraum", "Residential, accommodation or classroom"),
        office: t("Büro", "Office"),
        standard_exterior_noise: t("Regelfall Außenlärm", "Standard exterior noise"),
        special_assessment_required: t("Sonderbeurteilung erforderlich", "Special assessment required"),
        unknown: t("Ungeklärt", "Unknown"), negligible: t("Vernachlässigbar", "Negligible"),
        required: t("Zu berücksichtigen", "Required"),
        installed_configuration: t("Einbausituation berücksichtigt", "Installed configuration"),
        unadjusted_lab: t("Unkorrigierter Laborwert", "Unadjusted laboratory rating"),
        massive: t("Massiv", "Massive"), lightweight: t("Leichtbau", "Lightweight"),
        window_or_door: t("Fenster oder Tür", "Window or door"),
      };
      const yesNo = (value: boolean) => value ? t("Ja", "Yes") : t("Nein", "No");
      const details: string[] = [];
      const summary = batch.rooms.map(row => {
        const r = row.result;
        const eligible = r && (r.status === "unsupported" || acousticInputProvenance(r.input).some(p => p.kind === "source"));
        const numeric = eligible && r.status === "calculated" ? r.exteriorNoise : undefined;
        const margin = numeric?.marginDb;
        const status = r && !eligible ? t("Nur Annahmen", "Assumptions only")
          : !numeric || margin == null ? t("Offen", "Blocked")
          : margin < 0 ? t("Unter Ziel", "Below target")
          : margin <= 0.5 ? t("Reserve ≤ 0,5 dB", "Reserve ≤ 0.5 dB") : t("Ziel erreicht", "Target met");
        if (r?.input.method === "exterior_noise_facade") {
          const room = r.input;
          details.push([
            `**${t("Raum", "Room")} ${cell(row.roomId)}**`,
            `${t("Grundfläche", "Floor area")} S_G = ${room.room.floorAreaM2} m²; ${t("Nutzung", "Use")}: ${terms[room.room.use]} (${t("Beleg", "Evidence")} ${cite(room.room.provenance)}).`,
            `${terms[room.applicability.assessment]}: ${cell(room.applicability.basis)} (${cite(room.applicability.provenance)}); ${t("Flanken", "Flanking")}: ${terms[room.flanking.assessment]} (${cite(room.flanking.provenance)}).`,
            `${t("Hülle vollständig", "Envelope complete")}: ${yesNo(room.envelopeComplete)}; ${t("Bauteile vollständig", "Elements complete")}: ${yesNo(room.elementsComplete)}.`,
            ...(room.fieldEvidence?.length ? [table(t("Feldbelege", "Field evidence"), room.fieldEvidence.map(e => `| ${cell(e.field)} | ${cite(e.provenance)} |`))] : []),
            `| ${t("Fassade", "Facade")} | S_s m² | La dB | ${t("Ansatz / Belege", "Basis / evidence")} |\n| --- | --- | --- | --- |\n${room.facades.map(f => `| ${cell(f.id)} | ${f.areaM2} | ${f.noise.levelDb} | ${cell(f.noise.basis)} (${cite(f.provenance)}, ${cite(f.noise.provenance)}) |`).join("\n")}`,
            `| ${t("Bauteil / Fassade", "Element / facade")} | ${t("Fläche / Anzahl", "Area / count")} | ${t("Kennwert", "Rating")} dB | ${t("Konfiguration / Beleg", "Configuration / evidence")} |\n| --- | --- | --- | --- |\n${room.elements.map(e => `| ${cell(e.id)} / ${cell(e.facadeId)} | ${e.kind === "area" ? `${e.areaM2} m²` : `${e.count} × ${e.openingAreaM2} m²`} | ${e.kind === "area" ? `Rw ${e.rwDb}` : `Dn,e,w ${e.dnEWDb}`} | ${cell(e.configuration)}; ${terms[e.ratingBasis]}${e.kind === "area" ? `; ${terms[e.construction]}` : ""} (${cite(e.provenance)}) |`).join("\n")}`,
            ...(numeric ? [table(t("Rechenweg (ungerundete Werte)", "Calculation (unrounded values)"), r.intermediates.map(v => `| ${cell(v.label)} | ${v.value} ${cell(v.unit)} |`)),
              `Rw = ${r.value} dB; ${t("Ziel", "Target")} = ${numeric.targetRwDb} dB; ${t("Reserve", "Margin")} = ${margin} dB.`]
              : [`${status}: ${r.status === "unsupported" ? cell(r.limitations[0]) : t("Ohne Quellenbeleg kein Projektergebnis.", "No project result without source evidence.")}`]),
          ].join("\n\n"));
        }
        return `| ${cell(row.roomId)} | ${display(numeric?.targetRwDb)} | ${display(numeric ? r?.value : null)} | ${display(margin)} | ${status} |`;
      });
      const inventory = receipt.input.inventory.map(r => `${cell(r.roomId)} (${cite(r.provenance)})`).join(", ");
      const methods = [...new Set(batch.rooms.flatMap(r => r.result ? [r.result.formula] : []))];
      const limitations = [...new Set([...receipt.limitations, ...batch.rooms.flatMap(r => r.result?.limitations ?? [])])];
      return [
        `**${t("Außenlärm – Raumberechnung", "Exterior noise – room calculations")}: ${cell(receipt.input.scope)}**`,
        `${receipt.engine} · v${receipt.version} · ${t("Fachlich ungeprüft; Freigabe ausstehend.", "Not reviewed; release pending.")}`,
        `${t("Deklariertes Rauminventar", "Declared room inventory")}: ${inventory}.`,
        `${t("Berechnungsabdeckung", "Calculation coverage")}: ${batch.rooms.filter(r => r.status === "calculated").length}/${batch.rooms.length}; ${batch.complete ? t("deklariertes Inventar berechnet", "declared inventory calculated") : t("unvollständig", "incomplete")}.`,
        `| ${t("Raum", "Room")} | ${t("Ziel inkl. 2 dB", "Target incl. 2 dB")} | Rw dB | ${t("Reserve", "Margin")} dB | ${t("Numerischer Status", "Numeric status")} |\n| --- | --- | --- | --- | --- |\n${summary.join("\n")}`,
        t("Übersicht auf drei Dezimalstellen gerundet; Status und Reservebewertung verwenden ungerundete Werte. Zielerreichung ist keine fachliche Freigabe.", "Overview rounded to three decimals; status and margin assessment use unrounded values. Meeting a target is not professional approval."),
        ...(batch.issues.length ? [table(t("Offene Berechnungspunkte", "Calculation blockers"), batch.issues.map((issue, i) => `| ${i + 1} | ${cell(issue)} |`))] : []),
        ...methods.map(formula => `${t("Formel", "Formula")}: ${cell(formula)}`),
        ...details,
        table(t("Eingabebelege", "Input evidence"), evidenceRows),
        `**${t("Geltungsbereich und Prüfbedarf", "Scope and review requirements")}**\n\n${limitations.map(v => `- ${cell(v)}`).join("\n")}`,
      ].join("\n\n");
    }
    return [
      `**${t("Werkzeugberechnung", "Tool calculation")} ${index + 1} · ${cell(receipt.method)}**`,
      `${cell(receipt.engine)} · v${receipt.version} · ${t("Fachlich ungeprüft; kein Konformitätsnachweis oder Freigabe.", "Not reviewed; not a compliance verification or approval.")}`,
      table(t("Gespeichertes Ergebnis", "Saved result"), [
        `| ${t("Status", "Status")} | ${receipt.status === "unsupported" ? t("Nicht unterstützt – kein Rechenergebnis", "Unsupported – no calculated result") : t("Berechnet, ungeprüft", "Calculated, unreviewed")} |`,
        `| ${t("Ergebnis", "Result")} | ${receipt.status === "unsupported" || receipt.value === null ? "—" : `${receipt.value} ${cell(receipt.unit)}`} |`,
        `| ${t("Formel", "Formula")} | ${cell(receipt.formula)} |`,
        `| ${t("Methodenreferenz", "Method reference")} | ${cell(receipt.reference)} |`,
      ]),
      table(t("Eingaben und Herkunft (gespeicherte Feldnamen)", "Inputs and provenance (saved field names)"), fields(receipt.input)),
      ...(receipt.status !== "unsupported" && receipt.intermediates.length ? [table(t("Zwischenergebnisse", "Intermediate results"), receipt.intermediates.map(row =>
        `| ${cell(row.label)} | ${row.value} ${cell(row.unit)} |`))] : []),
      ...(receipt.status !== "unsupported" && receipt.exteriorNoise ? [table(t("Numerischer Vergleich (ungeprüft)", "Numerical comparison (unreviewed)"), fields(receipt.exteriorNoise))] : []),
      `**${t("Grenzen und Prüfbedarf", "Limitations and required review")}**\n\n${receipt.limitations.map(value => `- ${cell(value)}`).join("\n")}`,
    ].join("\n\n");
  })].filter(Boolean).join("\n\n");
}
