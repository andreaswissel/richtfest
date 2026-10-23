import { Fragment, useMemo, useState } from "react";
import { fireBuildingKeys, type BuildingAddressStateSuggestion } from "@richtfest/shared";
import { classifyFireBuilding, closureSatisfies, ceilingRequirement, deriveFireRoomRole, escapeRouteLengths, fireComponentStatus, fireConceptDraft, fireDoorRequirement, fireRequirement,
  fireWallRequirement, fireWaterDemand, maxEscapeDistance, ratingSatisfies, type EscapeRoute, type FireBuildingClass, type FireClassification, type FireClosure, type FireComponentRequirement, type FireRating,
  type FireRoomRole, type FireSpace, type StairwellSmokeVent } from "@richtfest/shared/fire-protection";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Badge } from "../ui/primitives";
import { fieldLabel, optionLabel, PropertyRow, regionComponentType, type ComponentPropertySave } from "./component-properties";
import { pointToMetres, type PageScale } from "./outline-geometry";
import type { BuildingComponentPropertyState, BuildingModel, BuildingPlanPoint, BuildingRegion } from "./types";

type T = ReturnType<typeof useT>;
type Key = Parameters<T>[0];
type States = Record<string, BuildingComponentPropertyState> | undefined;

/** Latest value a person has not rejected; otherwise the last approved one. */
const live = (states: States, key: string) => {
  const state = states?.[key];
  if (!state) return null;
  // Extracted fire heights cannot classify a building before human review.
  if (key === "fireHeight") return state.reviewedValue ?? (state.reviewStatus !== "rejected" && (state.reviewStatus === "approved" || state.provenance === "manual") ? state.value : null);
  return (state.reviewStatus !== "rejected" ? state.value : state.reviewedValue) ?? null;
};
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown) => typeof value === "string" && value ? value : null;
const bool = (value: unknown) => typeof value === "boolean" ? value : null;

export type FireMark = { wall?: FireRating; room?: "necessary_corridor" | "necessary_stairwell"; door?: FireClosure; status?: "met" | "not_met" | "open" };
/** An escape route on the plan: its length tag at the farthest point and the walking line to the exit, in page coordinates. */
export type FireAnnotation = { id: string; point: BuildingPlanPoint; path: BuildingPlanPoint[]; text: string; over: boolean };
export type FireComponentAssessment = { kind: "wall" | "ceiling" | "door"; requirement: FireComponentRequirement<FireRating> | FireComponentRequirement<FireClosure>;
  actual: FireRating | FireClosure | null; status: "none" | "met" | "not_met" | "open" };
export type FireAssessment = {
  classification: FireClassification;
  /** Values the model proposes where nothing was entered: the number of apartments and storeys above ground. */
  derived: { dwellings: number | null; storeysAboveGround: number | null };
  roomRoles: Map<string, { role: FireRoomRole | null; entered: boolean }>;
  components: Map<string, FireComponentAssessment>;
  fullStoreys: number | null;
  /** The building's default venting of its notwendige Treppenräume; a Treppenraum can override it. */
  smokeVent: StairwellSmokeVent | null;
  /** Treppenräume with their own venting. */
  stairwellVents: Map<string, StairwellSmokeVent>;
};

const centroid = (region: BuildingRegion): BuildingPlanPoint | null => {
  if (region.polygon && region.polygon.length) return { x: region.polygon.reduce((sum, point) => sum + point.x, 0) / region.polygon.length, y: region.polygon.reduce((sum, point) => sum + point.y, 0) / region.polygon.length };
  return region.box ? { x: region.box.x + region.box.width / 2, y: region.box.y + region.box.height / 2 } : null;
};
const ringDistance = (point: BuildingPlanPoint, ring: BuildingPlanPoint[]) => {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!, dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
  }
  return best;
};

