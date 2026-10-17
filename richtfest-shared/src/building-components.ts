import { z } from "zod";

/**
 * Shared component attributes on building-model entities. Every discipline
 * (sound, thermal, fire, cost) reads the same wall/ceiling record; these keys
 * are stored as ordinary versioned, reviewed building properties.
 */
export const componentTypeSchema = z.enum(["wall", "ceiling", "floor", "roof", "window", "door", "other"]);
export type ComponentType = z.infer<typeof componentTypeSchema>;
export const componentConstructionSchema = z.enum(["masonry", "concrete", "drywall", "timber", "steel", "other"]);
export type ComponentConstruction = z.infer<typeof componentConstructionSchema>;
/** Requirement-relevant wall role: DIN 4109-1 sets different requirements per role. */
export const wallRoleSchema = z.enum(["apartment_partition", "corridor_partition", "stairwell", "exterior", "internal"]);
export type WallRole = z.infer<typeof wallRoleSchema>;
export const spaceTypeSchema = z.enum(["apartment", "common_corridor", "stairwell", "common_other", "exterior"]);
export type SpaceType = z.infer<typeof spaceTypeSchema>;
/** Agreed sound insulation level: the statutory DIN 4109-1 minimum, the elevated civil-law level or DEGA 103. */
export const soundInsulationLevelSchema = z.enum(["statutory_minimum", "elevated", "dega"]);
/** German federal state: its Landesbauordnung and VVTB apply. */
export const federalStateSchema = z.enum(["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"]);
/** Whether a Bebauungsplan covers the site; it is checked first and binds the assessment. */
export const bebauungsplanSchema = z.enum(["applies", "none"]);
/** Regulatory basis keys, in the order the specialist checks them. */
export const regulatoryBasisKeys = ["federalState", "bebauungsplan", "bebauungsplanNoise", "stateBuildingCodeEdition", "vvtbEdition", "din4109Edition"] as const;
export type SoundInsulationLevel = z.infer<typeof soundInsulationLevelSchema>;

type PropertySpec = { value: z.ZodTypeAny; unit: string | null };
export const buildingComponentProperties = {
  element: {
    componentType: { value: componentTypeSchema, unit: null },
    construction: { value: componentConstructionSchema, unit: null },
    material: { value: z.string().trim().min(1).max(200), unit: null },
    thickness: { value: z.number().positive().max(500), unit: "cm" },
    bulkDensity: { value: z.number().positive().max(10000), unit: "kg/m³" },
    wallRole: { value: wallRoleSchema, unit: null },
  },
  building: {
    soundInsulationLevel: { value: soundInsulationLevelSchema, unit: null },
    // Regulatory basis: which law and editions apply, confirmed by approving each value.
    federalState: { value: federalStateSchema, unit: null },
    bebauungsplan: { value: bebauungsplanSchema, unit: null },
    bebauungsplanNoise: { value: z.string().trim().min(1).max(1000), unit: null },
    stateBuildingCodeEdition: { value: z.string().trim().min(1).max(120), unit: null },
    vvtbEdition: { value: z.string().trim().min(1).max(120), unit: null },
    din4109Edition: { value: z.string().trim().min(1).max(120), unit: null },
  },
  /** 0 is the ground floor; upper storeys count up, basements down. */
  storey: {
    level: { value: z.number().int().min(-9).max(99), unit: null },
  },
  room: {
    apartmentUnit: { value: z.string().trim().min(1).max(80), unit: null },
    spaceType: { value: spaceTypeSchema, unit: null },
  },
} satisfies Record<string, Record<string, PropertySpec>>;
/** Element kinds created by plan derivation imply a component type until one is entered. */
export function elementComponentType(kind: string | null | undefined, declared: unknown): ComponentType | null {
  if (typeof declared === "string" && componentTypeSchema.safeParse(declared).success) return declared as ComponentType;
  return kind === "draft_wall" ? "wall" : kind === "draft_ceiling" ? "ceiling" : null;
}

