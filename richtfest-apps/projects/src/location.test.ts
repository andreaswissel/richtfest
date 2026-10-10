import { expect, test } from "bun:test";
import { buildingFeature, treeFeature, toUtm33, SITE_ORIGIN } from "./location-context";
import { LasCrop, rangeResponse, zipDirectory } from "./location-lidar";

test("real Berlin coordinate conversion, south-positive rings and null heights", () => {
  // Independent EPSG:25833 reference for the first supplied Berlin street tree.
  const tree = toUtm33(13.48238982, 52.55715888);
  expect(tree[0]).toBeCloseTo(397116.74, 0);
  expect(tree[1]).toBeCloseTo(5824091.87, 0);
  const feature = { id: "tree.1", properties: { gisid: "1", baumhoehe: null, kronedurch: "0", art_dtsch: "Linde" }, geometry: { type: "Point", coordinates: tree } };
  const result = treeFeature(feature, SITE_ORIGIN)!;
  expect(result.height).toBeNull(); expect(result.crownDiameter).toBeNull();
  expect(result.position[0]).toBeLessThan(0); expect(result.position[1]).toBeGreaterThan(0);
  const building = buildingFeature({ id: "b", properties: { hoehe: null, hnr: null, strasse: "Giersstraße" }, geometry: { type: "MultiPolygon", coordinates: [[[[10,20],[11,19],[10,20]],[[10.1,19.9],[10.2,19.8],[10.1,19.9]]]] } }, [10,20])!;
  expect(building.polygons[0]![0]![1]).toEqual([1,1]);
  expect(building.polygons[0]).toHaveLength(2); expect(building.height).toBeNull(); expect(building.label).toBe("Giersstraße");
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
