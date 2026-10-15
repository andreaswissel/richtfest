import { exteriorNoiseExtractionSchema, exteriorNoiseBatchSchema, acousticInputProvenance,
  exteriorNoiseFacadeSchema, exteriorNoiseFactFields, acousticFactKey,
  type ExteriorNoiseFact, type ExteriorNoiseVisualCandidate, type AcousticInputReview } from "@richtfest/shared";
import { z } from "zod";
import { stepHash } from "./run-steps";

/** Stable reference to one immutable visual candidate for human review actions. */
export const exteriorNoiseVisualCandidateKey = (candidate: ExteriorNoiseVisualCandidate) => stepHash(candidate);
export const exteriorNoiseVisualAreaObservationKey = (candidate: ExteriorNoiseVisualCandidate) =>
  stepHash({ candidateKey: exteriorNoiseVisualCandidateKey(candidate), observation: candidate.floorAreaObservation ?? null });

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
  sourcePage?: number; evidenceKind?: string; documentBlock?: { id: string };
  documentBlocks?: [number, number, number, string, [number, number, number]?][];
  sourceFact?: { fact: { reviewStatus: string; evidence: { kind: string; page?: number; quote?: string } } };
  textRange?: { startByte: number; endByte: number; totalBytes: number } }[],
  visualReads: { receiptId: string; versionId: string; page: number; crop?: { x: number; y: number; width: number; height: number } | null; imageHash: string }[] = []) {
  const extraction = exteriorNoiseExtractionSchema.parse(raw);
  const literalSources = sources.flatMap(source => {
    if (source.evidenceKind === "page_notice" || source.evidenceKind === "environment_research") return [];
    if (source.evidenceKind === "source_fact" && (source.sourceFact?.fact.reviewStatus === "rejected"
      || source.sourceFact?.fact.evidence.kind !== "text")) return [];
    if (source.evidenceKind === "document_blocks") return (source.documentBlocks ?? []).map(block => ({
      ...source, text: block[3], documentBlock: { id: String(block[0]) },
      textRange: block[4] ? { startByte: block[4][0], endByte: block[4][1], totalBytes: block[4][2] }
        : { startByte: 0, endByte: Buffer.byteLength(block[3]), totalBytes: Buffer.byteLength(block[3]) },
    }));
    return [source];
  });
  const evidenceSources: typeof sources = [];
  for (const source of literalSources) {
    const previous = evidenceSources.at(-1);
    if (previous?.versionId === source.versionId && previous.sourcePage === source.sourcePage
      && previous.documentBlock?.id === source.documentBlock?.id && previous.textRange && source.textRange
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
    else if (!evidenceSources.some(s => s.versionId === p.versionId && (s.sourcePage === undefined || s.sourcePage === p.page) && s.text.includes(p.excerpt))) {
      // Models may reflow whitespace in OCR tables. Recover only an unambiguous
      // literal source span; never change words, punctuation, numbers or units.
      const pattern = p.excerpt.split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      const literals = new Set(evidenceSources.filter(s => s.versionId === p.versionId && (s.sourcePage === undefined || s.sourcePage === p.page))
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
  extraction.visualCandidates?.forEach((candidate, i) => {
    const path = ["visualCandidates", i, "provenance"];
    const p = candidate.provenance;
    const receipt = visualReads.find(read => read.receiptId === p.receiptId);
    const sameCrop = (left: typeof p.crop | undefined, right: typeof p.crop | undefined) => {
      const a = left ?? null, b = right ?? null;
      return a === null || b === null ? a === b
        : a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    };
    if (!receipt || receipt.versionId !== p.versionId || receipt.page !== p.page
      || !sameCrop(receipt.crop, p.crop) || receipt.imageHash !== p.imageHash) {
      issue(path, "visual_receipt_mismatch", "Visual candidates require an exact successful inspection receipt for the same source version, page, crop, and image.");
    }
  });
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
  const visualCandidates = new Map<string, ExteriorNoiseVisualCandidate>();
  for (const raw of packets) {
    const packet = exteriorNoiseExtractionSchema.parse(raw);
    for (const candidate of packet.visualCandidates ?? []) visualCandidates.set(JSON.stringify(candidate), candidate);
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
  if (!inventory.size) blockers.add("No declared room inventory was extracted; project calculation coverage is unknown.");
  for (const candidate of visualCandidates.values()) blockers.add(`Visual room candidate ${candidate.roomLabel ?? "(room label unresolved)"}${candidate.apartmentLabel ? ` / ${candidate.apartmentLabel}` : ""}: unreviewed mapping from source ${candidate.provenance.versionId}, page ${candidate.provenance.page}; confirm before adding to the calculation inventory.`);
  for (const id of inventory.keys()) if (!rooms.has(id)) blockers.add(`Room ${id}: complete source-backed calculation inputs are missing.`);
  return {
    input: inventory.size ? exteriorNoiseBatchSchema.extend({ method: z.literal("exterior_noise_batch") }).parse({
      method: "exterior_noise_batch", scope: "Extracted project room inventory",
      inventory: [...inventory.values()], rooms: [...rooms.values()].filter(r => !conflicts.has(r.room.id)),
    }) : null,
    blockers: [...blockers], visualCandidates: [...visualCandidates.values()].map(candidate => ({
      ...candidate, candidateKey: exteriorNoiseVisualCandidateKey(candidate), mappingDecision: null, confirmedRoomId: null,
    })),
  };
}

/** V2 merges exact, typed facts, never fuzzy room IDs, rounded values or source authority. */
export function reconcileExteriorNoiseInputs(packets: unknown[], resolutions: AcousticInputReview["resolutions"] = [],
  visualMappings: AcousticInputReview["visualMappings"] = [],
  visualAreaReviews: AcousticInputReview["visualAreaReviews"] = []) {
  const parsed = packets.map(p => exteriorNoiseExtractionSchema.parse(p));
  const blockers: string[] = [];
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
  const visualCandidates = [...new Map(parsed.flatMap(p => p.visualCandidates ?? [])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))).map(candidate => [JSON.stringify(candidate), candidate])).values()];
  const candidatesByKey = new Map(visualCandidates.map(candidate => [exteriorNoiseVisualCandidateKey(candidate), candidate]));
  const latestMappings = new Map<string, AcousticInputReview["visualMappings"][number]>();
  for (const mapping of visualMappings) latestMappings.set(mapping.candidateKey, mapping);
  const latestAreaReviews = new Map<string, AcousticInputReview["visualAreaReviews"][number]>();
  for (const review of visualAreaReviews) latestAreaReviews.set(review.candidateKey, review);
  for (const mapping of visualMappings) if (!candidatesByKey.has(mapping.candidateKey))
    blockers.push(`Visual mapping decision ${mapping.candidateKey} no longer matches a retained candidate; it was preserved and not applied.`);
  for (const review of visualAreaReviews) {
    const candidate = candidatesByKey.get(review.candidateKey);
    if (!candidate || !candidate.floorAreaObservation
      || exteriorNoiseVisualAreaObservationKey(candidate) !== review.observationKey)
      blockers.push(`Visual floor-area decision ${review.observationKey} no longer matches a retained observation; it was preserved and not applied.`);
  }
  for (const mapping of latestMappings.values()) {
    if (mapping.decision !== "confirmed" || !candidatesByKey.has(mapping.candidateKey)) continue;
    if (!inventory.some(entry => entry.roomId === mapping.roomId)) inventory.push({
      roomId: mapping.roomId,
      provenance: { kind: "assumption", reason: `Human-confirmed visual room identity ${mapping.candidateKey}; reviewer ${mapping.actorId} at ${mapping.at}.` },
    });
  }
  type Field = Pick<ExteriorNoiseFact, "roomId" | "target" | "id" | "field"> & {
    key: string; candidates: ExteriorNoiseFact[]; value: ExteriorNoiseFact["value"] | null;
    status: "missing" | "conflict" | "extracted" | "resolved";
    type: "number" | "boolean" | "string"; options?: string[];
  };
  const fields = new Map<string, Field>();
  const resolved = new Map(resolutions.map(r => [acousticFactKey(r.fact), r.fact]));
  const activeVisualAreaReviews = new Map<string, AcousticInputReview["visualAreaReviews"][number]>();
  const blockedVisualAreaKeys = new Set<string>();
  type ApprovedVisualAreaReview = Extract<AcousticInputReview["visualAreaReviews"][number], { decision: "approved" }>;
  const approvedAreaGroups = new Map<string, { review: ApprovedVisualAreaReview;
    candidate: ExteriorNoiseVisualCandidate }[]>();
  for (const review of latestAreaReviews.values()) {
    if (review.decision !== "approved") continue;
    const candidate = candidatesByKey.get(review.candidateKey);
    const mapping = latestMappings.get(review.candidateKey);
    if (!candidate?.floorAreaObservation || exteriorNoiseVisualAreaObservationKey(candidate) !== review.observationKey) continue;
    if (mapping?.decision !== "confirmed" || mapping.roomId !== review.roomId) {
      blockers.push(`Visual floor area ${review.observationKey} is inactive because its confirmed room identity changed or is missing.`);
      continue;
    }
    const key = acousticFactKey({ roomId: review.roomId, target: "room", id: review.roomId, field: "floorAreaM2" });
    const group = approvedAreaGroups.get(key) ?? [];
    group.push({ review, candidate });
    approvedAreaGroups.set(key, group);
  }
  for (const [key, group] of approvedAreaGroups) {
    const values = new Set(group.map(({ candidate }) => candidate.floorAreaObservation!.valueM2));
    if (values.size > 1) {
      blockedVisualAreaKeys.add(key);
      blockers.push(`Conflicting approved visual floor areas target the same room. Reconcile them before using a visual area.`);
      continue;
    }
    const reviewFact = resolved.get(key);
    const selected = group.sort((a, b) => a.review.candidateKey.localeCompare(b.review.candidateKey))[0]!;
    if (reviewFact && reviewFact.value !== selected.candidate.floorAreaObservation!.valueM2) {
      blockedVisualAreaKeys.add(key);
      blockers.push(`Approved visual floor area ${selected.review.observationKey} differs from the separately resolved room area; reconcile the values before using a visual area.`);
      continue;
    }
    for (const { review } of group) activeVisualAreaReviews.set(review.candidateKey, review);
    if (!reviewFact) {
      const { review, candidate } = selected;
      const fact: ExteriorNoiseFact = { roomId: review.roomId, target: "room", id: review.roomId, field: "floorAreaM2",
        value: candidate.floorAreaObservation!.valueM2,
        provenance: { kind: "assumption", reason: `Human-approved printed visual floor area ${review.observationKey} from candidate ${review.candidateKey}; reviewer ${review.actorId} at ${review.at}.` } };
      resolved.set(key, fact);
    }
  }
  const ensure = (roomId: string, target: ExteriorNoiseFact["target"], id: string, field: string) => {
    const key = acousticFactKey({ roomId, target, id, field });
    if (!fields.has(key)) {
      const schema = exteriorNoiseFactFields[target]![field]!;
      const options: string[] | undefined = schema instanceof z.ZodEnum ? schema.options
        : schema instanceof z.ZodLiteral ? [schema.value] : undefined;
      const candidates = [...new Map((byKey.get(key) ?? []).map(f => [JSON.stringify(f), f])).values()];
      const values = new Set(candidates.map(f => JSON.stringify(f.value)));
      const override = resolved.get(key);
      const blockedVisualArea = target === "room" && field === "floorAreaM2" && blockedVisualAreaKeys.has(key);
      fields.set(key, { roomId, target, id, field, key, candidates,
        value: blockedVisualArea ? null : override?.value ?? (values.size === 1 ? candidates[0]!.value : null),
        status: blockedVisualArea ? "conflict" : override ? "resolved" : !values.size ? "missing" : values.size > 1 ? "conflict" : "extracted",
        type: schema instanceof z.ZodNumber ? "number" : schema instanceof z.ZodBoolean ? "boolean" : "string",
        ...(options ? { options } : {}),
      });
    }
    return fields.get(key)!;
  };
  const rooms: z.infer<typeof exteriorNoiseFacadeSchema>[] = [];
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
  if (!inventory.length) blockers.push("No declared room inventory was extracted; project calculation coverage is unknown.");
  for (const candidate of visualCandidates) {
    const candidateKey = exteriorNoiseVisualCandidateKey(candidate);
    const decision = latestMappings.get(candidateKey);
    if (!decision) blockers.push(`Visual room candidate ${candidate.roomLabel ?? "(room label unresolved)"}${candidate.apartmentLabel ? ` / ${candidate.apartmentLabel}` : ""}: unreviewed mapping from source ${candidate.provenance.versionId}, page ${candidate.provenance.page}; confirm before adding to the calculation inventory.`);
    if (candidate.floorAreaObservation && !activeVisualAreaReviews.has(candidateKey)) {
      const areaReview = latestAreaReviews.get(candidateKey);
      blockers.push(areaReview?.decision === "rejected"
        ? `Printed floor area ${candidate.floorAreaObservation.valueM2} m² from candidate ${candidateKey} was rejected and is excluded from numerical inputs.`
        : `Printed floor area ${candidate.floorAreaObservation.valueM2} m² from candidate ${candidateKey} remains unreviewed or inactive; approve the exact observation after confirming the room identity.`);
    }
  }
  return {
    input: inventory.length ? exteriorNoiseBatchSchema.extend({ method: z.literal("exterior_noise_batch") }).parse({
      method: "exterior_noise_batch", scope: "Reconciled project room inventory", inventory, rooms,
    }) : null,
    blockers, fields: [...fields.values()],
    inventoryEvidence: parsed.flatMap(p => p.inventory),
    visualCandidates: visualCandidates.map(candidate => {
      const candidateKey = exteriorNoiseVisualCandidateKey(candidate);
      const decision = latestMappings.get(candidateKey);
      const observationKey = candidate.floorAreaObservation ? exteriorNoiseVisualAreaObservationKey(candidate) : null;
      const areaDecision = latestAreaReviews.get(candidateKey);
      const activeAreaDecision = activeVisualAreaReviews.get(candidateKey);
      return { ...candidate, candidateKey, mappingDecision: decision?.decision ?? null,
        confirmedRoomId: decision?.decision === "confirmed" ? decision.roomId : null,
        floorAreaObservationKey: observationKey, floorAreaDecision: areaDecision?.decision ?? null,
        floorAreaActive: activeAreaDecision?.decision === "approved",
        confirmedFloorAreaM2: activeAreaDecision?.decision === "approved" ? candidate.floorAreaObservation?.valueM2 ?? null : null,
        floorAreaRoomId: activeAreaDecision?.decision === "approved" ? activeAreaDecision.roomId : null };
    }),
    visualMappings,
    visualAreaReviews,
    sourceNotes: [...new Set(parsed.flatMap(p => p.blockers.map(b => `${b.roomId ?? "Project"}: ${b.reason}`)))],
  };
}
