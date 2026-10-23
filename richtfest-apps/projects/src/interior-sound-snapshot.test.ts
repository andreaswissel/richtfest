import { describe, expect, test } from "bun:test";
import type { AirborneInput, ImpactInput, InteriorSoundProof, Point2 } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { assembleInteriorSoundSnapshot, type InteriorSoundSnapshotInput } from "./interior-sound-proof";

const rect = (x0: number, y0: number, x1: number, y1: number): Point2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const property = (entityId: string, propertyKey: string, value: unknown, patch: Partial<InteriorSoundSnapshotInput["values"][number]> = {}) =>
  ({ entityId, propertyKey, value, reviewStatus: "unreviewed", provenance: "manual", propertyId: `${entityId}-${propertyKey}`, version: 1, reviewRevision: 0, ...patch });

// Independent storey heights, masses, room areas and page origins. Values are test inputs, not norm defaults.
function snapshot(): InteriorSoundSnapshotInput {
  const result: InteriorSoundSnapshotInput = { model: { revision: 17 }, buildingId: "building", pages: [], rooms: [], elements: [], storeys: [], relationships: [], values: [], levels: [] };
  for (const [index, id] of ["L", "U"].entries()) {
    const dx = index * 12, dy = index * 7;
    const shift = ([x, y]: Point2): Point2 => [x + dx, y + dy];
    const normalized = (ring: Point2[]) => ring.map(shift).map(([x, y]) => ({ x: x / 20, y: y / 10 }));
    const walls = [
      { id: `${id}W`, name: `${id}W`, ring: rect(4, -0.3, 4.2, 5.3).map(shift), exterior: false },
      { id: `${id}N`, name: `${id}N`, ring: rect(-0.3, -0.3, 8.3, 0).map(shift), exterior: true },
      { id: `${id}S`, name: `${id}S`, ring: rect(-0.3, 5, 8.3, 5.3).map(shift), exterior: true },
    ];
    result.storeys.push({ id, name: id, buildingId: "building" });
    result.levels.push({ storeyId: id, level: index });
    result.pages.push({ storey: { id, name: id, levelIndex: index }, sourceVersionId: `source-${id}`, page: index + 1, fileName: `${id}.pdf`,
      scale: { pageAspectRatio: 2, metresPerPageHeight: 10, denominator: 100 }, walls });
    result.values.push(property(id, "clearRoomHeight", index ? 3 : 2.5));
    for (const wall of walls) {
      result.elements.push({ id: wall.id, name: wall.name, storeyId: id, kind: "draft_wall" });
      result.values.push(...Object.entries({ construction: "masonry", material: "Kalksandstein", thickness: index ? 15 : 20, bulkDensity: 2000,
        wallRole: wall.exterior ? "exterior" : "apartment_partition" }).map(([key, value]) => property(wall.id, key, value)));
    }
    result.elements.push({ id: `${id}C`, name: `${id}C`, storeyId: id, kind: "draft_ceiling" });
    result.values.push(...Object.entries({ construction: "concrete", material: "Stahlbeton", thickness: index ? 25 : 20, bulkDensity: 2400,
      ceilingRole: "apartment_separating", screedType: "mortar", screedMass: 90, screedStiffness: 20 }).map(([key, value]) => property(`${id}C`, key, value)));
    for (const [suffix, ring] of [["A", rect(0, 0, 4, 5)], ["B", rect(4.2, 0, index ? 7.8 : 8, 5)]] as const) {
      const roomId = `${id}${suffix}`;
      result.rooms.push({ id: roomId, name: roomId, storeyId: id, geometry: {
        source: { sourceVersionId: `source-${id}`, page: index + 1 }, polygon: normalized(ring),
        holes: index && suffix === "A" ? [normalized(rect(1, 1, 2, 2))] : [],
      } });
      result.relationships.push(...walls.map(wall => ({ relationshipType: "separates", fromEntityId: wall.id, toEntityId: roomId, reviewStatus: "approved" })),
        { relationshipType: "covers", fromEntityId: `${id}C`, toEntityId: roomId, reviewStatus: "approved" });
    }
  }
  result.relationships.push({ relationshipType: "under_storey", fromEntityId: "LC", toEntityId: "U", reviewStatus: "approved" });
  return result;
}

