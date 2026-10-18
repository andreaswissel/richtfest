import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LocationContext,
  LocationState,
  LocationBuilding,
} from "@richtfest/shared";
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
import { Input } from "../ui/input";
import { Badge, Callout, Field, Segmented } from "../ui/primitives";
import { NativeSelect } from "../ui/native-select";
import { OutlineEditorLayer } from "../building-model/outline-editor";
import { fromLocal, toLocal } from "../location/site-geometry";
import type { createViewport, ViewportState } from "../location/viewport";
import "./site-geometry-editor.css";
import { SitePlanAlignment, usePlanRaster } from "./site-plan-overlay";

type Engine = typeof import("@richtfest/shared/site-geometry");
type Selection = {
  kind:
    | "parcel"
    | "line"
    | "envelope"
    | "exclusion"
    | "building"
    | "staffel"
    | "edge";
  id: string;
} | null;
type Tool =
  | "pan"
  | "select"
  | "line"
  | "envelope"
  | "exclusion"
  | "building"
  | "staffel"
  | "edge"
  | "reference";
const evidence = (label: string, ring: GeometryPoint[]): GeometryEvidence => ({
  id: crypto.randomUUID(),
  label,
  geometry: [[ring]],
  source: "",
  sourceDate: null,
  reviewed: false,
});
const closeRing = (points: GeometryPoint[]) =>
  [...points, points[0]!] as GeometryPoint[];
const pathFor = (
  geometry: GeometryMultiPolygon,
  project: (p: GeometryPoint) => GeometryPoint,
) =>
  geometry
    .map((polygon) =>
      polygon
        .map(
          (ring) =>
            ring
              .map((p, i) => `${i ? "L" : "M"}${project(p).join(",")}`)
              .join(" ") + "Z",
        )
        .join(" "),
    )
    .join(" ");

/** Explicit height describes the whole building, including its separate Staffel volumes. */
export function fullStoreyMeshHeight(building: BuildingGeometry) {
  const staffelHeight = building.staffel.reduce((sum, storey) => sum + storey.height, 0);
  return Math.max(building.fullStoreys * building.storeyHeight, (building.height ?? 0) - staffelHeight);
}

