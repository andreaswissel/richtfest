import type { GeometryMultiPolygon, GeometryPoint, SiteGeometryInput } from "@richtfest/shared/site-geometry-model";

export type MiniPlanFocus = "parcel" | "building_land" | "envelope" | "boundary" | "buildings";

/**
 * Read-only site plan for one planning limit: the parcel with what the limit refers to emphasised. North is up;
 * the drawing fits the parcel and its envelope, so a quick look shows street land, Baufenster or boundary building.
 */
export function SiteMiniPlan({ geometry, focus, label }: { geometry: SiteGeometryInput; focus: MiniPlanFocus; label: string }) {
  const parcel = geometry.parcel?.geometry;
  if (!parcel) return null;
  const shapes: GeometryMultiPolygon[] = [parcel, ...(geometry.envelope ? [geometry.envelope.geometry] : []), ...geometry.exclusions.map((e) => e.geometry)];
  const points = shapes.flat(3);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(maxX - minX, maxY - minY, 1), pad = span * 0.08;
  const width = maxX - minX + pad * 2, height = maxY - minY + pad * 2;
  // SVG y grows downwards; northing grows upwards.
  const at = ([x, y]: GeometryPoint) => `${(x - minX + pad).toFixed(2)},${(maxY - y + pad).toFixed(2)}`;
  const path = (polygons: GeometryMultiPolygon) => polygons.map((rings) => rings.map((ring) => `M${ring.map(at).join("L")}Z`).join("")).join("");
  const nonBuilding = geometry.exclusions.filter((e) => e.nonBuildingLand);
  const stroke = span / 220;
  return (
    <svg className="site-mini-plan" viewBox={`0 0 ${width.toFixed(2)} ${height.toFixed(2)}`} role="img" aria-label={label} data-focus={focus} style={{ ["--mini-stroke" as string]: stroke }}>
      <defs>
        <pattern id="site-mini-hatch" width={span / 60} height={span / 60} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2={span / 60} className="site-mini-hatch-line" strokeWidth={stroke} />
        </pattern>
      </defs>
      <path className="site-mini-parcel" d={path(parcel)} strokeWidth={stroke * (focus === "parcel" || focus === "boundary" ? 2.5 : 1.2)} />
      {geometry.envelope && <path className="site-mini-envelope" d={path(geometry.envelope.geometry)} data-active={focus === "envelope" || undefined} strokeWidth={stroke * (focus === "envelope" ? 2 : 1)} />}
      {nonBuilding.map((e) => <path key={e.id} className="site-mini-street" d={path(e.geometry)} fill="url(#site-mini-hatch)" data-active={focus === "building_land" || undefined} strokeWidth={stroke} />)}
      {geometry.buildings.map((b) => <path key={b.id} className="site-mini-building" d={path(b.footprint.geometry)} data-active={focus === "buildings" || focus === "boundary" || undefined} strokeWidth={stroke} />)}
      {(geometry.mandatoryLines ?? []).map((l) => <path key={l.id} className="site-mini-line" d={`M${l.line.map(at).join("L")}`} strokeWidth={stroke * 2} />)}
    </svg>
  );
}
