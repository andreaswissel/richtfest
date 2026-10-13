import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../i18n";
import { queryClient } from "../../query";
import {
  Message,
  MessageContent,
  MessageHeader,
  MessageFooter,
} from "../ui/message";
import { Bubble, BubbleContent } from "../ui/bubble";
import { agentName } from "./run-activity";
import type { WorkspaceMessage } from "./types";

/** Follow delivery even when a recipient has no running execution. */
export function useAgentMessageEvents(conversationId?: string, runId?: string) {
  useEffect(() => {
    if (!conversationId) return;
    const stream = new EventSource(
      `/api/knowledge/conversations/${conversationId}/message-events`,
      { withCredentials: true },
    );
    stream.addEventListener("messages", () => {
      void queryClient.invalidateQueries({
        queryKey: [`/knowledge/conversations/${conversationId}`],
      });
      if (runId)
        void queryClient.invalidateQueries({
          queryKey: [`/knowledge/runs/${runId}`],
        });
    });
    return () => stream.close();
  }, [conversationId, runId]);
}

export function AgentThreadMessage({
  message,
  projectId,
}: {
  message: WorkspaceMessage;
  projectId: string;
}) {
  const t = useT();
  const metadata = message.agentMessage;
  if (!metadata) return null;
  const participantLink = (participant: typeof metadata.sender) => (
    <Link
      to={`/projects/${projectId}?${new URLSearchParams({ conversation: participant.conversationId, agentRun: participant.runId })}`}
      title={participant.goal}
      className="hover:underline"
    >
      {agentName(
        { specialistRole: participant.role, goal: participant.goal },
        t,
      )}
    </Link>
  );
  return (
    <Message>
      <MessageContent>
        <MessageHeader className="flex-wrap gap-1">
          {participantLink(metadata.sender)}
          <span aria-hidden="true">→</span>
          {participantLink(metadata.recipient)}
        </MessageHeader>
        <Bubble variant="ghost">
          <BubbleContent className="whitespace-pre-wrap">
            {message.body}
          </BubbleContent>
        </Bubble>
        <MessageFooter data-persistent="" className="flex-wrap gap-x-3 gap-y-1">
          <span>{t("agentMessageDelivered")}</span>
          {metadata.replyToMessageId && (
            <Link
              className="hover:underline"
              to={`/projects/${projectId}?${new URLSearchParams({ conversation: metadata.sender.conversationId, message: metadata.replyToMessageId })}`}
            >
              {t("agentMessageReplyTo")}
            </Link>
          )}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}
