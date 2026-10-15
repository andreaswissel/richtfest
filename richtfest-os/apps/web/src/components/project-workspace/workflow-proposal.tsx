import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  AgentWorkflowRequest,
  WorkflowProposal as Proposal,
} from "@richtfest/shared";
import { api } from "../../api";
import { queryClient } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Callout, Field } from "../ui/primitives";
import { ArrowRight, Check, FileText, Calculator } from "lucide-react";

export function WorkflowProposal({
  proposalId,
  projectId,
  conversationId,
  writable,
}: {
  proposalId: string;
  projectId: string;
  conversationId?: string;
  writable: boolean;
}) {
  const t = useT();
  const base = `/knowledge/conversations/${conversationId}/workflow-proposals`;
  const [loadOlder, setLoadOlder] = useState(false);
  const query = useQuery({
    queryKey: [base],
    queryFn: () => api<Proposal[]>(base),
    enabled: !!conversationId,
  });
  const older = useQuery({
    queryKey: [base, proposalId],
    queryFn: () => api<Proposal>(`${base}/${proposalId}`),
    enabled: !!conversationId && loadOlder,
  });
  const data = older.data ?? query.data?.find((p) => p.id === proposalId);
  if (query.error || older.error)
    return <Callout>{t("workflowProposalUnavailable")}</Callout>;
  if (!data)
    return query.isPending ? (
      <p className="text-ui-sm text-muted-foreground">{t("loading")}</p>
    ) : (
      <Button variant="secondary" onClick={() => setLoadOlder(true)}>
        {t("workflowProposalOpen")}
      </Button>
    );
  return (
    <ProposalCard
      key={proposalId}
      data={data}
      base={base}
      projectId={projectId}
      writable={writable}
    />
  );
}

