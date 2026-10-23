import { expect, test } from "bun:test";
import { fireHeightMetres, type PlanHeightObservation } from "@richtfest/shared/plan-heights";
import { readPlanHeightOutput, selectHeightPages } from "./plan-heights";

const height: PlanHeightObservation = { kind: "fire_height", value: 954, unit: "cm", unitBasis: "explicit",
  quote: "Höhe 954 cm", buildingLabel: "Haus B", storeyLabel: "DG", upperReference: "highest_habitable_floor",
  lowerReference: "mean_terrain", floorBasis: "structural", constructionState: "proposed",
  region: { x: .7, y: .2, width: .2, height: .5 }, reason: "Printed dimension with labelled endpoints." };

test("height observations retain source numbers and distinguish classification height from roof and datum levels", () => {
  const output = readPlanHeightOutput({ observations: [height, { ...height, kind: "ridge_height", value: 13.8, unit: "m", quote: "First 13,80 m", upperReference: "ridge" }], gaps: [] },
    "Schnitt B-B\nHöhe 954 cm\nFirst 13,80 m");
  expect(output.observations.map(item => [item.kind, item.value, item.unit])).toEqual([["fire_height", 954, "cm"], ["ridge_height", 13.8, "m"]]);
  expect(fireHeightMetres(output.observations[0]!)).toBe(9.54);
  expect(fireHeightMetres(output.observations[1]!)).toBeNull();
  for (const patch of [{ lowerReference: "project_datum" }, { lowerReference: "terrain" }, { floorBasis: "unknown" },
    { upperReference: "floor" }, { unit: "unknown" }, { unitBasis: "unknown" }, { value: -1 }])
    expect(fireHeightMetres({ ...height, ...patch } as PlanHeightObservation)).toBeNull();
  // A number elsewhere on a sheet cannot justify an invented quote or arithmetic result.
  const rejected = readPlanHeightOutput({ observations: [{ ...height, quote: "Höhe 955 cm" }, { ...height, value: 9.54 }], gaps: [] }, "Höhe 954 cm");
  expect(rejected.observations).toEqual([]);
  expect(rejected.gaps[0]).toContain("2 observations rejected");
  expect(readPlanHeightOutput({ observations: [{ ...height, value: 9.54, quote: "9.54" }], gaps: [] }, "19.54 -9.54 9.543").observations).toEqual([]);
  expect(() => readPlanHeightOutput({ observations: [{ ...height, region: { x: .9, y: 0, width: .2, height: .5 } }], gaps: [] }, "Höhe 954 cm")).toThrow();
});

test("layout whitespace does not invalidate height evidence or relax literal source matching", () => {
  const quote = `OKFFB DG\n${" ".repeat(700)}+9.24`;
  const observation = { ...height, kind: "floor_elevation", value: 9.24, unit: "m", quote, upperReference: "floor", lowerReference: "project_datum" };
  const result = readPlanHeightOutput({ observations: [observation], gaps: [] }, quote);
  expect(result.observations[0]?.quote).toBe("OKFFB DG +9.24");
  expect(fireHeightMetres(result.observations[0]!)).toBeNull();
  expect(readPlanHeightOutput({ observations: [observation], gaps: [] }, "OKFFB EG +9.24").observations).toEqual([]);
  expect(() => readPlanHeightOutput({ observations: [{ ...observation, quote: "a".repeat(501) }], gaps: [] }, "a".repeat(501))).toThrow();
});

test("height page selection excludes floor-plan cut markers and reports bounded omitted section coverage", () => {
  const selected = selectHeightPages([{ page: 1, text: "Grundriss EG Schnitt A-A" }, { page: 2, text: "Lageplan" },
    ...Array.from({ length: 8 }, (_, i) => ({ page: i + 3, text: i === 0 ? "Ansicht Nord" : "Schnitt A-A" }))], [1]);
  expect(selected.selected.map(page => page.page)).toEqual([3, 4, 5, 6, 7, 8]);
  expect(selected.omittedPages).toEqual([9, 10]);
  expect(selectHeightPages([{ page: 1, text: "" }], [], [{ page: 1, status: "completed", answers: { page_type: { choice: "section", confidence: .59 } } }]).selected).toEqual([]);
});
