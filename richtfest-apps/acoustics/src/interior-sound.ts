import type {
  AcousticNormPack, AirborneInput, AirbornePath, AirborneResult, DoorConstruction, DoorResult, ImpactInput, ImpactOtherInput, ImpactOtherResult, ImpactResult, InteriorDoorRole,
  InteriorRequirementLevel, InteriorRequirements, Lining, LiningResult, ServiceInput, ServiceResult, StairInput, StairResult, TimberImpactInput, TimberImpactResult,
} from "@richtfest/shared";

/**
 * Interior sound insulation in massive buildings (DIN 4109-2): the airborne
 * sound insulation between two rooms from the direct path and three flanking
 * paths per edge, and the impact sound level of a massive ceiling with its
 * floating screed. Every normative number comes from the pack; without its
 * interior part nothing is calculated.
 *
 * Junctions are rigid: a T-junction (a continuous flanking element with the
 * separating element abutting it) unless the edge says it is a cross junction
 * and the pack has its coefficients. Flanking elements of different mass on
 * the two sides take their mean mass for the junction, as the catalogue allows.
 * Linings, suspended ceilings and floating screeds improve the faces they
 * cover: the direct path by both of the separating element's, a flanking path
 * by the two faces it leaves and enters.
 */

const lg = Math.log10;
const round = (value: number, decimals: number) => { const factor = 10 ** decimals; return Math.round(value * factor) / factor; };
const energySum = (levels: number[]) => -10 * lg(levels.reduce((sum, level) => sum + 10 ** (-level / 10), 0));

