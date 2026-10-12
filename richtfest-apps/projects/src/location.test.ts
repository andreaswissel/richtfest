import { expect, test, spyOn } from "bun:test";
import { buildingFeature, treeFeature, toUtm, resolveLocationAddress, importLocationContext } from "./location-context";
import { LasCrop, rangeResponse, zipDirectory, fetchLocationLidar } from "./location-lidar";
import { locationMatchesAddress } from "@richtfest/shared";

test("real Berlin coordinate conversion, south-positive rings and null heights", () => {
  // Independent EPSG:25833 reference for the first supplied Berlin street tree.
  const tree = toUtm(13.48238982, 52.55715888, 33);
  expect(tree[0]).toBeCloseTo(397116.74, 0);
  expect(tree[1]).toBeCloseTo(5824091.87, 0);
  const feature = { id: "tree.1", properties: { gisid: "1", baumhoehe: null, kronedurch: "0", art_dtsch: "Linde" }, geometry: { type: "Point", coordinates: tree } };
  const result = treeFeature(feature, [397139.418, 5824134.851])!;
  expect(result.height).toBeNull(); expect(result.crownDiameter).toBeNull();
  expect(result.position[0]).toBeLessThan(0); expect(result.position[1]).toBeGreaterThan(0);
  const building = buildingFeature({ id: "b", properties: { hoehe: null, hnr: null, strasse: "Giersstraße" }, geometry: { type: "MultiPolygon", coordinates: [[[[10,20],[11,19],[10,20]],[[10.1,19.9],[10.2,19.8],[10.1,19.9]]]] } }, [10,20])!;
  expect(building.polygons[0]![0]![1]).toEqual([1,1]);
  expect(building.polygons[0]).toHaveLength(2); expect(building.height).toBeNull(); expect(building.label).toBe("Giersstraße");
});

test("project address resolves exact Berlin house numbers and anchors context to the resolved site", async () => {
  const address = { street: "Giersstrasse 20", postalCode: "13088", city: "Berlin", country: "DE" };
  const feature = { properties: { adressid: "61316", str_name: "Giersstraße", hnr: 20, hnr_zusatz: null, plz: "13088" }, geometry: { type: "Point", coordinates: [13.48266821,52.55754663] } };
  let features: any[] = [feature];
  const upstream = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.hostname === "maps.rlp.de") return Response.json({ features: [] });
    if (url.pathname.endsWith("adressen_berlin")) {
      const house = Number(url.searchParams.get("CQL_FILTER")?.match(/hnr=(\d+)/)?.[1]);
      const matches = features.filter(f => f.properties.hnr === house);
      return Response.json({ features: matches, numberMatched: matches.length });
    }
    const [x,y] = url.searchParams.get("bbox")!.split(",").map(Number);
    expect(x).toBeCloseTo(397036.524, 1);
    expect(y).toBeCloseTo(5824034.599, 1);
    return Response.json({ features: [], numberMatched: 0 });
  }, { preconnect: fetch.preconnect }));
  try {
    const context = await importLocationContext(address, new AbortController().signal);
    expect(context).toMatchObject({ siteId: "berlin-address:61316", address: "Giersstraße 20, 13088 Berlin", projectAddress: address });
    expect(context.origin[0]).toBeCloseTo(397136.524, 1);
    expect(context.origin[1]).toBeCloseTo(5824134.599, 1);
    expect(context.sources).toHaveLength(4);
    expect(locationMatchesAddress(context, {...address,country:"Deutschland"})).toBe(true);
    expect(locationMatchesAddress(context, {...address,country:"AT"})).toBe(false);
    features = [{ ...feature, properties: {...feature.properties, hnr:21} }];
    expect((await resolveLocationAddress({...address,street:"Giersstrasse 21"},new AbortController().signal)).address).toBe("Giersstraße 21, 13088 Berlin");
    await expect(resolveLocationAddress(address,new AbortController().signal)).rejects.toThrow("not found");
    features = [feature, { ...feature, properties: { ...feature.properties, adressid: "another" } }];
    await expect(resolveLocationAddress(address, new AbortController().signal)).rejects.toThrow("ambiguous");
    features = [{ ...feature, properties: { ...feature.properties, hnr_zusatz: "a" } }];
    await expect(resolveLocationAddress(address, new AbortController().signal)).rejects.toThrow("not found");
    expect((await resolveLocationAddress({ ...address, street: "Giersstrasse 20a" }, new AbortController().signal)).address).toContain("20a");
    features = [];
    await expect(resolveLocationAddress(address, new AbortController().signal)).rejects.toThrow("not found");
    await expect(resolveLocationAddress({ ...address, city: "Hamburg" }, new AbortController().signal)).rejects.toThrow("Berlin");
    await expect(resolveLocationAddress({}, new AbortController().signal)).rejects.toThrow("requires");
  } finally { upstream.mockRestore(); }
});

