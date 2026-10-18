import type { LocationContext, LocationScene } from "./location";
import { toUtm, utmZone } from "./site-plan";

/**
 * Site context export for CAD and GIS: surrounding buildings, trees, planning
 * masses and the address point: DXF in source ETRS89 / UTM metres (zones 32/33),
 * GeoJSON in WGS84 longitude/latitude. A display export of imported public data,
 * never a surveyed Lageplan; every file says so.
 */
export const siteExportFormats = ["geojson", "dxf"] as const;
export type SiteExportFormat = typeof siteExportFormats[number];
type Ring = [number, number][];
export type SiteExportFeature =
  | { layer: "buildings"; id: string; label: string; height: number | null; roof: string | null; sourceId: string; polygons: Ring[][] }
  | { layer: "trees"; id: string; label: string; height: number | null; crownDiameter: number | null; sourceId: string; position: [number, number] }
  | { layer: "planning"; id: string; label: string; height: number; note: string; ring: Ring }
  | { layer: "address"; id: string; label: string; position: [number, number] };

export const siteExportDisclaimer = "Richtfest 2D site context export from public data and planning objects. Heights are attributes/labels only, not surveyed elevations. Display geometry, not a surveyed Lageplan or setting-out; IFC objects are bounding footprints, not meshes.";
const crsOf = (context: LocationContext) => context.crs ?? "EPSG:25833";
const round = (value: number) => Math.round(value * 1000) / 1000;

/** Local scene metres (X east, Z south) to projected coordinates. */
export function sceneToCrs(context: LocationContext, x: number, z: number): [number, number] {
  return [round(context.origin[0] + x), round(context.origin[1] - z)];
}

export function siteExportFeatures(context: LocationContext, scene: LocationScene | null): SiteExportFeature[] {
  const point = ([x, z]: [number, number]) => sceneToCrs(context, x, z);
  const masses = (scene?.objects ?? []).filter(object => object.kind === "mass" || object.kind === "ifc").map(object => {
    const angle = object.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const [w, d] = [object.size[0] / 2, object.size[2] / 2];
    // Inverse of the editor's envelope rotation: world offset = Rᵀ · local offset.
    const ring = ([[-w, -d], [w, -d], [w, d], [-w, d], [-w, -d]] as const).map(([x, z]) =>
      sceneToCrs(context, object.position[0] + cos * x + sin * z, object.position[2] - sin * x + cos * z));
    return { layer: "planning" as const, id: object.id, label: object.label, height: round(object.size[1]), note: object.note, ring };
  });
  return [
    { layer: "address", id: context.siteId, label: context.address, position: sceneToCrs(context, 0, 0) },
    ...context.buildings.map(building => ({ layer: "buildings" as const, id: building.id, label: building.label, height: building.height, roof: building.roof, sourceId: building.sourceId,
      polygons: building.polygons.map(polygon => polygon.map(ring => ring.map(point))) })),
    ...context.trees.map(tree => ({ layer: "trees" as const, id: tree.id, label: tree.species, height: tree.height, crownDiameter: tree.crownDiameter, sourceId: tree.sourceId, position: point(tree.position) })),
    ...masses,
  ];
}

export function siteGeoJson(context: LocationContext, scene: LocationScene | null) {
  // Invert the shared display projection, not the address geocoder: every vertex
  // must retain its own position. ETRS89/WGS84 epoch differences are unsurveyed.
  const geographic = ([east, north]: [number, number]): [number, number] => {
    const zone = utmZone(context.crs);
    let lon = zone * 6 - 183, lat = north / 111_000;
    for (let i = 0; i < 8; i++) {
      const p = toUtm(lon, lat, zone), dx = toUtm(lon + 0.00001, lat, zone), dy = toUtm(lon, lat + 0.00001, zone);
      const a = (dx[0] - p[0]) / 0.00001, b = (dy[0] - p[0]) / 0.00001;
      const c = (dx[1] - p[1]) / 0.00001, d = (dy[1] - p[1]) / 0.00001;
      const determinant = a * d - b * c, e = east - p[0], n = north - p[1];
      lon += (d * e - b * n) / determinant;
      lat += (a * n - c * e) / determinant;
    }
    return [lon, lat];
  };
  // RFC 7946 right-hand rule: exterior CCW, interior CW.
  const polygon = (rings: Ring[]) => rings.map((ring, index) => {
    const points = ring.map(geographic);
    const area = points.reduce((sum, p, i) => {
      const next = points[(i + 1) % points.length]!;
      return sum + p[0] * next[1] - next[0] * p[1];
    }, 0);
    return (index === 0 ? area < 0 : area > 0) ? points.reverse() : points;
  });
  const features = siteExportFeatures(context, scene).map(feature => {
    const { layer, id, label } = feature;
    if (feature.layer === "buildings") return { type: "Feature", id, properties: { layer, label, height: feature.height, roof: feature.roof, sourceId: feature.sourceId }, geometry: { type: "MultiPolygon", coordinates: feature.polygons.map(polygon) } };
    if (feature.layer === "planning") return { type: "Feature", id, properties: { layer, label, height: feature.height, note: feature.note }, geometry: { type: "Polygon", coordinates: polygon([feature.ring]) } };
    if (feature.layer === "trees") return { type: "Feature", id, properties: { layer, label, height: feature.height, crownDiameter: feature.crownDiameter, sourceId: feature.sourceId }, geometry: { type: "Point", coordinates: geographic(feature.position) } };
    return { type: "Feature", id, properties: { layer, label }, geometry: { type: "Point", coordinates: geographic(feature.position) } };
  });
  return JSON.stringify({ type: "FeatureCollection", name: context.address,
    metadata: { disclaimer: siteExportDisclaimer, sourceCrs: crsOf(context), sourceOrigin: context.origin, coordinateFormat: "WGS84 longitude, latitude (RFC 7946)", dimensions: 2, address: context.address, importedAt: context.importedAt, sources: context.sources }, features }, null, 2);
}

