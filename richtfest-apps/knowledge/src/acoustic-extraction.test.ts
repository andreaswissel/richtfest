import { expect, test } from "bun:test";
import { assembleExteriorNoiseInputs, reconcileExteriorNoiseInputs, validateExteriorNoiseExtraction } from "./acoustic-extraction";
import { exteriorNoiseFixture } from "../../../tests/fixtures/exterior-noise";
import { exteriorNoisePackets } from "../../../tests/fixtures/exterior-noise-packets";
import { calculateAcoustics } from "../../acoustics/src/calculations";
import { acousticInputProvenance, scopedExteriorNoiseExtractionSchema, exteriorNoiseExtractionSchema } from "@richtfest/shared";
import { sanitizeProviderDiagnostics } from "./deps";
import { z } from "zod";

test("quotation validation accepts exact adjacent fragments but never bridges gaps or source versions", () => {
  const versionId = crypto.randomUUID();
  const left = "Room 56: wall area ", right = "4.85 m²; Rw 55.3 dB.";
  const end = Buffer.byteLength(left), totalBytes = end + Buffer.byteLength(right);
  const sources = [
    { versionId, text: left, textRange: { startByte: 0, endByte: end, totalBytes } },
    { versionId, text: right, textRange: { startByte: end, endByte: totalBytes, totalBytes } },
  ];
  const packet = { inventory: [{ roomId: "56", provenance: { kind: "source" as const, versionId, page: 67,
    excerpt: left + right } }], rooms: [], facts: [], blockers: [] };
  expect(validateExteriorNoiseExtraction(packet, sources)).toEqual(packet);
  expect(() => validateExteriorNoiseExtraction(packet, [sources[0]!, { ...sources[1]!, versionId: crypto.randomUUID() }])).toThrow("exact quotations");
  expect(() => validateExteriorNoiseExtraction(packet, [sources[0]!, { ...sources[1]!, textRange: { startByte: end + 1, endByte: totalBytes + 1, totalBytes: totalBytes + 1 } }])).toThrow("exact quotations");
  expect(() => validateExteriorNoiseExtraction(packet, sources.map(({ textRange, ...s }) => s))).toThrow("exact quotations");
  expect(() => validateExteriorNoiseExtraction({ ...packet, inventory: [{ ...packet.inventory[0]!,
    provenance: { ...packet.inventory[0]!.provenance, excerpt: "Room 56: wall area 9 m²" } }] }, sources)).toThrow("exact quotations");
});

test("OCR whitespace recovery retains the literal source quote, not a rewritten or ambiguous claim", () => {
  const versionId = crypto.randomUUID();
  const literal = "FE(1)   area\t3.47 m²;\nRw 30 dB";
  const quote = "FE(1) area 3.47 m²; Rw 30 dB";
  const packet = { inventory: [{ roomId: "1", provenance: { kind: "source" as const, versionId, page: 29, excerpt: quote } }],
    rooms: [], facts: [], blockers: [] };
  const result = validateExteriorNoiseExtraction(packet, [{ versionId, text: literal }]);
  expect(result.inventory[0]!.provenance).toEqual({ ...packet.inventory[0]!.provenance, excerpt: literal });
  expect(packet.inventory[0]!.provenance.excerpt).toBe(quote);
  for (const text of [literal.replace("3.47", "34.7"), literal.replace(";", ","), literal.replace("m²", "m"),
    literal.replace("FE(1)", "FE1"), literal + "\n" + literal.replace("\t", "  ")]) {
    expect(() => validateExteriorNoiseExtraction(packet, [{ versionId, text }])).toThrow("exact quotations");
  }
});

