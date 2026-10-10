import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError, list, type RecordData } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { Callout, Field } from "../ui/primitives";
import { AgentEffortControl } from "../agent-effort-control";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  Copy,
  Search,
  Square,
  X,
} from "lucide-react";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  useMessageScroller,
  useMessageScrollerVisibility,
  useMessageScrollerScrollable,
} from "../ui/message-scroller";
import {
  Message,
  MessageContent,
  MessageHeader,
  MessageFooter,
} from "../ui/message";
import { Bubble, BubbleContent } from "../ui/bubble";
import { ChatMarkdown } from "../chat-markdown";
import { Marker, MarkerContent } from "../ui/marker";
import { LiveRun } from "./live-run";
import {
  Attachment,
  AttachmentContent,
  AttachmentTitle,
} from "../ui/attachment";
import {
  mergeMessages,
  type MessagePage,
  type WorkspaceMessage,
  type ReadState,
} from "./types";
const ProjectOpenUI = lazy(() => import("./openui"));

const runFailureCategoryLabels: Record<string, string> = {
  provider: "workspaceRunCategoryProvider",
  permission: "workspaceRunCategoryPermission",
  validation: "workspaceRunCategoryValidation",
  source: "workspaceRunCategorySource",
  project: "workspaceRunCategoryProject",
  cancellation: "workspaceRunCategoryCancellation",
  execution: "workspaceRunCategoryExecution",
};

const runFailurePhaseLabels: Record<string, string> = {
  plan: "workspaceRunPhasePlan",
  specialist: "workspaceRunPhaseSpecialist",
  review: "workspaceRunPhaseReview",
  independent_review: "workspaceRunPhaseIndependentReview",
  provider: "workspaceRunPhaseProvider",
  execution: "workspaceRunPhaseExecution",
  source_resolution: "workspaceRunPhaseSourceResolution",
  tool_execution: "workspaceRunPhaseToolExecution",
  finalization: "workspaceRunPhaseFinalization",
  cancellation: "workspaceRunPhaseCancellation",
  approval: "workspaceRunPhaseApproval",
};

function safeRunFailureReason(run: RecordData, t: ReturnType<typeof useT>) {
  const reason = [run.error, run.failureReason].find(
    (value) => typeof value === "string" && value.trim(),
  );
  const category =
    typeof reason === "string"
      ? /(?:^|;)\s*category=([a-z_]+)/.exec(reason)?.[1]
      : undefined;
  const phase =
    typeof reason === "string"
      ? /(?:^|;)\s*phase=([a-z_]+)/.exec(reason)?.[1]
      : undefined;
  const providerStatus =
    typeof reason === "string"
      ? /(?:^|;)\s*provider_http_status=(\d{3})/.exec(reason)?.[1]
      : undefined;
  const translation = category && runFailureCategoryLabels[category];
  const translatedPhase = phase && runFailurePhaseLabels[phase];
  if (!translation) return t("workspaceRunFailedNoReason");
  const categoryReason = t(translation as Parameters<typeof t>[0]);
  const reasonText = translatedPhase
    ? `${t("workspaceRunFailedDuring")} ${t(translatedPhase as Parameters<typeof t>[0])}: ${categoryReason}`
    : categoryReason;
  return providerStatus
    ? `${reasonText} (${t("workspaceRunProviderHttpStatus")}: ${providerStatus})`
    : reasonText;
}

