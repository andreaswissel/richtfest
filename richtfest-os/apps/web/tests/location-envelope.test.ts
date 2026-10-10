import { expect, test } from "bun:test";
import { pointsInEnvelope } from "../src/components/location/scene-math";
import type { LocationPointCloud, SceneObject } from "@richtfest/shared";

test("displayed returns respect translation, yaw, asymmetric dimensions and vertical bounds", () => {
  const object: SceneObject = {
    id: "vehicle",
    kind: "vehicle",
    label: "Vehicle",
    note: "",
    position: [10, 5, -4],
    size: [2, 3, 8],
    rotation: 45,
  };
  const cloud: LocationPointCloud = {
    positions: [
      12, 6, -2, 12, 6, -6, 10, 4.99, -4, 10, 8.01, -4, 10, 8, -4, 10, 5, -4,
    ],
    classifications: [5, 5, 2, 5, 5, 2],
    groundElevation: 50,
    sourcePointCount: 100,
    sampled: true,
    surveyedAt: "2021",
    sourceUrl: "https://gdi.berlin.de",
  };
  expect(pointsInEnvelope(cloud, object)).toBe(3);
  expect(pointsInEnvelope(cloud, { ...object, rotation: 0 })).toBe(2);
});
