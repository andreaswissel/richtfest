import { describe, expect, test } from "bun:test";
import { classifyFireBuilding, deriveFireRoomRole, fireConceptDraft, escapeRouteLengths, fireDoorRequirement, fireWallRequirement, ratingSatisfies, type FireBuildingInput, type FireSpace } from "./fire-protection";

const building = (overrides: Partial<FireBuildingInput>): FireBuildingInput => ({ state: "RP", height: null, detached: false, dwellings: 6, otherUnits: 0, usableArea: null,
  storeysAboveGround: 4, specialUse: "none", garageArea: null, ...overrides });

describe("building class and deliverable (LBauO RLP)", () => {
  test("Bendenweg: 9.54 m to the highest possible Aufenthaltsraum is GK 4 and needs a reviewed written concept", () => {
    expect(classifyFireBuilding(building({ height: 9.54, garageArea: 600 }))).toMatchObject({ buildingClass: 4, deliverable: "konzept", review: "psv", garage: "medium", notes: ["garageExtendedContent"] });
  });
  test("thresholds are exceeded only above 7, 13 and 22 m", () => {
    expect(classifyFireBuilding(building({ height: 7 })).buildingClass).toBe(3);
    expect(classifyFireBuilding(building({ height: 7.01 })).buildingClass).toBe(4);
    expect(classifyFireBuilding(building({ height: 13 })).buildingClass).toBe(4);
    expect(classifyFireBuilding(building({ height: 13.01 })).buildingClass).toBe(5);
    expect(classifyFireBuilding(building({ height: 22.5 }))).toMatchObject({ buildingClass: 5, highRise: true, deliverable: "konzept", review: "authority_or_psv" });
  });
  test("low buildings: RLP caps GK 2 by dwellings, not by area; other units only within 400 m²", () => {
    expect(classifyFireBuilding(building({ height: 6, dwellings: 2 }))).toMatchObject({ buildingClass: 2, deliverable: "nachweis", review: "none" });
    expect(classifyFireBuilding(building({ height: 6, dwellings: 1, detached: true, storeysAboveGround: 2 })).buildingClass).toBe(1);
    expect(classifyFireBuilding(building({ height: 6, dwellings: 1, detached: true, storeysAboveGround: 3 })).buildingClass).toBe(2);
    expect(classifyFireBuilding(building({ height: 6, dwellings: 1, otherUnits: 1, usableArea: 380 })).buildingClass).toBe(2);
    expect(classifyFireBuilding(building({ height: 6, dwellings: 1, otherUnits: 1, usableArea: 450 }))).toMatchObject({ buildingClass: 3, review: "authority_or_psv" });
    expect(classifyFireBuilding(building({ height: 6, dwellings: 3 }))).toMatchObject({ buildingClass: 3, notes: ["hillsideThirdDwelling"] });
  });
  test("open inputs are named instead of guessed; a Sonderbau always needs the written part", () => {
    expect(classifyFireBuilding(building({ height: 5, dwellings: null }))).toMatchObject({ buildingClass: null, deliverable: null, gaps: ["dwellings"] });
    expect(classifyFireBuilding(building({ height: 9, specialUse: null }))).toMatchObject({ buildingClass: 4, deliverable: "konzept", gaps: ["specialUse"] });
    expect(classifyFireBuilding(building({ height: 4, dwellings: 0, otherUnits: 1, usableArea: 300, specialUse: "childcare" }))).toMatchObject({ buildingClass: 2, deliverable: "konzept" });
    expect(classifyFireBuilding(building({ state: "BY", height: 9 }))).toMatchObject({ supported: false, buildingClass: null });
  });
});

