import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Crosshair, FileStack, Image as ImageIcon, Route, Volume2 } from "lucide-react";
import {
  aerialSourceFor,
  railNoiseAttribution,
  siteToPlan,
  twoPointPlacement,
  type LocationContext,
  type NoiseSource,
  type Point2,
} from "@richtfest/shared";
import { api } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout } from "../ui/primitives";
import { fromLocal, useSiteGeometry, type SiteGeometry, type SiteOverlay } from "./site-geometry";
import "./site-workbench.css";

type T = ReturnType<typeof useT>;
type Pick = { local: Point2; plan?: Point2; site?: Point2 };
const SNAP_M = 1.5;
/** EBA legend colours, Lden bands in dB(A). */
const railNoiseBands = [
  ["#E2F2BF", "55–59"],
  ["#F3C683", "60–64"],
  ["#CD463E", "65–69"],
  ["#75085C", "70–74"],
  ["#420848", "≥ 75"],
] as const;

const nearest = (point: Point2, candidates: Point2[]) => {
  let best: { index: number; distance: number } | null = null;
  candidates.forEach((candidate, index) => {
    const distance = Math.hypot(candidate[0] - point[0], candidate[1] - point[1]);
    if (distance <= SNAP_M && (!best || distance < best.distance)) best = { index, distance };
  });
  return best as { index: number; distance: number } | null;
};

const invalidate = (projectId: string) =>
  queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith(`/projects/${projectId}/`) });

/** Basis written with an adopted facade distance, so the value stays traceable to plan, page and placement state. */
export function distanceBasis(geometry: SiteGeometry, facade: string, t: T) {
  const page = geometry.page!;
  return t("siteDistanceBasis")
    .replace("{file}", page.fileName ?? t("sitePlanUnnamed"))
    .replace("{page}", String(page.page))
    .replace("{facade}", t(`siteFacade${facade}` as Parameters<T>[0]))
    .replace("{status}", t(geometry.status === "reviewed" ? "sitePlacementReviewed" : "sitePlacementApproximate"));
}

export function useApplyDistance(projectId: string) {
  return useMutation({
    mutationFn: ({ source, value, basis }: { source: NoiseSource; value: number; basis: string }) =>
      api(`/projects/${projectId}/noise-sources/${source.id}/inputs/distanceToFacade`, { value, basis, expectedVersion: source.inputs.distanceToFacade?.version ?? 0 }, "PUT"),
    onSuccess: () => invalidate(projectId),
  });
}

/** One adopted-or-adoptable facade distance; used in the viewer and in the exterior noise inputs. */
export function FacadeDistanceRow({ projectId, geometry, item, canWrite, compact }: {
  projectId: string;
  geometry: SiteGeometry;
  item: SiteGeometry["distances"][number];
  canWrite: boolean;
  compact?: boolean;
}) {
  const t = useT();
  const apply = useApplyDistance(projectId);
  const current = item.source.inputs.distanceToFacade?.value;
  const inUse = typeof current === "number" && Math.abs(current - item.distance) < 0.05;
  const facade = t(`siteFacade${item.facade}` as Parameters<T>[0]);
  return (
    <div className="site-distance-row">
      <span>
        {!compact && <strong>{item.source.name}</strong>}
        <span>
          {item.distance.toFixed(1)} m · {t("siteFacadeLabel").replace("{facade}", facade)}
        </span>
      </span>
      {inUse ? (
        <Badge variant="outline">{t("siteDistanceInUse")}</Badge>
      ) : canWrite && geometry.stored ? (
        <Button size="sm" variant="outline" disabled={apply.isPending}
          onClick={() => apply.mutate({ source: item.source, value: item.distance, basis: distanceBasis(geometry, item.facade, t) })}>
          {t("siteUseDistance")}
        </Button>
      ) : null}
      {apply.isError && <small className="noise-input-error">{apply.error instanceof Error ? apply.error.message : String(apply.error)}</small>}
    </div>
  );
}

/**
 * Site layers for exterior noise in the location viewer: mapped road/rail
 * axes, federal rail noise contours, the plan placed by two point pairs, and
 * facade distances measured from it.
 */
