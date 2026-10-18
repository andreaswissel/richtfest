import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Box, Layers, LocateFixed, Minus, Plus, X } from "lucide-react";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { WorkbenchTool } from "../ui/workbench-tool";
import { discoveryPolygons, type BerlinParcel, type BerlinPlan, type BerlinSiteContext, type SiteDiscovery } from "./site-lookups";

type Point = [number, number];
type Bounds = [number, number, number, number];
type View = { cx: number; cy: number; half: number };
type Range = { mean: number; max: number };
/** What the map knows about one parcel: observed ratios, covering plans and the § 34 frame of its neighbours. */
export type ParcelFacts = { grz: number | null; gfz: number | null; plans: BerlinPlan[]; frame: { grz: Range | null; gfz: Range | null; count: number } };
const FRAME_RADIUS_M = 100;
type LayerKey = "aerial" | "plans" | "buildings" | "labels";
/** Must match the server's orthophoto window (AERIAL_WINDOW_M / AERIAL_SNAP_M in the feasibility app). */
const AERIAL_WINDOW_M = 200, AERIAL_SNAP_M = 25;
const MIN_HALF = 12, MAX_HALF = AERIAL_WINDOW_M;
const ATTRIBUTION = "Geoportal Berlin / TrueDOP 2024, ALKIS, B-Plan · dl-de/zero-2-0";

/** SVG path in metres relative to `o` (y down): browsers draw SVG in 32-bit floats, too coarse for raw UTM values. */
const path = (polygons: Point[][][], o: Point) => polygons.map(polygon => polygon.map(ring => ring.map((p, i) => `${i ? "L" : "M"}${(p[0] - o[0]).toFixed(2)},${(o[1] - p[1]).toFixed(2)}`).join(" ") + " Z").join(" ")).join(" ");
const boundsOf = (polygons: Point[][][], into: Bounds = [Infinity, Infinity, -Infinity, -Infinity]): Bounds => {
  for (const polygon of polygons) for (const [x, y] of polygon[0] ?? []) { into[0] = Math.min(into[0], x); into[1] = Math.min(into[1], y); into[2] = Math.max(into[2], x); into[3] = Math.max(into[3], y); }
  return into;
};
/** Area-weighted centroid of the largest outer ring; good enough to place a label on a parcel. */
const labelPoint = (polygons: Point[][][]): Point | null => {
  let best: { area: number; point: Point } | null = null;
  for (const polygon of polygons) {
    const ring = polygon[0] ?? [];
    let a = 0, x = 0, y = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i]!, [x1, y1] = ring[i + 1]!, f = x0 * y1 - x1 * y0;
      a += f; x += (x0 + x1) * f; y += (y0 + y1) * f;
    }
    if (Math.abs(a) > (best?.area ?? 0)) best = { area: Math.abs(a), point: [x / (3 * a), y / (3 * a)] };
  }
  return best?.point ?? null;
};
const inside = (polygons: Point[][][], point: Point) => polygons.some(polygon => {
  const ring = polygon[0] ?? [];
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
});

/**
 * Parcel map for the Site step, in the spirit of the 3D location viewer: Berlin TrueDOP orthophoto underneath,
 * ALKIS parcels labelled with their number and observed GRZ/GFZ, B-Plan areas by name and nearby building
 * footprints. Selecting a parcel opens its record on the left; adopting it stays an explicit action.
 */
