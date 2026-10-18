import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  compassOf, ok, placementForPage, planToSite, roadSurfaceTypeSchema, toUtm, utmZone,
  type FacadeLevel, type FacadeLevelLimitation, type FacadeLevelSource, type FacadeNoiseLevels, type LocationContext, type NoiseSource,
  type Point2, type RatingLevelContribution, type RoadClass, type RoadNoiseReceiver, type RoadNoiseSource,
} from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { modelForProject, readSitePlan } from "./building-model-router";
import { readNoiseSources } from "./noise-sources";
import { buildingStoreys, projectLocations as locations } from "./schema";

/**
 * Road rating levels and relevant exterior noise levels at every exterior
 * facade of the placed plan, storey by storey. The receiver sits 5 cm in front
 * of the outer wall face at the height of the storey's ceiling. Values are a
 * draft for the planner: inputs, defaults and limitations travel with them.
 */

// Working assumptions, not normative values; each one is reported where it is used.
export const STOREY_HEIGHT_M = 3;
const LANE_WIDTH_M = 3.5;
const URBAN_SPEED_KMH = 50;
const RECEIVER_OFFSET_M = 0.05;

const roadClassOf = (dedication: string | null): RoadClass =>
  dedication === "1301" ? "motorway" : dedication === "1303" ? "federal" : dedication === "1305" || dedication === "1306" ? "state_district" : "municipal";

type SiteWall = { id: string; name: string; ring: Point2[] };
export type FacadeReceiver = { wallId: string; wallName: string; point: Point2; normal: Point2 };

/** The outer face of each exterior wall: of its long edges, the one farthest from the building centre, with its outward normal. */
export function facadeReceivers(walls: SiteWall[]): FacadeReceiver[] {
  const all = walls.flatMap(wall => wall.ring);
  if (!all.length) return [];
  const centre: Point2 = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length];
  const receivers: FacadeReceiver[] = [];
  for (const wall of walls) {
    const edges = wall.ring.map((a, i) => {
      const b = wall.ring[(i + 1) % wall.ring.length]!;
      const mid: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return { a, b, mid, length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    });
    const longest = Math.max(...edges.map(edge => edge.length));
    if (longest < 0.5) continue;
    const outer = edges.filter(edge => edge.length >= 0.6 * longest)
      .reduce((best, edge) => Math.hypot(edge.mid[0] - centre[0], edge.mid[1] - centre[1]) > Math.hypot(best.mid[0] - centre[0], best.mid[1] - centre[1]) ? edge : best);
    let normal: Point2 = [-(outer.b[1] - outer.a[1]) / outer.length, (outer.b[0] - outer.a[0]) / outer.length];
    if ((outer.mid[0] - centre[0]) * normal[0] + (outer.mid[1] - centre[1]) * normal[1] < 0) normal = [-normal[0], -normal[1]];
    receivers.push({ wallId: wall.id, wallName: wall.name, normal, point: [outer.mid[0] + normal[0] * RECEIVER_OFFSET_M, outer.mid[1] + normal[1] * RECEIVER_OFFSET_M] });
  }
  return receivers;
}

