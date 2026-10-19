import { describe, expect, test } from "bun:test";
import { proposeExteriorNoiseRoom, type Point2, type ProofValue } from "@richtfest/shared";
import { assembleExteriorNoiseProof, facadeLengths, overlapAlongWall, type ProofAssemblyInput } from "./exterior-noise-proof";

const value = <T,>(v: T, reviewStatus = "unreviewed"): ProofValue<T> => ({ value: v, reviewStatus, provenance: "manual", propertyId: "p", version: 1 });
// A 5 × 4 m room in the corner of two exterior walls: north (y = 0) and west (x = 0), 0.3 m thick.
const room: Point2[] = [[0.3, 0.3], [5.3, 0.3], [5.3, 4.3], [0.3, 4.3]];
const north = { id: "north", name: "N wall", ring: [[0, 0], [12, 0], [12, 0.3], [0, 0.3]] as Point2[] };
const west = { id: "west", name: "W wall", ring: [[0, 0], [0.3, 0], [0.3, 9], [0, 9]] as Point2[] };

const input = (patch: Partial<ProofAssemblyInput> = {}): ProofAssemblyInput => ({
  sourceLabel: "plan.pdf, p. 1", source: { versionId: "00000000-0000-4000-8000-000000000001", page: 1 },
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
