import { list, type RecordData } from "../../api";
import { useT } from "../../i18n";
import {
  currentRunTasks,
  runActivityLabel,
  providerActivityExplanation,
  workProgressMetadata,
  workProgressDescription,
  agentName,
  budgetActivityMetadata,
  budgetDescription,
} from "./run-activity";

export function RunActivityFeed({
  events,
  active,
  status,
  run,
  children = [],
}: {
  events: RecordData[];
  active: boolean;
  status?: string;
  run?: RecordData;
  children?: RecordData[];
}) {
  const t = useT();
  const visibleEvents = list(events).filter((event) => runActivityLabel(event));
  const latest = visibleEvents.at(-1);
  const latestLabel = latest && runActivityLabel(latest);
  const latestBudget = latest && budgetActivityMetadata(latest);
  const currentTasks = run
    ? currentRunTasks(run, children, t, visibleEvents)
    : [];
  const hasProgress = currentTasks.some((task) => task.hasProgress);

  if (!active && !visibleEvents.length) return null;

  return (
    <div
      className="run-activity-feed"
      role="group"
      aria-label={t("workspaceAgentProgress")}
    >
      <div role="status" aria-live="polite" aria-atomic="true">
        {active && currentTasks.length > 0 && (
          <div className="run-activity-current">
            <span className="run-activity-current-label">
              {t("workspaceCurrentTask")}:
            </span>
            <div className="run-activity-tasks">
              {currentTasks.map((task) => (
                <div key={task.id}>
                  <p className="font-medium text-foreground">{task.name}</p>
                  <p
                    className={`run-activity-current-text${task.hasProgress ? " run-activity-work-text" : ""}`}
                    title={task.text}
                  >
                    {task.text}
                  </p>
                  {task.summary && (
                    <div className="run-activity-finding">
                      <p className="text-ui-xs">{t("workspaceWorkFindings")}</p>
                      <p
                        className="run-activity-finding-text"
                        title={task.summary}
                      >
                        {task.summary}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {latestLabel &&
        (!active ||
          !hasProgress ||
          ["provider_call_retrying", "provider_call_failed"].includes(
            latest?.eventType,
          )) ? (
          <p>
            {latestBudget
              ? budgetDescription(latestBudget.budget, t)
              : t(latestLabel)}
          </p>
        ) : !currentTasks.length ? (
          <p>
            {status === "queued"
              ? t("agentRunWaitingForWorker")
              : t("workspaceActivityWaiting")}
          </p>
        ) : null}
      </div>
      {visibleEvents.length > 0 && (
        <details className="run-activity-history">
          <summary>
            {t("workspaceActivityHistory")} · {visibleEvents.length}
          </summary>
          <ol>
            {visibleEvents.map((activity) => {
              const label = runActivityLabel(activity);
              if (!label) return null;
              const work = workProgressMetadata(activity);
              const owner =
                work &&
                [run, ...children].find((agent) => agent?.id === work.runId);
              const timestamp = activity.createdAt
                ? new Date(activity.createdAt)
                : null;
              return (
                <li key={activity.id}>
                  {timestamp && !Number.isNaN(timestamp.getTime()) && (
                    <time dateTime={timestamp.toISOString()}>
                      {timestamp.toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  )}
                  <div className="min-w-0 text-foreground wrap-anywhere">
                    {work
                      ? `${owner ? `${agentName(owner, t)}: ` : ""}${workProgressDescription(work, t)}`
                      : t(label)}
                    {work?.summary && (
                      <p>
                        {t("workspaceWorkFindings")}: {work.summary}
                      </p>
                    )}
                    {providerActivityExplanation(activity, t) &&
                      ` · ${providerActivityExplanation(activity, t)}`}
                  </div>
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </div>
  );
}
