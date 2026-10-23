import { z } from "zod";
import { ceilingRequirement, classifyFireBuilding, closureSatisfies, escapeRouteLengths, fireCodeEditions,
  fireComponentStatus, fireConceptDraft, fireDoorRequirement, fireWallRequirement, fireWaterDemand,
  fireRatingSchema, fireClosureSchema, fireRoomRoleSchema, fireSpecialUseSchema, garageEnclosureSchema,
  stairwellSmokeVentSchema, ratingSatisfies, maxEscapeDistance, type FireConceptInput } from "./fire-protection";

const text = z.string().trim().min(1);
const quantity = z.number().finite().nonnegative().nullable();
const count = z.number().int().nonnegative().nullable();
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const evidence = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), sourceId: text, page: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("ifc"), sourceId: text, expressId: z.number().int().positive(), attribute: text }).strict(),
]));
const face = z.object({ exterior: z.boolean(), roomIds: z.array(text) }).strict()
  .refine(value => value.exterior ? value.roomIds.length === 0 : value.roomIds.length > 0, "An interior face needs rooms; an exterior face has none");

/** A calculation-stage snapshot, not an extractor output or an approved design.
 * Coordinates are metres in each storey's own 2D plane; no cross-storey routes.
 */
export const firePlanSchema = z.object({
  building: z.object({
    evidence,
    input: z.object({
      state: text.nullable(), height: quantity, detached: z.boolean().nullable(), dwellings: count, otherUnits: count,
      usableArea: quantity, largestUnitArea: quantity, unitsGrossArea: quantity, storeysAboveGround: count,
      specialUse: fireSpecialUseSchema.nullable(), garageArea: quantity,
    }).strict(),
    fullStoreys: count, smokeVent: stairwellSmokeVentSchema.nullable(), garageEnclosure: garageEnclosureSchema.nullable(),
  }).strict(),
  storeys: z.array(z.object({
    id: text, evidence,
    // Assert only after checking source scale, polygons, exits and door connections.
    geometryReviewed: z.boolean(),
    rooms: z.array(z.object({
      id: text, role: fireRoomRoleSchema.nullable(), unit: text.nullable(), basement: z.boolean().nullable(),
      roomUse: text.nullable(), smokeVent: stairwellSmokeVentSchema.nullable(), polygon: z.array(point).min(3).nullable(),
    }).strict()),
    walls: z.array(z.object({ id: text, basement: z.boolean().nullable(), loadBearing: z.boolean().nullable(),
      faces: z.tuple([face, face]).nullable(), actual: fireRatingSchema.nullable() }).strict()),
    ceilings: z.array(z.object({ id: text, basement: z.boolean().nullable(), actual: fireRatingSchema.nullable() }).strict()),
    doors: z.array(z.object({ id: text, point: point.nullable(), rooms: z.tuple([text.nullable(), text.nullable()]).nullable(),
      actual: fireClosureSchema.nullable() }).strict()),
  }).strict()).min(1),
}).strict();
export type FirePlan = z.infer<typeof firePlanSchema>;
export type FireProtectionSnapshot = { available: false; reason: string } | {
  available: true; modelId: string; revision: number; plan: FirePlan; blockers: string[];
  sourceVersionIds: string[]; properties: Array<{ entityId: string; key: string; version: number; reviewStatus: string; provenance: string; evidence: unknown }>;
};
export function validateFirePlan(value: FirePlan, ctx: z.RefinementCtx) {
  const problem = (message: string) => ctx.addIssue({ code: "custom", message });
  if (new Set(value.storeys.map(s => s.id)).size !== value.storeys.length) problem("Storey IDs must be unique");
  for (const storey of value.storeys) {
    const items = [...storey.rooms, ...storey.walls, ...storey.ceilings, ...storey.doors];
    if (new Set(items.map(item => item.id)).size !== items.length) problem("Element IDs must be unique within a storey");
    // Delimiters are reserved for stable check IDs.
    if ([storey, ...items].some(item => /[:/]/.test(item.id))) problem("IDs cannot contain : or /");
    const rooms = new Set(storey.rooms.map(room => room.id));
    for (const wall of storey.walls) for (const side of wall.faces ?? [])
      if (side.roomIds.some(id => !rooms.has(id))) problem("Wall refers to an unknown room");
    for (const door of storey.doors) if (door.rooms && (door.rooms[0] === door.rooms[1] || door.rooms.some(id => id !== null && !rooms.has(id))))
      problem("Door needs two different, known sides; null means confirmed outside, not unknown");
  }
}

