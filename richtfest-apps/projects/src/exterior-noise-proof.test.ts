import { describe, expect, test } from "bun:test";
import { exteriorNoiseAgentContext, proposeExteriorNoiseRoom, type Point2, type ProofValue } from "@richtfest/shared";
import { assembleExteriorNoiseProof, facadeLengths, overlapAlongWall, type ProofAssemblyInput } from "./exterior-noise-proof";

const value = <T,>(v: T, reviewStatus = "unreviewed"): ProofValue<T> => ({ value: v, reviewStatus, provenance: "manual", propertyId: "p", version: 1, reviewRevision: 0 });
// A 5 × 4 m room in the corner of two exterior walls: north (y = 0) and west (x = 0), 0.3 m thick.
const room: Point2[] = [[0.3, 0.3], [5.3, 0.3], [5.3, 4.3], [0.3, 4.3]];
const north = { id: "north", name: "N wall", ring: [[0, 0], [12, 0], [12, 0.3], [0, 0.3]] as Point2[] };
const west = { id: "west", name: "W wall", ring: [[0, 0], [0.3, 0], [0.3, 9], [0, 9]] as Point2[] };

const input = (patch: Partial<ProofAssemblyInput> = {}): ProofAssemblyInput => ({
  sourceLabel: "plan.pdf, p. 1", storeyId: "s", source: { versionId: "00000000-0000-4000-8000-000000000001", page: 1 },
  applicability: value("standard_exterior_noise"), flanking: value("negligible"), clearHeight: value(2.5),
  rooms: [{ id: "r1", name: "Schlafen", roomUse: null, polygon: room, holes: [], adjacentWallIds: new Set(["north", "west"]),
    kind: value("sleeping"), surfacesComplete: value(true) }],
  walls: [north, west].map(wall => ({ ...wall, construction: "masonry", rw: value(50), rwBasis: value("DIN 4109-32") })),
  levels: new Map([["north", { compass: "N" as const, dayDb: 62, sleepingDb: 66, basis: "calculated" as const }],
    ["west", { compass: "W" as const, dayDb: 58, sleepingDb: 61, basis: "turned_away" as const }]]),
  openings: [{ id: "w1", name: "Window 1", componentType: "window", roomId: "r1", wallId: "north", area: value(2), rw: value(37), basis: value("Test certificate") }],
  ...patch,
});

describe("facade geometry", () => {
  test("a room's extent along a wall is the overlap of both outlines on the wall axis", () => {
    expect(overlapAlongWall(room, north.ring)).toBeCloseTo(5, 9);
    expect(overlapAlongWall(room, west.ring)).toBeCloseTo(4, 9);
    // A wall only partly alongside the room counts only that part.
    expect(overlapAlongWall(room, [[3, 0], [9, 0], [9, 0.3], [3, 0.3]])).toBeCloseTo(2.3, 9);
  });

  test("without adjacency, only room edges on a wall count, and each edge goes to one wall", () => {
    const lengths = facadeLengths(room, [north, west]);
    expect(lengths.get("north")).toBeCloseTo(5, 9);
    expect(lengths.get("west")).toBeCloseTo(4, 9);
    expect(facadeLengths(room, [{ id: "far", ring: [[0, 20], [10, 20], [10, 20.3], [0, 20.3]] }]).size).toBe(0);
  });
});

