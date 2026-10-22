import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { buildingDeepLink, resolveRoomHeight, type LocationContext } from "@richtfest/shared";
import { registerMessages, useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge, Callout, Field, Segmented } from "../ui/primitives";
import type { ViewportState, createViewport } from "../location/viewport";
import { outlineSelfIntersects, pointToMetres, type PageScale } from "./outline-geometry";
import type { BuildingComponentPropertyState, BuildingModel, BuildingRegion } from "./types";
import en from "./locales/en.json";
import de from "./locales/de.json";

registerMessages({ en, de });

/** Render only canonical spatial rooms, never label boxes or extraction candidates. */
export function roomVolumeGeometry(regions: BuildingRegion[], storeys: BuildingModel["storeys"], scale: PageScale | null) {
  if (!scale?.metresPerPageHeight || scale.metresPerPageHeight <= 0 || !Number.isFinite(scale.metresPerPageHeight)
    || !Number.isFinite(scale.pageAspectRatio) || scale.pageAspectRatio <= 0) return [];
  return regions.flatMap(room => {
    if (room.entityType !== "room" || room.isCandidate || room.status === "rejected" || room.geometryQuality === "anchor"
      || !room.polygon || room.polygon.length < 3 || outlineSelfIntersects(room.polygon)) return [];
    const rings = [room.polygon, ...(room.holes ?? [])];
    if (rings.some(ring => ring.length < 3 || ring.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) return [];
    const storey = storeys.find(item => item.id === room.storeyId);
    const height = resolveRoomHeight(room.componentProperties?.clearRoomHeight, storey?.componentProperties?.clearRoomHeight);
    const polygons: [number, number][][][] = [rings.map(ring => ring.map(point => {
      const metres = pointToMetres(point, scale);
      return [metres.x, metres.y];
    }))];
    return [{ room, height, mesh: { id: room.id, polygons, base: 0, height: height.value, color: height.property?.reviewStatus === "approved" ? 0x94a3b8 : 0xd6b879 } }];
  });
}

const context: LocationContext = { siteId: "canonical-plan", address: "", origin: [0, 0], longitude: 0, latitude: 0,
  radius: 50, buildings: [], trees: [], sources: [], importedAt: "" };
const site: ViewportState["site"] = { axes: [], plan: null, distances: [], railNoise: null, aerial: { near: null, far: null }, picks: [], snaps: [] };

export function RoomVolumes({ projectId, regions, storeys, storeyId, scale, selectedId, onSelect, onSave, onReview, pending }: {
  projectId: string; regions: BuildingRegion[]; storeys: BuildingModel["storeys"]; storeyId?: string | null;
  scale: PageScale | null; selectedId?: string; onSelect: (id: string) => void;
  onSave: (entityType: "room" | "storey", entityId: string, value: number | null) => void;
  onReview: (state: BuildingComponentPropertyState, decision: "approved" | "rejected") => void;
  pending: boolean;
}) {
  const t = useT(), dark = usePreferences(state => state.theme) === "dark";
  const [params] = useSearchParams();
  const host = useRef<HTMLDivElement>(null), viewport = useRef<ReturnType<typeof createViewport> | null>(null);
  const select = useRef(onSelect); select.current = onSelect;
  const [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [scope, setScope] = useState("room"), [onlyPending, setOnlyPending] = useState(false);
  const volumes = useMemo(() => roomVolumeGeometry(regions, storeys, scale), [regions, storeys, scale]);
  const meshes = useMemo(() => volumes.map(item => item.mesh), [volumes]);
  const selected = regions.find(item => item.entityType === "room" && item.id === selectedId);
  const storey = storeys.find(item => item.id === (selected?.storeyId ?? storeyId));
  const height = resolveRoomHeight(selected?.componentProperties?.clearRoomHeight, storey?.componentProperties?.clearRoomHeight);
  const target = scope === "room" ? selected : storey;
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
    viewport.current?.update({ context, assessment: meshes, objects: [], models: {}, site, selected: selectedId ?? null,
      layers: { buildings: false, trees: false, detectedTrees: false, objects: true, lidar: false, roads: false, railNoise: false, plan: false, aerial: false },
      tool: "select", treeStyle: "schematic", measurement: [], clipHeight: 200, dark, constructionLabel: "", projectExtentLabel: "", siteAddressLabel: "" });
  }, [ready, meshes, selectedId, dark]);
  // Reframe when the source page or room inventory changes, not after every height edit or selection.
  const framing = JSON.stringify(meshes.map(mesh => [mesh.id, mesh.polygons]));
  useEffect(() => {
    if (ready && meshes.length) viewport.current?.fit(meshes.flatMap(mesh => mesh.polygons.flat(2)), "perspective", 0, Math.max(...meshes.map(mesh => mesh.height)));
  }, [ready, framing]);
  const rooms = regions.filter(room => room.entityType === "room" && !room.isCandidate);
  const outstanding = rooms.filter(room => resolveRoomHeight(room.componentProperties?.clearRoomHeight, storeys.find(item => item.id === room.storeyId)?.componentProperties?.clearRoomHeight).property?.reviewStatus !== "approved");
  const status = (state?: BuildingComponentPropertyState | null) => state?.reviewStatus === "approved" ? t(state.provenance === "inferred" ? "buildingVolumeReviewedAssumption" : "buildingModelReviewed")
    : !state || state.provenance === "inferred" ? t("buildingVolumeAssumed") : t("buildingVolumeSourceUnreviewed");
  return <div className="building-room-volumes">
    <div className="building-room-volume-canvas" ref={host} role="region" aria-label={t("buildingVolumeTitle")}>
      {error && <Callout>{t("buildingVolumeUnavailable")}</Callout>}
      {!meshes.length && <div className="building-room-volume-empty"><Callout>{t("buildingVolumeNoGeometry")}</Callout></div>}
    </div>
    <aside className="building-room-volume-editor" aria-label={t("buildingVolumeDimensions")}>
      <h2 className="text-ui font-semibold">{t("buildingVolumeTitle")}</h2>
      <Callout>{t("buildingVolumeDisclaimer")}</Callout>
      <Segmented value={onlyPending ? "pending" : "all"} onChange={value => setOnlyPending(value === "pending")} items={[
        { value: "all", label: t("buildingVolumeAllRooms") }, { value: "pending", label: `${t("buildingVolumeConfirm")} (${outstanding.length})` }]} />
      <div className="building-room-volume-list">
        {(onlyPending ? outstanding : rooms).map(room => {
          const resolved = resolveRoomHeight(room.componentProperties?.clearRoomHeight, storeys.find(item => item.id === room.storeyId)?.componentProperties?.clearRoomHeight);
          return <Link key={room.id} to={`${buildingDeepLink(projectId, "room", room.id)}&modelView=3d&modelState=${encodeURIComponent(params.get("modelState") || "existing")}`} aria-current={room.id === selectedId ? "true" : undefined}>
            <span>{room.label}</span><span>{resolved.value.toFixed(2)} m · {status(resolved.property)}</span>
          </Link>;
        })}
      </div>
      <p className="text-ui-xs text-muted-foreground">{t("buildingVolumeOmitted").replace("{count}", String(rooms.length - volumes.length))}</p>
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
      </form> : <p className="text-ui-sm">{t("buildingVolumeSelectRoom")}</p>}
    </aside>
  </div>;
}
