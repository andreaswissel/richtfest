import { describe, expect, test } from "bun:test";
import { planOpenings, planOpeningKey, type OpeningPage, type OpeningWall, type TracedOpening } from "./plan-openings";

// Two rooms side by side under a north exterior wall (y = 0.2); a partition between them at x = 0.5.
const rooms = [
  { id: "living", storeyId: "s1", candidateKey: "topology-v5:living", polygon: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.6 }, { x: 0.1, y: 0.6 }] },
  { id: "bed", storeyId: "s1", candidateKey: null, polygon: [{ x: 0.5, y: 0.2 }, { x: 0.9, y: 0.2 }, { x: 0.9, y: 0.6 }, { x: 0.5, y: 0.6 }] },
];
const wall = (id: string, keys: string[], exterior: boolean, roomIds: string[]): OpeningWall => ({ id, storeyId: "s1", sourceVersionId: "v1", page: 1, footprintKeys: keys, exterior, roomIds });
const walls = [wall("north-a", ["fa"], true, ["living"]), wall("north-b", ["fb"], true, ["bed"]), wall("partition", ["fp", "fq"], false, ["living", "bed"])];
const gap = (over: Partial<TracedOpening>): TracedOpening => ({ sourceKey: "o1", kind: "jamb_pair", wallAxis: "horizontal", sourceKeys: ["fa", "fb"], doorSwingKey: null,
  physicalWidthM: 1.504, jambLength: 0.01, midpoint: { x: 0.3, y: 0.195 }, closure: { x: 0.28, y: 0.19, width: 0.04, height: 0.01 }, sides: ["unassigned", "topology-v5:living"], ...over });
const page = (openings: TracedOpening[]): OpeningPage => ({ sourceVersionId: "v1", page: 1, storeyId: "s1", pageAspectRatio: 1.4, openings });

