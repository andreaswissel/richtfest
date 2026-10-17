import { expect, test } from "bun:test";
import { componentDataRequest, componentInputGaps, regulatoryBasisGaps, deriveWallRole, soundInsulationChecks, validateBuildingComponentProperty } from "@richtfest/shared";
import { planWallAdjacency, roomSpaceContext } from "./wall-adjacency";
import { planStoreyCeilings } from "./storey-ceilings";
import { planStoreyLevels, storeyLevelFromText } from "./storey-levels";

const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const source = { sourceVersionId: "00000000-0000-4000-8000-000000000001", page: 2 };
// Two apartments side by side above a common corridor, with a stairwell to the right. Rooms stop
// a raster cell short of each wall face, as extracted regions do.
const room = (id: string, name: string, polygon: ReturnType<typeof rect>, groupLabel?: string) => ({ id, name, geometry: { polygon, groupLabel, source } });
const wall = (id: string, polygon: ReturnType<typeof rect>) => ({ id, name: id, kind: "draft_wall", geometry: { polygon, source, planRegion: { x: polygon[0].x, y: polygon[0].y, width: polygon[2].x - polygon[0].x, height: polygon[2].y - polygon[0].y } } });
const rooms = [
  room("we1-wohnen", "Wohnen", rect(0.1, 0.1, 0.298, 0.398), "WE 1"),
  room("we2-wohnen", "Wohnen", rect(0.302, 0.1, 0.398, 0.398), "WE 2"),
  room("we2-bad", "Bad", rect(0.402, 0.1, 0.5, 0.398), "WE 2"),
  room("flur", "Flur", rect(0.1, 0.402, 0.5, 0.5)),
  room("treppe", "Treppenhaus", rect(0.502, 0.1, 0.6, 0.5)),
];
const walls = [
  wall("between-apartments", rect(0.298, 0.1, 0.302, 0.398)),
  wall("inside-we2", rect(0.398, 0.1, 0.402, 0.398)),
  wall("we1-corridor", rect(0.1, 0.398, 0.298, 0.402)),
  wall("we2-corridor", rect(0.302, 0.398, 0.5, 0.402)),
  wall("we2-stairs", rect(0.5, 0.1, 0.502, 0.398)),
  wall("facade", rect(0.1, 0.096, 0.298, 0.1)),
];
// Side order follows the wall's drawing direction, so compare the two sides as a set.
const sideRooms = (item: any) => item.sides.map((side: any) => side === "exterior" ? "outside" : side?.map((room: any) => room.roomId).sort().join("+") ?? null).sort();
const plan = (properties: any[] = []) => new Map(planWallAdjacency({ rooms, elements: walls, properties }).map(item => [item.wallId, item]));

test("wall roles follow the spaces a wall separates", () => {
  const result = plan();
  expect([...result.values()].map(item => [item.wallId, item.role])).toEqual([
    ["between-apartments", "apartment_partition"], ["inside-we2", "internal"], ["we1-corridor", "corridor_partition"],
    ["we2-corridor", "corridor_partition"], ["we2-stairs", "stairwell"], ["facade", "exterior"]]);
  expect(sideRooms(result.get("between-apartments"))).toEqual(["we1-wohnen", "we2-wohnen"]);
  // A corridor wall spanning two WE 2 rooms records both; beyond the plan's rooms nothing is assumed.
  expect(sideRooms(result.get("we2-corridor"))).toEqual(["flur", "we2-bad+we2-wohnen"]);
  expect(sideRooms(result.get("facade"))).toEqual(["outside", "we1-wohnen"]);
});

