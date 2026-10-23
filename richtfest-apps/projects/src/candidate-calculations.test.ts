import { expect, test } from "bun:test";
import { calculateCandidates } from "./candidate-calculations";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { sourceVersionId: id(1), page: 2, storeyId: id(2) };
const rect = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
function fixture(): Parameters<typeof calculateCandidates>[0] {
  return { model: { id: id(3), revision: 7 }, buildings: [{ id: id(4) }], storeys: [{ id: id(2), buildingId: id(4), levelIndex: 0 }],
    rooms: [], elements: [], properties: [], relationships: [], conflicts: [], planSources: [{ ...scope, alignmentStatus: "reviewed" }],
    extractions: [{ ...scope, id: id(5), extractorVersion: "test", status: "complete", updatedAt: "2026-10-23",
      result: { pageScale: { pageAspectRatio: 2, metresPerPageHeight: 10 }, scaleObservation: { status: "confirmed" } } }],
    extractionCandidates: [
      { id: id(6), jobId: id(5), entityType: "room", sourceKey: "same-key-on-another-page", name: "Living", status: "unreviewed",
        geometry: { quality: "enclosed_region", polygon: rect(.1, .1, .2, .4), holes: [rect(.12, .12, .02, .03)], groupLabel: "WE1" }, evidence: [{ ...scope }] },
      { id: id(7), jobId: id(5), entityType: "room", sourceKey: "room-two", name: "Sleeping", status: "unreviewed",
        geometry: { quality: "enclosed_region", polygon: rect(.31, .1, .3, .4), groupLabel: "WE2" }, evidence: [{ ...scope }] },
      { id: id(8), jobId: id(5), entityType: "element", sourceKey: "wall", name: "Partition", status: "unreviewed",
        geometry: { quality: "draft_wall", polygon: rect(.3, .1, .01, .4) }, evidence: [{ ...scope }] },
      { id: id(9), jobId: id(10), entityType: "room", sourceKey: "same-key-on-another-page", name: "Wrong page", status: "unreviewed",
        geometry: { quality: "enclosed_region", polygon: rect(.7, .7, .1, .1) } },
      { id: id(11), jobId: id(5), entityType: "room", sourceKey: "anchor", name: "Unresolved", status: "unreviewed",
        geometry: { quality: "anchor", polygon: rect(.7, .7, .1, .1) } },
    ],
  };
}

test("candidate calculations are page-scoped, source-linked, non-mutating and do not invent heights or approve geometry", () => {
  const data = fixture(), before = structuredClone(data);
  const result = calculateCandidates(data, scope);
  expect(result.geometry.map(r => r.id)).toEqual([id(6), id(7)]);
  // 4 × 4 m minus a 0.4 × 0.3 m hole, independently from the shoelace implementation.
  expect(result.geometry[0]!.areaM2).toBeCloseTo(15.88);
  expect(result.geometry[1]!.areaM2).toBeCloseTo(24);
  expect(result.geometry.every(r => r.clearHeight === null)).toBe(true);
  expect(result.geometry.every(r => r.adjacentWallIds.includes(id(8)))).toBe(true);
  expect(result.excluded).toContainEqual({ id: id(11), reason: "unresolved_geometry" });
  expect(result.fire.snapshot.available && result.fire.snapshot.plan.storeys[0]!.geometryReviewed).toBe(false);
  expect(result.reviewStatus).toBe("unreviewed");
  expect(result.fire.assessment?.classification.buildingClass).toBeNull();
  expect(result.exterior.batch?.inventory.map(room => room.roomId)).toEqual(["Living"]);
  expect(result.exterior.batch?.rooms).toEqual([]);
  expect(result.exterior.rooms[0]!.gaps).toContain("clear_height");
  expect(data).toEqual(before);
  expect(calculateCandidates(data, scope).inputHash).toBe(result.inputHash);
  expect(() => calculateCandidates(data, { ...scope, page: 3 })).toThrow("active plan page");
  data.extractions[0].status = "running";
  expect(() => calculateCandidates(data, scope)).toThrow("must complete");
});

