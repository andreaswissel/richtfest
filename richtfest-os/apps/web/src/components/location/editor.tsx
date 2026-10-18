import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useBlocker } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Box,
  Trees,
  Truck,
  MapPin,
  Scan,
  Upload,
  Undo2,
  Redo2,
  Focus,
  ScanSearch,
  Trash2,
  Eye,
  EyeOff,
  MousePointer2,
  Move,
  Ruler,
  Hand,
  Save,
  Layers,
  Download,
} from "lucide-react";
import type {
  LocationState,
  LocationScene,
  LocationPointCloud,
  SceneObject,
  SceneVector,
  ProjectAddress,
} from "@richtfest/shared";
import {
  formatProjectAddress,
  locationMatchesAddress,
} from "@richtfest/shared";
import { api, ApiError, uploadFile } from "../../api";
import { queryClient } from "../../query";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { Badge, Callout, Field, Segmented } from "../ui/primitives";
import type { IfcGeometry } from "./ifc-loader";
import type { createViewport, ViewportState } from "./viewport";
import { pointsInEnvelope } from "./scene-math";
import { EnvironmentSurveyButton } from "./environment-survey";
import { PublicDataStatus } from "./public-data";
import { MeasurementActions, useSiteWorkbench } from "./site-workbench";
import "./location.css";

const busy = (status?: string) => status === "queued" || status === "running";
const empty: LocationScene = { objects: [], planningNotes: "" };
type Draft = { scene: LocationScene; revision: number };

function NumberField({
  label,
  value,
  onChange,
  disabled,
  min,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  min?: number;
}) {
  const [text, setText] = useState(String(Number(value.toFixed(3))));
  useEffect(() => setText(String(Number(value.toFixed(3)))), [value]);
  return (
    <Field label={label}>
      <Input
        type="number"
        step="0.1"
        min={min}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={(e) => {
          const n = e.currentTarget.valueAsNumber;
          if (Number.isFinite(n) && (min === undefined || n >= min)) {
            if (n !== Number(value.toFixed(3))) onChange(n);
          } else setText(String(Number(value.toFixed(3))));
        }}
      />
    </Field>
  );
}

