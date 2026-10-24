import { useState } from "react";
import { ArrowUp, MessageSquarePlus } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  SupportConversation as Conversation,
  SupportMessage,
  SupportOverview as Overview,
  SupportProposal as Proposal,
  SupportReport as Report,
} from "@richtfest/shared";
import { api, ApiError } from "../api";
import { useApi } from "../query";
import { registerMessages, useT } from "../i18n";
import en from "../components/help-locales/en.json";
import de from "../components/help-locales/de.json";
import { Page, PageHeader, Section } from "../components/layout";
import {
  Badge,
  Callout,
  Field,
  Modal,
  RowLink,
  Segmented,
  Table,
} from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { NativeSelect } from "../components/ui/native-select";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "../components/ui/message";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { ChatMarkdown } from "../components/chat-markdown";
import { Marker, MarkerContent } from "../components/ui/marker";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "../components/ui/message-scroller";

import { LazyOpenUI } from "../components/project-workspace/lazy-openui";
import { buildProjectViewPath } from "@richtfest/shared/project-view-context";
import "../components/help-overlay.css";
registerMessages({ en, de });
type Kind = "bug" | "feature" | "feedback";
type Status = "open" | "in_progress" | "resolved";
const supportQuery = {
  queryKey: ["/support"],
  queryFn: () => api<Overview>("/support"),
  staleTime: 30_000,
};
const statusKeys = {
  open: "helpOpen",
  in_progress: "helpInProgress",
  resolved: "helpResolved",
} as const;
const messageStatusKeys = {
  pending: "helpPending",
  failed: "helpFailed",
  unconfigured: "helpUnconfigured",
  completed: "helpCompleted",
} as const;
function ErrorState({
  error,
  retry,
}: {
  error: Error | null;
  retry?: () => void;
}) {
  const t = useT();
  return error ? (
    <Callout tone="error">
      {error.message}{" "}
      {retry && (
        <Button variant="outline" onClick={retry}>
          {t("retry")}
        </Button>
      )}
    </Callout>
  ) : null;
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function Help({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const location = useLocation();
  const [params, setSearchParams] = useSearchParams();
  const conversationKey = embedded ? "helpConversation" : "conversation";
  const overview = useQuery(supportQuery);
  const conversationId =
    params.get(conversationKey) || overview.data?.conversations[0]?.id || null;
  const reportId = params.get("report");
  const reportsView =
    !embedded && (!!reportId || params.get("tab") === "reports");
  const projectId = /^\/projects\/([0-9a-f-]{36})$/i.exec(
    location.pathname,
  )?.[1];
  const pagePath = projectId
    ? buildProjectViewPath(projectId, params)
    : location.pathname;
  const [saved, setSaved] = useState<Report | null>(null);
  const [editor, setEditor] = useState<{
    proposal?: Proposal;
    messageId?: string;
  } | null>(null);
  const Container = embedded ? "section" : Page;
  return (
    <Container
      className={embedded ? "help-embedded grid min-w-0 gap-stack" : undefined}
    >
      {(!embedded || location.pathname === "/") && (
        <PageHeader
          title={t(embedded ? "helpWelcome" : "help")}
          actions={
            <Button asChild variant="ghost">
              <Link to={reportsView ? "/help" : "/help?tab=reports"}>
                {t(reportsView ? "helpChat" : "helpReports")}
              </Link>
            </Button>
          }
        />
      )}
      <ErrorState
        error={overview.error}
        retry={() => void overview.refetch()}
      />
      {embedded && (
        <p className="text-ui-xs text-muted-foreground">{t("helpScope")}</p>
      )}
      {saved && (
        <Callout>
          <Link to={`/help?report=${saved.id}`}>
            {t("helpSavedReport")}: {saved.title}
          </Link>
        </Callout>
      )}
      {reportsView ? (
        <>
          <div className="flex flex-wrap items-center gap-stack text-ui-sm">
            <Button variant="outline" onClick={() => setEditor({})}>
              {t("helpFileReport")}
            </Button>
            <Button asChild variant="ghost">
              <a href="/api/support/reports" target="_blank" rel="noreferrer">
                {t("helpExport")}
              </a>
            </Button>
          </div>
          <Reports
            reportId={reportId}
            canManage={overview.data?.canManage === true}
          />
        </>
      ) : (
        <div className="help-conversation mx-auto flex w-full min-w-0 max-w-3xl flex-col justify-center gap-stack min-[701px]:flex-1">
          {overview.data &&
            (!overview.data.readiness.configured ||
              !overview.data.readiness.canRun) && (
              <Callout>
                {overview.data.readiness.canRun
                  ? t("helpUnconfigured")
                  : t("helpNoPermission")}{" "}
                {overview.data.readiness.canRun && (
                  <Link to="/settings">{t("helpSettings")}</Link>
                )}
              </Callout>
            )}
          <SupportChat
            key={conversationId || "new"}
            id={conversationId}
            pagePath={pagePath}
            projectId={projectId}
            canRun={
              overview.isSuccess &&
              overview.data?.readiness.configured === true &&
              overview.data.readiness.canRun
            }
            onCreated={(id) => {
              const next = new URLSearchParams(embedded ? params : undefined);
              next.set(conversationKey, id);
              setSearchParams(next, { replace: true });
            }}
            onProposal={(proposal, messageId) =>
              setEditor({ proposal, messageId })
            }
            onFileReport={() => setEditor({})}
          />
        </div>
      )}
      {editor && (
        <ReportForm
          proposal={editor.proposal}
          pagePath={pagePath.length <= 500 ? pagePath : location.pathname}
          messageId={editor.messageId}
          onClose={() => setEditor(null)}
          onSaved={(report) => {
            setEditor(null);
            if (embedded) {
              setSaved(report);
              return;
            }
            const next = new URLSearchParams(params);
            next.delete("conversation");
            next.set("report", report.id);
            setSearchParams(next);
          }}
        />
      )}
    </Container>
  );
}

function SupportChat({
  id,
  pagePath,
  projectId,
  canRun,
  onCreated,
  onProposal,
  onFileReport,
}: {
  id: string | null;
  pagePath: string;
  projectId?: string;
  canRun: boolean;
  onCreated: (id: string) => void;
  onProposal: (proposal: Proposal, messageId: string) => void;
  onFileReport: () => void;
}) {
  const t = useT(),
    client = useQueryClient();
  const [newId] = useState(() => crypto.randomUUID());
  const path = `/support/conversations/${id || newId}`;
  const conversation = useQuery({
    queryKey: [path],
    enabled: !!id,
    queryFn: () =>
      api<{ conversation: Conversation; messages: SupportMessage[] }>(path),
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data?.messages.some((m) => m.status === "pending")
        ? 3000
        : false,
  });
  const [body, setBody] = useState("");
  const [request, setRequest] = useState<{ id: string; body: string } | null>(
    null,
  );
  const send = useMutation({
    mutationFn: async (input: { id: string; body: string }) => {
      if (!id) await api<Conversation>("/support/conversations", { id: newId });
      return api<{ message: SupportMessage }>(`${path}/messages`, input);
    },
    onSuccess: () => {
      setBody("");
      setRequest(null);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: [path] });
      void client.invalidateQueries({ queryKey: ["/support"] });
    },
  });
  const onSent = () => {
    if (!id) onCreated(newId);
  };
  const submit = (text: string) => {
    if (send.isPending || request || !canRun || !text.trim()) return;
    const input = {
      id: crypto.randomUUID(),
      body: text.trim(),
      pagePath,
      projectId,
    };
    setRequest(input);
    send.mutate(input, { onSuccess: onSent });
  };
  const messages = conversation.data?.messages || [];
  const started = !!id || !!request;
  return (
    <section
      aria-label={t("helpChat")}
      className="help-chat flex min-h-0 min-w-0 flex-col gap-stack"
    >
      {!started && (
        <div className="flex flex-wrap gap-stack">
          {(
            [
              "helpExampleConcept",
              "helpExampleFeature",
              "helpExampleFeedback",
            ] as const
          ).map((key) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant="outline"
              className="h-auto whitespace-normal py-stack text-left"
              disabled={!!request}
              onClick={() => setBody(t(key))}
            >
              {t(key)}
            </Button>
          ))}
        </div>
      )}
      <ErrorState
        error={conversation.error}
        retry={() => void conversation.refetch()}
      />
      {started && (
        <MessageScrollerProvider
          key={id || newId}
          autoScroll={send.isPending}
          defaultScrollPosition="last-anchor"
        >
          <MessageScroller className="h-[clamp(12rem,calc(100dvh-32rem),40rem)] min-[701px]:h-[clamp(12rem,calc(100dvh-29rem),40rem)]">
            <MessageScrollerViewport>
              <MessageScrollerContent className="gap-stack p-2">
                {id && conversation.isPending && (
                  <Marker>
                    <MarkerContent>{t("loading")}</MarkerContent>
                  </Marker>
                )}
                {!conversation.isPending && !messages.length && (
                  <Marker>
                    <MarkerContent>{t("noMessages")}</MarkerContent>
                  </Marker>
                )}
                {messages.map((message) => (
                  <MessageScrollerItem key={message.id}>
                    <Message align={message.role === "user" ? "end" : "start"}>
                      <MessageContent>
                        <MessageHeader>
                          {message.role === "user"
                            ? t("helpYou")
                            : t("helpAssistant")}
                        </MessageHeader>
                        <Bubble
                          variant={message.role === "user" ? "muted" : "ghost"}
                        >
                          <BubbleContent
                            className={
                              message.role === "user"
                                ? "whitespace-pre-wrap"
                                : undefined
                            }
                          >
                            {message.role === "user" ? (
                              message.body
                            ) : (
                              <ChatMarkdown>{message.body}</ChatMarkdown>
                            )}
                          </BubbleContent>
                        </Bubble>
                        {message.status !== "completed" && (
                          <Marker>
                            <MarkerContent>
                              {t(messageStatusKeys[message.status])}
                            </MarkerContent>
                          </Marker>
                        )}
                        {message.openui && (
                          <LazyOpenUI
                            projectId=""
                            response={message.openui}
                            onReply={canRun && !request ? submit : undefined}
                          />
                        )}
                        {!!message.sources?.length && (
                          <div className="flex flex-wrap gap-stack text-ui-xs text-muted-foreground">
                            {message.sources
                              .filter(
                                (source) => !source.path.startsWith("/docs/"),
                              )
                              .map((source, index) => (
                                <Link
                                  key={`${source.path}:${index}`}
                                  to={source.path}
                                >
                                  {source.title} ↗
                                </Link>
                              ))}
                            {message.sources.some((source) =>
                              source.path.startsWith("/docs/"),
                            ) && (
                              <details className="w-full">
                                <summary className="cursor-pointer">
                                  {t("docs")}
                                </summary>
                                <div className="flex flex-wrap gap-stack py-stack">
                                  {message.sources
                                    .filter((source) =>
                                      source.path.startsWith("/docs/"),
                                    )
                                    .map((source, index) => (
                                      <a
                                        key={`${source.path}:${index}`}
                                        href={source.path}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {source.title}
                                      </a>
                                    ))}
                                </div>
                              </details>
                            )}
                          </div>
                        )}
                        {message.reportId ? (
                          <Link to={`/help?report=${message.reportId}`}>
                            {t("helpSavedReport")}: {message.reportId}
                          </Link>
                        ) : (
                          message.proposal && (
                            <Button
                              variant="outline"
                              className="self-start"
                              onClick={() =>
                                onProposal(message.proposal!, message.id)
                              }
                            >
                              {t("helpReviewProposal")}
                            </Button>
                          )
                        )}
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}
                {request &&
                  !messages.some((message) => message.id === request.id) && (
                    <MessageScrollerItem>
                      <Message align="end">
                        <MessageContent>
                          <Bubble variant="muted">
                            <BubbleContent className="whitespace-pre-wrap">
                              {request.body}
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  )}
                {send.isPending && (
                  <MessageScrollerItem>
                    <Marker>
                      <MarkerContent>{t("helpWorking")}</MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton aria-label={t("helpLatest")} />
          </MessageScroller>
        </MessageScrollerProvider>
      )}
      <ErrorState error={send.error} />
      {send.isError && request && (
        <div className="flex flex-wrap gap-stack">
          <p className="text-ui-sm">{t("helpRetryHint")}</p>
          <Button
            variant="outline"
            onClick={() => send.mutate(request, { onSuccess: onSent })}
          >
            {t("retry")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setRequest(null);
              setBody("");
              send.reset();
            }}
          >
            {t("helpNewMessage")}
          </Button>
        </div>
      )}
      <form
        className="workspace-composer-shell shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          submit(body);
        }}
      >
        <div className="workspace-composer-input">
          <Textarea
            aria-label={t("helpMessage")}
            placeholder={t("helpPlaceholder")}
            rows={1}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit(body);
              }
            }}
            disabled={!canRun || !!request}
            maxLength={12000}
            required
          />
        </div>
        <div className="workspace-composer-controls">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("helpFileReport")}
            title={t("helpFileReport")}
            onClick={onFileReport}
          >
            <MessageSquarePlus aria-hidden="true" />
          </Button>
          <span className="flex-1" />
          <Button
            type="submit"
            size="icon"
            aria-label={t("helpSend")}
            title={t("helpSend")}
            disabled={!canRun || !!request || !body.trim()}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
      </form>
    </section>
  );
}

