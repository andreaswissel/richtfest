import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from "../ui/context-menu";
import type { BuildingPlanPoint } from "./types";
import type { OutlineDraft } from "./outline-geometry";

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const ringPath = (ring: BuildingPlanPoint[]) => `M${ring.map((point) => `${(point.x * 1000).toFixed(2)} ${(point.y * 1000).toFixed(2)}`).join("L")}Z`;

/** Path-edit overlay for one room outline in normalized page coordinates. Points are
 * real buttons: drag them, nudge with arrow keys, remove with Delete; midpoints insert.
 * Right-click a point or edge for the same actions in a context menu. */
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
  const [menu, setMenu] = useState<{ kind: "point"; index: number } | { kind: "edge"; index: number; point: BuildingPlanPoint }>();
  const menuFocus = useRef<number | undefined>(undefined);
  const t = useT();
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
    // preventDefault keeps the button from taking focus; focus it so Delete and the arrows act on the point just grabbed.
    handles.current.get(index)?.focus({ preventScroll: true });
    setFocusIndex(index);
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

  const removePoint = (index: number) => {
    const polygon = latest.current.polygon;
    if (polygon.length <= 3) return;
    onBegin();
    onChange({ ...latest.current, polygon: polygon.filter((_, i) => i !== index) });
    setFocusIndex(Math.min(index, polygon.length - 2));
  };
  const insertPoint = (index: number, point: BuildingPlanPoint) => {
    const polygon = latest.current.polygon;
    onBegin();
    onChange({ ...latest.current, polygon: [...polygon.slice(0, index + 1), point, ...polygon.slice(index + 1)] });
  };
  /** Nearest point on edge `index` to the cursor, so "Add point" lands where the user right-clicked. */
  const pointOnEdge = (index: number, event: React.MouseEvent) => {
    const polygon = latest.current.polygon, a = polygon[index]!, b = polygon[(index + 1) % polygon.length]!;
    const { x, y } = toPoint(event), dx = b.x - a.x, dy = b.y - a.y;
    const along = Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return { x: a.x + dx * along, y: a.y + dy * along };
  };

  const onKey = (index: number, event: React.KeyboardEvent) => {
    const polygon = latest.current.polygon;
    if ((event.key === "Delete" || event.key === "Backspace") && polygon.length > 3) {
      event.preventDefault();
      removePoint(index);
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
    <ContextMenu onOpenChange={(open) => { if (!open) setMenu(undefined); }}>
    <ContextMenuTrigger asChild>
    <div ref={layer} className="building-model-outline-editor" style={style}>
      <svg className="building-model-outline-editor-shape" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        <path d={[polygon, ...holes].map(ringPath).join("")} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
      </svg>
      {edges && <svg className="building-model-outline-editor-edges" viewBox="0 0 1000 1000" preserveAspectRatio="none">
        {polygon.map((point, index) => {
          const next = polygon[(index + 1) % polygon.length]!;
          return <line key={`edge-${index}`} className={active === -1 - index ? "is-active" : undefined} x1={point.x * 1000} y1={point.y * 1000} x2={next.x * 1000} y2={next.y * 1000} vectorEffect="non-scaling-stroke"
            onPointerDown={(event) => { if (event.button === 0) dragEdge(index, event); }}
            onContextMenu={(event) => setMenu({ kind: "edge", index, point: pointOnEdge(index, event) })}><title>{labels.edge ?? labels.point}</title></line>;
        })}
      </svg>}
      {polygon.map((point, index) => {
        const next = polygon[(index + 1) % polygon.length]!;
        const mid = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
        return <button key={`mid-${index}`} type="button" tabIndex={-1} className="building-model-outline-midpoint" style={{ left: `${mid.x * 100}%`, top: `${mid.y * 100}%` }}
          aria-label={labels.addPoint} title={labels.addPoint}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            insertPoint(index, mid);
            drag(index + 1, event);
          }}
          onContextMenu={() => setMenu({ kind: "edge", index, point: mid })} />;
      })}
      {polygon.map((point, index) => (
        <button key={`point-${index}`} ref={(node) => { if (node) handles.current.set(index, node); else handles.current.delete(index); }} type="button"
          className={`building-model-outline-handle${active === index ? " is-active" : ""}`} style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          aria-label={`${labels.point} ${index + 1}`} onFocus={() => setFocusIndex(index)}
          onPointerDown={(event) => { if (event.button !== 0) return; onBegin(); drag(index, event); }} onKeyDown={(event) => onKey(index, event)}
          onContextMenu={() => { handles.current.get(index)?.focus({ preventScroll: true }); setMenu({ kind: "point", index }); }} />
      ))}
    </div>
    </ContextMenuTrigger>
    {menu && <ContextMenuContent onCloseAutoFocus={(event) => {
      // Return focus to the point the menu acted on, so Delete keeps editing the outline instead of removing the whole shape.
      event.preventDefault();
      handles.current.get(menuFocus.current ?? menu.index)?.focus({ preventScroll: true });
      menuFocus.current = undefined;
    }}>
      {menu.kind === "point" ? (
        <ContextMenuItem variant="destructive" disabled={polygon.length <= 3} onSelect={() => { menuFocus.current = Math.min(menu.index, polygon.length - 2); removePoint(menu.index); }}>
          <Trash2 aria-hidden="true" />{t("outlineDeletePoint")}<ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onSelect={() => { menuFocus.current = menu.index + 1; insertPoint(menu.index, menu.point); }}>
          <Plus aria-hidden="true" />{t("outlineAddPoint")}
        </ContextMenuItem>
      )}
    </ContextMenuContent>}
    </ContextMenu>
  );
}