describe("room roles", () => {
  test("stairwells and common corridors are notwendig only from GK 3; rooms in a dwelling follow their use", () => {
    expect(deriveFireRoomRole({ spaceType: "stairwell", roomUse: null, name: "TRH" }, 4)).toBe("necessary_stairwell");
    expect(deriveFireRoomRole({ spaceType: "common_corridor", roomUse: null, name: "Flur" }, 2)).toBe("other");
    expect(deriveFireRoomRole({ spaceType: "common_corridor", roomUse: null, name: "Flur" }, null)).toBeNull();
    expect(deriveFireRoomRole({ spaceType: "apartment", roomUse: null, name: "Schlafen" }, 4)).toBe("habitable");
    expect(deriveFireRoomRole({ spaceType: "apartment", roomUse: null, name: "Abstellraum" }, 4)).toBe("other");
    expect(deriveFireRoomRole({ spaceType: "apartment", roomUse: "bathroom", name: "Wohnen/Bad" }, 4)).toBe("other");
  });
});

const space = (role: FireSpace["role"], unit: string | null = null, extra: Partial<FireSpace> = {}): FireSpace => ({ role, unit, basement: false, ...extra });
const wall = (buildingClass: 1 | 2 | 3 | 4 | 5, a: FireSpace, b: FireSpace, extra: { basement?: boolean; loadBearing?: boolean; state?: "RP" | "BE"; residential?: boolean } = {}) =>
  fireWallRequirement({ state: extra.state ?? "RP", residential: extra.residential, buildingClass, basement: extra.basement ?? false, loadBearing: extra.loadBearing ?? null, faces: [{ exterior: false, spaces: [a] }, { exterior: false, spaces: [b] }] });

describe("wall requirements: the strictest applicable rule", () => {
  test("GK 4 as in the Bendenweg plans: dwelling to notwendiger Flur fh (§ 35), dwelling to dwelling hf (§ 29)", () => {
    const corridor = wall(4, space("habitable", "WE 1"), space("necessary_corridor"));
    expect(corridor.required).toBe("fh");
    expect(corridor.reasons.map((reason) => reason.requirement)).toEqual(["corridorWalls"]);
    expect(wall(4, space("habitable", "WE 1"), space("other", "WE 2")).required).toBe("hf");
    // A common corridor that is not a notwendiger Flur stays a fremder Raum behind a Trennwand.
    expect(wall(4, space("habitable", "WE 1"), space("other")).required).toBe("hf");
  });
  test("Treppenraum walls by class and storey", () => {
    expect(wall(4, space("necessary_stairwell"), space("necessary_corridor")).required).toBe("hf_m");
    expect(wall(4, space("necessary_stairwell"), space("other"), { basement: true }).required).toBe("fb");
    expect(wall(3, space("necessary_stairwell"), space("habitable", "WE 2")).required).toBe("hf");
    // GK 5: Trennwand fb and Bauart Brandwand together need fb with mechanical resistance.
    expect(wall(5, space("necessary_stairwell"), space("habitable", "WE 2")).required).toBe("fb_nb_m");
  });
  test("walls within a dwelling carry nothing unless load-bearing; exterior walls only § 27", () => {
    expect(wall(4, space("habitable", "WE 1"), space("other", "WE 1")).required).toBeNull();
    expect(wall(4, space("habitable", "WE 1"), space("other", "WE 1"), { loadBearing: true }).required).toBe("hf");
    expect(wall(4, space("habitable", "WE 1"), space("other", "WE 1"), { loadBearing: true, basement: true }).required).toBe("fb");
    expect(wall(3, space("habitable", "WE 1"), space("habitable", "WE 2")).required).toBe("fh");
    const exterior = (inside: FireSpace, loadBearing: boolean | null) => fireWallRequirement({ state: "RP", buildingClass: 4, basement: false, loadBearing, faces: [{ exterior: true, spaces: [] }, { exterior: false, spaces: [inside] }] }).required;
    expect(exterior(space("habitable", "WE 1"), null)).toBeNull();
    // The Treppenraum's facade is drawn nichtbrennbar (§ 34 Abs. 6 Satz 2); load-bearing, it is a full Treppenraum wall.
    expect(exterior(space("necessary_stairwell"), null)).toBe("nb");
    expect(exterior(space("necessary_stairwell"), true)).toBe("hf_m");
    expect(fireWallRequirement({ state: "RP", buildingClass: 4, basement: false, loadBearing: null, faces: [{ exterior: true, spaces: [] }, { exterior: false, spaces: [space("habitable", "WE 1"), space("necessary_stairwell")] }] }).required).toBeNull();
    expect(ratingSatisfies("fb_nb_m", "nb")).toBe(true);
    expect(ratingSatisfies("fb", "nb")).toBe(false);
    expect(ratingSatisfies("nb", "fh")).toBe(false);
  });
});