export function airborneSoundInsulation(pack: AcousticNormPack, input: AirborneInput): AirborneResult {
  const method = pack.din4109_interior;
  if (!method) return { status: "unsupported", reason: "method_missing" };
  const a = method.airborne, decimals = method.roundingDecimals;
  if (!input.edges.length) return { status: "unsupported", reason: "no_edges" };
  const ss = input.separatingAreaM2, l0 = a.referenceLengthM;
  if (!(ss > 0) || input.edges.some(edge => !(edge.couplingLengthM > 0))) return { status: "unsupported", reason: "invalid_geometry" };
  const separating = input.separating;
  const combine = (a: number, b: number) => combineLinings(pack, a, b);
  const lining = separating.lightweight ? { source: 0, receiving: 0 } : separating.liningDb ?? { source: 0, receiving: 0 };
  const rDd = separating.rwDb + combine(lining.source, lining.receiving);
  const paths: AirbornePath[] = [];
  for (const edge of input.edges) {
    const { source, receiving } = edge, lf = edge.couplingLengthM;
    if (source.kind === "lightweight" && receiving.kind === "lightweight") {
      // Lightweight flanking elements: path Ff from their Dn,f,w; Df and Fd are neglected.
      const dnfw = Math.min(source.dnfwDb, receiving.dnfwDb);
      const lab = input.transmission === "horizontal" ? a.labEdgeLengthM.horizontal : a.labEdgeLengthM.vertical;
      paths.push({ edge: edge.edge, path: "Ff", from: source.name, to: receiving.name, kijDb: null, kijMinApplied: false,
        rDb: dnfw + 10 * lg(lab / lf) + 10 * lg(ss / a.referenceAbsorptionM2) });
      continue;
    }
    if (source.kind !== "massive" || receiving.kind !== "massive") return { status: "unsupported", reason: "mixed_flanking" };
    if (separating.lightweight) {
      // Mixed construction: massive flanking elements along a lightweight separating element take Kij = Kij,min on path Ff;
      // the lightweight element hardly couples to them, so Df and Fd are not counted.
      const kMin = 10 * lg(lf * l0 * (1 / source.areaM2 + 1 / receiving.areaM2));
      paths.push({ edge: edge.edge, path: "Ff", from: source.name, to: receiving.name, kijDb: kMin, kijMinApplied: true,
        rDb: source.rwDb / 2 + receiving.rwDb / 2 + kMin + 10 * lg(ss / (l0 * lf)) });
      continue;
    }
    const flankingMass = source.id === receiving.id ? source.massKgM2 : (source.massKgM2 + receiving.massKgM2) / 2;
    const m = lg(separating.massKgM2! / flankingMass);
    const junction = edge.junction === "cross" && a.crossJunction ? "cross" : "t";
    const t = junction === "cross" ? a.crossJunction! : a.tJunction;
    const k12 = t.k12.constant + t.k12.square * m * m;
    const k13 = m < t.k13.breakM ? t.k13.below.constant + t.k13.below.linear * m + t.k13.below.square * m * m : t.k13.above.constant + t.k13.above.linear * m;
    const path = (name: AirbornePath["path"], from: { name: string; rw: number; area: number; lining: number }, to: { name: string; rw: number; area: number; lining: number }, k: number) => {
      const kMin = 10 * lg(lf * l0 * (1 / from.area + 1 / to.area));
      const kij = Math.max(k, kMin), improvement = combine(from.lining, to.lining);
      paths.push({ edge: edge.edge, path: name, from: from.name, to: to.name, kijDb: kij, kijMinApplied: kMin > k, junction, ...(improvement ? { liningDb: improvement } : {}),
        rDb: from.rw / 2 + to.rw / 2 + improvement + kij + 10 * lg(ss / (l0 * lf)) });
    };
    const f = { name: source.name, rw: source.rwDb, area: source.areaM2, lining: source.liningDb ?? 0 }, r = { name: receiving.name, rw: receiving.rwDb, area: receiving.areaM2, lining: receiving.liningDb ?? 0 };
    path("Ff", f, r, k13);
    path("Df", { name: separating.name, rw: separating.rwDb, area: ss, lining: lining.source }, r, k12);
    path("Fd", f, { name: separating.name, rw: separating.rwDb, area: ss, lining: lining.receiving }, k12);
  }
  const rwPrime = energySum([rDd, ...paths.map(item => item.rDb)]);
  const small = ss < a.minSeparatingAreaM2;
  const value = small ? rwPrime - 10 * lg(ss / a.referenceAbsorptionM2) : rwPrime;
  // The unrounded value is compared; values are reported to the pack's precision.
  const margin = value - a.uncertaintyDb - input.requiredDb;
  return {
    status: "calculated", rDdDb: round(rDd, decimals),
    paths: paths.map(item => ({ ...item, kijDb: item.kijDb === null ? null : round(item.kijDb, decimals), rDb: round(item.rDb, decimals), ...(item.liningDb ? { liningDb: round(item.liningDb, decimals) } : {}) })),
    rwPrimeDb: round(rwPrime, decimals), quantity: small ? "Dn,w" : "R'w", valueDb: round(value, decimals), uncertaintyDb: a.uncertaintyDb,
    requiredDb: input.requiredDb, marginDb: round(margin, decimals), meets: margin >= 0,
    refs: [a.refs.total, a.refs.direct, a.refs.flanking, a.refs.junction, a.refs.kijMin, ...(small ? [a.refs.dnw] : []),
      ...(input.edges.some(edge => edge.source.kind === "lightweight") || separating.lightweight ? [a.refs.lightweight] : []),
      ...(pack.din4109_34 && (rDd !== separating.rwDb || paths.some(item => item.liningDb)) ? [pack.din4109_34.refs.combination] : []), a.refs.uncertainty],
    edition: `${method.editions.method}; ${method.editions.junctions}`,
  };
}