test("a face is outside only when nothing, not even an unreviewed room, lies beyond it", () => {
  const candidate = { id: "candidate", name: "Balkon", geometry: { polygon: rect(0.1, 0.02, 0.298, 0.09), source } };
  const result = new Map(planWallAdjacency({ rooms, elements: walls, properties: [], candidateRooms: [candidate] }).map(item => [item.wallId, item]));
  expect(sideRooms(result.get("facade"))).toEqual([null, "we1-wohnen"]);
  expect(result.get("facade")!.role).toBeNull();
  // Probes that land between rooms inside the building are unresolved, never outside.
  const gap = wall("gap", rect(0.6, 0.1, 0.604, 0.3));
  expect(sideRooms(planWallAdjacency({ rooms: [...rooms, room("east", "Bad", rect(0.7, 0.1, 0.8, 0.3), "WE 3")], elements: [gap], properties: [] })[0])).toEqual([null, "treppe"]);
});

test("thickness comes from the printed scale, in metres on both page axes", () => {
  // Landscape sheet (width 1.414 × height); the page height spans 30 m at this scale.
  const scales = new Map([[`${source.sourceVersionId}:${source.page}`, { pageAspectRatio: 1.414, metresPerPageHeight: 30, denominator: 100 }]]);
  const result = new Map(planWallAdjacency({ rooms, elements: walls, properties: [], scales }).map(item => [item.wallId, item]));
  expect(result.get("between-apartments")!.thicknessCm).toBe(17); // 0.004 × 1.414 × 30 m = 16.97 cm
  expect(result.get("we1-corridor")!.thicknessCm).toBe(12); // 0.004 × 30 m
  expect(plan().get("we1-corridor")!).toMatchObject({ thicknessCm: null, writeThickness: false });
  const entered = [{ entityType: "element", entityId: "we1-corridor", propertyKey: "thickness", current: { value: 11.5, reviewStatus: "unreviewed", provenance: "manual" }, reviewed: null }];
  expect(new Map(planWallAdjacency({ rooms, elements: walls, properties: entered, scales }).map(item => [item.wallId, item])).get("we1-corridor")!.writeThickness).toBe(false);
});

test("people's entries win over geometry and labels", () => {
  const props = [
    { entityType: "room", entityId: "flur", propertyKey: "spaceType", current: { value: "stairwell", reviewStatus: "unreviewed", provenance: "manual" }, reviewed: null },
    { entityType: "element", entityId: "inside-we2", propertyKey: "wallRole", current: { value: "apartment_partition", reviewStatus: "unreviewed", provenance: "manual" }, reviewed: null },
    { entityType: "element", entityId: "we2-stairs", propertyKey: "wallRole", current: { value: "exterior", reviewStatus: "unreviewed", provenance: "inferred" }, reviewed: null },
  ];
  const result = plan(props);
  expect(result.get("we1-corridor")!.role).toBe("stairwell");
  expect(result.get("inside-we2")!).toMatchObject({ role: "internal", writeRole: false });
  expect(result.get("we2-stairs")!).toMatchObject({ role: "stairwell", writeRole: true });
  expect(result.get("between-apartments")!.writeRole).toBe(true);
});

test("room context: apartment hallways are not common corridors", () => {
  expect(roomSpaceContext({ name: "Flur", groupLabel: "WE 3" }, {})).toMatchObject({ apartmentUnit: "WE 3", spaceType: "apartment" });
  expect(roomSpaceContext({ name: "Flur", groupLabel: null }, {})).toMatchObject({ apartmentUnit: null, spaceType: "common_corridor" });
  expect(roomSpaceContext({ name: "Balkon", groupLabel: "WE 3" }, {}).spaceType).toBe("exterior");
  expect(roomSpaceContext({ name: "Keller", groupLabel: null }, {}).spaceType).toBeNull();
  expect(deriveWallRole({ apartmentUnit: null, spaceType: "apartment" }, { apartmentUnit: "WE 1", spaceType: "apartment" })).toBeNull();
});