function ReportForm({
  proposal,
  pagePath,
  messageId,
  onClose,
  onSaved,
}: {
  proposal?: Proposal;
  pagePath: string;
  messageId?: string;
  onClose: () => void;
  onSaved: (report: Report) => void;
}) {
  const t = useT(),
    client = useQueryClient();
  const [id] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<Proposal>(
    proposal || { kind: "feedback", title: "", description: "", pagePath },
  );
  const [submitted, setSubmitted] = useState<Proposal | null>(null);
  const save = useMutation({
    mutationFn: (input: Proposal) =>
      api<Report>("/support/reports", {
        ...input,
        id,
        messageId,
        pagePath: input.pagePath || null,
      }),
    onSuccess: (report) => {
      client.setQueryData([`/support/reports/${report.id}`], report);
      void client.invalidateQueries({
        predicate: (query) => String(query.queryKey[0]).startsWith("/support"),
      });
      onSaved(report);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 400) setSubmitted(null);
    },
  });
  const locked = !!submitted;
  return (
    <Modal
      title={proposal ? t("helpReviewProposal") : t("helpFileReport")}
      onClose={onClose}
    >
      <form
        className="grid gap-stack"
        onSubmit={(e) => {
          e.preventDefault();
          const input = submitted || {
            ...draft,
            title:
              draft.title.trim() ||
              draft.description.trim().split("\n")[0].slice(0, 200),
            description: draft.description.trim(),
          };
          setSubmitted(input);
          save.mutate(input);
        }}
      >
        <Callout>{t("helpExplicitSubmit")}</Callout>
        <Field label={t("helpKind")}>
          <NativeSelect
            value={draft.kind}
            disabled={locked}
            onChange={(event) =>
              setDraft({ ...draft, kind: event.target.value as Kind })
            }
          >
            <option value="feedback">{t("helpFeedback")}</option>
            <option value="bug">{t("helpBug")}</option>
            <option value="feature">{t("helpFeature")}</option>
          </NativeSelect>
        </Field>
        <Field label={t("helpTitle")}>
          <Input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder={
              draft.description.trim().split("\n")[0].slice(0, 200) ||
              t("helpGeneratedTitle")
            }
            maxLength={200}
            disabled={locked}
          />
        </Field>
        <Field label={t("helpDescription")}>
          <Textarea
            className="text-ui-sm md:text-ui-sm"
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
            required
            maxLength={12000}
            disabled={locked}
          />
        </Field>
        <Field label={t("helpPagePath")}>
          <Input
            value={draft.pagePath || ""}
            onChange={(e) => setDraft({ ...draft, pagePath: e.target.value })}
            placeholder="/projects"
            maxLength={500}
            disabled={locked}
          />
        </Field>
        <ErrorState error={save.error} />
        {save.isError && (
          <p className="text-ui-sm">{t("helpReportRetryHint")}</p>
        )}
        <Button disabled={save.isPending || !draft.description.trim()}>
          {save.isPending
            ? t("saving")
            : save.isError
              ? t("retry")
              : t("helpSubmitReport")}
        </Button>
      </form>
    </Modal>
  );
}

