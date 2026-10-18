/**
 * Regenerates the bundled administrative areas used to find a site's federal state
 * (richtfest-apps/projects/src/data/vg250-*.json) from BKG VG250 (open, dl-de/by-2-0).
 *
 *   bun scripts/build-address-areas.ts
 *
 * - vg250-states.json: the 16 Länder land areas (GF 4), Douglas-Peucker simplified with
 *   TOLERANCE_DEG (≈ 170 m), coordinates quantised to 1e-4° and delta-encoded per ring.
 * - vg250-municipalities.json: every municipality (name and AGS), grouped by district key.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const WFS = "https://sgx.geodatenzentrum.de/wfs_vg250";
const TOLERANCE_DEG = 0.0015, MIN_AREA_KM2 = 0.3;
const STATE_BY_KEY: Record<string, string> = { "01": "SH", "02": "HH", "03": "NI", "04": "HB", "05": "NW", "06": "HE", "07": "RP", "08": "BW", "09": "BY", "10": "SL", "11": "BE", "12": "BB", "13": "MV", "14": "SN", "15": "ST", "16": "TH" };
const out = join(import.meta.dir, "../richtfest-apps/projects/src/data");
const source = { source: "VG250 © BKG (2026), dl-de/by-2-0, https://sgx.geodatenzentrum.de/wfs_vg250; Datenquellen: https://sg.geodatenzentrum.de/web_public/gdz/datenquellen/datenquellen_vg_nuts.pdf", retrieved: new Date().toISOString().slice(0, 10) };

async function features(typeName: string, extra: Record<string, string>) {
  const url = new URL(WFS);
  url.search = new URLSearchParams({ SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: typeName, OUTPUTFORMAT: "application/json", COUNT: "20000", ...extra }).toString();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${typeName}: HTTP ${response.status}`);
  return (await response.json()).features as Array<{ properties: Record<string, any>; geometry: { coordinates: number[][][][] } | null }>;
}

type P = [number, number];
function simplify(points: P[], tolerance: number): P[] {
  if (points.length < 4) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a]!, [bx, by] = points[b]!, k = Math.cos(ay * Math.PI / 180);
    const dx = (bx - ax) * k, dy = by - ay, length2 = dx * dx + dy * dy;
    let best = -1, index = -1;
    for (let i = a + 1; i < b; i++) {
      const px = (points[i]![0] - ax) * k, py = points[i]![1] - ay;
      const t = length2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0;
      const distance = Math.hypot(px - t * dx, py - t * dy);
      if (distance > best) { best = distance; index = i; }
    }
    if (best > tolerance) { keep[index] = true; stack.push([a, index], [index, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
const areaKm2 = (ring: P[]) => {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) sum += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  return Math.abs(sum) / 2 * Math.cos(ring[0]![1] * Math.PI / 180) * 111.32 ** 2;
};

const states: Record<string, number[][][]> = {};
for (const feature of await features("vg250:vg250_lan", { SRSNAME: "EPSG:4326" })) {
  if (feature.properties.gf !== 4 || !feature.geometry) continue;
  const state = STATE_BY_KEY[feature.properties.ags]!;
  for (const polygon of feature.geometry.coordinates) {
    const rings: number[][] = [];
    for (const [index, ring] of (polygon as P[][]).entries()) {
      if (areaKm2(ring) < MIN_AREA_KM2) { if (index === 0) break; continue; }
      // Split the closed ring at its farthest vertex so both halves simplify stably.
      let far = 0;
      ring.forEach((point, i) => { if (Math.hypot(point[0] - ring[0]![0], point[1] - ring[0]![1]) > Math.hypot(ring[far]![0] - ring[0]![0], ring[far]![1] - ring[0]![1])) far = i; });
      const simplified = [...simplify(ring.slice(0, far + 1), TOLERANCE_DEG), ...simplify(ring.slice(far), TOLERANCE_DEG).slice(1)];
      if (simplified.length < 4) continue;
      const encoded: number[] = [];
      let px = 0, py = 0;
      for (const [x, y] of simplified.slice(0, -1)) { const X = Math.round(x * 1e4), Y = Math.round(y * 1e4); encoded.push(X - px, Y - py); px = X; py = Y; }
      rings.push(encoded);
    }
    if (rings.length) (states[state] ??= []).push(rings);
  }
}
writeFileSync(join(out, "vg250-states.json"), JSON.stringify({ ...source, toleranceMeters: Math.round(TOLERANCE_DEG * 111320), encoding: "per ring: delta-encoded [lon, lat] * 1e4, first pair absolute, ring implicitly closed", states }));

const municipalities: Record<string, string[]> = {};
for (const { properties: p } of (await features("vg250:vg250_gem", { PROPERTYNAME: "gen,ags,gf" })).sort((a, b) => a.properties.ags.localeCompare(b.properties.ags))) {
  if (p.gf !== 4) continue;
  (municipalities[p.ags.slice(0, 5)] ??= []).push(`${p.ags.slice(5)}${p.gen}`);
}
writeFileSync(join(out, "vg250-municipalities.json"), JSON.stringify({ ...source, encoding: "district key (5 digits) -> '|'-joined municipality key suffix (3 digits) + name", municipalities: Object.fromEntries(Object.entries(municipalities).map(([key, list]) => [key, list.join("|")])) }));
console.log(`states: ${Object.keys(states).length}, municipalities: ${Object.values(municipalities).flat().length}`);
