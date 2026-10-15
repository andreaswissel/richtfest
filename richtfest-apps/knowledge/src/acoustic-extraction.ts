import { exteriorNoiseExtractionSchema, exteriorNoiseBatchSchema, acousticInputProvenance } from "@richtfest/shared";
import { z } from "zod";
import { stepHash } from "./run-steps";

/** Check source scope before an extraction is accepted into durable history. */
export function validateExteriorNoiseExtraction(raw: unknown, sources: { versionId: string; text: string }[]) {
  const extraction = exteriorNoiseExtractionSchema.parse(raw);
  const evidence = [
    ...extraction.inventory.map(r => r.provenance),
    ...extraction.rooms.flatMap(room => acousticInputProvenance({ ...room, method: "exterior_noise_facade" })),
  ];
  for (const p of evidence) {
    if (p.kind !== "source" || !sources.some(s => s.versionId === p.versionId && s.text.includes(p.excerpt)))
      throw new z.ZodError([{ code: "custom", path: ["exteriorNoiseExtraction"], message: "Extracted calculation inputs require exact quotations from this source packet; leave unsupported rooms blocked." }]);
  }
  const ids = new Set(extraction.inventory.map(r => r.roomId));
  if (ids.size !== extraction.inventory.length || new Set(extraction.rooms.map(r => r.room.id)).size !== extraction.rooms.length
    || extraction.rooms.some(r => !ids.has(r.room.id)))
    throw new z.ZodError([{ code: "custom", path: ["exteriorNoiseExtraction"], message: "Use unique room IDs; every supplied room must occur in the declared inventory." }]);
  return extraction;
}

/** Reconcile saved extraction packets without choosing between conflicting facts. */
export function assembleExteriorNoiseInputs(packets: unknown[]) {
  const inventory = new Map<string, z.infer<typeof exteriorNoiseBatchSchema>["inventory"][number]>();
  const rooms = new Map<string, z.infer<typeof exteriorNoiseBatchSchema>["rooms"][number]>();
  const conflicts = new Set<string>();
  const blockers = new Set<string>();
  for (const raw of packets) {
    const packet = exteriorNoiseExtractionSchema.parse(raw);
    for (const item of packet.inventory) if (!inventory.has(item.roomId)) inventory.set(item.roomId, item);
    for (const room of packet.rooms) {
      const previous = rooms.get(room.room.id);
      if (previous && stepHash(previous) !== stepHash(room)) {
        conflicts.add(room.room.id);
        blockers.add(`Room ${room.room.id}: conflicting extracted inputs; authoritative revision or mapping must be resolved.`);
      } else rooms.set(room.room.id, room);
    }
    for (const issue of packet.blockers) blockers.add(`${issue.roomId ? `Room ${issue.roomId}: ` : ""}${issue.reason}`);
  }
  if (!inventory.size) blockers.add("No source-backed room inventory was extracted; project calculation coverage is unknown.");
  for (const id of inventory.keys()) if (!rooms.has(id)) blockers.add(`Room ${id}: complete source-backed calculation inputs are missing.`);
  return {
    input: inventory.size ? exteriorNoiseBatchSchema.extend({ method: z.literal("exterior_noise_batch") }).parse({
      method: "exterior_noise_batch", scope: "Extracted project room inventory",
      inventory: [...inventory.values()], rooms: [...rooms.values()].filter(r => !conflicts.has(r.room.id)),
    }) : null,
    blockers: [...blockers],
  };
}
