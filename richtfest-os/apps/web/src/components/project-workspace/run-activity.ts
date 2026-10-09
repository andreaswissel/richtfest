import type { RecordData } from "../../api";

const activityLabels = {
  started: "workspaceActivityRunStarted",
  supervisor_started: "workspaceActivityStarted",
  provider_call_started: "workspaceActivityProviderCallStarted",
  provider_call_completed: "workspaceActivityProviderCallCompleted",
  provider_call_failed: "workspaceActivityProviderCallFailed",
  resumed: "workspaceActivityResumed",
  supervisor_planned: "workspaceActivityPlanned",
  specialist_completed: "workspaceActivitySpecialistCompleted",
  supervisor_revision_requested: "workspaceActivityRevision",
  supervisor_review_completed: "workspaceActivityReviewed",
  independent_review_started: "workspaceActivityIndependentReviewStarted",
  independent_review_completed: "workspaceActivityIndependentReviewCompleted",
  independent_review_revision_requested: "workspaceActivityIndependentReviewRevision",
  tool_executed: "workspaceActivityTool",
  completed: "workspaceActivityCompleted",
  failed: "workspaceActivityFailed",
  supervisor_failed: "workspaceActivityFailed",
  cancelled: "workspaceActivityCancelled",
  interrupted: "workspaceActivityInterrupted",
  steered: "workspaceActivitySteered",
  unconfigured: "workspaceActivityUnconfigured",
  validated_tool_unavailable: "workspaceActivityCalculationUnavailable",
} as const;

const toolLabels = {
  resolve_project_source: "workspaceActivitySource",
  delegate_source_review: "workspaceActivityDelegated",
  create_draft: "workspaceActivityDraft",
  ask_missing_input: "workspaceActivityQuestion",
  validated_calculation: "workspaceActivityCalculationUnavailable",
} as const;

type ActivityTranslationKey =
  | (typeof activityLabels)[keyof typeof activityLabels]
  | (typeof toolLabels)[keyof typeof toolLabels];

export function runActivityLabel(
  event: RecordData,
): ActivityTranslationKey | undefined {
  if (event.eventType === "tool_executed")
    return (
      toolLabels[event.toolName as keyof typeof toolLabels] ??
      activityLabels.tool_executed
    );
  return activityLabels[event.eventType as keyof typeof activityLabels];
}
