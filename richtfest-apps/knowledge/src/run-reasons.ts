export type RunFailurePhase =
  | "plan"
  | "specialist"
  | "review"
  | "independent_review"
  | "provider"
  | "execution"
  | "source_resolution"
  | "tool_execution"
  | "finalization"
  | "cancellation"
  | "approval";

export type RunFailureCategory =
  | "provider"
  | "permission"
  | "validation"
  | "source"
  | "project"
  | "cancellation"
  | "execution";

type ErrorMetadata = {
  code?: unknown;
  name?: unknown;
  status?: unknown;
};

function metadata(error: unknown): ErrorMetadata {
  return typeof error === "object" && error !== null
    ? (error as ErrorMetadata)
    : {};
}

/** Classify without reading or persisting an exception message. */
export function classifyRunFailure(
  error: unknown,
  phase: RunFailurePhase,
): RunFailureCategory {
  const value = metadata(error);
  const code = typeof value.code === "string" ? value.code : "";
  const name = typeof value.name === "string" ? value.name : "";
  const status = typeof value.status === "number" ? value.status : undefined;

  if (code === "cancelled" || name === "AbortError") return "cancellation";
  if (status === 401 || status === 403 || ["forbidden", "unauthorized", "permission_denied"].includes(code))
    return "permission";
  if (phase === "source_resolution") return "source";
  if (["not_found", "project_unavailable"].includes(code)) return "project";
  if (code === "validation_error" || code === "invalid_state" || name === "ZodError")
    return "validation";
  return "execution";
}

const actionableMessage: Record<RunFailureCategory, string> = {
  provider: "The provider call could not complete. Check the provider connection and retry.",
  permission: "A required permission is unavailable. Ask an administrator for access and retry.",
  validation: "The run returned unsupported or invalid output. Review the inputs and retry.",
  source: "Required project source content is unavailable. Restore or select readable sources and retry.",
  project: "The project is unavailable. Confirm project access and retry.",
  cancellation: "The run was cancelled before output could be approved.",
  execution: "The run stopped unexpectedly before output could be approved. Retry the run.",
};

export function formatRunFailureReason(
  phase: RunFailurePhase,
  category: RunFailureCategory,
  providerStatus?: number,
): string {
  const status = providerStatus === undefined ? "" : `; provider_http_status=${providerStatus}`;
  return `phase=${phase}; category=${category}; ${actionableMessage[category]}${status}`;
}

export function formatChildCancellationReason(
  phase: RunFailurePhase,
  category: RunFailureCategory,
  cause: "supervisor_failed" | "supervisor_cancelled" | "supervisor_steered",
): string {
  const causeText = {
    supervisor_failed: "The supervisor failed",
    supervisor_cancelled: "The supervisor was cancelled",
    supervisor_steered: "The supervisor was steered with new instructions",
  }[cause];
  return `phase=${phase}; category=${category}; ${causeText} during ${phase}; this child run was cancelled. Retry the supervisor run.`;
}

export const userCancellationReason =
  "phase=cancellation; category=cancellation; The run was cancelled by a user before output could be approved. Retry the run if needed.";

export const reviewRejectionReason =
  "phase=approval; category=cancellation; Output was rejected during human review. Retry the run to submit new output.";
