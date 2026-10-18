/**
 * The stored planning regime of a B-Plan parcel: plan type, adoption date, land-use ordinance (BauNVO version or
 * BO 58) and building class. Part of the site assessment contract; the rules each version implies live in
 * `planning-regime.ts`, which only the feasibility screens load.
 */
import { z } from "zod";

/** Calendar date (YYYY-MM-DD) that exists. */
export const regimeDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => { const d = new Date(v); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; }, "Invalid date");

export const PLAN_TYPES = ["qualified", "simple", "project_specific"] as const;
export type PlanType = (typeof PLAN_TYPES)[number];
export const LAND_USE_ORDINANCES = ["baunvo_1962", "baunvo_1968", "baunvo_1977", "baunvo_1990", "bo_58"] as const;
export type LandUseOrdinance = (typeof LAND_USE_ORDINANCES)[number];
export const BO58_BUILDING_CLASSES = ["II/1", "II/2", "II/3", "III/3", "IV/3", "V/3", "6"] as const;
export type Bo58BuildingClass = (typeof BO58_BUILDING_CLASSES)[number];

export const planRegimeSchema = z.object({
  regime: z.enum(["b_plan", "baunutzungsplan"]),
  planType: z.enum(PLAN_TYPES).nullable(),
  planName: z.string().trim().max(300),
  adoptedOn: regimeDate.nullable(),
  ordinance: z.enum(LAND_USE_ORDINANCES).nullable(),
  buildingClass: z.enum(BO58_BUILDING_CLASSES).nullable(),
  courtReview: z.string().trim().max(200).nullable(),
  source: z.string().trim().max(2000),
  sourceDate: regimeDate.nullable(),
  reviewed: z.boolean(),
}).strict();
export type PlanRegime = z.infer<typeof planRegimeSchema>;
