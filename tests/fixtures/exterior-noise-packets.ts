import type { ExteriorNoiseFact } from "../../richtfest-shared/src/acoustic-calculation";

/** Independently specified synthetic schedule/element packets; no reference answers. */
export function exteriorNoisePackets(versionId = "10000000-0000-4000-8000-000000000001") {
  const provenance = { kind: "source" as const, versionId, page: 1,
    excerpt: "A01: floor 20 m²; facade F1 10 m²; opaque W1 8 m² Rw 50 dB; window FE1 2 m² Rw 35 dB; assessed La 65 dB." };
  const facts: ExteriorNoiseFact[] = [];
  const record = (target: ExteriorNoiseFact["target"], id: string, values: Record<string, ExteriorNoiseFact["value"]>) => {
    for (const [field, value] of Object.entries(values)) facts.push({ roomId: "A01", target, id, field, value, provenance });
  };
  record("room", "A01", { use: "residential_accommodation_classroom", floorAreaM2: 20 });
  record("coverage", "A01", { standard: "DIN 4109-1/-2:2018-01", envelopeComplete: true, elementsComplete: true });
  record("applicability", "A01", { assessment: "standard_exterior_noise", basis: "Synthetic standard case" });
  record("flanking", "A01", { assessment: "negligible" });
  record("facade", "F1", { areaM2: 10 });
  record("noise", "F1", { metric: "La", levelDb: 65, basis: "Synthetic already assessed exterior level" });
  record("element", "W1", { kind: "area", facadeId: "F1", areaM2: 8, rwDb: 50,
    construction: "massive", ratingBasis: "installed_configuration", configuration: "Synthetic installed sealed wall" });
  record("element", "FE1", { kind: "area", facadeId: "F1", areaM2: 2, rwDb: 35,
    construction: "window_or_door", ratingBasis: "installed_configuration", configuration: "Synthetic installed closed window" });
  const packet = (values: ExteriorNoiseFact[]) => ({ inventory: [{ roomId: "A01", provenance }], rooms: [], facts: values, blockers: [] });
  return [packet(facts.filter(f => f.target !== "element")), packet(facts.filter(f => f.target === "element"))];
}
