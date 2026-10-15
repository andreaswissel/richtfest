import { list, type RecordData } from "../../api";
import { useT } from "../../i18n";
import {
  ActivityIcon,
  CircleAlertIcon,
  ClockIcon,
  HistoryIcon,
  LoaderCircleIcon,
} from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "../ui/trace";
import {
  currentRunTasks,
  runActivityLabel,
  providerActivityExplanation,
  workProgressMetadata,
  workProgressDescription,
  agentName,
  budgetActivityMetadata,
  budgetDescription,
  waitingBudgetCalls,
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
  const latestExplanation = latest && providerActivityExplanation(latest, t);
  const currentTasks = run
    ? currentRunTasks(run, children, t, visibleEvents)
    : [];
  const hasProgress = currentTasks.some((task) => task.hasProgress);
  const waiting = waitingBudgetCalls(visibleEvents);

  if (!active && !visibleEvents.length) return null;

  return (
    <div
      className="mt-2 min-w-0 text-ui-sm text-muted-foreground"
      role="group"
      aria-label={t("workspaceAgentProgress")}
    >
      <Trace role="status" aria-live="polite" aria-atomic="true">
        {active && currentTasks.length > 0 && (
          <Trace aria-label={t("workspaceCurrentTask")}>
            {currentTasks.map((task) => {
              const pending =
                [run, ...children].find((agent) => agent?.id === task.id)
                  ?.status === "queued" ||
                waiting.some((call) => call.runId === task.id);
              return (
                <div key={task.id} className="min-w-0">
                  <Trace>
                    <TraceLine status={pending ? "pending" : "running"}>
                      <TraceIcon>
                        {pending ? (
                          <ClockIcon />
                        ) : (
                          <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                        )}
                      </TraceIcon>
                      <TraceTitle className="whitespace-normal wrap-anywhere">
                        {task.name}
                      </TraceTitle>
                    </TraceLine>
                  </Trace>
                  <div className="mt-1 ml-[calc(var(--icon)+0.5rem)] space-y-1 leading-relaxed wrap-anywhere">
                    <p>{task.text}</p>
                    {task.summary && (
                      <div>
                        <p className="text-ui-xs">
                          {t("workspaceWorkFindings")}
                        </p>
                        <p className="text-foreground">{task.summary}</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </Trace>
        )}
        {latestLabel &&
        (!active ||
          !hasProgress ||
          ["provider_call_retrying", "provider_call_failed"].includes(
            latest?.eventType,
          )) ? (
          <div>
            <Trace>
              <TraceLine
                status={
                  latest?.eventType.includes("failed") ? "error" : undefined
                }
              >
                <TraceIcon>
                  {latest?.eventType.includes("failed") ? (
                    <CircleAlertIcon />
                  ) : (
                    <ActivityIcon />
                  )}
                </TraceIcon>
                <TraceTitle className="whitespace-normal wrap-anywhere">
                  {latestBudget
                    ? budgetDescription(latestBudget.budget, t)
                    : t(latestLabel)}
                </TraceTitle>
              </TraceLine>
            </Trace>
            {latestExplanation && (
              <p className="mt-1 ml-[calc(var(--icon)+0.5rem)] leading-relaxed wrap-anywhere">
                {latestExplanation}
              </p>
            )}
          </div>
        ) : !currentTasks.length ? (
          <TraceLine status={status === "queued" ? "pending" : "running"}>
            <TraceIcon>
              {status === "queued" ? (
                <ClockIcon />
              ) : (
                <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
              )}
            </TraceIcon>
            <TraceTitle>
              {status === "queued"
                ? t("agentRunWaitingForWorker")
                : t("workspaceActivityWaiting")}
            </TraceTitle>
          </TraceLine>
        ) : null}
      </Trace>
      {visibleEvents.length > 0 && (
        <TraceCollapsible className="mt-2">
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceIcon>
                <HistoryIcon />
              </TraceIcon>
              <TraceTitle>{t("workspaceActivityHistory")}</TraceTitle>
              <TraceDescription>{visibleEvents.length}</TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <Trace>
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
                const explanation = providerActivityExplanation(activity, t);
                return (
                  <div key={activity.id} className="min-w-0">
                    <Trace>
                      <TraceLine
                        status={
                          activity.eventType.includes("failed")
                            ? "error"
                            : undefined
                        }
                        className="items-start"
                      >
                        <TraceIcon>
                          {activity.eventType.includes("failed") ? (
                            <CircleAlertIcon />
                          ) : (
                            <ActivityIcon />
                          )}
                        </TraceIcon>
                        <TraceTitle className="whitespace-normal wrap-anywhere">
                          {work
                            ? `${owner ? `${agentName(owner, t)}: ` : ""}${workProgressDescription(work, t)}`
                            : t(label)}
                        </TraceTitle>
                        {timestamp && !Number.isNaN(timestamp.getTime()) && (
                          <TraceDescription>
                            <time
                              className="text-ui-2xs"
                              dateTime={timestamp.toISOString()}
                            >
                              {timestamp.toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </time>
                          </TraceDescription>
                        )}
                      </TraceLine>
                    </Trace>
                    <div className="ml-[calc(var(--icon)+0.5rem)] leading-relaxed wrap-anywhere">
                      {work?.summary && (
                        <p>
                          {t("workspaceWorkFindings")}: {work.summary}
                        </p>
                      )}
                      {explanation && <p>{explanation}</p>}
                    </div>
                  </div>
                );
              })}
            </Trace>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )}
    </div>
  );
}
