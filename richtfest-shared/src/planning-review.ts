import { calculateSiteAssessment, type SiteAssessmentInput } from "./site-assessment";

/**
 * What each planning limit does to capacity, the deviation routes worth asking for and the land-register
 * enquiries a B-Plan check leaves open. All of it is derived from the assessment input, so it is recomputed
 * rather than stored; the figures are arithmetic on the capacity envelope, not a permit forecast.
 */

type Constraints = SiteAssessmentInput["constraints"];
export type CapacityLimitKey = "grz" | "grz2" | "buildableFootprint" | "maxFullStoreys" | "gfz";
export type LimitEffect =
  /** The limit decides capacity; `cost` is the BGF gained if it alone were lifted (0 when another limit binds too). */
  | { kind: "binding"; cost: number }
  /** The limit leaves room; `reserve` is the BGF by which it could tighten before it binds. */
  | { kind: "reserve"; reserve: number }
  /** Street or other non-building land on the parcel; `cost` is the BGF the full parcel would add. */
  | { kind: "street_land"; cost: number; area: number }
  /** Additional Staffel or attic area on top of the full storeys. */
  | { kind: "adds"; area: number };

/** Upper bounds of the input schema: a lifted limit no longer constrains anything. */
const LIFTED: Record<CapacityLimitKey, number> = { grz: 1, grz2: 1, buildableFootprint: 1e9, maxFullStoreys: 200, gfz: 100 };

const withValues = (input: SiteAssessmentInput, values: Partial<Record<keyof Constraints, number>>): SiteAssessmentInput => ({
  ...input,
  constraints: Object.fromEntries(Object.entries(input.constraints).map(([key, c]) => [key, key in values && c ? { ...c, value: values[key as keyof Constraints]! } : c])) as Constraints,
});
const baselineBgf = (input: SiteAssessmentInput) => calculateSiteAssessment(input).baseline?.grossFloorArea ?? null;

/**
 * Effect of every capacity input on the baseline BGF. `grossParcelArea` is the drawn parcel; when the parcel area
 * entered for GRZ and GFZ is smaller (§ 19 (3) BauNVO, street land), the difference is reported on `parcelArea`.
 */
export function limitEffects(input: SiteAssessmentInput, grossParcelArea?: number | null): Partial<Record<keyof Constraints, LimitEffect>> {
  const baseline = calculateSiteAssessment(input).baseline;
  if (!baseline) return {};
  const effects: Partial<Record<keyof Constraints, LimitEffect>> = {};
  const storeys = input.constraints.maxFullStoreys.value ?? 0;
  for (const limit of baseline.limits) {
    if (baseline.bindingConstraints.includes(limit.id)) {
      const lifted = baselineBgf(withValues(input, { [limit.id]: LIFTED[limit.id] }));
      effects[limit.id] = { kind: "binding", cost: Math.max(0, (lifted ?? baseline.grossFloorArea) - baseline.grossFloorArea) };
    } else {
      // A footprint limit is measured at the storeys built: it binds once its envelope falls to the floor area actually reached.
      const room = (limit.unit === "footprint_m2" ? limit.capacity * storeys : limit.capacity) - baseline.fullFloorArea;
      effects[limit.id] = { kind: "reserve", reserve: Math.max(0, room) };
    }
  }
  const parcel = input.constraints.parcelArea.value;
  if (grossParcelArea && parcel !== null && grossParcelArea - parcel > 0.5) {
    const full = baselineBgf(withValues(input, { parcelArea: grossParcelArea }));
    if (full !== null) effects.parcelArea = { kind: "street_land", cost: Math.max(0, full - baseline.grossFloorArea), area: grossParcelArea - parcel };
  }
  const extra = input.constraints.additionalGrossArea.value;
  if (extra) effects.additionalGrossArea = { kind: "adds", area: extra };
  return effects;
}

export type DeviationRoute = "exemption_31_2" | "housing_exemption_31_3" | "housing_turbo_246e";
export type DeviationScenario = {
  route: DeviationRoute;
  /** The figures the route would change, as asked for. */
  change: Partial<Record<"grz" | "gfz" | "maxFullStoreys", number>>;
  grossFloorArea: number;
  gain: number;
  /** Condition codes, in the order a person checks them. */
  conditions: string[];
  /** Typical added time before a permit, in months. */
  months: [number, number];
  /** Qualitative and deliberately coarse: an exemption is a discretionary decision. */
  outlook: "plausible" | "open";
  citation: string;
};