const dxfLayers = { buildings: "RF_GEBAEUDE", trees: "RF_BAEUME", planning: "RF_PLANUNG", address: "RF_ADRESSE", labels: "RF_BESCHRIFTUNG" } as const;
/** DXF 2007 (AC1021), whose on-disk text encoding is UTF-8. Horizontal UTM metres only. */
export function siteDxf(context: LocationContext, scene: LocationScene | null) {
  const out: string[] = [];
  const pair = (code: number, value: string | number) => out.push(String(code), typeof value === "number" ? String(round(value)) : value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\\/g, "\\U+005C").slice(0, 250));
  const polyline = (layer: string, ring: Ring) => {
    const vertices = ring.slice(0, ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? -1 : undefined);
    pair(0, "LWPOLYLINE"); pair(100, "AcDbEntity"); pair(8, layer); pair(100, "AcDbPolyline"); pair(90, vertices.length); pair(70, 1); pair(38, 0);
    for (const [x, y] of vertices) { pair(10, x); pair(20, y); }
  };
  const text = (at: [number, number], value: string, height = 0.8) => { pair(0, "TEXT"); pair(100, "AcDbEntity"); pair(8, dxfLayers.labels); pair(100, "AcDbText"); pair(10, at[0]); pair(20, at[1]); pair(30, 0); pair(40, height); pair(1, value); pair(100, "AcDbText"); };
  const centre = (ring: Ring) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length] as [number, number];
  const height = (value: number | null) => value === null ? "" : ` · ${value.toLocaleString("de-DE", { maximumFractionDigits: 1 })} m`;
  pair(999, siteExportDisclaimer); pair(999, `${crsOf(context)} · ${context.address}`);
  pair(0, "SECTION"); pair(2, "HEADER"); pair(9, "$ACADVER"); pair(1, "AC1021"); pair(9, "$INSUNITS"); pair(70, 6); pair(0, "ENDSEC");
  pair(0, "SECTION"); pair(2, "TABLES"); pair(0, "TABLE"); pair(2, "LAYER"); pair(5, "1"); pair(100, "AcDbSymbolTable"); pair(70, Object.keys(dxfLayers).length);
  Object.values(dxfLayers).forEach((layer, index) => { pair(0, "LAYER"); pair(100, "AcDbSymbolTableRecord"); pair(100, "AcDbLayerTableRecord"); pair(2, layer); pair(70, 0); pair(62, [8, 3, 5, 1, 7][index]!); pair(6, "CONTINUOUS"); });
  pair(0, "ENDTAB"); pair(0, "ENDSEC");
  pair(0, "SECTION"); pair(2, "ENTITIES");
  for (const feature of siteExportFeatures(context, scene)) {
    if (feature.layer === "buildings") {
      for (const polygon of feature.polygons) for (const ring of polygon) polyline(dxfLayers.buildings, ring);
      const outer = feature.polygons[0]?.[0]; if (outer?.length) text(centre(outer), `${feature.label}${height(feature.height)}`);
    } else if (feature.layer === "planning") {
      polyline(dxfLayers.planning, feature.ring); text(centre(feature.ring.slice(0, -1)), `${feature.label}${height(feature.height)}`);
    } else if (feature.layer === "trees") {
      pair(0, "CIRCLE"); pair(100, "AcDbEntity"); pair(8, dxfLayers.trees); pair(100, "AcDbCircle"); pair(10, feature.position[0]); pair(20, feature.position[1]); pair(30, 0); pair(40, (feature.crownDiameter ?? 2) / 2);
    } else {
      pair(0, "POINT"); pair(100, "AcDbEntity"); pair(8, dxfLayers.address); pair(100, "AcDbPoint"); pair(10, feature.position[0]); pair(20, feature.position[1]); pair(30, 0);
      text([feature.position[0] + 1, feature.position[1] + 1], feature.label, 1);
    }
  }
  pair(0, "ENDSEC"); pair(0, "EOF");
  return out.join("\r\n") + "\r\n";
}

/** The same final UTF-8 bytes used by the download endpoint. Never encode as Latin-1. */
export function siteDxfBytes(context: LocationContext, scene: LocationScene | null): Uint8Array {
  return new TextEncoder().encode(siteDxf(context, scene));
}
