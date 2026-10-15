import { expect, test } from "bun:test";
import { compareExteriorNoiseReference } from "./reference-comparison";
import type { ExteriorNoiseReferenceInputs } from "@richtfest/shared";

function fixture() {
  const inputs: ExteriorNoiseReferenceInputs = { version: 1, sourceSha256: "a".repeat(64), rooms: [{
    id: "A", pages: [7], assessedLaDb: 68, roomFactorDb: 30, minimumRequirementDb: 30,
    floorAreaM2: 12.5, requirementAreaM2: 10, compositeAreaM2: 10, uncertaintyDb: 2,
    elements: [{ id: "wall", kind: "area", areaM2: 10, rwDb: 40, correctionDb: 0 }],
  }] };
  const answers = { version: 1, sourceSha256: inputs.sourceSha256,
    rooms: [{ id: "A", pages: [2], requiredDb: 38, compositeDb: 40, providedDb: 38 }] };
  return { inputs, answers };
}

test("reproduction separates requirement geometry, energy composition, allowance and expected answers", () => {
  const { inputs, answers } = fixture();
  const room = inputs.rooms[0]!;
  room.requirementAreaM2 = 20; // Do not silently use the 10 m² composite area.
  room.elements = [
    { id: "opaque", kind: "area", areaM2: 8, rwDb: 50, correctionDb: 0 },
    { id: "opening", kind: "area", areaM2: 2, rwDb: 20, correctionDb: 10 },
    { id: "vents", kind: "small", dnEWDb: 50, count: 2, correctionDb: 0 },
  ];
  const original = structuredClone(inputs);
  const result = compareExteriorNoiseReference(inputs, answers);
  const actual = result.rows[0]!.calculated!;
  // Independent energy sum: (0.00008 + 0.002 + 0.0002) / 10 = 0.000228.
  expect(actual.elements.reduce((sum, e) => sum + e.transmission, 0)).toBeCloseTo(0.000228, 12);
  expect(actual.requiredDb).toBeCloseTo(41.01029995663981, 10);
  expect(actual.compositeDb).toBeCloseTo(36.42065152999546, 10);
  expect(actual.providedDb).toBeCloseTo(34.42065152999546, 10);
  expect(actual.requirementMinusCompositeAreaM2).toBe(10);
  expect(actual.elementAreaMinusCompositeAreaM2).toBe(0);
  expect(result.withinTolerance).toBe(false);
  answers.rooms[0]!.compositeDb = 90;
  expect(compareExteriorNoiseReference(inputs, answers).rows[0]!.calculated).toEqual(actual);
  expect(inputs).toEqual(original);
  room.assessedLaDb = 55;
  expect(compareExteriorNoiseReference(inputs, answers).rows[0]!.calculated!.requiredDb).toBeCloseTo(33.01029995663981, 10);
});

test("reference tolerance never rounds away negative margins, and includes both sides of 0.1 dB", () => {
  const { inputs, answers } = fixture();
  inputs.rooms[0]!.assessedLaDb = 68.02;
  const nearZero = compareExteriorNoiseReference(inputs, answers);
  expect(nearZero.withinTolerance).toBe(true);
  expect(nearZero.reviewStatus).toBe("not_reviewed");
  expect(nearZero.rows[0]!.calculated!.marginDb).toBeCloseTo(-0.02, 10);
  inputs.rooms[0]!.assessedLaDb = 68;
  for (const sign of [-1, 1]) {
    answers.rooms[0]!.compositeDb = 40 + sign * 0.1;
    expect(compareExteriorNoiseReference(inputs, answers).withinTolerance).toBe(true);
    answers.rooms[0]!.compositeDb = 40 + sign * 0.100000001;
    expect(compareExteriorNoiseReference(inputs, answers).withinTolerance).toBe(false);
  }
  answers.rooms[0] = { ...answers.rooms[0]!, compositeDb: 40, providedDb: 38.06, requiredDb: 37.94 };
  expect(compareExteriorNoiseReference(inputs, answers).withinTolerance).toBe(false); // Margin differs by 0.12.
});

test("all expected rooms remain visible; missing inputs, extra rooms and blank areas cannot pass", () => {
  const { inputs, answers } = fixture();
  answers.rooms.push({ ...answers.rooms[0]!, id: "B" });
  let result = compareExteriorNoiseReference(inputs, answers);
  expect(result.rows.map(r => r.status)).toEqual(["within_reference_tolerance", "missing_input"]);
  expect(result.withinTolerance).toBe(false);
  inputs.rooms.push({ ...structuredClone(inputs.rooms[0]!), id: "B" });
  inputs.rooms.reverse();
  expect(compareExteriorNoiseReference(inputs, answers).withinTolerance).toBe(true);
  inputs.rooms.push({ ...structuredClone(inputs.rooms[0]!), id: "extra" });
  result = compareExteriorNoiseReference(inputs, answers);
  expect(result.unexpectedRoomIds).toEqual(["extra"]);
  expect(result.withinTolerance).toBe(false);
  const element = inputs.rooms[0]!.elements[0]!;
  if (element.kind === "area") element.areaM2 = null;
  const blocked = compareExteriorNoiseReference(inputs, answers).rows[1]!;
  expect(blocked.status).toBe("blocked");
  expect(blocked.calculated).toMatchObject({ requiredDb: 38, compositeDb: null, providedDb: null,
    marginDb: null, missingAreaElementIds: ["wall"] });
  expect(blocked.delta).toMatchObject({ compositeDb: null, providedDb: null, marginDb: null });
});

test("ambiguous identities, invalid quantities and expected results in the input are rejected", () => {
  const { inputs, answers } = fixture();
  expect(() => compareExteriorNoiseReference({ ...inputs, rooms: [...inputs.rooms, ...inputs.rooms] }, answers)).toThrow("Duplicate input room IDs");
  expect(() => compareExteriorNoiseReference(inputs, { ...answers, rooms: [...answers.rooms, ...answers.rooms] })).toThrow("Duplicate reference room IDs");
  expect(() => compareExteriorNoiseReference(inputs, { ...answers, sourceSha256: "b".repeat(64) })).toThrow("hashes differ");
  const room = inputs.rooms[0]!;
  expect(() => compareExteriorNoiseReference({ ...inputs, rooms: [{ ...room, elements: [...room.elements, ...room.elements] }] }, answers)).toThrow("Duplicate element IDs");
  for (const floorAreaM2 of [0, -1, Infinity, NaN])
    expect(() => compareExteriorNoiseReference({ ...inputs, rooms: [{ ...room, floorAreaM2 }] }, answers)).toThrow();
  expect(() => compareExteriorNoiseReference({ ...inputs, rooms: [{ ...room, expectedDb: 40 }] }, answers)).toThrow();
});
