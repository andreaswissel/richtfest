import { describe, expect, test } from "bun:test";
import { BUILDING_CODE_TOPICS, BUILDING_CODES, BUNDESLAENDER, buildingCodeRule, setbackDepth } from "./building-codes";
import { suggestedStaffelShare } from "./site-geometry";

describe("building code rule table", () => {
  test("every state is listed and every captured rule cites its own code and text version", () => {
    expect(Object.keys(BUILDING_CODES).sort()).toEqual([...BUNDESLAENDER].sort());
    for (const code of Object.values(BUILDING_CODES))
      for (const topic of BUILDING_CODE_TOPICS) {
        const rule = code[topic];
        if (!rule) continue;
        expect(rule.cite.startsWith(code.abbreviation)).toBe(true);
        expect(code.stand).not.toBeNull();
      }
  });
  test("only verified, modelled rules are applied", () => {
    expect(buildingCodeRule("BE", "setback")).toMatchObject({ factor: 0.4, minimum: 3 });
    // Hamburg's minimum is 2.5 m: 0.4 × 5 m = 2 m is raised to 2.5, not to Berlin's 3.
    expect(setbackDepth(buildingCodeRule("HH", "setback")!, 5)).toBe(2.5);
    // Mecklenburg-Vorpommern sets depths by building class, which the factor model cannot express.
    expect(buildingCodeRule("MV", "setback")).toBeNull();
    expect(buildingCodeRule("ST", "setback")).toBeNull();
    expect(buildingCodeRule("XX", "setback")).toBeNull();
  });
  test("a Staffel share is suggested only where the top storey is measured against the floor below", () => {
    expect(suggestedStaffelShare("BE")!.share).toBeLessThan(2 / 3);
    // Hessen counts a Vollgeschoss only above ¾, so exactly ¾ is still allowed.
    expect(suggestedStaffelShare("HE")).toMatchObject({ share: 3 / 4, threshold: 3 / 4, equalityCounts: false });
    // Bayern measures every storey against its own area: recessing does not avoid a full storey.
    expect(suggestedStaffelShare("BY")).toBeNull();
    expect(suggestedStaffelShare("BB")).toBeNull();
    expect(suggestedStaffelShare("RP")).toBeNull();
  });
});
