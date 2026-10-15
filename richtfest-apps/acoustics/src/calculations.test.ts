import { expect, test } from "bun:test";
import { calculateAcoustics } from "./calculations";
import { exteriorNoiseFixture } from "../../../tests/fixtures/exterior-noise";
import { acousticInputProvenance, renderAcousticCalculationReceipts, selectAcousticCalculationReportReceipts, type AcousticCalculationReceipt } from "../../../richtfest-shared/src/acoustic-calculation";

const provenance = { kind: "assumption", reason: "Synthetic arithmetic verification, not project evidence" } as const;
const observation = (levelDb: number) => ({ label: `Level ${levelDb}`, levelDb, provenance });
const context = { receiver: "Test receiver", weighting: "A" as const };
const sum = { ...context, method: "sum_sound_levels" as const, period: "Simultaneous", uncorrelatedSources: true as const };

const receipt = (input: Parameters<typeof calculateAcoustics>[0]): AcousticCalculationReceipt => ({
  ...calculateAcoustics(input), receiptId: "11111111-1111-4111-8111-111111111111",
});
const sourceProvenance = { kind: "source", versionId: "22222222-2222-4222-8222-222222222222", page: 3, excerpt: "Measured source level" } as const;

test("batch calculations preserve every declared room, numeric sign, blockers and input provenance", () => {
  const rooms = Array.from({ length: 62 }, (_, i) => {
    const { method, ...input } = exteriorNoiseFixture();
    input.room.id = `Room ${i + 1}`;
    input.room.provenance = sourceProvenance;
    if (i === 1) input.facades.forEach(f => { f.noise.levelDb += 0.04; });
    if (i === 2) input.envelopeComplete = false;
    return input;
  });
  const inventory = rooms.map(r => ({ roomId: r.room.id, provenance: sourceProvenance }));
  const input = { method: "exterior_noise_batch", scope: "Synthetic 62-room inventory", inventory, rooms: rooms.slice(0, 61).reverse() };
  const result = receipt(input as any);
  expect(result).toMatchObject({ status: "unsupported", value: null, batch: { complete: false } });
  expect(result.batch!.rooms.map(r => r.roomId)).toEqual(inventory.map(r => r.roomId));
  expect(result.batch!.rooms.filter(r => r.status === "calculated")).toHaveLength(60);
  expect(result.batch!.rooms[0]!.result?.value).toBeCloseTo(44.66896537322387, 10);
  expect(result.batch!.rooms[1]!.result?.exteriorNoise).toMatchObject({ comparison: "below_numeric_target" });
  expect(result.batch!.rooms[1]!.result?.exteriorNoise?.marginDb).toBeCloseTo(-0.020687791448087654, 10);
  expect(result.batch!.rooms[2]).toMatchObject({ status: "unsupported", result: { value: null } });
  expect(result.batch!.rooms[61]).toMatchObject({ status: "missing_input", result: null });
  expect(acousticInputProvenance(result.input).filter(p => p.kind === "source")).toHaveLength(123);
  for (const language of ["en", "de"] as const) {
    const rendered = renderAcousticCalculationReceipts([result], language);
    expect(rendered).toContain("60/62");
    expect(rendered).toContain("| Room 2 | 44.690 | 44.669 | -0.021 |");
    expect(rendered).toContain(language === "en" ? "Below target" : "Unter Ziel");
    expect(rendered).toContain("| Room 62 | — | — | — |");
    expect(rendered).toContain(sourceProvenance.versionId);
    expect(rendered).not.toContain(result.receiptId);
  }
  const complete = calculateAcoustics({ ...input, inventory: inventory.slice(0, 2), rooms: rooms.slice(0, 2) });
  expect(complete.batch?.complete).toBe(true); // Calculated does not mean every room meets its target.
  expect(complete.batch?.rooms[1]?.result?.exteriorNoise?.comparison).toBe("below_numeric_target");
  for (const invalid of [
    { ...input, inventory: [...inventory, inventory[0]] },
    { ...input, rooms: [rooms[0], rooms[0]] },
    { ...input, inventory: inventory.slice(0, 1) },
  ]) {
    const blocked = calculateAcoustics(invalid);
    expect(blocked.batch?.complete).toBe(false);
    expect(blocked.batch?.rooms.every(r => r.status === "invalid_inventory" && r.result === null)).toBe(true);
  }
  const assumptionOnly = exteriorNoiseFixture();
  const { method, ...assumptionRoom } = assumptionOnly;
  const mixed = receipt({ method: "exterior_noise_batch", scope: "Mixed evidence", inventory: [
    inventory[0]!, { roomId: assumptionRoom.room.id, provenance },
  ], rooms: [rooms[0]!, assumptionRoom] });
  expect(renderAcousticCalculationReceipts([mixed], "en")).toContain(`| ${assumptionRoom.room.id} | — | — | — | Assumptions only |`);
});