export function LocationEditor({
  projectId,
  address,
}: {
  projectId: string;
  address: ProjectAddress;
}) {
  const t = useT(),
    theme = usePreferences((s) => s.theme);
  const addressLabel = formatProjectAddress(address);
  const constructionLabel = t("locationConstruction");
  const siteFootprintLabel = t("locationSiteFootprint");
  const siteAddressLabel = t("locationSiteAddress");
  const hasAddress = !!address.street && !!address.city;
  const path = `/projects/${projectId}/location`;
  const state = useQuery({
    queryKey: [path],
    queryFn: () => api<LocationState>(path),
    staleTime: 30_000,
    refetchInterval: (query) =>
      busy(query.state.data?.contextJob.status) ||
      busy(query.state.data?.lidarJob.status)
        ? 2000
        : false,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const scene = draft?.scene ?? state.data?.scene ?? empty;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const [past, setPast] = useState<LocationScene[]>([]),
    [future, setFuture] = useState<LocationScene[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<ViewportState["tool"]>("select");
  const [treeStyle, setTreeStyle] =
    useState<ViewportState["treeStyle"]>("schematic");
  const [tab, setTab] = useState("properties");
  const [layers, setLayers] = useState({
    buildings: true,
    trees: true,
    objects: true,
    lidar: false,
    roads: true,
    railNoise: false,
    plan: true,
    aerial: true,
  });
  const [measurement, setMeasurement] = useState<SceneVector[]>([]);
  const [clipHeight, setClipHeight] = useState(50);
  const [models, setModels] = useState<Record<string, IfcGeometry>>({});
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [retryModels, setRetryModels] = useState(0);
  const host = useRef<HTMLDivElement>(null),
    viewport = useRef<ReturnType<typeof createViewport> | null>(null);
  const [viewportReady, setViewportReady] = useState(false),
    [viewportError, setViewportError] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !!draft &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!draft) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [!!draft]);
  const change = (next: LocationScene) => {
    const previous = sceneRef.current;
    setPast((p) => [...p.slice(-39), previous]);
    setFuture([]);
    setDraft((d) => ({
      scene: next,
      revision: d?.revision ?? state.data?.revision ?? 0,
    }));
  };
  const patchObject = (id: string, patch: Partial<SceneObject>) =>
    change({
      ...sceneRef.current,
      objects: sceneRef.current.objects.map((o) =>
        o.id === id ? { ...o, ...patch } : o,
      ),
    });
  const object = scene.objects.find((o) => o.id === selected);
  const tree = state.data?.context?.trees.find(
    (o) => `tree:${o.id}` === selected,
  );
  const building = state.data?.context?.buildings.find(
    (o) => `building:${o.id}` === selected,
  );
  const acceptState = (data: LocationState) =>
    queryClient.setQueryData([path], data);
  const save = useMutation({
    mutationFn: (input: Draft) => api<LocationState>(path, input, "PUT"),
    onSuccess(data, input) {
      acceptState(data);
      setDraft((current) =>
        current?.scene === input.scene
          ? null
          : current
            ? { ...current, revision: data.revision }
            : null,
      );
    },
  });
  const importContext = useMutation({
    mutationFn: () =>
      api<LocationState>(`${path}/import`, {
        revision: state.data?.revision ?? 0,
      }),
    onSuccess(data) {
      setPast([]);
      setFuture([]);
      setSelected(null);
      setMeasurement([]);
      setLayers((current) => ({ ...current, lidar: false }));
      acceptState(data);
    },
  });
  const importLidar = useMutation({
    mutationFn: () => api<LocationState>(`${path}/lidar`, {}),
    onSuccess: acceptState,
  });
  const cloud = useQuery({
    queryKey: [`${path}/lidar`, state.data?.context?.importedAt],
    queryFn: () => api<LocationPointCloud>(`${path}/lidar`),
    enabled: layers.lidar && state.data?.lidarJob.status === "ready",
    staleTime: Infinity,
    gcTime: 60_000,
    meta: { persist: false },
  });
  const importIfc = useMutation({
    mutationFn: async (file: File) => {
      const { loadIfc } = await import("./ifc-loader");
      const geometry = await loadIfc(await file.arrayBuffer());
      const form = new FormData();
      form.set("file", file);
      const source = await uploadFile<{ id: string; version: number }>(
        `/projects/${projectId}/files`,
        form,
      );
      return { geometry, source, name: file.name };
    },
    onSuccess({ geometry, source, name }) {
      const id = crypto.randomUUID();
      setModels((m) => ({ ...m, [id]: geometry }));
      change({
        ...sceneRef.current,
        objects: [
          ...sceneRef.current.objects,
          {
            id,
            kind: "ifc",
            label: name,
            position: [0, 0, 0],
            size: geometry.size,
            rotation: 0,
            note: "",
            source: { fileId: source.id, version: source.version },
          },
        ],
      });
      setSelected(id);
      setTab("properties");
      setLayers((l) => ({ ...l, objects: true }));
      void queryClient.invalidateQueries({
        queryKey: [`/projects/${projectId}`],
      });
      void queryClient.invalidateQueries({
        queryKey: [`/projects/${projectId}/files`],
      });
    },
  });
  // Geometry is a disposable render cache. Original IFC revisions are durable sources.
  const ifcKey = scene.objects
    .filter((o) => o.kind === "ifc" && o.source)
    .map((o) => `${o.id}/${o.source!.fileId}/${o.source!.version}`)
    .join(",");
  useEffect(() => {
    const controller = new AbortController();
    const missing = sceneRef.current.objects.filter(
      (o) => o.kind === "ifc" && o.source && !models[o.id],
    );
    for (const item of missing) {
      void (async () => {
        try {
          const response = await fetch(
            `/api/projects/${projectId}/files/${item.source!.fileId}/versions/${item.source!.version}/download`,
            { credentials: "include", signal: controller.signal },
          );
          if (!response.ok) throw new Error(`${response.status}`);
          const { loadIfc } = await import("./ifc-loader");
          const geometry = await loadIfc(
            await response.arrayBuffer(),
            controller.signal,
          );
          if (!controller.signal.aborted)
            setModels((m) => ({ ...m, [item.id]: geometry }));
        } catch (error) {
          if (!controller.signal.aborted)
            setModelErrors((m) => ({
              ...m,
              [item.id]: error instanceof Error ? error.message : String(error),
            }));
        }
      })();
    }
    return () => controller.abort();
  }, [ifcKey, projectId, retryModels]);
  const site = useSiteWorkbench({
    projectId,
    context: state.data?.context ?? null,
    layers,
    tool,
    setTool,
  });
  const callbacks = useRef({
    align: (_p: [number, number]) => {},
    zoom: (_out: boolean) => {},
    snap: (p: SceneVector) => p,
    select: setSelected,
    place: (_p: SceneVector) => {},
    measure: (_p: SceneVector) => {},
  });
  callbacks.current = {
    select: (id) => {
      setSelected(id);
      setTab("properties");
    },
    place: (point) => {
      if (object)
        patchObject(object.id, {
          position: [
            Number(point[0].toFixed(2)),
            object.position[1],
            Number(point[2].toFixed(2)),
          ],
        });
    },
    measure: (point) =>
      setMeasurement((m) => (m.length === 1 ? [...m, point] : [point])),
    snap: (point) => {
      // Snap to the nearest building or plan corner within 1 m, keeping the picked height.
      let best: [number, number] | null = null,
        bestDistance = 1;
      for (const vertex of site.snapVertices) {
        const distance = Math.hypot(vertex[0] - point[0], vertex[1] - point[2]);
        if (distance <= bestDistance) {
          best = vertex;
          bestDistance = distance;
        }
      }
      return best ? [best[0], point[1], best[1]] : point;
    },
    align: site.onAlign,
    zoom: site.onZoom,
  };
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.defaultPrevented || !viewport.current || target?.closest("[role=dialog], [data-slot=popover-content]")) return;
    if (event.key === "Escape") {
      if (measurement.length) setMeasurement([]);
      else if (tool !== "select") setTool("select");
      return;
    }
    if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    const key = event.key.toLowerCase();
    const tools: Record<string, ViewportState["tool"]> = { v: "select", g: "place", m: "measure", a: "align", h: "pan" };
    const views: Record<string, "top" | "perspective" | "street" | "area"> = { t: "top", "3": "perspective", s: "street", u: "area" };
    if (tools[key]) {
      if ((key === "g" && !object) || (key === "a" && !site.canAlign)) return;
      event.preventDefault();
      if (key === "m") setTreeStyle("schematic");
      setTool(tools[key]);
    } else if (views[key]) {
      event.preventDefault();
      viewport.current.view(views[key]);
    } else if (key === "f") {
      event.preventDefault();
      if (event.shiftKey) viewport.current.fitConstruction();
      else viewport.current.focus(selected);
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const hasContext = !!state.data?.context;
  const addressMismatch =
    hasContext && !locationMatchesAddress(state.data!.context!, address);
  const [retainedAddress, setRetainedAddress] = useState<string | null>(null);
  const showContext =
    hasContext && (!addressMismatch || retainedAddress === addressLabel);
  const rlpContext = state.data?.context?.crs === "EPSG:25832";
  useEffect(() => {
    if (!showContext || !host.current) return;
    let disposed = false;
    void import("./viewport")
      .then(({ createViewport }) => {
        if (disposed || !host.current) return;
        try {
          viewport.current = createViewport(host.current, {
            select: (id) => callbacks.current.select(id),
            place: (p) => callbacks.current.place(p),
            measure: (p) => callbacks.current.measure(p),
            align: (p) => callbacks.current.align(p),
            zoom: (out) => callbacks.current.zoom(out),
            snap: (p) => callbacks.current.snap(p),
          });
          setViewportReady(true);
        } catch {
          setViewportError(true);
        }
      })
      .catch(() => setViewportError(true));
    return () => {
      disposed = true;
      viewport.current?.dispose();
      viewport.current = null;
      setViewportReady(false);
    };
  }, [showContext]);
  useEffect(() => {
    if (viewport.current && state.data?.context)
      viewport.current.update({
        context: state.data.context,
        objects: scene.objects,
        models,
        cloud: cloud.data,
        layers,
        site: site.overlay,
        selected,
        tool,
        treeStyle,
        measurement,
        clipHeight,
        dark: theme === "dark",
        constructionLabel,
        siteFootprintLabel,
        siteAddressLabel,
      });
  }, [
    site.overlay,
    viewportReady,
    state.data?.context,
    scene.objects,
    models,
    cloud.data,
    layers,
    selected,
    tool,
    treeStyle,
    measurement,
    clipHeight,
    theme,
    constructionLabel,
    siteFootprintLabel,
    siteAddressLabel,
  ]);
  const envelopeCount = useMemo(
    () =>
      cloud.data && object?.kind === "vehicle"
        ? pointsInEnvelope(cloud.data, object)
        : null,
    [cloud.data, object],
  );
  const addObject = (kind: "vehicle" | "mass" | "note") => {
    const item: SceneObject = {
      id: crypto.randomUUID(),
      kind,
      label: t(
        kind === "vehicle"
          ? "locationVehicleName"
          : kind === "mass"
            ? "locationMassName"
            : "locationPinName",
      ),
      position: [0, 0, 0],
      size:
        kind === "vehicle"
          ? [2.55, 3.5, 8]
          : kind === "mass"
            ? [6, 3, 8]
            : [1, 1, 1],
      rotation: 0,
      note: "",
    };
    change({ ...scene, objects: [...scene.objects, item] });
    setSelected(item.id);
    setTab("properties");
    setLayers((l) => ({ ...l, objects: true }));
  };
  const toggle = (key: keyof typeof layers) => {
    const on = !layers[key];
    setLayers((l) => ({ ...l, [key]: on }));
    if (
      key === "lidar" &&
      on &&
      ["idle", "failed"].includes(state.data?.lidarJob.status ?? "idle")
    )
      importLidar.mutate();
  };
  const undo = (redo: boolean) => {
    const stack = redo ? future : past;
    if (!stack.length) return;
    const next = stack[stack.length - 1];
    if (redo) {
      setFuture(stack.slice(0, -1));
      setPast((p) => [...p, scene]);
    } else {
      setPast(stack.slice(0, -1));
      setFuture((p) => [...p, scene]);
    }
    setDraft((d) => ({
      scene: next,
      revision: d?.revision ?? state.data?.revision ?? 0,
    }));
  };
  const row = (id: string, name: string, icon: ReactNode) => (
    <button
      key={id}
      className="location-object-row"
      aria-pressed={selected === id}
      onClick={() => {
        setSelected(id);
        setTab("properties");
      }}
      onDoubleClick={() => viewport.current?.focus(id)}
    >
      {icon}
      <span>{name}</span>
    </button>
  );
  const layer = (
    key: keyof typeof layers,
    label: string,
    icon: ReactNode,
    count?: number,
  ) => (
    <div className="location-layer-heading">
      <span>
        {icon}
        {label}
        {count !== undefined && <small>{count}</small>}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={layers[key]}
        onClick={() => toggle(key)}
      >
        {layers[key] ? (
          <Eye className="size-icon-sm" />
        ) : (
          <EyeOff className="size-icon-sm" />
        )}
      </Button>
    </div>
  );
  const mutationError =
    save.error || importContext.error || importLidar.error || importIfc.error;
  const conflict = save.error instanceof ApiError && save.error.status === 409;
  return (
    <div className="location-editor" aria-label={t("locationEditor")}>
      {blocker.state === "blocked" && (
        <Callout>
          {t("locationUnsaved")}{" "}
          <Button variant="outline" onClick={() => blocker.reset()}>
            {t("locationStay")}
          </Button>{" "}
          <Button variant="outline" onClick={() => blocker.proceed()}>
            {t("locationLeave")}
          </Button>
        </Callout>
      )}
      {(state.error || mutationError) && (
        <Callout tone="error">
          {conflict
            ? t("locationConflict")
            : (state.error || mutationError)?.message}
          {conflict && (
            <Button
              variant="outline"
              onClick={() => {
                setDraft(null);
                setPast([]);
                setFuture([]);
                save.reset();
                void state.refetch();
              }}
            >
              {t("locationReload")}
            </Button>
          )}
        </Callout>
      )}
      {addressMismatch && (
        <Callout>
          <p>
            {t(
              hasAddress ? "locationAddressChanged" : "locationAddressMissing",
            )}
          </p>
          {hasAddress && <p>{addressLabel}</p>}
          <p>
            {t("locationRetainedSite")}: {state.data!.context!.address}
          </p>
          <Link to={`/projects/${projectId}?view=details`}>
            {t("projectDetails")} ↗
          </Link>
          <Button
            variant="outline"
            onClick={() =>
              setRetainedAddress(showContext ? null : addressLabel)
            }
          >
            {t(showContext ? "locationHideRetained" : "locationViewRetained")}
          </Button>
          {hasAddress && (
            <>
              <p>{t("locationAddressObjects")}</p>
              <Button
                variant="outline"
                disabled={
                  !!draft ||
                  scene.objects.length > 0 ||
                  importContext.isPending ||
                  busy(state.data?.contextJob.status) ||
                  busy(state.data?.lidarJob.status)
                }
                onClick={() => importContext.mutate()}
              >
                {t("locationUseProjectAddress")}
              </Button>
            </>
          )}
        </Callout>
      )}
      {!hasContext ? (
        <div className="location-empty">
          <Scan className="size-icon" />
          <h2>{addressLabel || t("address")}</h2>
          <p>
            {t(hasAddress ? "locationSetupHint" : "locationAddressMissing")}
          </p>
          <Link to={`/projects/${projectId}?view=details`}>
            {t("projectDetails")} ↗
          </Link>
          {state.data?.contextJob.error && (
            <Callout tone="error">{state.data.contextJob.error}</Callout>
          )}
          <Button
            disabled={
              !hasAddress ||
              !!draft ||
              state.isPending ||
              state.isError ||
              importContext.isPending ||
              busy(state.data?.contextJob.status)
            }
            onClick={() => importContext.mutate()}
          >
            {busy(state.data?.contextJob.status)
              ? t("locationLoading")
              : t("locationSetup")}
          </Button>
        </div>
      ) : showContext ? (
        <>
          <div className="location-toolbar">
            <div className="location-toolbar-group">
              <Button variant="outline" onClick={() => addObject("vehicle")}>
                <Truck className="size-icon-sm" />
                {t("locationVehicle")}
              </Button>
              <Button variant="outline" onClick={() => addObject("mass")}>
                <Box className="size-icon-sm" />
                {t("locationMass")}
              </Button>
              <Button variant="outline" onClick={() => addObject("note")}>
                <MapPin className="size-icon-sm" />
                {t("locationPin")}
              </Button>
              <Button
                variant="outline"
                disabled={importIfc.isPending}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="size-icon-sm" />
                {t("locationIfc")}
              </Button>
              <Input
                ref={fileInput}
                type="file"
                accept=".ifc"
                className="hidden"
                aria-label={t("locationIfc")}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importIfc.mutate(file);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="location-toolbar-group">
              <Button
                variant="ghost"
                size="icon"
                title={t("locationUndo")}
                aria-label={t("locationUndo")}
                disabled={!past.length}
                onClick={() => undo(false)}
              >
                <Undo2 className="size-icon-sm" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title={t("locationRedo")}
                aria-label={t("locationRedo")}
                disabled={!future.length}
                onClick={() => undo(true)}
              >
                <Redo2 className="size-icon-sm" />
              </Button>
              <span className="text-ui-xs muted" role="status">
                {draft
                  ? t("locationUnsaved")
                  : save.isSuccess
                    ? t("locationSaved")
                    : `v${state.data?.revision ?? 0}`}
              </span>
              <Button
                disabled={!draft || save.isPending || importIfc.isPending}
                onClick={() => draft && save.mutate(draft)}
              >
                <Save className="size-icon-sm" />
                {save.isPending ? t("saving") : t("locationSave")}
              </Button>
            </div>
          </div>
          {importIfc.isPending && <Callout>{t("locationIfcBusy")}</Callout>}
          <div className="location-workbench">
            <aside className="location-layers" aria-label={t("locationLayers")}>
              <h2>
                <Layers className="size-icon-sm" />
                {t("locationLayers")}
              </h2>
              <p className="location-site-label">
                {state.data!.context!.address}
                <small>{state.data!.context!.radius} m</small>
              </p>
              <div className="location-layer-section">
                {layer(
                  "buildings",
                  t("locationBuildings"),
                  <Box className="size-icon-sm" />,
                  state.data!.context!.buildings.length,
                )}
                <details>
                  <summary>{t("locationReadOnly")}</summary>
                  {state.data!.context!.buildings.map((b) =>
                    row(
                      `building:${b.id}`,
                      `${b.label} · ${b.height?.toFixed(1) ?? "—"} m`,
                      <Box className="size-icon-sm" />,
                    ),
                  )}
                </details>
              </div>
              {site.panel(layer)}
              {rlpContext ? (
                <Callout>{t("locationRlpCoverage")}</Callout>
              ) : (
                <>
                  <div className="location-layer-section">
                    {layer(
                      "trees",
                      t("locationTrees"),
                      <Trees className="size-icon-sm" />,
                      state.data!.context!.trees.length,
                    )}
                    <Field label={t("locationTreeStyle")}>
                      <Segmented
                        items={[
                          { value: "schematic", label: t("locationSchematic") },
                          {
                            value: "illustrative",
                            label: t("locationIllustrative"),
                          },
                        ]}
                        value={treeStyle}
                        onChange={(value) => {
                          setTreeStyle(
                            value === "illustrative"
                              ? "illustrative"
                              : "schematic",
                          );
                          if (tool === "measure") setTool("select");
                        }}
                      />
                    </Field>
                    {treeStyle === "illustrative" && (
                      <p className="text-ui-xs muted">
                        {t("locationTreeStyleHint")}
                      </p>
                    )}
                    <details>
                      <summary>{t("locationReadOnly")}</summary>
                      {state.data!.context!.trees.map((b) =>
                        row(
                          `tree:${b.id}`,
                          `${b.species} · ${b.height ?? "—"} m`,
                          <Trees className="size-icon-sm" />,
                        ),
                      )}
                    </details>
                  </div>
                  <div className="location-layer-section">
                    {layer(
                      "lidar",
                      t("locationLidar"),
                      <Scan className="size-icon-sm" />,
                    )}
                    <p className="text-ui-xs muted">
                      {busy(state.data?.lidarJob.status) || cloud.isFetching
                        ? t("locationCloudLoading")
                        : t("locationCloudHint")}
                    </p>
                    {(state.data?.lidarJob.error || cloud.error) && (
                      <Callout tone="error">
                        {state.data?.lidarJob.error || cloud.error?.message}
                        <Button
                          variant="outline"
                          onClick={() =>
                            state.data?.lidarJob.status === "failed"
                              ? importLidar.mutate()
                              : void cloud.refetch()
                          }
                        >
                          {t("locationRetry")}
                        </Button>
                      </Callout>
                    )}
                    {cloud.data && (
                      <>
                        <NumberField
                          label={t("locationClip")}
                          value={clipHeight}
                          min={-20}
                          onChange={setClipHeight}
                        />
                        <p className="text-ui-xs muted">
                          {t("locationCloudStats")}
                          <br />
                          {cloud.data.classifications.length.toLocaleString()} /{" "}
                          {cloud.data.sourcePointCount.toLocaleString()}
                        </p>
                      </>
                    )}
                  </div>
                </>
              )}
              <div className="location-layer-section">
                {layer(
                  "objects",
                  t("locationObjects"),
                  <Layers className="size-icon-sm" />,
                  scene.objects.length,
                )}
                {scene.objects.map((o) =>
                  row(
                    o.id,
                    o.label,
                    o.kind === "vehicle" ? (
                      <Truck className="size-icon-sm" />
                    ) : o.kind === "note" ? (
                      <MapPin className="size-icon-sm" />
                    ) : (
                      <Box className="size-icon-sm" />
                    ),
                  ),
                )}
              </div>
            </aside>
            <div className="location-canvas-column">
              <div className="location-view-tools">
                <div className="location-toolbar-group">
                  {(
                    [
                      ["select", MousePointer2, "locationSelect", "V"],
                      ["place", Move, "locationPlace", "G"],
                      ["measure", Ruler, "locationMeasure", "M"],
                      ["pan", Hand, "locationPan", "H"],
                    ] as const
                  ).map(([value, Icon, key, shortcut]) => (
                    <Button
                      key={value}
                      variant="ghost"
                      size="icon"
                      title={`${t(key)} (${shortcut})`}
                      aria-keyshortcuts={shortcut}
                      aria-label={t(key)}
                      aria-pressed={tool === value}
                      disabled={value === "place" && !object}
                      onClick={() => {
                        if (value === "measure") setTreeStyle("schematic");
                        setTool(value);
                      }}
                    >
                      <Icon className="size-icon-sm" />
                    </Button>
                  ))}
                </div>
                <div className="location-toolbar-group">
                  <Button
                    variant="ghost"
                    title={t("locationShortcut").replace("{key}", "T")}
                    aria-keyshortcuts="T"
                    onClick={() => viewport.current?.view("top")}
                  >
                    {t("locationTop")}
                  </Button>
                  <Button
                    variant="ghost"
                    title={t("locationShortcut").replace("{key}", "3")}
                    aria-keyshortcuts="3"
                    onClick={() => viewport.current?.view("perspective")}
                  >
                    3D
                  </Button>
                  <Button
                    variant="ghost"
                    title={t("locationShortcut").replace("{key}", "S")}
                    aria-keyshortcuts="S"
                    onClick={() => viewport.current?.view("street")}
                  >
                    {t("locationStreet")}
                  </Button>
                  <Button
                    variant="ghost"
                    title={t("locationShortcut").replace("{key}", "U")}
                    aria-keyshortcuts="U"
                    onClick={() => viewport.current?.view("area")}
                  >
                    {t("locationArea")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title={`${t("locationFrame")} (F)`}
                    aria-keyshortcuts="F"
                    aria-label={t("locationFrame")}
                    onClick={() => viewport.current?.focus(selected)}
                  >
                    <Focus className="size-icon-sm" />
                  </Button>
                  <Button
                    variant="outline"
                    title={`${t("locationFitConstructionHint")} (Shift+F)`}
                    aria-keyshortcuts="Shift+F"
                    onClick={() => viewport.current?.fitConstruction()}
                  >
                    <ScanSearch className="size-icon-sm" />
                    {t("locationFitConstruction")}
                  </Button>
                </div>
              </div>
              <div
                className="location-viewport"
                ref={host}
                data-ready={viewportReady}
                role="region"
                aria-label={t("locationEditor")}
              />
              {viewportError && (
                <div className="location-view-message">
                  <Callout tone="error">{t("locationWebgl")}</Callout>
                </div>
              )}
              {!viewportReady && !viewportError && (
                <div className="location-view-message" role="status">
                  {t("locationLoading")}
                </div>
              )}
              <div className="location-canvas-caption">
                <span>
                  {tool === "place"
                    ? t("locationPlaceHint")
                    : tool === "measure"
                      ? t("locationMeasureHint")
                      : t("locationControls")}
                </span>
                <Badge>{t("locationUnverified")}</Badge>
              </div>
              {measurement.length === 2 && (
                <div className="location-measurement" role="status">
                  {t("locationDistance")}:{" "}
                  <strong>
                    {Math.hypot(
                      ...measurement[0].map((n, i) => n - measurement[1][i]),
                    ).toFixed(2)}{" "}
                    m
                  </strong>{" "}
                  · {t("locationVertical")}:{" "}
                  {Math.abs(measurement[0][1] - measurement[1][1]).toFixed(2)} m
                  <MeasurementActions
                    key={measurement.flat().join(",")}
                    projectId={projectId}
                    context={state.data!.context!}
                    points={[measurement[0], measurement[1]]}
                    onDone={() => setMeasurement([])}
                  />
                </div>
              )}
            </div>
            <aside
              className="location-inspector"
              aria-label={t("locationInspector")}
            >
              <Segmented
                items={[
                  { value: "properties", label: t("locationInspector") },
                  { value: "notes", label: t("locationNotes") },
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === "notes" ? (
                <>
                  <p className="text-ui-xs muted">{t("locationNotesHint")}</p>
                  <Field label={t("locationNotes")}>
                    <Textarea
                      rows={18}
                      maxLength={50000}
                      value={scene.planningNotes}
                      onChange={(e) =>
                        change({ ...scene, planningNotes: e.target.value })
                      }
                    />
                  </Field>
                </>
              ) : object ? (
                <>
                  <Field label={t("locationName")}>
                    <Input
                      value={object.label}
                      maxLength={500}
                      onChange={(e) =>
                        patchObject(object.id, { label: e.target.value })
                      }
                    />
                  </Field>
                  <h3>{t("locationPosition")}</h3>
                  <div className="location-number-grid">
                    {["X", "Y", "Z"].map((axis, i) => (
                      <NumberField
                        key={`${object.id}-${axis}`}
                        label={axis}
                        value={object.position[i]}
                        onChange={(n) =>
                          patchObject(object.id, {
                            position: object.position.map((v, j) =>
                              i === j ? n : v,
                            ) as SceneVector,
                          })
                        }
                      />
                    ))}
                  </div>
                  <NumberField
                    label={t("locationRotation")}
                    value={object.rotation}
                    onChange={(n) => patchObject(object.id, { rotation: n })}
                  />
                  {object.kind !== "note" && (
                    <>
                      <h3>{t("locationDimensions")}</h3>
                      <div className="location-number-grid">
                        {(
                          [
                            "locationWidth",
                            "locationHeight",
                            "locationLength",
                          ] as const
                        ).map((label, i) => (
                          <NumberField
                            key={`${object.id}-${label}`}
                            label={t(label)}
                            min={0.01}
                            value={object.size[i]}
                            disabled={object.kind === "ifc"}
                            onChange={(n) =>
                              patchObject(object.id, {
                                size: object.size.map((v, j) =>
                                  i === j ? n : v,
                                ) as SceneVector,
                              })
                            }
                          />
                        ))}
                      </div>
                    </>
                  )}
                  {object.kind === "vehicle" && (
                    <>
                      <Callout>{t("locationVehicleHint")}</Callout>
                      {envelopeCount !== null && (
                        <dl className="location-values">
                          <dt>{t("locationPointCount")}</dt>
                          <dd>{envelopeCount}</dd>
                        </dl>
                      )}
                      <Callout>{t("locationSafety")}</Callout>
                    </>
                  )}
                  {object.kind === "ifc" && (
                    <>
                      <Badge>{t("locationAlignment")}</Badge>
                      <p className="text-ui-xs muted">{t("locationIfcHint")}</p>
                      {!models[object.id] && (
                        <Callout
                          tone={modelErrors[object.id] ? "error" : "info"}
                        >
                          {modelErrors[object.id]
                            ? `${t("locationIfcFailed")}: ${modelErrors[object.id]}`
                            : t("locationLoading")}
                          {modelErrors[object.id] && (
                            <Button
                              variant="outline"
                              onClick={() => {
                                setModelErrors({});
                                setRetryModels((n) => n + 1);
                              }}
                            >
                              {t("locationRetry")}
                            </Button>
                          )}
                        </Callout>
                      )}
                      <Link
                        className="text-ui-xs underline"
                        to={`/projects/${projectId}?view=sources`}
                      >
                        {t("locationSources")}
                      </Link>
                    </>
                  )}
                  <Field label={t("locationNote")}>
                    <Textarea
                      rows={4}
                      maxLength={10000}
                      value={object.note}
                      onChange={(e) =>
                        patchObject(object.id, { note: e.target.value })
                      }
                    />
                  </Field>
                  <Button
                    variant="outline"
                    onClick={() => {
                      change({
                        ...scene,
                        objects: scene.objects.filter(
                          (o) => o.id !== object.id,
                        ),
                      });
                      setSelected(null);
                      setTool("select");
                    }}
                  >
                    <Trash2 className="size-icon-sm" />
                    {t("locationDelete")}
                  </Button>
                </>
              ) : tree || building ? (
                <>
                  <h3>{tree?.species || building?.label}</h3>
                  <Badge>{t("locationReadOnly")}</Badge>
                  <dl className="location-values">
                    <dt>{t("locationRecordedHeight")}</dt>
                    <dd>
                      {(tree?.height ?? building?.height)?.toFixed(2) ??
                        t("locationUnknown")}{" "}
                      m
                    </dd>
                    {tree && (
                      <>
                        <dt>{t("locationCrown")}</dt>
                        <dd>{tree.crownDiameter ?? t("locationUnknown")} m</dd>
                      </>
                    )}
                  </dl>
                  <Callout>
                    {t(
                      tree
                        ? treeStyle === "illustrative"
                          ? "locationTreeIllustrationHint"
                          : "locationTreeHint"
                        : "locationBuildingHint",
                    )}
                  </Callout>
                  <code className="text-ui-2xs break-all">
                    {tree?.sourceId || building?.sourceId}
                  </code>
                </>
              ) : (
                <>
                  <p className="muted text-ui-sm">{t("locationSelectHint")}</p>
                  {!rlpContext && (
                    <Callout>
                      {t(
                        treeStyle === "illustrative"
                          ? "locationTreeIllustrationHint"
                          : "locationTreeHint",
                      )}
                    </Callout>
                  )}
                  <Callout>{t("locationBuildingHint")}</Callout>
                </>
              )}
              <EnvironmentSurveyButton projectId={projectId} />
              <div className="location-export" role="group" aria-label={t("locationExport")}>
                <span className="text-ui-xs font-medium">{t("locationExport")}</span>
                <p className="text-ui-xs muted">{t("locationExportHint")}</p>
                {(draft || save.isPending || importIfc.isPending) && (
                  <p className="text-ui-xs muted" role="status">{t("locationExportSaveFirst")}</p>
                )}
                {(["dxf", "geojson"] as const).map((format) => (
                  draft || save.isPending || importIfc.isPending ? (
                    <Button key={format} disabled variant="outline" size="xs" title={t("locationExportSaveFirst")}>
                      <Download aria-hidden="true" />
                      {t(format === "dxf" ? "locationExportDxf" : "locationExportGeoJson")}
                    </Button>
                  ) : <Button key={format} asChild variant="outline" size="xs">
                    <a href={`/api/projects/${projectId}/location/export?format=${format}`} download title={t("locationExportHint")}>
                      <Download aria-hidden="true" />
                      {t(format === "dxf" ? "locationExportDxf" : "locationExportGeoJson")}
                    </a>
                  </Button>
                ))}
              </div>
              {!!state.data?.context?.publicReleases?.length && (
                <PublicDataStatus projectId={projectId} state={state.data} address={address} />
              )}
              <details className="location-sources">
                <summary>{t("locationSources")}</summary>
                {state.data!.context!.sources.map((source) => (
                  <a
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.label}
                  </a>
                ))}
                {!rlpContext && (
                  <a
                    href="https://gdi.berlin.de/geonetwork/srv/api/records/85a97801-36bb-4627-8790-f5e53b1e38b3"
                    target="_blank"
                    rel="noreferrer"
                  >
                    LiDAR · 24.02.–02.03.2021 · dl-de-zero-2.0
                  </a>
                )}
                {cloud.data && (
                  <p>
                    {t("locationGround")}:{" "}
                    {cloud.data.groundElevation.toFixed(2)} m · DHHN2016
                  </p>
                )}
              </details>
            </aside>
          </div>
          <footer className="location-status">
            <span>{t("locationOrigin")}</span>
            <span>
              {state.data!.context!.crs ?? "EPSG:25833"} ·{" "}
              {state.data!.context!.origin.map((n) => n.toFixed(2)).join(" / ")}
            </span>
            <span>{t("locationLighting")}</span>
          </footer>
        </>
      ) : null}
    </div>
  );
}