function ProposalCard({
  data,
  base,
  projectId,
  writable,
}: {
  data: Proposal;
  base: string;
  projectId: string;
  writable: boolean;
}) {
  const t = useT();
  const [selection, setSelection] = useState<AgentWorkflowRequest | null>(null);
  const [budget, setBudget] = useState(String(data.budget.maxCostUsd));
  const [adjust, setAdjust] = useState(false);
  const workflow = selection ?? data.workflow;
  const write = useMutation({
    mutationFn: (action: "confirm" | "cancel") =>
      api<Proposal>(
        `${base}/${data.id}`,
        action === "cancel"
          ? { action }
          : {
              action,
              workflow,
              budget: { ...data.budget, maxCostUsd: Number(budget) },
            },
      ),
    onSuccess: (result) => {
      queryClient.setQueryData<Proposal[]>([base], (old) =>
        old?.map((p) => (p.id === result.id ? result : p)),
      );
      queryClient.setQueryData([base, data.id], result);
      void queryClient.invalidateQueries({ queryKey: [base] });
      void queryClient.invalidateQueries({
        queryKey: [`/knowledge/workspaces/${projectId}`],
      });
      void queryClient.invalidateQueries({
        queryKey: [
          `/knowledge/conversations/${data.conversationId}`,
          "messages",
        ],
      });
    },
  });
  const current = write.data ?? data;
  if (current.status !== "pending")
    return (
      <div className="flex flex-wrap items-center gap-2 text-ui-sm text-muted-foreground">
        <Check className="size-icon-sm" aria-hidden="true" />
        {t(
          current.status === "cancelled"
            ? "workflowProposalCancelled"
            : "workflowProposalStarted",
        )}
        {current.runId && (
          <Link
            className="underline underline-offset-2"
            to={`/projects/${projectId}?conversation=${data.conversationId}&agentRun=${current.runId}&panel=agents`}
          >
            {t("workflowProposalViewRun")}
          </Link>
        )}
      </div>
    );
  const mode = workflow?.mode;
  const title =
    mode === "calculation"
      ? "workflowProposalCalculationTitle"
      : mode === "report"
        ? "workflowProposalReportTitle"
        : mode === "team"
          ? "workflowProposalTeamTitle"
          : mode === "chat"
            ? "workflowProposalChatTitle"
            : "workflowProposalChoose";
  const description =
    mode === "calculation"
      ? "workflowProposalCalculationDescription"
      : mode === "report"
        ? "workflowProposalReportDescription"
        : mode === "team"
          ? "workflowProposalTeamDescription"
          : mode === "chat"
            ? "workflowProposalChatDescription"
            : "workflowProposalUncertain";
  const start =
    mode === "calculation"
      ? "workflowProposalStartCalculation"
      : mode === "report"
        ? "workflowProposalStartReport"
        : mode === "team"
          ? "workflowProposalStartTeam"
          : "workflowProposalStartChat";
  const allowed = mode === "chat" || data.supervisorEnabled;
  return (
    <form
      className="space-y-4 rounded-3xl bg-muted/50 p-5 text-ui"
      aria-label={t("workflowProposalLabel")}
      onSubmit={(e) => {
        e.preventDefault();
        if (writable && workflow && allowed && !write.isPending)
          write.mutate("confirm");
      }}
    >
      <div className="flex items-center gap-2 font-medium">
        {mode === "calculation" ? (
          <Calculator className="size-icon" aria-hidden="true" />
        ) : (
          <FileText className="size-icon" aria-hidden="true" />
        )}
        <span>{t(title)}</span>
      </div>
      <p className="text-ui-sm text-muted-foreground">{t(description)}</p>
      <p className="text-ui-xs text-muted-foreground">
        {t("workflowProposalSources").replace(
          "{count}",
          String(data.sourceVersionIds.length),
        )}
      </p>
      {(adjust || !mode) && (
        <div
          className="flex flex-wrap gap-2"
          aria-label={t("workflowProposalChoose")}
        >
          {(["calculation", "report", "team", "chat"] as const).map((next) => (
            <Button
              type="button"
              variant="secondary"
              className="rounded-full"
              key={next}
              disabled={write.isPending}
              aria-pressed={mode === next}
              onClick={() =>
                setSelection(
                  next === "report"
                    ? {
                        mode: next,
                        reportTemplate:
                          mode === "calculation"
                            ? "exterior-noise-concept"
                            : undefined,
                      }
                    : { mode: next },
                )
              }
            >
              {t(
                next === "calculation"
                  ? "agentModeCalculation"
                  : next === "report"
                    ? "workflowProposalFullConcept"
                    : next === "team"
                      ? "agentModeTeam"
                      : "agentModeChat",
              )}
            </Button>
          ))}
        </div>
      )}
      {workflow?.mode === "report" && (
        <Field label={t("agentReportFormat")}>
          <NativeSelect
            required
            value={workflow.reportTemplate ?? ""}
            disabled={write.isPending}
            onChange={(e) =>
              setSelection({
                mode: "report",
                reportTemplate: e.target.value as Extract<
                  AgentWorkflowRequest,
                  { mode: "report" }
                >["reportTemplate"],
              })
            }
          >
            <option value="" disabled>
              {t("workflowProposalChooseFormat")}
            </option>
            <option value="exterior-noise-concept">
              {t("agentReportFormatExterior")}
            </option>
            <option value="interior-noise-concept">
              {t("agentReportFormatInterior")}
            </option>
            <option value="sound-insulation-review">
              {t("agentReportFormatReview")}
            </option>
          </NativeSelect>
        </Field>
      )}
      {mode && mode !== "chat" && (
        <div className="space-y-2">
          <Field label={t("workflowProposalBudget")}>
            <Input
              type="number"
              min="0.01"
              max="1000"
              step="0.01"
              required
              className="max-w-40 rounded-xl border-transparent bg-muted"
              value={budget}
              disabled={write.isPending}
              onChange={(e) => setBudget(e.target.value)}
            />
          </Field>
          <p className="text-ui-xs text-muted-foreground">
            {t("workflowProposalCostHint")}
          </p>
        </div>
      )}
      {!allowed && mode && <Callout>{t("agentTeamUnavailable")}</Callout>}
      {write.error && <Callout tone="error">{write.error.message}</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        {mode && (
          <Button
            type="submit"
            className="rounded-full bg-foreground text-background hover:bg-foreground/90"
            disabled={
              !writable ||
              !allowed ||
              write.isPending ||
              (workflow?.mode === "report" && !workflow.reportTemplate)
            }
          >
            {t(write.isPending ? "saving" : start)}
            <ArrowRight className="size-icon-sm" aria-hidden="true" />
          </Button>
        )}
        {mode && !adjust && (
          <Button
            type="button"
            variant="ghost"
            className="rounded-full"
            disabled={write.isPending}
            onClick={() => setAdjust(true)}
          >
            {t("workflowProposalChange")}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          className="rounded-full"
          disabled={!writable || write.isPending}
          onClick={() => write.mutate("cancel")}
        >
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