test("Alzey imports exact house context across RLP tile boundaries without invented layers or heights", async () => {
  const address = { street: "Bendenweg 6", postalCode: "55232", city: "Alzey", country: "DE" };
  const feature = { id: "DERPLP150000Q0dQ", geometry: { type: "Point", coordinates: [8.09628, 49.739843] },
    properties: { typ: "Haus", bundesland: "Rheinland-Pfalz", strasse: "Bendenweg", haus: "6", ort: "Alzey", plz: "55232" } };
  let features: unknown[] = [feature], broken = false;
  const ring = (coords: string) => `<gml:LinearRing><gml:posList srsDimension="3">${coords}</gml:posList></gml:LinearRing>`;
  const building = (id: string, x: number, y: number, height = "") => `<bldg:Building gml:id="${id}">
    ${height ? `<bldg:measuredHeight uom="urn:adv:uom:m">${height}</bldg:measuredHeight>` : ""}
    <bldg:boundedBy><bldg:GroundSurface><gml:Polygon>
      <gml:exterior>${ring(`${x} ${y} 170 ${x + 12} ${y} 170 ${x + 12} ${y + 7} 170 ${x} ${y} 170`)}</gml:exterior>
      <gml:interior>${ring(`${x + 2} ${y + 1} 170 ${x + 4} ${y + 1} 170 ${x + 4} ${y + 2} 170 ${x + 2} ${y + 1} 170`)}</gml:interior>
    </gml:Polygon></bldg:GroundSurface></bldg:boundedBy>
    <bldg:boundedBy><bldg:RoofSurface><gml:Polygon><gml:exterior>${ring("1 2 180 3 4 180 5 6 180 1 2 180")}</gml:exterior></gml:Polygon></bldg:RoofSurface></bldg:boundedBy>
    <xal:ThoroughfareName>Bendenweg</xal:ThoroughfareName><xal:ThoroughfareNumber>6</xal:ThoroughfareNumber>
  </bldg:Building>`;
  const tile = (body: string) => `<core:CityModel xmlns:core="http://www.opengis.net/citygml/1.0" xmlns:bldg="http://www.opengis.net/citygml/building/1.0" xmlns:gml="http://www.opengis.net/gml" xmlns:xal="urn:oasis:names:tc:ciq:xsdschema:xAL:2.0">
    <gml:boundedBy><gml:Envelope srsName="urn:adv:crs:ETRS89_UTM32*DE_DHHN2016_NH"/></gml:boundedBy>${body}</core:CityModel>`;
  const upstream = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.hostname === "maps.rlp.de") return Response.json({ features });
    const body = url.pathname.endsWith("LoD2_32_434_5508_2_RP.gml")
      ? tile(building("south", 434880, 5509999))
      : url.pathname.endsWith("LoD2_32_434_5510_2_RP.gml")
        ? tile(building("site", 434885, 5510098, "13.455") + building("outside", 436000, 5512000)) : "unexpected tile";
    const bytes = new TextEncoder().encode(broken ? body.slice(0, -15) : body);
    // Split XML tags and numeric lists across response chunks.
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.slice(i, i + 37)); c.close(); } }));
  }, { preconnect: fetch.preconnect }));
  try {
    const context = await importLocationContext(address, AbortSignal.timeout(5000));
    expect(context).toMatchObject({ address: "Bendenweg 6, 55232 Alzey", crs: "EPSG:25832", projectAddress: address, trees: [] });
    // Independent official EPSG:25832 address result (WGS84 rounding < 0.1m).
    expect(context.origin[0]).toBeCloseTo(434884.641, 0);
    expect(context.origin[1]).toBeCloseTo(5510097.868, 0);
    expect(context.buildings.map(b => b.id)).toEqual(["south", "site"]);
    expect(context.buildings[0]!.height).toBeNull();
    const site = context.buildings[1]!;
    expect(site).toMatchObject({ height: 13.455, label: "Bendenweg 6", sourceId: "site" });
    expect(site.polygons).toHaveLength(1);
    expect(site.polygons[0]).toHaveLength(2);
    expect(site.polygons[0]![0]![0]![0]).toBeCloseTo(0.35, 1);
    expect(site.polygons[0]![0]![0]![1]).toBeCloseTo(-0.19, 1);
    expect(context.sources).toHaveLength(3);
    await expect(fetchLocationLidar(context, AbortSignal.timeout(5000))).rejects.toThrow("not available for Rheinland-Pfalz");
    broken = true;
    await expect(importLocationContext(address, AbortSignal.timeout(5000))).rejects.toThrow();
    for (const properties of [{ typ: "Strasse" }, { haus: "60" }, { ort: "Mainz" }, { plz: "55116" }, { bundesland: "Hessen" }]) {
      features = [{ ...feature, properties: { ...feature.properties, ...properties } }];
      await expect(resolveLocationAddress(address, AbortSignal.timeout(5000))).rejects.toThrow("not found");
    }
    features = [feature, { ...feature, id: "other" }];
    await expect(resolveLocationAddress(address, AbortSignal.timeout(5000))).rejects.toThrow("ambiguous");
  } finally { upstream.mockRestore(); }
});

