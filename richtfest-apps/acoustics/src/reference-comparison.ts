import { exteriorNoiseReferenceInputsSchema, exteriorNoiseReferenceAnswersSchema, type ExteriorNoiseReferenceInputs } from "@richtfest/shared";

/** Replay printed inputs without inferring applicability, correcting geometry or
 * deriving La/K_LPB. Kept separate from the gated project calculation tool: a
 * reference can be reproducible even when its geometry is inconsistent.
 */
function reproduceRoom(room: ExteriorNoiseReferenceInputs["rooms"][number]) {
  const geometryCorrectionDb = 10 * Math.log10(room.requirementAreaM2 / (0.8 * room.floorAreaM2));
  const requiredDb = Math.max(room.minimumRequirementDb, room.assessedLaDb - room.roomFactorDb) + geometryCorrectionDb;
  const missingAreaElementIds = room.elements.filter(e => e.kind === "area" && e.areaM2 === null).map(e => e.id);
  const elements = room.elements.flatMap(e => {
    if (e.kind === "area" && e.areaM2 === null) return [];
    const referenceArea = e.kind === "area" ? e.areaM2! : 10;
    const rating = e.kind === "area" ? e.rwDb : e.dnEWDb;
    const normalizedDb = rating + e.correctionDb + 10 * Math.log10(room.compositeAreaM2 / referenceArea);
    return [{ id: e.id, normalizedDb, transmission: (e.kind === "small" ? e.count : 1) * 10 ** (-normalizedDb / 10) }];
  });
  // Never silently drop an unquantified opening, even if the source did so.
  const compositeDb = missingAreaElementIds.length ? null : -10 * Math.log10(elements.reduce((sum, e) => sum + e.transmission, 0));
  const providedDb = compositeDb === null ? null : compositeDb - room.uncertaintyDb;
  return {
    geometryCorrectionDb, requiredDb, compositeDb, providedDb,
    marginDb: providedDb === null ? null : providedDb - requiredDb,
    requirementMinusCompositeAreaM2: room.requirementAreaM2 - room.compositeAreaM2,
    elementAreaMinusCompositeAreaM2: missingAreaElementIds.length ? null
      : room.elements.reduce((sum, e) => sum + (e.kind === "area" ? e.areaM2! : 0), 0) - room.compositeAreaM2,
    missingAreaElementIds, elements,
  };
}

/** Deterministic, offline golden comparison. Matching is not project approval.
 * Delta always means Richtfest minus the printed reference, before rounding.
 */
export function compareExteriorNoiseReference(rawInputs: unknown, rawAnswers: unknown) {
  const inputs = exteriorNoiseReferenceInputsSchema.parse(rawInputs);
  const answers = exteriorNoiseReferenceAnswersSchema.parse(rawAnswers);
  if (inputs.sourceSha256 !== answers.sourceSha256) throw new Error("Reference source hashes differ");
  const toleranceDb = 0.1;
  const byId = new Map(inputs.rooms.map(r => [r.id, r]));
  const expectedIds = new Set(answers.rooms.map(r => r.id));
  const unexpectedRoomIds = inputs.rooms.filter(r => !expectedIds.has(r.id)).map(r => r.id);
  const rows = answers.rooms.map(reference => {
    const input = byId.get(reference.id);
    const calculated = input ? reproduceRoom(input) : null;
    const delta = calculated ? {
      requiredDb: calculated.requiredDb - reference.requiredDb,
      compositeDb: calculated.compositeDb === null ? null : calculated.compositeDb - reference.compositeDb,
      providedDb: calculated.providedDb === null ? null : calculated.providedDb - reference.providedDb,
      marginDb: calculated.marginDb === null ? null : calculated.marginDb - (reference.providedDb - reference.requiredDb),
    } : null;
    // A tiny epsilon handles binary representation at exactly 0.1, not rounding
    // to a reporting precision. This never changes the calculated margin.
    const matches = delta !== null && [delta.requiredDb, delta.compositeDb, delta.providedDb, delta.marginDb]
      .every(d => d !== null && Math.abs(d) <= toleranceDb + 1e-12);
    const status = !input ? "missing_input" : calculated!.missingAreaElementIds.length ? "blocked"
      : matches ? "within_reference_tolerance" : "outside_reference_tolerance";
    return { roomId: reference.id, status, inputPages: input?.pages ?? [], reference, calculated, delta };
  });
  return {
    method: "exterior-noise-reference-reproduction" as const, version: 1 as const,
    sourceSha256: inputs.sourceSha256, reviewStatus: "not_reviewed" as const, toleranceDb,
    withinTolerance: unexpectedRoomIds.length === 0 && rows.every(r => r.status === "within_reference_tolerance"),
    expectedRoomCount: answers.rooms.length, unexpectedRoomIds, rows,
  };
}
