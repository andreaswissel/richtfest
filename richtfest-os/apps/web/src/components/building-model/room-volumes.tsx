import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { isActiveBuildingRelationship, resolveRoomHeight, type BuildingRelationship, type LocationContext } from "@richtfest/shared";
import { registerMessages, useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge, Callout, Field, Segmented } from "../ui/primitives";
import type { ViewportState, createViewport } from "../location/viewport";
import { outlineSelfIntersects, pointToMetres, type PageScale } from "./outline-geometry";
import { candidateRole, type BuildingComponentPropertyState, type BuildingModel, type BuildingRegion } from "./types";
import { BuildingConnections } from "./connections";
import en from "./locales/en.json";
import de from "./locales/de.json";

registerMessages({ en, de });

function hasMetricScale(scale: PageScale | null) {
  return !!scale && Number.isFinite(scale.metresPerPageHeight) && Number(scale.metresPerPageHeight) > 0
    && Number.isFinite(scale.pageAspectRatio) && scale.pageAspectRatio > 0;
}

/** Canonical rooms and their persisted extraction drafts share outlines, not a separate mesh model. */
export function roomVolumeGeometry(regions: BuildingRegion[], storeys: BuildingModel["storeys"], scale: PageScale | null) {
  if (!scale || !hasMetricScale(scale)) return [];
  return regions.flatMap(room => {
    if (room.entityType !== "room" || room.status === "rejected" || room.geometryQuality === "anchor"
      || !room.polygon || room.polygon.length < 3 || outlineSelfIntersects(room.polygon)) return [];
    if (room.isCandidate && (room.status !== "unreviewed"
      || !["enclosed_region", "approximate_partition", "approximate_region"].includes(room.geometryQuality ?? "")
      || regions.some(other => !other.isCandidate && other.id === room.match?.existingId))) return [];
    const rings = [room.polygon, ...(room.holes ?? [])];
    if (rings.some(ring => ring.length < 3 || outlineSelfIntersects(ring) || ring.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) return [];
    const storey = storeys.find(item => item.id === room.storeyId);
    const height = resolveRoomHeight(room.componentProperties?.clearRoomHeight, storey?.componentProperties?.clearRoomHeight);
    const polygons: [number, number][][][] = [rings.map(ring => ring.map(point => {
      const metres = pointToMetres(point, scale);
      return [metres.x, metres.y];
    }))];
    return [{ room, height, mesh: { id: room.id, polygons, base: 0, height: height.value, color: !room.isCandidate && height.property?.reviewStatus === "approved" ? 0x94a3b8 : 0xd6b879 } }];
  });
}

/** A display projection of persisted objects. No alignment, elevation or closure is written back as a fact. */
export function buildingVolumeGeometry(model: BuildingModel, regions: BuildingRegion[], sourceId?: string) {
  const selectedSource = model.planSources.find(source => source.id === sourceId);
  const buildingId = model.storeys.find(storey => storey.id === selectedSource?.storeyId)?.buildingId;
  const sources = model.planSources.filter(source => source.storeyId
    && (!buildingId || model.storeys.some(storey => storey.id === source.storeyId && storey.buildingId === buildingId))
    && !model.supersededSources.some(item => item.sourceVersionId === source.source?.versionId)
    && !model.automaticPlanProcessing.some(item => item.sourceVersionId === source.source?.versionId
      && item.nonFloorPlanPages.some(page => page.page === source.page)));
  // One source per storey; prefer the currently selected plan set over an alternative drawing.
  const floors = model.storeys.flatMap(storey => {
    const options = sources.filter(source => source.storeyId === storey.id);
    const source = options.find(source => source.source?.versionId === selectedSource?.source?.versionId) ?? options[0];
    if (!source) return [];
    const scale = model.extractions.find(job => job.page === source.page && job.storeyId === storey.id
      && job.sourceVersionId === source.source?.versionId)?.result?.pageScale ?? null;
    const objects = regions.filter(region => region.storeyId === storey.id && region.page === source.page
      && region.sourceVersionId === source.source?.versionId && region.status !== "rejected");
    const volumes = roomVolumeGeometry(objects, model.storeys, scale);
    const height = resolveRoomHeight(null, storey.componentProperties?.clearRoomHeight).value;
    const walls = objects.filter(wall => wall.entityType === "element"
      && (wall.isCandidate ? wall.status === "unreviewed" && candidateRole(wall) === "draft-wall"
        : wall.elementKind === "draft_wall" || wall.elementKind === "wall" || wall.componentProperties?.componentType?.value === "wall")
      && !(wall.isCandidate && objects.some(other => !other.isCandidate && other.id === wall.match?.existingId)));
    const wallMeshes = hasMetricScale(scale) ? walls.flatMap(wall => {
      const rings = [wall.polygon ?? [], ...(wall.holes ?? [])];
      if (rings.some(ring => ring.length < 3 || outlineSelfIntersects(ring) || ring.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)))) return [];
      return [{ id: wall.id, height, base: 0, color: wall.isCandidate ? 0xb8ac96 : 0xa1a1aa, opacity: .94,
        polygons: [rings.map(ring => ring.map(point => { const p = pointToMetres(point, scale!); return [p.x, p.y] as [number, number]; }))] }];
    }) : [];
    const meshes = [...volumes.map(item => ({ ...item.mesh, opacity: .16 })), ...wallMeshes];
    const points = (wallMeshes.length ? wallMeshes : meshes).flatMap(mesh => mesh.polygons.flat(2));
    const xs = points.map(point => point[0]), zs = points.map(point => point[1]);
    const center = points.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2] : [0, 0];
    const levelProperty = storey.componentProperties?.level;
    const level = levelProperty && !["rejected", "superseded"].includes(levelProperty.reviewStatus) && typeof levelProperty.value === "number"
      ? levelProperty.value : storey.levelIndex;
    return [{ source, storey, scale, objects, volumes, wallCount: wallMeshes.length, level, base: 0,
      height: Math.max(height, ...volumes.map(item => item.mesh.height)),
      meshes: meshes.map(mesh => ({ ...mesh, group: source.id,
        polygons: mesh.polygons.map(polygon => polygon.map(ring => ring.map(([x, z]) => [x - center[0]!, z - center[1]!] as [number, number]))) })) }];
  }).sort((a, b) => (a.level ?? a.source.page - 1) - (b.level ?? b.source.page - 1) || a.source.page - b.source.page);
  let base = 0;
  for (const [index, floor] of floors.entries()) {
    const previous = floors[index - 1];
    if (previous) base += (previous.height + .3) * (floor.level != null && previous.level != null ? Math.max(1, floor.level - previous.level) : 1);
    floor.base = base;
    for (const mesh of floor.meshes) mesh.base = base;
  }
  // Only known storey indices establish above/below ground. Page order is not an elevation.
  const ground = floors.every(floor => floor.level != null) ? floors.find(floor => floor.level === 0)?.base : undefined;
  if (ground !== undefined) for (const floor of floors) {
    floor.base -= ground;
    for (const mesh of floor.meshes) mesh.base = floor.base;
  }
  return floors;
}

