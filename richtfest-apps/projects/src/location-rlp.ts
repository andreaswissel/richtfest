import { SaxesParser } from "saxes";
import { z } from "zod";
import { formatProjectAddress, type ProjectAddress, type LocationBuilding, type LocationContext } from "@richtfest/shared";
import { boundedBody, localXZ, measuredHeight, toUtm } from "./location-context";

const normal = (value: string) => value.trim().toLowerCase().replaceAll("ß", "ss").replace(/\s+/g, " ");
const house = z.object({
  id: z.string(),
  geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number().finite(), z.number().finite()]) }),
  properties: z.object({ typ: z.literal("Haus"), bundesland: z.literal("Rheinland-Pfalz"), strasse: z.string(), haus: z.string(), ort: z.string(), plz: z.string() }),
});

export async function resolveRlpAddress(address: ProjectAddress, signal: AbortSignal) {
  // Public address search used by the state's GeoShop. Restrict both coverage
  // and returned structured fields; search ranking is not an exact match.
  const url = new URL("https://maps.rlp.de/bkg_geosearch");
  url.search = new URLSearchParams({ bbox: "5.9,48.8,8.6,51.0", outputformat: "json", srsName: "EPSG:4326", count: "100", query: formatProjectAddress(address) }).toString();
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Site address service unavailable; retry import");
  const json = JSON.parse((await boundedBody(response, 1_000_000)).toString());
  if (!Array.isArray(json.features) || json.features.length >= 100) throw new Error("Site address lookup incomplete; add the postal code or retry");
  const matches = json.features.flatMap((feature: unknown) => {
    const parsed = house.safeParse(feature);
    if (!parsed.success) return [];
    const p = parsed.data.properties;
    return normal(`${p.strasse} ${p.haus}`) === normal(address.street!) && normal(p.ort) === normal(address.city!)
      && (!address.postalCode || address.postalCode === p.plz) ? [parsed.data] : [];
  });
  if (!matches.length) throw new Error("Site address not found as an exact house in Rheinland-Pfalz. Coverage is Berlin and Rheinland-Pfalz only; check project details");
  if (matches.length !== 1) throw new Error("Site address is ambiguous; add the postal code in project details");
  const match = matches[0]!, [longitude, latitude] = match.geometry.coordinates;
  if (longitude < 5.9 || longitude > 8.6 || latitude < 48.8 || latitude > 51) throw new Error("Site address service returned invalid coordinates");
  return {
    siteId: `rlp-address:${match.id}`, projectAddress: address,
    address: `${match.properties.strasse} ${match.properties.haus}, ${match.properties.plz} ${match.properties.ort}`,
    longitude, latitude, origin: toUtm(longitude, latitude, 32), crs: "EPSG:25832" as const, radius: 100,
    sources: [{ label: "Address search maps.rlp.de / BKG; house match, not a surveyed setting-out point", url: url.href, surveyedAt: null }],
  };
}

/** Stream CityGML: retain only ground polygons and recorded heights near the
 * site. Roofs are not rendered as surveyed roof meshes; terrain is not imported. */
