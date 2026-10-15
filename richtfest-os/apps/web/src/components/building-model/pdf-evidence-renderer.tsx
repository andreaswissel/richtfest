import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import { candidateRole, type BuildingEvidence, type BuildingGeometryPart, type BuildingRegion, type PdfEvidenceLayer } from "./types";

export type PdfViewerTransform = { zoom: number; pan: { x: number; y: number } };

/** Render an extracted footprint relative to its normalized bounding box. */
export function polygonClipPath(region: Pick<BuildingRegion, "box" | "polygon" | "geometryQuality">) {
  if (region.geometryQuality === "anchor" || !region.box || !region.polygon?.length || region.box.width <= 0 || region.box.height <= 0) return undefined;
  const points = region.polygon.map((point) => `${(((point.x - region.box!.x) / region.box!.width) * 100).toFixed(2)}% ${(((point.y - region.box!.y) / region.box!.height) * 100).toFixed(2)}%`);
  return `polygon(${points.join(", ")})`;
}
export function regionOverlayStyle(region: Pick<BuildingRegion, "box">): CSSProperties | undefined {
  return region.box ? { left: `${region.box.x * 100}%`, top: `${region.box.y * 100}%`, width: `${region.box.width * 100}%`, height: `${region.box.height * 100}%` } : undefined;
}

export function partOverlayStyle(part: BuildingGeometryPart, parentBox?: BuildingRegion["box"]): CSSProperties | undefined {
  if (!part.box || !parentBox || parentBox.width <= 0 || parentBox.height <= 0) return undefined;
  return { left: `${((part.box.x - parentBox.x) / parentBox.width) * 100}%`, top: `${((part.box.y - parentBox.y) / parentBox.height) * 100}%`, width: `${(part.box.width / parentBox.width) * 100}%`, height: `${(part.box.height / parentBox.height) * 100}%` };
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
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [internalZoom, setInternalZoom] = useState(1);
  const [internalPan, setInternalPan] = useState({ x: 0, y: 0 });
  const zoom = transform?.zoom ?? internalZoom;
  const pan = transform?.pan ?? internalPan;
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  const pdfRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);
  const source = evidence.pdfUrl || (evidence.fileId
    ? `/api/projects/${projectId}/files/${evidence.fileId}/versions/${evidence.version || 1}/download`
    : undefined);

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
        <div className="building-model-region-layer" aria-label={labels.region}>
          {regions.filter((region) => region.page === page).map((region) => {
            const role = region.isCandidate ? region.candidateRole || candidateRole(region) : undefined;
            const candidateClass = role === "draft-wall" ? "draft-wall" : role === "raw-footprint" ? "footprint" : role === "construction-assembly" ? "assembly" : region.isCandidate && (region.geometryQuality === "approximate_partition" || region.geometryQuality === "approximate_region") ? "approximate" : region.isCandidate ? "anchor" : "";
            return (
            <button key={region.id} type="button" className={`building-model-region ${region.kind} ${region.isCandidate ? "candidate" : ""} ${candidateClass} ${selectedId === region.id ? "selected" : ""}`} style={regionOverlayStyle(region)} onClick={() => onSelect(region.id)} aria-pressed={selectedId === region.id} aria-label={`${region.label} · ${role || region.kind}`}>
              {region.isCandidate && region.parts?.length ? region.parts.map((part, index) => <span key={`${region.id}-part-${index}`} className="building-model-region-shape" style={{ ...partOverlayStyle(part, region.box), clipPath: polygonClipPath({ box: part.box, polygon: part.polygon, geometryQuality: "assembly" }) }} aria-hidden="true" />) : region.isCandidate && polygonClipPath(region) ? <span className="building-model-region-shape" style={{ clipPath: polygonClipPath(region) }} aria-hidden="true" /> : null}
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