const door = (buildingClass: 1 | 2 | 3 | 4 | 5, a: FireSpace | null, b: FireSpace | null, smokeVent: "windows" | "top_opening" = "windows") =>
  fireDoorRequirement({ state: "RP", buildingClass, smokeVent, sides: [a, b] }).required;

describe("door requirements", () => {
  test("Treppenraum doors depend on where they lead and on how the Treppenraum is vented", () => {
    expect(door(4, space("necessary_stairwell"), space("necessary_corridor"))).toBe("RS");
    expect(door(4, space("necessary_stairwell"), space("habitable", "WE 1"))).toBe("DS");
    expect(door(3, space("necessary_stairwell"), space("other", null, { roomUse: "bathroom" }))).toBe("DS");
    expect(door(4, space("necessary_stairwell"), space("other", null, { roomUse: "storage" }))).toBe("T30_RS");
    expect(door(4, space("necessary_stairwell"), space("other", null, { basement: true }))).toBe("T30_RS");
    expect(door(4, space("necessary_stairwell"), space("other", null), "top_opening")).toBe("T30_RS");
    // Bendenweg: 6a's Treppenraum has windows (DS to the dwellings), 6b's a smoke opening at the top (T 30-RS).
    expect(door(4, space("necessary_stairwell", null, { smokeVent: "top_opening" }), space("habitable", "WE 21"), "windows")).toBe("T30_RS");
    expect(door(4, space("necessary_stairwell", null, { smokeVent: "windows" }), space("habitable", "WE 27"), "top_opening")).toBe("DS");
  });
  test("the Flur rule governs dwelling doors to a notwendiger Flur; other doors between units are Trennwand openings", () => {
    expect(door(4, space("necessary_corridor"), space("habitable", "WE 1"))).toBe("D");
    expect(door(4, space("habitable", "WE 1"), space("habitable", "WE 2"))).toBe("T30_DS");
    expect(door(3, space("necessary_corridor"), space("other"))).toBe("D");
    expect(door(4, space("habitable", "WE 1"), space("other", "WE 1"))).toBeNull();
    expect(door(4, space("necessary_stairwell"), null)).toBeNull();
    expect(door(2, space("other"), space("habitable", "WE 1"))).toBe("T30_DS");
  });
});

