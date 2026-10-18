import { z } from "zod";

/**
 * Feasibility study: three development scenarios for one site (keep the
 * existing building, densify it, or build new) compared by residual land
 * value. Deterministic arithmetic on visible inputs; every input carries its
 * source (entered, a company calculation standard, or the building model) and
 * whether a person reviewed it. An indicative first assessment, not a
 * valuation (no BelWertV, no Gutachten).
 */
export const feasibilityMethod = "residual_land_value_v1";
export const feasibilityScenarioKinds = ["existing", "densify", "new_build"] as const;
export type FeasibilityScenarioKind = typeof feasibilityScenarioKinds[number];
export const feasibilitySources = ["entered", "standard", "building_model"] as const;

export const feasibilityValueSchema = z.object({
  value: z.number().finite().min(0).max(1e12).nullable(),
  source: z.enum(feasibilitySources),
  /** Where the value came from: the standard's name, or how the building model derived it. */
  note: z.string().trim().max(300).nullable().default(null),
  reviewed: z.boolean().default(false),
}).strict();
export type FeasibilityValue = z.infer<typeof feasibilityValueSchema>;

/** Site inputs shared by all scenarios. Rates are percent. */
export const feasibilitySiteKeys = ["parcelArea", "askingPrice", "acquisitionCostRate"] as const;
/** Scenario inputs. Areas in m², costs per m² living area (Wohnfläche) unless a lump sum. */
export const feasibilityScenarioKeys = [
  "existingLivingArea", "renovationCost", "newGrossFloorArea", "livingAreaRatio", "constructionCost", "contingencyRate",
  "demolitionCost", "otherCost", "salePrice", "monthlyRent", "operatingCostRate", "capitalizationRate",
  "financingRate", "marketingRate", "subsidies", "profitRate",
] as const;
export type FeasibilitySiteKey = typeof feasibilitySiteKeys[number];
export type FeasibilityScenarioKey = typeof feasibilityScenarioKeys[number];
export const feasibilityUnits: Record<FeasibilitySiteKey | FeasibilityScenarioKey, string> = {
  parcelArea: "m²", askingPrice: "€", acquisitionCostRate: "%",
  existingLivingArea: "m² WF", renovationCost: "€/m² WF", newGrossFloorArea: "m² GF", livingAreaRatio: "WF/GF", constructionCost: "€/m² WF", contingencyRate: "%",
  demolitionCost: "€", otherCost: "€", salePrice: "€/m² WF", monthlyRent: "€/m² WF", operatingCostRate: "%", capitalizationRate: "%",
  financingRate: "%", marketingRate: "%", subsidies: "€", profitRate: "%",
};

const valueMap = <K extends string>(keys: readonly K[]) => z.object(Object.fromEntries(keys.map(key => [key, feasibilityValueSchema.optional()])) as Record<K, z.ZodOptional<typeof feasibilityValueSchema>>).strict();
export const feasibilityScenarioSchema = z.object({
  kind: z.enum(feasibilityScenarioKinds),
  /** Sale of units, or rental held and valued by capitalised net rent. */
  revenueMode: z.enum(["sale", "rent"]),
  values: valueMap(feasibilityScenarioKeys),
}).strict();
export const feasibilityStudyInput = z.object({
  baseRevision: z.number().int().min(0),
  site: valueMap(feasibilitySiteKeys),
  scenarios: z.array(feasibilityScenarioSchema).length(3).refine(items => feasibilityScenarioKinds.every(kind => items.filter(item => item.kind === kind).length === 1), "One scenario per kind"),
  notes: z.string().max(5000).default(""),
}).strict();
export type FeasibilityScenario = z.infer<typeof feasibilityScenarioSchema>;
export type FeasibilityStudyInput = z.infer<typeof feasibilityStudyInput>;
export type FeasibilityStudy = Omit<FeasibilityStudyInput, "baseRevision"> & { revision: number; updatedAt: string | null };

/** Which inputs a scenario uses: keeping the building has no new floor area; a new build retains nothing. */
export function feasibilityScenarioInputs(kind: FeasibilityScenarioKind, revenueMode: FeasibilityScenario["revenueMode"]): FeasibilityScenarioKey[] {
  const areas: FeasibilityScenarioKey[] = kind === "existing" ? ["existingLivingArea", "renovationCost"]
    : kind === "densify" ? ["existingLivingArea", "renovationCost", "newGrossFloorArea", "livingAreaRatio", "constructionCost", "contingencyRate"]
    : ["newGrossFloorArea", "livingAreaRatio", "constructionCost", "contingencyRate", "demolitionCost"];
  const revenue: FeasibilityScenarioKey[] = revenueMode === "sale" ? ["salePrice"] : ["monthlyRent", "operatingCostRate", "capitalizationRate"];
  return [...areas, "otherCost", ...revenue, "financingRate", "marketingRate", "subsidies", "profitRate"];
}
/** Inputs that may stay empty and count as zero. */
const optionalInputs = new Set<string>(["otherCost", "subsidies", "demolitionCost", "askingPrice"]);