export type ElementComponentKey = keyof typeof buildingComponentProperties.element;
export type RoomComponentKey = keyof typeof buildingComponentProperties.room;

const specFor = (entityType: string, key: string): PropertySpec | undefined =>
  (buildingComponentProperties as Record<string, Record<string, PropertySpec>>)[entityType]?.[key];

/** Validates a known component key; unknown keys stay free-form. Returns an error message or null. */
export function validateBuildingComponentProperty(entityType: string, key: string, value: unknown, unit: string | null | undefined) {
  const spec = specFor(entityType, key);
  if (!spec) return null;
  if (value === null) return null;
  if (!spec.value.safeParse(value).success) return `Invalid value for ${key}`;
  if ((unit ?? null) !== spec.unit) return spec.unit ? `${key} requires unit ${spec.unit}` : `${key} takes no unit`;
  return null;
}

export type SpaceContext = { apartmentUnit: string | null; spaceType: SpaceType | null };

/**
 * Wall role from the two spaces a wall separates. Returns null when the role
 * cannot be established from the sides; it never guesses.
 */
export function deriveWallRole(a: SpaceContext | null, b: SpaceContext | null): WallRole | null {
  if (!a?.spaceType || !b?.spaceType) return null;
  // Any indoor space facing outside is an exterior wall, whatever else it separates.
  if ((a.spaceType === "exterior") !== (b.spaceType === "exterior")) return "exterior";
  const [apartment, other] = a.spaceType === "apartment" ? [a, b] : b.spaceType === "apartment" ? [b, a] : [null, null];
  if (!apartment || !other) return null;
  if (other.spaceType === "apartment") {
    if (!apartment.apartmentUnit || !other.apartmentUnit) return null;
    return apartment.apartmentUnit === other.apartmentUnit ? "internal" : "apartment_partition";
  }
  return other.spaceType === "common_corridor" ? "corridor_partition"
    : other.spaceType === "stairwell" ? "stairwell" : null;
}

export type ComponentPropertyState = { value: unknown; reviewStatus: string } | null | undefined;
export type ComponentInputGap = { field: string; status: "missing" | "unreviewed" };

/** Inputs a sound-insulation calculation needs for a wall or ceiling, and which are missing or unreviewed. */
export function componentInputGaps(componentType: ComponentType | null, properties: Record<string, ComponentPropertyState>): ComponentInputGap[] {
  if (componentType !== "wall" && componentType !== "ceiling") return [];
  const construction = properties.construction?.value;
  const fields = ["construction", "thickness",
    // Lightweight systems are rated as tested assemblies, not by bulk density.
    ...(construction === "drywall" || construction === "timber" ? [] : ["bulkDensity"]),
    ...(componentType === "wall" ? ["wallRole"] : [])];
  return fields.flatMap((field): ComponentInputGap[] => {
    const state = properties[field];
    if (!state || state.value === null || state.value === undefined || state.reviewStatus === "rejected") return [{ field, status: "missing" as const }];
    return state.reviewStatus === "approved" ? [] : [{ field, status: "unreviewed" as const }];
  });
}

export type ComponentValueState = { value: unknown; unit?: string | null; reviewStatus: string; provenance?: string | null; evidenceQuote?: string | null; evidenceKind?: string | null };

/** Where an unreviewed value came from: measured or derived from the plan, stated in a document or an inquiry reply, or entered by a person. */
export type ValueOrigin = "plan" | "document" | "correspondence" | "entered";
export const valueOrigin = (state: ComponentValueState): ValueOrigin => state.provenance !== "inferred" ? "entered"
  : state.evidenceKind === "correspondence" ? "correspondence"
  : state.evidenceQuote && !state.evidenceQuote.startsWith("Printed scale") ? "document" : "plan";
export type BuildingComponentRecord = { id: string; componentType: ComponentType | null; properties: Record<string, ComponentValueState | null | undefined> };

