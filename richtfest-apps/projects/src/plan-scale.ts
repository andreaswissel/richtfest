import type { PlanWord } from "./plan-extraction";

export const planScaleMethod = "dimension_chain_scale_v1" as const;

/** Scales architects draw floor plans in; a measured scale this close to one is taken as that scale. */
const standardDenominators = [20, 25, 50, 75, 100, 125, 200, 250, 500, 1000];

export type PlanScale = {
  /** Metres per page height on this sheet. */
  metresPerPageHeight: number;
  /** The scale on this sheet (1:denominator); a reduced print of a 1:100 plan reads e.g. 1:212. */
  denominator: number;
  source: "dimension_chains" | "title_block" | "dimension_chains_and_title_block" | "planner";
  /** Adjacent dimension figures whose spacing agrees with the scale, and all pairs read. */
  agreeingPairs: number;
  pairs: number;
  quote: string | null;
  status: "unreviewed" | "confirmed";
  method: typeof planScaleMethod;
  limitations: string;
};

const dimensionValue = (text: string) => /^\d{1,2}[.,]\d{2}$/.test(text) ? Number(text.replace(",", ".")) : null;

/**
 * Scale from the dimension chains: a chain's figures sit centred over contiguous
 * segments, so two neighbouring figures with values a and b (metres) stand
 * (a + b) / 2 apart at the drawing's scale. Every neighbouring pair is one
 * estimate; the estimates of a real chain agree, gaps and overall dimensions
 * scatter. Long segments are weighted higher (the figure's placement error is
 * absolute). Words are page-normalised; `aspect` is page width / height.
 * Returns metres per page height, or null without enough agreeing pairs.
 */
export function dimensionChainScale(words: PlanWord[], aspect: number) {
  const figures = words.flatMap(word => {
    const value = dimensionValue(word.text);
    return value !== null && value > 0 ? [{ ...word, value, vertical: word.height > word.width * 1.2 }] : [];
  });
  const estimates: Array<{ mpp: number; weight: number }> = [];
  for (const vertical of [false, true]) {
    const set = figures.filter(figure => figure.vertical === vertical);
    const across = (f: typeof set[number]) => vertical ? f.x + f.width / 2 : f.y + f.height / 2;
    // Along the chain in page heights, so horizontal and vertical chains measure alike.
    const along = (f: typeof set[number]) => vertical ? f.y + f.height / 2 : (f.x + f.width / 2) * aspect;
    const size = (f: typeof set[number]) => vertical ? f.width : f.height;
    const done = new Set<typeof set[number]>();
    for (const figure of set) {
      if (done.has(figure)) continue;
      const chain = set.filter(other => Math.abs(across(other) - across(figure)) < size(figure) * .3 && Math.abs(size(other) / size(figure) - 1) < .15)
        .sort((a, b) => along(a) - along(b));
      for (const member of chain) done.add(member);
      for (let i = 0; i + 1 < chain.length; i++) {
        const half = (chain[i]!.value + chain[i + 1]!.value) / 2, span = along(chain[i + 1]!) - along(chain[i]!);
        if (span > 0) estimates.push({ mpp: half / span, weight: half });
      }
    }
  }
  if (estimates.length < 6) return null;
  // The densest ±5% window by weight, then its weighted median.
  let best = { centre: 0, weight: 0 };
  for (const { mpp } of estimates) {
    const weight = estimates.reduce((sum, e) => sum + (Math.abs(e.mpp / mpp - 1) < .05 ? e.weight : 0), 0);
    if (weight > best.weight) best = { centre: mpp, weight };
  }
  const near = estimates.filter(e => Math.abs(e.mpp / best.centre - 1) < .05).sort((a, b) => a.mpp - b.mpp);
  const total = estimates.reduce((sum, e) => sum + e.weight, 0);
  if (near.length < 6 || best.weight < total * .3) return null;
  let accumulated = 0, metresPerPageHeight = near[near.length - 1]!.mpp;
  for (const e of near) { accumulated += e.weight; if (accumulated >= best.weight / 2) { metresPerPageHeight = e.mpp; break; } }
  return { metresPerPageHeight, agreeingPairs: near.length, pairs: estimates.length };
}