const context: LocationContext = { siteId: "canonical-plan", address: "", origin: [0, 0], longitude: 0, latitude: 0,
  radius: 50, buildings: [], trees: [], sources: [], importedAt: "" };
const site: ViewportState["site"] = { axes: [], plan: null, distances: [], railNoise: null, aerial: { near: null, far: null }, picks: [], snaps: [] };

export function RoomVolumes({ regions, model, sourceId, selectedId, onSave, onReview, onReviewOutline, onConfigureScale, onReviewConnection, onDeriveConnections, pending }: {
  regions: BuildingRegion[]; model: BuildingModel; sourceId?: string;
  selectedId?: string;
  onSave: (entityType: "room" | "storey", entityId: string, value: number | null) => void;
  onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void;
  onReviewOutline: (decision: "approved" | "rejected") => void;
  onConfigureScale: () => void;
  onReviewConnection: (relationship: BuildingRelationship, decision: "approved" | "rejected") => void;
  onDeriveConnections: () => void;
  pending: boolean;
}) {
  const t = useT(), dark = usePreferences(state => state.theme) === "dark";
  const [params, setParams] = useSearchParams();
  const { storeys } = model;
  const host = useRef<HTMLDivElement>(null), viewport = useRef<ReturnType<typeof createViewport> | null>(null);
  const selectedSource = model.planSources.find(source => source.id === sourceId);
  const buildingId = storeys.find(storey => storey.id === selectedSource?.storeyId)?.buildingId;
  const scopeSourceId = model.planSources.find(source => source.source?.versionId === selectedSource?.source?.versionId
    && storeys.find(storey => storey.id === source.storeyId)?.buildingId === buildingId)?.id;
  // Moving between floors must not rebuild their meshes (or restart the opacity animation).
  const floors = useMemo(() => buildingVolumeGeometry(model, regions, scopeSourceId), [model, regions, scopeSourceId]);
  const currentFloor = floors.find(floor => floor.source.id === sourceId) ?? floors[0];
  const focus = params.get("floorFocus") === "1" ? currentFloor : undefined;
  const objectParams = (region: BuildingRegion) => {
    const next = new URLSearchParams(params);
    next.delete("entity"); next.delete("candidate");
    next.set(region.isCandidate ? "candidate" : "entity", region.isCandidate ? region.id : `${region.entityType}:${region.id}`);
    next.set("page", String(region.page));
    if (region.sourceVersionId) next.set("sourceVersion", region.sourceVersionId);
    if (region.storeyId) next.set("storey", region.storeyId);
    if (region.constructionState !== "retained") next.set("modelState", region.constructionState === "proposed" ? "proposed" : region.constructionState === "demolished" ? "demolition" : "existing");
    next.set("sourceSelection", "manual");
    next.set("floorFocus", "1");
    return next;
  };
  const select = useRef((id: string) => {});
  select.current = id => { const region = regions.find(region => region.id === id); if (region) setParams(objectParams(region)); };
  const [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [scope, setScope] = useState("room"), [onlyPending, setOnlyPending] = useState(false);
  const [inspector, setInspector] = useState("dimensions");
  const related = useMemo(() => inspector === "connections" && selectedId ? model.relationships.filter(isActiveBuildingRelationship)
    .flatMap(link => link.fromEntityId === selectedId ? [link.toEntityId] : link.toEntityId === selectedId ? [link.fromEntityId] : []) : [], [model.relationships, selectedId, inspector]);
  const volumes = currentFloor?.volumes ?? [], scale = currentFloor?.scale ?? null;
  const meshes = useMemo(() => floors.flatMap(floor => floor.meshes), [floors]);
  const groundReference = useMemo<ViewportState["groundReference"]>(() => {
    if (!floors.every(floor => floor.level != null) || !floors.some(floor => floor.level === 0) || !meshes.length) return null;
    const points = meshes.flatMap(mesh => mesh.polygons.flat(2));
    const xs = points.map(point => point[0]), zs = points.map(point => point[1]);
    return { bounds: [[Math.min(...xs) - 6, Math.min(...zs) - 6], [Math.max(...xs) + 6, Math.max(...zs) + 6]] };
  }, [floors, meshes]);
  const selected = currentFloor?.objects.find(item => item.id === selectedId);
  const selectedRoom = selected?.entityType === "room" ? selected : undefined;
  const storey = currentFloor?.storey;
  const height = resolveRoomHeight(selected?.componentProperties?.clearRoomHeight, storey?.componentProperties?.clearRoomHeight);
  const target = scope === "room" ? selectedRoom?.isCandidate ? undefined : selectedRoom : storey;
  const property = target?.componentProperties?.clearRoomHeight;
  const effective = scope === "room" ? height : resolveRoomHeight(null, property);
  const [value, setValue] = useState(String(effective.value));
  useLayoutEffect(() => setValue(String(effective.value)), [target?.id, effective.value, property?.version, scope]);
  useEffect(() => {
    let active = true;
    void import("../location/viewport").then(({ createViewport }) => {
      if (!active || !host.current) return;
      viewport.current = createViewport(host.current, { select: id => { if (id) select.current(id); }, place: () => {}, measure: () => {}, align: () => {} });
      setReady(true);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; viewport.current?.dispose(); viewport.current = null; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    viewport.current?.update({ context, assessment: meshes, assessmentFocus: focus?.source.id ?? null, assessmentRelated: related, groundReference, objects: [], models: {}, site, selected: selectedId ?? null,
      layers: { buildings: false, trees: false, detectedTrees: false, objects: true, lidar: false, roads: false, railNoise: false, plan: false, aerial: false },
      tool: "select", treeStyle: "schematic", measurement: [], clipHeight: 200, dark, constructionLabel: "", projectExtentLabel: "", siteAddressLabel: "" });
  }, [ready, meshes, selectedId, dark, focus?.source.id, groundReference, related]);
  // Object selection and height edits do not reset a manually orbited camera. Floor changes fly to their actual vertical range.
  const framed = focus?.meshes ?? meshes;
  const framing = JSON.stringify(framed.map(mesh => [mesh.id, mesh.polygons]));
  const hasFramed = useRef(false);
  useEffect(() => {
    if (!ready || !framed.length) return;
    const base = Math.min(...framed.map(mesh => mesh.base)), top = Math.max(...framed.map(mesh => mesh.base + mesh.height));
    viewport.current?.fit(framed.flatMap(mesh => mesh.polygons.flat(2)), "perspective", hasFramed.current ? 450 : 0, top - base, base, focus ? .9 : 1.15);
    hasFramed.current = true;
  }, [ready, framing, focus?.source.id]);
  const rooms = (currentFloor?.objects ?? []).filter(room => room.entityType === "room" && room.status !== "rejected");
  const rendered = new Set(volumes.map(item => item.room.id));
  const outstanding = rooms.filter(room => room.isCandidate || !rendered.has(room.id)
    || resolveRoomHeight(room.componentProperties?.clearRoomHeight, storeys.find(item => item.id === room.storeyId)?.componentProperties?.clearRoomHeight).property?.reviewStatus !== "approved");
  const planParams = new URLSearchParams(params); planParams.set("modelView", "2d");
  if (currentFloor) {
    planParams.set("page", String(currentFloor.source.page)); planParams.set("storey", currentFloor.storey.id);
    if (currentFloor.source.source?.versionId) planParams.set("sourceVersion", currentFloor.source.source.versionId);
    if (!selected) { planParams.delete("entity"); planParams.delete("candidate"); }
  }
  const overviewParams = new URLSearchParams(params); overviewParams.delete("floorFocus");
  const status = (state?: BuildingComponentPropertyState | null) => state?.reviewStatus === "approved" ? t(state.provenance === "inferred" ? "buildingVolumeReviewedAssumption" : "buildingModelReviewed")
    : !state || state.provenance === "inferred" ? t("buildingVolumeAssumed") : t("buildingVolumeSourceUnreviewed");
  return <div className="building-room-volumes">
    <div className="building-room-volume-canvas" ref={host} role="region" aria-label={t("buildingVolumeBuilding") }>
      <nav className="building-volume-floors" aria-label={t("buildingVolumeFloors")}>
        <Link to={`?${overviewParams}`} aria-current={!focus ? "true" : undefined}>{t("buildingVolumeOverview")}</Link>
        {[...floors].reverse().map(floor => {
          const next = new URLSearchParams(params);
          next.delete("entity"); next.delete("candidate");
          next.set("floorFocus", "1"); next.set("page", String(floor.source.page));
          next.set("storey", floor.storey.id); next.set("sourceSelection", "manual");
          if (floor.source.source?.versionId) next.set("sourceVersion", floor.source.source.versionId);
          return <Link key={floor.source.id} to={`?${next}`} aria-current={focus?.source.id === floor.source.id ? "true" : undefined}>
            <span>{floor.storey.name ?? `${t("buildingModelPage")} ${floor.source.page}`}{floor.level != null ? ` · ${t("buildingVolumeLevel").replace("{level}", String(floor.level))}` : ""}</span>
            <span className="text-ui-xs text-muted-foreground">{floor.volumes.length} {t("buildingVolumeRooms")} · {floor.wallCount} {t("buildingVolumeWalls")}{!floor.meshes.length ? ` · ${t("buildingVolumeNotRendered")}` : ""}</span>
          </Link>;
        })}
      </nav>
      {error && <Callout>{t("buildingVolumeUnavailable")}</Callout>}
      {!framed.length && <div className="building-room-volume-empty"><Callout>{t(!currentFloor?.objects.length ? "buildingVolumeNoRooms" : !hasMetricScale(scale) ? "buildingVolumeNoScale" : "buildingVolumeNoGeometry")}</Callout></div>}
    </div>
    <aside className="building-room-volume-editor" aria-label={t("buildingVolumeDimensions")}>
      <h2 className="text-ui font-semibold">{currentFloor?.storey.name ?? t("buildingVolumeBuilding")}</h2>
      <Callout>{t("buildingVolumeDisclaimer")}</Callout>
      <details className="text-ui-xs text-muted-foreground"><summary>{t("buildingVolumePlacementAssumed")}</summary><p>{t("buildingVolumePlacementDetails")}</p></details>
      <p className="text-ui-xs text-muted-foreground">{t(groundReference ? "buildingVolumeGroundReference" : "buildingVolumeGroundUnknown")}</p>
      <Link className="text-ui-sm underline underline-offset-2" to={`?${planParams}`}>{t("buildingVolumeReviewPlan")}</Link>
      {!hasMetricScale(scale) && !!currentFloor?.objects.length && <Button variant="outline" onClick={onConfigureScale}>{t("buildingVolumeSetScale")}</Button>}
      <Segmented value={inspector} onChange={setInspector} items={[{ value: "dimensions", label: t("buildingVolumeDimensions") }, { value: "connections", label: t("buildingConnections") }]} />
      {inspector === "connections" ? <BuildingConnections model={model} objects={currentFloor?.objects ?? []} selected={selected}
        hrefFor={object => `?${objectParams(object)}`} onReview={onReviewConnection} onDerive={onDeriveConnections} pending={pending} /> : <>
      <Segmented value={onlyPending ? "pending" : "all"} onChange={value => setOnlyPending(value === "pending")} items={[
        { value: "all", label: t("buildingVolumeAllRooms") }, { value: "pending", label: `${t("buildingVolumeConfirm")} (${outstanding.length})` }]} />
      <div className="building-room-volume-list">
        {(onlyPending ? outstanding : rooms).map(room => {
          const resolved = resolveRoomHeight(room.componentProperties?.clearRoomHeight, storeys.find(item => item.id === room.storeyId)?.componentProperties?.clearRoomHeight);
          return <Link key={room.id} to={`?${objectParams(room)}`} aria-current={room.id === selectedId ? "true" : undefined}>
            <span>{room.label}</span><span>{room.isCandidate ? `${t("buildingVolumeDraft")} · ` : ""}{resolved.value.toFixed(2)} m · {status(resolved.property)}</span>
            {!rendered.has(room.id) && <span>{t("buildingVolumeNotRendered")}</span>}
          </Link>;
        })}
      </div>
      <p className="text-ui-xs text-muted-foreground">{t("buildingVolumeOmitted").replace("{count}", String(rooms.length - volumes.length))}</p>
      {selected?.entityType === "element" && <section className="grid gap-stack"><strong className="text-ui-sm">{selected.label}</strong><p className="text-ui-xs">{t("buildingVolumeWallReview")}</p></section>}
      {selectedRoom?.isCandidate && <section className="grid gap-stack">
        <strong className="text-ui-sm">{selectedRoom.label}</strong>
        <Badge>{t("buildingVolumeDraft")}</Badge>
        <p className="text-ui-xs">{t(selectedRoom.match?.existingId ? "buildingVolumeMatch" : "buildingVolumeDraftReview")}</p>
        {selectedRoom.geometryLimitations && <p className="text-ui-xs text-muted-foreground">{selectedRoom.geometryLimitations}</p>}
        <div className="flex flex-wrap gap-2">
          {!selectedRoom.match?.existingId && <Button variant="outline" disabled={pending || !rendered.has(selectedRoom.id)} onClick={() => onReviewOutline("approved")}>{t("buildingVolumeAcceptOutline")}</Button>}
          <Button variant="ghost" disabled={pending} onClick={() => onReviewOutline("rejected")}>{t("buildingModelRejectCandidate")}</Button>
        </div>
      </section>}
      <Segmented value={scope} onChange={setScope} items={[{ value: "room", label: t("buildingVolumeRoom") }, { value: "storey", label: t("buildingVolumeStorey") }]} />
      {target ? <form className="grid gap-stack" onSubmit={event => { event.preventDefault(); const number = Number(value); if (Number.isFinite(number) && number >= 1.5 && number <= 20) onSave(scope as "room" | "storey", target.id, number); }}>
        <strong className="text-ui-sm">{scope === "room" ? selected?.label : storey?.name}</strong>
        <Field label={t("buildingVolumeHeight")}><Input aria-label={t("buildingVolumeHeight")} type="number" min="1.5" max="20" step="0.01" required value={value} onChange={event => setValue(event.target.value)} /></Field>
        <div className="flex flex-wrap gap-2"><Badge>{status(effective.property)}</Badge><span className="text-ui-xs">{t(effective.scope === "storey" ? "buildingVolumeInherited" : effective.scope === "default" ? "buildingVolumeFallback" : "buildingVolumeOverride")}</span></div>
        {property?.evidenceQuote && <p className="text-ui-xs">{property.evidenceQuote}</p>}
        {property?.reviewedValue != null && property.reviewStatus !== "approved" && <p className="text-ui-xs">{t("buildingVolumePrevious").replace("{value}", String(property.reviewedValue))}</p>}
        <Button type="submit" disabled={pending}>{t("buildingVolumeSave")}</Button>
        {scope === "room" && property?.value != null && <Button type="button" variant="outline" disabled={pending} onClick={() => onSave("room", target.id, null)}>{t("buildingVolumeUseStorey")}</Button>}
        {property && property.value != null && !["approved", "rejected", "superseded"].includes(property.reviewStatus) && <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={pending || Number(value) !== property.value} onClick={() => onReview(property, "approved")}>{t("buildingVolumeReview")}</Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => onReview(property, "rejected")}>{t("buildingVolumeReject")}</Button>
        </div>}
      </form> : <p className="text-ui-sm">{t(selected?.isCandidate ? "buildingVolumeDraftHeight" : "buildingVolumeSelectRoom")}</p>}
      </>}
    </aside>
  </div>;
}
