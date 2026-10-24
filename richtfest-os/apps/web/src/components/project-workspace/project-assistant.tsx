import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, Plus, X } from "lucide-react";
import { api, list, type RecordData } from "../../api";
import { queryClient, type useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { Callout } from "../ui/primitives";
import { Transcript } from "./transcript";
import "./project-assistant.css";

/** Another surface for the project's existing shared conversation, not a second agent. */
export function ProjectAssistant({
  projectId,
  workspace,
  selected,
  sourceRef,
  canWrite,
  onSelect,
  onClose,
}: {
  projectId: string;
  workspace: ReturnType<typeof useApi>;
  selected?: RecordData;
  sourceRef: string;
  canWrite: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [params] = useSearchParams();
  const helpParams = new URLSearchParams(params);
  helpParams.delete("assistant");
  helpParams.set("guide", "1");
  const panel = useRef<HTMLElement>(null);
  const conversations = list(workspace.data?.conversations).filter(
    (conversation) => !conversation.archivedAt,
  );
  const create = useMutation({
    mutationFn: () =>
      api("/knowledge/conversations", {
        projectId,
        title: `Thread ${list(workspace.data?.conversations).length + 1}`,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [`/knowledge/workspaces/${projectId}`],
      }),
  });
  // Per-mutation callbacks only run while this project panel is still mounted.
  const startConversation = () =>
    create.mutate(undefined, {
      onSuccess: (conversation) => onSelect(conversation.id),
    });
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);
  return (
    <aside
      ref={panel}
      id="project-assistant"
      className="project-assistant"
      aria-label={t("projectAssistant")}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="project-assistant-header">
        <h2 className="text-ui-sm font-semibold">{t("projectAssistant")}</h2>
        <div className="flex items-center gap-stack">
          {selected && (
            <Button asChild variant="ghost" size="icon-sm">
              <Link
                to={`/projects/${projectId}?view=workspace&conversation=${selected.id}`}
                aria-label={t("projectAssistantOpenChat")}
                title={t("projectAssistantOpenChat")}
              >
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("projectAssistantClose")}
            title={t("projectAssistantClose")}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>
      {conversations.length > 0 && (
        <div className="project-assistant-threads">
          <NativeSelect
            aria-label={t("workspaceConversation")}
            value={selected?.id || ""}
            disabled={!conversations.length}
            onChange={(event) => onSelect(event.target.value)}
          >
            {!selected && (
              <option value="">{t("workspaceConversation")}</option>
            )}
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}
              </option>
            ))}
          </NativeSelect>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canWrite || !workspace.isSuccess || create.isPending}
            onClick={startConversation}
            aria-label={t("projectAssistantNewChat")}
            title={t("projectAssistantNewChat")}
          >
            <Plus aria-hidden="true" />
          </Button>
        </div>
      )}
      <p className="project-assistant-scope text-ui-xs text-muted-foreground">
        {t("projectAssistantScope")}
      </p>
      <div className="project-assistant-scope">
        <Link className="text-ui-xs" to={`?${helpParams}`}>
          {t("help")} ↗
        </Link>
      </div>
      {workspace.isPending && (
        <p role="status" className="p-page">
          {t("loading")}
        </p>
      )}
      {workspace.isError && (
        <Callout tone="error">
          {workspace.error.message}
          <Button variant="link" onClick={() => workspace.refetch()}>
            {t("retry")}
          </Button>
        </Callout>
      )}
      {create.error && <Callout tone="error">{create.error.message}</Callout>}
      {workspace.isSuccess &&
        (selected ? (
          <Transcript
            key={selected.id}
            projectId={projectId}
            conversationId={selected.id}
            conversationTitle={selected.title}
            readState={selected.readState}
            sourceRef={sourceRef}
            readOnly={!canWrite}
            runs={list(workspace.data?.runs).filter(
              (run) => run.conversationId === selected.id,
            )}
          />
        ) : (
          <div className="flex flex-col items-start gap-stack p-page">
            <Button
              disabled={!canWrite || create.isPending}
              onClick={startConversation}
            >
              {t("projectAssistantNewChat")}
            </Button>
          </div>
        ))}
    </aside>
  );
}