test("project reports preserve source-backed zero and mixed provenance with exact saved fields", () => {
  const zero = receipt({ ...sum, sources: [{ ...observation(0), provenance: sourceProvenance }] });
  const mixed = receipt({ ...sum, sources: [{ ...observation(60), provenance: sourceProvenance }, observation(70)] });
  expect(selectAcousticCalculationReportReceipts([zero, mixed])).toEqual([zero, mixed]);
  const report = renderAcousticCalculationReceipts([zero, mixed], "en");
  expect(report).toContain("| Result | 0 dB(A) |");
  expect(report).toContain(`| Result | ${mixed.value} dB(A) |`);
  expect(report).toContain("sources.0.levelDb");
  expect(report).toContain(sourceProvenance.versionId);
  expect(report).toContain("Page 3");
  expect(report).toContain(sourceProvenance.excerpt);
  expect(report).toContain(`Assumption: ${provenance.reason}`);
  for (const limitation of mixed.limitations) expect(report).toContain(limitation);
  expect(report).not.toContain("were excluded");
});

test("assumption-only zero and nonzero receipts stay durable but are excluded once per report in either language", () => {
  const receipts = [0, 73].map(level => receipt({ ...sum, sources: [observation(level)] }));
  const original = structuredClone(receipts);
  expect(selectAcousticCalculationReportReceipts(receipts)).toEqual([]);
  for (const language of ["en", "de"] as const) {
    const report = renderAcousticCalculationReceipts(receipts, language);
    expect(report.split("\n")).toHaveLength(1);
    expect(report).toContain(language === "en" ? "not project results" : "keine Projektergebnisse");
    expect(report).toContain(language === "en" ? "execution ledger" : "Ausführungsprotokoll");
    expect(report).not.toContain("|");
    expect(report).not.toContain("sum_sound_levels");
    expect(report).not.toContain(receipts[0]!.formula);
    expect(report).not.toContain(provenance.reason);
  }
  expect(receipts).toEqual(original);
  expect(renderAcousticCalculationReceipts([], "en")).toBe("");
});

test("unsupported assumption-only attempts retain blocking reasons, never a numeric result", () => {
  const input = exteriorNoiseFixture();
  input.envelopeComplete = false;
  const blocked = receipt(input);
  expect(blocked.status).toBe("unsupported");
  expect(selectAcousticCalculationReportReceipts([blocked])).toEqual([blocked]);
  for (const language of ["en", "de"] as const) {
    const report = renderAcousticCalculationReceipts([blocked], language);
    expect(report).toContain(language === "en" ? "Unsupported – no calculated result" : "Nicht unterstützt – kein Rechenergebnis");
    expect(report).toContain(language === "en" ? "| Result | — |" : "| Ergebnis | — |");
    for (const reason of blocked.limitations) expect(report).toContain(reason);
    expect(report).not.toContain("Intermediate results");
    expect(report).not.toContain("Numerical comparison");
    expect(report).not.toContain("were excluded");
  }
});

test("sound energy addition and duration averaging match independently derived ratios", () => {
  // 10^6 + 10^7 = 11,000,000; not 65 dB or 130 dB.
  const added = calculateAcoustics({ ...sum, sources: [observation(60), observation(70)] });
  expect(added.value).toBeCloseTo(70.41392685158225, 10);
  expect(added).toMatchObject({ engine: "richtfest-acoustics", version: 1, unit: "dB(A)", reviewStatus: "not_reviewed" });
  expect(added.input).toMatchObject({ sources: [{ provenance }, { provenance }] });
  // (1 × 10^7 + 9 × 10^5) / 10 = 1,090,000; unequal durations expose averaging mistakes.
  const averaged = calculateAcoustics({ ...context, method: "equivalent_sound_level", intervals: [
    { ...observation(70), durationSeconds: 1 }, { ...observation(50), durationSeconds: 9 },
  ] });
  expect(averaged.value).toBeCloseTo(60.37426497940624, 10);
  expect(averaged.intermediates.at(-1)).toEqual({ label: "Total duration", value: 10, unit: "s" });
  expect(calculateAcoustics({ ...sum, sources: [observation(-40), observation(-30)] }).value).toBeCloseTo(-29.58607314841775, 10);
  expect(calculateAcoustics({ ...sum, sources: [observation(300), observation(-200)] }).value).toBe(300);
});

