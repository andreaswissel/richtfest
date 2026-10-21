import { z } from "zod";

export const ifcBuildingImportInput = z.object({
  sourceVersionId: z.string().uuid(),
  baseRevision: z.number().int().nonnegative(),
  storeyExpressIds: z.array(z.number().int().positive()).min(1).refine(ids => new Set(ids).size === ids.length),
}).strict();

export type IfcFootprint = {
  coordinateSpace: "ifc-metre";
  method: "mesh-plan-projection-v1";
  /** IFC X/Y horizontal plane, in metres; closed rings, outer ring followed by holes. */
  footprint: [number, number][][][];
  elevationRange: [number, number];
  composedFromExpressIds?: number[];
};
export type IfcBuildingEntity = {
  expressId: number;
  globalId?: string;
  name: string;
  ifcType: string;
  entityType: "building" | "storey" | "room" | "element";
  buildingExpressId: number;
  storeyExpressId?: number;
  geometry: IfcFootprint | null;
};
export type IfcBuildingPreview = {
  schema: string;
  parserVersion: string;
  entities: IfcBuildingEntity[];
  warnings: Array<{ code: "unmapped" | "missingGeometry" | "failedGeometry" | "missingClasses" | "allDoorsExternal" | "identicalUnits" | "missingFireRatings"; count: number; detail?: string }>;
};
