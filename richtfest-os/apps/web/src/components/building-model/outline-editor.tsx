import { useEffect, useRef, useState } from "react";
import type { BuildingPlanPoint } from "./types";
import type { OutlineDraft } from "./outline-geometry";

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const ringPath = (ring: BuildingPlanPoint[]) => `M${ring.map((point) => `${(point.x * 1000).toFixed(2)} ${(point.y * 1000).toFixed(2)}`).join("L")}Z`;

/** Path-edit overlay for one room outline in normalized page coordinates. Points are
 * real buttons: drag them, nudge with arrow keys, remove with Delete; midpoints insert. */
export function OutlineEditorLayer({ draft, onBegin, onChange, labels, style, snap = true, edges = false }: {
  draft: OutlineDraft;
  /** Drag an edge to move that whole flank parallel to itself; both corners follow. */
  edges?: boolean;
  /** Snap dragged points to a neighbour's wall line; Alt always turns snapping off. */
  snap?: boolean;
  style?: React.CSSProperties;
  /** Called once before each change so the parent can record undo history. */
  onBegin: () => void;
  onChange: (draft: OutlineDraft) => void;
  labels: { point: string; addPoint: string; edge?: string };
}) {
  const layer = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<number, HTMLButtonElement>());
  const latest = useRef(draft);
  latest.current = draft;
  const [active, setActive] = useState<number>();
  const [focusIndex, setFocusIndex] = useState<number>();
  useEffect(() => { if (focusIndex !== undefined) handles.current.get(focusIndex)?.focus({ preventScroll: true }); }, [focusIndex, draft.polygon.length]);

  const toPoint = (event: { clientX: number; clientY: number }) => {
    const bounds = layer.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height), bounds };
  };
  const setPoint = (index: number, point: BuildingPlanPoint) =>
    onChange({ ...latest.current, polygon: latest.current.polygon.map((current, i) => i === index ? point : current) });

  const drag = (index: number, start: React.PointerEvent) => {
    start.preventDefault();
    start.stopPropagation();
    setActive(index);
    const move = (event: PointerEvent) => {
      const { x, y, bounds } = toPoint(event);
      const polygon = latest.current.polygon, count = polygon.length;
      const neighbours = [polygon[(index + count - 1) % count]!, polygon[(index + 1) % count]!];
      // Snap to a neighbour's wall line within 6 px so rectilinear rooms stay square; Alt turns snapping off.
      let snapped = { x, y };
      if (snap && !event.altKey) for (const neighbour of neighbours) {
        if (Math.abs(neighbour.x - x) * bounds.width < 6) snapped = { ...snapped, x: neighbour.x };
        if (Math.abs(neighbour.y - y) * bounds.height < 6) snapped = { ...snapped, y: neighbour.y };
      }
      setPoint(index, snapped);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setActive(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  /** Moves edge `index` (point index → index + 1) along its normal, measured in screen pixels so the plan's aspect ratio does not skew it. */
  const dragEdge = (index: number, start: React.PointerEvent) => {
    start.preventDefault();
    start.stopPropagation();
    onBegin();
    const base = latest.current.polygon, count = base.length, a = base[index]!, b = base[(index + 1) % count]!;
    const origin = toPoint(start), w = origin.bounds.width, h = origin.bounds.height;
    const ex = (b.x - a.x) * w, ey = (b.y - a.y) * h, length = Math.hypot(ex, ey) || 1, nx = -ey / length, ny = ex / length;
    setActive(-1 - index);
    const move = (event: PointerEvent) => {
      const bounds = layer.current!.getBoundingClientRect();
      const d = (event.clientX - start.clientX) * nx + (event.clientY - start.clientY) * ny;
      const shift = (p: BuildingPlanPoint) => ({ x: clamp(p.x + (d * nx) / bounds.width), y: clamp(p.y + (d * ny) / bounds.height) });
      onChange({ ...latest.current, polygon: base.map((p, i) => (i === index || i === (index + 1) % count ? shift(p) : p)) });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setActive(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const onKey = (index: number, event: React.KeyboardEvent) => {
    const polygon = latest.current.polygon;
    if ((event.key === "Delete" || event.key === "Backspace") && polygon.length > 3) {
      event.preventDefault();
      onBegin();
      onChange({ ...latest.current, polygon: polygon.filter((_, i) => i !== index) });
      setFocusIndex(Math.min(index, polygon.length - 2));
      return;
    }
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[event.key];
    if (!step || !layer.current) return;
    event.preventDefault();
    const bounds = layer.current.getBoundingClientRect(), pixels = event.shiftKey ? 10 : 1, point = polygon[index]!;
    onBegin();
    setPoint(index, { x: clamp(point.x + step[0] * pixels / bounds.width), y: clamp(point.y + step[1] * pixels / bounds.height) });
  };

  const { polygon, holes } = draft;
  return (
    <div ref={layer} className="building-model-outline-editor" style={style}>
      <svg className="building-model-outline-editor-shape" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        <path d={[polygon, ...holes].map(ringPath).join("")} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
      </svg>
      {edges && <svg className="building-model-outline-editor-edges" viewBox="0 0 1000 1000" preserveAspectRatio="none">
        {polygon.map((point, index) => {
          const next = polygon[(index + 1) % polygon.length]!;
          return <line key={`edge-${index}`} className={active === -1 - index ? "is-active" : undefined} x1={point.x * 1000} y1={point.y * 1000} x2={next.x * 1000} y2={next.y * 1000} vectorEffect="non-scaling-stroke"
            onPointerDown={(event) => dragEdge(index, event)}><title>{labels.edge ?? labels.point}</title></line>;
        })}
      </svg>}
      {polygon.map((point, index) => {
        const next = polygon[(index + 1) % polygon.length]!;
        const mid = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
        return <button key={`mid-${index}`} type="button" tabIndex={-1} className="building-model-outline-midpoint" style={{ left: `${mid.x * 100}%`, top: `${mid.y * 100}%` }}
          aria-label={labels.addPoint} title={labels.addPoint}
          onPointerDown={(event) => {
            onBegin();
            onChange({ ...latest.current, polygon: [...polygon.slice(0, index + 1), mid, ...polygon.slice(index + 1)] });
            drag(index + 1, event);
          }} />;
      })}
      {polygon.map((point, index) => (
        <button key={`point-${index}`} ref={(node) => { if (node) handles.current.set(index, node); else handles.current.delete(index); }} type="button"
          className={`building-model-outline-handle${active === index ? " is-active" : ""}`} style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          aria-label={`${labels.point} ${index + 1}`} onFocus={() => setFocusIndex(index)}
          onPointerDown={(event) => { onBegin(); drag(index, event); }} onKeyDown={(event) => onKey(index, event)} />
      ))}
    </div>
  );
}
