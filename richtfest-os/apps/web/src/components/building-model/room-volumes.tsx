import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { aerialSourceFor, isActiveBuildingRelationship, resolveRoomHeight, type BuildingRelationship, type LocationContext, type LocationState } from "@richtfest/shared";
import { geometryArea, intersectGeometry, unionGeometry } from "@richtfest/shared/site-geometry";
import { registerMessages, useT } from "../../i18n";
import { useApi } from "../../query";
import { usePreferences } from "../../store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Badge, Callout, Field, Segmented } from "../ui/primitives";
import type { ViewportState, createViewport } from "../location/viewport";
import { outlineSelfIntersects, pointToMetres, type PageScale } from "./outline-geometry";
import { candidateRole, type BuildingComponentPropertyState, type BuildingModel, type BuildingRegion } from "./types";
import { BuildingConnections } from "./connections";
import { buildingPresentation, buildingSiteTransform } from "./building-presentation";
import { useSiteImage } from "../location/site-image";
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
export function buildingVolumeGeometry(model: BuildingModel, regions: BuildingRegion[], sourceId?: string, hideEmptyFloors = false) {
  const selectedSource = model.planSources.find(source => source.id === sourceId);
  const buildingId = model.storeys.find(storey => storey.id === selectedSource?.storeyId)?.buildingId;
  const sources = model.planSources.filter(source => source.storeyId
    && (!buildingId || model.storeys.some(storey => storey.id === source.storeyId && storey.buildingId === buildingId))
    && !model.supersededSources.some(item => item.sourceVersionId === source.source?.versionId)
    && !model.automaticPlanProcessing.some(item => item.sourceVersionId === source.source?.versionId
      && item.nonFloorPlanPages.some(page => page.page === source.page)));
  // One source per storey; prefer the currently selected plan set over an alternative drawing.
  const allFloors = model.storeys.flatMap(storey => {
    const options = sources.filter(source => source.storeyId === storey.id);
    const source = options.find(source => source.source?.versionId === selectedSource?.source?.versionId) ?? options[0];
    if (!source) return [];
    const extraction = model.extractions.find(job => job.page === source.page && job.storeyId === storey.id
      && job.sourceVersionId === source.source?.versionId);
    const scale = extraction?.result?.pageScale ?? null;
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
    const levelProperty = storey.componentProperties?.level;
    const level = levelProperty && !["rejected", "superseded"].includes(levelProperty.reviewStatus) && typeof levelProperty.value === "number"
      ? levelProperty.value : storey.levelIndex;
    return [{ source, storey, scale, objects, volumes, wallCount: wallMeshes.length, level, base: 0,
      openingEvidence: extraction?.result?.topologyCoverage?.openingEvidence ?? [], origin: [0, 0] as [number, number],
      height: Math.max(height, ...volumes.map(item => item.mesh.height)),
      meshes: meshes.map(mesh => ({ ...mesh, group: source.id })) }];
  }).sort((a, b) => (a.level ?? a.source.page - 1) - (b.level ?? b.source.page - 1) || a.source.page - b.source.page);
  const floors = hideEmptyFloors ? allFloors.filter(floor => floor.meshes.length) : allFloors;
  const hiddenLevels = new Set(hideEmptyFloors ? allFloors.filter(floor => !floor.meshes.length).map(floor => floor.level) : []);
  // Preserve shared sheet coordinates, including setbacks. Independently centring each
  // floor incorrectly moves a smaller roof storey into the middle of the building.
  const reference = floors.find(floor => floor.level === 0 && floor.meshes.length) ?? floors.find(floor => floor.meshes.length);
  const points = reference?.meshes.flatMap(mesh => mesh.polygons.flat(2)) ?? [];
  const origin: [number, number] = points.length ? [
    (Math.min(...points.map(p => p[0])) + Math.max(...points.map(p => p[0]))) / 2,
    (Math.min(...points.map(p => p[1])) + Math.max(...points.map(p => p[1]))) / 2,
  ] : [0, 0];
  let base = 0;
  for (const [index, floor] of floors.entries()) {
    const previous = floors[index - 1];
    if (previous) {
      const hiddenBetween = [...hiddenLevels].filter(level => level != null && previous.level != null && floor.level != null
        && level > previous.level && level < floor.level).length;
      base += (previous.height + .3) * (floor.level != null && previous.level != null ? Math.max(1, floor.level - previous.level - hiddenBetween) : 1);
    }
    floor.base = base;
    floor.origin = origin;
    for (const mesh of floor.meshes) {
      mesh.base = base;
      mesh.polygons = mesh.polygons.map(polygon => polygon.map(ring => ring.map(([x, z]) => [x - origin[0], z - origin[1]])));
    }
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

export function RoomVolumes({ projectId, regions, model, sourceId, selectedId, onSave, onReview, onReviewOutline, onConfigureScale, onReviewConnection, onDeriveConnections, pending }: {
  projectId: string; regions: BuildingRegion[]; model: BuildingModel; sourceId?: string;
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
  const [hideEmptyFloors, setHideEmptyFloors] = useState(true);
  const [showGround, setShowGround] = useState(true), [showAerial, setShowAerial] = useState(true);
  // Moving between floors must not rebuild their meshes (or restart the opacity animation).
  const floors = useMemo(() => buildingVolumeGeometry(model, regions, scopeSourceId, hideEmptyFloors), [model, regions, scopeSourceId, hideEmptyFloors]);
  // Keep prerequisite diagnostics and scale controls when the entire scene is empty.
  const diagnosticFloors = useMemo(() => floors.length ? floors : buildingVolumeGeometry(model, regions, scopeSourceId), [floors, model, regions, scopeSourceId]);
  const currentFloor = floors.find(floor => floor.storey.id === params.get("storey") && floor.source.page === Number(params.get("page"))
    && floor.source.source?.versionId === params.get("sourceVersion")) ?? diagnosticFloors.find(floor => floor.source.id === sourceId) ?? diagnosticFloors[0];
  const focus = params.get("floorFocus") === "1" ? currentFloor : undefined;
  const location = useApi(`/projects/${projectId}/location`);
  const siteContext = (location.data as LocationState | undefined)?.context ?? null;
  const transform = useMemo(() => buildingSiteTransform(floors, siteContext, model.placement), [floors, siteContext, model.placement]);
  const aerialSource = transform && siteContext ? aerialSourceFor(siteContext) : null;
  const aerial = useSiteImage(projectId, siteContext, "aerial/near", !!aerialSource && showGround && showAerial, t("buildingPresentationAerialUnavailable"));
  const siteOverlay = useMemo(() => ({ ...site, aerial: { near: aerial.url, far: null } }), [aerial.url]);
  const surroundings = !!transform && !focus && params.get("buildingScope") !== "building";
  const overviewParams = new URLSearchParams(params);
  for (const key of ["floorFocus", "roomFocus", "entity", "candidate"]) overviewParams.delete(key);
  overviewParams.set("buildingScope", "building");
  const objectParams = (region: BuildingRegion) => {
    const next = new URLSearchParams(params);
    next.delete("entity"); next.delete("candidate");
    next.set(region.isCandidate ? "candidate" : "entity", region.isCandidate ? region.id : `${region.entityType}:${region.id}`);
    next.set("page", String(region.page));
    if (region.sourceVersionId) next.set("sourceVersion", region.sourceVersionId);
    if (region.storeyId) next.set("storey", region.storeyId);
    if (region.constructionState === "proposed" || region.constructionState === "demolished") next.set("modelState", region.constructionState === "proposed" ? "proposed" : "demolition");
    next.set("sourceSelection", "manual");
    next.set("floorFocus", "1");
    if (region.entityType === "room") next.set("roomFocus", "1"); else next.delete("roomFocus");
    return next;
  };
  const select = useRef((id: string | null) => {});
  select.current = id => {
    if (!id) { if (focus || selectedId) setParams(overviewParams); return; }
    const region = regions.find(region => region.id === id);
    if (region) { setShowInspector(true); setParams(objectParams(region)); return; }
    const floor = floors.find(floor => floor.storey.id === id);
    if (floor) {
      const next = new URLSearchParams(params);
      next.delete("entity"); next.delete("candidate"); next.delete("roomFocus");
      next.set("floorFocus", "1"); next.set("page", String(floor.source.page)); next.set("storey", floor.storey.id);
      next.set("sourceSelection", "manual");
      if (floor.source.source?.versionId) next.set("sourceVersion", floor.source.source.versionId);
      setParams(next);
    }
  };
  const [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [appearance, setAppearance] = useState("building"), [cutaway, setCutaway] = useState(true), [showInspector, setShowInspector] = useState(true);
  const [hoveredFloor, setHoveredFloor] = useState<string | null>(null);
  const [scope, setScope] = useState("room"), [onlyPending, setOnlyPending] = useState(false);
  const [inspector, setInspector] = useState("dimensions");
  const related = useMemo(() => inspector === "connections" && selectedId ? model.relationships.filter(isActiveBuildingRelationship)
    .flatMap(link => link.fromEntityId === selectedId ? [link.toEntityId] : link.toEntityId === selectedId ? [link.fromEntityId] : []) : [], [model.relationships, selectedId, inspector]);
  const volumes = currentFloor?.volumes ?? [], scale = currentFloor?.scale ?? null;
  const presentation = useMemo(() => buildingPresentation(floors), [floors]);
  const meshes = useMemo<NonNullable<ViewportState["assessment"]>>(() => {
    const raw = appearance === "building" ? presentation.meshes : floors.flatMap(floor => floor.meshes);
    return transform ? raw.map(mesh => ({ ...mesh, polygons: mesh.polygons.map(polygon => polygon.map(ring => ring.map(transform))) })) : raw;
  }, [floors, presentation, appearance, transform]);
  const displayContext = useMemo(() => {
    if (!transform || !siteContext) return context;
    const caps = meshes.filter(mesh => mesh.roof).map(mesh => mesh.polygons);
    if (!caps.length) return siteContext;
    const footprint = unionGeometry(...caps);
    // Presentation occlusion only: cadastral massing must not cover the model
    // being inspected. Keep the recorded context and its identities untouched.
    return { ...siteContext, buildings: siteContext.buildings.filter(building => geometryArea(intersectGeometry(building.polygons, footprint)) < .01) };
  }, [meshes, transform, siteContext]);
  const groundReference = useMemo<ViewportState["groundReference"]>(() => {
    if (!meshes.length) return null;
    const points = meshes.flatMap(mesh => mesh.polygons.flat(2));
    const xs = points.map(point => point[0]), zs = points.map(point => point[1]);
    return { bounds: [[Math.min(...xs) - 6, Math.min(...zs) - 6], [Math.max(...xs) + 6, Math.max(...zs) + 6]] };
  }, [meshes]);
  const hasGroundDatum = floors.length > 0 && floors.every(floor => floor.level != null) && floors.some(floor => floor.level === 0);
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
      viewport.current = createViewport(host.current, { select: id => select.current(id), place: () => {}, measure: () => {}, align: () => {} });
      setReady(true);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; viewport.current?.dispose(); viewport.current = null; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    viewport.current?.update({ context: displayContext, surroundingsOpacity: focus ? .06 : 1,
      assessment: meshes, assessmentFocus: focus?.source.id ?? null, assessmentHover: hoveredFloor, assessmentRelated: related,
      groundReference: !showGround ? null : transform && !focus ? undefined : groundReference, objects: [], models: {}, site: siteOverlay, selected: selectedId ?? null,
      orbitDrag: true, assessmentCutaway: appearance === "building" && cutaway && focus ? focus.base + 1.15 : null,
      layers: { buildings: !!transform, trees: !!transform, detectedTrees: !!transform, objects: true, lidar: false, roads: !!transform, railNoise: false, plan: false, aerial: !!transform && showGround && showAerial },
      tool: "select", treeStyle: "illustrative", measurement: [], clipHeight: 200, dark, constructionLabel: "", projectExtentLabel: "", siteAddressLabel: "" });
  }, [ready, meshes, selectedId, dark, focus?.source.id, focus?.base, hoveredFloor, groundReference, related, appearance, cutaway, transform, displayContext, siteOverlay, showGround, showAerial]);
  const roomFocus = focus && params.get("roomFocus") === "1" ? selectedRoom : undefined;
  // Explicit room/floor navigation flies to canonical bounds; property edits preserve the user's camera.
  const framed = roomFocus ? meshes.filter(mesh => mesh.id === roomFocus.id) : focus ? meshes.filter(mesh => mesh.group === focus.source.id) : meshes;
  const framing = JSON.stringify(framed.map(mesh => [mesh.id, mesh.polygons, mesh.base, mesh.height]));
  const hasFramed = useRef(false);
  useEffect(() => {
    if (!ready || !framed.length) return;
    const base = Math.min(...framed.map(mesh => mesh.base)), top = Math.max(...framed.map(mesh => mesh.base + mesh.height));
    const points = framed.flatMap(mesh => mesh.polygons.flat(2));
    if (surroundings) {
      const xs = points.map(point => point[0]), zs = points.map(point => point[1]);
      points.push([Math.min(...xs) - 45, Math.min(...zs) - 45], [Math.max(...xs) + 45, Math.max(...zs) + 45]);
    }
    viewport.current?.fit(points, "perspective", hasFramed.current ? 1200 : 0, top - base, base, roomFocus ? 1.5 : focus ? .78 : 1.05);
    hasFramed.current = true;
  }, [ready, framing, focus?.source.id, roomFocus?.id, surroundings]);
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
  const surroundingsParams = new URLSearchParams(overviewParams); surroundingsParams.delete("buildingScope");
  const locationParams = new URLSearchParams(params); locationParams.set("view", "location");
  const status = (state?: BuildingComponentPropertyState | null) => state?.reviewStatus === "approved" ? t(state.provenance === "inferred" ? "buildingVolumeReviewedAssumption" : "buildingModelReviewed")
    : !state || state.provenance === "inferred" ? t("buildingVolumeAssumed") : t("buildingVolumeSourceUnreviewed");
  return <div className={`building-room-volumes${showInspector ? "" : " is-presentation"}`}>
    <div className="building-room-volume-canvas" ref={host} role="region" aria-label={t("buildingVolumeBuilding") }>
      <div className="building-volume-controls">
        <Segmented value={appearance} onChange={setAppearance} items={[{ value: "building", label: t("buildingPresentation") }, { value: "evidence", label: t("buildingPresentationEvidence") }]} />
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={() => viewport.current?.view("perspective")}>{t("buildingPresentationOrbit")}</Button>
          <Button size="sm" variant="outline" onClick={() => viewport.current?.view("top")}>{t("buildingPresentationTop")}</Button>
          <Button size="sm" variant="outline" aria-label={t("buildingPresentationZoomIn")} onClick={() => viewport.current?.zoom(1.4)}>+</Button>
          <Button size="sm" variant="outline" aria-label={t("buildingPresentationZoomOut")} onClick={() => viewport.current?.zoom(1 / 1.4)}>−</Button>
          <Button size="sm" variant="outline" aria-pressed={!showInspector} onClick={() => setShowInspector(value => !value)}>{t("buildingPresentationExpand")}</Button>
          <Popover>
            <PopoverTrigger asChild><Button size="sm" variant="outline">{t("buildingVolumeViewOptions")}</Button></PopoverTrigger>
            <PopoverContent align="end" className="grid gap-stack text-ui-sm">
              <label className="flex items-center gap-stack"><Checkbox checked={hideEmptyFloors} onCheckedChange={value => {
                setHideEmptyFloors(value === true);
                if (value && focus && !focus.meshes.length) setParams(overviewParams);
              }} />{t("buildingVolumeHideEmpty")}</label>
              <label className="flex items-center gap-stack"><Checkbox checked={showGround} onCheckedChange={value => setShowGround(value === true)} />{t("buildingVolumeShowGround")}</label>
              <label className="flex items-center gap-stack"><Checkbox checked={showAerial} disabled={!showGround || !aerialSource} onCheckedChange={value => setShowAerial(value === true)} />{t("buildingVolumeShowAerial")}</label>
              <p className="text-ui-xs text-muted-foreground">{t("buildingVolumeViewOnly")}</p>
              {!transform && <p className="text-ui-xs text-muted-foreground">{t("buildingPresentationSiteUnaligned")}</p>}
              {transform && !aerialSource && <p className="text-ui-xs text-muted-foreground">{t("buildingPresentationAerialUnavailable")}</p>}
            </PopoverContent>
          </Popover>
          {focus && appearance === "building" && <Button size="sm" variant="outline" aria-pressed={cutaway} onClick={() => setCutaway(value => !value)}>{t("buildingPresentationCutaway")}</Button>}
        </div>
      </div>
      {appearance === "building" && framed.length > 0 && !error && <div className="building-volume-legend text-ui-xs">{t("buildingPresentationLegend")}{showGround && showAerial && aerial.url && aerialSource && <div>{aerialSource.attribution}</div>}</div>}
      <nav className="building-volume-floors" aria-label={t("buildingVolumeFloors")}>
        {transform && <Link to={`?${surroundingsParams}`} aria-current={surroundings ? "true" : undefined}>{t("buildingPresentationSurroundings")}</Link>}
        <Link to={`?${overviewParams}`} aria-current={!focus && !surroundings ? "true" : undefined}>{t("buildingVolumeOverview")}</Link>
        {[...floors].reverse().map(floor => {
          const next = new URLSearchParams(params);
          next.delete("entity"); next.delete("candidate"); next.delete("roomFocus");
          next.set("floorFocus", "1"); next.set("page", String(floor.source.page));
          next.set("storey", floor.storey.id); next.set("sourceSelection", "manual");
          if (floor.source.source?.versionId) next.set("sourceVersion", floor.source.source.versionId);
          return <Link key={floor.source.id} to={`?${focus?.source.id === floor.source.id && !roomFocus ? overviewParams : next}`} aria-current={focus?.source.id === floor.source.id ? "true" : undefined}
            onPointerEnter={() => setHoveredFloor(floor.source.id)} onPointerLeave={() => setHoveredFloor(null)}
            onFocus={() => setHoveredFloor(floor.source.id)} onBlur={() => setHoveredFloor(null)}>
            <span>{floor.storey.name ?? `${t("buildingModelPage")} ${floor.source.page}`}{floor.level != null ? ` · ${t("buildingVolumeLevel").replace("{level}", String(floor.level))}` : ""}</span>
            <span className="text-ui-xs text-muted-foreground">{floor.volumes.length} {t("buildingVolumeRooms")} · {floor.wallCount} {t("buildingVolumeWalls")}{!floor.meshes.length ? ` · ${t("buildingVolumeNotRendered")}` : ""}</span>
          </Link>;
        })}
      </nav>
      {(error || !framed.length) && <div className="building-room-volume-empty" role="status"><Callout>{t(error ? "buildingVolumeUnavailable" : !currentFloor?.objects.length ? "buildingVolumeNoRooms" : !hasMetricScale(scale) ? "buildingVolumeNoScale" : "buildingVolumeNoGeometry")}</Callout></div>}
    </div>
    <aside className="building-room-volume-editor" aria-label={t("buildingVolumeDimensions")} hidden={!showInspector}>
      <h2 className="text-ui font-semibold">{currentFloor?.storey.name ?? t("buildingVolumeBuilding")}</h2>
      <Callout>{t("buildingVolumeDisclaimer")}</Callout>
      {currentFloor?.source.storeyTitle && <p className="text-ui-xs text-muted-foreground">{t("buildingStoreyTitleEvidence").replace("{quote}", currentFloor.source.storeyTitle.quote)}</p>}
      {!transform && <p className="text-ui-xs text-muted-foreground">{t("buildingPresentationSiteUnaligned")} <Link className="underline" to={`?${locationParams}`}>{t("buildingPresentationOpenLocation")}</Link></p>}
      {transform && <details className="text-ui-xs text-muted-foreground"><summary>{t("buildingPresentationSiteSources")}</summary>
        {siteContext?.sources.map(source => <a key={source.url} className="block underline" href={source.url} target="_blank" rel="noreferrer">{source.label}</a>)}
      </details>}
      {aerial.isError && <Callout>{t("buildingPresentationAerialUnavailable")}</Callout>}
      {appearance === "building" && <details className="text-ui-xs text-muted-foreground"><summary>{t("buildingPresentationAssumptions")}</summary>
        <p>{t("buildingPresentationDetails")}</p>
        <p>{t("buildingPresentationCounts").replace("{placed}", String(presentation.placedOpenings)).replace("{infill}", String(presentation.provisionalOpenings)).replace("{rooms}", String(presentation.furnishedRooms))}</p>
      </details>}
      <details className="text-ui-xs text-muted-foreground"><summary>{t("buildingVolumePlacementAssumed")}</summary><p>{t("buildingVolumePlacementDetails")}</p></details>
      {showGround && groundReference && <p className="text-ui-xs text-muted-foreground">{t(hasGroundDatum ? "buildingVolumeGroundReference" : "buildingVolumeGroundUnknown")}</p>}
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
