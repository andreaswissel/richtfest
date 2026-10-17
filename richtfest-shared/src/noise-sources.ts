import { z } from "zod";

/**
 * Exterior noise sources of a project: the roads and railways a facade check
 * has to account for, with the inputs an emission calculation (RLS-19 for
 * roads, Schall 03 for railways) will need. Richtfest collects and requests
 * these inputs; it does not calculate emission or facade levels from them.
 */
export const noiseSourceKindSchema = z.enum(["road", "rail"]);
export type NoiseSourceKind = z.infer<typeof noiseSourceKindSchema>;

type InputSpec = { value: z.ZodTypeAny; unit: string | null };
const distance: InputSpec = { value: z.number().min(0).max(5000), unit: "m" };
const note = (max: number): InputSpec => ({ value: z.string().trim().min(1).max(max), unit: null });

/** Inputs per source kind, in the order they are asked for. */
export const noiseSourceInputs = {
  road: {
    dailyTraffic: { value: z.number().int().min(0).max(500_000), unit: "Kfz/24h" },
    heavyVehicleShare: { value: z.number().min(0).max(100), unit: "%" },
    speedLimit: { value: z.number().int().min(5).max(200), unit: "km/h" },
    roadSurface: note(200),
    distanceToFacade: distance,
    trafficBasis: note(300),
  },
  rail: {
    trainVolumes: note(2000),
    speed: { value: z.number().int().min(5).max(400), unit: "km/h" },
    trackType: note(200),
    distanceToFacade: distance,
    trafficBasis: note(300),
  },
} satisfies Record<NoiseSourceKind, Record<string, InputSpec>>;
export type RoadNoiseInput = keyof typeof noiseSourceInputs.road;
export type RailNoiseInput = keyof typeof noiseSourceInputs.rail;

/** Inputs only an authority or operator can supply; the facade distance is measured by the planner. */
export const requestableNoiseInputs = {
  road: ["dailyTraffic", "heavyVehicleShare", "speedLimit", "roadSurface", "trafficBasis"],
  rail: ["trainVolumes", "speed", "trackType", "trafficBasis"],
} as const satisfies { road: readonly RoadNoiseInput[]; rail: readonly RailNoiseInput[] };

export const noiseInputKeys = (kind: NoiseSourceKind) => Object.keys(noiseSourceInputs[kind]);

/** Returns an error message, or null when the value fits the input. */
export function validateNoiseInput(kind: NoiseSourceKind, key: string, value: unknown): string | null {
  const spec = (noiseSourceInputs[kind] as Record<string, InputSpec>)[key];
  if (!spec) return `Unknown input ${key}`;
  if (value === null) return null;
  return spec.value.safeParse(value).success ? null : `Invalid value for ${key}`;
}
export const noiseInputUnit = (kind: NoiseSourceKind, key: string) => (noiseSourceInputs[kind] as Record<string, InputSpec>)[key]?.unit ?? null;

/** Roads and railways as mapped in the official topographic model (ATKIS Basis-DLM); codes are AdV code list values. */
export const mappedRoadSchema = z.object({
  kind: z.literal("road"),
  ref: z.string(),
  name: z.string().nullable(),
  /** AX_Widmung_Strasse: 1301 Bundesautobahn … 1307 Gemeindestraße. */
  dedication: z.string().nullable(),
  designation: z.string().nullable(),
  lanes: z.number().nullable(),
  carriagewayWidthM: z.number().nullable(),
  distanceMeters: z.number().nullable(),
  segments: z.number().int(),
}).strict();
export const mappedRailSchema = z.object({
  kind: z.literal("rail"),
  ref: z.string(),
  name: z.string().nullable(),
  /** AX_Bahnkategorie: 1100 Eisenbahn, 1104 S-Bahn, 1201 Straßenbahn, 1202 U-Bahn, … */
  categories: z.array(z.string()),
  /** VzG route numbers (nummerDerBahnstrecke), the key DB InfraGO answers train volume requests by. */
  routeNumbers: z.array(z.string()),
  lines: z.array(z.string()),
  /** AX_AnzahlDerStreckengleise: 1000 single track, 2000 double track. */
  tracks: z.string().nullable(),
  electrified: z.boolean().nullable(),
  distanceMeters: z.number().nullable(),
  segments: z.number().int(),
}).strict();
export const mappedNoiseSourceSchema = z.discriminatedUnion("kind", [mappedRoadSchema, mappedRailSchema]);
export type MappedRoad = z.infer<typeof mappedRoadSchema>;
export type MappedRail = z.infer<typeof mappedRailSchema>;
export type MappedNoiseSource = z.infer<typeof mappedNoiseSourceSchema>;

export type NoiseInputValue = { value: unknown; unit: string | null; basis: string | null; version: number; enteredBy: string; enteredAt: string };
export type NoiseSource = {
  id: string;
  kind: NoiseSourceKind;
  name: string;
  /** Snapshot of the mapped object this source was added from; null when added by hand. */
  mapped: (MappedNoiseSource & { surveyFileId: string; connectorVersion: string; retrievedAt: string }) | null;
  inputs: Record<string, NoiseInputValue>;
  missing: string[];
  inquiryId: string | null;
  createdAt: string;
};

/** Inputs still without a value. */
export const noiseSourceGaps = (kind: NoiseSourceKind, inputs: Record<string, { value: unknown } | undefined>) =>
  noiseInputKeys(kind).filter(key => inputs[key]?.value === null || inputs[key]?.value === undefined);

export type NoiseRequestItem = { sourceId: string; kind: NoiseSourceKind; name: string; fields: string[] };
export type NoiseRequestProgress = { total: number; answered: number; outstanding: NoiseRequestItem[] };

/** How much of a sent noise data request has been answered; removed sources are ignored. */
export function noiseRequestProgress(items: NoiseRequestItem[], sources: Array<{ id: string; kind: NoiseSourceKind; inputs: Record<string, { value: unknown } | undefined> }>): NoiseRequestProgress {
  const byId = new Map(sources.map(source => [source.id, source]));
  let total = 0, answered = 0;
  const outstanding: NoiseRequestItem[] = [];
  for (const item of items) {
    const source = byId.get(item.sourceId);
    if (!source) continue;
    const gaps = new Set(noiseSourceGaps(source.kind, source.inputs));
    const fields = item.fields.filter(field => gaps.has(field));
    total += item.fields.length; answered += item.fields.length - fields.length;
    if (fields.length) outstanding.push({ ...item, fields });
  }
  return { total, answered, outstanding };
}
