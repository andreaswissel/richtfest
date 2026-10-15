import { exteriorNoiseExtractionSchema, exteriorNoiseBatchSchema, acousticInputProvenance,
  exteriorNoiseFacadeSchema, exteriorNoiseFactFields, acousticFactKey,
  type ExteriorNoiseFact, type AcousticInputReview } from "@richtfest/shared";
import { z } from "zod";
import { stepHash } from "./run-steps";

/** Identity hints only: later packets still need their own source-backed facts. */
export function exteriorNoiseIdentityDirectory(packets: unknown[]) {
  const entries = new Map<string, { roomId: string; provenance: z.infer<typeof exteriorNoiseExtractionSchema>["inventory"][number]["provenance"];
    facadeIds: Set<string>; elementIds: Set<string> }>();
  for (const raw of packets) {
    const packet = exteriorNoiseExtractionSchema.parse(raw);
    for (const room of packet.inventory) {
      const key = JSON.stringify([room.roomId, room.provenance.kind === "source" ? room.provenance.versionId : null]);
      const entry = entries.get(key) ?? { ...room, facadeIds: new Set<string>(), elementIds: new Set<string>() };
      for (const full of packet.rooms.filter(r => r.room.id === room.roomId)) {
        for (const facade of full.facades) entry.facadeIds.add(facade.id);
        for (const element of full.elements) entry.elementIds.add(element.id);
      }
      for (const fact of packet.facts ?? []) if (fact.roomId === room.roomId) {
        if (fact.target === "facade" || fact.target === "noise") entry.facadeIds.add(fact.id);
        if (fact.target === "element") entry.elementIds.add(fact.id);
      }
      entries.set(key, entry);
    }
  }
  return [...entries.values()].map(entry => ({ ...entry,
    facadeIds: [...entry.facadeIds].sort(), elementIds: [...entry.elementIds].sort(),
  }));
}

/** Check source scope before an extraction is accepted into durable history. */
export function validateExteriorNoiseExtraction(raw: unknown, sources: { versionId: string; text: string;
  textRange?: { startByte: number; endByte: number; totalBytes: number } }[]) {
  const extraction = exteriorNoiseExtractionSchema.parse(raw);
  const evidenceSources: typeof sources = [];
  for (const source of sources) {
    const previous = evidenceSources.at(-1);
    if (previous?.versionId === source.versionId && previous.textRange && source.textRange
      && previous.textRange.endByte === source.textRange.startByte
      && previous.textRange.totalBytes === source.textRange.totalBytes
      && Buffer.byteLength(previous.text) === previous.textRange.endByte - previous.textRange.startByte
      && Buffer.byteLength(source.text) === source.textRange.endByte - source.textRange.startByte) {
      // Exact byte-adjacent slices are one supplied passage, not an evidence gap.
      previous.text += source.text;
      previous.textRange = { ...previous.textRange, endByte: source.textRange.endByte };
    } else evidenceSources.push({ ...source });
  }
  const issues: z.ZodIssue[] = [];
  const issue = (path: (string | number)[], reason: string, message: string) => issues.push({
    code: "custom", path: ["exteriorNoiseExtraction", ...path], message, params: { acoustic: reason },
  });
  const evidence = (p: ReturnType<typeof acousticInputProvenance>[number], path: (string | number)[]) => {
    if (p.kind !== "source") issue([...path, "kind"], "source_required", "Extracted calculation inputs require exact quotations, not assumptions.");
    else if (!sources.some(s => s.versionId === p.versionId))
      issue([...path, "versionId"], "source_not_in_packet", "Use an exact source version from this packet with exact quotations.");
    else if (!evidenceSources.some(s => s.versionId === p.versionId && s.text.includes(p.excerpt))) {
      // Models may reflow whitespace in OCR tables. Recover only an unambiguous
      // literal source span; never change words, punctuation, numbers or units.
      const pattern = p.excerpt.split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      const literals = new Set(evidenceSources.filter(s => s.versionId === p.versionId)
        .flatMap(s => [...s.text.matchAll(new RegExp(pattern, "gu"))].map(match => match[0])));
      const literal = literals.size === 1 ? [...literals][0] : undefined;
      if (literal && literal.length <= 1000) p.excerpt = literal;
      else issue([...path, "excerpt"], "quote_not_in_source", "Extracted calculation inputs require exact quotations from the associated source packet.");
    }
  };
  extraction.inventory.forEach((r, i) => evidence(r.provenance, ["inventory", i, "provenance"]));
  extraction.rooms.forEach((room, i) => {
    for (const key of ["room", "applicability", "flanking"] as const) evidence(room[key].provenance, ["rooms", i, key, "provenance"]);
    room.facades.forEach((f, j) => {
      evidence(f.provenance, ["rooms", i, "facades", j, "provenance"]);
      evidence(f.noise.provenance, ["rooms", i, "facades", j, "noise", "provenance"]);
    });
    room.elements.forEach((e, j) => evidence(e.provenance, ["rooms", i, "elements", j, "provenance"]));
    room.fieldEvidence?.forEach((e, j) => evidence(e.provenance, ["rooms", i, "fieldEvidence", j, "provenance"]));
  });
  extraction.facts?.forEach((f, i) => evidence(f.provenance, ["facts", i, "provenance"]));
  const ids = new Set(extraction.inventory.map(r => r.roomId));
  const seenInventory = new Set<string>(), seenRooms = new Set<string>();
  extraction.inventory.forEach((r, i) => {
    if (seenInventory.has(r.roomId)) issue(["inventory", i, "roomId"], "duplicate_room", "Use unique room IDs in the declared inventory.");
    seenInventory.add(r.roomId);
  });
  extraction.rooms.forEach((r, i) => {
    if (seenRooms.has(r.room.id)) issue(["rooms", i, "room", "id"], "duplicate_room", "Supply each room only once.");
    if (!ids.has(r.room.id)) issue(["rooms", i, "room", "id"], "room_not_declared", "Every supplied room must occur in the declared inventory.");
    seenRooms.add(r.room.id);
  });
  extraction.facts?.forEach((f, i) => {
    if (!ids.has(f.roomId)) issue(["facts", i, "roomId"], "room_not_declared", "Every fact must refer to a room in the declared inventory.");
  });
  if (issues.length) throw new z.ZodError(issues);
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