test("candidate previews retain accepted identities and rejected connections/properties without resurrection", () => {
  const data = fixture();
  const candidate = data.extractionCandidates[0];
  data.rooms.push({ id: id(12), storeyId: scope.storeyId, stableKey: `extraction:${candidate.id}`, name: "Accepted name",
    geometry: { ...candidate.geometry, source: scope } });
  candidate.match = { existingId: id(12) };
  // The wall's right-hand face (side 0) borders the second room in this fixture.
  data.relationships.push({ fromEntityId: id(8), toEntityId: id(7), relationshipType: "separates", reviewStatus: "rejected", metadata: { side: 0 } });
  data.properties.push({ entityId: id(7), propertyKey: "apartmentUnit", reviewed: null,
    current: { value: "Wrong", reviewStatus: "rejected", provenance: "inferred" } });
  const result = calculateCandidates(data, scope);
  expect(result.geometry.map(r => r.id)).toEqual([id(12), id(7)]);
  expect(result.candidates.some(c => c.id === id(6))).toBe(false);
  expect(result.geometry.find(r => r.id === id(7))!.adjacentWallIds).toEqual([]);
  expect(result.properties.filter(p => p.entityId === id(7) && p.propertyKey === "apartmentUnit")).toHaveLength(1);
  expect(result.properties.find(p => p.entityId === id(7) && p.propertyKey === "apartmentUnit").current.reviewStatus).toBe("rejected");
  expect(result.fire.snapshot.available && result.fire.snapshot.plan.storeys[0]!.rooms.find(r => r.id === id(7))!.unit).toBeNull();
});

test("candidate acoustic inputs retain source proposals and available heights/openings, without approving or substituting printed areas", () => {
  const data = fixture();
  data.extractionCandidates[0].name = "Wo.- Es.- Ko. / Diele";
  data.extractionCandidates[0].geometry.printedArea = { value: 17.2, quote: "17.20 m²", status: "unreviewed" };
  data.elements.push({ id: id(20), name: "Facade", kind: "draft_wall", storeyId: scope.storeyId,
    geometry: { source: scope, polygon: rect(.1, .09, .2, .01) } },
  { id: id(21), name: "Window", kind: "window", roomId: id(6), storeyId: scope.storeyId,
    geometry: { source: scope, polygon: rect(.14, .09, .05, .01) } });
  data.relationships.push({ fromEntityId: id(21), toEntityId: id(20), relationshipType: "opening_in", reviewStatus: "approved" });
  const add = (entityId: string, propertyKey: string, value: unknown, provenance = "manual") => data.properties.push({ entityId, propertyKey,
    current: { value, provenance, reviewStatus: "unreviewed", propertyId: `${entityId}:${propertyKey}`, version: 1, reviewRevision: 0 } });
  add(scope.storeyId, "clearRoomHeight", 2.8);
  add(id(21), "openingWidth", 1.1); add(id(21), "openingHeight", 1.4);
  add(id(21), "soundReductionIndex", 32);
  const before = structuredClone(data);
  const result = calculateCandidates(data, scope), room = result.exterior.rooms[0]!;
  expect(room.kind).toMatchObject({ value: "living", reviewStatus: "unreviewed", provenance: "inferred" });
  expect(room.clearHeight?.value).toBe(2.8);
  expect(room.facades.find(f => f.wallId === id(20))?.windows[0]).toMatchObject({ id: id(21), area: { value: 1.54 }, rw: { value: 32 } });
  expect(room.gaps).toContain("facade_level");
  expect(result.geometry[0]).toMatchObject({ areaM2: expect.closeTo(15.88), printedArea: { value: 17.2 } });
  expect(result.exterior.batch?.rooms).toEqual([]);
  expect(data).toEqual(before);
  // An inferred height must not become usable in interior calculations while exterior checks withhold it.
  data.properties[0].current.provenance = "inferred";
  const unreviewed = calculateCandidates(data, scope);
  expect(unreviewed.geometry[0]!.clearHeight).toBeNull();
  expect(unreviewed.exterior.rooms[0]!.gaps).toContain("clear_height");
  data.properties.push({ entityId: id(6), propertyKey: "exteriorNoiseRoom", current: { value: "living", reviewStatus: "rejected" } });
  expect(calculateCandidates(data, scope).exterior.rooms[0]!.kind).toBeNull();
});
