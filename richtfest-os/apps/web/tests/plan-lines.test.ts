import { describe, expect, mock, test } from "bun:test";
import type { GeometryEvidence, PlanOverlay } from "@richtfest/shared/site-geometry-model";

const X = 397000, Y = 5824000;
// Plan page 100 m × 100 m: image x grows east, image y grows south, top-left corner at (X - 50, Y + 50).
const overlay: PlanOverlay = { fileVersionId: "v", page: 1, opacity: 0.5, source: "B-Plan IV-2c, p. 1", sourceDate: "2019-03-01", reviewed: true,
  controlPoints: [{ image: [0, 0], site: [X - 50, Y + 50] }, { image: [1, 0], site: [X + 50, Y + 50] }, { image: [0, 1], site: [X - 50, Y - 50] }] };
const toImage = (sx: number, sy: number) => [(sx - (X - 50)) / 100, (Y + 50 - sy) / 100] as [number, number];
const parcel: GeometryEvidence = { id: "p", label: "263/292", source: "ALKIS", sourceDate: "2026-09-01", reviewed: true,
  geometry: [[[[X, Y], [X + 20, Y], [X + 20, Y + 30], [X, Y + 30], [X, Y]]]] };

let request: any;
let payload: any;
mock.module("../src/api", () => ({ api: async (_path: string, body: unknown) => { request = body; return { id: "12345678-proposal", status: "completed", payload }; } }));
const { traceBuildingLines } = await import("../src/components/feasibility/plan-lines");

describe("tracing building lines from an aligned plan", () => {
  test("crops around the parcel, maps traced corners back onto the site, drops far windows and clips lines", async () => {
    // Parcel spans image x 0.5–0.7 and y 0.2–0.5; one parcel size (0.3) of margin, clamped to the page.
    const crop = { x: 0.2, y: 0, width: 0.8, height: 0.8 };
    const inCrop = (sx: number, sy: number) => { const [x, y] = toImage(sx, sy); return [(x - crop.x) / crop.width, (y - crop.y) / crop.height]; };
    payload = {
      baugrenzen: [
        { points: [inCrop(X + 3, Y + 5), inCrop(X + 17, Y + 5), inCrop(X + 17, Y + 25), inCrop(X + 3, Y + 25)], reason: "window on the site" },
        { points: [inCrop(X + 40, Y - 40), inCrop(X + 45, Y - 40), inCrop(X + 45, Y - 35)], reason: "neighbouring block" },
      ],
      baulinien: [{ points: [inCrop(X - 10, Y + 25), inCrop(X + 30, Y + 25)], reason: "street front" }],
      limitations: ["Scan is faint"],
    };
    const traced = await traceBuildingLines("project", overlay, parcel, "anthropic");
    expect(request.crop.x).toBeCloseTo(crop.x, 6);
    expect(request.crop.width).toBeCloseTo(crop.width, 6);
    expect(request.crop.height).toBeCloseTo(crop.height, 6);
    // The parcel outline is sent in the same crop coordinates: its south-west corner (X, Y) sits at image (0.5, 0.5).
    expect(request.site[0][0]).toBeCloseTo((0.5 - 0.2) / 0.8, 6);
    expect(request.site[0][1]).toBeCloseTo(0.5 / 0.8, 6);
    expect(traced.status).toBe("traced");
    expect(traced.envelope!.geometry).toHaveLength(1);
    const corners = traced.envelope!.geometry[0]![0]!;
    const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(X + 3, 3);
    expect(Math.max(...xs)).toBeCloseTo(X + 17, 3);
    expect(Math.min(...ys)).toBeCloseTo(Y + 5, 3);
    expect(Math.max(...ys)).toBeCloseTo(Y + 25, 3);
    expect(traced.envelope).toMatchObject({ reviewed: false, sourceDate: "2019-03-01" });
    // The Baulinie crosses the whole block; only the part on the parcel stays, 1 cm inside its edges.
    expect(traced.lines).toHaveLength(1);
    const [a, b] = traced.lines[0]!.line;
    expect(a![0]).toBeCloseTo(X + 0.01, 3);
    expect(b![0]).toBeCloseTo(X + 19.99, 3);
    expect(a![1]).toBeCloseTo(Y + 25, 3);
    expect(traced.lines[0]!.reviewed).toBe(false);
    expect(traced.limitations).toEqual(["Scan is faint"]);
  });
  test("nothing near the parcel stays empty instead of inventing an envelope", async () => {
    payload = { baugrenzen: [], baulinien: [], limitations: [] };
    const traced = await traceBuildingLines("project", overlay, parcel, "openai");
    expect(traced).toMatchObject({ status: "empty", envelope: null, lines: [] });
  });
});
