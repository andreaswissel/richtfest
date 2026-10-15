import { acousticCalculationSchema, acousticCalculationResultSchema, type AcousticCalculationInput, type AcousticCalculationResult } from "@richtfest/shared";

/** Bounded acoustic arithmetic, not a DIN/ISO compliance assessment. */
export function calculateAcoustics(raw: unknown): AcousticCalculationResult {
  const input = acousticCalculationSchema.parse(raw);
  if (input.method === "exterior_noise_batch") return calculateExteriorNoiseBatch(input);
  if (input.method === "exterior_noise_room_requirement" || input.method === "exterior_noise_facade")
    return calculateExteriorNoise(input);
  const common = {
    engine: "richtfest-acoustics" as const, version: 1 as const, method: input.method, input,
    reviewStatus: "not_reviewed" as const,
  };
  if (input.method === "composite_sound_reduction") {
    const area = input.elements.reduce((sum, element) => sum + element.areaM2, 0);
    const transmitted = input.elements.map(element => element.areaM2 * 10 ** (-element.reductionDb / 10));
    const equivalentArea = transmitted.reduce((sum, value) => sum + value, 0);
    return acousticCalculationResultSchema.parse({
      ...common, value: 10 * Math.log10(area / equivalentArea), unit: "dB",
      formula: "R = -10 log10(sum(S_i * 10^(-R_i/10)) / sum(S_i))",
      reference: "https://strutt.arup.com/help/Building_Acoustics/CompositeTL_BA.htm",
      intermediates: [
        { label: "Total partition area", value: area, unit: "m²" },
        ...input.elements.map((element, i) => ({ label: `${element.label}: equivalent transmission area`, value: transmitted[i]!, unit: "m²" })),
        { label: "Mean transmission coefficient", value: equivalentArea / area, unit: "1" },
      ],
      limitations: ["One frequency band only; not Rw, R'w, STC or a facade compliance result.",
        "Side-by-side elements under the same incident sound field; excludes flanking, junctions and installation effects.",
        "Inputs, source interpretation and applicability require specialist review. No approval or normative verification."],
    });
  }
  const observations = input.method === "sum_sound_levels" ? input.sources : input.intervals;
  const weights = input.method === "sum_sound_levels" ? input.sources.map(() => 1) : input.intervals.map(interval => interval.durationSeconds);
  const divisor = input.method === "sum_sound_levels" ? 1 : weights.reduce((sum, value) => sum + value, 0);
  // Scale around the largest level, avoiding large absolute energy values.
  const peak = Math.max(...observations.map(observation => observation.levelDb));
  const terms = observations.map((observation, i) => (weights[i]! / divisor) * 10 ** ((observation.levelDb - peak) / 10));
  const energy = terms.reduce((sum, value) => sum + value, 0);
  return acousticCalculationResultSchema.parse({
    ...common, value: peak + 10 * Math.log10(energy), unit: `dB(${input.weighting})`,
    formula: input.method === "sum_sound_levels" ? "L = 10 log10(sum(10^(L_i/10)))" : "Leq = 10 log10(sum(t_i * 10^(L_i/10)) / sum(t_i))",
    reference: input.method === "sum_sound_levels"
      ? "https://www.wkcgroup.com/tools-room/logarithmic-addition-sound-pressure-levels"
      : "https://svantek.com/academy/leq-equivalent-continuous-sound-level/",
    intermediates: [
      { label: "Scaling level", value: peak, unit: `dB(${input.weighting})` },
      ...observations.map((observation, i) => ({ label: `${observation.label}: scaled energy contribution`, value: terms[i]!, unit: "1" })),
      ...(input.method === "equivalent_sound_level" ? [{ label: "Total duration", value: divisor, unit: "s" }] : []),
    ],
    limitations: [input.method === "sum_sound_levels"
      ? "Uncorrelated simultaneous contributions at the same receiver and over the same period only. No propagation or coherent phase addition."
      : "Interval Leq values over non-overlapping intervals covering the whole period only; no Lmax averaging or regulatory time penalties.",
      "All inputs must already use the same frequency weighting and 20 µPa reference; no weighting conversion is performed.",
      "Inputs, source interpretation and applicability require specialist review. No approval or normative verification."],
  });
}

