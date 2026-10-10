import type { AgentRunEvaluation } from "@richtfest/shared";
import { useWrite } from "../query";
import { useT } from "../i18n";
import type { RecordData } from "../api";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Button } from "./ui/button";
import { Badge, Callout, Field, Form, Modal } from "./ui/primitives";

const scores = ["correctness", "completeness", "usefulness"] as const;
const reworkValues = ["none", "minor", "major", "unusable"] as const;

export function agentRunReviewPayload(
  form: FormData,
  decision: "approved" | "rejected",
) {
  const evaluation: AgentRunEvaluation = {};
  for (const key of scores) {
    const value = form.get(key);
    if (typeof value === "string" && /^[1-5]$/.test(value))
      evaluation[key] = Number(value);
  }
  const rework = form.get("rework");
  if (reworkValues.includes(rework as (typeof reworkValues)[number]))
    evaluation.rework = rework as (typeof reworkValues)[number];
  return {
    decision,
    note: form.get("note"),
    ...(Object.keys(evaluation).length ? { evaluation } : {}),
  };
}

export function AgentRunReview({
  run,
  onClose,
}: {
  run: RecordData;
  onClose: () => void;
}) {
  const t = useT();
  const approve = useWrite(`/knowledge/runs/${run.id}/approve`, onClose);
  return (
    <Modal title={t("reviewRun")} onClose={onClose}>
      <Form
        label={t("approveRun")}
        pending={approve.isPending}
        error={approve.error}
        onSubmit={(form) =>
          approve.mutate(agentRunReviewPayload(form, "approved"))
        }
      >
        <Callout>{t("approvalBoundary")}</Callout>
        <p>{run.outputSummary}</p>
        <Field label={t("reviewNoteLabel")}>
          <Input name="note" />
        </Field>
        <fieldset className="grid gap-stack" disabled={approve.isPending}>
          <legend className="text-ui font-medium">
            {t("runEvaluationOptional")}
          </legend>
          <p className="text-ui-xs text-muted-foreground">
            {t("runEvaluationRubric")}
          </p>
          {scores.map((key) => (
            <Field key={key} label={t(`runEvaluation_${key}`)}>
              <NativeSelect name={key} defaultValue="">
                <option value="">{t("runEvaluationBlank")}</option>
                {[1, 2, 3, 4, 5].map((score) => (
                  <option key={score} value={score}>
                    {score}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ))}
          <Field label={t("runEvaluation_rework")}>
            <NativeSelect name="rework" defaultValue="">
              <option value="">{t("runEvaluationBlank")}</option>
              {reworkValues.map((value) => (
                <option key={value} value={value}>
                  {t(`runEvaluationRework_${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </fieldset>
        <Button
          type="button"
          variant="ghost"
          disabled={approve.isPending}
          onClick={(event) => {
            const form = event.currentTarget.closest("form");
            if (form)
              approve.mutate(
                agentRunReviewPayload(new FormData(form), "rejected"),
              );
          }}
        >
          {t("rejectRun")}
        </Button>
      </Form>
    </Modal>
  );
}

export function AgentRunReviews({ approvals }: { approvals: RecordData[] }) {
  const t = useT();
  if (!approvals.length) return null;
  return (
    <details className="agent-thread-details">
      <summary>
        {t("runEvaluationSaved")} · {approvals.length}
      </summary>
      <div className="grid gap-stack text-ui-sm">
        {approvals.map((approval) => (
          <section key={approval.id} className="grid gap-1">
            <Badge>
              {t(
                approval.decision === "approved"
                  ? "run_approved"
                  : "runReviewRejected",
              )}
            </Badge>
            {approval.note && (
              <p className="whitespace-pre-wrap">{approval.note}</p>
            )}
            {approval.evaluation && (
              <div className="flex flex-wrap gap-2">
                {scores.map(
                  (key) =>
                    approval.evaluation[key] != null && (
                      <span key={key}>
                        {t(`runEvaluation_${key}`)}: {approval.evaluation[key]}
                        /5
                      </span>
                    ),
                )}
                {reworkValues.includes(approval.evaluation.rework) && (
                  <span>
                    {t("runEvaluation_rework")}:{" "}
                    {t(
                      `runEvaluationRework_${approval.evaluation.rework}` as Parameters<
                        typeof t
                      >[0],
                    )}
                  </span>
                )}
              </div>
            )}
            {approval.evaluatedOutput && (
              <details>
                <summary>{t("runEvaluationOutput")}</summary>
                <p className="whitespace-pre-wrap">
                  {approval.evaluatedOutput.summary}
                </p>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {approval.evaluatedOutput.rationale}
                </p>
                {approval.evaluatedOutput.artifactRevisionIds?.length > 0 && (
                  <p className="text-ui-xs">
                    {t("runEvaluationRevisions")}:{" "}
                    {approval.evaluatedOutput.artifactRevisionIds.join(" · ")}
                  </p>
                )}
              </details>
            )}
          </section>
        ))}
      </div>
    </details>
  );
}
