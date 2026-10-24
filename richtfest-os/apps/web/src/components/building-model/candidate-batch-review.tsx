import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api";
import { queryClient } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Callout, Field } from "../ui/primitives";
import type { BuildingModelState } from "./types";

type Preview = {
  baseRevision: number; scoreVersion: string; threshold: number; sourceVersionId: string; modelState: BuildingModelState;
  eligible: Array<{ id: string; name: string; page: number; entityType: string; score: number }>;
  excludedCount: number; unscoredCount: number;
};

export function CandidateBatchReview({ projectId, revision, sourceVersionId, modelState, candidateHref }: {
  projectId: string; revision: number; sourceVersionId: string; modelState: BuildingModelState; candidateHref: (id: string) => string;
}) {
  const t = useT();
  const [threshold, setThreshold] = useState("90");
  const [confirmed, setConfirmed] = useState(false);
  const number = Number(threshold);
  const validThreshold = threshold.trim() !== "" && Number.isInteger(number) && number >= 0 && number <= 100;
  const path = `/projects/${projectId}/building-model/extraction-candidates`;
  const preview = useMutation({
    mutationFn: () => api<Preview>(`${path}/preview`, { baseRevision: revision, sourceVersionId, modelState, threshold: number }),
    onMutate: () => setConfirmed(false),
  });
  const result = preview.data;
  const current = result && result.baseRevision === revision && result.sourceVersionId === sourceVersionId && result.modelState === modelState && result.threshold === number;
  const adopt = useMutation({
    mutationFn: () => api<{ revision: number; adoptedCount: number }>(`${path}/adopt`, {
      baseRevision: result!.baseRevision, sourceVersionId: result!.sourceVersionId, modelState: result!.modelState,
      threshold: result!.threshold, scoreVersion: result!.scoreVersion, candidateIds: result!.eligible.map(item => item.id),
    }),
    onSuccess: async () => {
      setConfirmed(false);
      preview.reset();
      await queryClient.invalidateQueries({ queryKey: [`/projects/${projectId}/building-model`] });
    },
  });
  return <details className="building-task-panel-section text-ui-xs">
    <summary className="cursor-pointer font-medium">{t("buildingBatchTitle")}</summary>
    <p className="text-muted-foreground">{t("buildingBatchExplain")}</p>
    <Field label={t("buildingBatchThreshold")}><Input type="number" min={0} max={100} step={1} value={threshold} aria-label={t("buildingBatchThreshold")}
      disabled={preview.isPending || adopt.isPending} onChange={event => { setThreshold(event.target.value); setConfirmed(false); }} /></Field>
    <Button type="button" size="sm" variant="outline" disabled={!validThreshold || preview.isPending || adopt.isPending} onClick={() => { adopt.reset(); preview.mutate(); }}>{preview.isPending ? t("loading") : t("buildingBatchPreview")}</Button>
    {(preview.error || adopt.error) && <Callout tone="error">{(preview.error || adopt.error)?.message}</Callout>}
    {adopt.isSuccess && <p role="status">{t("buildingBatchDone").replace("{count}", String(adopt.data.adoptedCount))}</p>}
    {result && <>
      {!current && <Callout>{t("buildingBatchStale")}</Callout>}
      <p role="status">{t("buildingBatchEligible").replace("{count}", String(result.eligible.length)).replace("{excluded}", String(result.excludedCount)).replace("{unscored}", String(result.unscoredCount))}</p>
      <p className="text-muted-foreground">{t("buildingBatchChecks")}</p>
      {result.eligible.length > 0 && <>
        <ul className="building-task-panel-list building-task-panel-saved">
          {result.eligible.map(item => <li key={item.id}><Link className="building-task-panel-link" to={candidateHref(item.id)}>
            <span>{item.name}<small>{t("buildingModelPage")} {item.page}</small></span><span>{item.score}%</span>
          </Link></li>)}
        </ul>
        <Callout>{t("buildingBatchLimits")}</Callout>
        <label className="flex items-start gap-stack"><Checkbox checked={confirmed} disabled={!current || preview.isPending || adopt.isPending} onCheckedChange={value => setConfirmed(value === true)} /><span>{t("buildingBatchConfirm")}</span></label>
        <Button type="button" size="sm" disabled={!current || !confirmed || preview.isPending || adopt.isPending} onClick={() => adopt.mutate()}>{adopt.isPending ? t("loading") : t("buildingBatchAdopt").replace("{count}", String(result.eligible.length))}</Button>
      </>}
    </>}
  </details>;
}