describe("escape route lengths", () => {
  const square = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  test("the farthest corner of a room to the Treppenraum door, including the wall the door sits in", () => {
    const routes = escapeRouteLengths([
      { id: "room", polygon: square(0, 0, 4, 4), role: "habitable", basement: false },
      { id: "stair", polygon: square(0, -3, 4, -0.2), role: "necessary_stairwell", basement: false },
    ], [{ id: "d", point: { x: 1, y: -0.1 }, rooms: ["room", "stair"] }]);
    // From the far corner (4, 4): √(3² + 4²) = 5 m to the doorway plus 0.1 m into the wall.
    expect(routes).toEqual([{ roomId: "room", length: 5.1, from: { x: 4, y: 4 }, doorId: "d", path: [{ x: 4, y: 4 }, { x: 1, y: 0 }, { x: 1, y: -0.1 }] }]);
  });
  test("the route bends around corners instead of crossing walls", () => {
    const routes = escapeRouteLengths([{ id: "l", role: "habitable", basement: false,
      polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 10 }, { x: 0, y: 10 }] }],
    [{ id: "out", point: { x: 10.05, y: 1 }, rooms: ["l", null] }]);
    // (10,1) → corner (2,2) → (0,10): √65 + √68, plus 0.05 m to the door.
    expect(routes[0]!.length).toBeCloseTo(Math.sqrt(65) + Math.sqrt(68) + 0.05, 2);
    expect(routes[0]!.from).toEqual({ x: 0, y: 10 });
  });
  test("routes continue through a notwendiger Flur; rooms without an exit and non-habitable rooms are not reported", () => {
    const routes = escapeRouteLengths([
      { id: "a", polygon: square(0, 0, 4, 4), role: "habitable", basement: false },
      { id: "flur", polygon: square(4.1, 0, 8.1, 4), role: "necessary_corridor", basement: false },
      { id: "stair", polygon: square(8.2, 0, 10, 4), role: "necessary_stairwell", basement: false },
      { id: "isolated", polygon: square(20, 0, 24, 4), role: "habitable", basement: false },
    ], [
      { id: "a-flur", point: { x: 4.05, y: 2 }, rooms: ["a", "flur"] },
      { id: "flur-stair", point: { x: 8.15, y: 2 }, rooms: ["flur", "stair"] },
    ]);
    expect(routes.map((route) => route.roomId)).toEqual(["a"]);
    expect(routes[0]!.length).toBeCloseTo(Math.sqrt(20) + 0.05 + 0.05 + 4 + 0.05, 2);
    expect(routes[0]!.doorId).toBe("a-flur");
    // The drawn line runs through both doors to the Treppenraum and is as long as the stated length.
    const path = routes[0]!.path;
    expect(path[0]).toEqual(routes[0]!.from);
    expect(path).toContainEqual({ x: 4.05, y: 2 });
    expect(path.at(-1)).toEqual({ x: 8.15, y: 2 });
    expect(path.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - path[index]!.x, point.y - path[index]!.y), 0)).toBeCloseTo(routes[0]!.length, 2);
  });
  test("every basement room is checked, whatever its use", () => {
    const routes = escapeRouteLengths([
      { id: "keller", polygon: square(0, 0, 30, 10), role: "other", basement: true },
      { id: "stair", polygon: square(30.2, 0, 33, 4), role: "necessary_stairwell", basement: true },
    ], [{ id: "d", point: { x: 30.1, y: 2 }, rooms: ["keller", "stair"] }]);
    expect(routes[0]!.length).toBeCloseTo(Math.hypot(30, 8) + 0.1, 2);
  });
});

describe("written part", () => {
  const draft = (statuses: Array<"met" | "not_met" | "open">) => fireConceptDraft({
    classification: classifyFireBuilding(building({ height: 9.54, dwellings: 31, garageArea: 900 })), height: 9.54, dwellings: 31, garageEnclosure: "closed",
    stairwells: [{ name: "6a", smokeVent: "windows" }, { name: "6b", smokeVent: "top_opening" }],
    components: statuses.map((status, index) => ({ kind: "wall" as const, name: `Wand ${index + 1}`, status, reasons: [{ requirement: "partitionWalls" as const, value: "hf" as const }] })),
    routes: [{ room: "WE 17", length: 31.92 }], water: { litresPerMinute: 1600, cubicMetresPerHour: 96 } });
  test("follows the office's chapter structure and states each Treppenraum's venting", () => {
    const text = draft(["met"]);
    const order = ["1 Allgemeine Angaben", "2.3 Schlussfolgerungen für den Brandschutz", "3.1 Schutzziele", "4.2.4 Löschwasserversorgung", "4.3.2 Rettungsweglängen", "4.4.4 Trennwände", "4.4.9 Rauchableitung", "5.1 Abweichungen und Kompensationsmaßnahmen", "7 Anlagen zum Brandschutzkonzept"];
    expect(order.map((heading) => text.split("\n").indexOf(heading))).toEqual(order.map((heading) => text.split("\n").indexOf(heading)).sort((a, b) => a - b));
    expect(order.every((heading) => text.split("\n").includes(heading))).toBe(true);
    expect(text).toContain("geschlossene Mittelgarage");
    expect(text).toContain("Notwendiger Treppenraum 6a: in jedem oberirdischen Geschoss");
    expect(text).toContain("Notwendiger Treppenraum 6b: an der höchsten Stelle");
    expect(text).toContain("Alle Anforderungen werden eingehalten.");
    expect(text).toContain("Es sind keine Abweichungen geplant bzw. werden benötigt.");
  });
  test("the closing sentence needs every component met; unmet ones become Abweichungen", () => {
    const text = draft(["met", "not_met", "open"]);
    expect(text.slice(text.indexOf("4.4.4 Trennwände"), text.indexOf("4.4.6 Decken"))).not.toContain("Alle Anforderungen werden eingehalten.");
    expect(text).toContain("Nicht erfüllt: Wand 2.");
  });
});

