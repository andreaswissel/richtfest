import { wallRoleOf } from "./component-properties";
import { closureLabel, type FireAnnotation, type FireMark } from "./fire-protection";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import { candidateRole, type BuildingEvidence, type BuildingGeometryPart, type BuildingPlanPoint, type BuildingRegion, type PdfEvidenceLayer } from "./types";
import { OutlineEditorLayer } from "./outline-editor";
import type { OutlineDraft } from "./outline-geometry";

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
  focusRegion,
  regions,
  layerVisibility,
  onLayers,
  onSelect,
  transform,
  onTransform,
  labels,
  tool = "select",
  onPlanPick,
  outline,
  measure,
  hideViewControls = false,
  colorWallRoles = false,
  fire = null,
}: {
  projectId: string;
  evidence: BuildingEvidence;
  page: number;
  selectedId?: string;
  /** Centre a newly opened review task once; ordinary selection and editing keep the viewport. */
  focusRegion?: BuildingRegion;
  regions: BuildingRegion[];
  layerVisibility: Record<string, boolean>;
  onLayers: (layers: PdfEvidenceLayer[]) => void;
  onSelect: (id: string) => void;
  transform?: PdfViewerTransform;
  onTransform?: (transform: PdfViewerTransform) => void;
  labels: { empty: string; loading: string; region: string; zoom: string; zoomIn: string; zoomOut: string; fit: string; magicSurface?: string; point?: string; addPoint?: string };
  /** "magic" and "measure": a click on the plan reports its normalized point instead of selecting a region.
   * "pan": regions are inert, so a drag anywhere moves the plan. */
  tool?: "select" | "magic" | "pan" | "measure";
  onPlanPick?: (point: BuildingPlanPoint) => void;
  /** An outline being edited; other regions stay visible but inert. */
  outline?: { draft: OutlineDraft; onBegin: () => void; onChange: (draft: OutlineDraft) => void; snap?: boolean } | null;
  /** Measurement points (one or two) with an optional label for the measured distance. */
  measure?: { points: BuildingPlanPoint[]; label?: string } | null;
  /** The workbench renders its own zoom controls in the tool rail. */
  hideViewControls?: boolean;
  /** Fill accepted walls by their wall role, as on a sound insulation plan. */
  colorWallRoles?: boolean;
  /** Brandschutzplan: walls by required rating, notwendige Flure and Treppenräume in green, door closures and escape route lengths. */
  fire?: { marks: Map<string, FireMark>; annotations: FireAnnotation[]; label: (annotation: FireAnnotation) => string } | null;
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
      // Scale the pan with the zoom so the point at the centre of the view stays put.
      updateTransform({ zoom: next, pan: { x: pan.x * next / currentZoom, y: pan.y * next / currentZoom } });
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
    updateTransform({ zoom: next, pan: { x: pan.x * next / zoom, y: pan.y * next / zoom } });
  };
  const fit = () => updateTransform({ zoom: 1, pan: { x: 0, y: 0 } });
  // Touch: two fingers pinch-zoom around the point between them (the canvas disables the browser's own pinch).
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number; pan: { x: number; y: number }; mid: { x: number; y: number }; centre: { x: number; y: number } } | undefined>(undefined);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const focusedTask = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusRegion) { focusedTask.current = undefined; return; }
    const key = `${source}:${page}:${focusRegion.id}`;
    if (loading || error || outline || focusRegion.page !== page || !focusRegion.box || focusedTask.current === key) return;
    const frame = requestAnimationFrame(() => {
      const surface = surfaceRef.current?.getBoundingClientRect();
      const viewport = evidenceCanvas.current?.getBoundingClientRect();
      const box = focusRegion.box!;
      if (!surface?.width || !surface.height || !viewport?.width || !viewport.height) return;
      const width = surface.width / zoom, height = surface.height / zoom;
      const nextZoom = Math.min(4, Math.max(1, Math.min(viewport.width / (Math.max(box.width, .05) * width * 1.6), viewport.height / (Math.max(box.height, .05) * height * 1.6))));
      const centreX = surface.left + surface.width / 2 - pan.x, centreY = surface.top + surface.height / 2 - pan.y;
      focusedTask.current = key;
      updateTransform({ zoom: nextZoom, pan: {
        x: viewport.left + viewport.width / 2 - centreX - (box.x + box.width / 2 - .5) * width * nextZoom,
        y: viewport.top + viewport.height / 2 - centreY - (box.y + box.height / 2 - .5) * height * nextZoom,
      } });
    });
    return () => cancelAnimationFrame(frame);
  }, [source, page, focusRegion, loading, error, outline]);
  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(b!.x - a!.x, b!.y - a!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } };
  };
  const pinchedAt = useRef(0);
  const beginPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const onButton = Boolean((event.target as HTMLElement).closest("button"));
    // Presses on overlay buttons keep their click, but still count as a finger for pinching.
    if (onButton && event.pointerType !== "touch") return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!onButton) event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) {
      // The surface scales about its centre; its untransformed centre is the current centre minus the pan.
      const bounds = surfaceRef.current?.getBoundingClientRect();
      const { distance, mid } = pinchState();
      dragRef.current = undefined;
      if (bounds && distance > 0) pinchRef.current = { distance, zoom, pan, mid, centre: { x: bounds.left + bounds.width / 2 - pan.x, y: bounds.top + bounds.height / 2 - pan.y } };
      return;
    }
    if (pointers.current.size === 1 && !onButton) dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (pinch && pointers.current.size >= 2) {
      const { distance, mid } = pinchState();
      const next = Math.min(4, Math.max(1, pinch.zoom * distance / pinch.distance)), ratio = next / pinch.zoom;
      // Keep the plan point that started under the fingers' midpoint under the current midpoint.
      updateTransform({ zoom: next, pan: { x: mid.x - pinch.centre.x - ratio * (pinch.mid.x - pinch.centre.x - pinch.pan.x), y: mid.y - pinch.centre.y - ratio * (pinch.mid.y - pinch.centre.y - pinch.pan.y) } });
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    updateTransform({ zoom, pan: { x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y } });
  };
  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const wasPinch = Boolean(pinchRef.current);
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (wasPinch && pointers.current.size < 2) { pinchRef.current = undefined; pinchedAt.current = Date.now(); }
    // Lifting one finger of a pinch continues as a pan with the remaining one.
    const [rest] = [...pointers.current.values()];
    dragRef.current = !rest ? undefined : wasPinch ? { x: rest.x, y: rest.y, panX: pan.x, panY: pan.y } : dragRef.current;
  };
  // Regions without plan geometry, such as derived storey ceilings, are listed in the outliner but not drawn.
  const pageRegions = regions.filter((region) => region.page === page && region.box);
  const pickStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const magicSurface = useRef<HTMLDivElement>(null);
  // Magic picks are resolved on the canvas: panning captures the pointer there, so the
  // surface itself never sees the click. A press that moved more than 4 px was a pan.
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pickStart.current = magicSurface.current && event.target === magicSurface.current && !pointers.current.size ? { x: event.clientX, y: event.clientY } : undefined;
    beginPan(event);
    if (pointers.current.size > 1) pickStart.current = undefined;
  };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    endPan(event);
    const start = pickStart.current, bounds = magicSurface.current?.getBoundingClientRect();
    pickStart.current = undefined;
    if (!start || !bounds?.width || !bounds.height || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    onPlanPick?.({ x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height });
  };
  const hasSelectedRegion = Boolean(selectedId && pageRegions.some((region) => region.id === selectedId));
  const selectOverlayRegion = (event: React.MouseEvent<HTMLButtonElement>, focusedRegion: BuildingRegion) => {
    // Lifting the fingers after a pinch is not a selection.
    if (event.detail !== 0 && Date.now() - pinchedAt.current < 400) return;
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
    <div ref={evidenceCanvas} className="building-model-evidence-canvas" data-page={page} onPointerDown={pointerDown} onPointerMove={movePan} onPointerUp={pointerUp} onPointerCancel={endPan}>
      {!hideViewControls && <div className="building-model-view-controls" aria-label={labels.zoom} onPointerDown={(event) => event.stopPropagation()}>
        <Button size="sm" variant="outline" type="button" onClick={() => adjustZoom(-0.25)} disabled={zoom <= 1} aria-label={labels.zoomOut} title={labels.zoomOut}><Minus className="size-icon-sm" aria-hidden="true" /></Button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <Button size="sm" variant="outline" type="button" onClick={() => adjustZoom(0.25)} disabled={zoom >= 4} aria-label={labels.zoomIn} title={labels.zoomIn}><Plus className="size-icon-sm" aria-hidden="true" /></Button>
        <Button size="sm" variant="ghost" type="button" onClick={fit} aria-label={labels.fit} title={labels.fit}><RotateCcw className="size-icon-sm" aria-hidden="true" /></Button>
      </div>}
      <div ref={surfaceRef} className={`building-model-plan-surface${source ? "" : " is-empty"}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        {source ? <canvas ref={canvas} className="building-model-pdf" aria-label={`${evidence.fileName} · page ${page}`} /> : <div className="building-model-pdf-empty"><span className="mono">PDF</span><p>{labels.empty}</p></div>}
        <div className={`building-model-region-layer${fire ? " color-fire" : colorWallRoles ? " color-wall-roles" : ""}${hasSelectedRegion ? " has-selection" : ""}${outline || tool !== "select" ? " is-inert" : ""}`} style={overlayInteractionStyle(zoom)} aria-label={labels.region}>
          {pageRegions.map((region) => {
            const role = region.isCandidate ? region.candidateRole || candidateRole(region) : undefined;
            // Room outlines are drawn as their exact polygon; the bounding-box button only provides focus and hit area.
            const shapePath = !region.parts?.length && region.entityType !== "element" && region.kind !== "element" ? regionShapePath(region) : undefined;
            const candidateClass = role === "draft-wall" ? "draft-wall" : role === "raw-footprint" ? "footprint" : role === "construction-assembly" ? "assembly" : region.isCandidate && (region.geometryQuality === "approximate_partition" || region.geometryQuality === "approximate_region") ? "approximate" : region.isCandidate ? "anchor" : "";
            return (
            <button key={region.id} ref={(node) => { if (node) regionButtonRefs.current.set(region.id, node); else regionButtonRefs.current.delete(region.id); }} type="button" className={`building-model-region ${region.kind} ${region.isCandidate ? "candidate" : ""} ${candidateClass} ${selectedId === region.id ? "selected" : ""}${shapePath ? " has-outline" : ""}`} style={regionOverlayStyle(region)} data-wall-role={region.entityType === "element" ? wallRoleOf(region) : undefined}
              data-fire-wall={fire?.marks.get(region.id)?.wall} data-fire-room={fire?.marks.get(region.id)?.room} data-fire-door={fire?.marks.get(region.id)?.door} data-fire-status={fire?.marks.get(region.id)?.status} onClick={(event) => selectOverlayRegion(event, region)} aria-pressed={selectedId === region.id} aria-label={`${region.label} · ${role || region.kind}`}>
              <span className="building-model-region-hit-area" aria-hidden="true" />
              {region.isCandidate && region.parts?.length ? region.parts.map((part, index) => <span key={`${region.id}-part-${index}`} className="building-model-region-shape" style={{ ...partOverlayStyle(part, region.box), clipPath: polygonClipPath({ box: part.box, polygon: part.polygon, geometryQuality: "assembly" }) }} aria-hidden="true" />) : shapePath ? <svg className="building-model-region-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={shapePath} fillRule="evenodd" vectorEffect="non-scaling-stroke" /></svg> : region.isCandidate && polygonClipPath(region) ? <span className="building-model-region-shape" style={{ clipPath: polygonClipPath(region) }} aria-hidden="true" /> : null}
              <span className="building-model-region-label">{fire?.marks.get(region.id)?.door ? closureLabel(fire.marks.get(region.id)!.door!) : region.label}</span>
            </button>
          );})}
        </div>
        {fire && fire.annotations.length > 0 && <svg className="building-model-fire-paths" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          {fire.annotations.map((annotation) => <polyline key={annotation.id} className={annotation.over ? "is-over" : undefined} points={annotation.path.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")} vectorEffect="non-scaling-stroke" />)}
        </svg>}
        {fire?.annotations.map((annotation) => <span key={annotation.id} className={`building-model-fire-route${annotation.over ? " is-over" : ""}`} style={{ left: `${annotation.point.x * 100}%`, top: `${annotation.point.y * 100}%`, ...overlayInteractionStyle(zoom) }} title={fire.label(annotation)}>{annotation.text}</span>)}
        {(tool === "magic" || tool === "measure") && !outline && <div ref={magicSurface} className="building-model-magic-surface" aria-label={labels.magicSurface} />}
        {measure && measure.points.length > 0 && <svg className="building-model-measure" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          {measure.points.length === 2 && <line x1={measure.points[0]!.x * 1000} y1={measure.points[0]!.y * 1000} x2={measure.points[1]!.x * 1000} y2={measure.points[1]!.y * 1000} vectorEffect="non-scaling-stroke" />}
        </svg>}
        {measure?.points.map((point, index) => <span key={index} className="building-model-measure-point" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%`, ...overlayInteractionStyle(zoom) }} aria-hidden="true" />)}
        {measure?.label && measure.points.length === 2 && <span className="building-model-measure-label" style={{ left: `${(measure.points[0]!.x + measure.points[1]!.x) * 50}%`, top: `${(measure.points[0]!.y + measure.points[1]!.y) * 50}%`, ...overlayInteractionStyle(zoom) }}>{measure.label}</span>}
        {outline && <OutlineEditorLayer style={overlayInteractionStyle(zoom)} snap={outline.snap ?? true} draft={outline.draft} onBegin={outline.onBegin} onChange={outline.onChange} labels={{ point: labels.point || "Point", addPoint: labels.addPoint || "Add point" }} />}
      </div>
      {loading && source && <div className="building-model-pdf-loading" role="status">{labels.loading} {page}…</div>}
      {error && <div className="building-model-pdf-error" role="alert">{error}</div>}
    </div>
  );
}