export function useSiteWorkbench({ projectId, context, layers, tool, setTool }: {
  projectId: string;
  context: LocationContext | null;
  layers: { roads: boolean; railNoise: boolean; plan: boolean; aerial: boolean };
  tool: string;
  setTool: (tool: "select" | "align") => void;
}) {
  const t = useT();
  const session = useApi("/auth/me");
  const canWrite = (session.data?.permissions || session.data?.user?.permissions || []).includes("projects:write");
  const [pageIndex, setPageIndex] = useState(0);
  const [picks, setPicks] = useState<Pick[]>([]);
  const pending = useMemo(
    () => picks.length === 4 ? twoPointPlacement([picks[0].plan!, picks[2].plan!], [picks[1].site!, picks[3].site!]) : null,
    [picks],
  );
  const { geometry, sitePlan } = useSiteGeometry(projectId, pageIndex, pending);
  const [zoomedOut, setZoomedOut] = useState(false);
  const aerialSource = context ? aerialSourceFor(context) : null;
  const image = (path: string, enabled: boolean, error: string) => ({
    queryKey: [`/projects/${projectId}/location/${path}`, context?.importedAt],
    queryFn: async () => {
      const response = await fetch(`/api/projects/${projectId}/location/${path}`, { credentials: "include" });
      if (!response.ok) throw new Error(error);
      return URL.createObjectURL(await response.blob());
    },
    enabled: enabled && !!context,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
    meta: { persist: false },
  });
  const railNoise = useQuery(image("rail-noise", layers.railNoise, t("siteRailNoiseUnavailable")));
  const aerialNear = useQuery(image("aerial/near", layers.aerial && !!aerialSource, t("siteAerialUnavailable")));
  // The wide window is only fetched once the planner zooms out of the neighbourhood.
  const aerialFar = useQuery(image("aerial/far", layers.aerial && !!aerialSource && zoomedOut, t("siteAerialUnavailable")));
  useEffect(() => () => { if (aerialNear.data) URL.revokeObjectURL(aerialNear.data); }, [aerialNear.data]);
  useEffect(() => () => { if (aerialFar.data) URL.revokeObjectURL(aerialFar.data); }, [aerialFar.data]);
  useEffect(() => () => { if (railNoise.data) URL.revokeObjectURL(railNoise.data); }, [railNoise.data]);
  const aligning = tool === "align";
  useEffect(() => { if (!aligning && picks.length < 4) setPicks([]); }, [aligning]);
  const planVertices = useMemo(() => (geometry?.walls ?? []).flatMap((wall) => wall.ring), [geometry?.walls]);
  const siteVertices = useMemo(() => (context?.buildings ?? []).flatMap((building) => building.polygons.flatMap((polygon) => polygon[0] ?? [])), [context]);
  const onAlign = (point: Point2) => {
    if (!context || !geometry?.page || !geometry.placement || picks.length >= 4) return;
    const planStep = picks.length % 2 === 0;
    if (planStep) {
      const hit = nearest(point, planVertices);
      const local = hit ? planVertices[hit.index] : point;
      const planPoint = hit ? geometry.page.walls.flatMap((wall) => wall.ring)[hit.index] : siteToPlan(fromLocal(context, point), geometry.placement);
      setPicks((current) => [...current, { local, plan: planPoint }]);
    } else {
      const hit = nearest(point, siteVertices);
      const local = hit ? siteVertices[hit.index] : point;
      const next = [...picks, { local, site: fromLocal(context, local) }];
      setPicks(next);
      if (next.length === 4) setTool("select");
    }
  };
  const save = useMutation({
    mutationFn: (status: "approximate" | "reviewed") => {
      const placement = status === "reviewed" && !pending ? geometry!.stored! : geometry!.placement!;
      const page = geometry!.page!;
      const quote = pending
        ? t("sitePlacementQuote").replace("{ratio}", pending.scaleRatio.toFixed(3))
        : sitePlan?.placement?.evidence[0]?.quote;
      return api(`/projects/${projectId}/building-model/placement`, {
        baseRevision: sitePlan!.modelRevision,
        origin: { x: Math.round(placement.origin[0] * 1000) / 1000, y: Math.round(placement.origin[1] * 1000) / 1000, crs: context?.crs ?? "EPSG:25833" },
        orientation: { degrees: Math.round(placement.degrees * 1000) / 1000 },
        alignmentStatus: status,
        evidence: [{ kind: "page", sourceVersionId: page.sourceVersionId, page: page.page, ...(quote ? { quote } : {}) }],
      }, "PUT");
    },
    onSuccess: () => { setPicks([]); return invalidate(projectId); },
  });
  // Distances only mean something for a stored or freshly aligned placement, never the centred default.
  const distances = useMemo(() => geometry?.stored || pending ? geometry?.distances ?? [] : [], [geometry, pending]);
  const overlay: SiteOverlay = useMemo(() => ({
    axes: geometry?.axes ?? [],
    plan: geometry?.page ? { walls: geometry.walls } : null,
    distances: distances.map((item) => ({
      id: item.sourceId,
      from: [item.from[0] - context!.origin[0], context!.origin[1] - item.from[1]] as Point2,
      to: [item.to[0] - context!.origin[0], context!.origin[1] - item.to[1]] as Point2,
      label: `${item.distance.toFixed(1)} m`,
    })),
    railNoise: railNoise.data ?? null,
    aerial: { near: aerialNear.data ?? null, far: aerialFar.data ?? null },
    picks: aligning ? picks.map((pick) => pick.local) : [],
    snaps: aligning ? (picks.length % 2 === 0 ? planVertices : siteVertices) : [],
  }), [geometry, distances, context, railNoise.data, aerialNear.data, aerialFar.data, aligning, picks, planVertices, siteVertices]);

  const steps = ["sitePickPlanA", "sitePickSiteA", "sitePickPlanB", "sitePickSiteB"] as const;
  const scaleOff = pending && Math.abs(pending.scaleRatio - 1) > 0.02;
  const panel = (layer: (key: "roads" | "railNoise" | "plan" | "aerial", label: string, icon: ReactNode, count?: number) => ReactNode) => (
    <>
      {aerialSource && (
        <div className="location-layer-section">
          {layer("aerial", t("siteAerial"), <ImageIcon className="size-icon-sm" />)}
          {layers.aerial && (
            <>
              {(aerialNear.isFetching || aerialFar.isFetching) && <p className="text-ui-xs muted">{t("siteAerialLoading")}</p>}
              {(aerialNear.isError || aerialFar.isError) && <Callout tone="error">{t("siteAerialUnavailable")}</Callout>}
              <p className="text-ui-2xs muted">{t("siteAerialHint")} {aerialSource.attribution}</p>
            </>
          )}
        </div>
      )}
      <div className="location-layer-section">
        {layer("roads", t("siteRoadsRail"), <Route className="size-icon-sm" />, geometry?.axes.length)}
        {geometry && !geometry.axes.length && <p className="text-ui-xs muted">{t("siteAxesMissing")}</p>}
      </div>
      <div className="location-layer-section">
        {layer("railNoise", t("siteRailNoise"), <Volume2 className="size-icon-sm" />)}
        {layers.railNoise && (
          <>
            {railNoise.isFetching && <p className="text-ui-xs muted">{t("siteRailNoiseLoading")}</p>}
            {railNoise.isError && <Callout tone="error">{t("siteRailNoiseUnavailable")}</Callout>}
            <ul className="site-noise-legend" aria-label={t("siteRailNoiseLegend")}>
              {railNoiseBands.map(([color, band]) => (
                <li key={band}><span style={{ background: color }} />{band} dB(A)</li>
              ))}
            </ul>
            <p className="text-ui-2xs muted">{t("siteRailNoiseHint")} {railNoiseAttribution}</p>
          </>
        )}
      </div>
      <div className="location-layer-section">
        {layer("plan", t("sitePlan"), <FileStack className="size-icon-sm" />)}
        {!geometry?.page ? (
          <p className="text-ui-xs muted">{t("sitePlanMissing")}</p>
        ) : (
          <>
            {sitePlan && sitePlan.pages.length > 1 && (
              <NativeSelect aria-label={t("sitePlanPage")} value={String(pageIndex)} onChange={(event) => { setPageIndex(Number(event.target.value)); setPicks([]); }}>
                {sitePlan.pages.map((page, index) => (
                  <option key={`${page.sourceVersionId}:${page.page}`} value={index}>
                    {[page.storey?.name, `${page.fileName ?? t("sitePlanUnnamed")} p. ${page.page}`].filter(Boolean).join(" · ")}
                  </option>
                ))}
              </NativeSelect>
            )}
            <p className="site-plan-status">
              <Badge variant="outline">
                {t(geometry.status === "reviewed" ? "sitePlacementReviewed" : geometry.status === "none" ? "sitePlacementNone" : "sitePlacementApproximate")}
              </Badge>
              {geometry.page.scale.denominator && <span className="text-ui-xs muted">1:{geometry.page.scale.denominator}</span>}
            </p>
            {aligning ? (
              <div className="site-align-step" role="status">
                <span className="text-ui-xs">{t("siteStep").replace("{step}", String(picks.length + 1))} {t(steps[Math.min(picks.length, 3)])}</span>
                <Button size="sm" variant="ghost" onClick={() => { setPicks([]); setTool("select"); }}>{t("cancel")}</Button>
              </div>
            ) : pending ? (
              <>
                <p className="text-ui-xs">
                  {t("siteAlignResult").replace("{degrees}", pending.degrees.toFixed(1)).replace("{ratio}", pending.scaleRatio.toFixed(3))}
                </p>
                {scaleOff && <Callout>{t("siteScaleMismatch")}</Callout>}
                {save.isError && <Callout tone="error">{save.error instanceof Error ? save.error.message : String(save.error)}</Callout>}
                <div className="inline-actions">
                  {canWrite && <Button size="sm" disabled={save.isPending} onClick={() => save.mutate("approximate")}>{t("siteSavePlacement")}</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setPicks([])}>{t("siteDiscardAlignment")}</Button>
                </div>
              </>
            ) : canWrite ? (
              <div className="inline-actions">
                <Button size="sm" variant="outline" title={`${t("siteAlignPlan")} (A)`} aria-keyshortcuts="A" onClick={() => { setPicks([]); setTool("align"); }}>
                  <Crosshair className="size-icon-sm" />
                  {t("siteAlignPlan")}
                </Button>
                {geometry.status === "approximate" && (
                  <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate("reviewed")}>{t("siteMarkReviewed")}</Button>
                )}
              </div>
            ) : null}
            {!geometry.stored && !pending && <p className="text-ui-xs muted">{t("sitePlanUnplacedHint")}</p>}
          </>
        )}
      </div>
      {geometry?.page && (
        <div className="location-layer-section">
          <h3 className="site-section-title">{t("siteFacadeDistances")}</h3>
          {!geometry.stored && !pending ? (
            <p className="text-ui-xs muted">{t("siteDistancesNeedPlacement")}</p>
          ) : distances.length ? (
            <>
              {distances.map((item) => (
                <FacadeDistanceRow key={item.sourceId} projectId={projectId} geometry={geometry} item={item} canWrite={canWrite} />
              ))}
              {pending && <p className="text-ui-xs muted">{t("siteDistancesPreview")}</p>}
              {geometry.allWalls && <p className="text-ui-xs muted">{t("siteAllWallsMeasured")}</p>}
            </>
          ) : (
            <p className="text-ui-xs muted">
              {t("siteNoMeasuredSources")}{" "}
              <Link className="underline underline-offset-2" to={`/projects/${projectId}?view=noise`}>{t("buildingExteriorNoiseOpen")}</Link>
            </p>
          )}
        </div>
      )}
    </>
  );
  return { overlay, onAlign, onZoom: setZoomedOut, panel, canAlign: !!geometry?.page, snapVertices: [...siteVertices, ...planVertices] };
}
