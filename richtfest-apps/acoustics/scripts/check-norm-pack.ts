/**
 * Checks the road noise method with a norm pack against reference cases such
 * as the TEST-20 tasks. Both files are licensed content kept outside the
 * repository: bun richtfest-apps/acoustics/scripts/check-norm-pack.ts <pack.json> <cases.json>
 */
import { acousticNormPackSchema, type AcousticNormPack } from "@richtfest/shared";
import { attenuation, baseVehicleLevel, gradientCorrection, groupSpeeds, lineLevel, lineRatingLevel, surfaceCorrection } from "../src/road-noise";

type Group = "car" | "truck1" | "truck2";
type Case = { task: string; kind: string; label?: string; expected: unknown; range?: [number, number]; [key: string]: unknown };
const [packPath, casesPath] = process.argv.slice(2);
if (!packPath || !casesPath) throw new Error("Usage: check-norm-pack.ts <pack.json> <cases.json>");
const pack: AcousticNormPack = acousticNormPackSchema.parse(await Bun.file(packPath).json());
const { cases } = await Bun.file(casesPath).json() as { cases: Case[] };
const rls = pack.rls19;
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
// Reference values are printed to two decimals; a hundredth either way is rounding.
const tolerance = 0.011;
let failures = 0;
const report = (item: Case, actual: number | null, expected: number | null) => {
  const ok = expected === null ? actual === null
    : actual !== null && (item.range ? actual >= item.range[0] - tolerance && actual <= item.range[1] + tolerance : Math.abs(actual - expected) <= tolerance);
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${item.task} ${item.label ?? item.kind}  expected ${expected ?? "n/a"}${item.range ? ` (${item.range.join("–")})` : ""}  got ${actual === null ? "n/a" : round(actual, 3)}`);
};
const speedOf = (group: Group, speedKmh: number | null) => {
  const speeds = groupSpeeds(rls, speedKmh === null ? "motorway" : "municipal", speedKmh);
  return speedKmh === null ? speeds![group] : Math.max(speedKmh, rls.speed.minimumKmh);
};
for (const item of cases) {
  const group = item.group as Group;
  if (item.kind === "unsupported") console.log(`skip  ${item.task} ${item.label}  ${item.reason}`);
  else if (item.kind === "base") report(item, baseVehicleLevel(rls, group, speedOf(group, item.speedKmh as number | null)), item.expected as number);
  else if (item.kind === "line_one_vehicle") {
    const speed = { car: item.speedKmh as number, truck1: item.speedKmh as number, truck2: item.speedKmh as number };
    const level = { car: 0, truck1: 0, truck2: 0, [group]: baseVehicleLevel(rls, group, item.speedKmh as number) };
    report(item, lineLevel(1, group === "truck1" ? 100 : 0, group === "truck2" ? 100 : 0, speed, level), item.expected as number);
  } else if (item.kind === "surface") report(item, surfaceCorrection(rls, item.surface as never, group, item.speedKmh as number), item.expected as number | null);
  else if (item.kind === "gradient") report(item, gradientCorrection(rls, group, item.gradientPct as number, item.speedKmh as number), item.expected as number);
  else if (item.kind === "line") report(item, lineLevel(item.hourlyTraffic as number, item.truck1Pct as number, item.truck2Pct as number, item.speedKmh as never, item.vehicleLevelDb as never), item.expected as number);
  else if (item.kind === "free_field") {
    const [x, y, z] = item.receiver as [number, number, number];
    const level = lineRatingLevel(rls, item.line as [number, number][], item.lineLevelDb as number, { id: "r", position: [x, y, z - (item.groundZ as number)], normal: null });
    report(item, level, item.expected as number);
  } else if (item.kind === "piece") {
    const [[ax, ay], [bx, by]] = item.piece as [number, number][];
    const [x, y, z] = item.receiver as [number, number, number];
    const result = attenuation(rls, Math.hypot((ax + bx) / 2 - x, (ay + by) / 2 - y), rls.sourceHeightM, z - (item.groundZ as number));
    for (const [key, expected] of Object.entries(item.expected as Record<string, number>))
      report({ ...item, label: `${item.label} ${key}` }, result[key as keyof typeof result] as number, expected);
  }
}
console.log(failures ? `${failures} failing` : `All supported cases pass (${cases.filter(item => item.kind !== "unsupported").length} of ${cases.length})`);
process.exit(failures ? 1 : 0);
