import { firePlanSchema, validateFirePlan, type FirePlan, type FireProtectionSnapshot } from "@richtfest/shared/fire-plan";

/** Pending proposals never override approved values; explicit previews may use unreviewed inputs. */
export function assembleFireProtectionSnapshot(data: {
  model: { id: string; revision: number }; buildings: any[]; storeys: any[]; rooms: any[]; elements: any[];
  properties: any[]; relationships: any[]; planSources: any[]; extractions: any[]; conflicts: any[];
}, mode: "reviewed" | "candidate_preview" = "reviewed"): FireProtectionSnapshot {
  const active = (rows: any[]) => rows.filter(row => row.constructionState !== "demolished");
  const buildings = active(data.buildings);
  if (buildings.length !== 1) return { available: false, reason: "A single active building is required; multiple buildings must not be combined." };
  const storeys = active(data.storeys).filter(s => s.buildingId === buildings[0].id);
  if (!storeys.length) return { available: false, reason: "No storeys in the saved building model." };
  const building = buildings[0];
  const blockers = new Set<string>();
  const properties: Extract<FireProtectionSnapshot, { available: true }>["properties"] = [];
  const evidence: FirePlan["building"]["evidence"] = [];
  const cite = (item: any) => {
    const sourceId = item?.sourceVersionId;
    if (!sourceId) return;
    if (item.kind === "ifc" && Number.isInteger(item.expressId) && item.expressId > 0)
      evidence.push({ kind: "ifc", sourceId, expressId: item.expressId, attribute: item.attribute ?? "Representation" });
    else if (Number.isInteger(item.page) && item.page > 0) evidence.push({ kind: "page", sourceId, page: item.page });
  };
  const get = (id: string, key: string): any => {
    if (data.conflicts.some(c => c.entityId === id && c.propertyKey === key)) return null;
    const property = data.properties.find(p => p.entityId === id && p.propertyKey === key);
    const chosen = property?.reviewed?.reviewStatus === "approved" ? property.reviewed
      : property?.current && !["rejected", "superseded"].includes(property.current.reviewStatus)
        && (property.current.provenance === "manual" || mode === "candidate_preview") ? property.current : null;
    if (property?.current && property.current.version !== chosen?.version) blockers.add(`${id}: ${key} has an unaccepted proposal; not used.`);
    if (!chosen) return null;
    if (!properties.some(p => p.entityId === id && p.key === key)) {
      properties.push({ entityId: id, key, version: chosen.version, reviewStatus: chosen.reviewStatus, provenance: chosen.provenance, evidence: chosen.evidence });
      for (const item of chosen.evidence ?? []) cite(item);
      if (chosen.reviewStatus !== "approved") blockers.add(`${id}: ${key} is ${chosen.provenance === "manual" ? "manually entered" : "inferred"} but not reviewed.`);
    }
    return chosen.value;
  };
  const number = (id: string, key: string) => { const value = get(id, key); return typeof value === "number" && Number.isFinite(value) ? value : null; };
  const levels = new Map(storeys.map(s => [s.id, data.properties.some(p => p.entityId === s.id && p.propertyKey === "level")
    || data.conflicts.some(c => c.entityId === s.id && c.propertyKey === "level")
    ? number(s.id, "level") : typeof s.levelIndex === "number" ? s.levelIndex : null]));
  for (const conflict of data.conflicts) blockers.add(`${conflict.entityId}: unresolved ${conflict.propertyKey} conflict.`);
  const relations = data.relationships.filter(r => r.reviewStatus === "approved"
    || mode === "candidate_preview" && r.reviewStatus === "unreviewed");
  const rooms = active(data.rooms), elements = active(data.elements);
  const plan: FirePlan = { building: {
    evidence,
    input: { state: get(building.id, "federalState"), height: number(building.id, "fireHeight"), detached: get(building.id, "fireDetached"),
      dwellings: number(building.id, "fireDwellings"), otherUnits: number(building.id, "fireOtherUnits"), usableArea: number(building.id, "fireUsableArea"),
      largestUnitArea: number(building.id, "fireLargestUnitArea"), unitsGrossArea: number(building.id, "fireUnitsGrossArea"),
      storeysAboveGround: [...levels.values()].every(v => v !== null) ? [...levels.values()].filter(v => v! >= 0).length : null,
      specialUse: get(building.id, "fireSpecialUse"), garageArea: number(building.id, "garageArea") },
    fullStoreys: storeys.every(s => get(s.id, "fullStorey") !== null) ? storeys.filter(s => get(s.id, "fullStorey") === "full").length : null,
    smokeVent: get(building.id, "stairwellSmokeVent"), garageEnclosure: get(building.id, "garageEnclosure"),
  }, storeys: [] };
  cite(building.geometry?.source);
  for (const storey of storeys) {
    const level = levels.get(storey.id), basement = level == null ? null : level < 0;
    const sourcePlans = data.planSources.filter(p => p.storeyId === storey.id);
    const localEvidence: FirePlan["building"]["evidence"] = [];
    for (const source of sourcePlans) localEvidence.push({ kind: "page", sourceId: source.sourceVersionId, page: source.page });
    const ifc = storey.geometry?.source;
    if (ifc?.kind === "ifc") localEvidence.push({ kind: "ifc", sourceId: ifc.sourceVersionId, expressId: ifc.expressId, attribute: "Representation" });
    const sourcePlan = sourcePlans.length === 1 ? sourcePlans[0] : null;
    const extraction = sourcePlan && data.extractions.filter(j => j.status === "complete" && j.sourceVersionId === sourcePlan.sourceVersionId && j.page === sourcePlan.page)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    const scale = extraction?.result?.pageScale;
    const scaleValid = Number.isFinite(scale?.metresPerPageHeight) && scale.metresPerPageHeight > 0
      && Number.isFinite(scale?.pageAspectRatio) && scale.pageAspectRatio > 0;
    const polygon = (row: any): Array<{ x: number; y: number }> | null => {
      const geometry = row.geometry;
      if (geometry?.holes?.length) {
        blockers.add(`${row.id}: routes through polygons with holes are unsupported.`);
        return null;
      }
      if (!sourcePlan || !scaleValid
        || geometry?.source?.sourceVersionId !== sourcePlan.sourceVersionId || geometry?.source?.page !== sourcePlan.page
        || !Array.isArray(geometry?.polygon) || geometry.polygon.length < 3) return null;
      return geometry.polygon.map((p: any) => ({ x: p.x * scale.pageAspectRatio * scale.metresPerPageHeight, y: p.y * scale.metresPerPageHeight }));
    };
    const roomRows = rooms.filter(r => r.storeyId === storey.id), roomIds = new Set(roomRows.map(r => r.id));
    const faces = (id: string): FirePlan["storeys"][number]["walls"][number]["faces"] => {
      const rows = relations.filter(r => r.fromEntityId === id && ["separates", "faces_exterior"].includes(r.relationshipType));
      for (const row of rows) cite(row.metadata);
      const sides = [...new Set(rows.map(r => r.metadata?.side))].sort();
      if (sides.length !== 2 || sides[0] !== 0 || sides[1] !== 1) return null;
      const result = sides.map(side => {
        const matching = rows.filter(r => r.metadata?.side === side);
        return { exterior: matching.some(r => r.relationshipType === "faces_exterior"),
          roomIds: matching.filter(r => r.relationshipType === "separates").map(r => r.toEntityId as string) };
      });
      if (result.some(f => f.exterior ? f.roomIds.length > 0 : !f.roomIds.length || f.roomIds.some(id => !roomIds.has(id)))) return null;
      // A merged/ambiguous outline can touch both wall faces. It cannot establish
      // a separation or an exit from a room back into itself.
      if (result[0]!.roomIds.some(id => result[1]!.roomIds.includes(id))) return null;
      return result as NonNullable<ReturnType<typeof faces>>;
    };
    const kind = (e: any) => get(e.id, "componentType") ?? (e.kind === "draft_wall" ? "wall" : e.kind === "draft_ceiling" ? "ceiling" : e.kind);
    const local = elements.filter(e => e.storeyId === storey.id);
    const item: FirePlan["storeys"][number] = { id: storey.id, evidence: localEvidence,
      geometryReviewed: mode !== "candidate_preview" && scaleValid && sourcePlan?.alignmentStatus === "reviewed" && extraction?.result?.scaleObservation?.status === "confirmed",
      rooms: roomRows.map(r => ({ id: r.id, role: get(r.id, "fireRoomRole"), unit: get(r.id, "apartmentUnit"), basement,
        roomUse: get(r.id, "roomUse"), smokeVent: get(r.id, "stairwellSmokeVent"), polygon: polygon(r) })),
      walls: local.filter(e => kind(e) === "wall").map(e => ({ id: e.id, basement, loadBearing: get(e.id, "loadBearing"), faces: faces(e.id), actual: get(e.id, "fireResistance") })),
      ceilings: local.filter(e => kind(e) === "ceiling").map(e => ({ id: e.id, basement, actual: get(e.id, "fireResistance") })),
      rescueWindows: local.filter(e => kind(e) === "window").map(e => ({ id: e.id,
        designated: get(e.id, "fireRescueWindow"), location: get(e.id, "fireRescueLocation"),
        clearWidth: number(e.id, "fireRescueClearWidth"), clearHeight: number(e.id, "fireRescueClearHeight"),
        sillHeight: number(e.id, "fireRescueSillHeight"), openableInside: get(e.id, "fireRescueOpenableInside") })),
      doors: local.filter(e => kind(e) === "door").map(e => {
        const hosts = relations.filter(r => r.fromEntityId === e.id && r.relationshipType === "opening_in");
        for (const host of hosts) cite(host.metadata);
        const sides = hosts.length === 1 ? faces(hosts[0].toEntityId) : null;
        const ring = polygon(e);
        return { id: e.id, actual: get(e.id, "fireClosure"),
          rooms: sides && sides.every(f => f.exterior || f.roomIds.length === 1) ? sides.map(f => f.exterior ? null : f.roomIds[0]!) as [string | null, string | null] : null,
          point: ring ? { x: ring.reduce((sum, p) => sum + p.x, 0) / ring.length, y: ring.reduce((sum, p) => sum + p.y, 0) / ring.length } : null };
      }),
    };
    if (!item.geometryReviewed) blockers.add(mode === "candidate_preview" ? `${storey.id}: candidate geometry is unreviewed; any route result is provisional.`
      : `${storey.id}: plan alignment/scale not confirmed; routes blocked.`);
    for (const room of item.rooms) if (!room.unit && !["common_corridor", "stairwell", "common_other", "exterior"].includes(get(room.id, "spaceType"))) {
      room.role = null; blockers.add(`${room.id}: unit/common-space membership is unknown.`);
    }
    for (const row of [...roomRows, ...local]) cite(row.geometry?.source);
    evidence.push(...localEvidence);
    plan.storeys.push(item);
  }
  if (elements.some(e => !storeys.some(s => s.id === e.storeyId))) blockers.add("Elements without an active storey are not assessed.");
  if (!rooms.length) blockers.add("No rooms in the model; room inventory is incomplete.");
  if (!elements.length) blockers.add("No components in the model; component inventory is incomplete.");
  const parsed = firePlanSchema.superRefine(validateFirePlan).safeParse(plan);
  if (!parsed.success) return { available: false, reason: "Saved fire inputs contain invalid or ambiguous geometry/properties; review the building model." };
  return { available: true, modelId: data.model.id, revision: data.model.revision, plan: parsed.data,
    sourceVersionIds: [...new Set(evidence.map(e => e.sourceId))], blockers: [...blockers], properties };
}