export function SiteParcelMap({ projectId, context, discovery, selected, adoptedId, onSelect, renderPanel }: {
  projectId: string;
  context: BerlinSiteContext;
  discovery?: SiteDiscovery;
  selected?: string;
  adoptedId?: string;
  onSelect: (id: string | undefined) => void;
  renderPanel: (parcel: BerlinParcel, facts: ParcelFacts) => ReactNode;
}) {
  const t = useT();
  const label = (key: string) => t(`berlinMap${key}` as Parameters<typeof t>[0]);
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([800, 480]);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ aerial: true, plans: true, buildings: true, labels: true });
  const [aerialFailed, setAerialFailed] = useState(false);
  const fit = useMemo(() => {
    const own = context.parcels.filter(p => p.containsAddress);
    const b = boundsOf((own.length ? own : context.parcels).flatMap(p => p.polygons));
    if (!Number.isFinite(b[0])) return { cx: context.origin[0], cy: context.origin[1], half: 60 };
    // Frame the address parcel with its neighbours around it.
    return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, half: Math.min(MAX_HALF, Math.max(45, Math.max(b[2] - b[0], b[3] - b[1]) * 2.2)) };
  }, [context]);
  const [view, setView] = useState<View>(fit);
  useEffect(() => { setView(fit); setAerialFailed(false); }, [fit]);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => { const r = entry!.contentRect; if (r.width && r.height) setSize([r.width, r.height]); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [w, h] = size;
  const m = (2 * view.half) / w; // metres per CSS pixel
  const snap = (v: number) => Math.round(v / AERIAL_SNAP_M) * AERIAL_SNAP_M;
  const aerial: Point = useMemo(() => [snap(context.origin[0]), snap(context.origin[1])], [context.origin[0], context.origin[1]]);
  const lx = (x: number) => x - aerial[0], ly = (y: number) => aerial[1] - y;
  const viewBox = [lx(view.cx) - view.half, ly(view.cy) - (view.half * h) / w, 2 * view.half, (2 * view.half * h) / w];
  const clampView = (next: View): View => {
    const half = Math.min(MAX_HALF, Math.max(MIN_HALF, next.half)), limit = AERIAL_WINDOW_M * 1.5;
    return { half, cx: Math.min(aerial[0] + limit, Math.max(aerial[0] - limit, next.cx)), cy: Math.min(aerial[1] + limit, Math.max(aerial[1] - limit, next.cy)) };
  };
  const zoom = (factor: number, at?: Point) => setView(v => {
    const half = Math.min(MAX_HALF, Math.max(MIN_HALF, v.half * factor)), k = half / v.half, [ax, ay] = at ?? [v.cx, v.cy];
    return clampView({ half, cx: ax + (v.cx - ax) * k, cy: ay + (v.cy - ay) * k });
  });

  // Pan with a drag on the map; a press without movement still selects the parcel under the pointer.
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean; parcel: string | null } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    // Read the parcel now: pointer capture retargets the release to the SVG root.
    const parcel = (event.target as Element).closest?.("[data-parcel]")?.getAttribute("data-parcel") ?? null;
    drag.current = { x: event.clientX, y: event.clientY, view, moved: false, parcel };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.x, dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    setView(clampView({ ...d.view, cx: d.view.cx - dx * m, cy: d.view.cy + dy * m }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) onSelect(d.parcel ?? undefined);
  };
  useEffect(() => {
    const el = frame.current?.querySelector("svg");
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      setView(v => {
        const mm = (2 * v.half) / rect.width;
        const at: Point = [v.cx - v.half + (event.clientX - rect.left) * mm, v.cy + (v.half * rect.height) / rect.width - (event.clientY - rect.top) * mm];
        const half = Math.min(MAX_HALF, Math.max(MIN_HALF, v.half * Math.exp(event.deltaY * 0.0015))), k = half / v.half;
        return clampView({ half, cx: at[0] + (v.cx - at[0]) * k, cy: at[1] + (v.cy - at[1]) * k });
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const ratios = useMemo(() => {
    const byParcel = new Map<string, { grz: number | null; gfz: number | null }>();
    for (const r of discovery?.references ?? []) if (r.parcelId && !byParcel.has(r.parcelId))
      byParcel.set(r.parcelId, { grz: r.metrics?.grz?.value ?? null, gfz: r.metrics?.gfz?.value ?? null });
    return byParcel;
  }, [discovery]);
  const buildings = useMemo(() => discovery ? discovery.buildings.map(b => ({ id: b.id, d: path(discoveryPolygons(discovery, b), aerial) })) : [], [discovery, aerial]);
  const parcels = useMemo(() => context.parcels.map(p => ({ parcel: p, d: path(p.polygons, aerial), at: labelPoint(p.polygons), bounds: boundsOf(p.polygons) })), [context, aerial]);
  const plans = useMemo(() => context.plans.filter(p => p.polygons?.length).map(p => ({ plan: p, d: path(p.polygons!, aerial), bounds: boundsOf(p.polygons!) })), [context, aerial]);
  const visible: Bounds = [view.cx - view.half, view.cy - (view.half * h) / w, view.cx + view.half, view.cy + (view.half * h) / w];
  const px = (n: number) => n * m;
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const chosen = context.parcels.find(p => p.id === selected);
  const facts = (parcel: BerlinParcel): ParcelFacts => {
    const at = labelPoint(parcel.polygons);
    // § 34 comparison: observed ratios of the other parcels within 100 m, as Assetfy's "rechnerische Werte".
    const near = at ? parcels.filter(p => p.parcel.id !== parcel.id && p.at && Math.hypot(p.at[0] - at[0], p.at[1] - at[1]) <= FRAME_RADIUS_M).map(p => ratios.get(p.parcel.id)).filter(r => r?.grz != null) : [];
    const range = (values: number[]): Range | null => values.length ? { mean: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) } : null;
    return {
      ...(ratios.get(parcel.id) ?? { grz: null, gfz: null }),
      plans: at ? context.plans.filter(p => p.polygons && inside(p.polygons, at)) : [],
      frame: { grz: range(near.map(r => r!.grz!)), gfz: range(near.flatMap(r => r!.gfz != null ? [r!.gfz] : [])), count: near.length },
    };
  };
  // A scale bar of a round length about a sixth of the map width.
  const scale = [5, 10, 20, 25, 50, 100, 200].find(s => s / m >= w / 8) ?? 200;
  const toggle = (key: LayerKey) => setLayers(l => ({ ...l, [key]: !l[key] }));

  return <div className="site-map" ref={frame}>
    <svg role="img" aria-label={label("Title")} viewBox={viewBox.join(" ")} preserveAspectRatio="xMidYMid meet"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; }}
      data-aerial={layers.aerial && !aerialFailed}>
      {layers.aerial && !aerialFailed && <image href={`/api/feasibility/projects/${projectId}/aerial?e=${aerial[0]}&n=${aerial[1]}`}
        x={-AERIAL_WINDOW_M} y={-AERIAL_WINDOW_M} width={AERIAL_WINDOW_M * 2} height={AERIAL_WINDOW_M * 2}
        preserveAspectRatio="none" onError={() => setAerialFailed(true)} />}
      {layers.buildings && buildings.map(b => <path key={b.id} className="site-map-building" d={b.d} />)}
      {layers.plans && plans.map(({ plan, d }) => <path key={plan.id} className="site-map-plan" data-status={plan.status} d={d}><title>{plan.name}</title></path>)}
      {parcels.map(({ parcel, d }) => <path key={parcel.id} className="site-map-parcel" d={d} data-parcel={parcel.id}
        data-selected={selected === parcel.id} data-adopted={adoptedId === parcel.id} data-address={parcel.containsAddress}>
        <title>{parcel.label}</title>
      </path>)}
      {layers.labels && parcels.map(({ parcel, at, bounds }) => {
        // Only label parcels that are large enough on screen to carry text.
        if (!at || (bounds[2] - bounds[0]) / m < 46 || (bounds[3] - bounds[1]) / m < 30) return null;
        const r = ratios.get(parcel.id), small = (bounds[2] - bounds[0]) / m < 90;
        return <text key={parcel.id} className="site-map-label" x={lx(at[0])} y={ly(at[1])} fontSize={px(12)} data-selected={selected === parcel.id}>
          <tspan x={lx(at[0])} fontWeight={600}>{parcel.number || parcel.label}</tspan>
          {!small && r?.grz != null && <tspan x={lx(at[0])} dy={px(14)} fontSize={px(11)}>GRZ {fmt(r.grz)}{r.gfz != null ? ` · GFZ ${fmt(r.gfz)}` : ""}</tspan>}
        </text>;
      })}
      {layers.plans && layers.labels && plans.map(({ plan, bounds }) => {
        // Name each plan area once, at the centre of its visible part.
        const x0 = Math.max(bounds[0], visible[0]), x1 = Math.min(bounds[2], visible[2]), y0 = Math.max(bounds[1], visible[1]), y1 = Math.min(bounds[3], visible[3]);
        if (x1 - x0 < px(80) || y1 - y0 < px(24)) return null;
        return <text key={plan.id} className="site-map-plan-label" x={lx((x0 + x1) / 2)} y={ly(y1 - px(18))} fontSize={px(12)}>
          {plan.name}{plan.status === "adopted" ? "" : ` · ${label("PlanDraft")}`}
        </text>;
      })}
      <circle className="site-map-address" cx={lx(context.origin[0])} cy={ly(context.origin[1])} r={px(5)} />
    </svg>

    {chosen && <aside className="site-map-panel" aria-label={label("Selected")}>
      <div className="site-map-panel-head">
        <div>
          <p className="muted text-ui-2xs">{chosen.district || label("Parcel")}</p>
          <h4 className="text-ui-lg font-semibold">{label("Parcel")} {chosen.number || chosen.label}</h4>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={t("close")} onClick={() => onSelect(undefined)}><X className="size-icon-sm" /></Button>
      </div>
      {renderPanel(chosen, facts(chosen))}
    </aside>}

    <div className="site-map-controls">
      <div className="site-map-control-group">
        <WorkbenchTool tooltipSide="left" label={label("ZoomIn")} onClick={() => zoom(1 / 1.5)}><Plus className="size-icon-sm" /></WorkbenchTool>
        <WorkbenchTool tooltipSide="left" label={label("ZoomOut")} onClick={() => zoom(1.5)}><Minus className="size-icon-sm" /></WorkbenchTool>
        <WorkbenchTool tooltipSide="left" label={label("Fit")} onClick={() => setView(fit)}><LocateFixed className="size-icon-sm" /></WorkbenchTool>
      </div>
      <div className="site-map-control-group">
        <Popover>
          <PopoverTrigger asChild><WorkbenchTool tooltipSide="left" label={label("Layers")}><Layers className="size-icon-sm" /></WorkbenchTool></PopoverTrigger>
          <PopoverContent side="left" align="start" className="site-map-layers w-56">
            <p className="text-ui-sm font-medium">{label("Layers")}</p>
            {(["aerial", "plans", "buildings", "labels"] as const).map(key => <label key={key} className="site-map-layer text-ui-sm">
              <span>{label(`Layer_${key}`)}{key === "buildings" && !discovery && <span className="muted text-ui-2xs"> · {label("BuildingsAfterDiscovery")}</span>}</span>
              <Switch checked={layers[key]} onCheckedChange={() => toggle(key)} />
            </label>)}
          </PopoverContent>
        </Popover>
        <Link className="workbench-tool" to={`/projects/${projectId}?view=location`} aria-label={label("Open3d")} title={label("Open3d")}><Box className="size-icon-sm" /></Link>
      </div>
    </div>

    <div className="site-map-scale text-ui-2xs" aria-hidden="true"><span style={{ width: scale / m }} />{scale} m</div>
    <p className="site-map-attribution text-ui-2xs">{aerialFailed && layers.aerial ? `${label("AerialUnavailable")} · ` : ""}{ATTRIBUTION}</p>
  </div>;
}