const numberInput = (source: NoiseSource, key: string) => {
  const value = source.inputs[key]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** A mapped road as a calculation source, with the defaults it needed. */
function roadSource(source: NoiseSource, zone: 32 | 33): { input: RoadNoiseSource; defaults: FacadeLevelSource["defaults"] } | null {
  const mapped = source.mapped;
  if (mapped?.kind !== "road" || !mapped.axes?.length) return null;
  const roadClass = roadClassOf(mapped.dedication);
  const defaults: FacadeLevelSource["defaults"] = [];
  let speedLimitKmh = numberInput(source, "speedLimit");
  if (speedLimitKmh === null && roadClass === "municipal") { speedLimitKmh = URBAN_SPEED_KMH; defaults.push({ key: "speedLimit", value: URBAN_SPEED_KMH }); }
  const lanes = mapped.lanes && mapped.lanes > 0 ? mapped.lanes : null;
  const laneWidthM = lanes && mapped.carriagewayWidthM ? mapped.carriagewayWidthM / lanes : LANE_WIDTH_M;
  if (!(lanes && mapped.carriagewayWidthM)) defaults.push({ key: "laneWidth", value: LANE_WIDTH_M });
  if (!lanes) defaults.push({ key: "lanes", value: 2 });
  const surface = roadSurfaceTypeSchema.safeParse(source.inputs.surfaceType?.value);
  return {
    defaults,
    input: {
      id: source.id, roadClass, dailyTraffic: numberInput(source, "dailyTraffic"), heavyVehicleSharePct: numberInput(source, "heavyVehicleShare"),
      speedLimitKmh, surface: surface.success ? surface.data : null, gradientPct: numberInput(source, "gradient"), lanes, laneWidthM,
      parts: mapped.axes.map(part => part.map(([lon, lat]) => toUtm(lon, lat, zone))),
    },
  };
}

export async function readFacadeNoiseLevels(d: AppDeps, projectId: string): Promise<FacadeNoiseLevels> {
  const host = d.exteriorNoise;
  if (!host) return { available: false, reason: "norm_pack_missing" };
  const [location] = await d.db.select({ context: locations.context }).from(locations).where(and(eq(locations.projectId, projectId), eq(locations.tenantId, d.tenantId))).limit(1);
  const context = location?.context as LocationContext | null | undefined;
  if (!context) return { available: false, reason: "location_missing" };
  const crs = context.crs ?? "EPSG:25833";
  const sitePlan = await readSitePlan(d, projectId);
  const page = sitePlan.pages.find(candidate => placementForPage(sitePlan.placement, candidate, crs));
  const placement = page && placementForPage(sitePlan.placement, page, crs);
  if (!page || !placement || !sitePlan.placement) return { available: false, reason: "placement_missing" };
  const exterior = page.walls.filter(wall => wall.exterior);
  if (!exterior.length) return { available: false, reason: "exterior_walls_missing" };
  const model = await modelForProject(d, projectId);
  const storeyRows = model ? await d.db.select({ id: buildingStoreys.id, name: buildingStoreys.name, levelIndex: buildingStoreys.levelIndex }).from(buildingStoreys)
    .where(and(eq(buildingStoreys.modelId, model.model.id), eq(buildingStoreys.tenantId, d.tenantId))) : [];
  // Storeys above ground; a model without storey levels is treated as one ground floor.
  const aboveGround = (storeyRows as Array<{ id: string; name: string; levelIndex: number | null }>).filter(row => row.levelIndex !== null && row.levelIndex >= 0)
    .sort((a, b) => a.levelIndex! - b.levelIndex!);
  const storeys = aboveGround.length ? aboveGround.map(row => ({ id: row.id, name: row.name, levelIndex: row.levelIndex! })) : [{ id: null, name: "", levelIndex: 0 }];

  const walls = exterior.map(wall => ({ id: wall.id, name: wall.name, ring: wall.ring.map(point => planToSite(point, placement)) }));
  const faces = facadeReceivers(walls);
  const receivers: Array<RoadNoiseReceiver & { face: FacadeReceiver; storey: (typeof storeys)[number] }> = storeys.flatMap(storey => faces.map(face => ({
    id: `${face.wallId}:${storey.levelIndex}`, face, storey, normal: face.normal,
    position: [face.point[0], face.point[1], (storey.levelIndex + 1) * STOREY_HEIGHT_M] as [number, number, number],
  })));

  const zone = utmZone(context.crs);
  const noiseSources = await readNoiseSources(d, projectId);
  const sources: FacadeLevelSource[] = [];
  const roads: RoadNoiseSource[] = [];
  const rail: RatingLevelContribution[] = [];
  for (const source of noiseSources) {
    const base = { id: source.id, name: source.name, kind: source.kind, issues: [] as string[], notes: [] as string[], emission: null, defaults: [] as FacadeLevelSource["defaults"] };
    if (source.kind === "rail") {
      const day = numberInput(source, "ratingLevelDay"), night = numberInput(source, "ratingLevelNight");
      if (day === null || night === null) sources.push({ ...base, status: "missing_inputs", issues: ["missing_rating_levels"] });
      else { rail.push({ sourceId: source.id, kind: "rail", dayDb: day, nightDb: night }); sources.push({ ...base, status: "imported" }); }
      continue;
    }
    const road = roadSource(source, zone);
    if (!road) { sources.push({ ...base, status: "no_geometry" }); continue; }
    roads.push(road.input);
    sources.push({ ...base, status: "calculated", defaults: road.defaults });
  }
  const levels = host.roadRatingLevels(roads, receivers);
  for (const result of levels) {
    const entry = sources.find(source => source.id === result.sourceId);
    if (!entry || entry.emission || entry.status === "missing_inputs") continue;
    if (!result.ok) { Object.assign(entry, { status: "missing_inputs", issues: result.emission.issues, notes: result.emission.notes }); continue; }
    const period = (p: typeof result.emission.day) => ({ hourlyTraffic: p.hourlyTraffic, truck1Pct: p.truck1Pct, truck2Pct: p.truck2Pct, lineLevelDb: p.lineLevelDb });
    Object.assign(entry, { notes: result.emission.notes, emission: { day: period(result.emission.day), night: period(result.emission.night), speedKmh: result.emission.day.speedKmh } });
  }

  const facades: FacadeLevel[] = receivers.map(receiver => {
    const road = levels.filter((item): item is Extract<typeof item, { ok: true }> => item.ok && item.receiverId === receiver.id && item.dayDb !== null && item.nightDb !== null);
    const contributions: RatingLevelContribution[] = [...road.map(item => ({ sourceId: item.sourceId, kind: "road" as const, dayDb: item.dayDb!, nightDb: item.nightDb! })), ...rail];
    const level = host.exteriorNoiseLevel(contributions);
    return {
      id: receiver.id, wallId: receiver.face.wallId, wallName: receiver.face.wallName,
      storey: receiver.storey, compass: compassOf(receiver.face.normal),
      receiver: { x: receiver.position[0], y: receiver.position[1], heightM: receiver.position[2] },
      sources: contributions.map(item => ({ sourceId: item.sourceId, dayDb: item.dayDb, nightDb: item.nightDb })),
      level: level && { dayDb: level.dayDb, nightDb: level.nightDb, sleepingDb: level.sleepingDb },
      basis: level ? "calculated" : "none",
    };
  });
  // Facades turned away from the sources: without screening in the model, they take the
  // permitted reduction from the loudest facade of the storey (open development) as a floor.
  let turnedAway = false;
  const reduction = host.turnedAwayReductionDb.open;
  for (const storey of storeys) {
    const onStorey = facades.filter(facade => facade.storey.levelIndex === storey.levelIndex);
    const loudest = onStorey.filter(facade => facade.level).reduce<FacadeLevel | null>((best, facade) => !best || facade.level!.sleepingDb > best.level!.sleepingDb ? facade : best, null);
    if (!loudest?.level) continue;
    for (const facade of onStorey) {
      const floor = { dayDb: loudest.level.dayDb - reduction, nightDb: loudest.level.nightDb - reduction, sleepingDb: loudest.level.sleepingDb - reduction };
      if (!facade.level || facade.level.sleepingDb < floor.sleepingDb) { facade.level = floor; facade.basis = "turned_away"; turnedAway = true; }
    }
  }
  const limitations: FacadeLevelLimitation[] = ["free_propagation", "flat_ground", "no_reflections", "no_junction_correction", "storey_height_assumed"];
  if (rail.length) limitations.push("rail_imported_all_facades");
  if (turnedAway) limitations.push("turned_away_reduction");
  return {
    available: true,
    editions: { rls19: host.editions.rls19, din4109: host.editions.din4109, pack: host.packId },
    placement: { alignmentStatus: sitePlan.placement.alignmentStatus, page: page.page, fileName: page.fileName },
    storeyHeightM: STOREY_HEIGHT_M, sources, facades, limitations,
  };
}

export function createExteriorNoiseLevelsRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.get("/projects/:projectId/exterior-noise/facade-levels", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("projects:read");
      const projectId = z.string().uuid().parse(req.params.projectId);
      res.json(ok(await readFacadeNoiseLevels(d, projectId)));
    } catch (error) { next(error); }
  });
  return router;
}
