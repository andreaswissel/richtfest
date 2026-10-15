import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { EnvironmentSurvey, LocationState } from "@richtfest/shared";
import { api } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { usePreferences } from "../../store";
import { Button } from "../ui/button";
import { Badge, Callout, Modal, Table } from "../ui/primitives";

const categoryKeys = {
  roads: "environmentRoad", rail: "environmentRail", industry: "environmentIndustry",
  ground_aviation: "environmentGroundAviation", flightpaths: "environmentFlightpaths", noise_contours: "environmentNoiseContours",
} as const;
const statusKeys = {
  findings: "environmentEvidenceFound", no_features_in_query: "environmentNoFeatures",
  unavailable: "environmentUnavailable", not_checked: "environmentNotChecked",
} as const;
const safeUrl = (value: string) => {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? value : undefined; }
  catch { return undefined; }
};

export function EnvironmentSurveyButton({ projectId }: { projectId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="outline" onClick={() => setOpen(true)}>{t("environmentCheck")}</Button>
    {open && <EnvironmentSurveyDialog projectId={projectId} onClose={() => setOpen(false)} />}
  </>;
}

function EnvironmentSurveyDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useT();
  const language = usePreferences(state => state.language);
  const session = useApi("/auth/me");
  const canWrite = (session.data?.permissions || session.data?.user?.permissions || []).includes("projects:write");
  const path = `/projects/${projectId}/environment`;
  const locationPath = `/projects/${projectId}/location`;
  const query = useQuery({ queryKey: [path], queryFn: () => api<EnvironmentSurvey | null>(path) });
  const location = useQuery({ queryKey: [locationPath], queryFn: () => api<LocationState>(locationPath) });
  const survey = query.data;
  const run = useMutation({
    mutationFn: () => api<EnvironmentSurvey>(path, { revision: location.data!.revision, refresh: !!survey }),
    onError: () => { void queryClient.invalidateQueries({ queryKey: [locationPath] }); },
    onSuccess: data => {
      queryClient.setQueryData([path], data);
      void queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/files`] });
    },
  });
  const date = (value: string) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? t("environmentUnavailable") : parsed.toLocaleString(language);
  };
  const receiptUrl = survey?.downloadUrl?.startsWith("/api/") && !survey.downloadUrl.includes("\\") ? survey.downloadUrl : undefined;
  return <Modal wide title={t("environmentCheck")} onClose={onClose}>
    <div className="flex min-w-0 flex-col gap-stack">
      <Callout>{t("environmentScopeHint")}</Callout>
      {query.isPending && <p role="status">{t("loading")}</p>}
      {query.isError && <Callout tone="error">{query.error.message} <Button variant="link" onClick={() => query.refetch()}>{t("retry")}</Button></Callout>}
      {query.isSuccess && !survey && <p className="text-ui-sm text-muted-foreground">{t("environmentNoSurvey")}</p>}
      {survey && <div className="space-y-1 text-ui-sm">
        <p>{survey.site.address}</p>
        <p>{t("environmentScope")}: {survey.scope.radiusMeters} m · {survey.site.latitude.toFixed(5)}, {survey.site.longitude.toFixed(5)}</p>
        <p>{t("environmentCheckedAt")}: {date(survey.retrievedAt)}</p>
        <p className="text-ui-xs text-muted-foreground">{t("environmentBounds")}: {survey.scope.bbox.map(value => value.toFixed(5)).join(" / ")}</p>
      </div>}
      <div className="max-h-80 overflow-auto divide-y">
        {(Object.keys(categoryKeys) as Array<keyof typeof categoryKeys>).map(category => {
          const result = survey?.categories.find(item => item.category === category);
          return <details key={category} className="group/environment-category py-cell">
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-ui-sm">
              <span className="flex min-w-0 items-center gap-2 font-medium"><ChevronRight aria-hidden="true" className="size-icon-sm shrink-0 transition-transform group-open/environment-category:rotate-90" />{t(categoryKeys[category])}{result && ["findings", "no_features_in_query"].includes(result.status) ? ` · ${result.featureCount}` : ""}{result?.spatial?.status === "checked" ? ` · ${t("environmentSpatialChecked")}` : result?.catalog?.status === "retrieved" ? ` · ${t("environmentCatalogRetrieved")}` : ""}</span>
              <Badge>{t(statusKeys[result?.status ?? "not_checked"])}</Badge>
            </summary>
            {result && <div className="space-y-2 pt-2 text-ui-sm">
              {result.spatial && <div className="space-y-2">
                <p className="font-medium">{t(result.spatial.status === "checked" ? "environmentSpatialChecked" : "environmentSpatialUnavailable")}</p>
                <Callout>{t("environmentSpatialScope")}</Callout>
                <p>{t("environmentSiteLevel")}: {t("environmentUnknownLevel")}</p>
                {!!result.spatial.layers.length && <div className="overflow-auto [&_td]:whitespace-normal [&_th]:whitespace-normal">
                  <Table headers={[t("environmentCatalogLayer"), t("environmentSpatialRelation"), t("environmentPublishedLevels")]} rows={result.spatial.layers.map(layer => ({ id: layer.theme, cells: [
                    <div><p>{layer.theme}</p><p className="text-ui-xs text-muted-foreground">{layer.year} · {t(layer.period === "day" ? "environmentCatalogDay" : "environmentCatalogNight")} · {layer.metric}</p></div>,
                    t(layer.relation === "outside_published_contour_extent" ? "environmentOutsideExtent" : "environmentWithinExtent"),
                    <div><p>{layer.publishedLevelsDbA.length ? `${layer.publishedLevelsDbA.join(", ")} dB(A)` : t("environmentUnknownLevel")}</p>{!layer.levelAttributesComplete && <p className="text-ui-xs text-muted-foreground">{t("environmentIncompleteLevels")}</p>}</div>,
                  ] }))} />
                </div>}
              </div>}
              {result.catalog && result.spatial?.status !== "checked" && <div className="space-y-2">
                <p>{t(result.catalog.status === "retrieved" ? "environmentCatalogRetrieved" : "environmentCatalogUnavailable")}</p>
                <p className="text-muted-foreground">{t("environmentCatalogScope")}</p>
                {!!result.catalog.layers.length && <Table headers={[t("environmentCatalogLayer"), t("environmentCatalogYear"), t("environmentCatalogPeriod"), t("environmentCatalogMetric")]} rows={result.catalog.layers.map(layer => ({ id: layer.theme, cells: [layer.theme, String(layer.year), t(layer.period === "day" ? "environmentCatalogDay" : "environmentCatalogNight"), layer.metric] }))} />}
              </div>}
              {["findings", "no_features_in_query"].includes(result.status) && <p>{t("environmentFeatures")}: {result.featureCount} · {t("environmentQueryLimit")}: {result.coverage.limit}{result.coverage.truncated ? ` · ${t("environmentTruncated")}` : ""}</p>}
              {result.observations.length > 0 && <ul className="list-disc pl-4">{result.observations.map(item => <li key={item.id}>{item.name || item.id} <span className="text-muted-foreground">· {item.kind}</span></li>)}</ul>}
              {result.limitations.map((limitation, index) => <p key={index} className="text-muted-foreground">{limitation}</p>)}
              {result.sources.map((source, index) => <div key={`${source.url}-${index}`} className="break-all">
                <a className="underline" href={safeUrl(source.url)} target="_blank" rel="noreferrer">{source.url}</a>
                <p className="text-ui-xs text-muted-foreground">{t("environmentCheckedAt")}: {date(source.retrievedAt)}</p>
              </div>)}
            </div>}
          </details>;
        })}
      </div>
      {!!survey?.limitations.length && <details className="text-ui-sm"><summary className="cursor-pointer">{t("environmentLimitations")}</summary><ul className="list-disc pl-4 pt-2 text-muted-foreground">{survey.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>}
      <div className="space-y-2">
        <p className="text-ui-sm text-muted-foreground">{t("environmentAviationHint")}</p>
        <Button asChild variant="link"><a href="https://framap.fraport.de/framap/main/r/isfl/go" target="_blank" rel="noreferrer">{t("environmentFraport")} ↗</a></Button>
      </div>
      {location.isError && <Callout tone="error">{location.error.message} <Button variant="link" onClick={() => location.refetch()}>{t("retry")}</Button></Callout>}
      {run.isError && <Callout tone="error">{run.error.message}</Callout>}
      <div className="flex flex-wrap justify-end gap-2">
        {receiptUrl && <Button asChild variant="outline"><a href={receiptUrl} target="_blank" rel="noreferrer">{t("environmentReceipt")}</a></Button>}
        {canWrite && <Button disabled={!location.data || query.isPending || query.isError || run.isPending} onClick={() => run.mutate()}>{run.isPending ? t("loading") : survey ? t("environmentRefresh") : t("environmentRun")}</Button>}
      </div>
    </div>
  </Modal>;
}
