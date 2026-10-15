import { expect, test } from "bun:test";
import { assembleExteriorNoiseInputs, reconcileExteriorNoiseInputs, validateExteriorNoiseExtraction } from "./acoustic-extraction";
import { exteriorNoiseFixture } from "../../../tests/fixtures/exterior-noise";
import { exteriorNoisePackets } from "../../../tests/fixtures/exterior-noise-packets";
import { calculateAcoustics } from "../../acoustics/src/calculations";

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