test("component properties are typed and calculation gaps are explicit", () => {
  expect(validateBuildingComponentProperty("element", "thickness", 24, "cm")).toBeNull();
  expect(validateBuildingComponentProperty("element", "thickness", 24, "m")).toBe("thickness requires unit cm");
  expect(validateBuildingComponentProperty("element", "wallRole", "party_wall", null)).toBe("Invalid value for wallRole");
  expect(validateBuildingComponentProperty("element", "fireRating", "REI 90", null)).toBeNull();
  const approved = (value: unknown) => ({ value, reviewStatus: "approved" });
  expect(componentInputGaps("wall", { construction: approved("masonry"), thickness: { value: 24, reviewStatus: "unreviewed" } })).toEqual([
    { field: "thickness", status: "unreviewed" }, { field: "bulkDensity", status: "missing" }, { field: "wallRole", status: "missing" }]);
  expect(componentInputGaps("wall", { construction: approved("drywall"), thickness: approved(12.5), wallRole: approved("internal") })).toEqual([]);
  expect(componentInputGaps("ceiling", {}).map(gap => gap.field)).toEqual(["construction", "thickness", "bulkDensity"]);
});

test("the data request asks per wall type for what is missing or unconfirmed", () => {
  const approved = (value: unknown, unit: string | null = null) => ({ value, unit, reviewStatus: "approved", provenance: "manual" });
  const inferred = (value: unknown, unit: string | null = null) => ({ value, unit, reviewStatus: "unreviewed", provenance: "inferred" });
  const components = [
    { id: "w1", componentType: "wall" as const, properties: { wallRole: inferred("apartment_partition"), thickness: inferred(24, "cm") } },
    { id: "w2", componentType: "wall" as const, properties: { wallRole: approved("apartment_partition"), thickness: inferred(24, "cm"), construction: approved("masonry") } },
    { id: "w3", componentType: "wall" as const, properties: { wallRole: approved("internal"), construction: approved("drywall"), thickness: approved(12.5, "cm") } },
    { id: "w4", componentType: "wall" as const, properties: { wallRole: { value: "stairwell", unit: null, reviewStatus: "rejected", provenance: "inferred" } } },
    { id: "c1", componentType: "ceiling" as const, properties: {} },
    { id: "x", componentType: null, properties: {} },
  ];
  const request = componentDataRequest(components);
  // Complete groups drop out; a rejected role counts as no role; ceilings come last.
  expect(request.map(group => [group.componentType, group.wallRole, group.count])).toEqual([["wall", "apartment_partition", 2], ["wall", null, 1], ["ceiling", null, 1]]);
  expect(request[0].fields).toEqual([
    { field: "construction", missing: 1, unconfirmed: [] },
    { field: "thickness", missing: 0, unconfirmed: [{ value: 24, unit: "cm", origin: "plan", count: 2 }] },
    { field: "bulkDensity", missing: 2, unconfirmed: [] },
  ]);
  // The role is Richtfest's to settle, so it is never asked of the architect.
  expect(request[1].fields.map(field => field.field)).toEqual(["construction", "thickness", "bulkDensity"]);

  const checks = soundInsulationChecks(components);
  expect(checks.map(check => [check.componentId, check.ready])).toEqual([["w1", false], ["w2", false], ["c1", false]]);
  const done = soundInsulationChecks([{ id: "w", componentType: "wall", properties: { wallRole: approved("corridor_partition"), construction: approved("masonry"), thickness: approved(24, "cm"), bulkDensity: approved(1800, "kg/m³") } }]);
  expect(done).toEqual([{ componentId: "w", componentType: "wall", wallRole: "corridor_partition", ready: true, gaps: [] }]);
});

