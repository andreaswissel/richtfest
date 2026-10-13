import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api, list, type RecordData } from "../api";
import { queryClient, useApi } from "../query";
import { useT } from "../i18n";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Badge, Callout } from "../components/ui/primitives";
import { ChatMarkdown } from "../components/chat-markdown";
import { Message, MessageContent } from "../components/ui/message";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { Marker, MarkerContent } from "../components/ui/marker";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "../components/ui/message-scroller";

export function CompanyKnowledgeChat({
  category,
  status,
  categories,
  children,
  onActive,
}: {
  category: string;
  status: string;
  categories: RecordData[];
  children: ReactNode;
  onActive: (active: boolean) => void;
}) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const searchId = params.get("searchId");
  const history = useApi("/knowledge/searches");
  const saved = useApi(`/knowledge/searches/${searchId}`, !!searchId);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<{
    question: string;
    category: string;
    status: string;
    resultId?: string;
  } | null>(null);
  const [previousDetail, setPreviousDetail] = useState<RecordData | null>(null);
  const submitting = useRef(false);
  const composing = useRef(false);
  const active = !!searchId || !!pending;
  useEffect(() => onActive(active), [active, onActive]);
  const detail = saved.data ?? (pending ? previousDetail : null);
  const turns: RecordData[] = detail
    ? Array.isArray(detail.turns) && detail.turns.length
      ? detail.turns
      : [detail]
    : [];
  const last = turns.at(-1);
  const scope = last?.filters ?? pending ?? { category, status };
  const running = last?.status === "running";
  const write = useMutation({
    retry: false,
    mutationFn: (body: RecordData) => api("/knowledge/searches", body),
    onSuccess: (result) => {
      // A POST is one turn, not a complete conversation detail.
      void queryClient.invalidateQueries({
        queryKey: [`/knowledge/searches/${result.id}`],
      });
      void queryClient.invalidateQueries({ queryKey: ["/knowledge/searches"] });
      setPending((turn) => (turn ? { ...turn, resultId: result.id } : null));
      setParams({
        category: result.filters.category,
        status: result.filters.status,
        searchId: result.id,
      });
      setQuestion("");
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  useEffect(() => {
    if (saved.data) setPreviousDetail(saved.data);
    if (
      pending?.resultId &&
      saved.data?.id === pending.resultId &&
      !saved.isFetching
    )
      setPending(null);
  }, [saved.data, saved.isFetching, pending?.resultId]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void saved.refetch(), 2000);
    return () => clearInterval(timer);
  }, [running, saved.refetch]);
  const terminal = last?.status === "completed" || last?.status === "failed";
  const canSend =
    !!history.data?.canAsk &&
    !!history.data?.configured &&
    !write.isPending &&
    !running &&
    (!searchId || terminal) &&
    turns.length < 20 &&
    !pending;
  const submit = () => {
    if (!canSend || !question.trim() || submitting.current) return;
    submitting.current = true;
    const turn = {
      question: question.trim(),
      category: scope.category,
      status: scope.status,
    };
    setPending(turn); // Switch the library to a conversation before the network request.
    write.mutate({ ...turn, ...(last ? { parentSearchId: last.id } : {}) });
  };
  const reset = () => {
    if (write.isPending) return;
    setPending(null);
    setPreviousDetail(null);
    setQuestion("");
    write.reset();
    const next = new URLSearchParams(params);
    next.delete("searchId");
    next.delete("view");
    setParams(next);
  };
  const composer = (
    <form
      className="knowledge-composer flex items-end gap-stack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label={t("knowledgeQuestion")}
        rows={1}
        maxLength={1000}
        value={question}
        placeholder={t(
          active ? "knowledgeFollowUp" : "knowledgeQuestionExample",
        )}
        className="min-h-control resize-none text-ui-sm md:text-ui-sm"
        disabled={!canSend}
        onChange={(e) => setQuestion(e.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            !composing.current &&
            e.keyCode !== 229
          ) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button disabled={!canSend || !question.trim()}>
        {t("knowledgeSearchAction")}
      </Button>
    </form>
  );
  const renderTurn = (turn: RecordData) => (
    <MessageScrollerItem key={turn.id}>
      <Message align="end">
        <MessageContent>
          <Bubble variant="muted">
            <BubbleContent className="whitespace-pre-wrap">
              {turn.question}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <Message className="mt-3">
        <MessageContent className="min-w-0 w-full">
          <Bubble variant="ghost">
            <BubbleContent>
              {turn.status === "running" ? (
                <Marker>
                  <MarkerContent>{t("knowledgeSearching")}</MarkerContent>
                </Marker>
              ) : turn.status !== "completed" ? (
                <Callout tone="error">{t("knowledgeSearchFailed")}</Callout>
              ) : !turn.answer ? (
                <p>{t("knowledgeNoEvidence")}</p>
              ) : (
                <>
                  <ChatMarkdown>{turn.answer}</ChatMarkdown>
                  <div className="mt-3 flex flex-col gap-stack">
                    {list(turn, "citations").map((c, i) => (
                      <div key={`${c.id}:${i}`} className="border-l-2 pl-3">
                        <div className="flex flex-wrap items-center gap-stack">
                          <Link
                            className="underline underline-offset-4"
                            to={`/knowledge/${c.id}?${params}`}
                          >
                            {c.displayTitle ?? c.title}
                          </Link>
                          <Badge
                            tone={
                              c.status === "approved" ? "success" : "neutral"
                            }
                          >
                            {t(c.status === "approved" ? "approved" : "draft")}
                          </Badge>
                        </div>
                        <blockquote className="whitespace-pre-wrap text-ui-sm text-muted-foreground">
                          {c.quote}
                        </blockquote>
                      </div>
                    ))}
                    <p className="text-ui-xs text-muted-foreground">
                      {t("knowledgeCitationHint")}
                    </p>
                  </div>
                </>
              )}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
  return (
    <div className="flex min-w-0 flex-col gap-stack">
      {!active && composer}
      {!history.data?.canAsk && history.data ? (
        <p className="text-ui-xs text-muted-foreground">
          {t("knowledgeSearchPermission")}
        </p>
      ) : history.data && !history.data.configured ? (
        <p className="text-ui-xs text-muted-foreground">
          {t("knowledgeSearchUnconfigured")}
        </p>
      ) : null}
      {history.error && <Callout tone="error">{history.error.message}</Callout>}
      {!active ? (
        children
      ) : (
        <div className="knowledge-conversation flex min-w-0 flex-col gap-stack">
          <div className="flex flex-wrap items-center justify-between gap-stack">
            <span className="text-ui-xs text-muted-foreground">
              {t("knowledgeSavedScope")}:{" "}
              {categories.find((c) => c.id === scope.category)?.name ??
                t(
                  scope.category === "_none"
                    ? "knowledgeUnfiled"
                    : "knowledgeAllEntries",
                )}{" "}
              ·{" "}
              {t(
                scope.status === "all"
                  ? "all"
                  : scope.status === "approved"
                    ? "approved"
                    : "draft",
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={reset}
              disabled={write.isPending}
            >
              {t("knowledgeBackLibrary")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={reset}
              disabled={write.isPending}
            >
              {t("knowledgeNewChat")}
            </Button>
          </div>
          <MessageScrollerProvider
            key={turns[0]?.id ?? "pending"}
            autoScroll={write.isPending}
            defaultScrollPosition="last-anchor"
          >
            <MessageScroller className="knowledge-messages">
              <MessageScrollerViewport>
                <MessageScrollerContent className="gap-stack p-2">
                  {turns.map(renderTurn)}
                  {pending &&
                    (!pending.resultId || detail?.id !== pending.resultId) && (
                      <MessageScrollerItem>
                        <Message align="end">
                          <MessageContent>
                            <Bubble variant="muted">
                              <BubbleContent className="whitespace-pre-wrap">
                                {pending.question}
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                        <Message className="mt-3">
                          <MessageContent>
                            <Bubble variant="ghost">
                              <BubbleContent>
                                <Marker>
                                  <MarkerContent>
                                    {write.error
                                      ? t("knowledgeSearchFailed")
                                      : t("knowledgeSearching")}
                                  </MarkerContent>
                                </Marker>
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )}
                  {saved.isPending && searchId && !pending && (
                    <Marker>
                      <MarkerContent>{t("loading")}</MarkerContent>
                    </Marker>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton aria-label={t("knowledgeLatest")} />
            </MessageScroller>
          </MessageScrollerProvider>
          <div aria-live="polite">
            {write.error && (
              <Callout tone="error">{write.error.message}</Callout>
            )}
            {saved.error && (
              <Callout tone="error">{saved.error.message}</Callout>
            )}
          </div>
          {turns.length >= 20 && (
            <p className="text-ui-xs text-muted-foreground">
              {t("knowledgeTurnLimit")}
            </p>
          )}
          {composer}
        </div>
      )}
      {list(history.data).length > 0 && (
        <details className="text-ui-sm">
          <summary className="cursor-pointer">
            {t("knowledgeRecentPrivate")}
          </summary>
          <ul className="mt-2 flex flex-col gap-stack">
            {list(history.data).map((item) => (
              <li key={item.id}>
                <Link
                  onClick={(e) => {
                    if (write.isPending) e.preventDefault();
                    else {
                      setPending(null);
                      write.reset();
                    }
                  }}
                  className="underline underline-offset-4"
                  to={`/knowledge?${new URLSearchParams({ ...item.filters, searchId: item.id })}`}
                >
                  {item.question}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