function Geometry3D({
  context,
  geometry,
  onSelect,
}: {
  context: LocationContext;
  geometry: SiteGeometryInput;
  onSelect: (id: string | null) => void;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null),
    viewport = useRef<ReturnType<typeof createViewport> | null>(null),
    select = useRef(onSelect);
  select.current = onSelect;
  const dark = usePreferences((s) => s.theme) === "dark";
  const [ready, setReady] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void import("../location/viewport").then(({ createViewport }) => {
      if (!active || !host.current) return;
      try {
        viewport.current = createViewport(host.current, {
          select: (id) => select.current(id),
          place: () => {},
          measure: () => {},
          align: () => {},
        });
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
  useEffect(() => {
    if (!ready || !viewport.current) return;
    const local = (g: GeometryMultiPolygon) =>
      g.map((p) => p.map((r) => r.map((point) => toLocal(context, point))));
    const assessment: NonNullable<ViewportState["assessment"]> = [];
    if (geometry.parcel)
      assessment.push({
        id: "parcel",
        polygons: local(geometry.parcel.geometry),
        base: 0.05,
        height: 0,
        color: 0x64748b,
      });
    if (geometry.envelope)
      assessment.push({
        id: "envelope",
        polygons: local(geometry.envelope.geometry),
        base: 0.1,
        height: 0,
        color: 0x10b981,
      });
    geometry.exclusions.forEach((x) =>
      assessment.push({
        id: x.id,
        polygons: local(x.geometry),
        base: 0.15,
        height: 0,
        color: 0xef4444,
      }),
    );
    geometry.buildings.forEach((b) => {
      const height = fullStoreyMeshHeight(b);
      assessment.push({
        id: b.id,
        polygons: local(b.footprint.geometry),
        base: 0.2,
        height,
        color: 0x6366f1,
      });
      let base = height + 0.2;
      b.staffel.forEach((s) => {
        assessment.push({
          id: s.footprint.id,
          polygons: local(s.footprint.geometry),
          base,
          height: s.height,
          color: 0x818cf8,
        });
        base += s.height;
      });
    });
    viewport.current.update({
      context,
      assessment,
      objects: [],
      models: {},
      layers: {
        buildings: true,
        trees: false,
        objects: true,
        lidar: false,
        roads: false,
        railNoise: false,
        plan: false,
        aerial: false,
      },
      site: {
        axes: [],
        plan: null,
        distances: [],
        railNoise: null,
        aerial: { near: null, far: null },
        picks: [],
        snaps: [],
      },
      selected: null,
      tool: "select",
      treeStyle: "schematic",
      measurement: [],
      clipHeight: 200,
      dark,
      constructionLabel: "",
      siteFootprintLabel: "",
      siteAddressLabel: context.address,
    });
  }, [context, geometry, ready, dark]);
  return (
    <div className="geometry-3d" ref={host}>
      {error && <Callout>{t("siteGeometryWebGLUnavailable")}</Callout>}
    </div>
  );
}

export function SiteGeometryEditor({
  projectId,
  value,
  disabled,
  options,
  onChange,
  onReference,
  onUseArea,
  contextOverride,
}: {
  projectId: string;
  value: SiteGeometryInput | null;
  disabled: boolean;
  options: MassingOptions | null;
  onChange: (v: SiteGeometryInput) => void;
  onReference?: (building: LocationBuilding, context: LocationContext) => void;
  contextOverride?: LocationContext | null;
  onUseArea?: (area: number) => void;
}) {
  const t = useT(),
    language = usePreferences((s) => s.language),
    label = (key: string) => t(`siteGeometry${key}` as Parameters<typeof t>[0]);
  const location = useApi(`/projects/${projectId}/location`),
    context =
      contextOverride ?? (location.data as LocationState | undefined)?.context;
  const geometry = useMemo(() => {
    const parsed = siteGeometryInputSchema.safeParse(value);
    return parsed.success
      ? parsed.data
      : {
          ...createEmptySiteGeometryInput(),
          ...value,
          mandatoryLines: value?.mandatoryLines ?? [],
          planOverlay: value?.planOverlay ?? null,
        };
  }, [value]);
  const [frame, setFrame] = useState({ zoom: 1, x: 0, y: 0 });
  const panStart = useRef<{
    clientX: number;
    clientY: number;
    frame: typeof frame;
  } | null>(null);
  const planImage = usePlanRaster(projectId, geometry.planOverlay);
  const [pickingAlignment, setPickingAlignment] = useState(false),
    [pickedSite, setPickedSite] = useState<GeometryPoint | null>(null);
  const [engine, setEngine] = useState<Engine>(),
    [result, setResult] = useState<SiteGeometryResult>(),
    [candidates, setCandidates] = useState<MassingCandidate[]>([]),
    [selected, setSelected] = useState<Selection>(null),
    [tool, setTool] = useState<Tool>("select"),
    [points, setPoints] = useState<GeometryPoint[]>([]),
    [view, setView] = useState("2d");
  const selectedBuilding = geometry.buildings.find(
    (b) =>
      b.id === selected?.id ||
      b.staffel.some((s) => s.footprint.id === selected?.id),
  );
  const selectedEvidence =
    selected?.kind === "parcel"
      ? geometry.parcel
      : selected?.kind === "envelope"
        ? geometry.envelope
        : selected?.kind === "exclusion"
          ? geometry.exclusions.find((e) => e.id === selected.id)
          : selected?.kind === "building"
            ? selectedBuilding?.footprint
            : selected?.kind === "staffel"
              ? selectedBuilding?.staffel.find(
                  (s) => s.footprint.id === selected.id,
                )?.footprint
              : null;
  const selectedLine =
    selected?.kind === "line"
      ? geometry.mandatoryLines.find((l) => l.id === selected.id)
      : null;
  const selectedStaffel =
    selected?.kind === "staffel"
      ? selectedBuilding?.staffel.find((s) => s.footprint.id === selected.id)
      : null;
  const selectedEdge =
    selected?.kind === "edge"
      ? geometry.setbacks.find((e) => e.id === selected.id)
      : null;
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
  const update = (patch: Partial<SiteGeometryInput>) =>
    onChange({ ...geometry, ...patch });
  const updateEvidence = (next: GeometryEvidence) => {
    if (selected?.kind === "parcel")
      update({
        parcel: next,
        ...(next.geometry !== geometry.parcel?.geometry
          ? { setbacks: [] }
          : {}),
      });
    if (selected?.kind === "envelope") update({ envelope: next });
    if (selected?.kind === "exclusion")
      update({
        exclusions: geometry.exclusions.map((e) =>
          e.id === next.id ? next : e,
        ),
        exclusionsReviewed: false,
      });
    if (selected?.kind === "building" || selected?.kind === "staffel")
      update({
        buildings: geometry.buildings.map((b) =>
          b.id !== selectedBuilding?.id
            ? b
            : selected.kind === "building"
              ? { ...b, footprint: next, storeysReviewed: false }
              : {
                  ...b,
                  staffel: b.staffel.map((s) =>
                    s.footprint.id === next.id
                      ? { ...s, footprint: next, classificationReviewed: false }
                      : s,
                  ),
                },
        ),
      });
  };
  const baseBounds = useMemo(() => {
    const pts =
      geometry.parcel?.geometry.flat(2) ??
      context?.buildings.flatMap((b) =>
        b.polygons.flat(2).map((p) => fromLocal(context, p)),
      ) ??
      [];
    if (!pts.length) return { x: 0, y: 0, size: 100 };
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
    const x = Math.min(...xs),
      y = Math.min(...ys),
      size = Math.max(10, Math.max(...xs) - x, Math.max(...ys) - y) * 1.2;
    return { x: x - size * 0.08, y: y - size * 0.08, size };
  }, [geometry.parcel, context]);
  const bounds = {
    x: baseBounds.x + (baseBounds.size * (1 - 1 / frame.zoom)) / 2 + frame.x,
    y: baseBounds.y + (baseBounds.size * (1 - 1 / frame.zoom)) / 2 + frame.y,
    size: baseBounds.size / frame.zoom,
  };
  const affine =
    geometry.planOverlay &&
    engine?.affineFromControlPoints(geometry.planOverlay.controlPoints);
  const overlayMatrix = affine
    ? `matrix(${(1000 * affine[0]) / bounds.size},${(-1000 * affine[3]) / bounds.size},${(1000 * affine[1]) / bounds.size},${(-1000 * affine[4]) / bounds.size},${(1000 * (affine[2] - bounds.x)) / bounds.size},${1000 - (1000 * (affine[5] - bounds.y)) / bounds.size})`
    : undefined;
  const project = (p: GeometryPoint): GeometryPoint => [
    ((p[0] - bounds.x) / bounds.size) * 1000,
    1000 - ((p[1] - bounds.y) / bounds.size) * 1000,
  ];
  const unproject = (p: { x: number; y: number }): GeometryPoint => [
    bounds.x + p.x * bounds.size,
    bounds.y + (1 - p.y) * bounds.size,
  ];
  const selectId = (id: string | null) => {
    if (!id) return setSelected(null);
    if (id.startsWith("building:") && context) {
      const b = context.buildings.find((b) => `building:${b.id}` === id);
      if (b && tool === "reference") onReference?.(b, context);
      return;
    }
    if (id === "parcel") setSelected({ kind: "parcel", id });
    else if (geometry.mandatoryLines.some((l) => l.id === id))
      setSelected({ kind: "line", id });
    else if (id === "envelope") setSelected({ kind: "envelope", id });
    else if (geometry.exclusions.some((e) => e.id === id))
      setSelected({ kind: "exclusion", id });
    else if (geometry.buildings.some((b) => b.id === id))
      setSelected({ kind: "building", id });
    else if (
      geometry.buildings.some((b) =>
        b.staffel.some((s) => s.footprint.id === id),
      )
    )
      setSelected({ kind: "staffel", id });
  };
  const start = (next: Tool) => {
    setView("2d");
    setTool(next);
    setPoints([]);
  };
  const finish = () => {
    if (tool === "line") {
      if (points.length < 2) return;
      const line = {
        id: crypto.randomUUID(),
        label: label("line"),
        line: points,
        source: "",
        sourceDate: null,
        reviewed: false,
      };
      update({ mandatoryLines: [...geometry.mandatoryLines, line] });
      setSelected({ kind: "line", id: line.id });
      setTool("select");
      setPoints([]);
      return;
    }
    if (points.length < 3) return;
    const e = evidence(label(tool), closeRing(points));
    if (tool === "envelope") {
      update({ envelope: e });
      setSelected({ kind: "envelope", id: e.id });
    }
    if (tool === "exclusion") {
      update({
        exclusions: [...geometry.exclusions, e],
        exclusionsReviewed: false,
      });
      setSelected({ kind: "exclusion", id: e.id });
    }
    if (tool === "building") {
      const b = {
        id: crypto.randomUUID(),
        label: label("building"),
        footprint: e,
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
      update({
        buildings: geometry.buildings.map((b) =>
          b.id === selectedBuilding.id
            ? {
                ...b,
                staffel: [
                  ...b.staffel,
                  {
                    footprint: e,
                    countable: true,
                    height: 3,
                    areaAbove230: null,
                    averageTopAboveTerrain: null,
                    classificationReviewed: false,
                  },
                ],
              }
            : b,
        ),
      });
      setSelected({ kind: "staffel", id: e.id });
    }
    setTool("select");
    setPoints([]);
  };
  const shift = (dx: number, dy: number) =>
    selectedEvidence &&
    updateEvidence({
      ...selectedEvidence,
      reviewed: false,
      geometry: selectedEvidence.geometry.map((p) =>
        p.map((r) => r.map(([x, y]) => [x + dx, y + dy])),
      ),
    });
  const format = (n: number) =>
    n.toLocaleString(language === "de" ? "de-DE" : "en-GB", {
      maximumFractionDigits: 2,
    });
  const selectedRing = selectedEvidence?.geometry[0]?.[0];
  return (
    <section className="site-geometry-workspace" aria-label={label("Title")}>
      <div className="geometry-toolbar">
        <h3 className="text-ui-sm font-medium">{label("Title")}</h3>
        <Segmented
          value={view}
          onChange={setView}
          items={[
            { value: "2d", label: label("Plan") },
            { value: "3d", label: "3D", disabled: !context },
          ]}
        />
        {(
          [
            "select",
            "pan",
            "envelope",
            "line",
            "exclusion",
            "building",
            "edge",
            "reference",
          ] as Tool[]
        ).map((mode) => (
          <Button
            key={mode}
            size="sm"
            variant="outline"
            aria-pressed={tool === mode}
            disabled={
              (!["select", "pan"].includes(mode) && (disabled || !geometry.parcel)) ||
              (mode === "reference" && !onReference)
            }
            onClick={() => start(mode)}
          >
            {label(mode)}
          </Button>
        ))}
      </div>
      <div className="geometry-view-controls">
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setFrame((f) => ({ ...f, zoom: Math.min(8, f.zoom * 1.5) }))
          }
        >
          {label("ZoomIn")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setFrame((f) => ({ ...f, zoom: Math.max(0.5, f.zoom / 1.5) }))
          }
        >
          {label("ZoomOut")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFrame({ zoom: 1, x: 0, y: 0 })}
        >
          {label("Fit")}
        </Button>
      </div>
      <NativeSelect
        aria-label={label("Selection")}
        value={
          selected?.kind === "envelope"
            ? "envelope"
            : selected?.kind === "parcel"
              ? "parcel"
              : (selected?.id ?? "_none")
        }
        onChange={(event) =>
          selectId(event.target.value === "_none" ? null : event.target.value)
        }
      >
        <option value="_none">{label("Selection")}</option>
        {geometry.parcel && <option value="parcel">{label("Parcel")}</option>}
        {geometry.envelope && (
          <option value="envelope">{label("envelope")}</option>
        )}
        {geometry.exclusions.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
        {geometry.mandatoryLines.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
        {geometry.buildings.map((b) => (
          <optgroup key={b.id} label={b.label}>
            <option value={b.id}>{b.label}</option>
            {b.staffel.map((s) => (
              <option key={s.footprint.id} value={s.footprint.id}>
                {s.footprint.label}
              </option>
            ))}
          </optgroup>
        ))}
      </NativeSelect>
      {!geometry.parcel && <Callout>{label("NeedParcel")}</Callout>}
      <div className="geometry-layout">
        <div className="geometry-canvas-wrap">
          {view === "3d" && context ? (
            <Geometry3D
              context={context}
              geometry={geometry}
              onSelect={selectId}
            />
          ) : (
            <div
              className="geometry-plan"
              onPointerDown={(e) => {
                if (tool !== "pan") return;
                panStart.current = {
                  clientX: e.clientX,
                  clientY: e.clientY,
                  frame,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!panStart.current) return;
                const r = e.currentTarget.getBoundingClientRect(),
                  start = panStart.current;
                setFrame({
                  ...start.frame,
                  x:
                    start.frame.x -
                    (((e.clientX - start.clientX) / r.width) *
                      baseBounds.size) /
                      start.frame.zoom,
                  y:
                    start.frame.y +
                    (((e.clientY - start.clientY) / r.height) *
                      baseBounds.size) /
                      start.frame.zoom,
                });
              }}
              onPointerUp={(e) => {
                panStart.current = null;
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onClickCapture={(event) => {
                if (!pickingAlignment) return;
                event.stopPropagation();
                const r = event.currentTarget.getBoundingClientRect();
                setPickedSite(
                  unproject({
                    x: (event.clientX - r.left) / r.width,
                    y: (event.clientY - r.top) / r.height,
                  }),
                );
                setPickingAlignment(false);
              }}
              onClick={(event) => {
                if (pickingAlignment) {
                  const r = event.currentTarget.getBoundingClientRect();
                  setPickedSite(
                    unproject({
                      x: (event.clientX - r.left) / r.width,
                      y: (event.clientY - r.top) / r.height,
                    }),
                  );
                  setPickingAlignment(false);
                  return;
                }
                if (
                  ![
                    "envelope",
                    "line",
                    "exclusion",
                    "building",
                    "staffel",
                  ].includes(tool) ||
                  disabled
                )
                  return;
                const r = event.currentTarget.getBoundingClientRect();
                const next = unproject({
                  x: (event.clientX - r.left) / r.width,
                  y: (event.clientY - r.top) / r.height,
                });
                const vertices = geometry.parcel?.geometry.flat(2) ?? [];
                const nearest = vertices.reduce<GeometryPoint | undefined>(
                  (best, p) =>
                    Math.hypot(p[0] - next[0], p[1] - next[1]) <
                      (bounds.size * 8) / r.width &&
                    (!best ||
                      Math.hypot(p[0] - next[0], p[1] - next[1]) <
                        Math.hypot(best[0] - next[0], best[1] - next[1]))
                      ? p
                      : best,
                  undefined,
                );
                setPoints((p) => [...p, nearest ?? next]);
              }}
            >
              <svg
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                aria-label={label("Plan")}
              >
                {planImage && overlayMatrix && (
                  <image
                    href={planImage}
                    width={1}
                    height={1}
                    preserveAspectRatio="none"
                    transform={overlayMatrix}
                    opacity={geometry.planOverlay?.opacity ?? 0.55}
                    style={{ pointerEvents: "none" }}
                  />
                )}
                {context?.buildings.map((b) => (
                  <path
                    key={b.id}
                    className="geometry-context-building"
                    d={pathFor(
                      b.polygons.map((p) =>
                        p.map((r) => r.map((p) => fromLocal(context, p))),
                      ),
                      project,
                    )}
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
                {geometry.parcel && (
                  <path
                    className="geometry-parcel"
                    d={pathFor(geometry.parcel.geometry, project)}
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
                {result?.usableGeometry.length ? (
                  <path
                    className="geometry-usable"
                    d={pathFor(result.usableGeometry, project)}
                  />
                ) : null}
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
                {geometry.buildings.map((b) => (
                  <g key={b.id}>
                    <path
                      className="geometry-building"
                      d={pathFor(b.footprint.geometry, project)}
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
                {tool === "edge" &&
                  geometry.parcel?.geometry.map((polygon, pi) =>
                    polygon.map((ring, ri) =>
                      ring.slice(0, -1).map((p, ei) => {
                        const q = ring[ei + 1]!;
                        return (
                          <line
                            key={`${pi}-${ri}-${ei}`}
                            className="geometry-edge"
                            x1={project(p)[0]}
                            y1={project(p)[1]}
                            x2={project(q)[0]}
                            y2={project(q)[1]}
                            onClick={(event) => {
                              event.stopPropagation();
                              let edge = geometry.setbacks.find(
                                (e) =>
                                  e.polygonIndex === pi &&
                                  e.ringIndex === ri &&
                                  e.edgeIndex === ei,
                              );
                              if (!edge) {
                                edge = {
                                  id: crypto.randomUUID(),
                                  polygonIndex: pi,
                                  ringIndex: ri,
                                  edgeIndex: ei,
                                  distance: null,
                                  profile: "manual",
                                  heightSource: "manual",
                                  assessmentHeight: null,
                                  reviewedHeight: null,
                                  source: "",
                                  sourceDate: null,
                                  reviewed: false,
                                };
                                update({
                                  setbacks: [...geometry.setbacks, edge],
                                });
                              }
                              setSelected({ kind: "edge", id: edge.id });
                            }}
                          />
                        );
                      }),
                    ),
                  )}
                {geometry.mandatoryLines.map((line) => (
                  <polyline
                    key={line.id}
                    className="geometry-mandatory-line"
                    points={line.line
                      .map((p) => project(p).join(","))
                      .join(" ")}
                    onClick={(event) => {
                      if (tool === "select") {
                        event.stopPropagation();
                        selectId(line.id);
                      }
                    }}
                  />
                ))}
                {points.length > 0 && (
                  <polyline
                    className="geometry-drawing"
                    points={points.map((p) => project(p).join(",")).join(" ")}
                  />
                )}
              </svg>
              {tool === "select" && selectedRing && !disabled && (
                <OutlineEditorLayer
                  draft={{
                    polygon: selectedRing.slice(0, -1).map((p) => {
                      const [x, y] = project(p);
                      return { x: x / 1000, y: y / 1000 };
                    }),
                    holes: [],
                  }}
                  labels={{
                    point: label("Point"),
                    addPoint: label("AddPoint"),
                  }}
                  onBegin={() => {}}
                  onChange={(draft) =>
                    updateEvidence({
                      ...selectedEvidence!,
                      reviewed: false,
                      geometry: [
                        [
                          closeRing(draft.polygon.map(unproject)),
                          ...selectedEvidence!.geometry[0]!.slice(1),
                        ],
                        ...selectedEvidence!.geometry.slice(1),
                      ],
                    })
                  }
                />
              )}
              <span className="geometry-scale text-ui-2xs">
                N ↑ · EPSG:25833 · {format(bounds.size)} m
              </span>
            </div>
          )}
          {points.length > 0 && (
            <div className="geometry-draw-actions">
              <span className="text-ui-xs">
                {points.length} {label("Points")}
              </span>
              <Button
                size="sm"
                disabled={points.length < (tool === "line" ? 2 : 3)}
                onClick={finish}
              >
                {label("Finish")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPoints((p) => p.slice(0, -1))}
              >
                {label("UndoPoint")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => start("select")}>
                {label("Cancel")}
              </Button>
            </div>
          )}
          <p className="text-ui-2xs muted">{label("MapHint")}</p>
        </div>
        <aside className="geometry-inspector">
          {!selected && (
            <p className="text-ui-xs muted">{label("SelectHint")}</p>
          )}
          {selectedEvidence && (
            <>
              <h4 className="text-ui-sm font-medium">
                {selectedEvidence.label}
              </h4>
              <Field label={label("Source")}>
                <Input
                  value={selectedEvidence.source}
                  disabled={disabled}
                  onChange={(e) =>
                    updateEvidence({
                      ...selectedEvidence,
                      source: e.target.value,
                      reviewed: false,
                    })
                  }
                />
              </Field>
              <Field label={label("Date")}>
                <Input
                  type="date"
                  value={selectedEvidence.sourceDate ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    updateEvidence({
                      ...selectedEvidence,
                      sourceDate: e.target.value || null,
                      reviewed: false,
                    })
                  }
                />
              </Field>
              <label className="site-review text-ui-xs">
                <Checkbox
                  checked={selectedEvidence.reviewed}
                  disabled={
                    disabled ||
                    !selectedEvidence.source ||
                    !selectedEvidence.sourceDate
                  }
                  onCheckedChange={(v) =>
                    updateEvidence({
                      ...selectedEvidence,
                      reviewed: v === true,
                    })
                  }
                />
                {label("Reviewed")}
              </label>
              <div className="geometry-move">
                <span className="text-ui-xs">{label("Move")}</span>
                {(
                  [
                    [0, 1, "↑"],
                    [0, -1, "↓"],
                    [-1, 0, "←"],
                    [1, 0, "→"],
                  ] as const
                ).map(([x, y, s]) => (
                  <Button
                    key={s}
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`${label("Move")} ${s}`}
                    onClick={() => shift(x, y)}
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </>
          )}
          {selectedBuilding && (
            <>
              <Field label={label("FullStoreys")}>
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={selectedBuilding.fullStoreys}
                  disabled={disabled}
                  onChange={(e) => {
                    const n = e.target.valueAsNumber;
                    if (Number.isInteger(n) && n > 0)
                      update({
                        buildings: geometry.buildings.map((b) =>
                          b.id === selectedBuilding.id
                            ? { ...b, fullStoreys: n, storeysReviewed: false }
                            : b,
                        ),
                      });
                  }}
                />
              </Field>
              <Field label={label("StoreyHeight")}>
                <Input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={selectedBuilding.storeyHeight}
                  disabled={disabled}
                  onChange={(e) => {
                    const n = e.target.valueAsNumber;
                    if (Number.isFinite(n) && n > 0)
                      update({
                        buildings: geometry.buildings.map((b) =>
                          b.id === selectedBuilding.id
                            ? { ...b, storeyHeight: n, storeysReviewed: false }
                            : b,
                        ),
                      });
                  }}
                />
              </Field>
              <Field label={label("StoreysSource")}>
                <Input
                  value={selectedBuilding.storeysSource}
                  disabled={disabled}
                  onChange={(e) =>
                    update({
                      buildings: geometry.buildings.map((b) =>
                        b.id === selectedBuilding.id
                          ? {
                              ...b,
                              storeysSource: e.target.value,
                              storeysReviewed: false,
                            }
                          : b,
                      ),
                    })
                  }
                />
              </Field>
              <label className="site-review text-ui-xs">
                <Checkbox
                  checked={selectedBuilding.storeysReviewed}
                  disabled={disabled || !selectedBuilding.storeysSource}
                  onCheckedChange={(v) =>
                    update({
                      buildings: geometry.buildings.map((b) =>
                        b.id === selectedBuilding.id
                          ? { ...b, storeysReviewed: v === true }
                          : b,
                      ),
                    })
                  }
                />
                {label("StoreysReviewed")}
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => start("staffel")}
              >
                {label("staffel")}
              </Button>
            </>
          )}
          {selectedStaffel && selectedBuilding && (
            <>
              <Field label={label("StaffelHeight")}>
                <Input
                  type="number"
                  step={0.1}
                  min={0.1}
                  value={selectedStaffel.height}
                  disabled={disabled}
                  onChange={(e) => {
                    const n = e.target.valueAsNumber;
                    if (n > 0)
                      update({
                        buildings: geometry.buildings.map((b) =>
                          b.id === selectedBuilding.id
                            ? {
                                ...b,
                                staffel: b.staffel.map((x) =>
                                  x === selectedStaffel
                                    ? {
                                        ...x,
                                        height: n,
                                        classificationReviewed: false,
                                      }
                                    : x,
                                ),
                              }
                            : b,
                        ),
                      });
                  }}
                />
              </Field>
              {(["areaAbove230", "averageTopAboveTerrain"] as const).map(
                (key) => (
                  <Field key={key} label={label(key)}>
                    <Input
                      type="number"
                      step={0.1}
                      disabled={disabled}
                      value={selectedStaffel[key] ?? ""}
                      onChange={(e) =>
                        update({
                          buildings: geometry.buildings.map((b) =>
                            b.id === selectedBuilding.id
                              ? {
                                  ...b,
                                  staffel: b.staffel.map((x) =>
                                    x === selectedStaffel
                                      ? {
                                          ...x,
                                          [key]: Number.isFinite(
                                            e.target.valueAsNumber,
                                          )
                                            ? e.target.valueAsNumber
                                            : null,
                                          classificationReviewed: false,
                                        }
                                      : x,
                                  ),
                                }
                              : b,
                          ),
                        })
                      }
                    />
                  </Field>
                ),
              )}
              <label className="site-review text-ui-xs">
                <Checkbox
                  checked={selectedStaffel.countable}
                  disabled={disabled}
                  onCheckedChange={(v) =>
                    update({
                      buildings: geometry.buildings.map((b) =>
                        b.id === selectedBuilding.id
                          ? {
                              ...b,
                              staffel: b.staffel.map((x) =>
                                x === selectedStaffel
                                  ? {
                                      ...x,
                                      countable: v === true,
                                      classificationReviewed: false,
                                    }
                                  : x,
                              ),
                            }
                          : b,
                      ),
                    })
                  }
                />
                {label("Countable")}
              </label>
              <label className="site-review text-ui-xs">
                <Checkbox
                  checked={selectedStaffel.classificationReviewed}
                  disabled={
                    disabled ||
                    selectedStaffel.areaAbove230 === null ||
                    selectedStaffel.averageTopAboveTerrain === null ||
                    !selectedStaffel.footprint.reviewed
                  }
                  onCheckedChange={(v) =>
                    update({
                      buildings: geometry.buildings.map((b) =>
                        b.id === selectedBuilding.id
                          ? {
                              ...b,
                              staffel: b.staffel.map((x) =>
                                x === selectedStaffel
                                  ? { ...x, classificationReviewed: v === true }
                                  : x,
                              ),
                            }
                          : b,
                      ),
                    })
                  }
                />
                {label("ClassificationReviewed")}
              </label>
            </>
          )}
          {selectedLine && (
            <>
              <h4 className="text-ui-sm">{label("line")}</h4>
              <Field label={label("Source")}>
                <Input
                  disabled={disabled}
                  value={selectedLine.source}
                  onChange={(e) =>
                    update({
                      mandatoryLines: geometry.mandatoryLines.map((l) =>
                        l.id === selectedLine.id
                          ? { ...l, source: e.target.value, reviewed: false }
                          : l,
                      ),
                    })
                  }
                />
              </Field>
              <Field label={label("Date")}>
                <Input
                  type="date"
                  disabled={disabled}
                  value={selectedLine.sourceDate ?? ""}
                  onChange={(e) =>
                    update({
                      mandatoryLines: geometry.mandatoryLines.map((l) =>
                        l.id === selectedLine.id
                          ? {
                              ...l,
                              sourceDate: e.target.value || null,
                              reviewed: false,
                            }
                          : l,
                      ),
                    })
                  }
                />
              </Field>
              <label className="site-review text-ui-xs">
                <Checkbox
                  disabled={
                    disabled || !selectedLine.source || !selectedLine.sourceDate
                  }
                  checked={selectedLine.reviewed}
                  onCheckedChange={(v) =>
                    update({
                      mandatoryLines: geometry.mandatoryLines.map((l) =>
                        l.id === selectedLine.id
                          ? { ...l, reviewed: v === true }
                          : l,
                      ),
                    })
                  }
                />
                {label("Reviewed")}
              </label>
            </>
          )}
          {selectedEdge && (
            <>
              <h4 className="text-ui-sm">
                {label("edge")} {selectedEdge.edgeIndex + 1}
              </h4>
              <Field label={label("Profile")}>
                <NativeSelect
                  disabled={disabled}
                  value={selectedEdge.profile}
                  onChange={(e) =>
                    update({
                      setbacks: geometry.setbacks.map((x) =>
                        x.id === selectedEdge.id
                          ? {
                              ...x,
                              profile: e.target.value as typeof x.profile,
                              reviewed: false,
                              reviewedHeight: null,
                            }
                          : x,
                      ),
                    })
                  }
                >
                  {[
                    "manual",
                    "standard",
                    "commercial",
                    "low_class",
                    "boundary_exception",
                  ].map((v) => (
                    <option key={v} value={v}>
                      {label(v)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {selectedEdge.profile !== "manual" &&
                selectedEdge.profile !== "boundary_exception" && (
                  <>
                    <Field label={label("HeightSource")}>
                      <NativeSelect
                        disabled={disabled}
                        value={selectedEdge.heightSource}
                        onChange={(e) =>
                          update({
                            setbacks: geometry.setbacks.map((x) =>
                              x.id === selectedEdge.id
                                ? {
                                    ...x,
                                    heightSource: e.target
                                      .value as typeof x.heightSource,
                                    reviewed: false,
                                    reviewedHeight: null,
                                  }
                                : x,
                            ),
                          })
                        }
                      >
                        <option value="manual">{label("ManualHeight")}</option>
                        <option value="buildings">
                          {label("BuildingHeight")}
                        </option>
                      </NativeSelect>
                    </Field>
                    {selectedEdge.heightSource === "manual" && (
                      <Field label={label("AssessmentHeight")}>
                        <Input
                          type="number"
                          min={0}
                          step={0.1}
                          disabled={disabled}
                          value={selectedEdge.assessmentHeight ?? ""}
                          onChange={(e) =>
                            update({
                              setbacks: geometry.setbacks.map((x) =>
                                x.id === selectedEdge.id
                                  ? {
                                      ...x,
                                      assessmentHeight: Number.isFinite(
                                        e.target.valueAsNumber,
                                      )
                                        ? e.target.valueAsNumber
                                        : null,
                                      reviewed: false,
                                      reviewedHeight: null,
                                    }
                                  : x,
                              ),
                            })
                          }
                        />
                      </Field>
                    )}
                  </>
                )}
              <Field label={label("Distance")}>
                <Input
                  type="number"
                  min={0}
                  step={0.1}
                  disabled={disabled}
                  value={selectedEdge.distance ?? ""}
                  onChange={(e) => {
                    const n = e.target.valueAsNumber;
                    update({
                      setbacks: geometry.setbacks.map((x) =>
                        x.id === selectedEdge.id
                          ? {
                              ...x,
                              distance: Number.isFinite(n) && n >= 0 ? n : null,
                              reviewed: false,
                            }
                          : x,
                      ),
                    });
                  }}
                />
              </Field>
              <Field label={label("Source")}>
                <Input
                  disabled={disabled}
                  value={selectedEdge.source}
                  onChange={(e) =>
                    update({
                      setbacks: geometry.setbacks.map((x) =>
                        x.id === selectedEdge.id
                          ? { ...x, source: e.target.value, reviewed: false }
                          : x,
                      ),
                    })
                  }
                />
              </Field>
              <Field label={label("Date")}>
                <Input
                  type="date"
                  disabled={disabled}
                  value={selectedEdge.sourceDate ?? ""}
                  onChange={(e) =>
                    update({
                      setbacks: geometry.setbacks.map((x) =>
                        x.id === selectedEdge.id
                          ? {
                              ...x,
                              sourceDate: e.target.value || null,
                              reviewed: false,
                            }
                          : x,
                      ),
                    })
                  }
                />
              </Field>
              <label className="site-review text-ui-xs">
                <Checkbox
                  disabled={
                    disabled ||
                    !selectedEdge.source ||
                    !selectedEdge.sourceDate ||
                    ((selectedEdge.profile === "manual" ||
                      selectedEdge.profile === "boundary_exception") &&
                      selectedEdge.distance === null)
                  }
                  checked={selectedEdge.reviewed}
                  onCheckedChange={(v) =>
                    update({
                      setbacks: geometry.setbacks.map((x) =>
                        x.id === selectedEdge.id
                          ? {
                              ...x,
                              reviewed: v === true,
                              reviewedHeight:
                                x.heightSource === "buildings"
                                  ? geometry.buildings.length
                                    ? Math.max(
                                        ...geometry.buildings.map((b) =>
                                          Math.max(
                                            b.height ?? 0,
                                            b.fullStoreys * b.storeyHeight +
                                              b.staffel.reduce(
                                                (h, s) => h + s.height,
                                                0,
                                              ),
                                          ),
                                        ),
                                      )
                                    : null
                                  : x.assessmentHeight,
                            }
                          : x,
                      ),
                    })
                  }
                />
                {label("Reviewed")}
              </label>
            </>
          )}
          {selected && !disabled && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (selected.kind === "line")
                  update({
                    mandatoryLines: geometry.mandatoryLines.filter(
                      (l) => l.id !== selected.id,
                    ),
                  });
                if (selected.kind === "parcel")
                  update({ parcel: null, setbacks: [] });
                if (selected.kind === "envelope") update({ envelope: null });
                if (selected.kind === "exclusion")
                  update({
                    exclusions: geometry.exclusions.filter(
                      (e) => e.id !== selected.id,
                    ),
                    exclusionsReviewed: false,
                  });
                if (selected.kind === "building")
                  update({
                    buildings: geometry.buildings.filter(
                      (b) => b.id !== selected.id,
                    ),
                  });
                if (selected.kind === "staffel")
                  update({
                    buildings: geometry.buildings.map((b) => ({
                      ...b,
                      staffel: b.staffel.filter(
                        (s) => s.footprint.id !== selected.id,
                      ),
                    })),
                  });
                if (selected.kind === "edge")
                  update({
                    setbacks: geometry.setbacks.filter(
                      (e) => e.id !== selected.id,
                    ),
                  });
                setSelected(null);
              }}
            >
              {label("Remove")}
            </Button>
          )}
          <label className="site-review text-ui-xs">
            <Checkbox
              disabled={disabled}
              checked={geometry.exclusionsReviewed}
              onCheckedChange={(v) =>
                update({ exclusionsReviewed: v === true })
              }
            />
            {label("ExclusionsReviewed")}
          </label>
          {engine && geometry.parcel && (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !options}
              onClick={() =>
                options &&
                setCandidates(
                  engine.generateMassingCandidates(geometry, options),
                )
              }
            >
              {label("Candidates")}
            </Button>
          )}
          {candidates.map((candidate, i) => (
            <div key={candidate.id} className="geometry-candidate text-ui-xs">
              <strong>
                {label("Variant")} {i + 1} · {label(candidate.strategy)}
              </strong>
              <span>
                GF {format(candidate.metrics.countableFloorArea)} m² · BGF{" "}
                {format(candidate.metrics.grossFloorArea)} m²
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  update({
                    buildings: [
                      {
                        ...candidate.building,
                        label: `${label("Variant")} ${i + 1}`,
                        footprint: {
                          ...candidate.building.footprint,
                          label: label("building"),
                        },
                      },
                    ],
                  });
                  setSelected({ kind: "building", id: candidate.building.id });
                }}
              >
                {label("UseVariant")}
              </Button>
            </div>
          ))}
        </aside>
      </div>
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
      />
      {result && (
        <div className="geometry-results text-ui-xs">
          <Badge variant="outline">{label(result.status)}</Badge>
          {onUseArea && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !result.usableArea}
              onClick={() => onUseArea(result.usableArea)}
            >
              {label("UseArea")}
            </Button>
          )}
          <span>
            {label("Usable")}: {format(result.usableArea)} m²
          </span>
          {result.buildings.map((b) => (
            <span key={b.id}>
              GF {format(b.countableFloorArea)} m² · BGF{" "}
              {format(b.grossFloorArea)} m² ·{" "}
              {label(b.validPlacement ? "Fits" : "DoesNotFit")}
            </span>
          ))}
          {result.issues.length > 0 && (
            <ul className="geometry-issue-list">
              {Object.entries(
                result.issues.reduce<Record<string, typeof result.issues>>(
                  (groups, issue) => {
                    (groups[issue.code] ??= []).push(issue);
                    return groups;
                  },
                  {},
                ),
              ).map(([code, issues]) => {
                const list = issues ?? [];
                const affected = (id?: string) => {
                  if (!id) return "";
                  const edge = geometry.setbacks.find((e) => e.id === id);
                  if (edge) return `${label("edge")} ${edge.edgeIndex + 1}`;
                  if (id.startsWith("edge-"))
                    return `${label("edge")} ${Number(id.split("-").at(-1)) + 1}`;
                  return (
                    geometry.buildings.find(
                      (b) => b.id === id || b.footprint.id === id,
                    )?.label ??
                    geometry.exclusions.find((e) => e.id === id)?.label ??
                    geometry.mandatoryLines.find((l) => l.id === id)?.label ??
                    (id === geometry.parcel?.id
                      ? label("Parcel")
                      : id === geometry.envelope?.id
                        ? label("envelope")
                        : label("ReviewGeometry"))
                  );
                };
                const review = (id?: string) => {
                  if (code === "missing_envelope") return start("envelope");
                  if (id?.startsWith("edge-")) {
                    const edge =
                      geometry.setbacks.find((e) => e.id === id) ??
                      engine
                        ?.createDefaultSetbacks(geometry.parcel!)
                        .find((e) => e.id === id);
                    if (edge) {
                      if (!geometry.setbacks.some((e) => e.id === id))
                        update({ setbacks: [...geometry.setbacks, edge] });
                      setSelected({ kind: "edge", id: edge.id });
                      setTool("edge");
                      return;
                    }
                  }
                  if (id === geometry.parcel?.id)
                    return setSelected({ kind: "parcel", id: "parcel" });
                  if (id === geometry.envelope?.id)
                    return setSelected({ kind: "envelope", id: "envelope" });
                  const b = geometry.buildings.find(
                    (b) => b.footprint.id === id,
                  );
                  if (b) return setSelected({ kind: "building", id: b.id });
                  if (id) selectId(id);
                };
                return (
                  <li key={code}>
                    <strong>{label(code) || label("ReviewGeometry")}</strong>
                    {list.length > 1 && <span> · {list.length}</span>}
                    <div className="geometry-issue-actions">
                      {list.slice(0, 3).map((issue, i) => (
                        <Button
                          key={i}
                          variant="ghost"
                          size="sm"
                          onClick={() => review(issue.id)}
                        >
                          {label("Review")} {affected(issue.id)}
                        </Button>
                      ))}
                      {list.length > 3 && (
                        <details>
                          <summary>
                            {label("MoreIssues")} · {list.length - 3}
                          </summary>
                          {list.slice(3).map((issue, i) => (
                            <Button
                              key={i}
                              variant="ghost"
                              size="sm"
                              onClick={() => review(issue.id)}
                            >
                              {label("Review")} {affected(issue.id)}
                            </Button>
                          ))}
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