const las = (points: number[][]) => {
  const b = Buffer.alloc(375 + points.length * 30);
  b.write("LASF"); b[24] = 1; b[25] = 4; b.writeUInt32LE(375,96); b[104] = 6; b.writeUInt16LE(30,105); b.writeBigUInt64LE(BigInt(points.length),247);
  for (const offset of [131,139,147]) b.writeDoubleLE(0.01,offset);
  for (const [i,p] of points.entries()) { const offset = 375+i*30; for (let j=0;j<3;j++) b.writeInt32LE(p[j]!*100,offset+j*4); b[offset+16]=p[3]!; }
  return b;
};
test("streamed real LAS layouts crop, retain ambiguous labels and normalize against class 2", () => {
  const b = las([[10,20,40,2],[11,19,45,5],[10,21,42,3],[200,200,99,2]]), crop = new LasCrop([10,20], 10);
  for (let p=0;p<b.length;p+=17) crop.push(b.subarray(p,p+17));
  const cloud = crop.finish();
  expect(cloud.positions).toEqual([0,0,0,1,5,1,0,2,-1]); expect(cloud.classifications).toEqual([2,5,3]);
  expect(cloud.groundElevation).toBe(40); expect(cloud.sourcePointCount).toBe(3); expect(cloud.sampled).toBe(false);
  const sampled = new LasCrop([10,20],10,2); sampled.push(b); expect(sampled.finish().sampled).toBe(true); expect(sampled.finish().classifications).toHaveLength(2);
  const truncated = new LasCrop([10,20],10); truncated.push(b.subarray(0,b.length-1)); expect(() => truncated.finish()).toThrow("Truncated LAS");
  const noGround = new LasCrop([10,20],10); noGround.push(las([[10,20,50,5]])); expect(() => noGround.finish()).toThrow("No ground");
});
test("ZIP64 central directory reads offsets beyond 4GB and rejects truncation/encryption", () => {
  const name = Buffer.from("tile.las"), b = Buffer.alloc(46+name.length+12);
  b.writeUInt32LE(0x02014b50); b.writeUInt16LE(8,10); b.writeUInt32LE(20,20); b.writeUInt32LE(50,24); b.writeUInt16LE(name.length,28); b.writeUInt16LE(12,30); b.writeUInt32LE(0xffffffff,42); name.copy(b,46);
  const q = 46+name.length; b.writeUInt16LE(1,q); b.writeUInt16LE(8,q+2); b.writeBigUInt64LE(32_000_000_000n,q+4);
  expect(zipDirectory(b)[0]).toMatchObject({ name:"tile.las", method:8, compressed:20, expanded:50, offset:32_000_000_000 });
  expect(() => zipDirectory(b.subarray(0,b.length-1))).toThrow("Truncated");
  b.writeUInt16LE(1,8); expect(() => zipDirectory(b)).toThrow("Encrypted");
});
test("range importer refuses 200 full downloads and mismatched Content-Range", async () => {
  const server = Bun.serve({ port:0, fetch(req) { return req.url.endsWith("/full") ? new Response("giant archive",{status:200}) : new Response("xx",{status:206,headers:{"Content-Range":"bytes 1-2/100"}}); } });
  try {
    await expect(rangeResponse(`${server.url}full`,0,1,100,AbortSignal.timeout(1000))).rejects.toThrow("full archive download refused");
    await expect(rangeResponse(`${server.url}wrong`,0,1,100,AbortSignal.timeout(1000))).rejects.toThrow("exact byte range");
  } finally { server.stop(); }
});
