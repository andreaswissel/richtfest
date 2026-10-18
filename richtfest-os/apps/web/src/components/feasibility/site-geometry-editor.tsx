import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { create } from "zustand";
import {
  ArrowLeftRight,
  Ban,
  BookmarkPlus,
  Box,
  Building2,
  Check,
  CircleHelp,
  Eye,
  EyeOff,
  Hand,
  Layers,
  Map as MapIcon,
  Minus,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Slash,
  Plus,
  Redo2,
  Scan,
  SquareDashed,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  LocationContext,
  LocationState,
  LocationBuilding,
  SiteAssessmentInput,
} from "@richtfest/shared";
import type { SetbackAreaCheck } from "@richtfest/shared/site-geometry";
import {
  createEmptySiteGeometryInput,
  siteGeometryInputSchema,
  type SiteGeometryInput,
  type BuildingGeometry,
  type GeometryEvidence,
  type GeometryMultiPolygon,
  type GeometryPoint,
  type SiteGeometryResult,
  type MassingCandidate,
  type MassingOptions,
} from "@richtfest/shared/site-geometry-model";
import { useApi } from "../../query";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DateInput } from "../ui/date-input";
import { Input } from "../ui/input";
import { Badge, Callout, Field, Segmented } from "../ui/primitives";
import { ResizeHandle } from "../ui/resize-handle";
import { NativeSelect } from "../ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { WorkbenchTool } from "../ui/workbench-tool";
import { OutlineEditorLayer } from "../building-model/outline-editor";
import { fromLocal, toLocal } from "../location/site-geometry";
import type { createViewport, ViewportState } from "../location/viewport";
import "./site-geometry-editor.css";
import { SitePlanAlignment, usePlanRaster } from "./site-plan-overlay";
import { TRACED_LINE_PREFIX } from "./plan-lines";
import { containsPoint, useBerlinContext, type BerlinParcel } from "./site-lookups";

type Engine = typeof import("@richtfest/shared/site-geometry");
type SelectionKind = "parcel" | "line" | "envelope" | "exclusion" | "building" | "staffel" | "edge";
type Selection = { kind: SelectionKind; id: string } | null;
type Tool = "pan" | "select" | "line" | "envelope" | "exclusion" | "building" | "staffel" | "edge" | "reference";
type T = ReturnType<typeof useT>;
type Key = Parameters<T>[0];
const DRAW_TOOLS: Tool[] = ["envelope", "line", "exclusion", "building", "staffel"];
const HISTORY_LIMIT = 50;

const evidence = (label: string, ring: GeometryPoint[]): GeometryEvidence => ({
  id: crypto.randomUUID(),
  label,
  geometry: [[ring]],
  source: "",
  sourceDate: null,
  reviewed: false,
});
const closeRing = (points: GeometryPoint[]) => [...points, points[0]!] as GeometryPoint[];
const pathFor = (geometry: GeometryMultiPolygon, project: (p: GeometryPoint) => GeometryPoint) =>
  geometry
    .map((polygon) => polygon.map((ring) => ring.map((p, i) => `${i ? "L" : "M"}${project(p).join(",")}`).join(" ") + "Z").join(" "))
    .join(" ");

/** Tool names that earlier drafts stored as object names; shown as numbered object names instead. */
const LEGACY_TOOL_LABELS = new Set([
  "", "Place building", "Gebäude platzieren", "Trace envelope", "Baufenster zeichnen", "Trace exclusion", "Ausschlussfläche zeichnen",
  "Trace upper storey", "Staffelgeschoss zeichnen", "Trace mandatory building line", "Baulinie zeichnen",
]);
export const displayName = (label: string | undefined, fallback: string) =>
  !label || LEGACY_TOOL_LABELS.has(label.trim()) ? fallback : label;

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
/** Parcel edges are named by the direction they face and their length, so issues and setbacks stay recognisable. */
export function parcelEdgeNames(parcel: GeometryEvidence | null, t: T, format: (n: number) => string) {
  const names = new Map<string, string>();
  if (!parcel) return names;
  const raw: { key: string; direction: string; length: string }[] = [];
  parcel.geometry.forEach((polygon, pi) =>
    polygon.forEach((ring, ri) => {
      const vertices = ring.slice(0, -1);
      const cx = vertices.reduce((s, p) => s + p[0], 0) / vertices.length;
      const cy = vertices.reduce((s, p) => s + p[1], 0) / vertices.length;
      vertices.forEach((p, ei) => {
        const q = ring[ei + 1]!;
        const angle = Math.atan2((p[0] + q[0]) / 2 - cx, (p[1] + q[1]) / 2 - cy);
        const direction = COMPASS[(Math.round(angle / (Math.PI / 4)) + 8) % 8]!;
        raw.push({ key: `${pi}-${ri}-${ei}`, direction, length: format(Math.hypot(q[0] - p[0], q[1] - p[1])) });
      });
    }),
  );
  for (const edge of raw) {
    const same = raw.filter((e) => e.direction === edge.direction);
    const suffix = same.length > 1 ? ` ${same.indexOf(edge) + 1}` : "";
    names.set(edge.key, t("siteGeometryEdgeName").replace("{direction}", t(`siteGeometryDir${edge.direction}` as Key) + suffix).replace("{length}", edge.length));
  }
  return names;
}

/** Explicit height describes the whole building, including its separate Staffel volumes. */
export function fullStoreyMeshHeight(building: BuildingGeometry) {
  const staffelHeight = building.staffel.reduce((sum, storey) => sum + storey.height, 0);
  return Math.max(building.fullStoreys * building.storeyHeight, (building.height ?? 0) - staffelHeight);
}

const translateRings = (g: GeometryMultiPolygon, dx: number, dy: number): GeometryMultiPolygon => g.map((p) => p.map((r) => r.map(([x, y]) => [x + dx, y + dy] as GeometryPoint)));
/** Moves a building with its Staffel; the moved footprint is new geometry and needs review again. */
export const translateBuilding = (b: BuildingGeometry, dx: number, dy: number): BuildingGeometry => ({
  ...b,
  footprint: { ...b.footprint, geometry: translateRings(b.footprint.geometry, dx, dy), reviewed: false },
  staffel: b.staffel.map((s) => ({ ...s, footprint: { ...s.footprint, geometry: translateRings(s.footprint.geometry, dx, dy), reviewed: false } })),
});

/** A round scale-bar length of roughly a fifth of the visible width. */
const scaleBar = (metresPerPixel: number, width: number) => {
  const target = (metresPerPixel * width) / 5;
  const power = 10 ** Math.floor(Math.log10(Math.max(target, 0.01)));
  const metres = [1, 2, 5, 10].map((m) => m * power).find((m) => m >= target * 0.7) ?? power * 10;
  return { metres, pixels: metres / metresPerPixel };
};