export function impactSoundLevel(pack: AcousticNormPack, input: ImpactInput): ImpactResult {
  const method = pack.din4109_interior;
  if (!method) return { status: "unsupported", reason: "method_missing" };
  const i = method.impact, decimals = method.roundingDecimals;
  const slab = input.slabMassKgM2;
  if (slab < i.bareSlab.minKgM2 || slab > i.bareSlab.maxKgM2) return { status: "unsupported", reason: "slab_mass_out_of_range" };
  const lnEq0 = i.bareSlab.constant - i.bareSlab.slope * lg(slab);
  let deltaLw = 0;
  const refs = [i.refs.total, i.bareSlab.ref];
  if (input.screed) {
    const spec = i.screeds[input.screed.type];
    const { massKgM2: mass, stiffnessMNm3: s } = input.screed;
    if (!spec || s < spec.minStiffness || s > spec.maxStiffness || mass < spec.minMassKgM2 || mass > spec.maxMassKgM2) return { status: "unsupported", reason: "screed_out_of_range" };
    deltaLw = round(spec.massLog * lg(mass) + spec.stiffnessLog * lg(s) + spec.massStiffnessLog * mass * lg(s) + spec.mass * mass + spec.constant, decimals);
    refs.push(spec.ref);
  }
  if (!input.flankingMassesKgM2.length) return { status: "unsupported", reason: "no_massive_flanking" };
  const k = i.flanking;
  const actual = input.flankingMassesKgM2.reduce((sum, value) => sum + value, 0) / input.flankingMassesKgM2.length;
  if (slab < k.minSlabKgM2 || slab > k.maxSlabKgM2 || actual < k.minFlankingKgM2) return { status: "unsupported", reason: "flanking_mass_out_of_range" };
  // Heavier flanking walls than the method covers lower K; capping their mean at the upper limit errs high.
  const mean = Math.min(actual, k.maxFlankingKgM2);
  const kDb = mean <= slab ? round(k.constant + k.slope * lg(slab / mean), decimals) : 0;
  refs.push(k.ref, i.refs.uncertainty);
  const lnw = lnEq0 - deltaLw + kDb;
  const margin = input.maxDb - (lnw + i.uncertaintyDb);
  return { status: "calculated", lnEq0Db: round(lnEq0, decimals), deltaLwDb: deltaLw, kDb, flankingMeanKgM2: round(actual, 1), flankingMassCapped: actual > mean, lnwPrimeDb: round(lnw, decimals),
    uncertaintyDb: i.uncertaintyDb, maxDb: input.maxDb, marginDb: round(margin, decimals), meets: margin >= 0, refs,
    edition: `${method.editions.method}; ${method.editions.junctions}; ${method.editions.screeds}` };
}


/**
 * Requirements per element role for a level. An elevated row replaces the
 * statutory one; where the elevated table has none, the statutory row applies.
 * Null without the interior part, or for the elevated level without its table.
 */
export function interiorRequirements(pack: AcousticNormPack, level: InteriorRequirementLevel): InteriorRequirements | null {
  const method = pack.din4109_interior;
  if (!method) return null;
  const minimum = method.requirements, elevated = level === "elevated" ? pack.din4109_5 : undefined;
  if (level === "elevated" && !elevated) return null;
  const upper = elevated?.requirements;
  const door = (role: InteriorDoorRole) => upper?.doors?.[role] ?? minimum.doors?.[role] ?? null;
  return {
    level, edition: elevated ? `${elevated.edition}; ${method.editions.requirements}` : method.editions.requirements,
    wall: role => upper?.walls?.[role] ?? minimum.walls[role] ?? null,
    ceiling: role => upper?.ceilings?.[role] ?? minimum.ceilings[role] ?? null,
    door,
    wallWithDoor: role => {
      const required = door(role), offset = upper?.wallWithDoor ?? minimum.wallWithDoor;
      return required && offset ? { rwMinDb: required.rwMinDb + offset.offsetDb, ref: `${offset.ref}; ${required.ref}` } : null;
    },
    stairs: upper?.stairs ?? minimum.stairs ?? null,
    hallwayFloor: upper?.hallwayFloor ?? minimum.hallwayFloor ?? null,
    // The elevated table may leave out a room use; that use keeps its statutory value.
    service: (kind, use) => upper?.services?.[kind]?.[use] ?? minimum.services?.[kind]?.[use] ?? null,
  };
}

/** Both faces improved: the larger ΔRw plus the pack's share of the smaller. Without the lining part only the larger counts. */
export function combineLinings(pack: AcousticNormPack, a: number, b: number) {
  return Math.max(a, b) + (pack.din4109_34?.smallerFactor ?? 0) * Math.min(a, b);
}

/**
 * ΔRw of a lining, suspended ceiling or floating screed on a massive element
 * from the resonance frequency of the two-leaf system. Below the table's lowest
 * frequency, or above its highest, there is no value.
 */
