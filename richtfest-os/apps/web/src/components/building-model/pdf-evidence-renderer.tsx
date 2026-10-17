import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import { candidateRole, type BuildingEvidence, type BuildingGeometryPart, type BuildingRegion, type PdfEvidenceLayer } from "./types";

export type PdfViewerTransform = { zoom: number; pan: { x: number; y: number } };

/** Keep PDF.js on the authenticated app origin instead of following a bucket redirect that requires browser GET CORS. */
export function inlinePdfSource(value?: string) {
  if (!value || !value.startsWith("/api/") || !/\/download(?:[?#]|$)/.test(value)) return value;
  const [withoutHash, hash] = value.split("#", 2);
  const separator = withoutHash!.includes("?") ? "&" : "?";
  return `${withoutHash}${separator}inline=1${hash ? `#${hash}` : ""}`;
}

/** Render an extracted footprint relative to its normalized bounding box. */
export function polygonClipPath(region: Pick<BuildingRegion, "box" | "polygon" | "geometryQuality">) {
  if (region.geometryQuality === "anchor" || !region.box || !region.polygon?.length || region.box.width <= 0 || region.box.height <= 0) return undefined;
  const points = region.polygon.map((point) => `${(((point.x - region.box!.x) / region.box!.width) * 100).toFixed(2)}% ${(((point.y - region.box!.y) / region.box!.height) * 100).toFixed(2)}%`);
  return `polygon(${points.join(", ")})`;
}
/** SVG path of an extracted room outline (with holes) in its bounding box's 0–100 viewBox. */
export function regionShapePath(region: Pick<BuildingRegion, "box" | "polygon" | "holes" | "geometryQuality">) {
  if (region.geometryQuality === "anchor" || !region.box || !region.polygon?.length || region.box.width <= 0 || region.box.height <= 0) return undefined;
  const { x, y, width, height } = region.box;
  const ring = (points: NonNullable<BuildingRegion["polygon"]>) => `M${points.map((point) => `${(((point.x - x) / width) * 100).toFixed(3)} ${(((point.y - y) / height) * 100).toFixed(3)}`).join("L")}Z`;
  return [region.polygon, ...(region.holes ?? [])].map(ring).join("");
}
export function regionOverlayStyle(region: Pick<BuildingRegion, "box">): CSSProperties | undefined {
  return region.box ? { left: `${region.box.x * 100}%`, top: `${region.box.y * 100}%`, width: `${region.box.width * 100}%`, height: `${region.box.height * 100}%` } : undefined;
}

export function partOverlayStyle(part: BuildingGeometryPart, parentBox?: BuildingRegion["box"]): CSSProperties | undefined {
  if (!part.box || !parentBox || parentBox.width <= 0 || parentBox.height <= 0) return undefined;
  return { left: `${((part.box.x - parentBox.x) / parentBox.width) * 100}%`, top: `${((part.box.y - parentBox.y) / parentBox.height) * 100}%`, width: `${(part.box.width / parentBox.width) * 100}%`, height: `${(part.box.height / parentBox.height) * 100}%` };
}

type OverlayPoint = { x: number; y: number };
type OverlayViewport = { width: number; height: number };

function pointInBox(point: OverlayPoint, box: NonNullable<BuildingRegion["box"]>) {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}

function pointInPolygon(point: OverlayPoint, polygon: NonNullable<BuildingRegion["polygon"]>) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index]!;
    const previousPoint = polygon[previous]!;
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function regionPolygons(region: BuildingRegion) {
  const polygons = region.polygon && region.polygon.length >= 3 ? [region.polygon] : [];
  for (const part of region.parts || []) {
    if (part.polygon && part.polygon.length >= 3) polygons.push(part.polygon);
  }
  return polygons;
}

function containsRegionGeometry(region: BuildingRegion, point: OverlayPoint) {
  const polygons = regionPolygons(region);
  if (polygons.length) return polygons.some((polygon) => pointInPolygon(point, polygon));
  const partBoxes = (region.parts || []).flatMap((part) => part.box ? [part.box] : []);
  if (partBoxes.length) return partBoxes.some((box) => pointInBox(point, box));
  return region.box ? pointInBox(point, region.box) : false;
}

function pointToSegmentDistance(point: OverlayPoint, start: OverlayPoint, end: OverlayPoint, viewport: OverlayViewport) {
  const pointX = point.x * viewport.width;
  const pointY = point.y * viewport.height;
  const startX = start.x * viewport.width;
  const startY = start.y * viewport.height;
  const deltaX = (end.x - start.x) * viewport.width;
  const deltaY = (end.y - start.y) * viewport.height;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const amount = lengthSquared ? Math.min(1, Math.max(0, ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared)) : 0;
  return Math.hypot(pointX - (startX + amount * deltaX), pointY - (startY + amount * deltaY));
}

function boxPolygon(box: NonNullable<BuildingRegion["box"]>) {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

function regionDistance(region: BuildingRegion, point: OverlayPoint, viewport: OverlayViewport) {
  if (containsRegionGeometry(region, point)) return 0;
  const polygons = regionPolygons(region);
  if (!polygons.length) {
    const partBoxes = (region.parts || []).flatMap((part) => part.box ? [part.box] : []);
    if (partBoxes.length) polygons.push(...partBoxes.map(boxPolygon));
    else if (region.box) polygons.push(boxPolygon(region.box));
  }
  return polygons.reduce((nearest, polygon) => polygon.reduce((distance, start, index) => {
    const end = polygon[(index + 1) % polygon.length]!;
    return Math.min(distance, pointToSegmentDistance(point, start, end, viewport));
  }, nearest), Number.POSITIVE_INFINITY);
}

function regionGeometryArea(region: BuildingRegion) {
  const polygons = regionPolygons(region);
  if (polygons.length) return polygons.reduce((total, polygon) => total + Math.abs(polygon.reduce((area, point, index) => {
    const next = polygon[(index + 1) % polygon.length]!;
    return area + point.x * next.y - next.x * point.y;
  }, 0)) / 2, 0);
  const boxes = (region.parts || []).flatMap((part) => part.box ? [part.box] : []);
  if (boxes.length) return boxes.reduce((total, box) => total + box.width * box.height, 0);
  return region.box ? region.box.width * region.box.height : Number.POSITIVE_INFINITY;
}

/** Resolve overlapping screen-sized hit areas using the source geometry, not DOM paint order. */
export function overlayRegionAtPoint(regions: BuildingRegion[], point: OverlayPoint, viewport: OverlayViewport, hitRadius = 8) {
  if (viewport.width <= 0 || viewport.height <= 0) return undefined;
  const ranked = regions.map((region, renderOrder) => ({
    region,
    renderOrder,
    contains: containsRegionGeometry(region, point),
    distance: regionDistance(region, point, viewport),
    area: regionGeometryArea(region),
  })).filter((candidate) => candidate.contains || candidate.distance <= hitRadius);
  ranked.sort((left, right) => Number(right.contains) - Number(left.contains)
    || left.distance - right.distance
    || left.area - right.area
    || left.renderOrder - right.renderOrder
    || left.region.id.localeCompare(right.region.id));
  return ranked[0]?.region;
}

type OverlayInteractionStyle = CSSProperties & {
  "--building-model-overlay-inverse-scale": number;
  "--building-model-overlay-hit-size": string;
  "--building-model-overlay-label-gap": string;
  "--building-model-overlay-stroke": string;
  "--building-model-overlay-focus-ring": string;
  "--building-model-overlay-marker-size": string;
  "--building-model-overlay-marker-offset": string;
};

/** Keep overlay interaction affordances legible without changing source geometry. */
export function overlayInteractionStyle(zoom: number): OverlayInteractionStyle {
  const safeZoom = Number.isFinite(zoom) ? Math.min(4, Math.max(1, zoom)) : 1;
  return {
    "--building-model-overlay-inverse-scale": 1 / safeZoom,
    "--building-model-overlay-hit-size": `${16 / safeZoom}px`,
    "--building-model-overlay-label-gap": `${3 / safeZoom}px`,
    "--building-model-overlay-stroke": `${1 / safeZoom}px`,
    "--building-model-overlay-focus-ring": `${2 / safeZoom}px`,
    "--building-model-overlay-marker-size": `${7 / safeZoom}px`,
    "--building-model-overlay-marker-offset": `${-5 / safeZoom}px`,
  };
}

/** PDF.js is isolated behind this lazy component. OCGs affect rendering only. */
export function PdfEvidenceRenderer({
  projectId,
  evidence,
  page,
  selectedId,
  regions,
  layerVisibility,
  onLayers,
  onSelect,
  transform,
  onTransform,
  labels,
}: {
  projectId: string;
  evidence: BuildingEvidence;
  page: number;
  selectedId?: string;
  regions: BuildingRegion[];
  layerVisibility: Record<string, boolean>;
  onLayers: (layers: PdfEvidenceLayer[]) => void;
  onSelect: (id: string) => void;
  transform?: PdfViewerTransform;
  onTransform?: (transform: PdfViewerTransform) => void;
  labels: { empty: string; loading: string; region: string; zoom: string; zoomIn: string; zoomOut: string; fit: string };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const evidenceCanvas = useRef<HTMLDivElement>(null);
  const regionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [internalZoom, setInternalZoom] = useState(1);
  const [internalPan, setInternalPan] = useState({ x: 0, y: 0 });
  const zoom = transform?.zoom ?? internalZoom;
  const pan = transform?.pan ?? internalPan;
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  const pdfRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);
  const source = inlinePdfSource(evidence.pdfUrl || (evidence.fileId
    ? `/api/projects/${projectId}/files/${evidence.fileId}/versions/${evidence.version || 1}/download`
    : undefined));

  const updateTransform = (next: PdfViewerTransform) => {
    setInternalZoom(next.zoom);
    setInternalPan(next.pan);
    onTransform?.(next);
  };

  useEffect(() => {
    updateTransform({ zoom: 1, pan: { x: 0, y: 0 } });
  }, [source, page]);

  // React delegates wheel events as passive in some browsers. Register this
  // one listener explicitly so zoom can consume the gesture without a console
  // warning or accidentally scrolling the project page underneath the viewer.
  useEffect(() => {
    const node = evidenceCanvas.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const currentZoom = transform?.zoom ?? internalZoom;
      const next = Math.min(4, Math.max(1, Number((currentZoom + (event.deltaY > 0 ? -0.1 : 0.1)).toFixed(2))));
      updateTransform({ zoom: next, pan: next === 1 ? { x: 0, y: 0 } : pan });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [transform?.zoom, internalZoom, pan.x, pan.y]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(undefined);
    if (!source) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        if (!pdfRef.current || pdfRef.current.__source !== source) {
          const loadingTask = pdfjs.getDocument({ url: source });
          const pdf: any = await loadingTask.promise;
          pdf.__source = source;
          pdfRef.current = pdf;
        }
        if (disposed) return;
        const pdf = pdfRef.current;
        const pdfPage = await pdf.getPage(page);
        const config = await pdf.getOptionalContentConfig();
        const operatorList = await pdfPage.getOperatorList();
        const pageLayerIds = new Set<string>();
        operatorList.fnArray.forEach((operation: number, index: number) => {
          if (operation !== pdfjs.OPS.beginMarkedContentProps) return;
          const properties = operatorList.argsArray[index]?.[1];
          if (properties?.type === "OCG" && typeof properties.id === "string") pageLayerIds.add(properties.id);
        });
        const entries: Array<[string, any]> = typeof (config as any)?.[Symbol.iterator] === "function"
          ? [...(config as any)]
          : Object.entries((config as any)?.getGroups?.() || (config as any)?.groups || {});
        const pageEntries = pageLayerIds.size ? entries.filter(([id]) => pageLayerIds.has(id)) : entries;
        const layers = pageEntries.map(([id, group]) => ({ id, label: group.name || id, visible: group.visible !== false }));
        if (!disposed) onLayers(layers);
        const viewport = pdfPage.getViewport({ scale: 1.35 });
        const target = canvas.current;
        if (!target) return;
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        for (const [id, visible] of Object.entries(layerVisibility)) config?.setVisibility?.(id, visible);
        renderTaskRef.current?.cancel?.();
        renderTaskRef.current = pdfPage.render({ canvasContext: target.getContext("2d"), viewport, optionalContentConfig: config });
        await renderTaskRef.current.promise;
        if (!disposed) setLoading(false);
      } catch (cause) {
        if (!disposed) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => { disposed = true; renderTaskRef.current?.cancel?.(); };
  }, [source, page, layerVisibility]);

  const adjustZoom = (delta: number) => {
    const next = Math.min(4, Math.max(1, Number((zoom + delta).toFixed(2))));
    updateTransform({ zoom: next, pan: next === 1 ? { x: 0, y: 0 } : pan });
  };
  const fit = () => updateTransform({ zoom: 1, pan: { x: 0, y: 0 } });
  const beginPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || (event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    updateTransform({ zoom, pan: { x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y } });
  };
  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = undefined;
  };
  const pageRegions = regions.filter((region) => region.page === page);
  const hasSelectedRegion = Boolean(selectedId && pageRegions.some((region) => region.id === selectedId));
  const selectOverlayRegion = (event: React.MouseEvent<HTMLButtonElement>, focusedRegion: BuildingRegion) => {
    // Keyboard-generated clicks have no pointer coordinates. Preserve native
    // button semantics and select the region that owns keyboard focus.
    if (event.detail === 0) {
      onSelect(focusedRegion.id);
      return;
    }
    const layer = event.currentTarget.parentElement;
    const bounds = layer?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    const region = overlayRegionAtPoint(pageRegions, {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    }, bounds);
    if (region) {
      if (region.id !== focusedRegion.id) regionButtonRefs.current.get(region.id)?.focus({ preventScroll: true });
      onSelect(region.id);
    }
  };
  return (
    <div ref={evidenceCanvas} className="building-model-evidence-canvas" data-page={page} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}>
      <div className="building-model-view-controls" aria-label={labels.zoom} onPointerDown={(event) => event.stopPropagation()}>
        <Button size="sm" variant="outline" type="button" onClick={() => adjustZoom(-0.25)} disabled={zoom <= 1} aria-label={labels.zoomOut} title={labels.zoomOut}><Minus className="size-icon-sm" aria-hidden="true" /></Button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <Button size="sm" variant="outline" type="button" onClick={() => adjustZoom(0.25)} disabled={zoom >= 4} aria-label={labels.zoomIn} title={labels.zoomIn}><Plus className="size-icon-sm" aria-hidden="true" /></Button>
        <Button size="sm" variant="ghost" type="button" onClick={fit} aria-label={labels.fit} title={labels.fit}><RotateCcw className="size-icon-sm" aria-hidden="true" /></Button>
      </div>
      <div className={`building-model-plan-surface${source ? "" : " is-empty"}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        {source ? <canvas ref={canvas} className="building-model-pdf" aria-label={`${evidence.fileName} · page ${page}`} /> : <div className="building-model-pdf-empty"><span className="mono">PDF</span><p>{labels.empty}</p></div>}
        <div className={`building-model-region-layer${hasSelectedRegion ? " has-selection" : ""}`} style={overlayInteractionStyle(zoom)} aria-label={labels.region}>
          {pageRegions.map((region) => {
            const role = region.isCandidate ? region.candidateRole || candidateRole(region) : undefined;
            // Room outlines are drawn as their exact polygon; the bounding-box button only provides focus and hit area.
            const shapePath = region.isCandidate && !region.parts?.length && region.entityType !== "element" ? regionShapePath(region) : undefined;
            const candidateClass = role === "draft-wall" ? "draft-wall" : role === "raw-footprint" ? "footprint" : role === "construction-assembly" ? "assembly" : region.isCandidate && (region.geometryQuality === "approximate_partition" || region.geometryQuality === "approximate_region") ? "approximate" : region.isCandidate ? "anchor" : "";
            return (
            <button key={region.id} ref={(node) => { if (node) regionButtonRefs.current.set(region.id, node); else regionButtonRefs.current.delete(region.id); }} type="button" className={`building-model-region ${region.kind} ${region.isCandidate ? "candidate" : ""} ${candidateClass} ${selectedId === region.id ? "selected" : ""}${shapePath ? " has-outline" : ""}`} style={regionOverlayStyle(region)} onClick={(event) => selectOverlayRegion(event, region)} aria-pressed={selectedId === region.id} aria-label={`${region.label} · ${role || region.kind}`}>
              <span className="building-model-region-hit-area" aria-hidden="true" />
              {region.isCandidate && region.parts?.length ? region.parts.map((part, index) => <span key={`${region.id}-part-${index}`} className="building-model-region-shape" style={{ ...partOverlayStyle(part, region.box), clipPath: polygonClipPath({ box: part.box, polygon: part.polygon, geometryQuality: "assembly" }) }} aria-hidden="true" />) : shapePath ? <svg className="building-model-region-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={shapePath} fillRule="evenodd" vectorEffect="non-scaling-stroke" /></svg> : region.isCandidate && polygonClipPath(region) ? <span className="building-model-region-shape" style={{ clipPath: polygonClipPath(region) }} aria-hidden="true" /> : null}
              <span className="building-model-region-label">{region.label}</span>
            </button>
          );})}
        </div>
      </div>
      {loading && source && <div className="building-model-pdf-loading" role="status">{labels.loading} {page}…</div>}
      {error && <div className="building-model-pdf-error" role="alert">{error}</div>}
    </div>
  );
}
