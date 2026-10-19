import type { AcousticNormPack, AirborneInput, AirbornePath, AirborneResult, DoorResult, ImpactInput, ImpactResult, InteriorDoorRole } from "@richtfest/shared";

/**
 * Interior sound insulation in massive buildings (DIN 4109-2): the airborne
 * sound insulation between two rooms from the direct path and three flanking
 * paths per edge, and the impact sound level of a massive ceiling with its
 * floating screed. Every normative number comes from the pack; without its
 * interior part nothing is calculated.
 *
 * Junctions are taken as rigid T-junctions: a continuous flanking element with
 * the separating element abutting it. Where the separating element continues
 * (a cross junction) this errs low. Flanking elements of different mass on the
 * two sides take their mean mass for the junction, as the catalogue allows.
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
  const rDd = separating.rwDb;
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
    const flankingMass = source.id === receiving.id ? source.massKgM2 : (source.massKgM2 + receiving.massKgM2) / 2;
    const m = lg(separating.massKgM2 / flankingMass);
    const t = a.tJunction;
    const k12 = t.k12.constant + t.k12.square * m * m;
    const k13 = m < t.k13.breakM ? t.k13.below.constant + t.k13.below.linear * m + t.k13.below.square * m * m : t.k13.above.constant + t.k13.above.linear * m;
    const path = (name: AirbornePath["path"], from: { name: string; rw: number; area: number }, to: { name: string; rw: number; area: number }, k: number) => {
      const kMin = 10 * lg(lf * l0 * (1 / from.area + 1 / to.area));
      const kij = Math.max(k, kMin);
      paths.push({ edge: edge.edge, path: name, from: from.name, to: to.name, kijDb: kij, kijMinApplied: kMin > k,
        rDb: from.rw / 2 + to.rw / 2 + kij + 10 * lg(ss / (l0 * lf)) });
    };
    const f = { name: source.name, rw: source.rwDb, area: source.areaM2 }, r = { name: receiving.name, rw: receiving.rwDb, area: receiving.areaM2 };
    const d = { name: separating.name, rw: separating.rwDb, area: ss };
    path("Ff", f, r, k13);
    path("Df", d, r, k12);
    path("Fd", f, d, k12);
  }
  const rwPrime = energySum([rDd, ...paths.map(item => item.rDb)]);
  const small = ss < a.minSeparatingAreaM2;
  const value = small ? rwPrime - 10 * lg(ss / a.referenceAbsorptionM2) : rwPrime;
  // The unrounded value is compared; values are reported to the pack's precision.
  const margin = value - a.uncertaintyDb - input.requiredDb;
  return {
    status: "calculated", rDdDb: round(rDd, decimals),
    paths: paths.map(item => ({ ...item, kijDb: item.kijDb === null ? null : round(item.kijDb, decimals), rDb: round(item.rDb, decimals) })),
    rwPrimeDb: round(rwPrime, decimals), quantity: small ? "Dn,w" : "R'w", valueDb: round(value, decimals), uncertaintyDb: a.uncertaintyDb,
    requiredDb: input.requiredDb, marginDb: round(margin, decimals), meets: margin >= 0,
    refs: [a.refs.total, a.refs.direct, a.refs.flanking, a.refs.junction, a.refs.kijMin, ...(small ? [a.refs.dnw] : []),
      ...(input.edges.some(edge => edge.source.kind === "lightweight") ? [a.refs.lightweight] : []), a.refs.uncertainty],
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


/** A door's tested Rw less the door allowance against the Rw its role requires; the unrounded margin decides. */
export function doorSoundInsulation(pack: AcousticNormPack, input: { rwDb: number; role: InteriorDoorRole }): DoorResult {
  const method = pack.din4109_interior;
  if (!method?.door) return { status: "unsupported", reason: "method_missing" };
  const requirement = method.requirements.doors?.[input.role];
  if (!requirement) return { status: "unsupported", reason: "no_requirement" };
  const margin = input.rwDb - method.door.uncertaintyDb - requirement.rwMinDb;
  return { status: "calculated", valueDb: input.rwDb, uncertaintyDb: method.door.uncertaintyDb, requiredDb: requirement.rwMinDb,
    // + 0 turns a margin rounded from just below zero into 0 rather than -0.
    marginDb: round(margin, method.roundingDecimals) + 0, meets: margin >= 0, refs: [requirement.ref, method.door.ref] };
}

/** R'w a stairwell or corridor wall needs where it holds a door of this role: the door's requirement plus the offset. */
export function wallWithDoorRequirement(pack: AcousticNormPack, role: InteriorDoorRole): { rwMinDb: number; ref: string } | null {
  const requirements = pack.din4109_interior?.requirements;
  const door = requirements?.doors?.[role], offset = requirements?.wallWithDoor;
  return door && offset ? { rwMinDb: door.rwMinDb + offset.offsetDb, ref: `${offset.ref}; ${door.ref}` } : null;
}
