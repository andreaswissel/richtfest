import type { AgentMessage, SourceReference } from "@richtfest/shared";

export type WorkspaceMessage = {
  id: string;
  body: string;
  sourceRef?: string;
  agentMessage?: AgentMessage | null;
  authorId?: string;
  runId?: string;
  actorKind?: string;
  role?: string;
  authorName?: string;
  authorType?: string;
  parentMessageId?: string;
  sourceVersionIds?: string[];
  sourceReferences?: SourceReference[];
  createdAt: string;
  openui?: string;
  annotation?: {
    id: string;
    page?: number;
    quote?: string;
    artifactId?: string;
    artifactRevisionId?: string;
    sourceVersionId?: string;
  };
  metadata?: { openui?: string };
};
export type ReadState = {
  meaningfulMessageId?: string;
  lastReadMessageId?: string;
  composerDraft?: string;
};
export type MessagePage = {
  items: WorkspaceMessage[];
  nextCursor: string | null;
  readState?: ReadState;
  unreadCount: number;
};
export function mergeMessages(pages: MessagePage[]) {
  const rows = new Map<string, WorkspaceMessage>();
  for (const page of [...pages].reverse())
    for (const message of page.items) rows.set(message.id, message);
  return [...rows.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
