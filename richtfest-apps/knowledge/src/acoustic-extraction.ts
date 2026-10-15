import { exteriorNoiseExtractionSchema, exteriorNoiseBatchSchema, acousticInputProvenance,
  exteriorNoiseFacadeSchema, exteriorNoiseFactFields, acousticFactKey,
  type ExteriorNoiseFact, type AcousticInputReview } from "@richtfest/shared";
import { z } from "zod";
import { stepHash } from "./run-steps";

/** Check source scope before an extraction is accepted into durable history. */
export function validateExteriorNoiseExtraction(raw: unknown, sources: { versionId: string; text: string }[]) {
  const extraction = exteriorNoiseExtractionSchema.parse(raw);
  const evidence = [
    ...extraction.inventory.map(r => r.provenance),
    ...extraction.rooms.flatMap(room => acousticInputProvenance({ ...room, method: "exterior_noise_facade" })),
    ...(extraction.facts ?? []).map(f => f.provenance),
  ];
  for (const p of evidence) {
    if (p.kind !== "source" || !sources.some(s => s.versionId === p.versionId && s.text.includes(p.excerpt)))
      throw new z.ZodError([{ code: "custom", path: ["exteriorNoiseExtraction"], message: "Extracted calculation inputs require exact quotations from this source packet; leave unsupported rooms blocked." }]);
  }
  const ids = new Set(extraction.inventory.map(r => r.roomId));
  if (ids.size !== extraction.inventory.length || new Set(extraction.rooms.map(r => r.room.id)).size !== extraction.rooms.length
    || extraction.rooms.some(r => !ids.has(r.room.id)) || extraction.facts?.some(f => !ids.has(f.roomId)))
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

/** V2 merges exact, typed facts, never fuzzy room IDs, rounded values or source authority. */
export function reconcileExteriorNoiseInputs(packets: unknown[], resolutions: AcousticInputReview["resolutions"] = []) {
  const parsed = packets.map(p => exteriorNoiseExtractionSchema.parse(p));
  const facts: ExteriorNoiseFact[] = parsed.flatMap(p => p.facts ?? []);
  for (const packet of parsed) for (const room of packet.rooms) {
    const add = (target: ExteriorNoiseFact["target"], id: string, record: Record<string, unknown>, provenance: ExteriorNoiseFact["provenance"]) => {
      for (const [field, value] of Object.entries(record)) if (Object.hasOwn(exteriorNoiseFactFields[target]!, field))
        facts.push({ roomId: room.room.id, target, id, field, value: value as ExteriorNoiseFact["value"], provenance });
    };
    add("room", room.room.id, room.room, room.room.provenance);
    add("coverage", room.room.id, room, room.room.provenance);
    add("applicability", room.room.id, room.applicability, room.applicability.provenance);
    add("flanking", room.room.id, room.flanking, room.flanking.provenance);
    for (const facade of room.facades) {
      add("facade", facade.id, facade, facade.provenance);
      add("noise", facade.id, facade.noise, facade.noise.provenance);
    }
    for (const element of room.elements) add("element", element.id, element, element.provenance);
  }
  // Stable ordering makes equivalent packets independent of extraction completion order.
  facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const byKey = new Map<string, ExteriorNoiseFact[]>();
  for (const fact of facts) {
    const key = acousticFactKey(fact);
    const group = byKey.get(key) ?? [];
    group.push(fact);
    byKey.set(key, group);
  }
  const inventory = [...new Map(parsed.flatMap(p => p.inventory)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))).map(r => [r.roomId, r])).values()];
  type Field = Pick<ExteriorNoiseFact, "roomId" | "target" | "id" | "field"> & {
    key: string; candidates: ExteriorNoiseFact[]; value: ExteriorNoiseFact["value"] | null;
    status: "missing" | "conflict" | "extracted" | "resolved";
    type: "number" | "boolean" | "string"; options?: string[];
  };
  const fields = new Map<string, Field>();
  const resolved = new Map(resolutions.map(r => [acousticFactKey(r.fact), r.fact]));
  const ensure = (roomId: string, target: ExteriorNoiseFact["target"], id: string, field: string) => {
    const key = acousticFactKey({ roomId, target, id, field });
    if (!fields.has(key)) {
      const schema = exteriorNoiseFactFields[target]![field]!;
      const options: string[] | undefined = schema instanceof z.ZodEnum ? schema.options
        : schema instanceof z.ZodLiteral ? [schema.value] : undefined;
      const candidates = [...new Map((byKey.get(key) ?? []).map(f => [JSON.stringify(f), f])).values()];
      const values = new Set(candidates.map(f => JSON.stringify(f.value)));
      const override = resolved.get(key);
      fields.set(key, { roomId, target, id, field, key, candidates,
        value: override?.value ?? (values.size === 1 ? candidates[0]!.value : null),
        status: override ? "resolved" : !values.size ? "missing" : values.size > 1 ? "conflict" : "extracted",
        type: schema instanceof z.ZodNumber ? "number" : schema instanceof z.ZodBoolean ? "boolean" : "string",
        ...(options ? { options } : {}),
      });
    }
    return fields.get(key)!;
  };
  const rooms: z.infer<typeof exteriorNoiseFacadeSchema>[] = [];
  const blockers: string[] = [];
  for (const entry of inventory) {
    const roomFacts = facts.filter(f => f.roomId === entry.roomId);
    const evidence: NonNullable<z.infer<typeof exteriorNoiseFacadeSchema>["fieldEvidence"]> = [];
    const record = (target: ExteriorNoiseFact["target"], id: string, keys = Object.keys(exteriorNoiseFactFields[target]!)) => {
      const result: Record<string, unknown> = Object.create(null);
      for (const field of keys) {
        const item = ensure(entry.roomId, target, id, field);
        if (item.value === null) continue;
        result[field] = item.value;
        const override = resolved.get(item.key);
        const selected = override ? [override] : item.candidates;
        for (const fact of selected) evidence.push({ field: `${target}/${id}/${field}`, provenance: fact.provenance });
        // The field register retains EVERY citation; this is only the group's primary citation.
        result.provenance ??= selected[0]!.provenance;
      }
      return result;
    };
    const facadeIds = [...new Set(roomFacts.filter(f => ["facade", "noise"].includes(f.target)).map(f => f.id))].sort();
    const elementIds = [...new Set(roomFacts.filter(f => f.target === "element").map(f => f.id))].sort();
    const coverage = record("coverage", entry.roomId);
    delete coverage.provenance;
    const candidate = { ...coverage,
      room: { id: entry.roomId, ...record("room", entry.roomId) },
      applicability: record("applicability", entry.roomId), flanking: record("flanking", entry.roomId),
      facades: facadeIds.map(id => ({ id, ...record("facade", id), noise: record("noise", id) })),
      elements: elementIds.map(id => {
        const kind = ensure(entry.roomId, "element", id, "kind").value;
        const keys = ["kind", "facadeId", "ratingBasis", "configuration", ...(kind === "area" ? ["areaM2", "rwDb", "construction"]
          : kind === "small" ? ["dnEWDb", "count", "openingAreaM2"] : [])];
        return { id, ...record("element", id, keys) };
      }), fieldEvidence: evidence,
    };
    const pending = [...fields.values()].filter(f => f.roomId === entry.roomId && f.value === null);
    for (const field of pending) blockers.push(`Room ${entry.roomId}: ${field.target}/${field.id}/${field.field} — ${field.status}.`);
    const room = exteriorNoiseFacadeSchema.safeParse(candidate);
    if (!facadeIds.length || !elementIds.length) blockers.push(`Room ${entry.roomId}: source-backed facade/element inventory is missing; supply source evidence, not invented objects.`);
    if (!pending.length && room.success) rooms.push(room.data);
    else if (!pending.length) blockers.push(`Room ${entry.roomId}: assembled inputs do not satisfy the calculation contract.`);
  }
  if (!inventory.length) blockers.push("No source-backed room inventory was extracted; project calculation coverage is unknown.");
  return {
    input: inventory.length ? exteriorNoiseBatchSchema.extend({ method: z.literal("exterior_noise_batch") }).parse({
      method: "exterior_noise_batch", scope: "Reconciled project room inventory", inventory, rooms,
    }) : null,
    blockers, fields: [...fields.values()],
    inventoryEvidence: parsed.flatMap(p => p.inventory),
    sourceNotes: [...new Set(parsed.flatMap(p => p.blockers.map(b => `${b.roomId ?? "Project"}: ${b.reason}`)))],
  };
}
