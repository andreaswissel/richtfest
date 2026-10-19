import type { AcousticNormPack, MassiveWallInput, MassiveWallRw } from "@richtfest/shared";

/**
 * Rw of a single-leaf massive wall from the component catalogue: the area
 * mass from thickness and wall density, then the mass law of its material.
 * Every normative number comes from the pack; without its catalogue part the
 * value is unavailable. Masonry with an unknown mortar takes the lowest wall
 * density any mortar allows, and plaster is left out, so the value errs low.
 */
export function massiveWallRw(pack: AcousticNormPack, input: MassiveWallInput): MassiveWallRw {
  const catalogue = pack.din4109_32;
  if (!catalogue) return { status: "unavailable", reason: "catalogue_missing" };
  if (!input.thicknessCm || input.thicknessCm <= 0) return { status: "unavailable", reason: "thickness_missing" };
  const assumptions: Extract<MassiveWallRw, { status: "calculated" }>["assumptions"] = ["without_plaster"];
  const refs: string[] = [];
  let wallDensity: number;
  if (input.form === "concrete") {
    // Only normal-weight concrete has a default density; lightweight and aerated concrete need theirs.
    if (input.densityKgM3 === null && input.material !== "dense") return { status: "unavailable", reason: "density_missing" };
    wallDensity = input.densityKgM3 ?? catalogue.concreteDensityKgM3.reinforced;
    if (input.densityKgM3 === null) assumptions.push("reinforced_concrete_density");
  } else {
    if (!input.densityKgM3) return { status: "unavailable", reason: "density_missing" };
    const rdk = input.densityKgM3 / 1000;
    const thicknessMm = input.thicknessCm * 10;
    const limits = catalogue.perforated;
    if (input.perforated === "clay" && thicknessMm > limits.maxThicknessMm && rdk < limits.clayMinRdkAboveMaxThickness) return { status: "unavailable", reason: "perforated_not_homogeneous" };
    if (input.perforated === "block" && (thicknessMm > limits.maxThicknessMm || rdk < limits.blockMinRdk)) return { status: "unavailable", reason: "perforated_not_homogeneous" };
    const candidates = catalogue.masonryWallDensity.filter(rule => (rule.minExclusive ? rdk > rule.minRdk : rdk >= rule.minRdk) && rdk <= rule.maxRdk)
      .map(rule => ({ density: rule.factor * rdk + rule.offset, ref: rule.ref }));
    if (!candidates.length) return { status: "unavailable", reason: "density_class_out_of_range" };
    const lowest = candidates.reduce((min, item) => item.density < min.density ? item : min);
    wallDensity = lowest.density;
    refs.push(lowest.ref);
    if (candidates.length > 1) assumptions.push("mortar_unknown_lowest");
  }
  const mass = input.thicknessCm / 100 * wallDensity;
  const segment = catalogue.massLaws[input.material].find(item =>
    (item.minInclusive ? mass >= item.minKgM2 : mass > item.minKgM2) && (item.maxInclusive ? mass <= item.maxKgM2 : mass < item.maxKgM2));
  if (!segment) return { status: "unavailable", reason: "mass_out_of_range" };
  const factor = 10 ** catalogue.roundingDecimals;
  const rwDb = Math.round((segment.slope * Math.log10(mass) + segment.intercept) * factor) / factor;
  return { status: "calculated", rwDb, massKgM2: Math.round(mass * 10) / 10, wallDensityKgM3: Math.round(wallDensity), refs: [...refs, segment.ref], edition: catalogue.edition, assumptions };
}