describe("openings from the plan trace", () => {
  test("a gap in an exterior wall is a window of its room, in the jamb wall that bounds that room", () => {
    const { planned } = planOpenings({ pages: [page([gap({})])], walls, rooms, existing: [] });
    expect(planned).toEqual([expect.objectContaining({ kind: "window", wallId: "north-a", roomId: "living", widthM: 1.5, planKey: "plan-opening:v1:1:o1", action: "create" })]);
    // The room without a trace key is found beyond the jamb face; its own exterior wall hosts the window.
    const bed = planOpenings({ pages: [page([gap({ sourceKey: "o2", midpoint: { x: 0.7, y: 0.205 }, sides: ["unassigned", "topology-v5:gone"] })])], walls, rooms, existing: [] });
    expect(bed.planned[0]).toMatchObject({ kind: "window", wallId: "north-b", roomId: "bed" });
    const terrace = { ...rooms[0], id: "terrace", exterior: true, candidateKey: "terrace", polygon: [{ x: .1, y: .1 }, { x: .5, y: .1 }, { x: .5, y: .19 }, { x: .1, y: .19 }] };
    const outside = planOpenings({ pages: [page([gap({ sides: ["terrace", "topology-v5:living"] })])], walls, rooms: [...rooms, terrace], existing: [] });
    expect(outside.planned[0]).toMatchObject({ kind: "window", roomId: "living", roomSides: ["terrace", "living"] });
    const otherJamb = { ...wall("other-jamb", ["fb"], false, ["living"]), exterior: null };
    const run = (exterior: boolean | null) => planOpenings({ pages: [page([gap({})])],
      walls: [walls[0], { ...otherJamb, exterior }], rooms, existing: [] });
    expect(run(null).planned[0]).toMatchObject({ wallId: "north-a", kind: "window" });
    // An explicitly interior jamb remains a conflict, not an unresolved neighbour.
    expect(run(false).outcomes[0].outcome).toBe("ambiguous");
  });

  test("a door swing makes a door anywhere; a gap without one inside the building is a passage", () => {
    const door = gap({ sourceKey: "d1", sourceKeys: ["fp", "fq"], doorSwingKey: "swing", wallAxis: "vertical", midpoint: { x: .5, y: .4 }, sides: ["topology-v5:living", "unassigned"] });
    const passage = gap({ sourceKey: "p1", sourceKeys: ["fp", "fq"], wallAxis: "vertical", midpoint: { x: 0.5, y: 0.4 }, sides: ["unassigned", "unassigned"] });
    const { planned, outcomes } = planOpenings({ pages: [page([door, passage])], walls, rooms, existing: [] });
    expect(planned).toEqual([expect.objectContaining({ action: "create", kind: "door", wallId: "partition", roomId: "living", doorSwing: true })]);
    expect(outcomes.map(item => item.outcome)).toEqual(["passage", "door"]);
  });

  test("re-deriving keeps placed openings; one entered opening in a wall with one gap takes its place", () => {
    const traced = page([gap({})]);
    const again = planOpenings({ pages: [traced], walls, rooms, existing: [{ id: "e1", kind: "window", wallId: "north-a", planKey: planOpeningKey(traced, gap({})) }] });
    expect(again).toMatchObject({ planned: [], summary: { kept: 1 } });
    const adopted = planOpenings({ pages: [traced], walls, rooms, existing: [{ id: "typed", kind: "window", wallId: "north-a", planKey: null }] });
    expect(adopted.planned).toEqual([expect.objectContaining({ action: "adopt", elementId: "typed", widthM: 1.5 })]);
    // Two gaps but one entered window: which is which is a person's call, so neither is placed nor created.
    const two = page([gap({}), gap({ sourceKey: "o3", midpoint: { x: 0.2, y: 0.195 } })]);
    expect(planOpenings({ pages: [two], walls, rooms, existing: [{ id: "typed", kind: "window", wallId: "north-a", planKey: null }] }))
      .toMatchObject({ planned: [], summary: { ambiguous: 2 } });
    // Walls of another plan page are never hosts.
    expect(planOpenings({ pages: [{ ...traced, page: 2 }], walls, rooms, existing: [] }).outcomes).toEqual([expect.objectContaining({ outcome: "no_wall" })]);
  });

  test("stroke doors use the actual jamb, keep both sides and reject same-room connections and room holes", () => {
    const rect = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    const jamb = { ...wall("jamb", [], false, ["living", "bed"]), polygon: rect(.495, .2, .01, .18) };
    const unrelated = { ...jamb, id: "unrelated", polygon: rect(.495, .6, .01, .1) };
    const opening = gap({ kind: "door_swing_doorway", sourceKeys: [], wallAxis: "vertical", doorSwingKey: "swing",
      midpoint: { x: .5, y: .4 }, closure: { x: .499, y: .38, width: .002, height: .04 }, sides: ["unassigned", "unassigned"],
      sideProbes: [{ x: .48, y: .4 }, { x: .52, y: .4 }] });
    const run = (rs = rooms, op = opening) => planOpenings({ pages: [page([op])], walls: [unrelated, jamb], rooms: rs, existing: [] });
    expect(run().planned).toEqual([expect.objectContaining({ wallId: "jamb", roomSides: ["living", "bed"] })]);
    expect(run(rooms, { ...opening, sideProbes: [{ x: .48, y: .4 }, { x: .47, y: .4 }] }).outcomes[0].outcome).toBe("ambiguous");
    const holed = rooms.map(r => ({ ...r, holes: [rect(.51, .39, .02, .02)] }));
    expect(run(holed).planned[0].roomSides).toEqual(["living", null]);
    expect(run(rooms.map(r => ({ ...r, sourceVersionId: "old", page: 1 }))).planned).toHaveLength(0);
    expect(run(rooms.map(r => ({ ...r, boundaryResolved: false }))).planned).toHaveLength(0);
  });
});