describe("exterior noise proof assembly", () => {
  test("a complete sleeping room uses the sleeping La and splits each facade into wall and openings", () => {
    const { rooms, batch } = assembleExteriorNoiseProof(input());
    expect(rooms[0]!.gaps).toEqual([]);
    expect(rooms[0]!.floorAreaM2).toBe(20);
    const packet = batch!.rooms[0]!;
    expect(packet.room.use).toBe("residential_accommodation_classroom");
    expect(packet.facades.map(facade => [facade.areaM2, facade.noise.levelDb])).toEqual([[12.5, 66], [10, 61]]);
    const north = packet.elements.filter(element => element.facadeId.includes("N wall"));
    expect(north.map(element => element.kind === "area" && [element.areaM2, element.rwDb])).toEqual([[10.5, 50], [2, 37]]);
    // The calculator requires every facade area to be accounted for by its elements within 0.01 m².
    for (const facade of packet.facades) {
      const covered = packet.elements.filter(element => element.facadeId === facade.id).reduce((sum, element) => sum + (element.kind === "area" ? element.areaM2 : 0), 0);
      expect(Math.abs(covered - facade.areaM2)).toBeLessThanOrEqual(0.01);
    }
  });

  test("a living room uses the day La", () => {
    const { batch } = assembleExteriorNoiseProof(input({ rooms: [{ ...input().rooms[0]!, name: "Wohnen", kind: value("living") }] }));
    expect(batch!.rooms[0]!.facades.map(facade => facade.noise.levelDb)).toEqual([62, 58]);
  });

  test("missing inputs keep a room out of the calculation but in the inventory", () => {
    const { rooms, batch } = assembleExteriorNoiseProof(input({ clearHeight: null, flanking: value("required"),
      openings: [{ ...input().openings[0]!, rw: null }], rooms: [{ ...input().rooms[0]!, surfacesComplete: null }] }));
    expect(rooms[0]!.gaps.sort()).toEqual(["clear_height", "flanking", "surfaces_unconfirmed", "window_rw"]);
    expect(batch!.inventory).toHaveLength(1);
    expect(batch!.rooms).toHaveLength(0);
  });

  test("small elements count by Dn,e,w with their area per element; a roof takes the loudest La of the room", () => {
    const vent = { id: "v1", name: "Lüfter", componentType: "small_element" as const, roomId: "r1", wallId: "north", area: value(0.05), rw: null, basis: value("Datenblatt"),
      count: value(2), dnew: value(42) };
    const roof = { id: "d1", name: "Flachdach", roomId: "r1", construction: "concrete", area: value(20), rw: value(55), basis: value("DIN 4109-32") };
    const { rooms, batch } = assembleExteriorNoiseProof(input({ openings: [...input().openings, vent], roofs: [roof] }));
    expect(rooms[0]!.gaps).toEqual([]);
    const packet = batch!.rooms[0]!;
    // The sleeping room's loudest facade is the north one: La 66 for sleeping rooms.
    expect(packet.facades.at(-1)).toMatchObject({ id: "Dach · Flachdach", areaM2: 20, noise: { levelDb: 66 } });
    const north = packet.elements.filter(element => element.facadeId.includes("N wall"));
    expect(north.find(element => element.kind === "small")).toMatchObject({ dnEWDb: 42, count: 2, openingAreaM2: 0.05 });
    // Wall area = 12.5 m² facade − 2 m² window − 2 × 0.05 m² vents.
    expect(north.find(element => element.id.endsWith("Wand"))).toMatchObject({ areaM2: 10.4 });
    expect(packet.elements.find(element => element.id === "Dach · Flachdach")).toMatchObject({ kind: "area", areaM2: 20, rwDb: 55, construction: "massive" });
    for (const facade of packet.facades) {
      const covered = packet.elements.filter(element => element.facadeId === facade.id).reduce((sum, element) => sum + (element.kind === "area" ? element.areaM2 : element.openingAreaM2 * element.count), 0);
      expect(Math.abs(covered - facade.areaM2)).toBeLessThanOrEqual(0.01);
    }
    // Missing ratings are gaps: a vent without Dn,e,w, a roof without Rw or construction.
    const open = assembleExteriorNoiseProof(input({ openings: [{ ...vent, dnew: null }], roofs: [{ ...roof, rw: null, construction: null }] }));
    expect(open.rooms[0]!.gaps.sort()).toEqual(["roof_construction", "roof_rw", "small_element_dnew"]);
  });

  test("openings larger than the facade are reported, not silently clipped", () => {
    const { rooms } = assembleExteriorNoiseProof(input({ openings: [{ ...input().openings[0]!, area: value(14) }] }));
    expect(rooms[0]!.gaps).toContain("openings_exceed_facade");
  });

  test("rooms not needing protection are neither inventoried nor checked", () => {
    const { rooms, batch } = assembleExteriorNoiseProof(input({ rooms: [{ ...input().rooms[0]!, name: "Bad", kind: value("not_protected") }] }));
    expect(rooms[0]!.gaps).toEqual([]);
    expect(batch).toBeNull();
  });

  test("room kinds are proposed from names, living before kitchen and hall", () => {
    expect(proposeExteriorNoiseRoom("Wohnküche", null)).toBe("living");
    expect(proposeExteriorNoiseRoom("Küche", null)).toBe("not_protected");
    expect(proposeExteriorNoiseRoom("Kind 2", null)).toBe("sleeping");
    expect(proposeExteriorNoiseRoom("Raum 3", null)).toBeNull();
  });
});

describe("agent context", () => {
  test("marks unconfirmed inferred values as suggestions and uses the room's La period", () => {
    const { rooms } = assembleExteriorNoiseProof(input({ openings: [{ ...input().openings[0]!, rw: { ...value(37), provenance: "inferred" } }] }));
    const proof = { available: true as const, modelRevision: 3, buildingId: "b",
      storeys: [{ id: "s", name: "EG", levelIndex: 0, page: { sourceVersionId: "v", fileName: "plan.pdf", page: 1 }, clearHeight: value(2.5) }],
      applicability: value("standard_exterior_noise", "approved"), flanking: null, rooms, suggestions: [], calculation: null, levels: {} as any };
    const context = exteriorNoiseAgentContext(proof, "p");
    if (!context.available) throw new Error("expected available");
    expect(context.applicability).toEqual({ value: "standard_exterior_noise", status: "approved" });
    const north = context.rooms[0]!.facades.find(facade => facade.wallId === "north")!;
    expect(north.laDb).toBe(66);
    expect(north.openings[0]!.rwDb).toEqual({ value: 37, status: "suggested" });
    expect(north.rwDb).toEqual({ value: 50, status: "unreviewed" });
  });
});
