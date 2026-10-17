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
  room: {
    apartmentUnit: { value: z.string().trim().min(1).max(80), unit: null },
    spaceType: { value: spaceTypeSchema, unit: null },
  },
} satisfies Record<string, Record<string, PropertySpec>>;
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
