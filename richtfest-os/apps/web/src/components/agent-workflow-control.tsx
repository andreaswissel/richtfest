import { useMutation } from "@tanstack/react-query";
import type { AgentWorkflow, AgentModeRecommendation } from "@richtfest/shared";
import { api } from "../api";
import { useT } from "../i18n";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { Callout, Field, Segmented } from "./ui/primitives";

export function workflowReady(
  workflow: AgentWorkflow,
  sources: string[],
  enabled: boolean,
) {
  return (
    workflow.mode === "chat" ||
    (enabled && (workflow.mode !== "report" || sources.length > 0))
  );
}

/** Recommendation state is keyed to the exact draft/context; late responses cannot apply to another draft. */
export function AgentWorkflowControl(props: {
  projectId: string;
  conversationId?: string;
  goal: string;
  sourceVersionIds: string[];
  value: AgentWorkflow;
  onChange: (value: AgentWorkflow) => void;
  supervisorEnabled: boolean;
  steering?: boolean;
}) {
  const key = JSON.stringify([
    props.projectId,
    props.conversationId,
    props.goal,
    props.sourceVersionIds,
    props.value,
    props.steering,
  ]);
  return <WorkflowControls key={key} {...props} />;
}

function WorkflowControls({
  projectId,
  conversationId,
  goal,
  sourceVersionIds,
  value,
  onChange,
  supervisorEnabled,
  steering,
}: Parameters<typeof AgentWorkflowControl>[0]) {
  const t = useT();
  const suggest = useMutation({
    mutationFn: () =>
      api<AgentModeRecommendation>("/knowledge/mode-recommendation", {
        projectId,
        conversationId,
        goal,
        sourceVersionIds,
      }),
  });
  const recommendation =
    suggest.data?.outcome === "classified" ? suggest.data.recommendation : null;
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
                  ? {
                      mode: "report",
                      reportTemplate: "sound-insulation-review",
                    }
                  : { mode: mode as "chat" | "team" },
              )
            }
          />
        </Field>
      )}
      {!steering && value.mode === "report" && (
        <Field label={t("agentReportTemplate")}>
          <NativeSelect
            value={value.reportTemplate}
            disabled={steering}
            onChange={(e) =>
              onChange({
                mode: "report",
                reportTemplate: e.target.value as Extract<
                  AgentWorkflow,
                  { mode: "report" }
                >["reportTemplate"],
              })
            }
          >
            <option value="sound-insulation-review">
              {t("agentTemplateSound")}
            </option>
            <option value="interior-noise-concept">
              {t("agentTemplateInterior")}
            </option>
            <option value="exterior-noise-concept">
              {t("agentTemplateExterior")}
            </option>
          </NativeSelect>
        </Field>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={steering || !goal.trim() || suggest.isPending}
        onClick={() => suggest.mutate()}
      >
        {t("agentSuggestMode")}
      </Button>
      {steering ? (
        <Callout>{t("agentSteeringMode")}</Callout>
      ) : (
        <>
          {value.mode !== "chat" && !supervisorEnabled && (
            <Callout>{t("agentTeamUnavailable")}</Callout>
          )}
          {value.mode === "report" && !sourceVersionIds.length && (
            <Callout>{t("agentReportSourcesRequired")}</Callout>
          )}
          {(suggest.error || (suggest.data && !actionable)) && (
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
                      ? {
                          mode: "report",
                          reportTemplate: "sound-insulation-review",
                        }
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