/** The rooms a door opens into: on each face of its wall, the room nearest the door; null is outside. Undefined when the door has no wall. */
export function doorSides(door: BuildingRegion, walls: Map<string, BuildingRegion>, rooms: Map<string, BuildingRegion>): [string | null, string | null] | undefined {
  const wall = door.inWall ? walls.get(door.inWall) : undefined, point = centroid(door);
  if (!wall?.separates || wall.separates.length < 2 || !point) return undefined;
  const pick = (face: NonNullable<BuildingRegion["separates"]>[number]) => face.exterior ? null
    : face.roomIds.map((id) => rooms.get(id)).filter((room): room is BuildingRegion => Boolean(room?.polygon?.length))
      .sort((a, b) => ringDistance(point, a.polygon!) - ringDistance(point, b.polygon!))[0]?.id ?? (face.roomIds[0] ?? null);
  return [pick(wall.separates[0]!), pick(wall.separates[1]!)];
}

/**
 * Building class, room roles and the requirement on every wall, slab and door,
 * from the building model's reviewed and entered values. Computed in the
 * browser from the same shared rules the written part uses.
 */
export function assessFireProtection(model: Pick<BuildingModel, "buildings" | "storeys" | "states">): FireAssessment {
  const site = model.buildings[0]?.componentProperties;
  const all = [...new Map(Object.values(model.states).flat().filter((region) => !region.isCandidate).map((region) => [region.id, region])).values()];
  const rooms = all.filter((region) => region.entityType === "room");
  const storeyLevel = new Map(model.storeys.map((storey) => [storey.id, num(live(storey.componentProperties, "level")) ?? storey.levelIndex ?? null]));
  const unitOf = (room: BuildingRegion) => str(live(room.componentProperties, "apartmentUnit")) ?? room.groupLabel ?? null;
  const spaceTypeOf = (room: BuildingRegion) => str(live(room.componentProperties, "spaceType")) ?? (unitOf(room) ? "apartment" : null);
  const units = new Set(rooms.filter((room) => spaceTypeOf(room) === "apartment").map(unitOf).filter(Boolean));
  const levels = [...storeyLevel.values()].filter((level): level is number => level !== null);
  const derived = { dwellings: units.size || null, storeysAboveGround: levels.length ? levels.filter((level) => level >= 0).length : null };
  const fullStoreys = model.storeys.length && model.storeys.every((storey) => live(storey.componentProperties, "fullStorey") !== null)
    ? model.storeys.filter((storey) => live(storey.componentProperties, "fullStorey") === "full").length : null;
  const classification = classifyFireBuilding({
    state: str(live(site, "federalState")), height: num(live(site, "fireHeight")), detached: bool(live(site, "fireDetached")),
    dwellings: num(live(site, "fireDwellings")), otherUnits: num(live(site, "fireOtherUnits")),
    usableArea: num(live(site, "fireUsableArea")), storeysAboveGround: derived.storeysAboveGround, specialUse: str(live(site, "fireSpecialUse")) as FireClassification["specialUse"],
    garageArea: num(live(site, "garageArea")), largestUnitArea: num(live(site, "fireLargestUnitArea")), unitsGrossArea: num(live(site, "fireUnitsGrossArea")),
  });
  const state = classification.state ?? "RP";
  const gk = classification.buildingClass as FireBuildingClass | null;
  const basement = (storeyId?: string | null) => { const level = storeyId ? storeyLevel.get(storeyId) : null; return level !== null && level !== undefined && level < 0; };
  const roomRoles = new Map(rooms.map((room) => {
    const entered = str(live(room.componentProperties, "fireRoomRole")) as FireRoomRole | null;
    return [room.id, { role: entered ?? deriveFireRoomRole({ spaceType: spaceTypeOf(room), roomUse: room.roomUse ?? null, name: room.label }, gk), entered: Boolean(entered) }];
  }));
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const space = (id: string | null): FireSpace | null => { const room = id ? roomById.get(id) : undefined;
    return room ? { role: roomRoles.get(room.id)?.role ?? null, unit: unitOf(room), basement: basement(room.storeyId), roomUse: room.roomUse ?? null,
      smokeVent: str(live(room.componentProperties, "stairwellSmokeVent")) as StairwellSmokeVent | null } : null; };
  const walls = new Map(all.filter((region) => region.entityType === "element" && regionComponentType(region) === "wall").map((wall) => [wall.id, wall]));
  const smokeVent = str(live(site, "stairwellSmokeVent")) as StairwellSmokeVent | null;
  const components = new Map<string, FireComponentAssessment>();
  for (const element of all.filter((region) => region.entityType === "element")) {
    const type = regionComponentType(element), props = element.componentProperties;
    if (type === "wall") {
      const requirement = fireWallRequirement({ state, residential: (num(live(site, "fireOtherUnits")) ?? 0) === 0, buildingClass: gk, basement: basement(element.storeyId), loadBearing: bool(live(props, "loadBearing")),
        faces: (element.separates ?? []).map((face) => ({ exterior: Boolean(face.exterior), spaces: face.roomIds.map(space).filter((item): item is FireSpace => Boolean(item)) })) });
      const actual = str(live(props, "fireResistance")) as FireRating | null;
      components.set(element.id, { kind: "wall", requirement, actual, status: fireComponentStatus(requirement.required, actual, ratingSatisfies) });
    } else if (type === "ceiling") {
      const requirement = ceilingRequirement(state, gk, basement(element.storeyId));
      const actual = str(live(props, "fireResistance")) as FireRating | null;
      components.set(element.id, { kind: "ceiling", requirement, actual, status: fireComponentStatus(requirement.required, actual, ratingSatisfies) });
    } else if (type === "door") {
      const sides = doorSides(element, walls, roomById);
      const requirement = sides ? fireDoorRequirement({ state, buildingClass: gk, smokeVent, sides: [space(sides[0]), space(sides[1])] }) : { required: null, reasons: [] };
      const actual = str(live(props, "fireClosure")) as FireClosure | null;
      components.set(element.id, { kind: "door", requirement, actual, status: fireComponentStatus(requirement.required, actual, closureSatisfies) });
    }
  }
  const stairwellVents = new Map(rooms.flatMap((room) => { const vent = str(live(room.componentProperties, "stairwellSmokeVent")) as StairwellSmokeVent | null; return vent ? [[room.id, vent] as const] : []; }));
  return { classification, derived, roomRoles, components, fullStoreys, smokeVent, stairwellVents };
}

