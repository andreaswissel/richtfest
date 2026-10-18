import { z } from "zod";
export const SITE_REFERENCE_METRICS = ["footprint", "storeys", "eaveHeight", "ridgeHeight", "depth", "frontage", "boundaryDistance", "buildingLineOffset", "grz", "grz2", "gfz"] as const;
export type SiteReferenceMetric = typeof SITE_REFERENCE_METRICS[number];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === v; });
const measurement = z.object({ value:z.number().finite().nonnegative().max(1e9).nullable(), source:z.string().max(2000), sourceDate:date.nullable(), kind:z.enum(["official","calculated","estimated","assessment"]), reviewed:z.boolean() }).strict();
export const siteReferenceSchema = z.object({
  id:z.string().min(1).max(200), label:z.string().max(300), source:z.string().max(2000), note:z.string().max(2000),
  buildingId:z.string().max(300).optional(), parcelId:z.string().max(300).optional(),
  polygons:z.array(z.array(z.array(z.tuple([z.number().finite(),z.number().finite()])).max(2000)).max(100)).max(100).optional(),
  metrics:z.object(Object.fromEntries(SITE_REFERENCE_METRICS.map(key=>[key,measurement.optional()])) as Record<SiteReferenceMetric,z.ZodOptional<typeof measurement>>).strict().optional(),
  buildingForm:z.object({value:z.string().max(300),source:z.string().max(2000),sourceDate:date.nullable(),reviewed:z.boolean()}).strict().optional(),
}).strict();
export type SiteReference = z.infer<typeof siteReferenceSchema>;
/** Descriptive sample only: no selection of binding planning limits or invented missing measurements. */
export function compareSiteReferences(references: SiteReference[]) {
  return Object.fromEntries(SITE_REFERENCE_METRICS.map(key => {
    const items = references.flatMap(r => { const m=r.metrics?.[key]; return m?.value == null ? [] : [m]; });
    return [key, items.length ? { count:items.length, mean:items.reduce((sum,m)=>sum+m.value!,0)/items.length, max:Math.max(...items.map(m=>m.value!)), reviewed:items.every(m=>m.reviewed && !!m.source && !!m.sourceDate) } : null];
  })) as Record<SiteReferenceMetric,{count:number;mean:number;max:number;reviewed:boolean}|null>;
}