async function readBuildings(response: Response, origin: [number, number], radius: number) {
  if (!response.ok || !response.body) throw new Error("Site building tile unavailable in Rheinland-Pfalz; retry import");
  const parser = new SaxesParser({ xmlns: true });
  const buildings: LocationBuilding[] = [];
  const stack: string[] = [];
  const parts: LocationBuilding[] = [];
  let polygon: [number, number][][] | null = null;
  let text = "", street = "", number = "", validCrs = false;
  const gml = "http://www.opengis.net/gml", bldg = "http://www.opengis.net/citygml/building/1.0";
  parser.on("doctype", () => { throw new Error("Site building tile contains an unsupported DTD"); });
  parser.on("opentag", tag => {
    stack.push(tag.local); text = "";
    if (tag.uri === gml && tag.local === "Envelope" && stack.length === 3)
      validCrs = tag.attributes.srsName?.value === "urn:adv:crs:ETRS89_UTM32*DE_DHHN2016_NH";
    if (tag.uri === bldg && ["Building", "BuildingPart"].includes(tag.local)) {
      const id = Object.values(tag.attributes).find(a => a.uri === gml && a.local === "id")?.value;
      if (!id) throw new Error("Site building tile has no source identifier");
      parts.push({ id, sourceId: id, polygons: [], height: null, roof: null, label: "Building" });
      street = ""; number = "";
    }
    if (parts.length && stack.includes("GroundSurface") && tag.uri === gml && tag.local === "Polygon") polygon = [];
    if (polygon && tag.local === "posList" && tag.attributes.srsDimension?.value !== "3")
      throw new Error("Site building tile has unsupported coordinate dimensions");
  });
  parser.on("text", value => { text += value; });
  parser.on("closetag", tag => {
    const part = parts.at(-1);
    if (part) {
      if (tag.uri === bldg && tag.local === "measuredHeight") part.height = measuredHeight(text.trim());
      if (tag.uri === bldg && tag.local === "roofType") part.roof = text.trim() || null;
      if (tag.local === "ThoroughfareName") street = text.trim();
      if (tag.local === "ThoroughfareNumber") number = text.trim();
      if (polygon && tag.uri === gml && tag.local === "posList") {
        const coords = text.trim().split(/\s+/).map(Number);
        if (coords.length < 12 || coords.length % 3 || !coords.every(Number.isFinite)) throw new Error("Site building tile has invalid coordinates");
        const ring: [number, number][] = [];
        for (let i = 0; i < coords.length; i += 3) ring.push(localXZ([coords[i]!, coords[i + 1]!], origin));
        polygon.push(ring);
      }
      if (polygon && tag.uri === gml && tag.local === "Polygon") { part.polygons.push(polygon); polygon = null; }
      if (tag.uri === bldg && ["Building", "BuildingPart"].includes(tag.local)) {
        parts.pop();
        part.label = [street, number].filter(Boolean).join(" ") || "Building";
        const points = part.polygons.flat(2);
        if (points.length && Math.min(...points.map(p => p[0])) <= radius && Math.max(...points.map(p => p[0])) >= -radius
          && Math.min(...points.map(p => p[1])) <= radius && Math.max(...points.map(p => p[1])) >= -radius) buildings.push(part);
      }
    }
    stack.pop(); text = "";
  });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 100_000_000) throw new Error("Site building tile exceeds bounded import budget");
      parser.write(decoder.decode(value, { stream: true }));
    }
    parser.write(decoder.decode()).close();
    if (!validCrs) throw new Error("Site building tile has unsupported coordinate reference system");
  } finally { await reader.cancel().catch(() => {}); }
  return buildings;
}

export async function importRlpBuildings(origin: [number, number], radius: number, signal: AbortSignal) {
  const buildings = new Map<string, LocationBuilding>(), sources: LocationContext["sources"] = [];
  // The official tiles are 2 km squares. Fetch every intersecting tile, also
  // when the address is just across a tile boundary (as at Bendenweg 6).
  for (let x = Math.floor((origin[0] - radius) / 2000); x <= Math.floor((origin[0] + radius) / 2000); x++) {
    for (let y = Math.floor((origin[1] - radius) / 2000); y <= Math.floor((origin[1] + radius) / 2000); y++) {
      const url = `https://geobasis-rlp.de/data/geb3dlo/current/gml/LoD2_32_${x * 2}_${y * 2}_2_RP.gml`;
      const response = await fetch(url, { signal });
      for (const building of await readBuildings(response, origin, radius)) buildings.set(building.id, building);
      sources.push({ label: `©GeoBasis-DE / LVermGeoRP ${new Date().getUTCFullYear()}, dl-de/by-2-0, www.lvermgeo.rlp.de [Daten bearbeitet]; LoD2 ground footprints and recorded heights only`, url, surveyedAt: null });
    }
  }
  return { buildings: [...buildings.values()], sources };
}