/** Escape route lengths for the rooms and doors on one plan page, at its printed scale. */
export function pageEscapeRoutes(assessment: FireAssessment, pageRegions: BuildingRegion[], allRegions: BuildingRegion[], scale: PageScale | null, storeyLevel: (storeyId?: string | null) => number | null): EscapeRoute[] {
  if (!scale?.metresPerPageHeight) return [];
  const rooms = pageRegions.filter((region) => region.entityType === "room" && !region.isCandidate && (region.polygon?.length ?? 0) >= 3);
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const walls = new Map(allRegions.filter((region) => region.entityType === "element" && regionComponentType(region) === "wall").map((wall) => [wall.id, wall]));
  const doors = pageRegions.filter((region) => region.entityType === "element" && regionComponentType(region) === "door").flatMap((door) => {
    const sides = doorSides(door, walls, roomById), point = centroid(door);
    return sides && point ? [{ id: door.id, point: pointToMetres(point, scale), rooms: sides }] : [];
  });
  return escapeRouteLengths(rooms.map((room) => ({ id: room.id, polygon: room.polygon!.map((point) => pointToMetres(point, scale)), role: assessment.roomRoles.get(room.id)?.role ?? null,
    basement: (storeyLevel(room.storeyId) ?? 0) < 0 })), doors);
}