describe("Berlin (BauO Bln)", () => {
  const be = (overrides: Partial<FireBuildingInput>) => classifyFireBuilding(building({ state: "BE", ...overrides }));
  test("between 7 and 13 m, GK 4 needs every unit within 400 m² BGF; otherwise GK 5", () => {
    expect(be({ height: 9.5, largestUnitArea: 120 })).toMatchObject({ buildingClass: 4, deliverable: "konzept", review: "check_engineer" });
    expect(be({ height: 9.5, largestUnitArea: 400 }).buildingClass).toBe(4);
    expect(be({ height: 9.5, largestUnitArea: 401 }).buildingClass).toBe(5);
    expect(be({ height: 9.5 })).toMatchObject({ buildingClass: null, gaps: ["largestUnitArea"] });
    expect(be({ height: 13.01 }).buildingClass).toBe(5);
  });
  test("low buildings: GK 1–2 need at most two units within 400 m² BGF in total; GK 3 is not checked unless a Mittelgarage is attached", () => {
    expect(be({ height: 6, dwellings: 2, unitsGrossArea: 380 })).toMatchObject({ buildingClass: 2, deliverable: "nachweis", review: "none" });
    expect(be({ height: 6, dwellings: 2, unitsGrossArea: 450 })).toMatchObject({ buildingClass: 3, review: "none" });
    expect(be({ height: 6, dwellings: 3, garageArea: 300 })).toMatchObject({ buildingClass: 3, review: "check_engineer" });
  });
  test("Trennwände follow the storey's load-bearing rating; GK 3 Treppenraum walls are fh", () => {
    expect(wall(4, space("habitable", "WE 1"), space("other", "WE 2"), { state: "BE" }).required).toBe("hf");
    expect(wall(3, space("habitable", "WE 1"), space("habitable", "WE 2"), { state: "BE" }).required).toBe("fh");
    expect(wall(2, space("habitable", "WE 1"), space("habitable", "WE 2"), { state: "BE" }).required).toBeNull();
    expect(wall(3, space("necessary_stairwell"), space("habitable", "WE 2"), { state: "BE" }).required).toBe("fh");
    expect(wall(3, space("necessary_stairwell"), space("habitable", "WE 2")).required).toBe("hf");
  });
  test("a smoke opening at the top does not turn Treppenraum doors into T 30-RS", () => {
    const dwelling = space("habitable", "WE 1");
    expect(fireDoorRequirement({ state: "BE", buildingClass: 4, smokeVent: "top_opening", sides: [space("necessary_stairwell"), dwelling] }).required).toBe("DS");
    expect(fireDoorRequirement({ state: "RP", buildingClass: 4, smokeVent: "top_opening", sides: [space("necessary_stairwell"), dwelling] }).required).toBe("T30_RS");
  });
  test("the written part cites the BauO Bln and the Prüfingenieur review", () => {
    const text = fireConceptDraft({ classification: be({ height: 9.5, largestUnitArea: 110, dwellings: 40 }), height: 9.5, dwellings: 40, garageEnclosure: null,
      stairwells: [{ name: "TRH 1", smokeVent: "top_opening" }], components: [], routes: [], water: null });
    expect(text).toContain("§ 35 BauO Bln");
    expect(text).toContain("Prüfingenieur");
    expect(text).not.toContain("LBauO");
  });
});