function calculateExteriorNoiseBatch(input: Extract<AcousticCalculationInput, { method: "exterior_noise_batch" }>): AcousticCalculationResult {
  const expected = new Set(input.inventory.map(r => r.roomId));
  const supplied = new Map(input.rooms.map(r => [r.room.id, r]));
  const issues: string[] = [];
  if (expected.size !== input.inventory.length) issues.push("Declared room IDs must be unique.");
  if (supplied.size !== input.rooms.length) issues.push("Calculation room IDs must be unique.");
  for (const id of supplied.keys()) if (!expected.has(id)) issues.push(`Calculation room ${id} is outside the declared inventory.`);
  const invalid = issues.length > 0;
  const rooms = input.inventory.map(({ roomId }) => {
    if (invalid) return { roomId, status: "invalid_inventory", result: null };
    const room = supplied.get(roomId);
    if (!room) {
      issues.push(`Room ${roomId}: calculation inputs are missing.`);
      return { roomId, status: "missing_input", result: null };
    }
    const result = calculateExteriorNoise({ ...room, method: "exterior_noise_facade" });
    if (result.status === "unsupported") issues.push(`Room ${roomId}: ${result.limitations[0]}`);
    return { roomId, status: result.status, result };
  });
  const complete = !invalid && rooms.every(r => r.status === "calculated");
  return acousticCalculationResultSchema.parse({
    engine: "richtfest-acoustics", version: 1, method: input.method, input,
    status: complete ? "calculated" : "unsupported", value: null, unit: "dB",
    formula: "Execute exterior_noise_facade v1 for every room in the declared inventory; no aggregate dB result.",
    reference: "https://bauleitplaene-mv.de/download/07_DIN%204109-1-863150.pdf#page=18",
    intermediates: [], batch: { complete, issues, rooms }, reviewStatus: "not_reviewed",
    limitations: [
      "Coverage refers only to the supplied room inventory, not independently verified project completeness.",
      "Complete means every declared room was calculated, not that targets are met or a person approved the inputs, rules or results.",
      "Existing exterior-noise applicability, geometry, installed-rating and flanking checks remain in force. No day/night selection or noise-source corrections are performed.",
    ],
  });
}

