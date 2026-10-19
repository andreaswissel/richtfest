import { expect, test } from "bun:test";
import { planScale } from "./plan-scale";
import type { PlanWord } from "./plan-extraction";

const aspect = 1.54;
/** A horizontal dimension chain: contiguous segments (metres) with each figure centred over its segment. */
const chain = (values: number[], metresPerPageHeight: number, y: number, x0 = .1) => {
  let at = x0 * aspect * metresPerPageHeight;
  return values.map(value => {
    const centre = (at + value / 2) / metresPerPageHeight / aspect; at += value;
    return { text: value.toFixed(2), x: centre - .005, y, width: .01, height: .004 } as PlanWord;
  });
};
const values = [3.65, 1.01, 4.51, 2.24, 3, 1.76, 2.51, 4.1, 1.26, 3.38];
const stray = [{ text: "40.64", x: .4, y: .05, width: .012, height: .004 }, { text: "2.00", x: .7, y: .3, width: .01, height: .004 }] as PlanWord[];

test("dimension chains give the sheet's scale and snap to the drawing scale they match", () => {
  // An A1 sheet (594 mm high) at 1:100: 59.4 m per page height.
  const words = [...chain(values, 59.4, .1), ...chain(values.slice().reverse(), 59.4, .2, .3), ...stray];
  const scale = planScale({ words, aspect, pageHeightPoints: 594 / 25.4 * 72 })!;
  expect(scale).toMatchObject({ source: "dimension_chains", denominator: 100 });
  expect(scale.metresPerPageHeight).toBeCloseTo(59.4, 6);
  expect(scale.agreeingPairs).toBeGreaterThanOrEqual(16);
});

test("a reduced print keeps its measured scale; a printed scale that disagrees is ignored", () => {
  // The same plan fitted onto A3 (297 mm high): about 1:212, which is no drawing scale.
  const words = [...chain(values, 63, .1), ...chain(values, 63, .2, .25), { text: "1:50", x: .9, y: .9, width: .02, height: .004 }];
  const scale = planScale({ words, aspect, pageHeightPoints: 297 / 25.4 * 72 })!;
  expect(scale.source).toBe("dimension_chains");
  expect(scale.metresPerPageHeight).toBeGreaterThan(63 * .99);
  expect(scale.metresPerPageHeight).toBeLessThan(63 * 1.01);
  expect(scale.denominator).toBe(212);
});

test("a printed scale the chains confirm is taken exactly; without chains it is used alone", () => {
  const pageHeightPoints = 594 / 25.4 * 72;
  const confirmed = planScale({ words: [...chain(values, 59.9, .1), ...chain(values, 59.9, .2), { text: "M", x: .9, y: .9, width: .005, height: .004 }, { text: "1:100", x: .91, y: .9, width: .02, height: .004 }], aspect, pageHeightPoints })!;
  expect(confirmed).toMatchObject({ source: "dimension_chains_and_title_block", denominator: 100, quote: "1:100" });
  expect(confirmed.metresPerPageHeight).toBeCloseTo(59.4, 6);
  expect(planScale({ words: [{ text: "M 1:50", x: .9, y: .9, width: .03, height: .004 }], aspect, pageHeightPoints })).toMatchObject({ source: "title_block", denominator: 50 });
  expect(planScale({ words: stray, aspect, pageHeightPoints })).toBeNull();
});
