import { expect, test } from "bun:test";
import { assembleExteriorNoiseInputs, validateExteriorNoiseExtraction } from "./acoustic-extraction";
import { exteriorNoiseFixture } from "../../../tests/fixtures/exterior-noise";

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
