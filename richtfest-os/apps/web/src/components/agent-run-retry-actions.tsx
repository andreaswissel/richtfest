import type { RecordData } from "../api";
import { useNavigate } from "react-router-dom";
import { useT } from "../i18n";
import { useWrite } from "../query";
import { Button } from "./ui/button";
import { Callout } from "./ui/primitives";

export function AgentRunRetryActions({ run }: { run: RecordData }) {
  const t = useT();
  const navigate = useNavigate();
  const showRun = (created: RecordData) => {
    if (created.id === run.id) return;
    const params = new URLSearchParams({ agentRun: created.id });
    if (created.conversationId)
      params.set("conversation", created.conversationId);
    navigate(`/projects/${created.projectId}?${params}`);
  };
  const retry = useWrite(`/knowledge/runs/${run.id}/retry`, showRun);
  const rerun = useWrite(`/knowledge/runs/${run.id}/rerun`, showRun);
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
          disabled={retry.isPending || rerun.isPending}
          onClick={() => retry.mutate({})}
        >
          {t("workspaceRetryRun")}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={rerun.isPending || retry.isPending}
        onClick={() => rerun.mutate({})}
      >
        {t("workspaceRunAgain")}
      </Button>
      {retry.error && <Callout tone="error">{retry.error.message}</Callout>}
      {rerun.error && <Callout tone="error">{rerun.error.message}</Callout>}
    </div>
  );
}
