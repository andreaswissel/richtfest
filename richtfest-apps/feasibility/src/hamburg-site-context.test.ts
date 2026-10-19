import { expect, test } from "bun:test";
import { toUtm } from "@richtfest/shared";
import { lookupSiteContext } from "./berlin-site-context";
import { to25832 } from "./hamburg-site-context";

test("Hamburg parcels are reprojected into the assessment frame and keep the official area", async () => {
  // Rathausmarkt 1: the service answers in EPSG:25832, the assessment works in EPSG:25833.
  const origin = toUtm(9.992627505, 53.550543679, 33), [e, n] = to25832(origin);
  const square = (dx: number) => [[[e + dx - 10, n - 10], [e + dx + 10, n - 10], [e + dx + 10, n + 10], [e + dx - 10, n + 10], [e + dx - 10, n - 10]]];
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: any) => {
    requested = String(input);
    return Response.json({ numberMatched: 2, features: [
      { id: 7, properties: { idflurst: "DEHHALKAJ0000FWC", flaeche: 3098, aktualit: "2025-12-01Z", gemarkung: "Altstadt Nord", flstnrzae: "1376" }, geometry: { type: "MultiPolygon", coordinates: [square(30)] } },
      { id: 8, properties: { idflurst: "DEHHALKAJ0000FmC", flaeche: 16371, aktualit: "2021-08-11Z", gemarkung: "Altstadt Nord", flstnrzae: "1658", flstnrnen: "2" }, geometry: { type: "MultiPolygon", coordinates: [square(0)] } },
    ] });
  }) as unknown as typeof fetch;
  try {
    const r = await lookupSiteContext({ region: "HH", address: "Rathausmarkt 1, 20095 Hamburg", origin, sources: [] }, new AbortController().signal);
    expect(new URL(requested).searchParams.get("crs")).toBe("http://www.opengis.net/def/crs/EPSG/0/25832");
    expect(r.parcelStatus).toBe("available"); expect(r.planStatus).toBe("not_connected"); expect(r.plans).toEqual([]);
    const [own, neighbour] = r.parcels;
    expect(own).toMatchObject({ id: "DEHHALKAJ0000FmC", number: "1658/2", area: 16371, sourceDate: "2021-08-11", containsAddress: true });
    expect(neighbour?.containsAddress).toBe(false);
    // Without reprojection the 25832 ring would sit ~330 km west of the 25833 origin.
    const [x, y] = own!.polygons[0]![0]![0]!;
    expect(Math.hypot(x - origin[0], y - origin[1])).toBeLessThan(20);
  } finally { globalThis.fetch = original; }
});
