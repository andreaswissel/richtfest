import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  AgentWorkflowRequest,
  AgentModeRecommendation,
} from "@richtfest/shared";
import { api } from "../api";
import { useT } from "../i18n";
import { Button } from "./ui/button";
import { Callout, Field, Segmented } from "./ui/primitives";

// Suggest is a composer choice, not an executable or persisted run workflow.
export type WorkflowSelection = AgentWorkflowRequest | { mode: "suggest" };

export function workflowReady(
  workflow: WorkflowSelection,
  _sources: string[],
  enabled: boolean,
) {
  return workflow.mode === "suggest" || workflow.mode === "chat" || enabled;
}

type WorkflowContext = {
  projectId: string;
  conversationId?: string;
  goal: string;
  sourceVersionIds: string[];
  value: WorkflowSelection;
  supervisorEnabled: boolean;
  steering?: boolean;
  active?: boolean;
};

/** One preflight per submission; editing or unmounting invalidates late results. */
export function useWorkflowDecision(props: WorkflowContext) {
  const key = JSON.stringify([
    props.projectId,
    props.conversationId,
    props.goal,
    props.sourceVersionIds,
    props.value,
    props.steering,
    props.supervisorEnabled,
    props.active,
  ]);
  const currentContext = useRef({ key });
  if (currentContext.current.key !== key) currentContext.current = { key };
  const context = currentContext.current;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pending = useRef(false);
  const suggest = useMutation({
    mutationFn: () =>
      api<AgentModeRecommendation>("/knowledge/mode-recommendation", {
        projectId: props.projectId,
        conversationId: props.conversationId,
        goal: props.goal,
        sourceVersionIds: props.sourceVersionIds,
      }),
  });
  const requestContext = useRef<{ key: string } | undefined>(undefined);
  const result = requestContext.current === context ? suggest.data : undefined;
  const error = requestContext.current === context ? suggest.error : null;
  const request = async () => {
    if (pending.current) return;
    pending.current = true;
    requestContext.current = context;
    try {
      const response = await suggest.mutateAsync();
      return mounted.current && currentContext.current === context
        ? response
        : undefined;
    } catch {
      return mounted.current && currentContext.current === context
        ? null
        : undefined;
    } finally {
      pending.current = false;
    }
  };
  return {
    result,
    error,
    request,
    isPending: suggest.isPending,
    resolve: async (): Promise<AgentWorkflowRequest | undefined> => {
      if (props.active === false) return;
      if (props.steering) return { mode: "chat" }; // Existing run retains its own workflow.
      if (props.value.mode !== "suggest") return props.value;
      const response = result ?? (await request());
      if (response === undefined) return;
      if (
        response?.outcome === "classified" &&
        ["team", "report"].includes(response.recommendation ?? "") &&
        props.supervisorEnabled
      )
        return; // Apply + Send explicitly authorizes escalation.
      return { mode: "chat" };
    },
  };
}

export function AgentWorkflowControl({
  goal,
  sourceVersionIds,
  value,
  onChange,
  supervisorEnabled,
  steering,
  decision,
}: WorkflowContext & {
  onChange: (value: WorkflowSelection) => void;
  decision: ReturnType<typeof useWorkflowDecision>;
}) {
  const t = useT();
  const recommendation =
    decision.result?.outcome === "classified"
      ? decision.result.recommendation
      : null;
  const actionable =
    recommendation === "chat" ||
    ((recommendation === "team" || recommendation === "report") &&
      supervisorEnabled);
  return (
    <div className="flex flex-wrap items-end gap-stack">
      {!steering && (
        <Field label={t("agentWorkflowMode")}>
          <Segmented
            items={[
              { value: "suggest", label: t("agentModeSuggest") },
              { value: "chat", label: t("agentModeChat") },
              {
                value: "team",
                label: t("agentModeTeam"),
                disabled: !supervisorEnabled,
              },
              {
                value: "report",
                label: t("agentModeReport"),
                disabled: !supervisorEnabled,
              },
            ]}
            value={value.mode}
            onChange={(mode) =>
              onChange(
                mode === "report"
                  ? { mode: "report" }
                  : { mode: mode as "suggest" | "chat" | "team" },
              )
            }
          />
        </Field>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={steering || !goal.trim() || decision.isPending}
        onClick={() => void decision.request()}
      >
        {t(decision.isPending ? "agentCheckingMode" : "agentSuggestMode")}
      </Button>
      {steering ? (
        <Callout>{t("agentSteeringMode")}</Callout>
      ) : (
        <>
          {value.mode === "suggest" && (
            <span className="text-ui-xs text-muted-foreground">
              {t("agentSuggestDefaultHint")}
            </span>
          )}
          {["team", "report"].includes(value.mode) && !supervisorEnabled && (
            <Callout>{t("agentTeamUnavailable")}</Callout>
          )}
          {value.mode === "report" && !sourceVersionIds.length && (
            <Callout>{t("agentReportAutomaticEvidence")}</Callout>
          )}
          {(decision.error || (decision.result && !actionable)) && (
            <Callout>{t("agentSuggestionUnavailable")}</Callout>
          )}
          {actionable && (
            <Callout>
              {t("agentSuggestedMode")} ·{" "}
              {t(
                recommendation === "chat"
                  ? "agentModeChat"
                  : recommendation === "team"
                    ? "agentModeTeam"
                    : "agentModeReport",
              )}{" "}
              <Button
                type="button"
                variant="link"
                onClick={() =>
                  onChange(
                    recommendation === "report"
                      ? { mode: "report" }
                      : { mode: recommendation as "chat" | "team" },
                  )
                }
              >
                {t("agentApplyMode")}
              </Button>
            </Callout>
          )}
        </>
      )}
    </div>
  );
}