function useElementSize<E extends HTMLElement>() {
  const ref = useRef<E>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

type Viewport = ReturnType<typeof createViewport>;
type Local = (g: GeometryMultiPolygon) => GeometryPoint[][][];
/** 3D massing view: a map-style camera (drag pans, Ctrl/⌥-drag orbits), parcels, live Abstandsflächen, draw, move and extrude. */
function Geometry3D({ context, geometry, selected, parcels, setbacks, drawing, draft, editable, tool, viewport: handle, onSelect, onGround, onHover, onDrag, onFinish }: {
  context: LocationContext;
  geometry: SiteGeometryInput;
  selected: string | null;
  parcels: { items: { id: string; polygons: GeometryPoint[][][] }[]; selected: string | null };
  setbacks: SetbackAreaCheck[];
  drawing: { points: GeometryPoint[]; hover: GeometryPoint | null } | null;
  /** Footprint being drawn, previewed at its default height. */
  draft: { footprint: GeometryMultiPolygon; height: number } | null;
  editable: { id: string; height: number; label: string } | null;
  tool: "select" | "draw";
  viewport: React.MutableRefObject<Viewport | null>;
  onSelect: (id: string | null, ground?: GeometryPoint) => void;
  onGround: (point: GeometryPoint) => void;
  /** Double-click while drawing closes the outline (or ends a building line). */
  onFinish: () => void;
  onHover: (point: GeometryPoint | null) => void;
  onDrag: { begin: (id: string, kind: "move" | "extrude") => void; move: (id: string, kind: "move" | "extrude", value: GeometryPoint | number) => void };
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null),
    viewport = handle,
    handlers = useRef({ onSelect, onGround, onHover, onDrag, onFinish });
  handlers.current = { onSelect, onGround, onHover, onDrag, onFinish };
  const dark = usePreferences((s) => s.theme) === "dark";
  const [ready, setReady] = useState(false),
    [error, setError] = useState(false);
  const site = (point: GeometryPoint) => fromLocal(context, point);
  const siteRef = useRef(site);
  siteRef.current = site;
  useEffect(() => {
    let active = true;
    void import("../location/viewport").then(({ createViewport }) => {
      if (!active || !host.current) return;
      try {
        viewport.current = createViewport(host.current, {
          select: (id, ground) => handlers.current.onSelect(id, ground && siteRef.current(ground)),
          place: () => {},
          measure: () => {},
          align: () => {},
          ground: (point) => handlers.current.onGround(siteRef.current(point)),
          hover: (point) => handlers.current.onHover(point && siteRef.current(point)),
          drag: {
            begin: (id, kind) => handlers.current.onDrag.begin(id, kind),
            // Local Z points south; site Y points north.
            move: (id, kind, value) => handlers.current.onDrag.move(id, kind, typeof value === "number" ? value : [value[0], -value[1]]),
          },
        });
        host.current.addEventListener("dblclick", () => handlers.current.onFinish());
        setReady(true);
      } catch {
        setError(true);
      }
    });
    return () => {
      active = false;
      viewport.current?.dispose();
      viewport.current = null;
    };
  }, []);
  const local: Local = (g) => g.map((p) => p.map((r) => r.map((point) => toLocal(context, point))));
  const assessment = useMemo(() => {
    const items: NonNullable<ViewportState["assessment"]> = [];
    if (geometry.parcel) items.push({ id: "parcel", polygons: local(geometry.parcel.geometry), base: 0.05, height: 0, color: 0x64748b });
    if (geometry.envelope) items.push({ id: "envelope", polygons: local(geometry.envelope.geometry), base: 0.1, height: 0, color: 0x10b981 });
    geometry.exclusions.forEach((x) => items.push({ id: x.id, polygons: local(x.geometry), base: 0.15, height: 0, color: 0xef4444 }));
    // With a building selected, the others turn neutral so a footprint drawn inside another massing stays visible.
    const focus = geometry.buildings.find((b) => b.id === selected || b.staffel.some((st) => st.footprint.id === selected))?.id;
    geometry.buildings.forEach((b) => {
      const height = fullStoreyMeshHeight(b);
      const muted = !!focus && focus !== b.id;
      items.push({ id: b.id, polygons: local(b.footprint.geometry), base: 0.2, height, color: muted ? 0xcbd5e1 : focus ? 0x4f46e5 : 0x6366f1 });
      let base = height + 0.2;
      b.staffel.forEach((s) => {
        items.push({ id: s.footprint.id, polygons: local(s.footprint.geometry), base, height: s.height, color: muted ? 0xe2e8f0 : 0x818cf8 });
        base += s.height;
      });
    });
    if (draft) items.push({ id: "draft", polygons: local(draft.footprint), base: 0.2, height: draft.height, color: 0x94a3b8 });
    return items;
  }, [context, geometry, draft, selected]);
  const localParcels = useMemo(() => ({ items: parcels.items.map((p) => ({ id: p.id, polygons: local(p.polygons) })), selected: parcels.selected }), [context, parcels]);
  const localSetbacks = useMemo(() => setbacks.map((c) => ({ id: c.id, clear: local(c.clear), conflict: local(c.conflict) })), [context, setbacks]);
  const localDrawing = useMemo(() => drawing && { points: drawing.points.map((p) => toLocal(context, p)), hover: drawing.hover && toLocal(context, drawing.hover) }, [context, drawing]);
  const editableItem = useMemo(() => editable && { ...editable, base: 0.2 }, [editable?.id, editable?.height, editable?.label]);
  useEffect(() => {
    if (!ready || !viewport.current) return;
    viewport.current.update({
      context,
      assessment,
      parcels: localParcels,
      setbacks: localSetbacks,
      drawing: localDrawing,
      editable: editableItem,
      objects: [],
      models: {},
      layers: { buildings: true, trees: false, objects: true, lidar: false, roads: false, railNoise: false, plan: false, aerial: false },
      site: EMPTY_OVERLAY,
      selected,
      tool,
      treeStyle: "schematic",
      measurement: [],
      clipHeight: 200,
      dark,
      constructionLabel: "",
      projectExtentLabel: "",
      siteAddressLabel: "",
    });
  }, [context, assessment, localParcels, localSetbacks, localDrawing, editableItem, selected, tool, ready, dark]);
  // Opens over the plan's framing, then tilts into 3D so the switch reads as one continuous view.
  useEffect(() => {
    if (!ready || !viewport.current) return;
    const rings = geometry.parcel?.geometry.flat(2) ?? geometry.buildings.flatMap((b) => b.footprint.geometry.flat(2));
    const points = rings.map((p) => toLocal(context, p));
    const top = Math.max(0, ...geometry.buildings.map((b) => fullStoreyMeshHeight(b)));
    viewport.current.fit(points, "top", 0);
    const frame = requestAnimationFrame(() => viewport.current?.fit(points, "perspective", 700, top));
    return () => cancelAnimationFrame(frame);
  }, [ready]);
  return (
    <div className="geometry-3d" ref={host} role="region" aria-label={t("siteGeometry3D")}>
      {error && <Callout>{t("siteGeometryWebGLUnavailable")}</Callout>}
    </div>
  );
}
const NO_SETBACKS: SetbackAreaCheck[] = [];
const EMPTY_OVERLAY: ViewportState["site"] = { axes: [], plan: null, distances: [], railNoise: null, aerial: { near: null, far: null }, picks: [], snaps: [] };
/** Height used for setbacks: the whole building including Staffel, as the engine's "buildings" height source. */
/** Panel widths the user dragged to, in CSS pixels; view state only, kept while the app is open. */
type PanelWidths = { layers: number; inspector: number; massing: number };
const usePanelWidths = create<PanelWidths & { set: (patch: Partial<PanelWidths>) => void }>((set) => ({ layers: 224, inspector: 320, massing: 304, set: (patch) => set(patch) }));
export const buildingHeight = (b: BuildingGeometry) => Math.max(b.height ?? 0, b.fullStoreys * b.storeyHeight + b.staffel.reduce((h, s) => h + s.height, 0));
/** Without a 3D location scene, the massing view still works around the parcel on an empty ground. */
const emptyContext = (origin: GeometryPoint): LocationContext => ({
  siteId: "assessment", address: "", origin, longitude: 0, latitude: 0, crs: "EPSG:25833", radius: 200, buildings: [], trees: [], sources: [], importedAt: new Date(0).toISOString(),
});

export function SiteGeometryEditor({
  projectId,
  value,
  disabled,
  options,
  onChange,
  onReference,
  onUseArea,
  contextOverride,
  referenceBuildingIds = [],
  emptyAction,
  scenario = "baseline",
  onScenario,
  upsideMassing,
  upsideStoreys,
  onAdoptParcel,
  parcelArea,
  jurisdiction = "BE",
}: {
  projectId: string;
  value: SiteGeometryInput | null;
  disabled: boolean;
  options: MassingOptions | null;
  onChange: (v: SiteGeometryInput) => void;
  onReference?: (building: LocationBuilding, context: LocationContext) => void;
  contextOverride?: LocationContext | null;
  onUseArea?: (area: number) => void;
  /** Building ids already chosen as § 34 references, outlined on the plan. */
  referenceBuildingIds?: string[];
  /** Shown on the empty canvas before a parcel exists, e.g. a link to the parcel lookup. */
  emptyAction?: ReactNode;
  /** "upside" previews the exemption massing read-only; the design itself stays the baseline. */
  scenario?: "baseline" | "upside";
  onScenario?: (scenario: "baseline" | "upside") => void;
  /** Generated massing for the exemption scenario: undefined without a scenario, null when nothing fits. */
  upsideMassing?: { building: BuildingGeometry; grossFloorArea: number; countableFloorArea: number } | null;
  upsideStoreys?: number | null;
  /** Adopts a cadastral parcel picked on the map, including its area constraint; without it only the geometry changes. */
  onAdoptParcel?: (parcel: BerlinParcel) => void;
  /** Entered parcel area for GRZ/GFZ, as in the design check; the drawn parcel is the fallback. */
  parcelArea?: number | null;
  /** Landesbauordnung that sets the Staffel full-storey share. */
  jurisdiction?: string;
}) {
  const t = useT(),
    language = usePreferences((s) => s.language),
    label = (key: string) => t(`siteGeometry${key}` as Key);
  const widths = usePanelWidths();
  const location = useApi(`/projects/${projectId}/location`),
    context = contextOverride ?? (location.data as LocationState | undefined)?.context;
  // Cadastral parcels come from the Site step's lookup (shared query cache); the same locator keeps the key identical.
  const locator = (useApi(`/feasibility/projects/${projectId}/site-assessment`).data as { assessment?: { siteLocator?: SiteAssessmentInput["siteLocator"] } } | undefined)?.assessment?.siteLocator;
  const berlin = useBerlinContext(projectId, locator);
  const alkis = berlin.data?.parcels ?? [];
  const geometry = useMemo(() => {
    const parsed = siteGeometryInputSchema.safeParse(value);
    return parsed.success
      ? parsed.data
      : { ...createEmptySiteGeometryInput(), ...value, mandatoryLines: value?.mandatoryLines ?? [], planOverlay: value?.planOverlay ?? null };
  }, [value]);
  const [canvasRef, size] = useElementSize<HTMLDivElement>();
  const [frame, setFrame] = useState({ zoom: 1, x: 0, y: 0 });
  const panStart = useRef<{ clientX: number; clientY: number; frame: typeof frame; moved: boolean } | null>(null),
    panned = useRef(false);
  const planImage = usePlanRaster(projectId, geometry.planOverlay);
  const [pickingAlignment, setPickingAlignment] = useState(false),
    [pickedSite, setPickedSite] = useState<GeometryPoint | null>(null);
  const [engine, setEngine] = useState<Engine>(),
    [result, setResult] = useState<SiteGeometryResult>(),
    [candidates, setCandidates] = useState<MassingCandidate[]>([]),
    [selected, setSelected] = useState<Selection>(null),
    [tool, setTool] = useState<Tool>("select"),
    [points, setPoints] = useState<GeometryPoint[]>([]),
    [hover, setHover] = useState<GeometryPoint | null>(null),
    [view, setView] = useState("2d"),
    [tab, setTab] = useState("properties"),
    [panel, setPanel] = useState<"layers" | "inspector" | null>(null),
    [layers, setLayers] = useState({ context: true, plan: true, parcels: true, setbacks: true }),
    [parcelPick, setParcelPick] = useState<string | null>(null),
    [past, setPast] = useState<SiteGeometryInput[]>([]),
    [future, setFuture] = useState<SiteGeometryInput[]>([]);
  const format = (n: number, digits = 2) => n.toLocaleString(language === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: digits });
  const edgeNames = useMemo(() => parcelEdgeNames(geometry.parcel, t, (n) => format(n, 1)), [geometry.parcel, language]);
  const edgeName = (pi: number, ri: number, ei: number) => edgeNames.get(`${pi}-${ri}-${ei}`) ?? `${label("edge")} ${ei + 1}`;
  const buildingName = (b: BuildingGeometry, index: number) => displayName(b.label, label("ObjectBuilding").replace("{n}", String(index + 1)));
  const staffelName = (s: BuildingGeometry["staffel"][number], index: number) => displayName(s.footprint.label, label("ObjectStaffel").replace("{n}", String(index + 1)));
  const exclusionName = (e: GeometryEvidence, index: number) => displayName(e.label, label("ObjectExclusion").replace("{n}", String(index + 1)));
  const lineName = (l: { label: string }, index: number) => displayName(l.label, label("ObjectLine").replace("{n}", String(index + 1)));

  const selectedBuilding = geometry.buildings.find((b) => b.id === selected?.id || b.staffel.some((s) => s.footprint.id === selected?.id));
  const selectedEvidence =
    selected?.kind === "parcel" ? geometry.parcel
      : selected?.kind === "envelope" ? geometry.envelope
        : selected?.kind === "exclusion" ? geometry.exclusions.find((e) => e.id === selected.id)
          : selected?.kind === "building" ? selectedBuilding?.footprint
            : selected?.kind === "staffel" ? selectedBuilding?.staffel.find((s) => s.footprint.id === selected.id)?.footprint
              : null;
  const selectedLine = selected?.kind === "line" ? geometry.mandatoryLines.find((l) => l.id === selected.id) : null;
  const selectedStaffel = selected?.kind === "staffel" ? selectedBuilding?.staffel.find((s) => s.footprint.id === selected.id) : null;
  const selectedEdge = selected?.kind === "edge" ? geometry.setbacks.find((e) => e.id === selected.id) : null;
  const pickedParcel = alkis.find((p) => p.id === parcelPick && p.id !== geometry.parcel?.id) ?? null;
  useEffect(() => {
    void import("@richtfest/shared/site-geometry").then(setEngine);
  }, []);
  useEffect(() => {
    if (engine) {
      try {
        setResult(engine.calculateSiteGeometry(geometry));
      } catch {
        setResult(undefined);
      }
    }
    setCandidates([]);
  }, [engine, value]);
  useEffect(() => {
    setPast([]);
    setFuture([]);
  }, [projectId]);
  /** Every edit records undo history, like the 3D location workbench; a drag is one undo step. */
  const gesture = useRef(false);
  const commit = (next: SiteGeometryInput) => {
    if (!gesture.current) {
      setPast((p) => [...p.slice(-HISTORY_LIMIT + 1), geometry]);
      setFuture([]);
    }
    onChange(next);
  };
  const beginGesture = () => {
    if (gesture.current) return;
    setPast((p) => [...p.slice(-HISTORY_LIMIT + 1), geometry]);
    setFuture([]);
    gesture.current = true;
    const end = () => {
      gesture.current = false;
      window.removeEventListener("pointerup", end);
      window.removeEventListener("keyup", end);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("keyup", end);
  };
  const undo = (redo: boolean) => {
    const from = redo ? future : past;
    const target = from.at(-1);
    if (!target || disabled) return;
    if (redo) {
      setFuture(future.slice(0, -1));
      setPast((p) => [...p, geometry]);
    } else {
      setPast(past.slice(0, -1));
      setFuture((f) => [...f, geometry]);
    }
    setSelected(null);
    onChange(target);
  };
  const update = (patch: Partial<SiteGeometryInput>) => commit({ ...geometry, ...patch });
  const patchBuilding = (id: string, patch: (b: BuildingGeometry) => BuildingGeometry) =>
    update({ buildings: geometry.buildings.map((b) => (b.id === id ? patch(b) : b)) });
  const updateEvidence = (next: GeometryEvidence) => {
    if (selected?.kind === "parcel") update({ parcel: next, ...(next.geometry !== geometry.parcel?.geometry ? { setbacks: [] } : {}) });
    if (selected?.kind === "envelope") update({ envelope: next });
    if (selected?.kind === "exclusion") update({ exclusions: geometry.exclusions.map((e) => (e.id === next.id ? next : e)), exclusionsReviewed: false });
    if ((selected?.kind === "building" || selected?.kind === "staffel") && selectedBuilding)
      patchBuilding(selectedBuilding.id, (b) =>
        selected.kind === "building"
          ? { ...b, footprint: next, storeysReviewed: false }
          : { ...b, staffel: b.staffel.map((s) => (s.footprint.id === next.id ? { ...s, footprint: next, classificationReviewed: false } : s)) },
      );
  };

  // Plan projection: metres to canvas pixels, north up, with a uniform scale so shapes are never distorted.
  const width = Math.max(size.width, 1),
    height = Math.max(size.height, 1);
  const addressParcels = useMemo(() => alkis.filter((p) => p.containsAddress), [alkis]);
  const extent = useMemo(() => {
    const pts =
      geometry.parcel?.geometry.flat(2) ??
      (addressParcels.length ? addressParcels.flatMap((p) => p.polygons.flat(2)) : undefined) ??
      context?.buildings.flatMap((b) => b.polygons.flat(2).map((p) => fromLocal(context, p))) ??
      [];
    if (!pts.length) return { cx: 0, cy: 0, w: 100, h: 100 };
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: Math.max(10, maxX - minX), h: Math.max(10, maxY - minY) };
  }, [geometry.parcel, context, addressParcels]);
  /** The 3D scene: the project's location context, else empty ground around the parcel. */
  const scene = useMemo(
    () => context ?? (geometry.parcel || addressParcels.length ? emptyContext([Math.round(extent.cx), Math.round(extent.cy)]) : null),
    [context, !!geometry.parcel || addressParcels.length > 0, Math.round(extent.cx), Math.round(extent.cy)],
  );
  /** Neighbouring buildings with a known height and their Abstandsflächen; buildings mostly on the parcel are treated as replaced. */
  const { neighbours, replaced } = useMemo(() => {
    const replaced = new Set<string>();
    if (!engine || !context || !geometry.parcel) return { neighbours: [], replaced };
    const parcel = geometry.parcel.geometry, reach = 40;
    const xs = parcel.flat(2).map((p) => p[0]), ys = parcel.flat(2).map((p) => p[1]);
    const [minX, minY, maxX, maxY] = [Math.min(...xs) - reach, Math.min(...ys) - reach, Math.max(...xs) + reach, Math.max(...ys) + reach];
    const neighbours = context.buildings.flatMap((b) => {
      const footprint = b.polygons.map((p) => p.map((r) => r.map((point) => fromLocal(context, point))));
      if (footprint.flat(2).every(([x, y]) => x < minX || x > maxX || y < minY || y > maxY)) return [];
      try {
        const area = engine.geometryArea(footprint);
        if (!(area > 0)) return [];
        if (engine.geometryArea(engine.intersectGeometry(footprint, parcel)) > area / 2) {
          replaced.add(b.id);
          return [];
        }
        // Nebengebäude (garages, sheds) may stand in setback areas and keep none of their own (§ 6 (7) BauO Bln).
        if (b.ancillary) return [];
        return b.height ? [{ footprint, area: engine.berlinSetbackArea(footprint, engine.deriveBerlinSetback("standard", b.height) ?? 3) }] : [];
      } catch {
        return [];
      }
    });
    return { neighbours, replaced };
  }, [engine, context, geometry.parcel]);
  /** The massing view shows the design instead of the existing buildings it replaces. */
  const scene3d = useMemo(() => (scene && replaced.size ? { ...scene, buildings: scene.buildings.filter((b) => !replaced.has(b.id)) } : scene), [scene, replaced]);
  const fitScale = Math.max(extent.w / (width * 0.8), extent.h / (height * 0.8));
  const metresPerPixel = fitScale / frame.zoom;
  const cx = extent.cx + frame.x,
    cy = extent.cy + frame.y;
  const project = (p: GeometryPoint): GeometryPoint => [width / 2 + (p[0] - cx) / metresPerPixel, height / 2 - (p[1] - cy) / metresPerPixel];
  const unproject = (p: { x: number; y: number }): GeometryPoint => [cx + (p.x * width - width / 2) * metresPerPixel, cy - (p.y * height - height / 2) * metresPerPixel];
  const affine = geometry.planOverlay && engine?.affineFromControlPoints(geometry.planOverlay.controlPoints);
  const overlayMatrix = affine
    ? `matrix(${affine[0] / metresPerPixel},${-affine[3] / metresPerPixel},${affine[1] / metresPerPixel},${-affine[4] / metresPerPixel},${width / 2 + (affine[2] - cx) / metresPerPixel},${height / 2 - (affine[5] - cy) / metresPerPixel})`
    : undefined;
  const pointerSite = (event: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = event.currentTarget.getBoundingClientRect();
    return unproject({ x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height });
  };
  const viewport3d = useRef<Viewport | null>(null);
  /** Zooms by `factor`, keeping the site point under (fx, fy) — fractions of the canvas — where it is, like a map. */
  const zoomAt = (factor: number, fx = 0.5, fy = 0.5) =>
    setFrame((f) => {
      const zoom = Math.min(16, Math.max(0.25, f.zoom * factor));
      const ox = (fx - 0.5) * width, oy = (fy - 0.5) * height;
      const px = extent.cx + f.x + ox * (fitScale / f.zoom), py = extent.cy + f.y - oy * (fitScale / f.zoom);
      return { zoom, x: px - extent.cx - ox * (fitScale / zoom), y: py - extent.cy + oy * (fitScale / zoom) };
    });
  const zoomBy = (factor: number) => (view === "3d" ? viewport3d.current?.zoom(factor) : zoomAt(factor));
  const fit = () => {
    if (view !== "3d") return setFrame({ zoom: 1, x: 0, y: 0 });
    if (!scene) return;
    const rings = geometry.parcel?.geometry.flat(2) ?? addressParcels.flatMap((p) => p.polygons.flat(2));
    viewport3d.current?.fit(rings.map((p) => toLocal(scene, p)), undefined, 450, Math.max(0, ...geometry.buildings.map(fullStoreyMeshHeight)));
  };
  const wheelZoom = useRef(zoomAt);
  wheelZoom.current = zoomAt;
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    // Wheel zoom stays on the canvas instead of scrolling the page; it follows trackpad deltas smoothly and zooms to the cursor.
    const wheel = (event: WheelEvent) => {
      if (view !== "2d") return;
      event.preventDefault();
      const r = element.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      wheelZoom.current(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), (event.clientX - r.left) / r.width, (event.clientY - r.top) / r.height);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [view]);

  const selectId = (id: string | null) => {
    setTab("properties");
    setParcelPick(null);
    if (!id) return setSelected(null);
    if (id.startsWith("building:") && context) {
      const b = context.buildings.find((b) => `building:${b.id}` === id);
      if (b && tool === "reference") onReference?.(b, context);
      return;
    }
    if (id === "parcel") setSelected({ kind: "parcel", id });
    else if (geometry.mandatoryLines.some((l) => l.id === id)) setSelected({ kind: "line", id });
    else if (id === "envelope") setSelected({ kind: "envelope", id });
    else if (geometry.exclusions.some((e) => e.id === id)) setSelected({ kind: "exclusion", id });
    else if (geometry.buildings.some((b) => b.id === id)) setSelected({ kind: "building", id });
    else if (geometry.buildings.some((b) => b.staffel.some((s) => s.footprint.id === id))) setSelected({ kind: "staffel", id });
    else if (geometry.setbacks.some((e) => e.id === id)) setSelected({ kind: "edge", id });
  };
  /** Clicking a cadastral parcel (other than the adopted one) picks it for adoption. */
  const pickParcelAt = (point: GeometryPoint) => {
    if (!layers.parcels) return false;
    const hit = alkis.find((p) => p.id !== geometry.parcel?.id && containsPoint(p.polygons, point));
    if (!hit) return false;
    setSelected(null);
    setParcelPick(hit.id);
    return true;
  };
  const adoptParcel = (parcel: BerlinParcel) => {
    if (onAdoptParcel) onAdoptParcel(parcel);
    else update({ parcel: { id: parcel.id, label: parcel.label, geometry: parcel.polygons, source: parcel.sourceUrl, sourceDate: parcel.sourceDate, reviewed: false }, setbacks: [] });
    setParcelPick(null);
    setSelected(null);
    setFrame({ zoom: 1, x: 0, y: 0 });
  };
  // Drawing works in the plan and in 3D; edge decisions and vertex editing stay in the plan.
  const canDraw = !disabled && !!geometry.parcel && scenario !== "upside";
  const start = (next: Tool) => {
    setTool(next);
    setPoints([]);
    if (next === "edge") setTab("properties");
  };
  const finish = () => {
    if (tool === "line") {
      if (points.length < 2) return;
      const line = { id: crypto.randomUUID(), label: label("ObjectLine").replace("{n}", String(geometry.mandatoryLines.length + 1)), line: points, source: "", sourceDate: null, reviewed: false };
      update({ mandatoryLines: [...geometry.mandatoryLines, line] });
      setSelected({ kind: "line", id: line.id });
      setTool("select");
      setPoints([]);
      return;
    }
    if (points.length < 3) return;
    const ring = closeRing(points);
    if (tool === "envelope") {
      const e = evidence(label("ObjectEnvelope"), ring);
      update({ envelope: e });
      setSelected({ kind: "envelope", id: "envelope" });
    }
    if (tool === "exclusion") {
      const e = evidence(label("ObjectExclusion").replace("{n}", String(geometry.exclusions.length + 1)), ring);
      update({ exclusions: [...geometry.exclusions, e], exclusionsReviewed: false });
      setSelected({ kind: "exclusion", id: e.id });
    }
    if (tool === "building") {
      const name = label("ObjectBuilding").replace("{n}", String(geometry.buildings.length + 1));
      const b: BuildingGeometry = {
        id: crypto.randomUUID(),
        label: name,
        footprint: evidence(name, ring),
        fullStoreys: options?.maxFullStoreys ?? 1,
        storeyHeight: 3,
        height: null,
        storeysSource: "",
        storeysReviewed: false,
        staffel: [],
      };
      update({ buildings: [...geometry.buildings, b] });
      setSelected({ kind: "building", id: b.id });
    }
    if (tool === "staffel" && selectedBuilding) {
      const e = evidence(label("ObjectStaffel").replace("{n}", String(selectedBuilding.staffel.length + 1)), ring);
      patchBuilding(selectedBuilding.id, (b) => ({
        ...b,
        staffel: [...b.staffel, { footprint: e, countable: true, height: 3, areaAbove230: null, averageTopAboveTerrain: null, classificationReviewed: false }],
      }));
      setSelected({ kind: "staffel", id: e.id });
    }
    setTool("select");
    setPoints([]);
  };
  /** Adds a drawn corner, snapped to nearby parcel and building corners; clicking the first corner closes the shape. */
  const addPoint = (next: GeometryPoint, tolerance: number) => {
    if (tool !== "line" && points.length >= 3 && Math.hypot(points[0]![0] - next[0], points[0]![1] - next[1]) < tolerance) return finish();
    const vertices = [...(geometry.parcel?.geometry.flat(2) ?? []), ...geometry.buildings.flatMap((b) => b.footprint.geometry.flat(2))];
    const nearest = vertices.reduce<GeometryPoint | undefined>(
      (best, p) =>
        Math.hypot(p[0] - next[0], p[1] - next[1]) < tolerance && (!best || Math.hypot(p[0] - next[0], p[1] - next[1]) < Math.hypot(best[0] - next[0], best[1] - next[1])) ? p : best,
      undefined,
    );
    const point = nearest ?? next;
    // The second click of a double-click lands on the last corner; it closes the outline instead of adding a corner.
    setPoints((p) => (p.length && Math.hypot(p.at(-1)![0] - point[0], p.at(-1)![1] - point[1]) < tolerance ? p : [...p, point]));
  };
  const shift = (dx: number, dy: number) =>
    selectedEvidence &&
    updateEvidence({ ...selectedEvidence, reviewed: false, geometry: selectedEvidence.geometry.map((p) => p.map((r) => r.map(([x, y]) => [x + dx, y + dy]))) });
  const planRef = useRef<HTMLDivElement>(null);
  const siteAt = (event: { clientX: number; clientY: number }) => {
    const r = planRef.current!.getBoundingClientRect();
    return unproject({ x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height });
  };
  /** Drag a building with its Staffel, in 10 cm steps; numbers follow live and moving revokes review. */
  const dragBuilding = (building: BuildingGeometry, event: React.PointerEvent) => {
    if (tool !== "select" || disabled || event.button !== 0 || scenario === "upside") return;
    event.stopPropagation();
    const origin = siteAt(event), base = geometry, startX = event.clientX, startY = event.clientY;
    let moved = false, frameRequest = 0;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      if (!moved) {
        moved = true;
        beginGesture();
        setSelected({ kind: "building", id: building.id });
      }
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(() => {
        const p = siteAt(ev);
        const dx = Math.round((p[0] - origin[0]) * 10) / 10, dy = Math.round((p[1] - origin[1]) * 10) / 10;
        onChange({ ...base, buildings: base.buildings.map((b) => (b.id === building.id ? translateBuilding(b, dx, dy) : b)) });
      });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  /**
   * Drag a Staffel as a whole, in 10 cm steps, kept within its building's footprint: a move that would leave the floor below
   * slides along the wall it hits (each axis is tried on its own) instead of stopping.
   */
  const dragStaffel = (building: BuildingGeometry, staffel: BuildingGeometry["staffel"][number], event: React.PointerEvent) => {
    if (tool !== "select" || disabled || event.button !== 0 || scenario === "upside" || !engine) return;
    event.stopPropagation();
    const origin = siteAt(event), base = geometry, startX = event.clientX, startY = event.clientY, below = building.footprint.geometry;
    const fits = (dx: number, dy: number) => {
      try {
        const moved = translateRings(staffel.footprint.geometry, dx, dy);
        return engine.geometryArea(moved) - engine.geometryArea(engine.intersectGeometry(moved, below)) < 0.01;
      } catch {
        return false;
      }
    };
    let moved = false, frameRequest = 0, last: [number, number] = [0, 0];
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      if (!moved) {
        moved = true;
        beginGesture();
        setSelected({ kind: "staffel", id: staffel.footprint.id });
      }
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(() => {
        const p = siteAt(ev);
        const dx = Math.round((p[0] - origin[0]) * 10) / 10, dy = Math.round((p[1] - origin[1]) * 10) / 10;
        const next: [number, number] | null = fits(dx, dy) ? [dx, dy] : fits(dx, last[1]) ? [dx, last[1]] : fits(last[0], dy) ? [last[0], dy] : null;
        if (!next || (next[0] === last[0] && next[1] === last[1])) return;
        last = next;
        const footprint = { ...staffel.footprint, geometry: translateRings(staffel.footprint.geometry, next[0], next[1]), reviewed: false };
        onChange({ ...base, buildings: base.buildings.map((b) => (b.id === building.id ? { ...b, staffel: b.staffel.map((st) => (st.footprint.id === staffel.footprint.id ? { ...st, footprint, classificationReviewed: false } : st)) } : b)) });
      });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  // Live massing: the footprint being drawn previews at the default height, every building gets its Abstandsflächen.
  const defaultStoreys = options?.maxFullStoreys ?? 1;
  const draft = useMemo(() => {
    const ring = [...points, ...(hover ? [hover] : [])];
    return tool === "building" && ring.length >= 3 ? { footprint: [[closeRing(ring)]] as GeometryMultiPolygon, height: defaultStoreys * 3 } : null;
  }, [tool, points, hover, defaultStoreys]);
  const massingBuildings = useMemo(() => (scenario === "upside" ? (upsideMassing ? [upsideMassing.building] : []) : geometry.buildings), [scenario, upsideMassing, geometry.buildings]);
  const setbackChecks = useMemo(() => {
    if (!engine || !geometry.parcel) return [];
    // Staffel volumes stack on the main body; each gets its own setback from its walls at its top height.
    const buildings: { id: string; footprint: GeometryMultiPolygon; height: number; upper?: { footprint: GeometryMultiPolygon; height: number }[] }[] = massingBuildings.map((b) => {
      if (!b.staffel.length) return { id: b.id, footprint: b.footprint.geometry, height: buildingHeight(b) };
      let top = fullStoreyMeshHeight(b);
      return { id: b.id, footprint: b.footprint.geometry, height: top, upper: b.staffel.map((s) => ({ footprint: s.footprint.geometry, height: (top += s.height) })) };
    });
    if (draft) buildings.push({ id: "draft", footprint: draft.footprint, height: draft.height });
    return engine.checkSetbackAreas({ parcel: geometry.parcel.geometry, buildings, neighbours });
  }, [engine, geometry.parcel, massingBuildings, draft, neighbours]);
  const shownSetbacks = layers.setbacks ? setbackChecks : NO_SETBACKS;
  /** The building the massing panel and the 3D grip work on: the selection, else the only building. */
  const focusBuilding = scenario === "baseline" ? (selectedBuilding ?? (geometry.buildings.length === 1 ? geometry.buildings[0] : undefined)) : undefined;
  const floorArea = (b: BuildingGeometry) => {
    if (!engine) return null;
    try {
      return engine.geometryArea(b.footprint.geometry) * b.fullStoreys + b.staffel.reduce((sum, s) => sum + engine.geometryArea(s.footprint.geometry), 0);
    } catch {
      return null;
    }
  };
  /** Live site figures for the massing overlay: combined footprint, GRZ and GFZ, including the outline being drawn. */
  const siteFigures = useMemo(() => {
    if (!engine || !geometry.parcel) return null;
    const shapes = [...massingBuildings.map((b) => b.footprint.geometry), ...(draft ? [draft.footprint] : [])];
    if (!shapes.length) return null;
    try {
      const basis = parcelArea && parcelArea > 0 ? parcelArea : engine.geometryArea(geometry.parcel.geometry);
      const footprint = engine.geometryArea(engine.unionGeometry(...shapes));
      const countable =
        massingBuildings.reduce((n, b) => n + engine.geometryArea(b.footprint.geometry) * b.fullStoreys + b.staffel.reduce((m, st) => m + (st.countable ? engine.geometryArea(st.footprint.geometry) : 0), 0), 0) +
        (draft ? engine.geometryArea(draft.footprint) * defaultStoreys : 0);
      return basis > 0 ? { footprint, grz: footprint / basis, gfz: countable / basis } : null;
    } catch {
      return null;
    }
  }, [engine, geometry.parcel, massingBuildings, draft, parcelArea, defaultStoreys]);
  const setStoreys = (b: BuildingGeometry, patch: { fullStoreys?: number; storeyHeight?: number }) =>
    patchBuilding(b.id, (x) => ({ ...x, ...patch, height: null, storeysReviewed: false }));
  /** Proposes a Staffelgeschoss on top of the building: the footprint inset until it covers at most `share` of the floor below. */
  const staffelProposal = (b: BuildingGeometry, share: number, name: string): GeometryEvidence | null => {
    if (!engine) return null;
    const footprint = engine.proposeStaffel(b.footprint.geometry, share);
    const source = label("StaffelProposalSource").replace("{share}", format(share * 100, 0)) + (staffelRule ? ` · ${staffelRule.rule}` : "");
    return footprint.length ? { ...evidence(name, []), geometry: footprint, source } : null;
  };
  // The state's building code sets from which share of the floor below a Staffel is a Vollgeschoss; the proposal stays just below it.
  const staffelRule = engine?.suggestedStaffelShare(jurisdiction) ?? null;
  const shareText = (share: number) => (Math.abs(share - 2 / 3) < 1e-6 ? "⅔" : `${format(share * 100, 0)} %`);
  const fullStorey = (share: number) => (staffelRule ? share >= staffelRule.threshold - 1e-6 : true);
  const addStaffel = (b: BuildingGeometry, share = staffelRule?.share ?? 2 / 3) => {
    const e = staffelProposal(b, share, label("ObjectStaffel").replace("{n}", String(b.staffel.length + 1)));
    if (!e) return;
    patchBuilding(b.id, (x) => ({
      ...x,
      height: null,
      staffel: [...x.staffel, { footprint: e, countable: fullStorey(share), height: b.storeyHeight, areaAbove230: null, averageTopAboveTerrain: null, classificationReviewed: false }],
    }));
    setSelected({ kind: "staffel", id: e.id });
  };
  /** Re-proposes the selected Staffel's outline for another share of the floor below, keeping its id, name and height. */
  const reshapeStaffel = (b: BuildingGeometry, staffel: BuildingGeometry["staffel"][number], share: number) => {
    const e = staffelProposal(b, share, staffel.footprint.label);
    if (!e) return;
    patchBuilding(b.id, (x) => ({ ...x, staffel: x.staffel.map((st) => (st === staffel ? { ...st, footprint: { ...e, id: st.footprint.id }, countable: fullStorey(share), classificationReviewed: false } : st)) }));
  };
  /** 3D drags: moving follows the ground like the plan drag (10 cm steps), extruding snaps to whole floors. */
  const drag3d = useRef<{ base: SiteGeometryInput; floors: number } | null>(null);
  const onDrag3d = {
    begin: (id: string) => {
      const building = geometry.buildings.find((b) => b.id === id);
      if (!building || disabled) return;
      beginGesture();
      drag3d.current = { base: geometry, floors: building.fullStoreys };
      setSelected({ kind: "building", id });
    },
    move: (id: string, kind: "move" | "extrude", value: GeometryPoint | number) => {
      const drag = drag3d.current;
      if (!drag) return;
      if (kind === "move") {
        const [dx, dy] = value as GeometryPoint;
        onChange({ ...drag.base, buildings: drag.base.buildings.map((b) => (b.id === id ? translateBuilding(b, Math.round(dx * 10) / 10, Math.round(dy * 10) / 10) : b)) });
        return;
      }
      const building = drag.base.buildings.find((b) => b.id === id);
      if (!building) return;
      const floors = Math.min(200, Math.max(1, Math.round((value as number) / building.storeyHeight)));
      if (floors === drag.floors) return;
      drag.floors = floors;
      onChange({ ...drag.base, buildings: drag.base.buildings.map((b) => (b.id === id ? { ...b, fullStoreys: floors, height: null, storeysReviewed: false } : b)) });
    },
  };
  const removeObject = (kind: SelectionKind, id: string) => {
    if (kind === "line") update({ mandatoryLines: geometry.mandatoryLines.filter((l) => l.id !== id) });
    if (kind === "parcel") update({ parcel: null, setbacks: [] });
    if (kind === "envelope") update({ envelope: null });
    if (kind === "exclusion") update({ exclusions: geometry.exclusions.filter((e) => e.id !== id), exclusionsReviewed: false });
    if (kind === "building") update({ buildings: geometry.buildings.filter((b) => b.id !== id) });
    if (kind === "staffel") update({ buildings: geometry.buildings.map((b) => ({ ...b, staffel: b.staffel.filter((s) => s.footprint.id !== id) })) });
    if (kind === "edge") update({ setbacks: geometry.setbacks.filter((e) => e.id !== id) });
    if (selected?.kind === kind && selected.id === id) setSelected(null);
  };
  const removeSelected = () => {
    if (selected) removeObject(selected.kind, selected.id);
  };
  const openEdge = (pi: number, ri: number, ei: number) => {
    let edge = geometry.setbacks.find((e) => e.polygonIndex === pi && e.ringIndex === ri && e.edgeIndex === ei);
    if (!edge) {
      edge = { id: crypto.randomUUID(), polygonIndex: pi, ringIndex: ri, edgeIndex: ei, distance: null, profile: "manual", heightSource: "manual", assessmentHeight: null, reviewedHeight: null, source: "", sourceDate: null, reviewed: false };
      update({ setbacks: [...geometry.setbacks, edge] });
    }
    setTab("properties");
    setSelected({ kind: "edge", id: edge.id });
  };

  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.defaultPrevented || target?.closest("[role=dialog], [data-slot=popover-content]")) return;
    const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    if (event.key === "Escape") {
      if (points.length || tool !== "select") start("select");
      else if (selected && !typing) setSelected(null);
      return;
    }
    if (typing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo(event.shiftKey);
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const arrow = arrows[event.key];
    if (arrow && selectedEvidence && tool === "select" && !disabled && scenario !== "upside" && !event.metaKey && !event.ctrlKey) {
      // Arrow keys nudge the selected shape by 10 cm, Shift by 1 m; held keys are one undo step.
      event.preventDefault();
      const step = event.shiftKey ? 1 : 0.1;
      beginGesture();
      shift(arrow[0] * step, arrow[1] * step);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (points.length && event.key === "Enter") {
      event.preventDefault();
      finish();
      return;
    }
    if (points.length && event.key === "Backspace") {
      event.preventDefault();
      setPoints((p) => p.slice(0, -1));
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !points.length && selected && !disabled && scenario === "baseline") {
      event.preventDefault();
      removeSelected();
      return;
    }
    const key = event.key.toLowerCase();
    const tools: Record<string, Tool> = { v: "select", h: "pan", e: "envelope", l: "line", x: "exclusion", b: "building", s: "edge", r: "reference" };
    if (tools[key]) {
      const next = tools[key]!;
      if (next !== "select" && next !== "pan" && !canDraw) return;
      if (next === "reference" && !onReference) return;
      if (next === "edge" && view !== "2d") return;
      event.preventDefault();
      start(next);
    } else if (key === "t") setView("2d");
    else if (key === "3" && scene) setView("3d");
    else if (key === "f") fit();
    else if (key === "+" || key === "=") zoomBy(1.5);
    else if (key === "-") zoomBy(1 / 1.5);
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const selectedRing = selectedEvidence?.geometry[0]?.[0];
  const pendingIssues = result?.issues ?? [];
  const reviewState = (reviewed: boolean) => <Badge variant="outline">{t(reviewed ? "siteAssessmentReviewed" : "siteAssessmentUnreviewed")}</Badge>;
  const reviewHint = (missing: string[]) =>
    missing.length ? <small className="muted">{t("siteAssessmentReviewNeeds").replace("{items}", missing.join(", "))}</small> : null;
  const evidenceMissing = (item: { source: string; sourceDate: string | null }) =>
    [!item.source.trim() && label("Source"), !item.sourceDate && label("Date")].filter(Boolean) as string[];
  const evidenceFields = (item: { source: string; sourceDate: string | null; reviewed: boolean }, change: (patch: { source?: string; sourceDate?: string | null; reviewed?: boolean }) => void, extraMissing: string[] = []) => {
    const missing = [...evidenceMissing(item), ...extraMissing];
    return (
      <>
        <Field label={label("Source")}>
          <Input value={item.source} disabled={disabled} maxLength={2000} onChange={(e) => change({ source: e.target.value, reviewed: false })} />
        </Field>
        <Field label={label("Date")}>
          <DateInput value={item.sourceDate} disabled={disabled} onValueChange={(sourceDate) => change({ sourceDate, reviewed: false })} />
        </Field>
        <div className="geometry-review">
          <label className="site-review text-ui-xs">
            <Checkbox checked={item.reviewed} disabled={disabled || missing.length > 0} onCheckedChange={(v) => change({ reviewed: v === true })} />
            {label("Reviewed")}
          </label>
          {!item.reviewed && reviewHint(missing)}
        </div>
      </>
    );
  };
  const numberField = (fieldLabel: string, current: number | null, change: (n: number | null) => void, opts: { min?: number; step?: number; integer?: boolean } = {}) => (
    <Field label={fieldLabel}>
      <Input
        type="number"
        min={opts.min ?? 0}
        step={opts.step ?? 0.1}
        disabled={disabled}
        value={current ?? ""}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (!Number.isFinite(n)) return change(null);
          if (opts.integer && !Number.isInteger(n)) return;
          change(n);
        }}
      />
    </Field>
  );

  const issueTarget = (id?: string) => {
    if (!id) return null;
    const edge = geometry.setbacks.find((e) => e.id === id);
    if (edge) return { name: edgeName(edge.polygonIndex, edge.ringIndex, edge.edgeIndex), edge: [edge.polygonIndex, edge.ringIndex, edge.edgeIndex] as const };
    const match = id.match(/^edge-(\d+)-(\d+)-(\d+)$/);
    if (match) {
      const [pi, ri, ei] = match.slice(1).map(Number) as [number, number, number];
      return { name: edgeName(pi, ri, ei), edge: [pi, ri, ei] as const };
    }
    const bIndex = geometry.buildings.findIndex((b) => b.id === id || b.footprint.id === id);
    if (bIndex >= 0) return { name: buildingName(geometry.buildings[bIndex]!, bIndex), select: { kind: "building" as const, id: geometry.buildings[bIndex]!.id } };
    for (const b of geometry.buildings) {
      const sIndex = b.staffel.findIndex((s) => s.footprint.id === id);
      if (sIndex >= 0) return { name: staffelName(b.staffel[sIndex]!, sIndex), select: { kind: "staffel" as const, id } };
    }
    const xIndex = geometry.exclusions.findIndex((e) => e.id === id);
    if (xIndex >= 0) return { name: exclusionName(geometry.exclusions[xIndex]!, xIndex), select: { kind: "exclusion" as const, id } };
    const lIndex = geometry.mandatoryLines.findIndex((l) => l.id === id);
    if (lIndex >= 0) return { name: lineName(geometry.mandatoryLines[lIndex]!, lIndex), select: { kind: "line" as const, id } };
    if (id === geometry.parcel?.id) return { name: label("Parcel"), select: { kind: "parcel" as const, id: "parcel" } };
    if (id === geometry.envelope?.id) return { name: label("ObjectEnvelope"), select: { kind: "envelope" as const, id: "envelope" } };
    return null;
  };
  const reviewIssue = (code: string, id?: string) => {
    if (code === "missing_envelope") return start("envelope");
    if (code === "exclusions_unreviewed") {
      // The confirmation lives with the exclusions in the layer list.
      setSelected(null);
      setPanel("layers");
      document.querySelector<HTMLElement>(".geometry-layer-check button")?.focus();
      return;
    }
    const target = issueTarget(id);
    if (target?.edge) {
      const [pi, ri, ei] = target.edge;
      const edge = geometry.setbacks.find((e) => e.polygonIndex === pi && e.ringIndex === ri && e.edgeIndex === ei) ?? engine?.createDefaultSetbacks(geometry.parcel!).find((e) => e.polygonIndex === pi && e.ringIndex === ri && e.edgeIndex === ei);
      if (edge) {
        if (!geometry.setbacks.some((e) => e.id === edge.id)) update({ setbacks: [...geometry.setbacks, edge] });
        setTool("edge");
        setTab("properties");
        setSelected({ kind: "edge", id: edge.id });
      }
      return;
    }
    if (target?.select) {
      setTab("properties");
      setSelected(target.select);
    }
  };
  const groupedIssues = Object.entries(
    pendingIssues.reduce<Record<string, typeof pendingIssues>>((groups, issue) => {
      (groups[issue.code] ??= []).push(issue);
      return groups;
    }, {}),
  );

  const toolItems: [Tool, typeof MousePointer2, Key, string][] = [
    ["select", MousePointer2, "siteGeometryselect", "V"],
    ["pan", Hand, "siteGeometrypan", "H"],
    ["envelope", SquareDashed, "siteGeometryenvelope", "E"],
    ["line", Slash, "siteGeometryline", "L"],
    ["exclusion", Ban, "siteGeometryexclusion", "X"],
    ["building", Building2, "siteGeometrybuilding", "B"],
    ["edge", ArrowLeftRight, "siteGeometryedge", "S"],
    ["reference", BookmarkPlus, "siteGeometryreference", "R"],
  ];
  const drawing = DRAW_TOOLS.includes(tool);
  const parcelLayer = useMemo(
    () => ({ items: layers.parcels ? alkis.map((p) => ({ id: p.id, polygons: p.polygons })) : [], selected: pickedParcel?.id ?? null }),
    [alkis, layers.parcels, pickedParcel?.id],
  );
  const drawingPreview = useMemo(() => (drawing && points.length ? { points, hover } : null), [drawing, points, hover]);
  const focusHeight = focusBuilding ? fullStoreyMeshHeight(focusBuilding) : 0;
  const editable = focusBuilding && !disabled && !drawing
    ? { id: focusBuilding.id, height: focusHeight, label: label("MassingGrip").replace("{floors}", String(focusBuilding.fullStoreys)).replace("{height}", format(focusHeight, 1)) }
    : null;
  const bar = scaleBar(metresPerPixel, width);
  const edgeDecisions = geometry.parcel ? geometry.parcel.geometry.flat().reduce((n, ring) => n + ring.length - 1, 0) : 0;
  // Each layer row selects its object; the trash button deletes it (one undo step, like Delete on the selection).
  const objectRow = (key: string, name: string, kind: SelectionKind, id: string, status?: ReactNode, indent = false) => (
    <div key={key} className={`geometry-object-item${indent ? " is-child" : ""}`}>
      <button type="button" className="geometry-object-row" aria-pressed={selected?.kind === kind && selected.id === id} onClick={() => selectId(id)}>
        <span>{name}</span>
        {status}
      </button>
      {!disabled && scenario === "baseline" && (
        <Button variant="ghost" size="icon-xs" className="geometry-object-delete" aria-label={label("DeleteObject").replace("{name}", name)} title={label("DeleteObject").replace("{name}", name)} onClick={() => removeObject(kind, id)}>
          <Trash2 className="size-icon-sm" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
  const smallStatus = (reviewed: boolean) => <small className="muted">{t(reviewed ? "siteAssessmentReviewedShort" : "siteAssessmentUnreviewed")}</small>;

  return (
    <>
      <section className="geometry-workbench" aria-label={label("Title")}>
        <div className="geometry-toolbar" role="toolbar" aria-label={label("Actions")}>
          <div className="geometry-toolbar-group">
            <Button variant="ghost" size="icon-sm" className="geometry-panel-toggle" aria-label={label("Layers")} title={label("Layers")} aria-pressed={panel === "layers"} onClick={() => setPanel(panel === "layers" ? null : "layers")}>
              <PanelLeft className="size-icon-sm" />
            </Button>
            <Button variant="ghost" size="icon-sm" className="geometry-panel-toggle" aria-label={label("Inspector")} title={label("Inspector")} aria-pressed={panel === "inspector"} onClick={() => setPanel(panel === "inspector" ? null : "inspector")}>
              <PanelRight className="size-icon-sm" />
            </Button>
            <Segmented value={view} onChange={setView} items={[{ value: "2d", label: label("Plan") }, { value: "3d", label: "3D", disabled: !scene }]} />
            {upsideMassing !== undefined && onScenario && (
              <Segmented
                value={scenario}
                onChange={(value) => { start("select"); setSelected(null); onScenario(value as "baseline" | "upside"); }}
                items={[{ value: "baseline", label: label("ScenarioBaseline") }, { value: "upside", label: label("ScenarioUpside"), disabled: !upsideMassing }]}
              />
            )}
            {!scene && <span className="text-ui-2xs muted">{label("3DNeedsContext")}</span>}
          </div>
          <div className="geometry-toolbar-group">
            <Button variant="ghost" size="icon-sm" aria-label={t("locationUndo")} title={`${t("locationUndo")} (⌘Z)`} disabled={!past.length || disabled} onClick={() => undo(false)}>
              <Undo2 className="size-icon-sm" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("locationRedo")} title={`${t("locationRedo")} (⇧⌘Z)`} disabled={!future.length || disabled} onClick={() => undo(true)}>
              <Redo2 className="size-icon-sm" />
            </Button>
          </div>
        </div>
        <div className={`geometry-body${panel ? ` show-${panel}` : ""}`} style={{ "--layers-w": `${widths.layers}px`, "--inspector-w": `${widths.inspector}px` } as CSSProperties}>
          <ResizeHandle className="geometry-resize" edge="right" value={widths.layers} min={180} max={480} onChange={(layers) => widths.set({ layers })} label={label("ResizeLayers")} style={{ left: widths.layers }} />
          <ResizeHandle className="geometry-resize" edge="left" value={widths.inspector} min={300} max={640} onChange={(inspector) => widths.set({ inspector })} label={label("ResizeInspector")} style={{ left: `calc(100% - ${widths.inspector}px)` }} />
          <aside className="geometry-layers" aria-label={label("Layers")}>
            <h2><Layers className="size-icon-sm" aria-hidden="true" />{label("Layers")}</h2>
            <div className="geometry-layer-section">
              <h3>{label("GroupSite")}</h3>
              {geometry.parcel ? objectRow("parcel", label("Parcel"), "parcel", "parcel", smallStatus(geometry.parcel.reviewed)) : <p className="text-ui-2xs muted">{label("NeedParcel")}</p>}
              {result && geometry.parcel && <p className="geometry-layer-meta text-ui-2xs muted">{label("Usable")}: {format(result.usableArea)} m²</p>}
            </div>
            <div className="geometry-layer-section">
              <h3>{label("GroupPlanning")}</h3>
              {geometry.envelope ? objectRow("envelope", label("ObjectEnvelope"), "envelope", "envelope", smallStatus(geometry.envelope.reviewed)) : <p className="text-ui-2xs muted">{label("NoEnvelope")}</p>}
              {geometry.mandatoryLines.map((l, i) => objectRow(l.id, lineName(l, i), "line", l.id, smallStatus(l.reviewed)))}
              {geometry.exclusions.map((e, i) => objectRow(e.id, exclusionName(e, i), "exclusion", e.id, smallStatus(e.reviewed)))}
              <label className="site-review text-ui-xs geometry-layer-check">
                <Checkbox disabled={disabled} checked={geometry.exclusionsReviewed} onCheckedChange={(v) => update({ exclusionsReviewed: v === true })} />
                {label("ExclusionsReviewed")}
              </label>
              {geometry.parcel && (
                <button type="button" className="geometry-object-row" aria-pressed={tool === "edge"} disabled={!canDraw} onClick={() => start("edge")}>
                  <span>{label("edge")}</span>
                  <small className="muted">{label("EdgesDecided").replace("{done}", String(geometry.setbacks.filter((e) => e.reviewed).length)).replace("{total}", String(edgeDecisions))}</small>
                </button>
              )}
            </div>
            <div className="geometry-layer-section">
              <h3>{label("GroupDesign")}</h3>
              {geometry.buildings.length === 0 && <p className="text-ui-2xs muted">{label("NoBuildings")}</p>}
              {geometry.buildings.map((b, i) => (
                <div key={b.id}>
                  {objectRow(b.id, buildingName(b, i), "building", b.id, smallStatus(b.footprint.reviewed && b.storeysReviewed))}
                  {b.staffel.map((s, si) => objectRow(s.footprint.id, staffelName(s, si), "staffel", s.footprint.id, smallStatus(s.footprint.reviewed && s.classificationReviewed), true))}
                  {!disabled && scenario === "baseline" && (
                    <button type="button" className="geometry-object-add text-ui-xs" disabled={!engine} onClick={() => addStaffel(b)}>
                      <Plus className="size-icon-sm" aria-hidden="true" />
                      {label("MassingAddStaffel")}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="geometry-layer-section">
              <h3>{label("GroupContext")}</h3>
              <div className="geometry-layer-toggle text-ui-xs">
                <span>{label("ContextBuildings")} <small className="muted">{context?.buildings.length ?? 0}</small></span>
                <Button variant="ghost" size="icon-xs" aria-label={label(layers.context ? "HideLayer" : "ShowLayer")} aria-pressed={layers.context} disabled={!context} onClick={() => setLayers((l) => ({ ...l, context: !l.context }))}>
                  {layers.context ? <Eye className="size-icon-sm" /> : <EyeOff className="size-icon-sm" />}
                </Button>
              </div>
              {([["parcels", label("LayerParcels"), alkis.length, !alkis.length], ["setbacks", label("LayerSetbacks"), setbackChecks.length, !geometry.parcel]] as const).map(([key, name, count, off]) => (
                <div key={key} className="geometry-layer-toggle text-ui-xs">
                  <span>{name} <small className="muted">{count}</small></span>
                  <Button variant="ghost" size="icon-xs" aria-label={`${name}: ${label(layers[key] ? "HideLayer" : "ShowLayer")}`} aria-pressed={layers[key]} disabled={off} onClick={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}>
                    {layers[key] ? <Eye className="size-icon-sm" /> : <EyeOff className="size-icon-sm" />}
                  </Button>
                </div>
              ))}
              {referenceBuildingIds.length > 0 && <p className="text-ui-2xs muted">{label("ReferencesOutlined").replace("{count}", String(referenceBuildingIds.length))}</p>}
              <div className="geometry-layer-toggle text-ui-xs">
                <span>{label("SourcePlan")} <small className="muted">{geometry.planOverlay ? t(geometry.planOverlay.reviewed ? "siteAssessmentReviewedShort" : "siteAssessmentUnreviewed") : label("NotAligned")}</small></span>
                <Button variant="ghost" size="icon-xs" aria-label={label(layers.plan ? "HideLayer" : "ShowLayer")} aria-pressed={layers.plan} disabled={!geometry.planOverlay} onClick={() => setLayers((l) => ({ ...l, plan: !l.plan }))}>
                  {layers.plan ? <Eye className="size-icon-sm" /> : <EyeOff className="size-icon-sm" />}
                </Button>
              </div>
              {!context && <p className="text-ui-2xs muted">{label("ContextHint")}</p>}
            </div>
          </aside>
          <div className="workbench-tool-rail" role="toolbar" aria-orientation="vertical" aria-label={label("Tools")}>
            {toolItems.map(([value, Icon, key, shortcut]) => (
              <WorkbenchTool
                key={value}
                label={t(key)}
                shortcut={shortcut}
                aria-pressed={tool === value}
                title={value === "edge" && view !== "2d" ? `${t(key)} · ${label("SwitchToPlan")}` : undefined}
                disabled={(value !== "select" && value !== "pan" && !canDraw) || (value === "reference" && !onReference) || (value === "edge" && view !== "2d")}
                onClick={() => start(value)}
              >
                <Icon className="size-icon" aria-hidden="true" />
              </WorkbenchTool>
            ))}
            <div className="geometry-view-tools" role="group" aria-label={label("Views")}>
              <WorkbenchTool label={label("Plan")} shortcut="T" aria-pressed={view === "2d"} onClick={() => setView("2d")}>
                <MapIcon className="size-icon" aria-hidden="true" />
              </WorkbenchTool>
              <WorkbenchTool label="3D" shortcut="3" aria-pressed={view === "3d"} disabled={!scene} onClick={() => setView("3d")}>
                <Box className="size-icon" aria-hidden="true" />
              </WorkbenchTool>
              <WorkbenchTool label={label("ZoomIn")} shortcut="+" onClick={() => zoomBy(1.5)}>
                <ZoomIn className="size-icon" aria-hidden="true" />
              </WorkbenchTool>
              <WorkbenchTool label={label("ZoomOut")} shortcut="−" aria-keyshortcuts="-" onClick={() => zoomBy(1 / 1.5)}>
                <ZoomOut className="size-icon" aria-hidden="true" />
              </WorkbenchTool>
              <WorkbenchTool label={label("Fit")} shortcut="F" onClick={fit}>
                <Scan className="size-icon" aria-hidden="true" />
              </WorkbenchTool>
              <Popover>
                <PopoverTrigger asChild>
                  <WorkbenchTool label={label("Help")}>
                    <CircleHelp className="size-icon" aria-hidden="true" />
                  </WorkbenchTool>
                </PopoverTrigger>
                <PopoverContent side="right" align="end" className="text-ui-xs">
                  {label("HelpText")}
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <div className="geometry-canvas-column">
            <div className="geometry-canvas" ref={canvasRef}>
              {view === "3d" && scene ? (
                <Geometry3D
                  context={scene3d!}
                  geometry={scenario === "upside" ? { ...geometry, buildings: massingBuildings } : geometry}
                  selected={selected?.kind === "edge" ? null : selected?.id ?? null}
                  parcels={parcelLayer}
                  setbacks={shownSetbacks}
                  drawing={drawingPreview}
                  draft={draft}
                  editable={editable}
                  tool={drawing ? "draw" : "select"}
                  viewport={viewport3d}
                  onSelect={(id, ground) => {
                    if (id === "draft") return;
                    if (!id && ground && tool === "select" && pickParcelAt(ground)) return;
                    selectId(id);
                  }}
                  onGround={(point) => !disabled && addPoint(point, 0.75)}
                  onFinish={() => drawing && finish()}
                  onHover={setHover}
                  onDrag={onDrag3d}
                />
              ) : (
                <div
                  ref={planRef}
                  className="geometry-plan"
                  data-tool={tool}
                  data-scenario={scenario}
                  onDoubleClick={() => drawing && finish()}
                  onPointerDown={(e) => {
                    // Dragging the map pans with any tool, like a web map; shapes that drag themselves stop the event first.
                    if (e.button !== 0 && e.button !== 1) return;
                    if (e.button === 1) e.preventDefault();
                    panStart.current = { clientX: e.clientX, clientY: e.clientY, frame, moved: false };
                  }}
                  onPointerMove={(e) => {
                    setHover(pointerSite(e));
                    const begin = panStart.current;
                    if (!begin) return;
                    if (!begin.moved) {
                      if (Math.hypot(e.clientX - begin.clientX, e.clientY - begin.clientY) < 3) return;
                      begin.moved = true;
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }
                    setFrame({ ...begin.frame, x: begin.frame.x - (e.clientX - begin.clientX) * metresPerPixel, y: begin.frame.y + (e.clientY - begin.clientY) * metresPerPixel });
                  }}
                  onPointerLeave={() => setHover(null)}
                  onPointerUp={(e) => {
                    panned.current = !!panStart.current?.moved;
                    panStart.current = null;
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                  }}
                  onClick={(event) => {
                    if (panned.current) {
                      panned.current = false;
                      return;
                    }
                    if (pickingAlignment) {
                      setPickedSite(pointerSite(event));
                      setPickingAlignment(false);
                      return;
                    }
                    const target = event.target as Element;
                    if (tool === "select" && (target === event.currentTarget.querySelector("svg") || target.classList.contains("geometry-context-building"))) {
                      if (!pickParcelAt(pointerSite(event))) {
                        setSelected(null);
                        setParcelPick(null);
                      }
                      return;
                    }
                    if (!drawing || disabled) return;
                    addPoint(pointerSite(event), metresPerPixel * 8);
                  }}
                >
                  <svg viewBox={`0 0 ${width} ${height}`} aria-label={label("Plan")}>
                    {planImage && overlayMatrix && layers.plan && (
                      <image href={planImage} width={1} height={1} preserveAspectRatio="none" transform={overlayMatrix} opacity={geometry.planOverlay?.opacity ?? 0.55} style={{ pointerEvents: "none" }} />
                    )}
                    {layers.context &&
                      context?.buildings.map((b) => (
                        <path
                          key={b.id}
                          className={`geometry-context-building${referenceBuildingIds.includes(b.id) ? " is-reference" : ""}`}
                          d={pathFor(b.polygons.map((p) => p.map((r) => r.map((p) => fromLocal(context, p)))), project)}
                          onClick={(event) => {
                            if (tool === "reference") {
                              event.stopPropagation();
                              onReference?.(b, context);
                            }
                          }}
                        >
                          <title>{b.label}</title>
                        </path>
                      ))}
                    {parcelLayer.items.map((p) => (
                      <path key={p.id} className={`geometry-alkis-parcel${p.id === parcelLayer.selected ? " is-picked" : ""}`} d={pathFor(p.polygons, project)} />
                    ))}
                    {layers.parcels && metresPerPixel < 0.35 &&
                      alkis.map((p) => {
                        if (p.id === geometry.parcel?.id || !p.number) return null;
                        const ring = p.polygons[0]?.[0];
                        if (!ring?.length) return null;
                        const [x, y] = project([ring.reduce((n, q) => n + q[0], 0) / ring.length, ring.reduce((n, q) => n + q[1], 0) / ring.length]);
                        return x < 0 || y < 0 || x > width || y > height ? null : <text key={p.id} className="geometry-alkis-label" x={x} y={y}>{p.number}</text>;
                      })}
                    {geometry.parcel && (
                      <path
                        className={`geometry-parcel${selected?.kind === "parcel" ? " is-selected" : ""}`}
                        d={pathFor(geometry.parcel.geometry, project)}
                        onClick={(event) => {
                          if (tool === "select") {
                            event.stopPropagation();
                            selectId("parcel");
                          }
                        }}
                      />
                    )}
                    {geometry.envelope && (
                      <path
                        className="geometry-envelope"
                        d={pathFor(geometry.envelope.geometry, project)}
                        onClick={(event) => {
                          if (tool === "select") {
                            event.stopPropagation();
                            selectId("envelope");
                          }
                        }}
                      />
                    )}
                    {result?.usableGeometry.length ? <path className="geometry-usable" d={pathFor(result.usableGeometry, project)} /> : null}
                    {geometry.exclusions.map((e) => (
                      <path
                        key={e.id}
                        className="geometry-exclusion"
                        d={pathFor(e.geometry, project)}
                        onClick={(event) => {
                          if (tool === "select") {
                            event.stopPropagation();
                            selectId(e.id);
                          }
                        }}
                      />
                    ))}
                    {shownSetbacks.map((c) => (
                      <g key={c.id} className="geometry-setback">
                        {c.clear.length > 0 && <path className="geometry-setback-clear" d={pathFor(c.clear, project)} />}
                        {c.conflict.length > 0 && <path className="geometry-setback-conflict" d={pathFor(c.conflict, project)} />}
                      </g>
                    ))}
                    {scenario === "upside" && upsideMassing && (
                      <g className="geometry-scenario">
                        <path className="geometry-building is-scenario" d={pathFor(upsideMassing.building.footprint.geometry, project)} />
                        {upsideMassing.building.staffel.map((s) => <path key={s.footprint.id} className="geometry-staffel is-scenario" d={pathFor(s.footprint.geometry, project)} />)}
                      </g>
                    )}
                    {scenario === "baseline" && geometry.buildings.map((b) => (
                      <g key={b.id}>
                        <path
                          className="geometry-building"
                          d={pathFor(b.footprint.geometry, project)}
                          onPointerDown={(event) => dragBuilding(b, event)}
                          onClick={(event) => {
                            if (tool === "select") {
                              event.stopPropagation();
                              selectId(b.id);
                            }
                          }}
                        />
                        {b.staffel.map((s) => (
                          <path
                            key={s.footprint.id}
                            className="geometry-staffel"
                            d={pathFor(s.footprint.geometry, project)}
                            onPointerDown={(event) => dragStaffel(b, s, event)}
                            onClick={(event) => {
                              if (tool === "select") {
                                event.stopPropagation();
                                selectId(s.footprint.id);
                              }
                            }}
                          />
                        ))}
                      </g>
                    ))}
                    {(tool === "edge" || selected?.kind === "edge") &&
                      geometry.parcel?.geometry.map((polygon, pi) =>
                        polygon.map((ring, ri) =>
                          ring.slice(0, -1).map((p, ei) => {
                            const q = ring[ei + 1]!;
                            const [x1, y1] = project(p), [x2, y2] = project(q);
                            const setback = geometry.setbacks.find((e) => e.polygonIndex === pi && e.ringIndex === ri && e.edgeIndex === ei);
                            const active = selectedEdge?.polygonIndex === pi && selectedEdge.ringIndex === ri && selectedEdge.edgeIndex === ei;
                            return (
                              <g key={`${pi}-${ri}-${ei}`}>
                                <line
                                  className={`geometry-edge${active ? " is-selected" : ""}${setback?.reviewed ? " is-reviewed" : ""}`}
                                  x1={x1}
                                  y1={y1}
                                  x2={x2}
                                  y2={y2}
                                  onClick={(event) => {
                                    if (tool !== "edge" && tool !== "select") return;
                                    event.stopPropagation();
                                    openEdge(pi, ri, ei);
                                  }}
                                >
                                  <title>{edgeName(pi, ri, ei)}</title>
                                </line>
                                {tool === "edge" && <text className="geometry-edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2}>{edgeName(pi, ri, ei).split(" · ")[0]}</text>}
                              </g>
                            );
                          }),
                        ),
                      )}
                    {geometry.mandatoryLines.map((line) => (
                      <polyline
                        key={line.id}
                        className="geometry-mandatory-line"
                        points={line.line.map((p) => project(p).join(",")).join(" ")}
                        onClick={(event) => {
                          if (tool === "select") {
                            event.stopPropagation();
                            selectId(line.id);
                          }
                        }}
                      />
                    ))}
                    {draft && <path className="geometry-draft" d={pathFor(draft.footprint, project)} />}
                    {points.length > 0 && (
                      <>
                        <polyline className="geometry-drawing" points={[...points, ...(hover ? [hover] : [])].map((p) => project(p).join(",")).join(" ")} />
                        {points.map((p, i) => {
                          const [x, y] = project(p);
                          return <circle key={i} className="geometry-drawing-vertex" cx={x} cy={y} r={i === 0 ? 5 : 4} />;
                        })}
                      </>
                    )}
                  </svg>
                  {tool === "select" && selectedRing && !disabled && scenario === "baseline" && (
                    <OutlineEditorLayer
                      draft={{
                        polygon: selectedRing.slice(0, -1).map((p) => {
                          const [x, y] = project(p);
                          return { x: x / width, y: y / height };
                        }),
                        holes: [],
                      }}
                      labels={{ point: label("Point"), addPoint: label("AddPoint"), edge: label("DragEdge") }}
                      edges
                      onBegin={beginGesture}
                      onChange={(draft) =>
                        updateEvidence({
                          ...selectedEvidence!,
                          reviewed: false,
                          geometry: [[closeRing(draft.polygon.map(unproject)), ...selectedEvidence!.geometry[0]!.slice(1)], ...selectedEvidence!.geometry.slice(1)],
                        })
                      }
                    />
                  )}
                  <div className="geometry-scale text-ui-2xs" aria-hidden="true">
                    <span>N ↑</span>
                    <span className="geometry-scale-bar" style={{ width: bar.pixels }} />
                    <span>{format(bar.metres)} m</span>
                  </div>
                </div>
              )}
              {!geometry.parcel && !alkis.length && (
                <div className="geometry-empty">
                  <p className="text-ui-sm">{label("EmptyTitle")}</p>
                  <p className="text-ui-xs muted">{label("NeedParcel")}</p>
                  {emptyAction}
                  <Button size="sm" variant="outline" disabled={berlin.isFetching} onClick={() => void berlin.refetch()}>
                    {label(berlin.isFetching ? "MassingLoadingParcels" : "MassingLoadParcels")}
                  </Button>
                  {berlin.isError && <small className="text-ui-2xs muted">{(berlin.error as Error).message}</small>}
                </div>
              )}
              {scenario === "baseline" && (geometry.parcel || alkis.length > 0) && (
                <section className="geometry-massing" aria-label={label("MassingTitle")} style={{ "--massing-w": `${widths.massing}px` } as CSSProperties}>
                  <ResizeHandle edge="left" value={widths.massing} min={240} max={560} onChange={(massing) => widths.set({ massing })} label={label("ResizeMassing")} style={{ left: 0 }} />
                  <ol className="geometry-massing-steps text-ui-2xs">
                    {([["Parcel", !!geometry.parcel], ["Footprint", geometry.buildings.length > 0], ["Height", !!focusBuilding]] as const).map(([step, done], i) => (
                      <li key={step} data-done={done}>
                        {done ? <Check className="size-icon-sm" aria-hidden="true" /> : <span aria-hidden="true">{i + 1}</span>}
                        {label(`MassingStep${step}`)}
                      </li>
                    ))}
                  </ol>
                  {pickedParcel ? (
                    <div className="geometry-massing-row">
                      <span className="text-ui-xs"><strong>{pickedParcel.label}</strong>{pickedParcel.area !== null && <span className="muted"> · {format(pickedParcel.area, 0)} m²</span>}</span>
                      <Button size="sm" variant={geometry.parcel ? "outline" : "default"} disabled={disabled} onClick={() => adoptParcel(pickedParcel)}>
                        {label(geometry.parcel ? "MassingReplaceParcel" : "MassingUseParcel")}
                      </Button>
                    </div>
                  ) : !geometry.parcel ? (
                    <p className="text-ui-xs muted">{label("MassingPickParcel")}</p>
                  ) : drawing && tool === "building" ? (
                    <p className="text-ui-xs muted">{label("MassingDrawHint")}</p>
                  ) : !focusBuilding ? (
                    geometry.buildings.length ? (
                      <p className="text-ui-xs muted">{label("MassingSelectBuilding")}</p>
                    ) : (
                      <div className="geometry-massing-row">
                        <span className="text-ui-xs muted">{label("MassingDrawPrompt")}</span>
                        <Button size="sm" disabled={!canDraw} onClick={() => start("building")}>
                          <Building2 className="size-icon-sm" aria-hidden="true" />
                          {label("MassingDrawFootprint")}
                        </Button>
                      </div>
                    )
                  ) : null}
                  {siteFigures && !pickedParcel && (
                    <dl className="geometry-massing-values geometry-massing-site text-ui-xs" aria-label={label("MassingSiteFigures")}>
                      <dt>{label("MassingFootprintArea")}</dt>
                      <dd>{format(siteFigures.footprint, 0)} m²</dd>
                      {([["GRZ", siteFigures.grz, options?.grz], ["GFZ", siteFigures.gfz, options?.gfz]] as const).map(([name, value, limit]) => (
                        <Fragment key={name}>
                          <dt>{name}</dt>
                          <dd data-over={limit != null && value > limit + 1e-6}>
                            <strong>{format(value, 2)}</strong>
                            {limit != null && <span className="muted"> / {label("MassingLimit").replace("{value}", format(limit, 2))}</span>}
                          </dd>
                        </Fragment>
                      ))}
                    </dl>
                  )}
                  {focusBuilding && !pickedParcel && !(drawing && tool === "building") && (() => {
                    const check = setbackChecks.find((c) => c.id === focusBuilding.id);
                    const bgf = floorArea(focusBuilding);
                    return (
                      <>
                        <div className="geometry-massing-fields">
                          <Field label={label("MassingFloors")}>
                            <div className="geometry-stepper">
                              <Button size="icon-sm" variant="outline" aria-label={label("MassingFloorsLess")} disabled={disabled || focusBuilding.fullStoreys <= 1} onClick={() => setStoreys(focusBuilding, { fullStoreys: focusBuilding.fullStoreys - 1 })}>
                                <Minus className="size-icon-sm" />
                              </Button>
                              <Input
                                type="number"
                                min={1}
                                max={200}
                                step={1}
                                disabled={disabled}
                                value={focusBuilding.fullStoreys}
                                aria-label={label("MassingFloors")}
                                onChange={(e) => {
                                  const n = e.target.valueAsNumber;
                                  if (Number.isInteger(n) && n >= 1 && n <= 200) setStoreys(focusBuilding, { fullStoreys: n });
                                }}
                              />
                              <Button size="icon-sm" variant="outline" aria-label={label("MassingFloorsMore")} disabled={disabled || focusBuilding.fullStoreys >= 200} onClick={() => setStoreys(focusBuilding, { fullStoreys: focusBuilding.fullStoreys + 1 })}>
                                <Plus className="size-icon-sm" />
                              </Button>
                            </div>
                          </Field>
                          <span className="geometry-massing-times" aria-hidden="true">×</span>
                          <Field label={label("MassingFloorHeight")}>
                            <Input
                              type="number"
                              min={2}
                              max={20}
                              step={0.1}
                              disabled={disabled}
                              value={focusBuilding.storeyHeight}
                              onChange={(e) => {
                                const n = e.target.valueAsNumber;
                                if (Number.isFinite(n) && n > 0 && n <= 20) setStoreys(focusBuilding, { storeyHeight: n });
                              }}
                            />
                          </Field>
                        </div>
                        <dl className="geometry-massing-values text-ui-xs">
                          <dt>{label("MassingHeight")}</dt>
                          <dd>{format(buildingHeight(focusBuilding), 1)} m</dd>
                          <dt>BGF</dt>
                          <dd><strong>{bgf === null ? "–" : `${format(bgf, 0)} m²`}</strong></dd>
                          {check && (
                            <>
                              <dt>{label("MassingSetback")}</dt>
                              <dd>{label("MassingSetbackDepth").replace("{depth}", format(check.depth, 1))}</dd>
                            </>
                          )}
                          {check?.upperDepth != null && (
                            <>
                              <dt>{label("MassingSetbackStaffel")}</dt>
                              <dd>{label("MassingSetbackStaffelDepth").replace("{depth}", format(check.upperDepth, 1))}</dd>
                            </>
                          )}
                        </dl>
                        {!disabled && (
                          <Button size="sm" variant="outline" className="geometry-massing-action" disabled={!engine} onClick={() => addStaffel(focusBuilding)}>
                            <Plus className="size-icon-sm" aria-hidden="true" />
                            {label("MassingAddStaffel")}
                          </Button>
                        )}
                        {check && (
                          <p className="geometry-massing-check text-ui-xs" data-ok={check.ok} role="status">
                            <span className="geometry-massing-swatch" aria-hidden="true" />
                            {check.ok
                              ? label("MassingSetbackClear")
                              : [
                                  check.outsideParcel > 0.01 && label("MassingSetbackOutside").replace("{area}", format(check.outsideParcel, 0)),
                                  check.overlap > 0.01 && label("MassingSetbackOverlap").replace("{area}", format(check.overlap, 0)),
                                ].filter(Boolean).join(" · ") || label("MassingSetbackFailed")}
                          </p>
                        )}
                        {view === "2d" && scene && (
                          <Button size="sm" variant="outline" className="geometry-massing-action" onClick={() => setView("3d")}>
                            <Box className="size-icon-sm" aria-hidden="true" />
                            {label("MassingExtrude3D")}
                          </Button>
                        )}
                        <small className="text-ui-2xs muted">{label(view === "3d" ? "MassingDragHint" : "MassingSetbackNote")}</small>
                      </>
                    );
                  })()}
                </section>
              )}
              {scenario === "upside" && upsideMassing && (
                <div className="geometry-canvas-caption" role="status">
                  <span>{label("ScenarioHint").replace("{storeys}", String(upsideStoreys ?? "–")).replace("{bgf}", format(upsideMassing.grossFloorArea, 0))}</span>
                  {onScenario && <Button size="sm" variant="ghost" onClick={() => onScenario("baseline")}>{label("ScenarioBack")}</Button>}
                </div>
              )}
              {scenario === "baseline" && (drawing || pickingAlignment || tool === "edge" || tool === "reference") && (
                <div className="geometry-canvas-caption" role="status">
                  <span>
                    {pickingAlignment
                      ? t("sitePlanPickMap")
                      : drawing
                        ? label("DrawHint").replace("{tool}", t(`siteGeometry${tool}` as Key)).replace("{count}", String(points.length))
                        : label(tool === "edge" ? "EdgeHint" : "ReferenceHint")}
                  </span>
                  {drawing && (
                    <span className="geometry-caption-actions">
                      <Button size="sm" disabled={points.length < (tool === "line" ? 2 : 3)} onClick={finish}>{label("Finish")}</Button>
                      <Button size="sm" variant="outline" disabled={!points.length} onClick={() => setPoints((p) => p.slice(0, -1))}>{label("UndoPoint")}</Button>
                      <Button size="sm" variant="ghost" onClick={() => start("select")}>{label("Cancel")}</Button>
                    </span>
                  )}
                  {!drawing && !pickingAlignment && <Button size="sm" variant="ghost" onClick={() => start("select")}>{label("Done")}</Button>}
                </div>
              )}
            </div>
          </div>
          <aside className="geometry-inspector" aria-label={label("Inspector")}>
            <Segmented
              value={tab}
              onChange={setTab}
              items={[
                { value: "properties", label: label("Properties") },
                { value: "checks", label: groupedIssues.length ? `${label("Checks")} · ${pendingIssues.length}` : label("Checks") },
              ]}
            />
            {tab === "checks" ? (
              groupedIssues.length === 0 ? (
                <p className="text-ui-xs muted">{result ? label("NoIssues") : label("NeedParcel")}</p>
              ) : (
                <ul className="geometry-issue-list">
                  {groupedIssues.map(([code, issues]) => (
                    <li key={code}>
                      <strong className="text-ui-xs">{t(`siteGeometry${code}` as Key) || label("ReviewGeometry")}</strong>
                      <div className="geometry-issue-actions">
                        {(issues ?? []).map((issue, i) => (
                          <Button key={i} variant="outline" size="sm" onClick={() => reviewIssue(code, issue.id)}>
                            {issueTarget(issue.id)?.name ?? label(code === "missing_envelope" ? "envelope" : "Review")}
                          </Button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <>
                {!selected && (
                  <>
                    <h3>{label("Summary")}</h3>
                    {result && geometry.parcel ? (
                      <dl className="geometry-values">
                        <dt>{label("Status")}</dt>
                        <dd><Badge variant="outline">{label(result.status)}</Badge></dd>
                        <dt>{label("ParcelArea")}</dt>
                        <dd>{format(result.parcelArea)} m²</dd>
                        <dt>{label("Usable")}</dt>
                        <dd>{format(result.usableArea)} m²</dd>
                        {result.buildings.map((b) => {
                          const index = geometry.buildings.findIndex((x) => x.id === b.id);
                          return [
                            <dt key={`${b.id}-n`}>{index >= 0 ? buildingName(geometry.buildings[index]!, index) : label("ObjectBuilding")}</dt>,
                            <dd key={`${b.id}-v`}>GF {format(b.countableFloorArea)} m² · BGF {format(b.grossFloorArea)} m²<br /><small className="muted">{label(b.validPlacement ? "Fits" : "DoesNotFit")}</small></dd>,
                          ];
                        })}
                      </dl>
                    ) : (
                      <p className="text-ui-xs muted">{label("NeedParcel")}</p>
                    )}
                    {onUseArea && result && geometry.parcel && (
                      <div className="geometry-review">
                        <Button size="sm" variant="outline" disabled={disabled || !result.usableArea} onClick={() => onUseArea(result.usableArea)}>
                          {label("UseArea")}
                        </Button>
                        <small className="muted">{label("UseAreaHint").replace("{area}", format(result.usableArea))}</small>
                      </div>
                    )}
                    {engine && geometry.parcel && (
                      <div className="geometry-review">
                        <h3>{label("CandidatesTitle")}</h3>
                        <Button variant="outline" size="sm" disabled={disabled || !options} onClick={() => options && setCandidates(engine.generateMassingCandidates(geometry, options))}>
                          {label("Candidates")}
                        </Button>
                        {!options && <small className="muted">{label("CandidatesNeed")}</small>}
                        {candidates.map((candidate, i) => {
                          const name = `${label("Variant")} ${i + 1} · ${label(candidate.strategy)}`;
                          return (
                            <div key={candidate.id} className="geometry-candidate text-ui-xs">
                              <strong>{name}</strong>
                              <span>GF {format(candidate.metrics.countableFloorArea)} m² · BGF {format(candidate.metrics.grossFloorArea)} m²</span>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={disabled}
                                onClick={() => {
                                  update({ buildings: [{ ...candidate.building, label: name, footprint: { ...candidate.building.footprint, label: name } }] });
                                  setSelected({ kind: "building", id: candidate.building.id });
                                }}
                              >
                                {label("UseVariant")}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <p className="text-ui-2xs muted">{label("SelectHint")}</p>
                  </>
                )}
                {selectedEvidence && selected && selected.kind !== "edge" && selected.kind !== "line" && (
                  <>
                    <div className="geometry-inspector-heading">
                      <h3>{label(`Kind${selected.kind}`)}</h3>
                      {reviewState(selectedEvidence.reviewed)}
                    </div>
                    {(selected.kind === "building" || selected.kind === "exclusion" || selected.kind === "staffel") && (
                      <Field label={label("Name")}>
                        <Input
                          disabled={disabled}
                          maxLength={200}
                          value={selected.kind === "building" && selectedBuilding ? buildingName(selectedBuilding, geometry.buildings.indexOf(selectedBuilding)) : selectedEvidence.label}
                          onChange={(e) =>
                            selected.kind === "building" && selectedBuilding
                              ? patchBuilding(selectedBuilding.id, (b) => ({ ...b, label: e.target.value, footprint: { ...b.footprint, label: e.target.value } }))
                              : updateEvidence({ ...selectedEvidence, label: e.target.value })
                          }
                        />
                      </Field>
                    )}
                    {evidenceFields(selectedEvidence, (patch) => updateEvidence({ ...selectedEvidence, ...patch }))}
                    <div className="geometry-move" role="group" aria-label={label("Move")}>
                      <span className="text-ui-xs">{label("Move")}</span>
                      {([[0, 1, "↑"], [0, -1, "↓"], [-1, 0, "←"], [1, 0, "→"]] as const).map(([x, y, s]) => (
                        <Button key={s} size="icon-sm" variant="outline" disabled={disabled} aria-label={`${label("Move")} ${s}`} onClick={() => shift(x, y)}>
                          {s}
                        </Button>
                      ))}
                    </div>
                  </>
                )}
                {selectedBuilding && selected?.kind === "building" && (
                  <>
                    <h3>{label("StoreysTitle")}</h3>
                    {numberField(label("FullStoreys"), selectedBuilding.fullStoreys, (n) => n !== null && n > 0 && patchBuilding(selectedBuilding.id, (b) => ({ ...b, fullStoreys: n, storeysReviewed: false })), { min: 1, step: 1, integer: true })}
                    {numberField(label("StoreyHeight"), selectedBuilding.storeyHeight, (n) => n !== null && n > 0 && patchBuilding(selectedBuilding.id, (b) => ({ ...b, storeyHeight: n, storeysReviewed: false })))}
                    <Field label={label("StoreysSource")}>
                      <Input value={selectedBuilding.storeysSource} disabled={disabled} onChange={(e) => patchBuilding(selectedBuilding.id, (b) => ({ ...b, storeysSource: e.target.value, storeysReviewed: false }))} />
                    </Field>
                    <div className="geometry-review">
                      <label className="site-review text-ui-xs">
                        <Checkbox checked={selectedBuilding.storeysReviewed} disabled={disabled || !selectedBuilding.storeysSource.trim()} onCheckedChange={(v) => patchBuilding(selectedBuilding.id, (b) => ({ ...b, storeysReviewed: v === true }))} />
                        {label("StoreysReviewed")}
                      </label>
                      {!selectedBuilding.storeysReviewed && !selectedBuilding.storeysSource.trim() && reviewHint([label("StoreysSource")])}
                    </div>
                    <Button size="sm" variant="outline" disabled={!canDraw} onClick={() => start("staffel")}>
                      {label("AddStaffel")}
                    </Button>
                  </>
                )}
                {selectedStaffel && selectedBuilding && (
                  <>
                    <h3>{label("StaffelTitle")}</h3>
                    {(() => {
                      const area = engine ? engine.geometryArea(selectedStaffel.footprint.geometry) : 0, below = engine ? engine.geometryArea(selectedBuilding.footprint.geometry) : 0;
                      const share = below > 0 ? area / below : 0;
                      return (
                        <div className="geometry-staffel-share">
                          <p className="text-ui-xs">{label("StaffelArea").replace("{area}", format(area, 0)).replace("{share}", format(share * 100, 0))}</p>
                          {!disabled && (
                            <Field label={label("MassingStaffelShare")}>
                              <Segmented
                                value={share > 0.7 ? "0.75" : staffelRule && Math.abs(share - staffelRule.share) < 0.02 ? String(staffelRule.share) : ""}
                                onChange={(v) => reshapeStaffel(selectedBuilding, selectedStaffel, Number(v))}
                                items={[...(staffelRule ? [{ value: String(staffelRule.share), label: label("StaffelBelowThreshold").replace("{share}", shareText(staffelRule.threshold)) }] : []), { value: "0.75", label: "75 %" }]}
                              />
                            </Field>
                          )}
                          {staffelRule && (
                            <p className="text-ui-2xs muted">
                              {label("StaffelRuleHint").replace("{rule}", staffelRule.rule).replace("{share}", shareText(staffelRule.threshold))}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    {numberField(label("StaffelHeight"), selectedStaffel.height, (n) => n !== null && n > 0 && patchBuilding(selectedBuilding.id, (b) => ({ ...b, staffel: b.staffel.map((x) => (x === selectedStaffel ? { ...x, height: n, classificationReviewed: false } : x)) })))}
                    {(["areaAbove230", "averageTopAboveTerrain"] as const).map((key) => (
                      <div key={key}>{numberField(label(key), selectedStaffel[key], (n) => patchBuilding(selectedBuilding.id, (b) => ({ ...b, staffel: b.staffel.map((x) => (x === selectedStaffel ? { ...x, [key]: n, classificationReviewed: false } : x)) })))}</div>
                    ))}
                    <label className="site-review text-ui-xs">
                      <Checkbox checked={selectedStaffel.countable} disabled={disabled} onCheckedChange={(v) => patchBuilding(selectedBuilding.id, (b) => ({ ...b, staffel: b.staffel.map((x) => (x === selectedStaffel ? { ...x, countable: v === true, classificationReviewed: false } : x)) }))} />
                      {label("Countable")}
                    </label>
                    <div className="geometry-review">
                      <label className="site-review text-ui-xs">
                        <Checkbox
                          checked={selectedStaffel.classificationReviewed}
                          disabled={disabled || selectedStaffel.areaAbove230 === null || selectedStaffel.averageTopAboveTerrain === null || !selectedStaffel.footprint.reviewed}
                          onCheckedChange={(v) => patchBuilding(selectedBuilding.id, (b) => ({ ...b, staffel: b.staffel.map((x) => (x === selectedStaffel ? { ...x, classificationReviewed: v === true } : x)) }))}
                        />
                        {label("ClassificationReviewed")}
                      </label>
                      {!selectedStaffel.classificationReviewed &&
                        reviewHint([
                          selectedStaffel.areaAbove230 === null && label("areaAbove230"),
                          selectedStaffel.averageTopAboveTerrain === null && label("averageTopAboveTerrain"),
                          !selectedStaffel.footprint.reviewed && label("Reviewed"),
                        ].filter(Boolean) as string[])}
                    </div>
                  </>
                )}
                {selectedLine && (
                  <>
                    <div className="geometry-inspector-heading">
                      <h3>{label("Kindline")}</h3>
                      {reviewState(selectedLine.reviewed)}
                    </div>
                    <Field label={label("Name")}>
                      <Input disabled={disabled} maxLength={200} value={lineName(selectedLine, geometry.mandatoryLines.indexOf(selectedLine))} onChange={(e) => update({ mandatoryLines: geometry.mandatoryLines.map((l) => (l.id === selectedLine.id ? { ...l, label: e.target.value } : l)) })} />
                    </Field>
                    {evidenceFields(selectedLine, (patch) => update({ mandatoryLines: geometry.mandatoryLines.map((l) => (l.id === selectedLine.id ? { ...l, ...patch } : l)) }))}
                  </>
                )}
                {selectedEdge && (
                  <>
                    <div className="geometry-inspector-heading">
                      <h3>{edgeName(selectedEdge.polygonIndex, selectedEdge.ringIndex, selectedEdge.edgeIndex)}</h3>
                      {reviewState(selectedEdge.reviewed)}
                    </div>
                    {(() => {
                      const patchEdge = (patch: Partial<typeof selectedEdge>) => update({ setbacks: geometry.setbacks.map((x) => (x.id === selectedEdge.id ? { ...x, ...patch } : x)) });
                      const needsDistance = selectedEdge.profile === "manual" || selectedEdge.profile === "boundary_exception";
                      return (
                        <>
                          <Field label={label("Profile")}>
                            <NativeSelect disabled={disabled} value={selectedEdge.profile} onChange={(e) => patchEdge({ profile: e.target.value as typeof selectedEdge.profile, reviewed: false, reviewedHeight: null })}>
                              {["manual", "standard", "commercial", "low_class", "boundary_exception"].map((v) => (
                                <option key={v} value={v}>{label(v)}</option>
                              ))}
                            </NativeSelect>
                          </Field>
                          {!needsDistance && (
                            <>
                              <Field label={label("HeightSource")}>
                                <NativeSelect disabled={disabled} value={selectedEdge.heightSource} onChange={(e) => patchEdge({ heightSource: e.target.value as typeof selectedEdge.heightSource, reviewed: false, reviewedHeight: null })}>
                                  <option value="manual">{label("ManualHeight")}</option>
                                  <option value="buildings">{label("BuildingHeight")}</option>
                                </NativeSelect>
                              </Field>
                              {selectedEdge.heightSource === "manual" && numberField(label("AssessmentHeight"), selectedEdge.assessmentHeight, (n) => patchEdge({ assessmentHeight: n, reviewed: false, reviewedHeight: null }))}
                            </>
                          )}
                          {numberField(label("Distance"), selectedEdge.distance, (n) => patchEdge({ distance: n !== null && n >= 0 ? n : null, reviewed: false }))}
                          <Field label={label("Source")}>
                            <Input disabled={disabled} value={selectedEdge.source} onChange={(e) => patchEdge({ source: e.target.value, reviewed: false })} />
                          </Field>
                          <Field label={label("Date")}>
                            <DateInput disabled={disabled} value={selectedEdge.sourceDate} onValueChange={(sourceDate) => patchEdge({ sourceDate, reviewed: false })} />
                          </Field>
                          {(() => {
                            const missing = [...evidenceMissing(selectedEdge), ...(needsDistance && selectedEdge.distance === null ? [label("Distance")] : [])];
                            return (
                              <div className="geometry-review">
                                <label className="site-review text-ui-xs">
                                  <Checkbox
                                    disabled={disabled || missing.length > 0}
                                    checked={selectedEdge.reviewed}
                                    onCheckedChange={(v) =>
                                      patchEdge({
                                        reviewed: v === true,
                                        reviewedHeight:
                                          selectedEdge.heightSource === "buildings"
                                            ? geometry.buildings.length
                                              ? Math.max(...geometry.buildings.map((b) => Math.max(b.height ?? 0, b.fullStoreys * b.storeyHeight + b.staffel.reduce((h, s) => h + s.height, 0))))
                                              : null
                                            : selectedEdge.assessmentHeight,
                                      })
                                    }
                                  />
                                  {label("Reviewed")}
                                </label>
                                {!selectedEdge.reviewed && reviewHint(missing)}
                              </div>
                            );
                          })()}
                        </>
                      );
                    })()}
                  </>
                )}
                {selected && !disabled && (
                  <Button variant="ghost" size="sm" className="geometry-remove" onClick={removeSelected}>
                    {label(selected.kind === "edge" ? "ResetEdge" : "Remove")}
                  </Button>
                )}
              </>
            )}
          </aside>
        </div>
        <footer className="geometry-status">
          {result && <Badge variant="outline">{label(result.status)}</Badge>}
          <span>
            {result ? `${label("Usable")} ${format(result.usableArea)} m²` : label("NeedParcelShort")}
            {scenario === "upside" && upsideMassing
              ? ` · ${label("ScenarioUpside")}: GF ${format(upsideMassing.countableFloorArea)} m² · BGF ${format(upsideMassing.grossFloorArea)} m²`
              : result?.buildings.length ? ` · GF ${format(result.buildings.reduce((n, b) => n + b.countableFloorArea, 0))} m² · BGF ${format(result.buildings.reduce((n, b) => n + b.grossFloorArea, 0))} m²` : ""}
          </span>
          <span>{view === "2d" && hover ? `EPSG:25833 · ${hover.map((n) => n.toFixed(2)).join(" / ")}` : "EPSG:25833 · N ↑"}</span>
          <span>{label(view === "2d" ? "StatusHint" : "StatusHint3D")}</span>
        </footer>
        {/* Plan alignment as a drawer at the bottom of the workbench, so the editor stays one full window. */}
        <div className="geometry-plan-drawer">
          <SitePlanAlignment
            projectId={projectId}
            overlay={geometry.planOverlay}
            disabled={disabled}
            pickedSite={pickedSite}
            onRequestSite={() => {
              setView("2d");
              setPickingAlignment(true);
            }}
            onChange={(planOverlay) => update({ planOverlay })}
            parcel={geometry.parcel}
            envelopeReviewed={!!geometry.envelope?.reviewed}
            onTrace={(traced) => {
              // A new trace replaces earlier unreviewed traced lines; lines a person drew or reviewed stay.
              update({
                envelope: traced.envelope ?? geometry.envelope,
                mandatoryLines: [...geometry.mandatoryLines.filter((l) => l.reviewed || !l.id.startsWith(TRACED_LINE_PREFIX)), ...traced.lines],
              });
              if (traced.envelope) setSelected({ kind: "envelope", id: "envelope" });
            }}
          />
        </div>
      </section>
    </>
  );
}