test("each storey with plan rooms gets one ceiling; the storey above is linked only with known levels", () => {
  const storeys = [
    { id: "eg", buildingId: "b", name: "EG", levelIndex: 0 }, { id: "og1", buildingId: "b", name: "OG 1", levelIndex: 1 },
    { id: "og2", buildingId: "b", name: "OG 2", levelIndex: null }, { id: "empty", buildingId: "b", name: "DG", levelIndex: 2 },
  ];
  const rooms = [
    { id: "r1", storeyId: "eg", constructionState: "unknown", geometry: { source } }, { id: "r2", storeyId: "eg", constructionState: "unknown", geometry: { source: { ...source, page: 3 } } },
    { id: "r3", storeyId: "eg", constructionState: "unknown", geometry: { source: { ...source, page: 3 } } },
    { id: "r4", storeyId: "og1", constructionState: "proposed", geometry: { source } }, { id: "r5", storeyId: "og2", geometry: { source } },
    { id: "manual", storeyId: "empty", geometry: null },
  ];
  const ceilings = planStoreyCeilings({ storeys, rooms, elements: [{ id: "existing", stableKey: "ceiling-above:og1", geometry: null }] });
  expect(ceilings.map(ceiling => [ceiling.storeyId, ceiling.upperStoreyId, ceiling.existingId, ceiling.source.page, ceiling.roomIds.length, ceiling.constructionState])).toEqual([
    ["eg", "og1", null, 3, 3, "unknown"], ["og1", "empty", "existing", 2, 1, "proposed"], ["og2", null, null, 2, 1, "unknown"]]);
  expect(ceilings[0].name).toBe("Ceiling above EG");
});

test("storey levels come from the drawing title, never from level marks of other storeys", () => {
  const cases: Array<[string, number | "top" | null]> = [
    ["Wohnen\nGrundriss EG\nM 1:100", 0], ["GRUNDRISS 1. OG\nOKFF EG ±0,00\nOKFF 1. OG +2,95", 1], ["Grundriss 2. Obergeschoss", 2], ["Grundriss OG2", 2],
    ["Grundriss Dachgeschoss\nOKFF 3. OG", "top"], ["Kellergeschoss", -1], ["Bendenweg 12", null], ["OKFF EG\nOKFF 1.OG", null], ["Grundriss UG", -1],
  ];
  expect(cases.map(([text]) => [text, storeyLevelFromText(text)?.level ?? null])).toEqual(cases);
  expect(storeyLevelFromText("GRUNDRISS 1. OG\nOKFF EG")!.quote).toBe("GRUNDRISS 1. OG");

  const storeys = [{ id: "eg", buildingId: "b", levelIndex: null }, { id: "og", buildingId: "b", levelIndex: null }, { id: "dg", buildingId: "b", levelIndex: null }, { id: "set", buildingId: "b", levelIndex: 5 }];
  const readings = new Map([["eg", { level: 0, quote: "Grundriss EG" }], ["og", { level: 1, quote: "Grundriss 1. OG" }], ["dg", { level: "top" as const, quote: "Grundriss DG" }], ["set", { level: 0, quote: "Grundriss EG" }]]);
  // The attic sits above every other storey of the building, including one whose level a person set.
  expect(planStoreyLevels({ storeys, properties: [], readings }).map(item => [item.storeyId, item.level, item.write])).toEqual([["eg", 0, true], ["og", 1, true], ["dg", 6, true], ["set", 5, false]]);
  const entered = [{ entityType: "storey", entityId: "og", propertyKey: "level", current: { value: 2, reviewStatus: "unreviewed", provenance: "manual" }, reviewed: null }];
  expect(planStoreyLevels({ storeys: storeys.slice(0, 2), properties: entered, readings }).map(item => [item.storeyId, item.level, item.write])).toEqual([["eg", 0, true], ["og", 2, false]]);
});

test("the regulatory basis asks for Bebauungsplan noise requirements only when a plan applies", () => {
  const approved = (value: unknown) => ({ value, reviewStatus: "approved" });
  const settled = { federalState: approved("RP"), stateBuildingCodeEdition: approved("LBauO 2024"), vvtbEdition: approved("VVTB RLP 2023"), din4109Edition: approved("2018-01") };
  expect(regulatoryBasisGaps({ ...settled, bebauungsplan: approved("none") })).toEqual([]);
  expect(regulatoryBasisGaps({ ...settled, bebauungsplan: approved("applies") })).toEqual([{ field: "bebauungsplanNoise", status: "missing" }]);
  expect(regulatoryBasisGaps({ ...settled, din4109Edition: { value: "2018-01", reviewStatus: "unreviewed" } }).map(gap => `${gap.field}:${gap.status}`)).toEqual(["bebauungsplan:missing", "din4109Edition:unreviewed"]);
});
