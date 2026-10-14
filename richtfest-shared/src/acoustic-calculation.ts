import { z } from "zod";

// Provenance is supplied by the agent, not proof that a number was reviewed.
const provenance = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), versionId: z.string().uuid(), page: z.number().int().positive().nullable(), excerpt: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("assumption"), reason: z.string().trim().min(1).max(1000) }).strict(),
]);
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
  configuration: label.describe("Evidence for installed size, joints and operating state; ventilation at design airflow, shading in the assessed state. Include corrections in the supplied rating, not twice."),
};
export const exteriorNoiseFacadeSchema = exteriorNoiseRoomSchema.extend({
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

export const acousticCalculationSchema = z.discriminatedUnion("method", [
  sumSoundLevelsSchema.extend({ method: z.literal("sum_sound_levels") }).strict(),
  equivalentSoundLevelSchema.extend({ method: z.literal("equivalent_sound_level") }).strict(),
  compositeSoundReductionSchema.extend({ method: z.literal("composite_sound_reduction") }).strict(),
  exteriorNoiseRoomSchema.extend({ method: z.literal("exterior_noise_room_requirement") }).strict(),
  exteriorNoiseFacadeSchema.extend({ method: z.literal("exterior_noise_facade") }).strict(),
]);
export type AcousticCalculationInput = z.infer<typeof acousticCalculationSchema>;

/** Every input evidence record, shared by authorization and report citation retention. */
export function acousticInputProvenance(input: AcousticCalculationInput): z.infer<typeof provenance>[] {
  switch (input.method) {
    case "sum_sound_levels": return input.sources.map(o => o.provenance);
    case "equivalent_sound_level": return input.intervals.map(o => o.provenance);
    case "composite_sound_reduction": return input.elements.map(o => o.provenance);
    default: return [input.room.provenance, input.applicability.provenance,
      ...input.facades.flatMap(f => [f.provenance, f.noise.provenance]),
      ...(input.method === "exterior_noise_facade" ? [input.flanking.provenance, ...input.elements.map(e => e.provenance)] : []),
    ];
  }
}

export const acousticCalculationResultSchema = z.object({
  engine: z.literal("richtfest-acoustics"),
  version: z.literal(1),
  method: z.enum(["sum_sound_levels", "equivalent_sound_level", "composite_sound_reduction", "exterior_noise_room_requirement", "exterior_noise_facade"]),
  input: acousticCalculationSchema,
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
export type AcousticCalculationResult = z.infer<typeof acousticCalculationResultSchema>;
export const acousticCalculationReceiptSchema = acousticCalculationResultSchema.extend({ receiptId: z.string().uuid() });
export type AcousticCalculationReceipt = z.infer<typeof acousticCalculationReceiptSchema>;

/** Render saved arithmetic, never ask a writer to recalculate or transcribe it. */
export function renderAcousticCalculationReceipts(receipts: AcousticCalculationReceipt[], language: "de" | "en") {
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
  return receipts.map((raw, index) => {
    const receipt = acousticCalculationReceiptSchema.parse(raw);
    return [
      `**${t("Werkzeugberechnung", "Tool calculation")} ${index + 1} · ${cell(receipt.method)}**`,
      `${cell(receipt.engine)} · v${receipt.version} · ${t("Fachlich ungeprüft; kein Konformitätsnachweis oder Freigabe.", "Not reviewed; not a compliance verification or approval.")}`,
      table(t("Gespeichertes Ergebnis", "Saved result"), [
        `| ${t("Status", "Status")} | ${receipt.status === "unsupported" ? t("Nicht unterstützt – kein Rechenergebnis", "Unsupported – no calculated result") : t("Berechnet, ungeprüft", "Calculated, unreviewed")} |`,
        `| ${t("Ergebnis", "Result")} | ${receipt.value === null ? "—" : `${receipt.value} ${cell(receipt.unit)}`} |`,
        `| ${t("Formel", "Formula")} | ${cell(receipt.formula)} |`,
        `| ${t("Methodenreferenz", "Method reference")} | ${cell(receipt.reference)} |`,
      ]),
      table(t("Eingaben und Herkunft (gespeicherte Feldnamen)", "Inputs and provenance (saved field names)"), fields(receipt.input)),
      ...(receipt.intermediates.length ? [table(t("Zwischenergebnisse", "Intermediate results"), receipt.intermediates.map(row =>
        `| ${cell(row.label)} | ${row.value} ${cell(row.unit)} |`))] : []),
      ...(receipt.exteriorNoise ? [table(t("Numerischer Vergleich (ungeprüft)", "Numerical comparison (unreviewed)"), fields(receipt.exteriorNoise))] : []),
      `**${t("Grenzen und Prüfbedarf", "Limitations and required review")}**\n\n${receipt.limitations.map(value => `- ${cell(value)}`).join("\n")}`,
    ].join("\n\n");
  }).join("\n\n");
}
