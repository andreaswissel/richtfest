/**
 * Synthetic CAD-style floor plan for extraction tests: an A3 landscape sheet at
 * 1:100 with optional-content layers, filled construction walls (rectangles and
 * L-shaped pieces), door openings with swing arcs, window gaps in the exterior
 * wall, an L-shaped living room and an L-shaped corridor. Coordinates below are
 * metres inside the apartment; the page is PDF points.
 */
type Rect = [x0: number, y0: number, x1: number, y1: number];
type Poly = [number, number][];
export type SyntheticRoom = { label: string; area: number; labelAt: [number, number]; cells: Rect[] };
export type SyntheticDoor = { hinge: [number, number]; open: [number, number]; closed: [number, number] };

const rect = ([x0, y0, x1, y1]: Rect): Poly => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
export const syntheticPlanWalls: Poly[] = [
  // Exterior (0.3 m): corner pieces are L-shaped source polygons.
  [[-0.3, -0.3], [2, -0.3], [2, 0], [0, 0], [0, 5.5], [-0.3, 5.5]],
  rect([4, -0.3, 10, 0]),
  [[12, -0.3], [14.3, -0.3], [14.3, 4.2], [14, 4.2], [14, 0], [12, 0]],
  rect([14, 5.2, 14.3, 7]),
  [[14, 8.5], [14.3, 8.5], [14.3, 10.3], [7, 10.3], [7, 10], [14, 10]],
  rect([2.5, 10, 6, 10.3]),
  [[-0.3, 7], [0, 7], [0, 10], [1, 10], [1, 10.3], [-0.3, 10.3]],
  // Interior (0.12 m) with door openings.
  [[3.44, 3.94], [9, 3.94], [9, 4.06], [3.56, 4.06], [3.56, 6], [3.44, 6]],
  rect([3.44, 6.9, 3.56, 10]),
  rect([7.94, 0, 8.06, 3.94]),
  rect([9.9, 3.94, 14, 4.06]),
  [[4.94, 5.44], [6, 5.44], [6, 5.56], [5.06, 5.56], [5.06, 10], [4.94, 10]],
  rect([6.8, 5.44, 10, 5.56]),
  rect([10.9, 5.44, 14, 5.56]),
  rect([7.94, 5.56, 8.06, 10]),
];
export const syntheticPlanRooms: SyntheticRoom[] = [
  { label: "Wohnen", area: 53, labelAt: [1.5, 1.8], cells: [[0, 0, 8, 4], [0, 4, 3.5, 10]] },
  { label: "Küche", area: 24, labelAt: [11, 1.8], cells: [[8, 0, 14, 4]] },
  { label: "Flur", area: 22.5, labelAt: [4.25, 8], cells: [[3.5, 4, 5, 10], [5, 4, 14, 5.5]] },
  { label: "Bad", area: 13.5, labelAt: [6.5, 7.5], cells: [[5, 5.5, 8, 10]] },
  { label: "Schlafen", area: 27, labelAt: [11, 7.5], cells: [[8, 5.5, 14, 10]] },
];
export const syntheticPlanDoors: SyntheticDoor[] = [
  { hinge: [3.5, 6], closed: [3.5, 6.9], open: [2.6, 6] },
  { hinge: [9, 4], closed: [9.9, 4], open: [9, 3.1] },
  { hinge: [6, 5.5], closed: [6.8, 5.5], open: [6, 6.3] },
  { hinge: [10, 5.5], closed: [10.9, 5.5], open: [10, 6.4] },
  { hinge: [14, 4.2], closed: [14, 5.2], open: [13, 4.2] },
];

export type SyntheticPlanOptions = {
  /** Apartment fill on a "Füllflächen" layer with a "WE 1" marker. */
  unitFill?: boolean;
  /** Every wall in one compound non-zero fill path, as many CAD exports do. */
  mergedWalls?: boolean;
  /** Wohnen↔Küche door whose far side is the face of a perpendicular wall: only one jamb, marked by its swing arc. */
  cornerDoor?: boolean;
  /** Semicircular bay in the bedroom's south wall, drawn with Bézier curves. */
  curvedBay?: boolean;
  /** Drawing scale denominator (default 1:100) and page size in points (default A3 landscape). */
  scale?: number; page?: [number, number];
};
export const syntheticBayArea = Math.PI * 1.5 ** 2 / 2;
export function syntheticPlan(options: SyntheticPlanOptions = {}) {
  const walls = syntheticPlanWalls.slice(), doors = syntheticPlanDoors.slice();
  const rooms = syntheticPlanRooms.map(room => ({ ...room }));
  if (options.cornerDoor) {
    walls[walls.findIndex(w => w[0][0] === 7.94 && w[0][1] === 0)] = rect([7.94, 0, 8.06, 3]);
    doors.push({ hinge: [8, 3], closed: [8, 3.94], open: [7.06, 3] });
  }
  if (options.curvedBay) {
    walls[walls.findIndex(w => w[0][0] === 14 && w[0][1] === 8.5)] = [[14, 8.5], [14.3, 8.5], [14.3, 10.3], [12.8, 10.3], [12.8, 10], [14, 10]];
    walls.push(rect([7, 10, 9.2, 10.3]));
    rooms.find(room => room.label === "Schlafen")!.area = 27 + syntheticBayArea;
  }
  return { walls, doors, rooms };
}