test("composite band reduction uses transmitted energy, not averaged ratings or layers", () => {
  // 9 m² at 50 dB and 1 m² at 20 dB: tau = (0.00009 + 0.01) / 10 = 0.001009.
  const input = { method: "composite_sound_reduction", bandCentreHz: 500, bandwidth: "third_octave", elements: [
    { label: "Wall", areaM2: 9, reductionDb: 50, provenance },
    { label: "Window", areaM2: 1, reductionDb: 20, provenance },
  ] };
  const result = calculateAcoustics(input);
  expect(result.value).toBeCloseTo(29.96108833763089, 10);
  expect(result.intermediates.at(-1)?.value).toBeCloseTo(0.001009, 12);
  expect(result.limitations.join(" ")).toContain("not Rw");
  expect(calculateAcoustics({ ...input, elements: input.elements.map(e => ({ ...e, areaM2: e.areaM2 * 7 })) }).value).toBeCloseTo(29.96108833763089, 12);
  expect(calculateAcoustics({ ...input, elements: [{ ...input.elements[0], reductionDb: 0 }] }).value).toBe(0);
});

test("calculation schemas reject unsupported quantities, units, nonfinite numbers and missing evidence", () => {
  for (const bad of [NaN, Infinity, -Infinity, "60", 301, -201])
    expect(() => calculateAcoustics({ ...sum, sources: [observation(bad as number)] })).toThrow();
  expect(() => calculateAcoustics({ ...sum, sources: [] })).toThrow();
  expect(() => calculateAcoustics({ ...sum, sources: [{ label: "Untraceable", levelDb: 60 }] })).toThrow();
  expect(() => calculateAcoustics({ ...sum, weighting: "mixed", sources: [observation(60)] })).toThrow();
  expect(() => calculateAcoustics({ ...sum, uncorrelatedSources: false, sources: [observation(60)] })).toThrow();
  for (const durationSeconds of [0, -1, Infinity, Number.MIN_VALUE])
    expect(() => calculateAcoustics({ ...context, method: "equivalent_sound_level", intervals: [{ ...observation(60), durationSeconds }] })).toThrow();
  const band = { method: "composite_sound_reduction", bandCentreHz: 500, bandwidth: "octave" };
  expect(() => calculateAcoustics({ ...band, elements: [{ label: "Wall", areaM2: 0, reductionDb: 30, provenance }] })).toThrow();
  expect(() => calculateAcoustics({ ...band, elements: [{ label: "Wall", areaM2: 10, rwDb: 30, provenance }] })).toThrow();
  expect(() => calculateAcoustics({ method: "din_4109_compliance" })).toThrow();
});

test("exterior room targets preserve use minima, geometry, uncertainty and high-noise limits", () => {
  const { elements, elementsComplete, flanking, ...base } = exteriorNoiseFixture();
  const room = { ...base, method: "exterior_noise_room_requirement" as const };
  room.room.floorAreaM2 = 20;
  room.facades = [{ ...room.facades[0]!, areaM2: 16 }]; // S_s/(0.8 S_G) = 1.
  for (const [use, lowTarget, highTarget, upperLa] of [
    ["hospital_bedroom", 37, 47, 75], ["residential_accommodation_classroom", 32, 42, 80], ["office", 32, 37, 80],
  ] as const) {
    room.room.use = use;
    room.facades[0]!.noise.levelDb = 55;
    expect(calculateAcoustics(room).value).toBe(lowTarget);
    room.facades[0]!.noise.levelDb = 70;
    expect(calculateAcoustics(room)).toMatchObject({ value: highTarget, status: "calculated",
      exteriorNoise: { geometryCorrectionDb: 0, prognosisUncertaintyDb: 2, comparison: "not_evaluated", marginDb: null } });
    room.facades[0]!.noise.levelDb = upperLa;
    expect(calculateAcoustics(room).status).toBe("calculated");
    room.facades[0]!.noise.levelDb += 0.001;
    expect(calculateAcoustics(room)).toMatchObject({ status: "unsupported", value: null });
  }
  room.room.use = "residential_accommodation_classroom";
  room.facades[0]!.noise.levelDb = 55;
  room.room.floorAreaM2 = 40;
  expect(calculateAcoustics(room).value).toBeCloseTo(28.98970004336019, 10);
  expect(() => calculateAcoustics({ ...room, standard: "DIN 4109:1989" })).toThrow();
  expect(() => calculateAcoustics({ ...room, facades: [{ ...room.facades[0], noise: { ...room.facades[0]!.noise, metric: "Lden" } }] })).toThrow();
});

