import { expect, test } from "bun:test";
import { containsPoint, lookupBerlinContext, polygonsOf, publicLink } from "./berlin-site-context";

test("parcel geometry retains holes and does not substitute invalid shapes", () => {
  const polygon = [[[0,0],[10,0],[10,10],[0,10],[0,0]],[[4,4],[6,4],[6,6],[4,6],[4,4]]];
  const polygons = polygonsOf({ properties: {}, geometry: { type: "Polygon", coordinates: polygon } });
  expect(containsPoint(polygons,[2,2])).toBe(true);
  expect(containsPoint(polygons,[5,5])).toBe(false);
  expect(containsPoint(polygons,[20,20])).toBe(false);
  expect(polygonsOf({properties:{},geometry:{type:"Point",coordinates:[0,0]}})).toEqual([]);
  expect(publicLink("javascript:alert(1)")).toBeNull();
  expect(publicLink("https://user:secret@example.org/plan.pdf")).toBeNull();
  expect(publicLink("https://example.org/plan.pdf")).toBe("https://example.org/plan.pdf");
});

test("Berlin lookup returns official candidates without inferring planning basis and distinguishes upstream failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes("typeNames=bplan%3Aa_bp_iv")) return new Response("failure",{status:503});
    if (url.includes("bplan")) return Response.json({numberMatched:0,features:[]});
    return Response.json({numberMatched:1, features:[{id:"parcel.1",properties:{uuid:"1",afl:995,beg:"2025-06-24",namgmk:"Test",fln:"2",zae:"3"},geometry:{type:"Polygon",coordinates:[[[0,0],[10,0],[10,10],[0,10],[0,0]]]}}]});
  }) as unknown as typeof fetch;
  try {
    const r = await lookupBerlinContext({address:"Public test address",origin:[5,5],sources:[]},new AbortController().signal);
    expect(r.parcelStatus).toBe("available"); expect(r.planStatus).toBe("unavailable"); expect(r.plans).toEqual([]);
    expect(r.parcels[0]?.area).toBe(995); expect(r.parcels[0]?.sourceDate).toBe("2025-06-24"); expect(r.parcels[0]?.containsAddress).toBe(true);
    expect(r).not.toHaveProperty("planningBasis"); expect(r.parcels[0]).not.toHaveProperty("reviewed");
  } finally { globalThis.fetch = original; }
});

test("truncated Berlin collections remain unavailable, never complete empty findings", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({numberMatched:101,features:[]})) as unknown as typeof fetch;
  try {
    const r=await lookupBerlinContext({address:"Test",origin:[0,0],sources:[]},new AbortController().signal);
    expect(r.parcelStatus).toBe("unavailable");expect(r.planStatus).toBe("unavailable");expect(r.parcels).toEqual([]);
  } finally {globalThis.fetch=original;}
});

test("malformed upstream features produce unavailable context rather than a failed assessment", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({numberMatched:1,features:[null]})) as unknown as typeof fetch;
  try {
    const result = await lookupBerlinContext({address:"Test",origin:[0,0],sources:[]},new AbortController().signal);
    expect(result.parcelStatus).toBe("unavailable");
    expect(result.planStatus).toBe("unavailable");
    expect(result.parcels).toEqual([]);
  } finally { globalThis.fetch = original; }
});

test("aerial window is a fixed snapped square around a Berlin point, never caller-sized", async () => {
  const express = (await import("express")).default;
  const { createBerlinSiteContextRouter, AERIAL_WINDOW_M } = await import("./berlin-site-context");
  const calls: unknown[][] = [];
  const deps = { requirePermission() {}, project: async () => ({ id: "p" }), aerialImage: async (...args: unknown[]) => { calls.push(args); return { body: Buffer.from("jpeg"), stale: false, fetchedAt: new Date(), freshUntil: new Date(Date.now() + 60_000), attribution: "Geoportal Berlin" }; } };
  const app = express().use(createBerlinSiteContextRouter(() => deps as any)).use((e: any, _q: any, res: any, _n: any) => res.status(e.status ?? 400).end());
  const server = app.listen(0), base = `http://localhost:${(server.address() as any).port}/projects/00000000-0000-4000-8000-000000000000/aerial`;
  try {
    const ok = await fetch(`${base}?e=397137.4&n=5824112.6&halfWidth=5000`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(calls[0]!.slice(1)).toEqual([[397125, 5824125], AERIAL_WINDOW_M]);
    expect((await fetch(`${base}?e=13.4&n=52.5`)).status).toBe(400);
    expect(calls).toHaveLength(1);
  } finally { server.close(); }
});

test("FNP land use is only a planning-law hint by category", async () => {
  const { landUseCategory } = await import("./berlin-site-context");
  expect(landUseCategory("Wohnbaufläche, W1 (GFZ über 1,5)")).toBe("building");
  expect(landUseCategory("Gemischte Baufläche, M2")).toBe("building");
  expect(landUseCategory("Wald")).toBe("open");
  expect(landUseCategory("Grünfläche")).toBe("open");
  expect(landUseCategory("Fläche für Ver- und Entsorgung")).toBe("other");
});

test("plan register facts and the locality come through for the planning regime", async () => {
  const original = globalThis.fetch;
  const square = { type: "Polygon", coordinates: [[[0,0],[10,0],[10,10],[0,10],[0,0]]] };
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes("typeNames=bplan%3Ab_bp_fs")) return Response.json({numberMatched:1,features:[{id:"b_bp_fs.1",properties:{planname:"IV-2c",festsg_am:"1985-03-12",planartname:"Qualifizierter B-Plan",verfahrensart:"Normal",normkontr:"teilunwirksam"},geometry:square}]});
    if (url.includes("alkis_ortsteile")) return Response.json({numberMatched:1,features:[{id:"o.1",properties:{nam:"Kreuzberg",sch:"110000020202"},geometry:square}]});
    return Response.json({numberMatched:0,features:[]});
  }) as unknown as typeof fetch;
  try {
    const r = await lookupBerlinContext({address:"Test",origin:[5,5],sources:[]},new AbortController().signal);
    expect(r.plans[0]).toMatchObject({ name: "IV-2c", effectiveDate: "1985-03-12", planType: "Qualifizierter B-Plan", courtReview: "teilunwirksam" });
    expect(r.locality).toMatchObject({ name: "Kreuzberg", key: "110000020202" });
  } finally { globalThis.fetch = original; }
});
