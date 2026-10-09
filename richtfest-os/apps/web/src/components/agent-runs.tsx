import { useState } from "react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";
import { useApi, useWrite } from "../query";
import { list, type RecordData } from "../api";
import { useT } from "../i18n";
import { AgentEffortControl } from "./agent-effort-control";
import { Section } from "./layout";
import { Input, Textarea } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Button } from "./ui/button";
import { Badge, Callout, Empty, Field, Form, Modal } from "./ui/primitives";
import "./agent-runs.css";

export function AgentRuns({
  projectId,
  initialRuns,
}: {
  projectId: string;
  initialRuns?: RecordData[];
}) {
  const t = useT();
  const [effort, setEffort] = useState("medium");
  const [open, setOpen] = useState(false);
  const [fileId, setFileId] = useState("");
  const [sources, setSources] = useState<{ id: string; label: string }[]>([]);
  const readiness = useApi("/agent/readiness");
  const supervisor = readiness.data?.supervisor;
  const runs = useApi(`/knowledge/runs?projectId=${projectId}`, !initialRuns);
  const files = useApi(`/projects/${projectId}/files`, open);
  const versions = useApi(
    `/projects/${projectId}/files/${fileId}/versions`,
    open && !!fileId,
  );
  const create = useWrite("/knowledge/runs", () => {
    setOpen(false);
    setSources([]);
  });
  return (
    <Section
      title={t("agentRuns")}
      meta={
        <Button
          variant="outline"
          disabled={!readiness.data?.executionAvailable}
          onClick={() => setOpen(true)}
        >
          ＋ {t("assignAgentGoal")}
        </Button>
      }
    >
      {readiness.data && !readiness.data.executionAvailable && (
        <Callout>
          {t("agentToolsUnavailable")}{" "}
          <Button asChild variant="link">
            <Link to="/settings">{t("aiConnections")}</Link>
          </Button>
        </Callout>
      )}
      {readiness.error && (
        <Callout tone="error">{readiness.error.message}</Callout>
      )}
      {runs.error && <Callout tone="error">{runs.error.message}</Callout>}
      <div className="agent-run-list">
        {list(initialRuns || runs.data, "items")
          .filter((run) => !run.parentRunId)
          .map((run) => (
            <RunGroup
              key={run.id}
              run={run}
              projectId={projectId}
              childrenRuns={list(initialRuns || runs.data, "items").filter(
                (child) => child.parentRunId === run.id,
              )}
            />
          ))}
      </div>
      {(initialRuns || runs.data) &&
        !list(initialRuns || runs.data, "items").length && (
          <Empty>{t("noAgentRuns")}</Empty>
        )}
      {open && (
        <Modal title={t("assignAgentGoal")} onClose={() => setOpen(false)}>
          <Form
            label={t("assignAgentGoal")}
            pending={create.isPending}
            error={create.error}
            onSubmit={(form) =>
              create.mutate({
                projectId,
                effort,
                goal: form.get("goal"),
                sourceVersionIds: sources.map((s) => s.id),
              })
            }
          >
            <Callout>{t("agentGoalHint")}</Callout>
            <Field label={t("assignedGoal")}>
              <Textarea name="goal" required autoFocus />
            </Field>
            <AgentEffortControl
              enabled={supervisor?.enabled}
              presets={supervisor?.presets}
              value={effort}
              onChange={setEffort}
            />
            <Field label={t("source")}>
              <NativeSelect
                value={fileId}
                onChange={(e) => setFileId(e.target.value)}
              >
                <option value="">{t("chooseSource")}</option>
                {list(files.data, "files").map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {fileId && (
              <Field label={t("version")}>
                <NativeSelect
                  value=""
                  onChange={(e) => {
                    const version = list(versions.data).find(
                      (v) => v.id === e.target.value,
                    );
                    const file = list(files.data, "files").find(
                      (f) => f.id === fileId,
                    );
                    if (version && !sources.some((s) => s.id === version.id))
                      setSources([
                        ...sources,
                        {
                          id: version.id,
                          label: `${file?.name} · ${version.version}`,
                        },
                      ]);
                  }}
                >
                  <option value="">{t("addSourceVersion")}</option>
                  {list(versions.data).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.version}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {sources.map((source) => (
              <div key={source.id} className="task-row">
                <span>{source.label}</span>
                <Button
                  type="button"
                  variant="link"
                  onClick={() =>
                    setSources(sources.filter((s) => s.id !== source.id))
                  }
                >
                  {t("removeSource")}
                </Button>
              </div>
            ))}
          </Form>
        </Modal>
      )}
    </Section>
  );
}
function runHref(projectId: string, run: RecordData) {
  const params = new URLSearchParams();
  if (run.conversationId) params.set("conversation", run.conversationId);
  params.set("agentRun", run.id);
  return `/projects/${projectId}?${params}`;
}

function statusLabel(run: RecordData, t: ReturnType<typeof useT>) {
  const statusKey = `run_${run.status}` as Parameters<
    ReturnType<typeof useT>
  >[0];
  return t(statusKey) || run.status;
}

function specialistLabel(run: RecordData, t: ReturnType<typeof useT>) {
  return run.specialistRole
    ? run.specialistRole === "source_reviewer"
      ? t("agentThreadSourceName")
      : run.specialistRole === "requirements_reviewer"
        ? t("agentThreadRequirementsName")
        : t(`specialist_${run.specialistRole}` as never) || run.specialistRole
    : t("agent");
}

function RunGroup({
  run,
  projectId,
  childrenRuns,
}: {
  run: RecordData;
  projectId: string;
  childrenRuns: RecordData[];
}) {
  const t = useT();
  const activeChildren = childrenRuns.filter(
    (child) => child.status !== "cancelled",
  );
  const previousChildren = childrenRuns.filter(
    (child) => child.status === "cancelled",
  );
  return (
    <details className="agent-run-group">
      <summary className="agent-run-row">
        <span className="agent-run-main">
          <span className="agent-run-copy">
            <strong>{run.goal}</strong>
            <span>{specialistLabel(run, t)}</span>
          </span>
          <Badge tone={run.status === "approved" ? "success" : "neutral"}>
            {statusLabel(run, t)}
          </Badge>
        </span>
        <ChevronDown
          className="agent-run-disclosure size-icon-sm"
          aria-hidden="true"
        />
      </summary>
      <RunDetails run={run} projectId={projectId} />
      {activeChildren.length > 0 && (
        <div
          className="agent-run-children"
          aria-label={t("supervisorSpecialists")}
        >
          {activeChildren.map((child) => (
            <Link
              className="agent-run-child"
              key={child.id}
              to={runHref(projectId, child)}
            >
              <span className="agent-run-child-copy">
                <strong>{specialistLabel(child, t)}</strong>
                <span>{statusLabel(child, t)}</span>
              </span>
              <ArrowUpRight className="size-icon-sm" aria-hidden="true" />
            </Link>
          ))}
        </div>
      )}
      {previousChildren.length > 0 && (
        <details className="agent-run-history">
          <summary>
            {t("agentThreadPrevious")} · {previousChildren.length}
          </summary>
          <div className="agent-run-children">
            {previousChildren.map((child) => (
              <Link
                className="agent-run-child"
                key={child.id}
                to={runHref(projectId, child)}
              >
                <span className="agent-run-child-copy">
                  <strong>{specialistLabel(child, t)}</strong>
                  <span>{statusLabel(child, t)}</span>
                </span>
                <ArrowUpRight className="size-icon-sm" aria-hidden="true" />
              </Link>
            ))}
          </div>
        </details>
      )}
    </details>
  );
}

function RunDetails({
  run,
  projectId,
}: {
  run: RecordData;
  projectId: string;
}) {
  const t = useT();
  const [review, setReview] = useState(false);
  const approve = useWrite(`/knowledge/runs/${run.id}/approve`, () =>
    setReview(false),
  );
  const cancel = useWrite(`/knowledge/runs/${run.id}/cancel`);
  const retry = useWrite(`/knowledge/runs/${run.id}/retry`);
  return (
    <div className="agent-run-details">
      {run.outputSummary && (
        <p className="agent-run-result">{run.outputSummary}</p>
      )}
      {run.rationale && <p className="muted">{run.rationale}</p>}
      {(run.error || run.failureReason) && (
        <Callout>{run.error || run.failureReason}</Callout>
      )}
      {(run.sourceVersions || run.sourceVersionIds || []).length > 0 && (
        <div className="agent-run-sources">
          <span className="muted">{t("sourceVersions")}</span>
          {(run.sourceVersions || run.sourceVersionIds || []).map(
            (source: any) => (
              <Badge key={typeof source === "string" ? source : source.id}>
                {typeof source === "string"
                  ? source
                  : `${source.name || source.fileName} · ${source.version}`}
              </Badge>
            ),
          )}
        </div>
      )}
      {run.approvedBy && (
        <p className="muted">
          {t("approvalProvenance")} · {run.approvedByName || run.approvedBy}
          {run.approvalNote ? ` · ${run.approvalNote}` : ""}
        </p>
      )}
      <div className="agent-run-detail-actions">
        <Button asChild variant="link" size="sm">
          <Link to={runHref(projectId, run)}>{t("sharedWorkOpenThread")}</Link>
        </Button>
        {!run.parentRunId && run.status === "needs_review" && (
          <Button variant="outline" size="sm" onClick={() => setReview(true)}>
            {t("reviewRun")}
          </Button>
        )}
        {!run.parentRunId &&
          [
            "queued",
            "unconfigured",
            "running",
            "needs_attention",
            "needs_review",
          ].includes(run.status) && (
            <Button
              variant="link"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({})}
            >
              {t("workspaceStop")}
            </Button>
          )}
        {!run.parentRunId &&
          [
            "unconfigured",
            "failed",
            "cancelled",
            "validated_tool_unavailable",
          ].includes(run.status) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={retry.isPending}
              onClick={() => retry.mutate({})}
            >
              {t("workspaceRetryRun")}
            </Button>
          )}
      </div>
      {retry.error && <Callout tone="error">{retry.error.message}</Callout>}
      {cancel.error && <Callout tone="error">{cancel.error.message}</Callout>}
      {review && !run.parentRunId && (
        <Modal title={t("reviewRun")} onClose={() => setReview(false)}>
          <Form
            label={t("approveRun")}
            pending={approve.isPending}
            error={approve.error}
            onSubmit={(form) =>
              approve.mutate({ decision: "approved", note: form.get("note") })
            }
          >
            <Callout>{t("approvalBoundary")}</Callout>
            <p>{run.outputSummary}</p>
            <Field label={t("reviewNoteLabel")}>
              <Input name="note" />
            </Field>
            <Button
              type="button"
              variant="link"
              disabled={approve.isPending}
              onClick={() => approve.mutate({ decision: "rejected" })}
            >
              {t("rejectRun")}
            </Button>
          </Form>
        </Modal>
      )}
    </div>
  );
}