export type FeasibilityResult = {
  kind: FeasibilityScenarioKind;
  status: "complete" | "incomplete";
  missing: string[];
  /** Inputs that are used but not reviewed: the result is indicative until they are. */
  unreviewed: string[];
  livingArea: number | null;
  revenue: number | null;
  constructionCosts: number | null;
  financing: number | null;
  marketing: number | null;
  profit: number | null;
  totalCosts: number | null;
  residualLandValue: number | null;
  residualPerParcelArea: number | null;
  /** Residual land value minus the asking price; positive means the price is covered. */
  headroom: number | null;
};

/**
 * Residual land value: revenue − costs − developer profit, divided by
 * (1 + acquisition costs). Revenue is units × sale price, or annual net rent
 * capitalised at the given rate. Costs: renovation and construction per m²
 * living area plus contingency on construction, demolition and other lump
 * sums, financing on those costs and marketing on revenue, less subsidies.
 */
export function calculateFeasibility(site: FeasibilityStudyInput["site"], scenario: FeasibilityScenario): FeasibilityResult {
  const used = feasibilityScenarioInputs(scenario.kind, scenario.revenueMode);
  const states: Record<string, FeasibilityValue | undefined> = { ...scenario.values, parcelArea: site.parcelArea, acquisitionCostRate: site.acquisitionCostRate, askingPrice: site.askingPrice };
  const required = ["parcelArea", "acquisitionCostRate", ...used];
  const missing = required.filter(key => !optionalInputs.has(key) && (states[key]?.value === null || states[key]?.value === undefined));
  const unreviewed = [...required, "askingPrice"].filter(key => states[key] && states[key]!.value !== null && !states[key]!.reviewed);
  const v = (key: string) => states[key]?.value ?? 0;
  const pct = (key: string) => v(key) / 100;
  const empty = { livingArea: null, revenue: null, constructionCosts: null, financing: null, marketing: null, profit: null, totalCosts: null, residualLandValue: null, residualPerParcelArea: null, headroom: null };
  if (missing.length) return { kind: scenario.kind, status: "incomplete", missing, unreviewed, ...empty };
  const existing = used.includes("existingLivingArea") ? v("existingLivingArea") : 0;
  const newLiving = used.includes("newGrossFloorArea") ? v("newGrossFloorArea") * v("livingAreaRatio") : 0;
  const livingArea = existing + newLiving;
  const revenue = scenario.revenueMode === "sale" ? livingArea * v("salePrice")
    : pct("capitalizationRate") > 0 ? livingArea * v("monthlyRent") * 12 * (1 - pct("operatingCostRate")) / pct("capitalizationRate") : 0;
  const build = newLiving * v("constructionCost");
  const constructionCosts = existing * v("renovationCost") + build * (1 + (used.includes("contingencyRate") ? pct("contingencyRate") : 0))
    + (used.includes("demolitionCost") ? v("demolitionCost") : 0) + v("otherCost");
  const financing = constructionCosts * pct("financingRate");
  const marketing = revenue * pct("marketingRate");
  const profit = revenue * pct("profitRate");
  const totalCosts = constructionCosts + financing + marketing - v("subsidies");
  const residualLandValue = (revenue - totalCosts - profit) / (1 + pct("acquisitionCostRate"));
  const parcel = v("parcelArea");
  return { kind: scenario.kind, status: "complete", missing, unreviewed, livingArea, revenue, constructionCosts, financing, marketing, profit, totalCosts, residualLandValue,
    residualPerParcelArea: parcel > 0 ? residualLandValue / parcel : null,
    headroom: site.askingPrice?.value === null || site.askingPrice?.value === undefined ? null : residualLandValue - site.askingPrice.value };
}

/** The building model figures a study can start from, all approved values or null. */
export type FeasibilitySiteFigures = {
  parcelArea: number | null;
  grz: number | null;
  gfz: number | null;
  /** Geschossfläche of the approved Vollgeschosse of buildings marked existing or retained. */
  existingGrossFloorArea: number | null;
};
