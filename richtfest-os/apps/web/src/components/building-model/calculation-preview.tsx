import { useMutation } from "@tanstack/react-query";
import { api } from "../../api";
import { registerMessages, useT } from "../../i18n";
import { Button } from "../ui/button";
import { Badge, Callout } from "../ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import en from "./locales/en.json";
import de from "./locales/de.json";

registerMessages({ en, de });
type Preview = {
  modelRevision: number; inputHash: string; candidates: Array<{ id: string }>; excluded: Array<{ id: string; reason: string }>;
  geometry: Array<{ id: string; name: string; areaM2: number | null; clearHeight: number | null; adjacentWallIds: string[] }>;
  fire: { snapshot: { available: boolean; reason?: string }; assessment: null | { observations: Array<{ outcome: string }>; concept: string | null } };
  interior: { unavailable?: string; walls?: Array<{ result: unknown; gaps: unknown[] }> };
};

/** Read-only calculation mode, separate from accepting geometry or approving its inputs. */
export function CandidateCalculationPreview({ projectId, sourceVersionId, page, storeyId }: {
  projectId: string; sourceVersionId: string; page: number; storeyId: string;
}) {
  const t = useT();
  const calculation = useMutation({ mutationFn: () => api<Preview>(`/projects/${projectId}/building-model/calculation-preview`, { sourceVersionId, page, storeyId }) });
  const result = calculation.data;
  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `candidate-preview-page-${page}-r${result.modelRevision}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="grid gap-stack border-t pt-2 text-ui-sm" aria-label={t("buildingCalculationTitle")}>
    <h3 className="building-model-panel-title">{t("buildingCalculationTitle")}</h3>
    <p className="text-muted-foreground">{t("buildingCalculationHint")}</p>
    <Button variant="outline" size="sm" disabled={calculation.isPending} onClick={() => calculation.mutate()}>{t(calculation.isPending ? "buildingCalculationRunning" : "buildingCalculationRun")}</Button>
    {calculation.error && <Callout>{calculation.error.message}</Callout>}
    {result && <>
      <Badge>{t("buildingCalculationUnreviewed")}</Badge>
      <p>{t("buildingCalculationCounts").replace("{used}", String(result.candidates.length)).replace("{excluded}", String(result.excluded.length))}</p>
      <Callout>{t("buildingCalculationLimits")}</Callout>
      <details><summary>{t("buildingCalculationGeometry")}</summary>
      <Table><TableHeader><TableRow><TableHead>{t("buildingVolumeRooms")}</TableHead><TableHead>m²</TableHead><TableHead>{t("buildingConnections")}</TableHead></TableRow></TableHeader>
        <TableBody>{result.geometry.map(room => <TableRow key={room.id}><TableCell>{room.name}</TableCell><TableCell>{room.areaM2?.toFixed(2) ?? "—"}</TableCell><TableCell>{room.adjacentWallIds.length}</TableCell></TableRow>)}</TableBody>
      </Table></details>
      {result.fire.assessment ? <p>{t("buildingCalculationFire").replace("{complete}", String(result.fire.assessment.observations.filter(o => o.outcome === "complete").length))
        .replace("{open}", String(result.fire.assessment.observations.filter(o => o.outcome !== "complete").length))}</p>
        : <Callout>{result.fire.snapshot.reason}</Callout>}
      <p>{t("buildingCalculationSound").replace("{count}", String(result.interior.walls?.filter(w => w.result && !w.gaps.length).length ?? 0))}</p>
      {result.fire.assessment?.concept && <details><summary>{t("buildingCalculationConcept")}</summary><pre className="whitespace-pre-wrap break-words text-ui-xs">{result.fire.assessment.concept}</pre></details>}
      <Button size="sm" variant="outline" onClick={download}>{t("buildingCalculationDownload")}</Button>
      <p className="break-all text-ui-xs text-muted-foreground">r{result.modelRevision} · {result.inputHash.slice(0, 16)}</p>
    </>}
  </section>;
}