/** What the plan overlay draws: wall ratings, the green escape areas and door closures. */
export function fireMarks(assessment: FireAssessment): Map<string, FireMark> {
  const marks = new Map<string, FireMark>();
  for (const [id, item] of assessment.components) {
    if (!item.requirement.required) continue;
    marks.set(id, item.kind === "door" ? { door: item.requirement.required as FireClosure, status: item.status === "none" ? undefined : item.status }
      : item.kind === "wall" ? { wall: item.requirement.required as FireRating, status: item.status === "none" ? undefined : item.status } : {});
  }
  for (const [id, { role }] of assessment.roomRoles) if (role === "necessary_corridor" || role === "necessary_stairwell") marks.set(id, { room: role });
  return marks;
}

export const closureLabel = (code: string) => code.replace("_", "-").replace(/^T(\d+)/, "T $1");
export const ratingLabel = (rating: FireRating, t: T) => optionLabel("fireResistance", rating, t);

const classText = (classification: FireClassification, t: T) => classification.buildingClass ? t("buildingFireClass").replace("{class}", String(classification.buildingClass)) : t("buildingFireClassOpen");

/** Toolbar summary: the class and the deliverable, or what is still open. */
export function fireSummary(assessment: FireAssessment, t: T) {
  const { classification } = assessment;
  if (!classification.supported) return t("buildingFireStateUnsupportedShort");
  return [classText(classification, t), classification.deliverable ? t(classification.deliverable === "konzept" ? "buildingFireDeliverableConcept" : "buildingFireDeliverableNachweis") : null].filter(Boolean).join(" · ");
}

/**
 * The fire protection panel: inputs of the building class, the result
 * (class, Sonderbau, deliverable, who checks it), the status of every rated
 * component, escape route lengths on the shown page and the written part as a
 * draft to copy. It applies the LBauO RLP; it never approves anything.
 */
