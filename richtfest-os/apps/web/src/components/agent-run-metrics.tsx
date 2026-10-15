import { useEffect, useMemo, useState } from "react";
import type { RecordData } from "../api";
import { useT } from "../i18n";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const FIVE_MINUTES = 5 * 60 * 1000;

export function isAgentRunActive(run: RecordData) {
  return ACTIVE_STATUSES.has(run.status);
}

function dateValue(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function runStart(run: RecordData) {
  const started = dateValue(run.startedAt) ?? dateValue(run.started_at);
  if (started !== undefined) return started;
  // A queued run has not started executing yet. Keep the queue wait out of
  // the runtime counter; older running/terminal rows still use createdAt.
  if (run.status === "queued") return undefined;
  // A finished run with a completion timestamp but no start timestamp never
  // entered execution (for example, it was cancelled while still queued).
  if (dateValue(run.finishedAt ?? run.finished_at) !== undefined) return undefined;
  return (
    dateValue(run.createdAt) ??
    dateValue(run.created_at)
  );
}

function runEnd(run: RecordData) {
  return (
    dateValue(run.finishedAt) ??
    dateValue(run.finished_at) ??
    dateValue(run.completedAt) ??
    dateValue(run.completed_at) ??
    dateValue(run.endedAt) ??
    dateValue(run.ended_at) ??
    dateValue(run.updatedAt) ??
    dateValue(run.updated_at)
  );
}

function usageFor(run: RecordData) {
  const aggregate = !run.parentRunId
    ? run.usage?.aggregate || run.aggregateUsage || run.usageAggregate
    : undefined;
  const usage = aggregate || run.usage || run.tokenUsage || run.usageSummary || {};
  return {
    inputTokens: usage.inputTokens ?? usage.input_tokens ?? run.inputTokens,
    outputTokens:
      usage.outputTokens ?? usage.output_tokens ?? run.outputTokens,
    reasoningTokens:
      usage.reasoningTokens ?? usage.reasoning_tokens ?? run.reasoningTokens,
    estimatedCostUsd:
      run.estimatedCostUsd ??
      run.estimated_cost_usd ??
      run.approximateCostUsd ??
      run.approximate_cost_usd ??
      run.costUsd ??
      run.cost_usd ??
      usage.estimatedCostUsd ??
      usage.estimated_cost_usd ??
      usage.approximateCostUsd ??
      usage.approximate_cost_usd ??
      usage.costUsd ??
      usage.cost_usd,
    recordedCostUsd: usage.recordedCostUsd,
  };
}

function elapsedFor(run: RecordData, now: number) {
  const explicit = Number(run.durationMs ?? run.duration_ms);
  if (Number.isFinite(explicit) && explicit >= 0 && !isAgentRunActive(run))
    return explicit;
  const start = runStart(run);
  if (start === undefined) return undefined;
  const end = isAgentRunActive(run) ? now : (runEnd(run) ?? now);
  return Math.max(0, end - start);
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  if (milliseconds < FIVE_MINUTES) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  return `${Math.floor(seconds / 60)} min`;
}

function formatCost(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost < 0) return undefined;
  if (cost < 0.01 && cost > 0) return `<$0.01`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens < 0) return undefined;
  return new Intl.NumberFormat().format(Math.floor(tokens));
}

/** Compact, live-updating elapsed time and provider usage for a run row. */
export function AgentRunMetrics({
  run,
  className = "",
}: {
  run: RecordData;
  className?: string;
}) {
  const t = useT();
  const active = isAgentRunActive(run);
  const start = runStart(run);
  const [now, setNow] = useState(() => Date.now());
  const elapsed = elapsedFor(run, now);
  const usage = useMemo(() => usageFor(run), [run]);
  const inputTokens = formatTokens(usage.inputTokens);
  const outputTokens = formatTokens(usage.outputTokens);
  const reasoningTokens = formatTokens(usage.reasoningTokens);
  const partial = usage.estimatedCostUsd == null && usage.recordedCostUsd != null;
  const cost = formatCost(usage.estimatedCostUsd ?? usage.recordedCostUsd);
  const costLabel = t(partial ? "agentRunKnownCost" : "agentRunCost");
  const usageParts = [
    inputTokens ? `${t("agentRunInputTokens")} ${inputTokens}` : undefined,
    outputTokens ? `${t("agentRunOutputTokens")} ${outputTokens}` : undefined,
    reasoningTokens
      ? `${t("agentRunReasoningTokens")} ${reasoningTokens}`
      : undefined,
  ].filter(Boolean);

  useEffect(() => {
    if (!active || start === undefined) return;
    const age = Math.max(0, Date.now() - start);
    const delay = age < FIVE_MINUTES ? 1000 : 60_000;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [active, start, now]);

  if (elapsed === undefined && !cost && !usageParts.length) return null;
  return (
    <span
      className={`agent-run-metrics${className ? ` ${className}` : ""}`}
      aria-label={[
        elapsed === undefined
          ? undefined
          : `${t("agentRunDuration")}: ${formatElapsed(elapsed)}`,
        ...usageParts,
        cost ? `${costLabel}: ${cost}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      {elapsed !== undefined && (
        <span>
          {t("agentRunDuration")} {formatElapsed(elapsed)}
        </span>
      )}
      {usageParts.map((part) => (
        <span key={part}>{part}</span>
      ))}
      {cost && <span>{costLabel} {cost}</span>}
    </span>
  );
}
