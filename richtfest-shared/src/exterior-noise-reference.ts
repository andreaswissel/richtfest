import { z } from "zod";

// Printed-reference reproduction only. These inputs assert neither normative
// applicability nor complete/reviewed project geometry. No agent tool uses this contract.
const id = z.string().trim().min(1).max(200);
const area = z.number().finite().positive().max(1_000_000);
const rating = z.number().finite().min(0).max(100);
const pages = z.array(z.number().int().positive()).min(1);
const sourceSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const element = { id, correctionDb: z.number().finite().min(-100).max(100) };
const room = z.object({
  id, pages,
  assessedLaDb: z.number().finite().min(0).max(150),
  roomFactorDb: rating, minimumRequirementDb: rating,
  floorAreaM2: area,
  requirementAreaM2: area,
  compositeAreaM2: area,
  uncertaintyDb: z.number().finite().min(0).max(20),
  elements: z.array(z.discriminatedUnion("kind", [
    z.object({ ...element, kind: z.literal("area"), areaM2: area.nullable(), rwDb: rating }).strict(),
    z.object({ ...element, kind: z.literal("small"), dnEWDb: rating, count: z.number().int().min(1).max(100) }).strict(),
  ])).min(1).max(100),
}).strict().refine(r => new Set(r.elements.map(e => e.id)).size === r.elements.length, "Duplicate element IDs");

export const exteriorNoiseReferenceInputsSchema = z.object({
  version: z.literal(1), sourceSha256,
  rooms: z.array(room).min(1).max(1000),
}).strict().refine(v => new Set(v.rooms.map(r => r.id)).size === v.rooms.length, "Duplicate input room IDs");
export type ExteriorNoiseReferenceInputs = z.infer<typeof exteriorNoiseReferenceInputsSchema>;

// Expected answers are a separate argument/file, never a calculation input.
export const exteriorNoiseReferenceAnswersSchema = z.object({
  version: z.literal(1), sourceSha256,
  rooms: z.array(z.object({
    id, pages,
    requiredDb: z.number().finite(),
    compositeDb: z.number().finite(),
    providedDb: z.number().finite(),
  }).strict()).min(1).max(1000),
}).strict().refine(v => new Set(v.rooms.map(r => r.id)).size === v.rooms.length, "Duplicate reference room IDs");
