import { describe, expect, test } from "bun:test";
import { calculateFeasibility, type FeasibilityScenario, type FeasibilityValue } from "./feasibility";

const v = (value: number, reviewed = true): FeasibilityValue => ({ value, source: "entered", note: null, reviewed });
const site = { parcelArea: v(1000), acquisitionCostRate: v(8), askingPrice: v(1_000_000) };
const newBuild: FeasibilityScenario = { kind: "new_build", revenueMode: "sale", values: {
  newGrossFloorArea: v(1200), livingAreaRatio: v(0.75), constructionCost: v(3000), contingencyRate: v(20), demolitionCost: v(50_000),
  salePrice: v(7500), financingRate: v(5), marketingRate: v(3), profitRate: v(15),
} };

describe("calculateFeasibility", () => {
  test("residual land value of a new build sold as units", () => {
    const result = calculateFeasibility(site, newBuild);
    // 900 m² WF × 7,500 € = 6.75 M; build 900 × 3,000 × 1.2 + 50,000 = 3.29 M; financing 164,500; marketing 202,500; profit 1,012,500.
    expect(result.status).toBe("complete");
    expect(result.livingArea).toBe(900);
    expect(result.revenue).toBe(6_750_000);
    expect(result.constructionCosts).toBe(3_290_000);
    expect(result.totalCosts).toBe(3_657_000);
    expect(result.residualLandValue!).toBeCloseTo((6_750_000 - 3_657_000 - 1_012_500) / 1.08, 6);
    expect(result.residualPerParcelArea!).toBeCloseTo(result.residualLandValue! / 1000, 6);
    expect(result.headroom!).toBeCloseTo(result.residualLandValue! - 1_000_000, 6);
    expect(result.unreviewed).toEqual([]);
  });

  test("capitalises net rent and keeps existing area only when the scenario retains it", () => {
    const rent: FeasibilityScenario = { kind: "existing", revenueMode: "rent", values: {
      existingLivingArea: v(600), renovationCost: v(800), newGrossFloorArea: v(999), monthlyRent: v(14), operatingCostRate: v(15), capitalizationRate: v(3.8),
      financingRate: v(5), marketingRate: v(0), profitRate: v(10),
    } };
    const result = calculateFeasibility(site, rent);
    expect(result.livingArea).toBe(600);
    expect(result.revenue!).toBeCloseTo(600 * 14 * 12 * 0.85 / 0.038, 6);
    expect(result.constructionCosts).toBe(480_000);
  });

  test("names missing inputs and unreviewed ones instead of assuming them", () => {
    const { salePrice: _, ...values } = newBuild.values;
    const missing = calculateFeasibility(site, { ...newBuild, values: { ...values, constructionCost: { value: 3000, source: "standard", note: "Zielmarke", reviewed: false } } });
    expect(missing.status).toBe("incomplete");
    expect(missing.missing).toEqual(["salePrice"]);
    expect(missing.unreviewed).toEqual(["constructionCost"]);
    expect(missing.residualLandValue).toBeNull();
    // Demolition, other costs and subsidies may stay empty.
    const { demolitionCost: __, ...withoutDemolition } = newBuild.values;
    expect(calculateFeasibility(site, { ...newBuild, values: withoutDemolition }).status).toBe("complete");
  });
});
