/**
 * Which rulebook a B-Plan parcel follows. A B-Plan applies the BauNVO in the version in force when it was
 * adopted, and West Berlin's Baunutzungsplan 1960 applies the Bauordnung 1958 (BO 58) instead. The version
 * decides whether attic rooms count toward GF and how garages and ancillary structures count toward GRZ.
 * Every value here is a proposal for review, not a legal determination.
 */
import { regimeDate, type Bo58BuildingClass, type LandUseOrdinance, type PlanRegime, type PlanType } from "./planning-regime-model";

export * from "./planning-regime-model";

/**
 * What each version means for the capacity:
 * - `atticRooms`: "count" when habitable rooms in non-full storeys (attics, Staffel) always count toward GF;
 *   "plan" when they count only if the plan says so (BauNVO 1990 § 20 (3)).
 * - `ancillary`: "overrun_50" when garages, parking, access and ancillary structures count toward the footprint and
 *   may exceed GRZ by 50 %, at most 0.8 (BauNVO 1990 § 19 (4)); "not_counted" when Nebenanlagen do not count and no
 *   GRZ 2 cap exists (garages and covered parking up to 0.1 of the parcel from 1968, § 21a (3)); "unclear" when the
 *   text does not settle it (BO 58).
 */
export const ORDINANCE_RULES: Record<LandUseOrdinance, { atticRooms: "count" | "plan"; ancillary: "overrun_50" | "not_counted" | "unclear"; citation: string; inForceFrom: string | null }> = {
  baunvo_1962: { atticRooms: "count", ancillary: "not_counted", citation: "BauNVO 1962 § 19 (4), § 20 (2)", inForceFrom: "1962-08-01" },
  baunvo_1968: { atticRooms: "count", ancillary: "not_counted", citation: "BauNVO 1968 § 19 (4), § 20 (2), § 21a (3)", inForceFrom: "1969-01-01" },
  baunvo_1977: { atticRooms: "count", ancillary: "not_counted", citation: "BauNVO 1977 § 19 (4), § 20 (2), § 21a (3)", inForceFrom: "1977-10-01" },
  baunvo_1990: { atticRooms: "plan", ancillary: "overrun_50", citation: "BauNVO 1990 § 19 (4), § 20 (3)", inForceFrom: "1990-01-27" },
  bo_58: { atticRooms: "count", ancillary: "unclear", citation: "BO 58 § 7 Nr. 18, 21", inForceFrom: null },
};

/**
 * BauNVO version from the adoption date. A plan whose public display began before a new version keeps the old one
 * (transitional rules, e.g. § 25c BauNVO 1990), so adoption within two years after a change is flagged `transitional`.
 * Before the first BauNVO there is no version.
 */
export function ordinanceForAdoption(adoptedOn: string | null): { ordinance: LandUseOrdinance | null; transitional: boolean } {
  if (!adoptedOn || !regimeDate.safeParse(adoptedOn).success) return { ordinance: null, transitional: false };
  const versions = (["baunvo_1990", "baunvo_1977", "baunvo_1968", "baunvo_1962"] as const);
  for (const ordinance of versions) {
    const from = ORDINANCE_RULES[ordinance].inForceFrom!;
    if (adoptedOn >= from) {
      const twoYears = `${Number(from.slice(0, 4)) + 2}${from.slice(4)}`;
      return { ordinance, transitional: ordinance !== "baunvo_1962" && adoptedOn < twoYears };
    }
  }
  return { ordinance: null, transitional: false };
}

/** Plan type as named in Berlin's B-Plan register (`planartname`). */
export function planTypeFromRegister(name: string | null | undefined): PlanType | null {
  const n = (name ?? "").toLowerCase();
  if (n.startsWith("qualifiziert")) return "qualified";
  if (n.startsWith("einfach")) return "simple";
  if (n.startsWith("vorhabenbezogen")) return "project_specific";
  return null;
}

/** BO 58 § 7 Nr. 14 building classes: full storeys, buildable share (GRZ) and GFZ; II/1 and II/2 open, the rest closed (§ 7 Nr. 16). Class 6 is for industrial areas and uses the Baumassenzahl. */
export const BO58_CLASS_FIGURES: Record<Bo58BuildingClass, { storeys: number | null; grz: number; gfz: number | null; buildingForm: "open" | "closed" }> = {
  "II/1": { storeys: 2, grz: 0.1, gfz: 0.2, buildingForm: "open" },
  "II/2": { storeys: 2, grz: 0.2, gfz: 0.4, buildingForm: "open" },
  "II/3": { storeys: 2, grz: 0.3, gfz: 0.6, buildingForm: "closed" },
  "III/3": { storeys: 3, grz: 0.3, gfz: 0.9, buildingForm: "closed" },
  "IV/3": { storeys: 4, grz: 0.3, gfz: 1.2, buildingForm: "closed" },
  "V/3": { storeys: 5, grz: 0.3, gfz: 1.5, buildingForm: "closed" },
  "6": { storeys: null, grz: 0.6, gfz: null, buildingForm: "closed" },
};

/**
 * Berlin Ortsteile (ALKIS key `sch`) in former West Berlin, where the Baunutzungsplan 1960 applies unless a newer
 * B-Plan replaced it. Staaken was split by the 1990 border and needs a check.
 */
const WEST_DISTRICTS = ["11000004", "11000005", "11000006", "11000007", "11000008", "11000012"];
const WEST_LOCALITIES = ["110000010102", "110000010103", "110000010104", "110000010105", "110000010106", "110000020202"];
export function baunutzungsplanCoverage(localityKey: string | null | undefined): "covered" | "partial" | "none" | "unknown" {
  if (!localityKey || !/^\d{12}$/.test(localityKey)) return "unknown";
  if (localityKey === "110000050504") return "partial";
  return WEST_LOCALITIES.includes(localityKey) || WEST_DISTRICTS.includes(localityKey.slice(0, 8)) ? "covered" : "none";
}

/** The rules that apply to an assessment's regime, or null when the version is unknown (then today's BauNVO is assumed by callers). */
export const regimeRules = (regime: Pick<PlanRegime, "ordinance"> | null | undefined) => (regime?.ordinance ? ORDINANCE_RULES[regime.ordinance] : null);