function Reports({
  reportId,
  canManage,
}: {
  reportId: string | null;
  canManage: boolean;
}) {
  const t = useT();
  const [kind, setKind] = useState("all"),
    [status, setStatus] = useState("all");
  const filter = new URLSearchParams();
  if (kind !== "all") filter.set("kind", kind);
  if (status !== "all") filter.set("status", status);
  const path = `/support/reports?${filter}`;
  const reports = useInfiniteQuery({
    queryKey: [path],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<{ items: Report[]; nextCursor: string | null }>(
        `${path}${pageParam ? `${filter.size ? "&" : ""}cursor=${pageParam}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
  });
  return (
    <div className="grid grid-cols-1 gap-section [&>.section]:min-w-0 [&_.section-heading]:break-words">
      <Section title={canManage ? t("helpTenantReports") : t("helpOwnReports")}>
        <div className="flex flex-wrap gap-stack [&>.field]:min-w-0 [&>.field]:max-w-full">
          <Field label={t("helpKind")}>
            <Segmented
              value={kind}
              onChange={setKind}
              items={[
                { value: "all", label: t("helpAll") },
                { value: "bug", label: t("helpBug") },
                { value: "feature", label: t("helpFeature") },
                { value: "feedback", label: t("helpFeedback") },
              ]}
            />
          </Field>
          <Field label={t("status")}>
            <Segmented
              value={status}
              onChange={setStatus}
              items={[
                { value: "all", label: t("helpAll") },
                ...(["open", "in_progress", "resolved"] as Status[]).map(
                  (value) => ({ value, label: t(statusKeys[value]) }),
                ),
              ]}
            />
          </Field>
        </div>
        <ErrorState
          error={reports.error}
          retry={() => void reports.refetch()}
        />
        {reports.isPending ? (
          <p role="status">{t("loading")}</p>
        ) : (
          <Table
            headers={[t("title"), t("helpKind"), t("status"), t("helpCreated")]}
            rows={(reports.data?.pages.flatMap((page) => page.items) || []).map(
              (report) => ({
                id: report.id,
                sort: [
                  report.title,
                  report.kind,
                  report.status,
                  report.createdAt,
                ],
                cells: [
                  <RowLink to={`/help?report=${report.id}`}>
                    {report.title}
                  </RowLink>,
                  t(
                    report.kind === "bug"
                      ? "helpBug"
                      : report.kind === "feature"
                        ? "helpFeature"
                        : "helpFeedback",
                  ),
                  <Badge>{t(statusKeys[report.status])}</Badge>,
                  dateLabel(report.createdAt),
                ],
              }),
            )}
          />
        )}
        {reports.data?.pages[0].items.length === 0 && (
          <p className="text-ui-sm text-muted-foreground">
            {t("helpNoReports")}
          </p>
        )}
        {reports.hasNextPage && (
          <Button
            variant="outline"
            disabled={reports.isFetchingNextPage}
            onClick={() => void reports.fetchNextPage()}
          >
            {t("helpLoadMore")}
          </Button>
        )}
      </Section>
      {reportId && (
        <ReportDetail key={reportId} id={reportId} canManage={canManage} />
      )}
    </div>
  );
}

function ReportDetail({ id, canManage }: { id: string; canManage: boolean }) {
  const t = useT(),
    client = useQueryClient(),
    path = `/support/reports/${id}`;
  const session = useApi("/auth/me");
  const report = useQuery({
    queryKey: [path],
    queryFn: () => api<Report>(path),
  });
  const update = useMutation({
    mutationFn: (status: Status) => api<Report>(path, { status }, "PATCH"),
    onSuccess: (value) => {
      client.setQueryData([path], value);
      void client.invalidateQueries({
        predicate: (query) =>
          String(query.queryKey[0]).startsWith("/support/reports?"),
      });
    },
  });
  const value = report.data;
  return (
    <Section title={value?.title || t("helpReportDetail")}>
      <ErrorState error={report.error} retry={() => void report.refetch()} />
      {report.isPending && <p role="status">{t("loading")}</p>}
      {value && (
        <div className="grid grid-cols-1 gap-stack break-words text-ui-sm">
          <Callout>
            <Link to={`/help?report=${value.id}`}>
              {t("helpSavedReport")}: {value.id}
            </Link>
          </Callout>
          <div className="flex flex-wrap items-center gap-stack">
            <Badge>
              {t(
                value.kind === "bug"
                  ? "helpBug"
                  : value.kind === "feature"
                    ? "helpFeature"
                    : "helpFeedback",
              )}
            </Badge>
            <Badge>{t(statusKeys[value.status])}</Badge>
            <span>{dateLabel(value.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap">{value.description}</p>
          {value.pagePath && (
            <p>
              {t("helpPage")}:{" "}
              {value.pagePath.startsWith("/") &&
              !value.pagePath.startsWith("//") &&
              !value.pagePath.includes("\\") ? (
                <Link to={value.pagePath}>{value.pagePath}</Link>
              ) : (
                value.pagePath
              )}
            </p>
          )}
          {value.conversationId && value.createdBy === session.data?.id && (
            <Link to={`/help?conversation=${value.conversationId}`}>
              {t("helpOpenConversation")}
            </Link>
          )}
          {canManage && (
            <div className="flex flex-wrap gap-stack">
              {(["open", "in_progress", "resolved"] as Status[]).map(
                (status) => (
                  <Button
                    key={status}
                    variant="outline"
                    disabled={update.isPending || status === value.status}
                    onClick={() => update.mutate(status)}
                  >
                    {t(statusKeys[status])}
                  </Button>
                ),
              )}
            </div>
          )}
          <ErrorState error={update.error} />
        </div>
      )}
    </Section>
  );
}