export function liningImprovement(pack: AcousticNormPack, input: { lining: Lining; baseMassKgM2: number; baseRwDb: number }): LiningResult {
  const table = pack.din4109_34;
  if (!table) return { f0Hz: null, deltaRwDb: null, reason: "method_missing" };
  const { lining, baseMassKgM2: base } = input;
  const masses = 1 / lining.massKgM2 + 1 / base;
  const f0 = lining.kind === "bonded" ? table.f0Constant * Math.sqrt(lining.stiffnessMNm3 * masses) : table.f0Constant * Math.sqrt(table.cavityFactor / lining.cavityM * masses);
  const low = table.lowBand, points = table.points, last = points[points.length - 1]!;
  const lowValue = (f: number) => Math.max(low.constant - low.lgSlope * lg(f) - low.rwFactor * input.baseRwDb, 0);
  const shown = round(f0, 1);
  if (!(f0 >= low.minHz) || f0 > last.f0Hz) return { f0Hz: shown, deltaRwDb: null, reason: "out_of_range" };
  const refs = [table.refs.table, lining.kind === "bonded" ? table.refs.bonded : table.refs.freeStanding];
  if (f0 <= low.maxHz) return { f0Hz: shown, deltaRwDb: round(lowValue(f0), 1), refs };
  // Between the low band's end and the first point, and between points, linearly; a frequency listed twice steps.
  const nodes = [{ f0Hz: low.maxHz, deltaRwDb: lowValue(low.maxHz) }, ...points];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!, b = nodes[i]!;
    if (f0 > b.f0Hz) continue;
    const value = b.f0Hz === a.f0Hz ? b.deltaRwDb : a.deltaRwDb + (b.deltaRwDb - a.deltaRwDb) * (f0 - a.f0Hz) / (b.f0Hz - a.f0Hz);
    return { f0Hz: shown, deltaRwDb: round(value, 1), refs };
  }
  return { f0Hz: shown, deltaRwDb: round(last.deltaRwDb, 1), refs };
}

/** ΔLw of a floating screed within its ranges, or null outside them. */
function screedDeltaLw(pack: AcousticNormPack, screed: ImpactInput["screed"]) {
  const i = pack.din4109_interior!.impact, decimals = pack.din4109_interior!.roundingDecimals;
  if (!screed) return { deltaLw: 0, ref: null };
  const spec = i.screeds[screed.type];
  const { massKgM2: mass, stiffnessMNm3: s } = screed;
  if (!spec || s < spec.minStiffness || s > spec.maxStiffness || mass < spec.minMassKgM2 || mass > spec.maxMassKgM2) return null;
  return { deltaLw: round(spec.massLog * lg(mass) + spec.stiffnessLog * lg(s) + spec.massStiffnessLog * mass * lg(s) + spec.mass * mass + spec.constant, decimals), ref: spec.ref };
}

/**
 * Impact sound into a room beside or diagonally below the excited floor of a
 * massive building: the bare slab less the screed's ΔLw less K_T. The walls
 * between must be rigidly connected and heavy enough.
 */
export function impactOtherDirections(pack: AcousticNormPack, input: ImpactOtherInput): ImpactOtherResult {
  const method = pack.din4109_interior, rule = method?.impact.otherDirections;
  if (!method || !rule) return { status: "unsupported", reason: "method_missing" };
  const i = method.impact, decimals = method.roundingDecimals, slab = input.slabMassKgM2;
  if (slab < i.bareSlab.minKgM2 || slab > i.bareSlab.maxKgM2) return { status: "unsupported", reason: "slab_mass_out_of_range" };
  if (input.wallMassKgM2 < rule.minWallKgM2) return { status: "unsupported", reason: "wall_too_light" };
  const screed = screedDeltaLw(pack, input.screed);
  if (!screed) return { status: "unsupported", reason: "screed_out_of_range" };
  const lnEq0 = i.bareSlab.constant - i.bareSlab.slope * lg(slab);
  const kT = input.position === "beside" ? rule.besideDb : rule.diagonalBelowDb;
  const lnw = lnEq0 - screed.deltaLw - kT;
  const margin = input.maxDb - (lnw + i.uncertaintyDb);
  return { status: "calculated", lnEq0Db: round(lnEq0, decimals), deltaLwDb: screed.deltaLw, kTDb: kT, lnwPrimeDb: round(lnw, decimals), uncertaintyDb: i.uncertaintyDb,
    maxDb: input.maxDb, marginDb: round(margin, decimals) + 0, meets: margin >= 0,
    refs: [rule.ref, i.bareSlab.ref, ...(screed.ref ? [screed.ref] : []), i.refs.uncertainty], edition: `${method.editions.method}; ${method.editions.junctions}; ${method.editions.screeds}` };
}

