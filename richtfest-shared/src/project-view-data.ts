/** Saved records are untrusted context, never instructions, permissions or citation receipts. */
export type ProjectViewData = {
  status: "available" | "unavailable" | "existing_context";
  reason?: "not_saved" | "selection_not_found" | "project_not_found" | "feature_disabled" | "unsupported_view" | "reader_not_configured" | "payload_too_large";
  authority: "untrusted_saved_project_data";
  truncated: boolean;
  data?: unknown;
};

export function unavailableProjectViewData(reason: NonNullable<ProjectViewData["reason"]>): ProjectViewData {
  return { status: "unavailable", reason, authority: "untrusted_saved_project_data", truncated: false };
}

/** A structured excerpt, including its envelope, never exceeds 16 KiB UTF-8. */
export function boundedProjectViewData(data: unknown, truncated = false): ProjectViewData {
  let width = 40, text = 2000;
  for (;;) {
    const clip = (value: unknown, depth = 0): unknown => {
      if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value ?? null;
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "string") {
        if (value.length > text) truncated = true;
        return value.slice(0, text);
      }
      if (depth >= 10) { truncated = true; return null; }
      if (Array.isArray(value)) {
        if (value.length > width) truncated = true;
        return value.slice(0, width).map(item => clip(item, depth + 1));
      }
      if (typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length > width) truncated = true;
        return Object.fromEntries(entries.slice(0, width).map(([key, item]) => [key, clip(item, depth + 1)]));
      }
      truncated = true;
      return null;
    };
    const excerpt = clip(data);
    const result: ProjectViewData = { status: "available", authority: "untrusted_saved_project_data", truncated, data: excerpt };
    if (new TextEncoder().encode(JSON.stringify(result)).length <= 16384) return result;
    truncated = true;
    width = Math.max(1, Math.floor(width / 2));
    text = Math.floor(text / 2);
    // Owner-projected keys are short; still fail closed for an unexpectedly enormous key.
    if (!text) return { ...unavailableProjectViewData("payload_too_large"), truncated: true };
  }
}