/** Scales printed in the title block or under a drawing title: "M 1:100", "1:100", "1 : 100". */
export function titleBlockDenominators(words: PlanWord[]) {
  const found: Array<{ denominator: number; quote: string }> = [];
  words.forEach((word, i) => {
    const one = word.text.match(/^(?:M\.?\s*=?\s*)?1\s*:\s*(\d{2,4})$/i);
    if (one) { found.push({ denominator: Number(one[1]), quote: word.text }); return; }
    // "1" ":" "100" as separate words on one line.
    const colon = words[i + 1], value = words[i + 2];
    if (/^(?:M\.?)?1$/i.test(word.text) && colon?.text === ":" && value && /^\d{2,4}$/.test(value.text) && Math.abs(value.y - word.y) < word.height * .5)
      found.push({ denominator: Number(value.text), quote: `${word.text} : ${value.text}` });
  });
  return found.filter(item => item.denominator >= 10 && item.denominator <= 5000);
}

/**
 * The plan's scale on this sheet. Dimension chains measure the sheet itself, so
 * they also hold for reduced prints; a title-block scale that agrees with them
 * (within 3%) makes it exact. Without readable chains a single title-block scale
 * is used, which is wrong on a reduced print. Always unreviewed evidence.
 */
export function planScale(input: { words: PlanWord[]; aspect: number; pageHeightPoints: number | null }): PlanScale | null {
  const pageHeightM = input.pageHeightPoints ? input.pageHeightPoints / 72 * .0254 : null;
  const chains = dimensionChainScale(input.words, input.aspect);
  const titles = titleBlockDenominators(input.words);
  const distinctTitles = [...new Set(titles.map(t => t.denominator))];
  const base = { method: planScaleMethod, status: "unreviewed" as const };
  if (chains) {
    const agreeing = pageHeightM ? titles.find(t => Math.abs(t.denominator * pageHeightM / chains.metresPerPageHeight - 1) < .03) : undefined;
    if (agreeing && pageHeightM) return { ...base, metresPerPageHeight: agreeing.denominator * pageHeightM, denominator: agreeing.denominator,
      source: "dimension_chains_and_title_block", agreeingPairs: chains.agreeingPairs, pairs: chains.pairs, quote: agreeing.quote,
      limitations: "The printed scale agrees with the plan's dimension chains. Unreviewed until a person confirms it." };
    const measured = pageHeightM ? chains.metresPerPageHeight / pageHeightM : null;
    const standard = measured ? standardDenominators.find(d => Math.abs(d / measured - 1) < .03) : undefined;
    const metresPerPageHeight = standard && pageHeightM ? standard * pageHeightM : chains.metresPerPageHeight;
    return { ...base, metresPerPageHeight, denominator: standard ?? (measured ? Math.round(measured) : 0), source: "dimension_chains",
      agreeingPairs: chains.agreeingPairs, pairs: chains.pairs, quote: null,
      limitations: standard ? `Measured from the plan's dimension chains, within 3% of 1:${standard}. Unreviewed until a person confirms it.`
        : "Measured from the plan's dimension chains; no standard scale matches, as on a reduced print. Unreviewed until a person confirms it." };
  }
  if (distinctTitles.length === 1 && pageHeightM) {
    const title = titles[0]!;
    return { ...base, metresPerPageHeight: title.denominator * pageHeightM, denominator: title.denominator, source: "title_block",
      agreeingPairs: 0, pairs: 0, quote: title.quote,
      limitations: "Printed scale only; no dimension chain was readable to check it. Wrong on a reduced or enlarged print." };
  }
  return null;
}