/**
 * A massive stair into the room behind the stairwell wall: the tabled L'n,w
 * without a covering, else the tabled Ln,eq,0,w less the covering's or floating
 * screed's ΔLw. No flanking correction; the table already includes it.
 */
export function stairImpact(pack: AcousticNormPack, input: StairInput): StairResult {
  const method = pack.din4109_interior, stairs = method?.impact.stairs;
  if (!method || !stairs) return { status: "unsupported", reason: "method_missing" };
  const row = stairs.cases[input.stairCase];
  if (!row) return { status: "unsupported", reason: "case_missing" };
  if (row.minWallKgM2 !== null) {
    if (input.wallMassKgM2 === null) return { status: "unsupported", reason: "wall_mass_missing" };
    if (input.wallMassKgM2 < row.minWallKgM2) return { status: "unsupported", reason: "wall_too_light" };
  }
  const i = method.impact, decimals = method.roundingDecimals;
  const covered = input.coveringDeltaLwDb !== null;
  const lnw = covered ? row.lnEq0Db - input.coveringDeltaLwDb! : row.lnwDb;
  const margin = input.maxDb - (lnw + i.uncertaintyDb);
  return { status: "calculated", tableDb: covered ? row.lnEq0Db : row.lnwDb, quantity: covered ? "Ln,eq,0,w" : "L'n,w", deltaLwDb: input.coveringDeltaLwDb,
    lnwPrimeDb: round(lnw, decimals), uncertaintyDb: i.uncertaintyDb, maxDb: input.maxDb, marginDb: round(margin, decimals) + 0, meets: margin >= 0,
    refs: [input.requirementRef, stairs.ref, row.ref, i.refs.uncertainty] };
}

/**
 * A timber ceiling's impact sound into the room below: its catalogue Ln,w plus
 * K1 for the receiving room's walls and the ceiling's underside, plus K2 for
 * the screed and the walls. With walls of several linings the largest K counts.
 */
export function timberImpact(pack: AcousticNormPack, input: TimberImpactInput): TimberImpactResult {
  const method = pack.din4109_interior, timber = method?.impact.timber;
  if (!method || !timber || !input.wallLinings.length) return { status: "unsupported", reason: "method_missing" };
  const k1Of = (lining: TimberImpactInput["wallLinings"][number]) => timber.k1[lining]?.[input.underside];
  const k1Values = input.wallLinings.map(k1Of);
  if (k1Values.some(value => value === undefined)) return { status: "unsupported", reason: "method_missing" };
  const k1 = Math.max(...(k1Values as number[]));
  const base = input.lnwDb + k1;
  const k2Values = [...new Set(input.wallLinings.map(lining => lining === "gypsum_wood" || lining === "gypsum_fibre" ? "boarded" as const : "wood" as const))].map(group => {
    const row = timber.k2[group]?.[input.screed];
    if (!row) return undefined;
    const index = Math.min(Math.max(Math.floor(base - row.fromDb), 0), row.values.length - 1);
    return row.values[index];
  });
  if (k2Values.some(value => value === undefined)) return { status: "unsupported", reason: "method_missing" };
  const k2 = Math.max(...(k2Values as number[])), decimals = method.roundingDecimals, i = method.impact;
  const lnw = base + k2;
  const margin = input.maxDb - (lnw + i.uncertaintyDb);
  return { status: "calculated", lnwDb: input.lnwDb, k1Db: k1, k2Db: k2, lnwPrimeDb: round(lnw, decimals), uncertaintyDb: i.uncertaintyDb, maxDb: input.maxDb,
    marginDb: round(margin, decimals) + 0, meets: margin >= 0, refs: [timber.ref, i.refs.uncertainty] };
}