test("extraction repair distinguishes source, quotation and inventory failures without exposing rejected values", () => {
  const base = exteriorNoisePackets()[0]!;
  const p = base.inventory[0]!.provenance;
  const sources = [{ versionId: p.versionId, text: p.excerpt }];
  for (const [reason, path, mutate] of [
    ["source_not_in_packet", ["inventory", 0, "provenance", "versionId"], (v: typeof base) => { v.inventory[0]!.provenance = { ...p, versionId: crypto.randomUUID() }; }],
    ["quote_not_in_source", ["inventory", 0, "provenance", "excerpt"], (v: typeof base) => { v.inventory[0]!.provenance = { ...p, excerpt: "PRIVATE_REJECTED_QUOTE" }; }],
    ["duplicate_room", ["inventory", 1, "roomId"], (v: typeof base) => { v.inventory.push(structuredClone(v.inventory[0]!)); }],
    ["room_not_declared", ["facts", 0, "roomId"], (v: typeof base) => { v.facts[0]!.roomId = "UNKNOWN"; v.facts[0]!.id = "UNKNOWN"; }],
  ] as const) {
    const packet = structuredClone(base);
    mutate(packet);
    let error: unknown;
    try { validateExteriorNoiseExtraction(packet, sources); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(z.ZodError);
    const safe = sanitizeProviderDiagnostics({ issues: (error as z.ZodError).issues });
    expect(safe.issues).toEqual([{ code: "custom", path: ["exteriorNoiseExtraction", ...path], acoustic: reason }]);
    expect(sanitizeProviderDiagnostics(safe)).toEqual(safe);
    expect(JSON.stringify(safe)).not.toContain("PRIVATE_REJECTED_QUOTE");
  }
  expect(validateExteriorNoiseExtraction(base, sources)).toEqual(base);
  expect(sanitizeProviderDiagnostics({ issues: [{ code: "custom", path: ["exteriorNoiseExtraction"], params: { acoustic: "PRIVATE_REJECTED_QUOTE" } }] }))
    .toEqual({ issues: [{ code: "custom", path: ["exteriorNoiseExtraction"] }] });
});

test("packet source contract constrains every provenance without losing fact validation", () => {
  const packet = exteriorNoisePackets()[0]!;
  const p = packet.inventory[0]!.provenance;
  const schema = scopedExteriorNoiseExtractionSchema([p.versionId]);
  expect(schema.safeParse(packet).success).toBe(true);
  expect(scopedExteriorNoiseExtractionSchema([]).safeParse(packet).success).toBe(false);
  expect(scopedExteriorNoiseExtractionSchema([]).safeParse({ inventory: [], rooms: [], facts: [], blockers: [] }).success).toBe(true);
  for (const field of ["id", "value"] as const) {
    const bad = structuredClone(packet);
    if (field === "id") bad.facts[1]!.id = "NOT_THE_ROOM";
    else bad.facts[1]!.value = -1;
    expect(schema.safeParse(bad).success).toBe(false);
  }
  const { method, ...room } = exteriorNoiseFixture();
  room.fieldEvidence = [{ field: "room.floorAreaM2", provenance: { ...p } }];
  for (const record of [room.room, room.applicability, room.flanking, ...room.facades, ...room.facades.map(f => f.noise), ...room.elements])
    record.provenance = { ...p };
  const full = { inventory: [{ roomId: room.room.id, provenance: p }], rooms: [room], facts: [], blockers: [] };
  expect(schema.safeParse(full).success).toBe(true);
  for (const versionId of ["Q1", "20000000-0000-4000-8000-000000000002"]) {
    const bad = structuredClone(full);
    // Each record is checked separately, including nested noise and element provenance.
    for (const value of acousticInputProvenance({ ...bad.rooms[0]!, method })) {
      const previous = { ...value };
      Object.assign(value, { versionId });
      expect(schema.safeParse(bad).success).toBe(false);
      Object.assign(value, previous);
    }
  }
});

test("extracted room inputs require scoped quotations, not assumptions or reference answers", () => {
  const { method, ...room } = exteriorNoiseFixture();
  const provenance = { kind: "source" as const, versionId: crypto.randomUUID(), page: 3, excerpt: "Synthetic room schedule" };
  const packet = { inventory: [{ roomId: room.room.id, provenance }], rooms: [room], blockers: [] };
  const sources = [{ versionId: provenance.versionId, text: provenance.excerpt }];
  expect(() => validateExteriorNoiseExtraction(packet, sources)).toThrow("exact quotations");
  for (const record of [room.room, room.applicability, room.flanking, ...room.facades, ...room.facades.map(f => f.noise), ...room.elements])
    record.provenance = provenance;
  expect(validateExteriorNoiseExtraction(packet, sources)).toEqual(packet);
  expect(() => validateExteriorNoiseExtraction(packet, [{ ...sources[0]!, versionId: crypto.randomUUID() }])).toThrow("exact quotations");
  expect(() => validateExteriorNoiseExtraction(packet, [{ ...sources[0]!, text: "Different evidence" }])).toThrow("exact quotations");
  expect(() => validateExteriorNoiseExtraction({ ...packet, inventory: [] }, sources)).toThrow("declared inventory");
});

test("reconciliation retains missing rooms and blocks conflicts regardless of packet order", () => {
  const { method, ...room } = exteriorNoiseFixture();
  const packet = { inventory: [{ roomId: room.room.id, provenance: room.room.provenance },
    { roomId: "Other room", provenance: room.room.provenance }], rooms: [room], blockers: [] };
  const identical = assembleExteriorNoiseInputs([packet, structuredClone(packet)]);
  expect(identical.input?.inventory).toHaveLength(2);
  expect(identical.input?.rooms).toHaveLength(1);
  expect(identical.blockers.join(" ")).toContain("Other room");
  const conflicting = structuredClone(packet);
  conflicting.rooms[0]!.room.floorAreaM2 += 3;
  for (const packets of [[packet, conflicting, packet], [conflicting, packet]]) {
    const result = assembleExteriorNoiseInputs(packets);
    expect(result.input?.rooms).toHaveLength(0);
    expect(result.input?.inventory).toHaveLength(2);
    expect(result.blockers.join(" ")).toContain("conflicting extracted inputs");
  }
  expect(assembleExteriorNoiseInputs([])).toMatchObject({ input: null, blockers: [expect.stringContaining("coverage is unknown")] });
});

test("v2 combines complementary evidence, retains corroboration and never rounds away conflicts", () => {
  const packets = exteriorNoisePackets();
  const duplicate = structuredClone(packets[0]!);
  for (const fact of duplicate.facts) fact.provenance = { kind: "source", versionId: crypto.randomUUID(), page: 5, excerpt: "Independent schedule" };
  const expectedRw = -10 * Math.log10((8 * 10 ** -5 + 2 * 10 ** -3.5) / 10);
  for (const input of [packets, [...packets].reverse(), [...packets, duplicate]]) {
    const result = reconcileExteriorNoiseInputs(input);
    expect(result.blockers).toEqual([]);
    expect(result.input?.rooms).toHaveLength(1);
    const calculated = calculateAcoustics(result.input!);
    expect(calculated.batch?.rooms[0]?.result?.value).toBeCloseTo(expectedRw, 8);
    expect(result.fields.find(f => f.field === "floorAreaM2")?.value).toBe(20);
  }
  const merged = reconcileExteriorNoiseInputs([...packets, duplicate]);
  expect(merged.fields.find(f => f.field === "floorAreaM2")?.candidates).toHaveLength(2);
  expect(merged.input?.rooms[0]?.fieldEvidence?.filter(e => e.field.endsWith("floorAreaM2"))).toHaveLength(2);
  duplicate.facts.find(f => f.field === "floorAreaM2")!.value = 20.001;
  for (const input of [[...packets, duplicate], [duplicate, ...packets]]) {
    const result = reconcileExteriorNoiseInputs(input);
    expect(result.input?.rooms).toHaveLength(0);
    expect(result.fields.find(f => f.field === "floorAreaM2")?.status).toBe("conflict");
    expect(result.fields.filter(f => f.status === "conflict")).toHaveLength(1);
  }
});

test("v2 retains undeclared coverage gaps, missing areas and false/zero values without fabrication", () => {
  const packets = exteriorNoisePackets();
  packets[0]!.inventory.push({ roomId: "A02", provenance: packets[0]!.inventory[0]!.provenance });
  packets[1]!.facts = packets[1]!.facts.filter(f => !(f.id === "FE1" && f.field === "areaM2"));
  const missing = reconcileExteriorNoiseInputs(packets);
  expect(missing.input?.inventory.map(r => r.roomId)).toEqual(["A01", "A02"]);
  expect(missing.input?.rooms).toHaveLength(0);
  expect(missing.fields.find(f => f.id === "FE1" && f.field === "areaM2")?.status).toBe("missing");
  expect(missing.blockers.join(" ")).toContain("A02");
  const clean = exteriorNoisePackets();
  clean[0]!.facts.find(f => f.field === "envelopeComplete")!.value = false;
  clean[0]!.facts.find(f => f.field === "levelDb")!.value = 0;
  const result = reconcileExteriorNoiseInputs(clean);
  expect(result.input?.rooms[0]?.envelopeComplete).toBe(false);
  expect(result.input?.rooms[0]?.facades[0]?.noise.levelDb).toBe(0);
  expect(calculateAcoustics(result.input!).batch?.rooms[0]?.status).toBe("unsupported");
  const packet = clean[0]!;
  const p = packet.inventory[0]!.provenance;
  expect(() => validateExteriorNoiseExtraction(packet, [{ versionId: p.versionId, text: p.excerpt }])).not.toThrow();
  packet.facts[0]!.provenance = { kind: "assumption", reason: "No source" };
  expect(() => validateExteriorNoiseExtraction(packet, [{ versionId: p.versionId, text: p.excerpt }])).toThrow("exact quotations");
});

test("project reconciliation retains rooms beyond a single extraction packet's capacity", () => {
  const p = exteriorNoisePackets()[0]!.inventory[0]!.provenance;
  const inventory = Array.from({ length: 159 }, (_, i) => ({ roomId: `Room ${i + 1}`, provenance: p }));
  const packets = [inventory.slice(0, 100), inventory.slice(100)].map(inventory => ({ inventory, rooms: [], facts: [], blockers: [] }));
  for (const packet of packets) expect(exteriorNoiseExtractionSchema.safeParse(packet).success).toBe(true);
  expect(exteriorNoiseExtractionSchema.safeParse({ ...packets[0], inventory }).success).toBe(false);
  const assembled = reconcileExteriorNoiseInputs(packets);
  expect(assembled.input?.inventory).toHaveLength(159);
  const result = calculateAcoustics(assembled.input!);
  expect(result.batch?.complete).toBe(false);
  expect(new Set(result.batch?.rooms.map(r => r.roomId))).toEqual(new Set(inventory.map(r => r.roomId)));
  expect(result.batch?.rooms.every(r => r.status === "missing_input" && r.result === null)).toBe(true);
});
