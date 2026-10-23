import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fireHeightMetres } from "@richtfest/shared/plan-heights";
import { api, ApiError } from "../../api";
import { registerMessages, useT } from "../../i18n";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Field } from "../ui/primitives";
import type { BuildingModel } from "./types";
import en from "./locales/en.json";
import de from "./locales/de.json";

registerMessages({ en, de });

/** Saved source observations only; transfer creates an unreviewed property, never approval. */
export function PlanHeights({ projectId, model, onPage }: {
  projectId: string; model: Pick<BuildingModel, "revision" | "buildings" | "automaticPlanProcessing" | "planSources">;
  onPage: (page: number, sourceVersionId: string) => void;
}) {
  const t = useT(), client = useQueryClient();
  const sources = model.automaticPlanProcessing.filter(item => item.renderableSource?.mimeType === "application/pdf"
    && model.planSources.some(plan => plan.source?.versionId === item.sourceVersionId));
  const [sourceId, setSourceId] = useState("");
  const source = sources.find(item => item.sourceVersionId === sourceId) ?? sources[0];
  const [buildingId, setBuildingId] = useState("");
  const building = model.buildings.length === 1 ? model.buildings[0] : model.buildings.find(item => item.id === buildingId);
  const extraction = source?.heightExtraction;
  const safeRetry = extraction?.status === "partial" && extraction.pages.length > 0
    && extraction.pages.every(page => ["unconfigured", "forbidden", "unavailable"].includes(page.status));
  const active = sources.some(item => ["queued", "processing"].includes(item.heightExtraction?.status ?? ""));
  const invalidate = () => client.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void client.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] }); }, 2500);
    return () => clearInterval(timer);
  }, [active, client, projectId]);
  const queue = useMutation({
    mutationFn: (sourceVersionId: string) => api(`/projects/${projectId}/building-model/height-extractions`, { sourceVersionId }),
    onSuccess: invalidate,
  });
  const transfer = useMutation({
    mutationFn: (input: { sourceVersionId: string; page: number; observationIndex: number; buildingId: string }) =>
      api(`/projects/${projectId}/building-model/height-observations`, { baseRevision: model.revision, ...input }),
    onSuccess: invalidate,
  });
  const error = transfer.error ?? queue.error;
  const label = (value: string) => t(`buildingHeight_${value}` as keyof typeof en);
  return <section className="grid gap-stack text-ui-sm" aria-label={t("buildingHeightTitle")}>
    <h3 className="building-model-panel-title">{t("buildingHeightTitle")}</h3>
    <Callout>{t("buildingHeightUnreviewed")}</Callout>
    {!source ? <p>{t("buildingHeightNoSource")}</p> : <>
      {sources.length > 1 && <Field label={t("buildingHeightSource")}><NativeSelect value={source.sourceVersionId} onChange={event => { setSourceId(event.target.value); queue.reset(); transfer.reset(); }}>
        {sources.map(item => <option key={item.sourceVersionId} value={item.sourceVersionId}>{item.fileName}</option>)}
      </NativeSelect></Field>}
      {sources.length === 1 && <p>{source.fileName}</p>}
      {(!extraction || safeRetry) && <Button size="sm" variant="outline" disabled={queue.isPending || (!extraction && queue.isSuccess)} onClick={() => queue.mutate(source.sourceVersionId)}>{t("buildingHeightExtract")}</Button>}
      {extraction && <Badge>{label(extraction.status)}</Badge>}
      {extraction?.status === "unavailable" && !extraction.pages.length && <p>{t("buildingHeightNoSections")}</p>}
      {queue.isSuccess && !extraction && <Badge>{label("queued")}</Badge>}
      {extraction?.omittedPages?.length ? <p>{t("buildingHeightOmitted").replace("{pages}", extraction.omittedPages.join(", "))}</p> : null}
      {model.buildings.length > 1 && <Field label={t("buildingHeightTarget")}><NativeSelect value={buildingId} onChange={event => { setBuildingId(event.target.value); transfer.reset(); }}>
        <option value="">{t("buildingHeightChooseBuilding")}</option>
        {model.buildings.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
      </NativeSelect></Field>}
      {building?.componentProperties.fireHeight && <Callout>{t("buildingHeightAlreadySet")}</Callout>}
      {extraction?.pages.map(page => <details key={page.page} className="border-t py-cell">
        <summary className="cursor-pointer text-ui-sm">{t("buildingHeightPage").replace("{page}", String(page.page))} · {label(page.status)} · {page.observations.length}</summary>
        <div className="grid gap-stack pt-2">
        <div className="flex items-center gap-2"><Button variant="link" size="sm" onClick={() => onPage(page.page, source.sourceVersionId)}>{t("buildingHeightPage").replace("{page}", String(page.page))}</Button><Badge>{label(page.status)}</Badge></div>
        {page.status === "completed" && !page.observations.length && <p>{t("buildingHeightNoObservations")}</p>}
        {page.observations.map((observation, observationIndex) => {
          const metres = page.status === "completed" ? fireHeightMetres(observation) : null;
          return <div key={observationIndex} className="grid gap-stack border-t pt-2">
            <div><Badge>{label(observation.kind)}</Badge> <strong>{observation.value} {observation.unit === "unknown" ? label("unknown") : observation.unit}</strong> · {label(observation.unitBasis)}</div>
            <p>{[observation.buildingLabel, observation.storeyLabel, label(observation.constructionState)].filter(Boolean).join(" · ")}</p>
            <p>{label(observation.lowerReference)} → {label(observation.upperReference)} · {label(observation.floorBasis)}</p>
            <blockquote className="border-l pl-2">{observation.quote}</blockquote>
            <p>{observation.reason}</p>
            {metres !== null && <Button size="sm" variant="outline" disabled={!building || Boolean(building.componentProperties.fireHeight) || transfer.isPending || transfer.isSuccess} onClick={() => building && transfer.mutate({ buildingId: building.id, sourceVersionId: source.sourceVersionId, page: page.page, observationIndex })}>{t("buildingHeightUse").replace("{value}", String(metres))}</Button>}
          </div>;
        })}
        {page.gaps.map((gap, index) => <Callout key={index}>{gap}</Callout>)}
        {page.metadata && <details><summary>{t("buildingHeightProvenance")}</summary><pre className="whitespace-pre-wrap break-all text-ui-xs">{JSON.stringify(page.metadata, null, 2)}</pre></details>}
        </div>
      </details>)}
    </>}
    {transfer.isSuccess && <Callout>{t("buildingHeightCopied")}</Callout>}
    {error && <Callout>{error instanceof ApiError && error.status === 409 ? t("buildingModelOptimisticConflict") : error.message}</Callout>}
  </section>;
}
