import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type RecordData } from "../../api";
import { queryClient } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Badge, Callout } from "../ui/primitives";
import { CraneWorkingIndicator } from "./crane-working-indicator";
export function LiveRun({
  run,
  projectId,
  silent = false,
}: {
  run: RecordData;
  projectId: string;
  silent?: boolean;
}) {
  const t = useT(),
    [events, setEvents] = useState<RecordData[]>([]),
    [offline, setOffline] = useState(false);
  const plannedEvents = useRef(new Set<string>());
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
        setEvents((old) =>
          old.some((e) => e.id === activity.id)
            ? old
            : [...old.slice(-19), activity],
        );
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
      </div>
      {offline && (
        <span className="muted text-ui-xs">{t("workspaceReconnecting")}</span>
      )}
      {stop.error && <Callout tone="error">{stop.error.message}</Callout>}
    </div>
  );
}
