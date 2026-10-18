import type { FeasibilityScenario, FeasibilityScenarioKind, FeasibilitySiteFigures, FeasibilityStudyInput, FeasibilityValue } from "@richtfest/shared";

/**
 * Starting values for a new study. Company calculation standards (Richtfest
 * Kalkulations-Standards, May 2026) are proposals marked "standard", never
 * reviewed: they are experience values to verify per project. Building model
 * figures are approved values derived from the zoning check. Everything else
 * starts empty so a missing input is visible instead of silently assumed.
 */
const standard = (value: number, note: string): FeasibilityValue => ({ value, source: "standard", note, reviewed: false });
const fromModel = (value: number, note: string): FeasibilityValue => ({ value: Math.round(value * 100) / 100, source: "building_model", note, reviewed: false });
const decimal = (value: number) => value.toLocaleString("de-DE", { maximumFractionDigits: 2 });

export const calculationStandards = {
  constructionCost: standard(3000, "Kalkulations-Standard 05/2026: Zielmarke KG 300–700 brutto für ein optimiertes MFH"),
  contingencyRate: standard(20, "Kalkulations-Standard 05/2026: Wagnis 20 % auf KG 300–700"),
  capitalizationRate: standard(3.8, "Kalkulations-Standard 05/2026: Liegenschaftszins Marktsicht"),
} as const;

export function initialStudy(figures: FeasibilitySiteFigures): Omit<FeasibilityStudyInput, "baseRevision"> {
  const maxFloorArea = figures.gfz !== null && figures.parcelArea !== null ? figures.gfz * figures.parcelArea : null;
  const maxNote = maxFloorArea === null ? "" : `GFZ ${decimal(figures.gfz!)} × ${decimal(figures.parcelArea!)} m² Grundstück`;
  const scenario = (kind: FeasibilityScenarioKind): FeasibilityScenario => {
    const values: FeasibilityScenario["values"] = {};
    if (kind !== "existing") Object.assign(values, { constructionCost: calculationStandards.constructionCost, contingencyRate: calculationStandards.contingencyRate });
    if (kind === "new_build" && maxFloorArea !== null) values.newGrossFloorArea = fromModel(maxFloorArea, `${maxNote} (zulässig nach Bebauungsplan)`);
    if (kind === "densify" && maxFloorArea !== null && figures.existingGrossFloorArea !== null && maxFloorArea > figures.existingGrossFloorArea)
      values.newGrossFloorArea = fromModel(maxFloorArea - figures.existingGrossFloorArea, `${maxNote} − ${decimal(figures.existingGrossFloorArea)} m² Bestand`);
    values.capitalizationRate = calculationStandards.capitalizationRate;
    return { kind, revenueMode: "sale", values };
  };
  return {
    site: figures.parcelArea === null ? {} : { parcelArea: fromModel(figures.parcelArea, "Grundstücksfläche aus dem Gebäudemodell") },
    scenarios: [scenario("existing"), scenario("densify"), scenario("new_build")],
    notes: "",
  };
}