export function FireProtectionPanel({ model, addressState, assessment, routes, storeyLabel, roomNames, elementNames, t, pending, onSave, onReview }: {
  addressState?: BuildingAddressStateSuggestion | null;
  model: Pick<BuildingModel, "buildings" | "storeys">; assessment: FireAssessment; routes: EscapeRoute[]; storeyLabel: (storeyId: string) => string; roomNames: Map<string, string>; elementNames: Map<string, string>; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void;
}) {
  const site = model.buildings[0];
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const { classification, derived } = assessment;
  const states = site?.componentProperties ?? {};
  const berlin = classification.state === "BE", height = num(live(states, "fireHeight"));
  const visibleKeys = fireBuildingKeys.filter((key) => key === "fireUsableArea" ? !berlin && (num(live(states, "fireOtherUnits")) ?? 0) > 0
    : key === "fireLargestUnitArea" ? berlin && (height === null || (height > 7 && height <= 13) || live(states, key) !== null)
    : key === "fireUnitsGrossArea" ? berlin && (classification.gaps.includes("unitsGrossArea") || live(states, key) !== null || (height !== null && height <= 7))
    : key === "fireDetached" ? (classification.buildingClass === null || classification.buildingClass <= 2) && (classification.gaps.includes("detached") || live(states, key) !== null || (num(live(states, "fireHeight")) ?? 99) <= 7)
    : key === "garageEnclosure" ? (num(live(states, "garageArea")) ?? 0) > 100
    : key === "stairwellSmokeVent" ? (classification.buildingClass ?? 0) >= 3 : true);
  const placeholder = (key: string) => key === "fireDwellings" && derived.dwellings !== null ? String(derived.dwellings) : undefined;
  const summary = useMemo(() => {
    const counts = { met: 0, not_met: 0, open: 0 };
    const byKind = new Map<string, { total: number; met: number; not_met: number; open: number }>();
    for (const item of assessment.components.values()) {
      if (item.status === "none") continue;
      counts[item.status]++;
      const key = item.kind === "door" ? `door:${item.requirement.required}` : `${item.kind}:${item.requirement.required}`;
      const entry = byKind.get(key) ?? { total: 0, met: 0, not_met: 0, open: 0 };
      entry.total++; entry[item.status]++; byKind.set(key, entry);
    }
    return { counts, byKind: [...byKind].sort(([a], [b]) => a.localeCompare(b)) };
  }, [assessment]);
  const water = fireWaterDemand(assessment.fullStoreys, bool(live(states, "fireDetached")));
  const longest = routes.reduce<EscapeRoute | null>((best, route) => !best || route.length > best.length ? route : best, null);
  const over = routes.filter((route) => route.length > maxEscapeDistance);
  const copyDraft = async () => {
    const stairwells = [...assessment.roomRoles].filter(([, { role }]) => role === "necessary_stairwell")
      .map(([id]) => ({ name: roomNames.get(id) ?? id, smokeVent: assessment.stairwellVents.get(id) ?? assessment.smokeVent }));
    const text = fireConceptDraft({ classification, height: num(live(states, "fireHeight")), dwellings: num(live(states, "fireDwellings")),
      garageEnclosure: str(live(states, "garageEnclosure")) as "open" | "closed" | null, stairwells,
      components: [...assessment.components].map(([id, item]) => ({ kind: item.kind, name: elementNames.get(id) ?? id, status: item.status, reasons: item.requirement.reasons })),
      routes: routes.map((route) => ({ room: roomNames.get(route.roomId) ?? route.roomId, length: route.length })), water });
    try { await navigator.clipboard.writeText(text); setCopied("done"); } catch { setCopied("failed"); }
  };
  const kindLabel = (key: string) => {
    const [kind, value] = key.split(":") as [string, string];
    return kind === "door" ? `${t("buildingFireDoors")} ${closureLabel(value)}` : `${t(kind === "wall" ? "buildingFireWalls" : "buildingFireCeilings")} ${ratingLabel(value as FireRating, t)}`;
  };
  if (!site) return null;
  return <>
    <dl className="building-model-component-rows">
      <PropertyRow propertyKey="federalState" state={states.federalState} addressSuggestion={addressState} t={t} pending={pending} onSave={onSave} onReview={(decision) => states.federalState && onReview(states.federalState, decision)} />
      {visibleKeys.map((key) => <PropertyRow key={key} propertyKey={key} state={states[key]} placeholder={placeholder(key)} t={t} pending={pending} onSave={onSave}
        onReview={(decision) => states[key] && onReview(states[key]!, decision)} />)}
    </dl>
    <p className="muted text-ui-2xs">{t(berlin ? "buildingFireHeightHintBe" : "buildingFireHeightHint")}</p>
    {!classification.supported ? <p className="text-ui-xs">{t("buildingFireStateUnsupported")}</p> : <dl className="building-model-component-rows building-model-fire-result" aria-label={t("buildingFireResult")}>
      <dt>{t("buildingFireClassLabel")}</dt>
      <dd className="building-model-stack"><Badge variant={classification.buildingClass ? "secondary" : "outline"}>{classText(classification, t)}</Badge>
        {classification.gaps.length > 0 && <span className="muted text-ui-2xs">{t("buildingFireOpen")}: {classification.gaps.map((gap) => t(`buildingFireGap${gap[0]!.toUpperCase()}${gap.slice(1)}` as Key)).join(", ")}</span>}</dd>
      <dt>{t("buildingFireSpecialUseLabel")}</dt>
      <dd>{classification.highRise ? t("buildingFireHighRise") : classification.specialUse ? optionLabel("fireSpecialUse", classification.specialUse, t) : t("buildingModelUnknownValue")}</dd>
      {classification.garage && <><dt>{t("buildingFireGarage")}</dt><dd>{t(`buildingFireGarage${classification.garage[0]!.toUpperCase()}${classification.garage.slice(1)}` as Key)}</dd></>}
      <dt>{t("buildingFireDeliverable")}</dt>
      <dd className="building-model-stack">{classification.deliverable ? <strong>{t(classification.deliverable === "konzept" ? "buildingFireDeliverableConcept" : "buildingFireDeliverableNachweis")}</strong> : <span className="muted">{t("buildingFireClassOpen")}</span>}
        {classification.deliverable && <span className="muted text-ui-2xs">{t(classification.deliverable === "konzept" ? "buildingFireDeliverableConceptHint" : "buildingFireDeliverableNachweisHint")}</span>}</dd>
      <dt>{t("buildingFireReview")}</dt>
      <dd>{classification.review ? t(classification.review === "psv" ? "buildingFireReviewPsv" : classification.review === "none" ? "buildingFireReviewNone" : classification.review === "check_engineer" ? "buildingFireReviewCheckEngineer" : "buildingFireReviewAuthority") : "–"}</dd>
      {classification.notes.map((note) => <Fragment key={note}><dt /><dd className="muted text-ui-2xs">{t(`buildingFireNote${note[0]!.toUpperCase()}${note.slice(1)}` as Key)}</dd></Fragment>)}
    </dl>}
    {classification.buildingClass && <>
      <h3 className="building-model-fire-subtitle">{t("buildingFireComponents")}</h3>
      {summary.byKind.length ? <ul className="building-model-fire-components">
        {summary.byKind.map(([key, entry]) => <li key={key}><span>{kindLabel(key)}</span><span className="muted">{t("buildingFireComponentCounts").replace("{total}", String(entry.total)).replace("{met}", String(entry.met)).replace("{open}", String(entry.open))}</span>
          {entry.not_met > 0 && <Badge variant="destructive">{t("buildingFireNotMetCount").replace("{count}", String(entry.not_met))}</Badge>}</li>)}
      </ul> : <p className="muted text-ui-xs">{t("buildingFireNoComponents")}</p>}
      <p className="muted text-ui-2xs">{t("buildingFireComponentsHint")}</p>
      <h3 className="building-model-fire-subtitle">{t("buildingFireEscapeRoutes")}</h3>
      {routes.length ? <p className="text-ui-xs">{t("buildingFireEscapeSummary").replace("{count}", String(routes.length)).replace("{longest}", longest ? longest.length.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "–")}
        {over.length > 0 && <> <Badge variant="destructive">{t("buildingFireEscapeOver").replace("{count}", String(over.length))}</Badge></>}</p>
        : <p className="muted text-ui-xs">{t("buildingFireEscapeNone")}</p>}
      <p className="muted text-ui-2xs">{t("buildingFireEscapeHint")}</p>
      <h3 className="building-model-fire-subtitle">{t("buildingFireWater")}</h3>
      <p className="text-ui-xs">{water ? t("buildingFireWaterDemand").replace("{lpm}", water.litresPerMinute.toLocaleString()).replace("{m3h}", String(water.cubicMetresPerHour)) : t("buildingFireWaterOpen")}</p>
      <div className="building-model-component-derive">
        <Button size="xs" variant="outline" onClick={() => void copyDraft()}>{t(classification.deliverable === "konzept" ? "buildingFireCopyConcept" : "buildingFireCopyNachweis")}</Button>
        <p className="muted text-ui-2xs" role="status">{copied === "done" ? t("buildingFireCopied") : copied === "failed" ? t("buildingFireCopyFailed") : t("buildingFireCopyHint")}</p>
      </div>
    </>}
    {model.storeys.length > 0 && <p className="muted text-ui-2xs">{t("buildingFireStoreysHint").replace("{storeys}", model.storeys.map((storey) => storeyLabel(storey.id)).join(", "))}</p>}
  </>;
}