/** Latest non-rejected value of a component property; rejected values count as absent. */
const liveValue = (state: ComponentValueState | null | undefined) => state && state.reviewStatus !== "rejected" && state.value !== null && state.value !== undefined ? state : null;

/** Separating walls whose sound insulation must be verified against DIN 4109-1. Exterior walls go through the facade check. */
export const verifiedWallRoles = ["apartment_partition", "corridor_partition", "stairwell"] as const satisfies readonly WallRole[];
const roleOrder: Array<WallRole | null> = ["apartment_partition", "corridor_partition", "stairwell", "exterior", "internal", null];

export type ComponentRequestField = {
  field: string;
  /** Components without a usable value: ask for it. */
  missing: number;
  /** Unreviewed values grouped by value: ask to confirm them. */
  unconfirmed: Array<{ value: unknown; unit: string | null; origin: ValueOrigin; count: number }>;
};
export type ComponentRequestGroup = { componentType: "wall" | "ceiling"; wallRole: WallRole | null; count: number; componentIds: string[]; fields: ComponentRequestField[] };

/**
 * What still has to be asked of the architect or client, grouped the way they
 * answer: per wall role, and for ceilings. Only inputs a sound insulation
 * calculation needs are requested; a group appears only while something is
 * missing or unconfirmed.
 */
export function componentDataRequest(components: BuildingComponentRecord[]): ComponentRequestGroup[] {
  const groups = new Map<string, { componentType: "wall" | "ceiling"; wallRole: WallRole | null; items: BuildingComponentRecord[] }>();
  for (const component of components) {
    if (component.componentType !== "wall" && component.componentType !== "ceiling") continue;
    const role = component.componentType === "wall" ? (liveValue(component.properties.wallRole)?.value as WallRole | undefined) ?? null : null;
    const key = `${component.componentType}:${role}`;
    const group = groups.get(key) ?? { componentType: component.componentType, wallRole: role, items: [] };
    group.items.push(component);
    groups.set(key, group);
  }
  const result: ComponentRequestGroup[] = [];
  for (const group of groups.values()) {
    const fields = new Map<string, ComponentRequestField>();
    for (const item of group.items) {
      const gaps = componentInputGaps(item.componentType, Object.fromEntries(Object.entries(item.properties).map(([key, state]) => [key, state ? { value: state.value, reviewStatus: state.reviewStatus } : null])));
      // The wall role comes from the plan and Richtfest's review, not from the architect.
      for (const gap of gaps) {
        if (gap.field === "wallRole") continue;
        const field = fields.get(gap.field) ?? { field: gap.field, missing: 0, unconfirmed: [] };
        if (gap.status === "missing") field.missing++;
        else {
          const state = item.properties[gap.field]!;
          const unit = state.unit ?? null, origin = valueOrigin(state);
          const existing = field.unconfirmed.find(entry => JSON.stringify([entry.value, entry.unit, entry.origin]) === JSON.stringify([state.value, unit, origin]));
          if (existing) existing.count++; else field.unconfirmed.push({ value: state.value, unit, origin, count: 1 });
        }
        fields.set(gap.field, field);
      }
    }
    if (!fields.size) continue;
    const order = ["construction", "thickness", "bulkDensity"];
    result.push({ componentType: group.componentType, wallRole: group.wallRole, count: group.items.length, componentIds: group.items.map(item => item.id),
      fields: [...fields.values()].sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field)).map(field => ({ ...field, unconfirmed: field.unconfirmed.sort((a, b) => b.count - a.count) })) });
  }
  return result.sort((a, b) => (a.componentType === b.componentType ? 0 : a.componentType === "wall" ? -1 : 1) || roleOrder.indexOf(a.wallRole) - roleOrder.indexOf(b.wallRole));
}

export type SoundInsulationCheck = { componentId: string; componentType: "wall" | "ceiling"; wallRole: WallRole | null; ready: boolean; gaps: ComponentInputGap[] };