function harness() {
  const airborne: AirborneInput[] = [], impact: ImpactInput[] = [];
  const unsupported = () => ({ status: "unsupported" as const, reason: "method_missing" as const });
  const host: NonNullable<AppDeps["interiorSound"]> = {
    editions: { requirements: "test", method: "test", junctions: "test", screeds: "test", catalogue: "test" },
    requirements: level => level === "elevated" ? null : ({ level, edition: "test-requirements",
      wall: () => ({ rwMinDb: 53, ref: "test wall" }), ceiling: () => ({ rwMinDb: 54, lnwMaxDb: 50, ref: "test ceiling" }),
      door: () => ({ rwMinDb: 27, ref: "test door" }), wallWithDoor: () => null, stairs: null, hallwayFloor: null, service: () => null }),
    massiveRw: request => request.thicknessCm === null || request.densityKgM3 === null ? { status: "unavailable", reason: "thickness_missing" } : ({
      status: "calculated", massKgM2: request.thicknessCm * request.densityKgM3 / 100, rwDb: request.thicknessCm + 30,
      wallDensityKgM3: request.densityKgM3, refs: ["test"], edition: "test", assumptions: [],
    }),
    airborne: request => { airborne.push(request); return unsupported(); },
    impact: request => { impact.push(request); return unsupported(); },
    crossJunctionOffsetM: 0.5, lining: () => ({ f0Hz: null, deltaRwDb: null, reason: "method_missing" }),
    impactOther: unsupported, stair: unsupported, timberImpact: unsupported, service: unsupported,
    lightweightOptions: () => [], lightweightRow: () => null,
  };
  const run = (input: InteriorSoundSnapshotInput): Extract<InteriorSoundProof, { available: true }> => {
    const proof = assembleInteriorSoundSnapshot(input, host);
    if (!proof.available) throw new Error(proof.reason);
    return proof;
  };
  return { host, airborne, impact, run };
}

