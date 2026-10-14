import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type RecordData } from "../api";
import { useNavigate } from "react-router-dom";
import { useT } from "../i18n";
import { useWrite } from "../query";
import { Button } from "./ui/button";
import { Callout, Field, Modal } from "./ui/primitives";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";

type Recovery = {
  resumable: boolean;
  generation: number;
  checkpointHash: string;
  phase: string;
  completedSpecialists: number;
  totalSpecialists: number;
  sections: { key: string; savedPieces: number; savedFallbackPieces: number }[];
  savedPieces: number;
  editorialCandidate?: boolean;
  preservationChecked?: boolean;
  accounting: {
    recordedCostUsd: number;
    unknownOutcomes: number;
    unpricedAttempts: number;
    unpricedUsage: unknown;
  };
  budget: { maxCostUsd: number; maxAutomaticRetries: number };
};

export function AgentRunRetryActions({ run }: { run: RecordData }) {
  return <RetryActions key={run.id} run={run} />;
}

function RetryActions({ run }: { run: RecordData }) {
  const t = useT();
  const phaseLabel = (phase: string) => {
    const key = {
      plan: "agentRunPhasePlan",
      specialists: "agentRunPhaseSpecialists",
      review: "agentRunPhaseReview",
      independent_review: "agentRunPhaseIndependentReview",
      done: "agentRunPhaseDone",
      provider: "workspaceRunPhaseProvider",
      editorial: "workspaceWorkEditingDocument",
    }[phase] as Parameters<typeof t>[0] | undefined;
    return key ? t(key) : t("runRecoveryUnknownStage");
  };
  const sectionLabel = (section: string) => {
    const key = {
      preliminaryRemarks: "runRecoverySectionPreliminaryRemarks",
      exteriorNoiseAssessment: "runRecoverySectionExteriorNoiseAssessment",
      planningLaw: "runRecoverySectionPlanningLaw",
      components: "runRecoverySectionComponents",
      plans: "runRecoverySectionPlans",
      sourcesAndRevisions: "runRecoverySectionSourcesAndRevisions",
      openIssues: "runRecoverySectionOpenIssues",
      calculationAppendix: "runRecoverySectionCalculationAppendix",
      requirements: "runRecoverySectionRequirements",
      verification: "runRecoverySectionVerification",
      buildingServices: "runRecoverySectionBuildingServices",
      heatPumps: "runRecoverySectionHeatPumps",
      protectionLevels: "runRecoverySectionProtectionLevels",
    }[section] as Parameters<typeof t>[0] | undefined;
    return key ? t(key) : t("runRecoveryUnknownSection");
  };
  const navigate = useNavigate();
  const [mode, setMode] = useState<"retry" | "rerun" | null>(null);
  const [preview, setPreview] = useState<Recovery | null>(null);
  const [cost, setCost] = useState("10");
  const [retries, setRetries] = useState("3");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const locked = useRef(false);
  const loading = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  const recovery = useMutation({
    mutationFn: () => api<Recovery>(`/knowledge/runs/${run.id}/recovery`),
    retry: false,
  });
  const showRun = (created: RecordData) => {
    if (!alive.current || created.id === run.id) return;
    const params = new URLSearchParams({ agentRun: created.id });
    if (created.conversationId)
      params.set("conversation", created.conversationId);
    navigate(`/projects/${created.projectId}?${params}`);
  };
  const retry = useWrite(`/knowledge/runs/${run.id}/retry`, showRun);
  const rerun = useWrite(`/knowledge/runs/${run.id}/rerun`, showRun);
  const pending = retry.isPending || rerun.isPending;
  const close = () => {
    if (locked.current) return;
    epoch.current++;
    loading.current = false;
    setMode(null);
    setPreview(null);
    setError(null);
  };
  const load = async () => {
    if (locked.current || loading.current) return;
    loading.current = true;
    const token = ++epoch.current;
    setPreview(null);
    setError(null);
    setAck(false);
    try {
      const data = await recovery.mutateAsync();
      if (token !== epoch.current) return;
      setPreview(data);
      setCost(String(data.budget?.maxCostUsd ?? 10));
      setRetries(String(data.budget?.maxAutomaticRetries ?? 3));
    } catch (failure) {
      if (token === epoch.current) setError((failure as Error).message);
    } finally {
      if (token === epoch.current) loading.current = false;
    }
  };
  const needsAck =
    !!preview?.resumable &&
    (preview.accounting.unknownOutcomes > 0 ||
      preview.accounting.unpricedAttempts > 0);
  const valid =
    cost.trim() !== "" &&
    Number(cost) >= 0.01 &&
    Number(cost) <= 1000 &&
    retries.trim() !== "" &&
    Number.isInteger(Number(retries)) &&
    Number(retries) >= 0 &&
    Number(retries) <= 10;
  const confirm = async () => {
    if (
      locked.current ||
      error ||
      !mode ||
      (mode === "retry" &&
        (!preview || (preview.resumable && (!valid || (needsAck && !ack)))))
    )
      return;
    locked.current = true;
    try {
      if (mode === "rerun") await rerun.mutateAsync({});
      else
        await retry.mutateAsync(
          preview!.resumable
            ? {
                generation: preview!.generation,
                checkpointHash: preview!.checkpointHash,
                budget: {
                  maxCostUsd: Number(cost),
                  maxAutomaticRetries: Number(retries),
                },
                acknowledgeUnknownOutcomes: ack,
              }
            : {},
        );
      locked.current = false;
      close();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      locked.current = false;
    }
  };
  const retryable = [
    "unconfigured",
    "failed",
    "cancelled",
    "validated_tool_unavailable",
  ].includes(run.status);
  if (
    run.parentRunId ||
    (!retryable && !["needs_review", "approved"].includes(run.status))
  )
    return null;
  return (
    <div className="flex flex-wrap items-center gap-stack">
      {retryable && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending || !!mode}
          onClick={() => {
            setMode("retry");
            void load();
          }}
        >
          {t("workspaceRetryRun")}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending || !!mode}
        onClick={() => {
          setError(null);
          setMode("rerun");
        }}
      >
        {t("workspaceRunAgain")}
      </Button>
      {mode && (
        <Modal
          title={t(
            mode === "retry" ? "workspaceRetryRun" : "workspaceRunAgain",
          )}
          onClose={close}
        >
          <div className="grid max-h-[calc(90dvh-8rem)] min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-stack text-ui-sm">
            <div className="grid min-h-0 gap-stack overflow-y-auto">
              {mode === "rerun" ? (
                <Callout>{t("runRecoveryFresh")}</Callout>
              ) : (
                <>
                  {recovery.isPending && <p>{t("loading")}</p>}
                  {preview &&
                    (preview.resumable ? (
                      <>
                        <p>
                          {t("runRecoveryRetained")}:{" "}
                          {preview.completedSpecialists}/
                          {preview.totalSpecialists} · {preview.savedPieces}{" "}
                          {t("runRecoveryPieces")}
                        </p>
                        <p>
                          {t("runRecoveryStage")}: {phaseLabel(preview.phase)}
                        </p>
                        <ul>
                          {preview.sections.map((section) => (
                            <li key={section.key}>
                              {sectionLabel(section.key)}: {section.savedPieces}{" "}
                              {t("runRecoveryPieces")} (
                              {section.savedFallbackPieces}{" "}
                              {t("runRecoveryFallback")})
                            </li>
                          ))}
                        </ul>
                        {preview.editorialCandidate && (
                          <p>
                            {t(
                              preview.preservationChecked
                                ? "runRecoveryEditorialChecked"
                                : "runRecoveryEditorialUnchecked",
                            )}
                          </p>
                        )}
                        <p>{t("runRecoveryReuse")}</p>
                        <p>
                          {t("runRecoveryCost")}: $
                          {preview.accounting.recordedCostUsd.toFixed(2)} USD
                        </p>
                        <Callout>{t("runRecoveryIncomplete")}</Callout>
                        <Callout>{t("runRecoveryAllowance")}</Callout>
                        <Field label={t("runRecoveryMaxCost")}>
                          <Input
                            type="number"
                            min="0.01"
                            max="1000"
                            step="0.01"
                            value={cost}
                            disabled={pending}
                            onChange={(e) => setCost(e.target.value)}
                          />
                        </Field>
                        <Field label={t("runRecoveryMaxRetries")}>
                          <Input
                            type="number"
                            min="0"
                            max="10"
                            step="1"
                            value={retries}
                            disabled={pending}
                            onChange={(e) => setRetries(e.target.value)}
                          />
                        </Field>
                        {needsAck && (
                          <label className="flex items-start gap-stack">
                            <Checkbox
                              checked={ack}
                              disabled={pending}
                              onCheckedChange={(value) =>
                                setAck(value === true)
                              }
                            />
                            {t("runRecoveryAcknowledge")}
                          </label>
                        )}
                      </>
                    ) : (
                      <Callout>{t("runRecoveryLegacy")}</Callout>
                    ))}
                </>
              )}
            </div>
            <div className="grid gap-stack">
              {error && <Callout tone="error">{error}</Callout>}
              <div className="flex justify-end gap-stack">
                {mode === "retry" && (
                  <Button
                    variant="outline"
                    disabled={pending || recovery.isPending}
                    onClick={() => void load()}
                  >
                    {t("runRecoveryReload")}
                  </Button>
                )}
                <Button
                  disabled={
                    pending ||
                    !!error ||
                    (mode === "retry" &&
                      (!preview ||
                        recovery.isPending ||
                        (preview.resumable && (!valid || (needsAck && !ack)))))
                  }
                  onClick={() => void confirm()}
                >
                  {t(
                    mode === "retry"
                      ? "workspaceRetryRun"
                      : "workspaceRunAgain",
                  )}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
