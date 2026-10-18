import type { AcousticNormPack, ExteriorNoiseLevel, RatingLevelContribution } from "@richtfest/shared";

/**
 * Relevant exterior noise level La of one facade from the rating levels of
 * its sources, after the DIN 4109-2 rules for calculated levels: a rail
 * reduction, a night surcharge for rooms used for sleeping, energetic
 * combination of the sources per period and one addition on the sum.
 */
const energySum = (levels: number[]) => {
  const peak = Math.max(...levels);
  return peak + 10 * Math.log10(levels.reduce((sum, level) => sum + 10 ** ((level - peak) / 10), 0));
};

export function exteriorNoiseLevel(pack: AcousticNormPack, contributions: RatingLevelContribution[]): ExteriorNoiseLevel | null {
  if (!contributions.length) return null;
  const rules = pack.din4109;
  const adjusted = contributions.map(item => {
    const reduction = item.kind === "rail" ? rules.railReductionDb : 0;
    return { ...item, dayLaDb: item.dayDb - reduction, nightLaDb: item.nightDb + rules.nightSurchargeDb - reduction };
  });
  // The addition applies once, to the combined level of all sources.
  const dayDb = energySum(adjusted.map(item => item.dayLaDb)) + rules.exteriorLevelAdditionDb;
  const nightDb = energySum(adjusted.map(item => item.nightLaDb)) + rules.exteriorLevelAdditionDb;
  return { dayDb, nightDb, sleepingDb: Math.max(dayDb, nightDb), contributions: adjusted };
}
