import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type RecordData } from "../../api";
import { queryClient } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Badge, Callout } from "../ui/primitives";
import { CraneWorkingIndicator } from "./crane-working-indicator";
import { runActivityLabel } from "./run-activity";
import { AgentRunMetrics } from "../agent-run-metrics";

export function LiveRun({
  run,
  projectId,
  showSupervisorActivity = true,
  silent = false,
}: {
  run: RecordData;
  projectId: string;
  showSupervisorActivity?: boolean;
  silent?: boolean;
}) {
  const t = useT(),
    [events, setEvents] = useState<RecordData[]>([]),
    [offline, setOffline] = useState(false),
    [expanded, setExpanded] = useState(false);
  const activityId = useId();
  const plannedEvents = useRef(new Set<string>());
  const seenActivities = useRef(new Set<string>());
  useEffect(() => {
    setEvents([]);
    setExpanded(false);
    setOffline(false);
    plannedEvents.current.clear();
    seenActivities.current.clear();
  }, [run.id]);
  const stop = useMutation({
    mutationFn: () => api(`/knowledge/runs/${run.id}/cancel`, {}),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [`/knowledge/workspaces/${projectId}`],
      }),
  });
  useEffect(() => {
    if (!["queued", "running"].includes(run.status)) return;
    const stream = new EventSource(
      `/api/knowledge/runs/${run.id}/events/stream`,
      { withCredentials: true },
    );
    stream.addEventListener("activity", (event) => {
      try {
        const activity = JSON.parse((event as MessageEvent).data);
        if (activity.id && seenActivities.current.has(activity.id)) return;
        if (activity.id) seenActivities.current.add(activity.id);
        if (
          activity.id &&
          ["supervisor_planned", "supervisor_revision_requested"].includes(
            activity.eventType,
          ) &&
          !plannedEvents.current.has(activity.id)
        ) {
          plannedEvents.current.add(activity.id);
          void queryClient.invalidateQueries({
            queryKey: [`/knowledge/workspaces/${projectId}`],
          });
        }
        setOffline(false);
        if (!runActivityLabel(activity)) return;
        void queryClient.invalidateQueries({
          queryKey: [`/knowledge/runs/${run.id}`],
        });
        setEvents((old) => [...old.slice(-49), activity]);
      } catch {
        setOffline(true);
      }
    });
    stream.addEventListener("status", (event) => {
      try {
        const status = JSON.parse((event as MessageEvent).data);
        setOffline(false);
        queryClient.setQueryData(
          [`/knowledge/workspaces/${projectId}`],
          (old: RecordData | undefined) =>
            old
              ? {
                  ...old,
                  runs: old.runs.map((r: RecordData) =>
                    r.id === run.id ? { ...r, ...status } : r,
                  ),
                }
              : old,
        );
        if (!["queued", "running"].includes(status.status)) {
          stream.close();
          void queryClient.invalidateQueries({
            queryKey: [`/knowledge/workspaces/${projectId}`],
          });
          void queryClient.invalidateQueries({
            queryKey: [`/knowledge/runs/${run.id}`],
          });
          if (run.conversationId)
            void queryClient.invalidateQueries({
              queryKey: [
                `/knowledge/conversations/${run.conversationId}`,
                "messages",
              ],
            });
        }
      } catch {
        setOffline(true);
      }
    });
    stream.onerror = () => {
      setOffline(true);
    };
    return () => stream.close();
  }, [run.id, run.status, projectId]);
  if (silent) return null;
  return (
    <div className="workspace-live-run">
      <div className="inline-actions">
        <Badge>
          {["queued", "running"].includes(run.status)
            ? t("workspaceLive")
            : run.status}
        </Badge>
        <AgentRunMetrics run={run} />
        <CraneWorkingIndicator label={t("workspaceUiSupervisorWorking")} />
        {["queued", "running"].includes(run.status) && (
          <Button
            variant="link"
            size="sm"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            {t("workspaceStop")}
          </Button>
        )}
        {showSupervisorActivity && (
          <Button
            variant="link"
            size="sm"
            aria-expanded={expanded}
            aria-controls={activityId}
            onClick={() => setExpanded((value) => !value)}
          >
            {t(
              expanded
                ? "workspaceHideSupervisorActivity"
                : "workspaceShowSupervisorActivity",
            )}
          </Button>
        )}
      </div>
      {showSupervisorActivity && (
        <div
          id={activityId}
          className="workspace-live-run-activity"
          hidden={!expanded}
        >
          {expanded && (
            <div
              className="mt-2 max-h-60 overflow-y-auto border-l pl-3 text-ui-xs"
              role="log"
              aria-label={t("supervisorProgress")}
              aria-live="polite"
              aria-relevant="additions text"
            >
              {events.length ? (
                <ol className="space-y-2 py-2">
                  {events.map((activity) => {
                    const label = runActivityLabel(activity);
                    if (!label) return null;
                    const timestamp = activity.createdAt
                      ? new Date(activity.createdAt)
                      : null;
                    return (
                      <li
                        key={activity.id}
                        className="flex items-baseline gap-2"
                      >
                        {timestamp && !Number.isNaN(timestamp.getTime()) && (
                          <time
                            className="shrink-0 text-muted-foreground tabular-nums"
                            dateTime={timestamp.toISOString()}
                          >
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
                <p className="py-2 text-muted-foreground">
                  {t("workspaceActivityWaiting")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {offline && (
        <span className="muted text-ui-xs">{t("workspaceReconnecting")}</span>
      )}
      {stop.error && <Callout tone="error">{stop.error.message}</Callout>}
    </div>
  );
}