function calculateExteriorNoise(input: Extract<AcousticCalculationInput, { method: "exterior_noise_room_requirement" | "exterior_noise_facade" }>): AcousticCalculationResult {
  const common = {
    engine: "richtfest-acoustics", version: 1, method: input.method, input, unit: "dB", reviewStatus: "not_reviewed",
    formula: "R_required = max(La_max - K_room, minimum); K_AL = 10 log10(S_s / (0.8 S_G)); target = R_required + K_AL + 2",
    reference: "https://bauleitplaene-mv.de/download/07_DIN%204109-1-863150.pdf#page=18",
  };
  const limitations = [
    "DIN 4109-1/-2:2018-01 scoped numerical screening, not a certified Schallschutznachweis or approval. Current legal applicability and contractual targets require specialist review.",
    "La must already be assessed for the room and relevant source/time conditions. No propagation, day/night selection, spectral or noise corrections are performed.",
    "Geometry, component ratings, completeness and applicability are supplied claims, not verified facts. Assumptions remain assumptions.",
  ];
  const unsupported = (reason: string) => acousticCalculationResultSchema.parse({ ...common,
    status: "unsupported", value: null, intermediates: [], limitations: [reason, ...limitations],
  });
  if (input.applicability.assessment !== "standard_exterior_noise")
    return unsupported("Project applicability is unknown or requires special assessment (including aircraft-law or special low-frequency cases).");
  if (!input.envelopeComplete) return unsupported("Room exterior envelope is incomplete; include every exterior wall and roof surface.");
  if (new Set(input.facades.map(f => f.id)).size !== input.facades.length)
    return unsupported("Facade IDs must be unique.");
  const exteriorArea = input.facades.reduce((sum, f) => sum + f.areaM2, 0);
  const maximumLa = Math.max(...input.facades.map(f => f.noise.levelDb));
  const roomFactor = input.room.use === "hospital_bedroom" ? 25 : input.room.use === "office" ? 35 : 30;
  const minimum = input.room.use === "hospital_bedroom" ? 35 : 30;
  const required = Math.max(maximumLa - roomFactor, minimum);
  if (maximumLa > 80 || required > 50)
    return unsupported("La above 80 dB or base requirement above 50 dB requires site-specific requirements (DIN 4109-1:2018-01 §7.1).");
  const geometry = 10 * Math.log10(exteriorArea / (0.8 * input.room.floorAreaM2));
  const target = required + geometry + 2;
  const exteriorNoise = { baseRequiredDb: required, geometryCorrectionDb: geometry,
    prognosisUncertaintyDb: 2, targetRwDb: target, marginDb: null as number | null, comparison: "not_evaluated" };
  const intermediates = [
    { label: "Maximum assessed La", value: maximumLa, unit: "dB" },
    { label: "Room-use factor K_Raumart", value: roomFactor, unit: "dB" },
    { label: "Minimum base requirement", value: minimum, unit: "dB" },
    { label: "Base requirement before geometry and uncertainty", value: required, unit: "dB" },
    { label: "Total exterior area S_s", value: exteriorArea, unit: "m²" },
    { label: "Geometry correction K_AL", value: geometry, unit: "dB" },
    { label: "Prognosis uncertainty u_prog", value: 2, unit: "dB" },
    { label: "Target performance including geometry and uncertainty", value: target, unit: "dB" },
  ];
  if (input.method === "exterior_noise_room_requirement") return acousticCalculationResultSchema.parse({
    ...common, value: target, intermediates, exteriorNoise, limitations,
  });
  if (!input.elementsComplete) return unsupported("Facade element inventory is incomplete; missing openings or ventilation cannot be omitted.");
  if (input.flanking.assessment !== "negligible") return unsupported("Flanking is required or unresolved. Detailed transmission-path calculation is not implemented.");
  if (new Set(input.elements.map(e => e.id)).size !== input.elements.length)
    return unsupported("Element IDs must be unique; use count for identical small elements.");
  const facades = new Map(input.facades.map(f => [f.id, f]));
  for (const e of input.elements) {
    if (!facades.has(e.facadeId)) return unsupported(`Element ${e.id} references an unknown facade.`);
    if (e.ratingBasis !== "installed_configuration") return unsupported(`Element ${e.id} lacks an installed-configuration rating; verify size, joints, length and operating state first.`);
    if (e.kind === "area" && e.construction === "unknown") return unsupported(`Construction type of ${e.id} is unknown; flanking applicability cannot be determined.`);
    // Conservative gate: do not let a negative geometry correction erase the
    // base threshold, or a positive correction hide a high-performing facade.
    if (e.kind === "area" && e.construction === "massive" && e.rwDb >= 50 && Math.max(required, required + geometry) > 40)
      return unsupported(`Massive element ${e.id} has Rw >= 50 dB with a base or geometry-adjusted requirement > 40 dB. Detailed flanking review is required, including Fd for non-massive adjoining flanks.`);
  }
  for (const f of input.facades) {
    const covered = input.elements.filter(e => e.facadeId === f.id)
      .reduce((sum, e) => sum + (e.kind === "area" ? e.areaM2 : e.openingAreaM2 * e.count), 0);
    // Allow only a 0.01 m² tabulation-rounding discrepancy, not missing elements.
    if (Math.abs(covered - f.areaM2) > 0.01 + 1e-9)
      return unsupported(`Element areas do not account for facade ${f.id} within 0.01 m²; check gaps, overlaps and double-counted openings.`);
  }
  const transmission = input.elements.map(e => {
    const bonus = maximumLa - facades.get(e.facadeId)!.noise.levelDb;
    const rating = e.kind === "area" ? e.rwDb : e.dnEWDb;
    const referenceArea = e.kind === "area" ? e.areaM2 : 10;
    const normalized = rating + 10 * Math.log10(exteriorArea / referenceArea) + bonus;
    const contribution = (e.kind === "small" ? e.count : 1) * 10 ** (-normalized / 10);
    intermediates.push({ label: `${e.id}: exposure correction K_LPB`, value: bonus, unit: "dB" },
      { label: `${e.id}: normalized R_e,i,w per element`, value: normalized, unit: "dB" },
      { label: `${e.id}: transmission contribution including count`, value: contribution, unit: "1" });
    return contribution;
  });
  const value = -10 * Math.log10(transmission.reduce((sum, t) => sum + t, 0));
  const margin = value - target;
  return acousticCalculationResultSchema.parse({ ...common, value,
    formula: `${common.formula}; R_e,i,w = rating + 10 log10(S_s / S_i_or_A0) + (La_max - La_i); R_w,ges = -10 log10(sum(n_i * 10^(-R_e,i,w/10))); A0 = 10 m²; margin = R_w,ges - target`,
    reference: "https://www.institut-holzbau.de/wp-content/uploads/2024/05/2024-05-24_DIN-4109-2018_Beispiel_Aussenlaermnachweis-1.pdf#page=13",
    intermediates, exteriorNoise: { ...exteriorNoise, marginDb: margin, comparison: margin >= 0 ? "meets_numeric_target" : "below_numeric_target" },
    limitations: [...limitations,
      "Simplified weighted-index facade method, not the generic single-band composite tool. Assumes negligible flanking; no flanking paths are calculated.",
      "Method cross-reference: Ziegel, Baulicher Schallschutz, March 2022, pp. 45–47. The high-performing massive-element gate is deliberately conservative. Area agreement is not proof of a complete inventory.",
      "Numerical comparison uses unrounded values and a fixed 2 dB prognosis allowance, not a compliance verdict. No tolerance is added to the comparison margin.",
    ],
  });
}
