import { expect, test } from "bun:test";
import { distanceToPolylineMeters, fromUtm32, groupMappedSources, hessenMappedAxis, readGmlFeatures, rlpMappedAxis, type MappedAxis } from "./noise-geodata";
import { toUtm } from "./location-context";

// Trimmed from a real HVBG ATKIS response (EPSG:4326, latitude first).
const axes = `<?xml version="1.0" encoding="utf-8"?>
<wfs:FeatureCollection xmlns="http://www.adv-online.de/namespaces/adv/gid/7.1" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:xlink="http://www.w3.org/1999/xlink">
<wfs:member><AX_Strassenachse gml:id="DEHE046200004E7y">
<modellart><AA_Modellart><advStandardModell>Basis-DLM</advStandardModell></AA_Modellart></modellart>
<istTeilVon xlink:href="urn:adv:oid:DEHE046200005qds"/>
<position><gml:LineString gml:id="g1" srsName="urn:ogc:def:crs:EPSG::4326" srsDimension="2"><gml:posList>50.1289315 8.9198221 50.1293781 8.9205177</gml:posList></gml:LineString></position>
<breiteDerFahrbahn uom="m">10.000</breiteDerFahrbahn><anzahlDerFahrstreifen>2</anzahlDerFahrstreifen>
</AX_Strassenachse></wfs:member>
<wfs:member><AX_Strassenachse gml:id="DEHE046200004E3g">
<istTeilVon xlink:href="urn:adv:oid:DEHE046200005xyz"/>
<position><gml:LineString gml:id="g2"><gml:posList>50.1325241 8.9242496 50.1314823 8.9250164</gml:posList></gml:LineString></position>
<anzahlDerFahrstreifen>4</anzahlDerFahrstreifen>
</AX_Strassenachse></wfs:member>
<wfs:member><AX_Bahnstrecke gml:id="DEHE04620000BTAR">
<position><gml:LineString gml:id="g3"><gml:posList>50.1300 8.9300 50.1310 8.9320</gml:posList></gml:LineString></position>
<bahnkategorie>1101</bahnkategorie><bahnkategorie>1104</bahnkategorie><elektrifizierung>1000</elektrifizierung><anzahlDerStreckengleise>2000</anzahlDerStreckengleise>
<nummerDerBahnstrecke>3680</nummerDerBahnstrecke><nummerDerLinie>S9</nummerDerLinie><nummerDerLinie>S8</nummerDerLinie>
</AX_Bahnstrecke></wfs:member>
</wfs:FeatureCollection>`;
const roads = `<wfs:FeatureCollection xmlns="http://www.adv-online.de/namespaces/adv/gid/7.1" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:xlink="http://www.w3.org/1999/xlink">
<wfs:member><AX_Strasse gml:id="DEHE046200005qds"><bestehtAus xlink:href="urn:adv:oid:DEHE046200004E7y"/><name>Friedrich-Ebert-Anlage</name><widmung>1307</widmung></AX_Strasse></wfs:member>
<wfs:member><AX_Strasse gml:id="DEHE046200005xyz"><name>Friedrich-Ebert-Anlage</name><widmung>1307</widmung></AX_Strasse></wfs:member>
</wfs:FeatureCollection>`;

test("UTM 32 conversion round-trips within a centimetre", () => {
  for (const [lon, lat] of [[8.9215, 50.1293], [8.68, 50.11], [9.95, 51.6]] as const) {
    const [back, backLat] = fromUtm32(...toUtm(lon, lat, 32));
    expect(Math.abs(back - lon) * 71000).toBeLessThan(0.01);
    expect(Math.abs(backLat - lat) * 111000).toBeLessThan(0.01);
  }
});

test("distance runs to the nearest point of a segment, not to its vertices", () => {
  // A 200 m east-west segment passing 50 m north of the site: the vertices are ~112 m away, the segment 50 m.
  const site = { longitude: 8.9, latitude: 50.1 };
  const north = 50 / 110574, half = 100 / (111320 * Math.cos(50.1 * Math.PI / 180));
  expect(distanceToPolylineMeters(site, [[[8.9 - half, 50.1 + north], [8.9 + half, 50.1 + north]]])).toBe(50);
  expect(distanceToPolylineMeters(site, [])).toBeNull();
});

test("Hessen GML becomes one source per named road and per rail route, nearest first", () => {
  const features = readGmlFeatures(axes, ["AX_Strassenachse", "AX_Bahnstrecke"]);
  expect(features.map(feature => feature.id)).toEqual(["DEHE046200004E7y", "DEHE046200004E3g", "DEHE04620000BTAR"]);
  // Nested values (advStandardModell) are not mistaken for feature fields.
  expect(features[0]!.fields.advStandardModell).toBeUndefined();
  const roadObjects = new Map(readGmlFeatures(roads, ["AX_Strasse"]).map(road => [road.id, road]));
  const site = { longitude: 8.9215, latitude: 50.1293 };
  const grouped = groupMappedSources(features.map(feature => hessenMappedAxis(feature, roadObjects)).filter((axis): axis is MappedAxis => !!axis), site);
  // Two ATKIS road objects with the same name and class are one road; lanes and width take the widest axis.
  expect(grouped.roads).toHaveLength(1);
  expect(grouped.roads[0]).toMatchObject({ name: "Friedrich-Ebert-Anlage", dedication: "1307", lanes: 4, carriagewayWidthM: 10, segments: 2 });
  // Nearest is the first axis' east end: 70.1 m east, 8.6 m north of the site.
  expect(grouped.roads[0]!.distanceMeters).toBe(71);
  expect(grouped.rail).toEqual([expect.objectContaining({ ref: "rail:route:3680", categories: ["1101", "1104"], routeNumbers: ["3680"], lines: ["S8", "S9"], tracks: "2000", electrified: true })]);
});

test("GML with a DTD is refused", () => {
  expect(() => readGmlFeatures(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`, ["x"])).toThrow();
});

test("Rheinland-Pfalz flattened attributes map to the same source shape", () => {
  const road = rlpMappedAxis({ properties: { objart_txt: "AX_Strassenachse", objid: "A1", objid_z: "S1", bez: "B40", brf: 8.5, fsz: 2, nam: "An der Philippsschanze", wdm: 1303 },
    geometry: { type: "LineString", coordinates: [[8.27, 49.995], [8.271, 49.996]] } });
  expect(road).toMatchObject({ kind: "road", group: "S1", dedication: "1303", designation: "B40", lanes: 2, widthM: 8.5 });
  // -9998 is the RLP placeholder for an unknown width.
  expect(rlpMappedAxis({ properties: { objart_txt: "AX_Strassenachse", objid: "A2", brf: -9998 }, geometry: null })!.widthM).toBeNull();
  const rail = rlpMappedAxis({ properties: { objart_txt: "AX_Bahnstrecke", objid: "R1", bkt: "1100#1102#1104", elk: 1000, gls: 2000, nrb: "3510#3522" }, geometry: { type: "LineString", coordinates: [] } });
  expect(rail).toMatchObject({ categories: ["1100", "1102", "1104"], routeNumbers: ["3510", "3522"], group: "route:3510+3522", tracks: "2000", electrified: true });
});