/** Fire protection of the selected wall, slab, door or room: its requirement with the rules behind it, and what the build-up provides. */
export function FireComponentSection({ region, assessment, t, pending, onSave, onReview }: { region: BuildingRegion; assessment: FireAssessment; t: T; pending: boolean;
  onSave: (save: ComponentPropertySave) => void; onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void }) {
  const states = region.componentProperties ?? {};
  const row = (key: string, placeholder?: string) => <PropertyRow key={key} propertyKey={key} state={states[key]} placeholder={placeholder} t={t} pending={pending} onSave={onSave} onReview={(decision) => states[key] && onReview(states[key]!, decision)} />;
  if (region.entityType === "room") {
    const role = assessment.roomRoles.get(region.id);
    return <dl className="building-model-component-rows">{row("fireRoomRole", role && !role.entered && role.role ? role.role : undefined)}
      {role?.role === "necessary_stairwell" && row("stairwellSmokeVent", assessment.smokeVent ?? undefined)}</dl>;
  }
  const item = assessment.components.get(region.id);
  if (!item) return null;
  const required = item.requirement.required;
  return <>
    <dl className="building-model-component-rows">
      <dt>{t("buildingFireRequired")}</dt>
      <dd className="building-model-stack">
        <span>{required ? item.kind === "door" ? closureLabel(required) : ratingLabel(required as FireRating, t) : assessment.classification.buildingClass ? t("buildingFireNoRequirement") : t("buildingFireClassOpen")}</span>
        {item.requirement.reasons.map((reason) => { const rule = fireRequirement(reason.requirement, assessment.classification.state ?? "RP");
          return <span key={reason.requirement} className="muted text-ui-2xs" title={rule?.text}>
          {rule?.cite ?? reason.requirement}: {item.kind === "door" ? closureLabel(reason.value) : ratingLabel(reason.value as FireRating, t)}</span>; })}
      </dd>
      {item.kind === "wall" && row("loadBearing")}
      {item.kind === "door" ? row("fireClosure") : <>{row("fireResistance")}{row("fireResistanceBasis")}</>}
      {required && <><dt>{t("status")}</dt><dd><Badge variant={item.status === "not_met" ? "destructive" : item.status === "met" ? "secondary" : "outline"}>{t(item.status === "met" ? "buildingFireMet" : item.status === "not_met" ? "buildingFireNotMet" : "buildingFireStatusOpen")}</Badge></dd></>}
    </dl>
  </>;
}

