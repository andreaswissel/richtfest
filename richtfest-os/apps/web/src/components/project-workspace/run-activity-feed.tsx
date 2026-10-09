import { list, type RecordData } from "../../api";
import { useT } from "../../i18n";
import { runActivityLabel } from "./run-activity";

export function RunActivityFeed({
  events,
  active,
  status,
  currentTask,
}: {
  events: RecordData[];
  active: boolean;
  status?: string;
  currentTask?: string;
}) {
  const t = useT();
  const visibleEvents = list(events).filter((event) => runActivityLabel(event));

  if (!active && !visibleEvents.length) return null;

  return (
    <div
      className="run-activity-feed"
      role="log"
      aria-label={t("workspaceAgentProgress")}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {active && currentTask && (
        <p className="run-activity-current">
          <span className="run-activity-current-label">
            {t("workspaceCurrentTask")}:
          </span>
          <span className="run-activity-current-text" title={currentTask}>
            {currentTask}
          </span>
        </p>
      )}
      {visibleEvents.length ? (
        <ol>
          {visibleEvents.map((activity) => {
            const label = runActivityLabel(activity);
            if (!label) return null;
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
                <span>{t(label)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p>
          {status === "queued"
            ? t("agentRunWaitingForWorker")
            : t("workspaceActivityWaiting")}
        </p>
      )}
    </div>
  );
}
