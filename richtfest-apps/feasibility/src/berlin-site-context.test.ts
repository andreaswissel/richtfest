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