/** Shared by saved-model execution and offline replay; no model-supplied answers. */
export function assessFirePlan(raw: unknown, mode: "reviewed" | "candidate_preview" = "reviewed") {
  const input = firePlanSchema.superRefine(validateFirePlan).parse(raw);
  const { building } = input;
  const classification = classifyFireBuilding(building.input);
  const { state, buildingClass } = classification;
  type Observation = { id: string; value: string | number | boolean | null; unit: string | null;
    evidence: z.infer<typeof evidence>; outcome: "complete" | "blocked" | "unsupported"; note: string };
  const observations: Observation[] = [];
  const components: FireConceptInput["components"] = [];
  const routes: Array<{ storeyId: string; roomId: string; length: number; path: z.infer<typeof point>[] }> = [];
  const add = (id: string, value: Observation["value"], unit: string | null, evidence: Observation["evidence"],
    outcome: Observation["outcome"] = "complete", note = "Deterministic replay of supplied inputs; not approval.") => {
    observations.push({ id, value, unit, evidence, outcome, note });
  };
  const jurisdiction = state ? "complete" : building.input.state ? "unsupported" : "blocked";
  for (const [key, value] of Object.entries({ class: buildingClass, deliverable: classification.deliverable, review: classification.review }))
    add(`building:${key}`, value, null, building.evidence, jurisdiction !== "complete" ? jurisdiction : value === null ? "blocked" : "complete",
      classification.gaps.length ? `Missing inputs: ${classification.gaps.join(", ")}` : "Classification under the engine's recorded code edition.");

  for (const storey of input.storeys) {
    const prefix = `${storey.id}/`;
    const roomById = new Map(storey.rooms.map(room => [room.id, room]));
    const baseOutcome = jurisdiction !== "complete" ? jurisdiction : buildingClass === null ? "blocked" : "complete";
    const elements = [...storey.walls.map(item => ({ ...item, kind: "wall" as const })),
      ...storey.ceilings.map(item => ({ ...item, kind: "ceiling" as const })), ...storey.doors.map(item => ({ ...item, kind: "door" as const }))];
    for (const element of elements) {
      const { kind } = element;
      const unknownSpace = (id: string) => roomById.get(id)!.role === null || roomById.get(id)!.basement === null;
      const missingDoorSpace = (id: string) => {
        const room = roomById.get(id)!;
        return unknownSpace(id) || (room.role === "other" && room.roomUse === null)
          || (state === "RP" && (buildingClass ?? 0) >= 4 && room.role === "necessary_stairwell" && !(room.smokeVent ?? building.smokeVent));
      };
      const missing = element.kind === "wall"
        ? element.basement === null || element.faces === null || element.loadBearing === null || building.input.otherUnits === null || element.faces.some(face => face.roomIds.some(unknownSpace))
        : element.kind === "door" ? element.rooms === null || element.rooms.some(id => id !== null && missingDoorSpace(id)) : element.basement === null;
      const outcome = baseOutcome !== "complete" ? baseOutcome : missing ? "blocked" : "complete";
      let required: string | null = null;
      let status: FireConceptInput["components"][number]["status"] | null = null;
      if (outcome === "complete" && state) {
        if (element.kind === "door") {
          const sides = element.rooms!.map(id => id === null ? null : roomById.get(id)!) as Parameters<typeof fireDoorRequirement>[0]["sides"];
          const result = fireDoorRequirement({ state, buildingClass, smokeVent: building.smokeVent, sides });
          required = result.required;
          status = fireComponentStatus(result.required, element.actual, closureSatisfies);
          components.push({ kind, name: prefix + element.id, status, reasons: result.reasons });
        } else {
          const result = element.kind === "wall" ? fireWallRequirement({ state, buildingClass, basement: element.basement!,
            loadBearing: element.loadBearing, residential: building.input.otherUnits === 0,
            faces: element.faces!.map(face => ({ exterior: face.exterior, spaces: face.roomIds.map(id => ({ ...roomById.get(id)!, basement: roomById.get(id)!.basement! })) })) })
            : ceilingRequirement(state, buildingClass, element.basement!);
          required = result.required;
          status = fireComponentStatus(result.required, element.actual, ratingSatisfies);
          components.push({ kind, name: prefix + element.id, status, reasons: result.reasons });
        }
      }
      add(`component:${prefix}${element.id}:required`, outcome === "complete" ? required ?? "none" : null, null, storey.evidence, outcome);
      add(`component:${prefix}${element.id}:status`, status, null, storey.evidence, outcome);
    }
    // IFC routes remain unsupported, even if an operator supplies a 2D polygon.
    const routeOutcome = baseOutcome !== "complete" ? baseOutcome : storey.evidence.some(item => item.kind === "ifc") ? "unsupported"
      : !storey.evidence.length || mode !== "candidate_preview" && !storey.geometryReviewed || storey.rooms.some(room => room.role === null || room.polygon === null || room.basement === null)
        || storey.doors.some(door => door.rooms === null || door.point === null) ? "blocked" : "complete";
    const calculated = routeOutcome === "complete" ? escapeRouteLengths(
      storey.rooms.map(room => ({ ...room, basement: room.basement!, polygon: room.polygon! })),
      storey.doors.map(door => ({ id: door.id, rooms: door.rooms!, point: door.point! }))) : [];
    for (const room of storey.rooms.filter(room => room.role !== "necessary_stairwell" && (room.role === null || room.role === "habitable" || room.basement !== false))) {
      const route = calculated.find(route => route.roomId === room.id);
      const outcome = routeOutcome !== "complete" ? routeOutcome : route ? "complete" : "blocked";
      add(`route:${prefix}${room.id}:length`, route?.length ?? null, "m", storey.evidence, outcome,
        route ? `${mode === "candidate_preview" ? "UNREVIEWED candidate geometry. " : ""}Engine's sampled first-route length, rounded to 0.01 m; not a second-route or accessibility check.`
          : "No verified calculable route: check scale, geometry, roles, door connections, exits and supported source format.");
      add(`route:${prefix}${room.id}:withinLimit`, route ? route.length <= maxEscapeDistance : null, null, storey.evidence, outcome,
        "Engine's 35 m comparison uses its rounded length; borderline routes require independent geometric review.");
      if (route) routes.push({ storeyId: storey.id, roomId: room.id, length: route.length, path: route.path });
    }
  }
  const water = building.fullStoreys === null || building.input.detached === null ? null : fireWaterDemand(building.fullStoreys, building.input.detached);
  add("building:water", state ? water?.litresPerMinute ?? null : null, "l/min", building.evidence,
    jurisdiction !== "complete" ? jurisdiction : water ? "complete" : "blocked", "AGBF basic demand only; availability and project-specific demand require review.");
  for (const id of ["second-escape-route", "fire-brigade-access", "garage-components"])
    add(`scope:${id}`, null, null, building.evidence, "unsupported", "Not executed by this engine; retain applicable positive checks as failures.");
  const gaps = observations.filter(item => item.outcome !== "complete").map(item => ({ id: item.id, outcome: item.outcome, note: item.note }));
  const concept = state ? "UNREVIEWED DRAFT — calculation-stage replay, not a complete Brandschutzkonzept.\n\n"
    + (mode === "candidate_preview" ? "CANDIDATE PREVIEW — geometry, connections and inferred inputs may be unreviewed. Results are conditional, not approval or demonstrated compliance.\n\n" : "")
    + "Unperformed or blocked checks:\n" + gaps.map(gap => `- ${gap.id}: ${gap.outcome}`).join("\n") + "\n\n"
    + fireConceptDraft({ classification, height: building.input.height, dwellings: building.input.dwellings,
      garageEnclosure: building.garageEnclosure, components, routes: routes.map(route => ({ room: `${route.storeyId}/${route.roomId}`, length: route.length })),
      stairwells: input.storeys.flatMap(s => s.rooms.filter(r => r.role === "necessary_stairwell").map(r => ({ name: `${s.id}/${r.id}`, smokeVent: r.smokeVent ?? building.smokeVent }))), water }) + "\n" : null;
  return { ...(mode === "candidate_preview" ? { mode, reviewStatus: "unreviewed" as const } : {}),
    classification, codeEditions: state ? fireCodeEditions[state] : null, components, routes, gaps, observations, concept };
}