describe("source-pinned interior sound snapshot", () => {
  test("maps two asymmetric storeys, normalized geometry and distinct flanking masses without mutating JSON input", () => {
    const data = snapshot(), before = JSON.stringify(data), { run, airborne, impact } = harness();
    const proof = run(JSON.parse(before));
    expect(proof.modelRevision).toBe(17);
    expect(proof.buildingId).toBe("building");
    expect(proof.suggestions).toEqual([]);
    expect(proof.storeys.map(storey => [storey.id, storey.sourceVersionId, storey.page])).toEqual([["L", "source-L", 1], ["U", "source-U", 2]]);
    expect(proof.walls.map(wall => wall.areaM2)).toEqual([12.5, 15]);
    expect(proof.ceilings.map(ceiling => ceiling.areaM2)).toEqual([20, 19, 19, 18]);
    expect(airborne).toHaveLength(6);
    expect(impact.map(request => request.slabMassKgM2)).toEqual([480, 480, 600, 600]);
    const lowerCeiling = airborne.find(request => request.transmission === "vertical" && request.separating.id === "LC")!;
    expect(lowerCeiling.edges.map(edge => [edge.source.id, edge.receiving.id])).toEqual([["UW", "LW"], ["UN", "LN"], ["US", "LS"]]);
    expect(lowerCeiling.edges[1]!.source).toMatchObject({ massKgM2: 300, areaM2: 10 });
    expect(lowerCeiling.edges[1]!.receiving).toMatchObject({ massKgM2: 400, areaM2: 10 });
    expect(proof.limitations).toEqual(["junction_types", "doors_not_checked", "floor_like_ceiling", "walls_above_like_below", "impact_hallways_only"]);
    expect(run(data)).toEqual(proof);
    expect(JSON.stringify(data)).toBe(before);
  });

  test("room geometry is isolated by both source revision and page, and demolished rooms stay excluded", () => {
    const data = snapshot(), baseline = harness().run(data);
    for (const [id, source, constructionState] of [
      ["old", { sourceVersionId: "old-source", page: 1 }, "existing"],
      ["other-page", { sourceVersionId: "source-L", page: 9 }, "existing"],
      ["gone", { sourceVersionId: "source-L", page: 1 }, "demolished"],
    ] as const) {
      data.rooms.push({ ...data.rooms[0], id, constructionState, geometry: { ...data.rooms[0].geometry, source } });
      data.relationships.push(...data.relationships.filter(row => row.toEntityId === "LA").map(row => ({ ...row, toEntityId: id })));
      data.values.push(property(id, "clearRoomHeight", 19));
    }
    expect(harness().run(data)).toEqual(baseline);
  });

  test("missing, unknown-level, other-building and ambiguous neighbour pages never supply upper flanking elements", () => {
    for (const variant of ["missing", "unknown-level", "other-building", "missing-building", "no-outline", "outline-mismatch", "same-storey-pages", "same-storey-revisions", "two-storeys"] as const) {
      const data = snapshot();
      if (variant === "missing") data.pages.pop();
      if (variant === "unknown-level") data.levels[1]!.level = null;
      if (variant === "other-building") data.storeys[1].buildingId = "other-building";
      if (variant === "missing-building") delete data.storeys[1].buildingId;
      if (variant === "no-outline") data.pages[1]!.walls = data.pages[1]!.walls.map(wall => ({ ...wall, exterior: false }));
      if (variant === "outline-mismatch") data.pages[1]!.walls = data.pages[1]!.walls.map(wall => ({ ...wall, ring: wall.ring.map(([x, y]) => [x * 3, y * 3]) }));
      if (variant === "same-storey-pages") data.pages.push({ ...data.pages[1]!, page: 8 });
      if (variant === "same-storey-revisions") data.pages.push({ ...data.pages[1]!, sourceVersionId: "other-revision" });
      if (variant === "two-storeys") {
        data.storeys.push({ id: "U2", name: "U2", buildingId: "building" });
        data.levels.push({ storeyId: "U2", level: 1 });
        data.pages.push({ ...data.pages[1]!, storey: { id: "U2", name: "U2", levelIndex: 1 } });
      }
      const { run, airborne } = harness(), proof = run(data);
      const lower = airborne.filter(request => request.transmission === "vertical" && request.separating.id === "LC");
      expect(lower).toHaveLength(2);
      expect(lower.every(request => request.edges.every(edge => edge.source.id === edge.receiving.id))).toBe(true);
      expect(proof.limitations).toContain("walls_above_like_below");
      const reversed = harness();
      reversed.run({ ...data, pages: [...data.pages].reverse() });
      expect(reversed.airborne.filter(request => request.transmission === "vertical" && request.separating.id === "LC")).toEqual(lower);
    }
  });

  test("missing height or construction stays incomplete; missing plans and requirements stay unavailable", () => {
    const data = snapshot(), { host } = harness();
    expect(assembleInteriorSoundSnapshot({ ...data, pages: [] }, host)).toEqual({ available: false, reason: "plan_missing" });
    expect(assembleInteriorSoundSnapshot(data, { ...host, requirements: () => null })).toEqual({ available: false, reason: "norm_pack_missing" });
    data.values = data.values.filter(value => value.entityId !== "LW" || !["construction", "material"].includes(value.propertyKey));
    data.values = data.values.filter(value => value.propertyKey !== "clearRoomHeight");
    const { run, airborne, impact } = harness(), proof = run(data);
    expect(proof.walls[0]!.gaps).toContainEqual({ code: "element", elementId: "LW", elementName: "LW", reason: "construction_missing" });
    expect(proof.walls.every(wall => wall.areaM2 === null && wall.result === null)).toBe(true);
    expect(proof.ceilings.every(ceiling => ceiling.gaps.some(gap => gap.code === "clear_height"))).toBe(true);
    expect(airborne).toEqual([]);
    expect(impact).toEqual([]);
  });

  test("inferred storey heights enter calculations only after approval, without substituting a default", () => {
    for (const reviewStatus of ["unreviewed", "rejected", "superseded", "approved"]) {
      const data = snapshot();
      data.values = data.values.map(value => value.propertyKey === "clearRoomHeight" ? { ...value, provenance: "inferred", reviewStatus } : value);
      const { run, airborne, impact } = harness(), proof = run(data);
      expect(airborne.length).toBe(reviewStatus === "approved" ? 6 : 0);
      expect(impact.length).toBe(reviewStatus === "approved" ? 4 : 0);
      expect(proof.storeys[0]!.clearHeight).toMatchObject({ value: 2.5, provenance: "inferred", reviewStatus });
      expect(proof.walls[0]!.areaM2).toBe(reviewStatus === "approved" ? 12.5 : null);
    }
  });

  test("an unreviewed room override cannot fall back to the storey; uniform reviewed room overrides can", () => {
    for (const reviewStatus of ["unreviewed", "approved", "rejected"]) {
      const data = snapshot();
      data.values.push(property("LA", "clearRoomHeight", 3.2, { provenance: "inferred", reviewStatus }),
        property("LB", "clearRoomHeight", 3.2, { provenance: "inferred", reviewStatus }));
      const proof = harness().run(data);
      expect(proof.walls[0]!.areaM2).toBe(reviewStatus === "approved" ? 16 : reviewStatus === "rejected" ? 12.5 : null);
    }
    const unequal = snapshot();
    unequal.values.push(property("LA", "clearRoomHeight", 3.2));
    expect(harness().run(unequal).walls[0]!.gaps).toContainEqual({ code: "clear_height" });
  });

  test("rejected and superseded relationships cannot silently restore adjacency or ceiling coverage", () => {
    for (const reviewStatus of ["rejected", "superseded"]) {
      const data = snapshot();
      data.relationships = data.relationships.map(row => ({ ...row, reviewStatus }));
      const proof = harness().run(data);
      expect(proof.walls).toEqual([]);
      expect(proof.ceilings).toEqual([]);
      expect(proof.places.every(place => !place.walls.length)).toBe(true);
    }
  });

  test("an unsupported elevated requirement retains the explicit minimum-only limitation", () => {
    const data = snapshot();
    data.values.push(property("building", "soundInsulationLevel", "elevated"));
    const proof = harness().run(data);
    expect(proof.level).toBe("elevated");
    expect(proof.requirementLevel).toBe("statutory_minimum");
    expect(proof.limitations).toContain("minimum_requirements_only");
  });

  test("doors, stairs and installations keep their property metadata and opening hosts through the snapshot adapter", () => {
    const data = snapshot();
    data.elements.push({ id: "D", name: "Door", kind: "door", storeyId: "L", roomId: "LA" },
      { id: "T", name: "Stair", kind: "stair", storeyId: "L", roomId: "LA" },
      { id: "I", name: "Service", kind: "installation", storeyId: "L", roomId: "LA" });
    data.relationships.push(...["D", "I"].map(id => ({ relationshipType: "opening_in", fromEntityId: id, toEntityId: "LW", reviewStatus: "approved" })));
    data.values.push(property("D", "doorRole", "to_dwelling_hallway"), property("D", "soundReductionIndex", 32, { version: 4, reviewRevision: 2, reviewStatus: "approved" }),
      property("T", "stairCase", "landing_rigid"), property("I", "installationKind", "sanitary"), property("I", "installationProof", "reference_wall"));
    const proof = harness().run(data);
    expect(proof.doors[0]).toMatchObject({ id: "D", wall: { id: "LW" }, room: { id: "LA" },
      rw: { value: 32, propertyId: "D-soundReductionIndex", version: 4, reviewRevision: 2, reviewStatus: "approved", provenance: "manual" } });
    expect(proof.stairs[0]).toMatchObject({ stair: { id: "T" }, stairCase: { value: "landing_rigid" } });
    expect(proof.services[0]).toMatchObject({ id: "I", wall: { id: "LW" }, room: { id: "LA" }, kind: { value: "sanitary" } });
    expect(proof.limitations).toContain("stairs_room_behind_wall");
    expect(proof.limitations).toContain("services_execution");
  });
});