/**
 * Separating components that need an airborne/impact sound insulation
 * verification, and whether their inputs are complete and reviewed. This only
 * prepares the verification; it does not calculate anything.
 */
export function soundInsulationChecks(components: BuildingComponentRecord[]): SoundInsulationCheck[] {
  return components.flatMap((component): SoundInsulationCheck[] => {
    const role = component.componentType === "wall" ? (liveValue(component.properties.wallRole)?.value as WallRole | undefined) ?? null : null;
    if (component.componentType === "wall" ? !role || !(verifiedWallRoles as readonly string[]).includes(role) : component.componentType !== "ceiling") return [];
    const gaps = componentInputGaps(component.componentType, Object.fromEntries(Object.entries(component.properties).map(([key, state]) => [key, state ? { value: state.value, reviewStatus: state.reviewStatus } : null])));
    return [{ componentId: component.id, componentType: component.componentType as "wall" | "ceiling", wallRole: role, ready: gaps.length === 0, gaps }];
  });
}

/**
 * Regulatory basis items still to settle: missing or not yet confirmed by a
 * person. Bebauungsplan noise requirements are only asked for when a plan applies.
 */
export function regulatoryBasisGaps(properties: Record<string, ComponentPropertyState>): ComponentInputGap[] {
  const keys = regulatoryBasisKeys.filter(key => key !== "bebauungsplanNoise" || properties.bebauungsplan?.value === "applies");
  return keys.flatMap((field): ComponentInputGap[] => {
    const state = properties[field];
    if (!state || state.value === null || state.value === undefined || state.reviewStatus === "rejected") return [{ field, status: "missing" }];
    return state.reviewStatus === "approved" ? [] : [{ field, status: "unreviewed" }];
  });
}

export type DataRequestProgress = { total: number; answered: number; outstanding: ComponentRequestGroup[] };

/**
 * How much of a sent request has been answered. An item (one field of one
 * group) counts as answered once none of the requested components still has it
 * missing or unreviewed, whether it was entered, copied, read or approved.
 * Components deleted since are ignored.
 */
export function dataRequestProgress(items: ComponentRequestGroup[], components: BuildingComponentRecord[]): DataRequestProgress {
  const byId = new Map(components.map(component => [component.id, component]));
  const gapsOf = (component: BuildingComponentRecord) => new Set(componentInputGaps(component.componentType, Object.fromEntries(Object.entries(component.properties)
    .map(([key, state]) => [key, state ? { value: state.value, reviewStatus: state.reviewStatus } : null]))).map(gap => gap.field));
  let total = 0, answered = 0;
  const outstanding: ComponentRequestGroup[] = [];
  for (const group of items) {
    const current = group.componentIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const fields = group.fields.filter(field => {
      total++;
      const open = current.some(component => gapsOf(component).has(field.field));
      if (!open) answered++;
      return open;
    });
    if (fields.length) outstanding.push({ ...group, fields });
  }
  return { total, answered, outstanding };
}

/**
 * What to ask again for a sent request: the current data request for the
 * requested components, limited to the items still open. Values the
 * counterpart already stated in a reply are left out: they need an internal
 * review, not another question. Other proposed values appear to confirm.
 */
export function followUpRequest(items: ComponentRequestGroup[], components: BuildingComponentRecord[]): ComponentRequestGroup[] {
  const open = new Map<string, Set<string>>();
  for (const group of dataRequestProgress(items, components).outstanding)
    for (const id of group.componentIds) open.set(id, new Set([...(open.get(id) ?? []), ...group.fields.map(field => field.field)]));
  return componentDataRequest(components.filter(component => open.has(component.id)))
    .map(group => ({ ...group, fields: group.fields.filter(field => group.componentIds.some(id => open.get(id)?.has(field.field)))
      .map(field => ({ ...field, unconfirmed: field.unconfirmed.filter(entry => entry.origin !== "correspondence") }))
      .filter(field => field.missing > 0 || field.unconfirmed.length > 0) }))
    .filter(group => group.fields.length);
}