export function syntheticPlanPdf(options: SyntheticPlanOptions = {}) {
  const { unitFill = false } = options, { walls, doors, rooms } = syntheticPlan(options);
  const [width, height] = options.page ?? [1190.55, 841.89], k = 72 / 25.4 * 1000 / (options.scale ?? 100), ox = 150, oy = 150;
  const X = (x: number) => (ox + x * k).toFixed(3), Y = (y: number) => (height - (oy + y * k)).toFixed(3);
  const path = (poly: Poly) => poly.map(([x, y], i) => `${X(x)} ${Y(y)} ${i ? "l" : "m"}`).join(" ") + " h";
  const text = (value: string, x: number, y: number, size = 9) => `BT /F1 ${size} Tf ${X(x)} ${Y(y)} Td (${value}) Tj ET`;
  const arc = ({ hinge: [hx, hy], open: [ax, ay], closed: [bx, by] }: SyntheticDoor) => {
    const c = 0.5523;
    // Quarter circle from the open leaf end to the closed jamb, centred on the hinge.
    const c1: [number, number] = [ax + (bx - hx) * c, ay + (by - hy) * c], c2: [number, number] = [bx + (ax - hx) * c, by + (ay - hy) * c];
    return `${X(hx)} ${Y(hy)} m ${X(ax)} ${Y(ay)} l S ${X(ax)} ${Y(ay)} m ${X(c1[0])} ${Y(c1[1])} ${X(c2[0])} ${Y(c2[1])} ${X(bx)} ${Y(by)} c S`;
  };
  // Curved wall ring between radius 1.5 and 1.8 m below y = 10, centred at x = 11, as four cubic quarter arcs.
  const bay = () => {
    const c = 0.5523, cx = 11, cy = 10, quarter = (r: number, from: number, to: number) => {
      const p = (a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)], [x0, y0] = p(from), [x3, y3] = p(to), d = to > from ? 1 : -1;
      const c1 = [x0 - d * c * r * Math.sin(from), y0 + d * c * r * Math.cos(from)], c2 = [x3 + d * c * r * Math.sin(to), y3 - d * c * r * Math.cos(to)];
      return `${X(c1[0])} ${Y(c1[1])} ${X(c2[0])} ${Y(c2[1])} ${X(x3)} ${Y(y3)} c`;
    };
    return `${X(12.5)} ${Y(10)} m ${quarter(1.5, 0, Math.PI / 2)} ${quarter(1.5, Math.PI / 2, Math.PI)} ${X(9.2)} ${Y(10)} l ${quarter(1.8, Math.PI, Math.PI / 2)} ${quarter(1.8, Math.PI / 2, 0)} h`;
  };
  const latin = (value: string) => value.replace(/ü/g, "\\374").replace(/²/g, "\\262");
  const content = [
    ...(unitFill ? ["/OC /oc3 BDC 0.9 g", path(rect([0, 0, 14, 10])), "f* EMC"] : []),
    "/OC /oc1 BDC 0.25 g", ...(options.mergedWalls ? [walls.map(path).join(" ") + " f"] : walls.map(path).map(p => p + " f")),
    ...(options.curvedBay ? [bay() + " f"] : []), "EMC",
    "/OC /oc2 BDC 0.4 w 0 G", ...doors.map(arc), "EMC",
    "/OC /oc4 BDC 0 g",
    ...rooms.flatMap(room => [text(latin(room.label), room.labelAt[0] - .4, room.labelAt[1]),
      text(latin(`${room.area.toFixed(2).replace(".", ",")} m²`), room.labelAt[0] - .4, room.labelAt[1] + .45, 7)]),
    ...(unitFill ? [text("WE 1", 12.5, 9.3)] : []),
    `BT /F1 12 Tf ${width - 220} 60 Td (Grundriss EG) Tj ET`, `BT /F1 9 Tf ${width - 220} 40 Td (M 1:${options.scale ?? 100}) Tj ET`, "EMC",
  ].join("\n");
  const layers = ["Konstruktion", "Türen", "Füllflächen", "Beschriftung"];
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R 7 0 R 8 0 R 9 0 R] /D << /Order [6 0 R 7 0 R 8 0 R 9 0 R] /ON [6 0 R 7 0 R 8 0 R 9 0 R] >> >> >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /Properties << /oc1 6 0 R /oc2 7 0 R /oc3 8 0 R /oc4 9 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    ...layers.map(name => `<< /Type /OCG /Name (${latin(name).replace("ä", "\\344")}) >>`),
  ];
  let body = "%PDF-1.6\n%\xe2\xe3\xcf\xd3\n";
  const offsets = objects.map((object, i) => { const offset = Buffer.byteLength(body, "latin1"); body += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}