function FailedRunOutcome({
  run,
  projectId,
  conversationId,
  hasRetry,
  hasActiveRun,
}: {
  run: RecordData;
  projectId: string;
  conversationId: string;
  hasRetry: boolean;
  hasActiveRun: boolean;
}) {
  const t = useT();
  const retry = useMutation({
    mutationFn: () => api(`/knowledge/runs/${run.id}/retry`, {}),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const params = new URLSearchParams({
    conversation: conversationId,
    agentRun: run.id,
  });

  return (
    <Message>
      <MessageContent>
        <MessageHeader>{t("workspaceRunOutcomeTitle")}</MessageHeader>
        <Callout tone="error">{safeRunFailureReason(run, t)}</Callout>
        <div className="flex flex-wrap items-center gap-stack">
          <Button asChild variant="link" size="sm">
            <Link to={`/projects/${projectId}?${params}`}>
              {t("workspaceRunOutcomeDetails")}
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              retry.isPending || retry.isSuccess || hasRetry || hasActiveRun
            }
            onClick={() => retry.mutate()}
          >
            {retry.isPending
              ? t("workspaceRunRetrying")
              : retry.isSuccess || hasRetry
                ? t("workspaceRunRetryStarted")
                : t("workspaceRetryRun")}
          </Button>
        </div>
        {retry.error && (
          <Callout tone="error">{t("workspaceRunRetryFailed")}</Callout>
        )}
      </MessageContent>
    </Message>
  );
}

export function Transcript({
  conversationId,
  projectId,
  readState,
  runs = [],
  initialMessage,
  onInitialMessageSent,
}: {
  conversationId: string;
  projectId: string;
  readState?: ReadState;
  runs?: RecordData[];
  initialMessage?: string;
  onInitialMessageSent?: () => void;
}) {
  const [following, setFollowing] = useState(false);
  return (
    <MessageScrollerProvider
      key={conversationId}
      autoScroll={following}
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={32}
    >
      <Conversation
        key={conversationId}
        conversationId={conversationId}
        projectId={projectId}
        readState={readState}
        runs={runs}
        initialMessage={initialMessage}
        onInitialMessageSent={onInitialMessageSent}
        following={following}
        setFollowing={setFollowing}
      />
    </MessageScrollerProvider>
  );
}
function Conversation({
  conversationId,
  projectId,
  readState,
  following,
  setFollowing,
  runs,
  initialMessage,
  onInitialMessageSent,
}: {
  conversationId: string;
  projectId: string;
  readState?: ReadState;
  runs: RecordData[];
  following: boolean;
  setFollowing: (value: boolean) => void;
  initialMessage?: string;
  onInitialMessageSent?: () => void;
}) {
  const t = useT(),
    [params, setParams] = useSearchParams();
  const path = `/knowledge/conversations/${conversationId}`;
  const [effort, setEffort] = useState("medium");
  const [attachments, setAttachments] = useState<string[]>([]);
  const readiness = useApi("/agent/readiness");
  const readinessProvider =
    readiness.data?.provider ||
    readiness.data?.selectedProvider ||
    readiness.data?.activeProvider;
  const configuredPresets = list(readiness.data?.supervisor?.presets).filter(
    (preset) => preset.configured,
  );
  const configuredDefault =
    configuredPresets.find((preset) => preset.effort === "medium")?.effort ||
    configuredPresets[0]?.effort ||
    "medium";
  const selectedEffort = configuredPresets.some(
    (preset) => preset.effort === effort,
  )
    ? effort
    : configuredDefault;
  useEffect(() => {
    if (configuredPresets.length)
      setEffort((current) =>
        configuredPresets.some((preset) => preset.effort === current)
          ? current
          : configuredDefault,
      );
  }, [readiness.data?.supervisor]);
  const startRun = useMutation({
    mutationFn: ({
      goal,
      sourceVersionIds,
      messageId,
      effort,
    }: {
      goal: string;
      sourceVersionIds: string[];
      messageId?: string;
      effort: string;
    }) =>
      api("/knowledge/runs", {
        projectId,
        conversationId,
        effort,
        goal,
        sourceVersionIds,
        messageId,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [`/knowledge/workspaces/${projectId}`],
      }),
  });
  const steer = useMutation({
    mutationFn: ({
      runId,
      instruction,
      messageId,
      sourceVersionIds,
    }: {
      runId: string;
      instruction: string;
      messageId: string;
      sourceVersionIds: string[];
    }) =>
      api(`/knowledge/runs/${runId}/steer`, {
        instruction,
        messageId,
        sourceVersionIds,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [`/knowledge/workspaces/${projectId}`],
      }),
  });
  const activeSupervisorRun = readiness.data?.supervisor?.enabled
    ? runs.find(
        (candidate) =>
          !candidate.parentRunId &&
          candidate.conversationId === conversationId &&
          (!readinessProvider || candidate.provider === readinessProvider) &&
          ["queued", "running"].includes(candidate.status),
      )
    : undefined;
  const stopRun = useMutation({
    mutationFn: () =>
      api(`/knowledge/runs/${activeSupervisorRun!.id}/cancel`, {}),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [`/knowledge/workspaces/${projectId}`],
      }),
  });
  const query = useInfiniteQuery({
    queryKey: [path, "messages"],
    initialPageParam: "",
    refetchOnMount: "always",
    queryFn: ({ pageParam }) =>
      api<MessagePage>(
        `${path}/messages?limit=50${pageParam ? `&before=${pageParam}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
  });
  const messages = useMemo(
    () => mergeMessages(query.data?.pages || []),
    [query.data?.pages],
  );
  const initial = query.data?.pages[0]?.readState || readState;
  const [draft, setDraft] = useState(
      readState?.composerDraft || initialMessage || "",
    ),
    [search, setSearch] = useState(""),
    [reply, setReply] = useState<string>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const hydrated = useRef(false),
    restored = useRef(false),
    reader = useRef<ReadState>(readState || {}),
    draftDirty = useRef(false);
  const { scrollToMessage, scrollToEnd } = useMessageScroller();
  const visibility = useMessageScrollerVisibility(),
    scrollable = useMessageScrollerScrollable();
  const composer = useRef<HTMLTextAreaElement>(null);
  const handleReply = useCallback((id: string) => {
    setReply(id);
    composer.current?.focus();
  }, []);
  const handleInput = useCallback((body: string) => {
    setDraft(body);
    draftDirty.current = true;
    composer.current?.focus();
  }, []);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const [searchTerm, setSearchTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const searchQuery = useInfiniteQuery({
    queryKey: [path, "search", searchTerm],
    enabled: !!searchTerm,
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<MessagePage>(
        `${path}/messages?limit=50&q=${encodeURIComponent(searchTerm)}${pageParam ? `&before=${pageParam}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
  });
  const save = useMutation({
    scope: { id: `reader-${conversationId}` },
    mutationFn: (body: ReadState) =>
      api<ReadState>(`${path}/read`, body, "PUT"),
    onSuccess: (state, variables) => {
      queryClient.setQueryData([path, "messages"], (old: any) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page: MessagePage) => ({
                ...page,
                readState: state,
              })),
            }
          : old,
      );
      queryClient.setQueryData(
        [`/knowledge/workspaces/${projectId}`],
        (old: any) =>
          old
            ? {
                ...old,
                conversations: old.conversations.map((conversation: any) =>
                  conversation.id === conversationId
                    ? {
                        ...conversation,
                        readState: state,
                        ...(variables.lastReadMessageId === messages.at(-1)?.id
                          ? { unreadCount: 0 }
                          : {}),
                      }
                    : conversation,
                ),
              }
            : old,
      );
    },
  });
  const lastReaderWrite = useRef("");
  const persistReader = (state: ReadState) => {
    const payload: ReadState = {
      ...(typeof state.lastReadMessageId === "string"
        ? { lastReadMessageId: state.lastReadMessageId }
        : {}),
      ...(typeof state.meaningfulMessageId === "string"
        ? { meaningfulMessageId: state.meaningfulMessageId }
        : {}),
      composerDraft: state.composerDraft || "",
    };
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === lastReaderWrite.current) return;
    lastReaderWrite.current = fingerprint;
    save.mutate(payload, {
      onError: () => {
        if (lastReaderWrite.current === fingerprint)
          lastReaderWrite.current = "";
      },
    });
  };
  const send = useMutation({
    mutationFn: (body: {
      body: string;
      parentMessageId?: string;
      sourceVersionIds: string[];
    }) => api<WorkspaceMessage>(`${path}/messages`, body),
    onSuccess: async (message, submitted) => {
      if (messages.length === 0 && !submitted.parentMessageId) {
        void api<{ title: string }>(`${path}/title-from-message`, {
          messageId: message.id,
        })
          .then(({ title }) => {
            queryClient.setQueryData(
              [`/knowledge/workspaces/${projectId}`],
              (old: any) =>
                old
                  ? {
                      ...old,
                      conversations: old.conversations.map(
                        (conversation: any) =>
                          conversation.id === conversationId
                            ? { ...conversation, title }
                            : conversation,
                      ),
                    }
                  : old,
            );
          })
          .catch(() => undefined);
      }
      if (readiness.data?.executionAvailable) {
        const nextRun = {
          goal: submitted.body,
          sourceVersionIds: submitted.sourceVersionIds,
          messageId: message.id,
          effort: selectedEffort,
        };
        if (activeSupervisorRun)
          steer.mutate(
            {
              runId: activeSupervisorRun.id,
              instruction: submitted.body,
              messageId: message.id,
              sourceVersionIds: submitted.sourceVersionIds,
            },
            {
              onError: (error) => {
                // A legacy direct run has no supervisor state. The saved human
                // message is reused when starting its first supervisor round.
                if (error instanceof ApiError && error.status === 409)
                  startRun.mutate(nextRun);
              },
            },
          );
        else startRun.mutate(nextRun);
      }
      const composerUnchanged = latestDraft.current === submitted.body;
      if (composerUnchanged) {
        setDraft("");
        setAttachments([]);
        setReply(undefined);
      }
      draftDirty.current = !composerUnchanged;
      reader.current = {
        ...reader.current,
        composerDraft: composerUnchanged ? "" : latestDraft.current,
        meaningfulMessageId: message.id,
        lastReadMessageId: message.id,
      };
      persistReader(reader.current);
      queryClient.setQueryData([path, "messages"], (old: any) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p: MessagePage, i: number) =>
                i ? p : { ...p, items: [...p.items, message] },
              ),
            }
          : old,
      );
      setFollowing(true);
      requestAnimationFrame(() =>
        scrollToMessage(message.id, {
          align: "start",
          behavior: "instant",
          scrollMargin: 32,
        }),
      );
      void queryClient.invalidateQueries({
        queryKey: [`/knowledge/workspaces/${projectId}`],
      });
    },
  });
  const initialMessageSubmitted = useRef(false);
  useEffect(() => {
    if (
      !initialMessage ||
      !ready ||
      !readiness.isFetched ||
      messages.length > 0 ||
      initialMessageSubmitted.current
    )
      return;
    initialMessageSubmitted.current = true;
    send.mutate({ body: initialMessage, sourceVersionIds: [] });
    onInitialMessageSent?.();
  }, [initialMessage, ready, readiness.isFetched, messages.length]);
  useEffect(() => {
    if (query.data && !hydrated.current) {
      hydrated.current = true;
      reader.current = initial || {};
      if (!draftDirty.current) setDraft(initial?.composerDraft || "");
    }
  }, [query.data]);
  useEffect(
    () => () => {
      if (hydrated.current)
        persistReader({
          ...reader.current,
          composerDraft: latestDraft.current,
        });
    },
    [conversationId],
  );
  const target = params.get("message") || initial?.meaningfulMessageId;
  const direct = useQuery({
    queryKey: [path, "message", target],
    enabled: !!target && !!query.data && !messages.some((m) => m.id === target),
    queryFn: () => api<WorkspaceMessage>(`${path}/messages/${target}`),
  });
  const persistedMessages = useMemo(
    () =>
      direct.data && !messages.some((m) => m.id === direct.data.id)
        ? [direct.data, ...messages]
        : messages,
    [direct.data, messages],
  );
  const canonicalRunMessageIds = new Map<string, string>();
  for (const run of runs) {
    if (!run.outputSummary) continue;
    const terminal = persistedMessages
      .filter(
        (message) =>
          message.runId === run.id &&
          message.actorKind === "agent" &&
          message.body === run.outputSummary,
      )
      .at(-1);
    if (terminal) canonicalRunMessageIds.set(run.id, terminal.id);
  }
  const partialMessages: WorkspaceMessage[] = runs
    .filter((run) => run.partialOutput && !canonicalRunMessageIds.has(run.id))
    .map((run) => ({
      id: `run-${run.id}`,
      runId: run.id,
      body: run.partialOutput,
      actorKind: "agent",
      createdAt: run.createdAt,
      metadata: {},
    }));
  const failedRuns = runs.filter(
    (run) =>
      !run.parentRunId &&
      run.conversationId === conversationId &&
      run.status === "failed",
  );
  const failedOutcomes = new Map(
    failedRuns.map((run) => [`run-${run.id}-outcome`, run]),
  );
  const outcomeMessages: WorkspaceMessage[] = failedRuns.map((run) => ({
    id: `run-${run.id}-outcome`,
    runId: run.id,
    body: "",
    actorKind: "agent",
    createdAt: run.finishedAt || run.updatedAt || run.createdAt,
  }));
  const displayMessages = [
    ...persistedMessages,
    ...partialMessages,
    ...outcomeMessages,
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  useLayoutEffect(() => {
    if (!query.data || restored.current) return;
    if (
      target &&
      !displayMessages.some((m) => m.id === target) &&
      direct.isPending
    )
      return;
    requestAnimationFrame(() => {
      if (target)
        scrollToMessage(target, { align: "start", behavior: "instant" });
      restored.current = true;
      setReady(true);
    });
  }, [query.data, target, direct.data, direct.isPending]);
  useEffect(() => {
    const id = params.get("message");
    if (ready && id) {
      setFollowing(false);
      scrollToMessage(id, { align: "center", behavior: "instant" });
    }
  }, [params.get("message"), ready, direct.data]);
  useEffect(() => {
    if (!ready) return;
    const meaningful = visibility.currentAnchorId;
    if (
      meaningful &&
      persistedMessages.some((message) => message.id === meaningful)
    )
      reader.current.meaningfulMessageId = meaningful;
    const last = visibility.visibleMessageIds
      .filter((id) => !id.startsWith("run-"))
      .at(-1);
    if (following && last) reader.current.lastReadMessageId = last;
    const timer = setTimeout(
      () => persistReader({ ...reader.current, composerDraft: draft }),
      700,
    );
    return () => clearTimeout(timer);
  }, [
    visibility.currentAnchorId,
    visibility.visibleMessageIds.join(","),
    persistedMessages,
    draft,
    ready,
    following,
  ]);
  useEffect(() => {
    const select = () => {
      if (window.getSelection()?.toString()) setFollowing(false);
    };
    document.addEventListener("selectionchange", select);
    return () => document.removeEventListener("selectionchange", select);
  }, []);
  const matches = searchTerm
    ? mergeMessages(searchQuery.data?.pages || [])
    : [];
  const unread = messages.filter(
    (m) =>
      m.id !== reader.current.lastReadMessageId &&
      (!reader.current.lastReadMessageId ||
        messages.findIndex((x) => x.id === m.id) >
          messages.findIndex((x) => x.id === reader.current.lastReadMessageId)),
  ).length;
  return (
    <div className="project-conversation">
      <div className="workspace-conversation-tools">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="workspace-search-toggle"
          aria-label={
            searchOpen
              ? t("workspaceUiCloseSearch")
              : t("workspaceUiOpenSearch")
          }
          aria-expanded={searchOpen}
          title={
            searchOpen
              ? t("workspaceUiCloseSearch")
              : t("workspaceUiOpenSearch")
          }
          onClick={() => {
            setSearchOpen((open) => !open);
            if (searchOpen) setSearch("");
          }}
        >
          {searchOpen ? (
            <X aria-hidden="true" />
          ) : (
            <Search aria-hidden="true" />
          )}
        </Button>
        {searchOpen && (
          <div className="workspace-search">
            <Input
              autoFocus
              value={search}
              aria-label={t("workspaceSearch")}
              placeholder={t("workspaceSearch")}
              onFocus={() => setFollowing(false)}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <div className="search-results">
                {matches.map((m) => (
                  <Button
                    variant="ghost"
                    key={m.id}
                    onClick={() => {
                      setFollowing(false);
                      const next = new URLSearchParams(params);
                      next.set("message", m.id);
                      setParams(next);
                    }}
                  >
                    {m.body.slice(0, 90)}
                  </Button>
                ))}
                {!matches.length && (
                  <span>
                    {searchQuery.isFetching
                      ? t("loading")
                      : t("workspaceNoMatches")}
                  </span>
                )}
                {searchQuery.hasNextPage && (
                  <Button
                    variant="ghost"
                    onClick={() => searchQuery.fetchNextPage()}
                  >
                    {t("workspaceOlder")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {query.error && (
        <Callout tone="error">
          {query.error.message}
          <Button variant="link" onClick={() => query.refetch()}>
            {t("retry")}
          </Button>
        </Callout>
      )}
      <MessageScroller className="project-transcript">
        <MessageScrollerViewport
          aria-label={t("workspaceConversation")}
          preserveScrollOnPrepend
          onScroll={(event) => {
            const viewport = event.currentTarget;
            const atEnd =
              viewport.scrollHeight -
                viewport.scrollTop -
                viewport.clientHeight <=
              8;
            if (!atEnd) {
              setFollowing(false);
              return;
            }

            setFollowing(true);
            const lastMessage = messages.at(-1);
            if (
              lastMessage &&
              reader.current.lastReadMessageId !== lastMessage.id
            ) {
              reader.current.lastReadMessageId = lastMessage.id;
              persistReader({ ...reader.current, composerDraft: draft });
            }
          }}
          onWheel={() => setFollowing(false)}
          onTouchMove={() => setFollowing(false)}
          onKeyDown={() => setFollowing(false)}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) setFollowing(false);
          }}
        >
          <MessageScrollerContent
            className={`p-page gap-stack ${ready ? "" : "invisible"}`}
            aria-live="off"
          >
            {query.hasNextPage && (
              <Button
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => {
                  setFollowing(false);
                  void query.fetchNextPage();
                }}
              >
                {t("workspaceOlder")}
              </Button>
            )}
            {displayMessages.map((message, index) => (
              <MessageScrollerItem
                key={
                  failedOutcomes.has(message.id)
                    ? message.id
                    : message.id.startsWith("run-") ||
                        (message.runId &&
                          canonicalRunMessageIds.get(message.runId) ===
                            message.id)
                      ? `run-${message.runId}`
                      : message.id
                }
                messageId={message.id}
                scrollAnchor={
                  (message.actorKind ||
                    message.authorType ||
                    message.role ||
                    "user") === "user"
                }
              >
                {index > 0 &&
                  displayMessages[index - 1]?.id ===
                    readState?.lastReadMessageId && (
                    <Marker variant="separator">
                      <MarkerContent>{t("workspaceUnread")}</MarkerContent>
                    </Marker>
                  )}
                {!failedOutcomes.has(message.id) &&
                  message.id.startsWith("run-") &&
                  ["stopped", "cancelled", "failed"].includes(
                    runs.find((run) => run.id === message.runId)?.status,
                  ) && (
                    <Marker>
                      <MarkerContent>{t("workspaceInterrupted")}</MarkerContent>
                    </Marker>
                  )}
                {failedOutcomes.has(message.id) ? (
                  <FailedRunOutcome
                    run={failedOutcomes.get(message.id)!}
                    projectId={projectId}
                    conversationId={conversationId}
                    hasRetry={runs.some(
                      (run) => run.retryOfRunId === message.runId,
                    )}
                    hasActiveRun={runs.some(
                      (run) =>
                        !run.parentRunId &&
                        run.conversationId === conversationId &&
                        ["queued", "running"].includes(run.status),
                    )}
                  />
                ) : (
                  <MessageRow
                    message={message}
                    projectId={projectId}
                    conversationId={conversationId}
                    reviewRun={
                      message.runId
                        ? canonicalRunMessageIds.get(message.runId) ===
                          message.id
                          ? runs.find(
                              (run) =>
                                run.id === message.runId &&
                                !run.parentRunId &&
                                run.status === "needs_review",
                            )
                          : undefined
                        : undefined
                    }
                    onReply={handleReply}
                    onInput={handleInput}
                  />
                )}
              </MessageScrollerItem>
            ))}
            {runs
              .filter((run) => ["queued", "running"].includes(run.status))
              .map((run) => (
                <MessageScrollerItem
                  key={`run-${run.id}-working`}
                  messageId={`run-${run.id}-working`}
                >
                  <Message>
                    <MessageContent>
                      <LiveRun
                        run={run}
                        projectId={projectId}
                        currentTask={(() => {
                          if (!run.isSupervisor) return run.goal;
                          const children = runs.filter(
                            (candidate) => candidate.parentRunId === run.id,
                          );
                          const activeChild = children.find((child) =>
                            ["queued", "running"].includes(child.status),
                          );
                          return (
                            activeChild?.goal ||
                            t(
                              children.length
                                ? "workspaceTaskReviewing"
                                : "workspaceTaskPlanning",
                            )
                          );
                        })()}
                      />
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
            {!displayMessages.length && (
              <Marker>
                <MarkerContent>{t("noMessages")}</MarkerContent>
              </Marker>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
      {scrollable.end && (
        <div className="workspace-jump">
          <Button
            variant="outline"
            onClick={() => {
              setFollowing(true);
              scrollToEnd({ behavior: "instant" });
              reader.current.lastReadMessageId = messages.at(-1)?.id;
              persistReader({ ...reader.current, composerDraft: draft });
            }}
          >
            {t("workspaceLatest")} {unread > 0 && `· ${unread}`}
          </Button>
        </div>
      )}
      <form
        className="workspace-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim())
            send.mutate({
              body: draft,
              parentMessageId: reply,
              sourceVersionIds: attachments,
            });
        }}
      >
        <div className="workspace-composer-shell">
          {reply && (
            <div className="workspace-composer-context">
              <span>
                {t("workspaceReplying")} ·{" "}
                {messages.find((m) => m.id === reply)?.body.slice(0, 80)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("cancel")}
                title={t("cancel")}
                onClick={() => setReply(undefined)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          )}
          {params.get("sourceVersion") &&
            !attachments.includes(params.get("sourceVersion")!) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setAttachments([...attachments, params.get("sourceVersion")!])
                }
              >
                {t("workspaceAttachRevision")}
              </Button>
            )}
          {attachments.length > 0 && (
            <div className="workspace-composer-attachments">
              {attachments.map((source) => (
                <Attachment key={source}>
                  <AttachmentContent>
                    <AttachmentTitle>
                      {t("source")} · {source}
                    </AttachmentTitle>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("removeSource")}
                      title={t("removeSource")}
                      onClick={() =>
                        setAttachments(
                          attachments.filter((id) => id !== source),
                        )
                      }
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </AttachmentContent>
                </Attachment>
              ))}
            </div>
          )}
          <div className="workspace-composer-input">
            <Textarea
              ref={composer}
              value={draft}
              required
              aria-label={t("message")}
              placeholder={t("workspaceUiComposerPlaceholder")}
              onChange={(e) => {
                draftDirty.current = true;
                setDraft(e.target.value);
              }}
              onBlur={() => {
                if (hydrated.current)
                  persistReader({ ...reader.current, composerDraft: draft });
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </div>
          <div className="workspace-composer-controls">
            <AgentEffortControl
              enabled
              presets={readiness.data?.supervisor?.presets}
              value={selectedEffort}
              onChange={setEffort}
            />
            <span
              className={`workspace-composer-status text-ui-xs${save.error ? " workspace-composer-error" : " muted"}`}
              aria-live={save.error ? "assertive" : "polite"}
            >
              {save.error
                ? t("workspaceDraftError")
                : save.isPending
                  ? t("workspaceSaving")
                  : ""}
            </span>
            {activeSupervisorRun && !draft.trim() ? (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="workspace-send-button"
                aria-label={t("workspaceStop")}
                title={t("workspaceStop")}
                disabled={stopRun.isPending}
                onClick={() => stopRun.mutate()}
              >
                <Square aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="workspace-send-button"
                aria-label={t("workspaceUiSendMessage")}
                title={t("workspaceUiSendShortcut")}
                disabled={send.isPending || !draft.trim()}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
        {readiness.error && (
          <Callout tone="error">{readiness.error.message}</Callout>
        )}
        {readiness.data && !readiness.data.executionAvailable && (
          <Callout tone="error">
            {send.isSuccess && <p>{t("workspaceMessageSavedNoReply")}</p>}
            {t("workspaceNoExecution")}{" "}
            <Link className="underline underline-offset-2" to="/settings">
              {t("aiConnections")}
            </Link>
          </Callout>
        )}
        {startRun.error && (
          <Callout tone="error">
            {startRun.error.message}
            <Button
              type="button"
              variant="link"
              onClick={() =>
                startRun.mutate({
                  goal: send.variables?.body || draft,
                  sourceVersionIds:
                    send.variables?.sourceVersionIds || attachments,
                  messageId: send.data?.id,
                  effort: selectedEffort,
                })
              }
            >
              {t("retry")}
            </Button>
          </Callout>
        )}
        {steer.error &&
          (!(steer.error instanceof ApiError) ||
            steer.error.status !== 409) && (
            <Callout tone="error">{steer.error.message}</Callout>
          )}
        {stopRun.error && (
          <Callout tone="error">{stopRun.error.message}</Callout>
        )}
        {send.error && <Callout tone="error">{send.error.message}</Callout>}
      </form>
    </div>
  );
}
const MessageRow = memo(function MessageRow({
  message,
  projectId,
  conversationId,
  reviewRun,
  onReply,
  onInput,
}: {
  message: WorkspaceMessage;
  projectId: string;
  conversationId: string;
  reviewRun?: RecordData;
  onReply: (id: string) => void;
  onInput: (body: string) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  const role =
    message.actorKind || message.role || message.authorType || "user";
  const link = `/projects/${projectId}?conversation=${conversationId}&message=${message.id}`;
  const session = queryClient.getQueryData<RecordData>(["/auth/me"]);
  const currentUserId = session?.user?.id || session?.id;
  const author =
    role === "agent" || role === "assistant"
      ? t("agent")
      : message.authorId && message.authorId === currentUserId
        ? t("yourself")
        : message.authorName || t("teamMember");
  const isOwnMessage =
    role === "user" &&
    Boolean(message.authorId && message.authorId === currentUserId);
  if (role === "system")
    return (
      <Marker>
        <MarkerContent>{message.body}</MarkerContent>
      </Marker>
    );
  return (
    <Message align={isOwnMessage ? "end" : "start"}>
      <MessageContent>
        {!isOwnMessage && role !== "agent" && role !== "assistant" && (
          <MessageHeader>
            {message.id.startsWith("run-") ? (
              author
            ) : (
              <Link to={link}>{author}</Link>
            )}
          </MessageHeader>
        )}
        <Bubble
          variant={role === "user" ? "muted" : "ghost"}
          className="max-w-full"
        >
          <BubbleContent
            className={
              role === "agent" || role === "assistant"
                ? undefined
                : "preserve-lines"
            }
          >
            {role === "agent" || role === "assistant" ? (
              <ChatMarkdown>{message.body}</ChatMarkdown>
            ) : (
              message.body
            )}
          </BubbleContent>
        </Bubble>
        {(message.openui || message.metadata?.openui) && (
          <Suspense fallback={<span>{t("loading")}</span>}>
            <ProjectOpenUI
              projectId={projectId}
              conversationId={conversationId}
              response={message.openui || message.metadata?.openui || ""}
              onReply={onInput}
            />
          </Suspense>
        )}
        {message.annotation && (
          <blockquote className="message-annotation">
            <BadgeLabel page={message.annotation.page} />
            {message.annotation.quote && <p>{message.annotation.quote}</p>}
            {message.annotation.artifactId && (
              <Link
                to={`/projects/${projectId}?panel=artifacts&artifact=${message.annotation.artifactId}&revision=${message.annotation.artifactRevisionId}`}
              >
                {t("workspaceArtifacts")}
              </Link>
            )}
          </blockquote>
        )}
        {message.sourceVersionIds?.map((id) => (
          <Attachment key={id}>
            <AttachmentContent>
              <AttachmentTitle>
                <Link
                  to={`/projects/${projectId}?conversation=${conversationId}&sourceVersion=${id}${message.annotation?.page ? `&page=${message.annotation.page}` : ""}`}
                >
                  {t("source")} · {id}
                </Link>
              </AttachmentTitle>
            </AttachmentContent>
          </Attachment>
        ))}
        {reviewRun &&
          !/^root\s*=\s*(?:ArtifactPreview|ArtifactPdf)\(/.test(
            message.openui || message.metadata?.openui || "",
          ) && (
            <Link
              className="workspace-review-result"
              to={`/projects/${projectId}?conversation=${conversationId}&agentRun=${reviewRun.id}`}
            >
              {t("workspaceUiReviewResult")}
            </Link>
          )}
        <MessageFooter>
          {isOwnMessage && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t(
                copied ? "workspaceMessageCopied" : "workspaceCopyMessage",
              )}
              title={t(
                copied ? "workspaceMessageCopied" : "workspaceCopyMessage",
              )}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(message.body);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? (
                <Check className="size-icon-sm" aria-hidden="true" />
              ) : (
                <Copy className="size-icon-sm" aria-hidden="true" />
              )}
            </Button>
          )}
          {!message.id.startsWith("run-") && (
            <>
              <Button variant="ghost" onClick={() => onReply(message.id)}>
                {t("workspaceReply")}
              </Button>
              <Button variant="ghost" asChild>
                <Link to={link}>{t("workspaceMessageLink")}</Link>
              </Button>
            </>
          )}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
});

function BadgeLabel({ page }: { page?: number }) {
  const t = useT();
  return (
    <span className="text-ui-xs muted">
      {t("workspaceAnnotation")}
      {page ? ` · ${t("workspacePageNumber")} ${page}` : ""}
    </span>
  );
}