/** Legend for the Brandschutzplan overlay, in ARCenergie's drawing convention. */
export function FireLegend({ marks, t }: { marks: Map<string, FireMark>; t: T }) {
  const walls = new Map<string, number>(), doors = new Map<string, number>(); let corridor = 0, stairwell = 0;
  for (const mark of marks.values()) {
    if (mark.wall) walls.set(mark.wall, (walls.get(mark.wall) ?? 0) + 1);
    if (mark.door) doors.set(mark.door, (doors.get(mark.door) ?? 0) + 1);
    if (mark.room === "necessary_corridor") corridor++;
    if (mark.room === "necessary_stairwell") stairwell++;
  }
  return <div className="building-model-role-legend building-model-fire-legend" aria-label={t("buildingFirePlanLegend")}>
    {(["fb_nb_m", "hf_m", "fb", "hf", "fh", "nb"] as const).filter((rating) => walls.has(rating)).map((rating) => <span key={rating}><i className="building-model-fire-swatch" data-fire-wall={rating} aria-hidden="true" />{ratingLabel(rating, t)} · {walls.get(rating)}</span>)}
    {stairwell > 0 && <span><i className="building-model-fire-swatch" data-fire-room="necessary_stairwell" aria-hidden="true" />{optionLabel("fireRoomRole", "necessary_stairwell", t)}</span>}
    {corridor > 0 && <span><i className="building-model-fire-swatch" data-fire-room="necessary_corridor" aria-hidden="true" />{optionLabel("fireRoomRole", "necessary_corridor", t)}</span>}
    {[...doors].sort().map(([code, count]) => <span key={code}><i className="building-model-fire-door-tag" aria-hidden="true">{closureLabel(code)}</i>{optionLabel("fireClosure", code, t)} · {count}</span>)}
    <span><i className="building-model-fire-route-tag" aria-hidden="true">m</i>{t("buildingFireEscapeLegend")}</span>
    {!marks.size && <span className="muted">{t("buildingFireNoMarks")}</span>}
  </div>;
}