/**
 * Building services noise in protected rooms of other units. Sanitary
 * installations on a reference installation wall need no level: the wall's
 * rules decide. Otherwise a measured or certified LAF,max,n is compared with
 * the requirement; no allowance applies.
 */
export function serviceNoise(pack: AcousticNormPack, input: ServiceInput): ServiceResult {
  if (input.method === "level") {
    if (!input.requirement) return { status: "unsupported", reason: "no_requirement" };
    const margin = input.requirement.maxDb - input.valueDb;
    return { status: "calculated", method: "level", valueDb: input.valueDb, maxDb: input.requirement.maxDb, marginDb: round(margin, 1) + 0, meets: margin >= 0, refs: [input.requirement.ref] };
  }
  const rules = pack.din4109_36;
  if (!rules) return { status: "unsupported", reason: "method_missing" };
  const failures: Extract<ServiceResult, { method: "reference_wall" }>["failures"] = [];
  if (input.kind !== "sanitary") failures.push("not_sanitary");
  if (input.wall.massive) { if (input.wall.massKgM2 < rules.massiveMinKgM2) failures.push("wall_too_light"); }
  else {
    if (!input.wall.buildUpConfirmed) failures.push("build_up_unconfirmed");
    if (input.wall.slabMassKgM2 === null || input.wall.slabMassKgM2 < rules.lightweightSlabMinKgM2) failures.push("slab_too_light");
  }
  if (input.bordersProtectedRoom) failures.push("borders_protected_room");
  if (!input.conditionsConfirmed) failures.push("conditions_unconfirmed");
  return { status: "calculated", method: "reference_wall", wall: input.wall.massive ? "massive" : "lightweight", meets: !failures.length, failures,
    refs: [input.wall.massive ? rules.refs.massive : rules.refs.lightweight] };
}

/** A door's Rw less the door allowance against the Rw its role requires; the unrounded margin decides. */
export function doorSoundInsulation(pack: AcousticNormPack, input: { rwDb: number; requirement: { rwMinDb: number; ref: string } | null }): DoorResult {
  const method = pack.din4109_interior;
  if (!method?.door) return { status: "unsupported", reason: "method_missing" };
  const requirement = input.requirement;
  if (!requirement) return { status: "unsupported", reason: "no_requirement" };
  const margin = input.rwDb - method.door.uncertaintyDb - requirement.rwMinDb;
  return { status: "calculated", method: "declared", valueDb: input.rwDb, uncertaintyDb: method.door.uncertaintyDb, requiredDb: requirement.rwMinDb,
    // + 0 turns a margin rounded from just below zero into 0 rather than -0.
    marginDb: round(margin, method.roundingDecimals) + 0, meets: margin >= 0, refs: [requirement.ref, method.door.ref] };
}

/**
 * A door without a declared Rw, from its leaf and seals (catalogue criteria):
 * only for requirements up to the catalogue's limit; every part must reach the
 * requirement plus its offset. No allowance applies; the criteria are the proof.
 */
export function doorCriteria(pack: AcousticNormPack, input: DoorConstruction & { requirement: { rwMinDb: number; ref: string } | null }): DoorResult {
  const rules = pack.din4109_35?.doors;
  if (!rules) return { status: "unsupported", reason: "method_missing" };
  const requirement = input.requirement;
  if (!requirement) return { status: "unsupported", reason: "no_requirement" };
  if (requirement.rwMinDb > rules.maxRequiredDb) return { status: "unsupported", reason: "criteria_not_applicable" };
  const required = requirement.rwMinDb;
  const part = (name: "leaf" | "rebate_seal" | "floor_seal", valueDb: number, offset: number) => ({ part: name, valueDb, requiredDb: required + offset, meets: valueDb >= required + offset });
  const criteria = [part("leaf", input.leafRwDb, rules.leafOffsetDb[input.leafType]), part("rebate_seal", input.rebateSealDb, rules.sealOffsetDb), part("floor_seal", input.floorSealDb, rules.sealOffsetDb)];
  return { status: "calculated", method: "criteria", requiredDb: required, criteria, marginDb: Math.min(...criteria.map(item => item.valueDb - item.requiredDb)) + 0,
    meets: criteria.every(item => item.meets), refs: [requirement.ref, rules.ref] };
}