test("weighted facade composition matches the tabulated example without rounding a near failure into success", () => {
  const input = exteriorNoiseFixture();
  const result = calculateAcoustics(input);
  // Independently evaluated from the seven table rows, not the displayed 44.7/2.6.
  expect(result.value).toBeCloseTo(44.66896537322387, 10);
  expect(result.exteriorNoise?.geometryCorrectionDb).toBeCloseTo(2.6496531646719567, 10);
  expect(result.exteriorNoise?.marginDb).toBeCloseTo(0.019312208551912345, 10);
  expect(result.exteriorNoise?.comparison).toBe("meets_numeric_target");
  expect(result.reviewStatus).toBe("not_reviewed");
  input.facades.forEach(f => { f.noise.levelDb += 0.04; }); // Same orientation differences; only the requirement changes.
  const nearFailure = calculateAcoustics(input);
  expect(nearFailure.value).toBeCloseTo(44.66896537322387, 10);
  expect(nearFailure.exteriorNoise?.marginDb).toBeCloseTo(-0.020687791448087654, 10);
  expect(nearFailure.exteriorNoise?.comparison).toBe("below_numeric_target");
});

test("small elements use A0 and multiplicity, not physical opening area as acoustic area", () => {
  const input = exteriorNoiseFixture();
  // One 10 m², 40 dB component transmits 0.001 m² equivalent area.
  // Each Dn,e,w=40 element contributes another 0.001 m², independent of its opening area.
  input.room.floorAreaM2 = 12.5;
  input.facades = [{ ...input.facades[0]!, areaM2: 10 }];
  input.facades[0]!.noise.levelDb = 60;
  input.elements = [
    { ...input.elements[0]!, kind: "area", rwDb: 40, areaM2: 10, construction: "massive" },
    { ...input.elements[3]!, kind: "small", dnEWDb: 40, count: 1, openingAreaM2: 0 },
  ];
  expect(calculateAcoustics(input).value).toBeCloseTo(36.98970004336019, 10);
  if (input.elements[1]!.kind === "small") input.elements[1]!.count = 2;
  expect(calculateAcoustics(input).value).toBeCloseTo(35.228787452803374, 10);
  expect(() => calculateAcoustics({ ...input, elements: [{ ...input.elements[1], rwDb: 40 }] })).toThrow();
});

test("exterior screening refuses incomplete geometry, unqualified ratings and unresolved flanking", () => {
  const cases: [string, (input: ReturnType<typeof exteriorNoiseFixture>) => void][] = [
    ["applicability", i => { i.applicability.assessment = "unknown"; }],
    ["special", i => { i.applicability.assessment = "special_assessment_required"; }],
    ["envelope", i => { i.envelopeComplete = false; }],
    ["inventory", i => { i.elementsComplete = false; }],
    ["flanking", i => { i.flanking.assessment = "required"; }],
    ["flanking", i => { i.flanking.assessment = "unknown"; }],
    ["installed", i => { i.elements[0]!.ratingBasis = "unadjusted_lab"; }],
    ["unknown", i => { if (i.elements[0]!.kind === "area") i.elements[0]!.construction = "unknown"; }],
    ["flanking", i => { if (i.elements[0]!.kind === "area") i.elements[0]!.rwDb = 50; }],
    ["areas", i => { i.elements = i.elements.filter(e => e.id !== "window-1"); }],
    ["areas", i => { if (i.elements[0]!.kind === "area") i.elements[0]!.areaM2 += 1; }],
    ["unknown facade", i => { i.elements[0]!.facadeId = "wrong"; }],
    ["unique", i => { i.elements[1]!.id = i.elements[0]!.id; }],
    ["unique", i => { i.facades[1]!.id = i.facades[0]!.id; }],
  ];
  for (const [reason, change] of cases) {
    const input = exteriorNoiseFixture(); change(input);
    const result = calculateAcoustics(input);
    expect(result).toMatchObject({ status: "unsupported", value: null, reviewStatus: "not_reviewed" });
    expect(result.exteriorNoise).toBeUndefined();
    expect(result.limitations[0]!.toLowerCase()).toContain(reason);
  }
  const input = exteriorNoiseFixture();
  input.facades = [{ ...input.facades[0]!, areaM2: 10 }];
  input.room.floorAreaM2 = 12.5;
  input.elements = [{ ...input.elements[0]!, kind: "area", areaM2: 10, rwDb: 50, construction: "massive" }];
  expect(calculateAcoustics(input).status).toBe("calculated"); // Requirement exactly 40, K_AL=0.
  input.facades[0]!.noise.levelDb = 70.001;
  expect(calculateAcoustics(input).status).toBe("unsupported");
});