/** Small overrun treated as not touching the plan's core concept (Grundzüge der Planung); a working assumption, not case law. */
const MINOR_OVERRUN = 0.1;

/**
 * Deviation routes for a B-Plan site whose capacity is limited by the plan, each with the capacity it would reach.
 * § 31 (2) asks for a small overrun of the binding density figure; the housing routes ask for one or two more full
 * storeys with the density they need. Storey routes only appear when storeys or density bind.
 */
export function deviationScenarios(input: SiteAssessmentInput): DeviationScenario[] {
  if (input.planningBasis !== "b_plan") return [];
  const baseline = calculateSiteAssessment(input).baseline;
  const c = input.constraints;
  if (!baseline || c.grz.value === null || c.gfz.value === null || c.maxFullStoreys.value === null || c.parcelArea.value === null) return [];
  const binding = new Set(baseline.bindingConstraints);
  const scenarios: DeviationScenario[] = [];
  const add = (route: DeviationRoute, change: DeviationScenario["change"], rest: Omit<DeviationScenario, "route" | "change" | "grossFloorArea" | "gain">) => {
    const bgf = baselineBgf(withValues(input, change));
    if (bgf === null || bgf - baseline.grossFloorArea < 1) return;
    scenarios.push({ route, change, grossFloorArea: bgf, gain: bgf - baseline.grossFloorArea, ...rest });
  };
  const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  const minor: DeviationScenario["change"] = {};
  if (binding.has("gfz")) minor.gfz = round(c.gfz.value * (1 + MINOR_OVERRUN), 2);
  if (binding.has("grz")) minor.grz = Math.min(1, round(c.grz.value * (1 + MINOR_OVERRUN), 2));
  if (Object.keys(minor).length) {
    add("exemption_31_2", minor, { conditions: ["core_concept_untouched", "justified", "neighbours_considered"], months: [0, 2], outlook: "plausible", citation: "§ 31 (2) BauGB" });
  }
  if (binding.has("maxFullStoreys") || binding.has("gfz")) {
    // More storeys only add floor area if the density follows; ask for the GFZ the taller envelope needs.
    const storeysFor = (extra: number) => {
      const storeys = c.maxFullStoreys.value! + extra;
      const gfz = Math.min(100, Math.max(c.gfz.value!, round((baseline.footprint * storeys + (c.additionalCountableArea.value ?? 0)) / c.parcelArea.value!, 2)));
      return { maxFullStoreys: storeys, gfz };
    };
    add("housing_exemption_31_3", storeysFor(1), { conditions: ["housing_use", "municipal_consent", "neighbours_considered"], months: [3, 6], outlook: "open", citation: "§ 31 (3), § 36a BauGB" });
    add("housing_turbo_246e", storeysFor(2), { conditions: ["housing_use", "municipal_consent", "consent_terms", "specialist_law"], months: [4, 9], outlook: "open", citation: "§ 246e, § 36a BauGB (until 31 Dec 2030)" });
  }
  return scenarios;
}

export type SiteTaskKey = "encumbrances_register" | "land_register_section_2";
export type SiteTaskProposal = { key: SiteTaskKey; reason: "boundary_building" | "always" | "rights_open" };

/**
 * Enquiries the plan cannot answer: the Baulastenverzeichnis (public-law encumbrances, e.g. setback areas taken
 * over for a neighbour) and section II of the Grundbuch (easements such as utility or access rights).
 */
export function siteTaskProposals(input: SiteAssessmentInput): SiteTaskProposal[] {
  if (!input.geometry?.parcel && input.constraints.parcelArea.value === null) return [];
  const boundary = input.designRules?.buildingForm === "closed" || /geschlossen|\bg\b/i.test(input.planningFacts?.buildingForm?.value ?? "");
  return [
    { key: "encumbrances_register", reason: boundary ? "boundary_building" : "always" },
    { key: "land_register_section_2", reason: input.checks.rights.status === "unresolved" ? "rights_open" : "always" },
  ];
}
