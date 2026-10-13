import type { AcousticCalculationInput } from "../../richtfest-shared/src/acoustic-calculation";

/** Ziegel, March 2022, pp. 103–104: tabulated values, not reconciled project geometry.
 * The printed window dimensions/area and net-wall subtraction disagree. Keep this
 * explicitly unreviewed; use independent arithmetic expectations in the tests.
 */
export function exteriorNoiseFixture(): Extract<AcousticCalculationInput, { method: "exterior_noise_facade" }> {
  const provenance = { kind: "assumption" as const, reason: "Synthetic test transcription of the rounded Ziegel 2022 tables 8.15–8.16, pp. 103–104; geometry inconsistencies unresolved." };
  const configuration = "Fixture: installed size, sealed joints and assessed operating state assumed, not verified.";
  const ratingBasis = "installed_configuration" as const;
  const areaElement = (id: string, facadeId: string, areaM2: number, rwDb: number, construction: "massive" | "window_or_door") =>
    ({ id, facadeId, kind: "area" as const, areaM2, rwDb, construction, configuration, ratingBasis, provenance });
  return {
    method: "exterior_noise_facade", standard: "DIN 4109-1/-2:2018-01",
    room: { id: "example-corner-room", use: "residential_accommodation_classroom", floorAreaM2: 12, provenance },
    applicability: { assessment: "standard_exterior_noise", basis: "Synthetic method exercise; no legal applicability decision", provenance },
    envelopeComplete: true,
    facades: [
      { id: "wall-1", areaM2: 10.56, provenance, noise: { metric: "La", levelDb: 70, basis: "Assessed design value from example", provenance } },
      { id: "wall-5", areaM2: 7.11, provenance, noise: { metric: "La", levelDb: 68, basis: "Assessed design value from example", provenance } },
    ],
    elementsComplete: true, flanking: { assessment: "negligible", provenance },
    elements: [
      areaElement("opaque-1", "wall-1", 8.92, 49.5, "massive"),
      areaElement("window-1", "wall-1", 1.25, 39, "window_or_door"),
      areaElement("shutter-1", "wall-1", 0.38, 49, "window_or_door"),
      { id: "vent-1", facadeId: "wall-1", kind: "small", dnEWDb: 49, count: 1, openingAreaM2: 0.02, configuration, ratingBasis, provenance },
      areaElement("opaque-5", "wall-5", 4.46, 49.5, "massive"),
      areaElement("window-5", "wall-5", 2.27, 39, "window_or_door"),
      areaElement("shutter-5", "wall-5", 0.38, 49, "window_or_door"),
    ],
  };
}
