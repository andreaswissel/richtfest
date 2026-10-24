import { expect, test } from "bun:test";
import { boundedProjectViewData, unavailableProjectViewData } from "./project-view-data";

test("saved view data is a UTF-8 bounded structured excerpt with honest truncation", () => {
  const small = { revision: 7, inputs: [{ id: "room", reviewed: false, value: 123 }] };
  expect(boundedProjectViewData(small)).toEqual({ status: "available", authority: "untrusted_saved_project_data", truncated: false, data: small });
  for (const data of [
    { notes: "🏗️".repeat(20000) },
    { records: Array.from({ length: 200 }, (_, index) => ({ id: index, notes: "ä".repeat(3000) })) },
    { ["x".repeat(20000)]: "value" },
  ]) {
    const result = boundedProjectViewData(data);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(16384);
    expect(result.truncated).toBe(true);
  }
  expect(boundedProjectViewData([], true).truncated).toBe(true);
  expect(unavailableProjectViewData("not_saved")).toMatchObject({ status: "unavailable", reason: "not_saved", truncated: false });
});
