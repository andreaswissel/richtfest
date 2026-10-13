import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, list, type RecordData } from "../api";
import { ChatMarkdown } from "../components/chat-markdown";
import { Page, PageHeader, Section } from "../components/layout";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../components/ui/table";
import {
  Badge,
  Callout,
  Empty,
  Field,
  RowLink,
  Segmented,
  linkedRow,
} from "../components/ui/primitives";
import { useT } from "../i18n";
import { queryClient, useApi, useWrite } from "../query";
import { LoadState } from "./foundation";

export function CompanyKnowledge() {
  const { draftId } = useParams();
  return draftId ? (
    <CompanyDraft key={draftId} draftId={draftId} />
  ) : (
    <CompanyDrafts />
  );
}

function CompanyDrafts() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const category = params.get("category") || "all";
  const status = params.get("status") || "all";
  const search = params.get("q") || "";
  const page = Math.max(0, Number(params.get("page")) || 0);
  const ask = params.get("view") === "ask";
  const query = useApi(
    `/knowledge/library?${new URLSearchParams({ category, status, q: ask ? "" : search, page: String(ask ? 0 : page) })}`,
  );
  const data = query.data;
  const drafts = list(data);
  const categories = list(data, "categories");
  const [selected, setSelected] = useState<string[]>([]);
  const [destination, setDestination] = useState("_none");
  const selectionScope = `${category}:${status}:${search}:${page}:${ask}`;
  useEffect(() => setSelected([]), [selectionScope]);
  const move = useMutation({
    mutationFn: () =>
      api(
        "/knowledge/categories/assign",
        {
          draftIds: selected,
          categoryId: destination === "_none" ? null : destination,
        },
        "PATCH",
      ),
    onSuccess: () => {
      setSelected([]);
      void queryClient.invalidateQueries({
        queryKey: [],
        predicate: (q) =>
          String(q.queryKey[0]).startsWith("/knowledge/library?"),
      });
    },
  });
  const href = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    next.delete("page");
    next.delete("searchId");
    for (const [key, value] of Object.entries(changes)) next.set(key, value);
    return `/knowledge?${next}`;
  };
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.delete("page");
    next.delete("searchId");
    value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };
  const selectedCategory = categories.find((c) => c.id === category);
  return (
    <Page>
      <PageHeader
        title={t("companyKnowledge")}
        description={t("companyKnowledgeHint")}
      />
      <LoadState query={query} />
      <div className="grid min-w-0 gap-section md:grid-cols-[12rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-stack md:border-r md:pr-4">
          <h2 className="text-ui-sm font-medium">{t("knowledgeCategories")}</h2>
          <nav
            aria-label={t("knowledgeCategories")}
            className="flex flex-col gap-1"
          >
            {[
              {
                id: "all",
                name: t("knowledgeAllEntries"),
                count: data?.totalCount ?? 0,
              },
              {
                id: "_none",
                name: t("knowledgeUnfiled"),
                count: data?.unfiledCount ?? 0,
              },
              ...categories,
            ].map((c) => (
              <Link
                key={c.id}
                to={href({ category: c.id })}
                aria-current={category === c.id ? "page" : undefined}
                className={`flex min-h-control items-center justify-between gap-stack rounded-md px-2 py-cell text-ui-sm hover:bg-muted ${category === c.id ? "bg-muted font-medium" : "text-muted-foreground"}`}
              >
                <span className="break-words min-w-0">{c.name}</span>
                <span className="text-ui-xs tabular-nums">{c.count}</span>
              </Link>
            ))}
          </nav>
          {data?.canManage && <CategoryEditor />}
        </aside>
        <div className="flex min-w-0 flex-col gap-section">
          <div className="flex flex-wrap items-center justify-between gap-stack">
            <nav aria-label={t("companyKnowledge")} className="segmented">
              {[
                { view: "browse", label: t("knowledgeBrowse") },
                { view: "ask", label: t("knowledgeAsk") },
              ].map((v) => (
                <Button
                  key={v.view}
                  variant="ghost"
                  size="sm"
                  asChild
                  data-state={
                    ask === (v.view === "ask") ? "active" : "inactive"
                  }
                >
                  <Link
                    to={href({ view: v.view })}
                    aria-current={
                      ask === (v.view === "ask") ? "page" : undefined
                    }
                  >
                    {v.label}
                  </Link>
                </Button>
              ))}
            </nav>
            {data?.canManage && selectedCategory && (
              <CategoryEditor
                key={selectedCategory.id}
                category={selectedCategory as { id: string; name: string }}
              />
            )}
          </div>
          <div className="flex flex-wrap items-end gap-stack [&_.segmented]:self-end">
            {!ask && (
              <Field label={t("companyKnowledgeSearch")}>
                <Input
                  value={search}
                  maxLength={300}
                  onChange={(e) => setFilter("q", e.target.value)}
                />
              </Field>
            )}
            <Field label={t("status")}>
              <Segmented
                value={status}
                onChange={(v) => setFilter("status", v)}
                items={[
                  { value: "all", label: t("all") },
                  { value: "approved", label: t("approved") },
                  { value: "draft", label: t("draft") },
                ]}
              />
            </Field>
          </div>
          {ask ? (
            <KnowledgeSearch
              category={category}
              status={status}
              categories={categories}
            />
          ) : (
            data && (
              <>
                {selected.length > 0 && (
                  <form
                    className="flex flex-wrap items-end gap-stack"
                    onSubmit={(e) => {
                      e.preventDefault();
                      move.mutate();
                    }}
                  >
                    <span className="self-center text-ui-sm">
                      {selected.length} {t("knowledgeSelected")}
                    </span>
                    <Field label={t("knowledgeDestination")}>
                      <NativeSelect
                        value={destination}
                        onChange={(e) => setDestination(e.target.value)}
                        disabled={move.isPending}
                      >
                        <option value="_none">{t("knowledgeUnfiled")}</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Button disabled={move.isPending}>
                      {move.isPending ? t("loading") : t("knowledgeMove")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={move.isPending}
                      onClick={() => setSelected([])}
                    >
                      {t("cancel")}
                    </Button>
                  </form>
                )}
                {move.error && (
                  <Callout tone="error">{move.error.message}</Callout>
                )}
                <Section
                  title={`${selectedCategory?.name ?? t(category === "_none" ? "knowledgeUnfiled" : "companyKnowledgeEntries")} · ${data.total}`}
                >
                  {drafts.length ? (
                    <Table className="data-table [&_td]:whitespace-normal [&_.row-link]:break-words">
                      <TableHeader>
                        <TableRow>
                          {data.canManage && (
                            <TableHead style={{ width: "var(--control)" }}>
                              <Input
                                type="checkbox"
                                className="size-icon"
                                aria-label={t("knowledgeSelectPage")}
                                checked={drafts.every((d) =>
                                  selected.includes(d.id),
                                )}
                                disabled={move.isPending}
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? drafts.map((d) => d.id)
                                      : [],
                                  )
                                }
                              />
                            </TableHead>
                          )}
                          <TableHead>{t("title")}</TableHead>
                          <TableHead>{t("status")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {drafts.map((draft) => (
                          <TableRow key={draft.id} {...linkedRow}>
                            {data.canManage && (
                              <TableCell style={{ width: "var(--control)" }}>
                                <Input
                                  type="checkbox"
                                  className="relative z-10 size-icon"
                                  aria-label={`${t("knowledgeSelect")} ${draft.title}`}
                                  checked={selected.includes(draft.id)}
                                  disabled={move.isPending}
                                  onChange={(e) =>
                                    setSelected((ids) =>
                                      e.target.checked
                                        ? [...ids, draft.id]
                                        : ids.filter((id) => id !== draft.id),
                                    )
                                  }
                                />
                              </TableCell>
                            )}
                            <TableCell>
                              <RowLink to={`/knowledge/${draft.id}?${params}`}>
                                {draft.title}
                              </RowLink>
                            </TableCell>
                            <TableCell>
                              <Badge
                                tone={
                                  draft.status === "approved"
                                    ? "success"
                                    : "neutral"
                                }
                              >
                                {draft.status === "approved"
                                  ? t("approved")
                                  : t("draft")}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Empty>{t("companyKnowledgeEmpty")}</Empty>
                  )}
                  <div className="flex items-center justify-end gap-stack text-ui-sm">
                    {page > 0 && (
                      <Button variant="outline" size="sm" asChild>
                        <Link to={href({ page: String(page - 1) })}>
                          {t("knowledgePrevious")}
                        </Link>
                      </Button>
                    )}
                    <span>
                      {t("knowledgePage")} {page + 1} /{" "}
                      {Math.max(1, Math.ceil(data.total / data.pageSize))}
                    </span>
                    {(page + 1) * data.pageSize < data.total && (
                      <Button variant="outline" size="sm" asChild>
                        <Link to={href({ page: String(page + 1) })}>
                          {t("knowledgeNext")}
                        </Link>
                      </Button>
                    )}
                  </div>
                </Section>
              </>
            )
          )}
        </div>
      </div>
    </Page>
  );
}

function CategoryEditor({
  category,
}: {
  category?: { id: string; name: string };
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(category?.name ?? "");
  const write = useMutation({
    mutationFn: () =>
      api(
        category
          ? `/knowledge/categories/${category.id}`
          : "/knowledge/categories",
        { name },
        category ? "PATCH" : "POST",
      ),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({
        predicate: (q) =>
          String(q.queryKey[0]).startsWith("/knowledge/library?"),
      });
    },
  });
  const label = t(
    category ? "knowledgeRenameCategory" : "knowledgeCreateCategory",
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!write.isPending) {
          write.reset();
          setName(category?.name ?? "");
          setOpen(v);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>{t("knowledgeCategoryHint")}</DialogDescription>
        <form
          className="flex flex-col gap-stack"
          onSubmit={(e) => {
            e.preventDefault();
            write.mutate();
          }}
        >
          <Field label={t("knowledgeCategoryName")}>
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={write.isPending}
            />
          </Field>
          {write.error && <Callout tone="error">{write.error.message}</Callout>}
          <div className="flex justify-end gap-stack">
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={write.isPending}
              >
                {t("cancel")}
              </Button>
            </DialogClose>
            <Button disabled={write.isPending || !name.trim()}>
              {write.isPending ? t("loading") : label}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KnowledgeSearch({
  category,
  status,
  categories,
}: {
  category: string;
  status: string;
  categories: RecordData[];
}) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const history = useApi("/knowledge/searches");
  const searchId = params.get("searchId");
  const saved = useApi(`/knowledge/searches/${searchId}`, !!searchId);
  const [question, setQuestion] = useState("");
  const write = useWrite("/knowledge/searches", (result) => {
    queryClient.setQueryData([`/knowledge/searches/${result.id}`], result);
    // Preserve the submitted scope even if the user changes filters during execution.
    setParams({
      view: "ask",
      category: result.filters.category,
      status: result.filters.status,
      searchId: result.id,
    });
  });
  useEffect(() => {
    if (saved.data?.status !== "running") return;
    const timer = setInterval(() => void saved.refetch(), 3000);
    return () => clearInterval(timer);
  }, [saved.data?.status, saved.refetch]);
  const result = saved.data;
  return (
    <div className="flex flex-col gap-section">
      <Callout>{t("knowledgeSearchHint")}</Callout>
      <LoadState query={history} />
      {history.data && (
        <>
          {!history.data.canAsk ? (
            <Callout>{t("knowledgeSearchPermission")}</Callout>
          ) : !history.data.configured ? (
            <Callout>{t("knowledgeSearchUnconfigured")}</Callout>
          ) : null}
          <form
            className="flex flex-col gap-stack"
            onSubmit={(e) => {
              e.preventDefault();
              write.mutate({ question, category, status });
            }}
          >
            <Field
              label={t("knowledgeQuestion")}
              hint={
                history.data.provider
                  ? `${t("knowledgeProvider")}: ${history.data.provider}`
                  : undefined
              }
            >
              <Input
                required
                maxLength={1000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={t("knowledgeQuestionExample")}
                disabled={write.isPending}
              />
            </Field>
            <Button
              className="self-start"
              disabled={
                write.isPending ||
                !question.trim() ||
                !history.data.canAsk ||
                !history.data.configured
              }
            >
              {write.isPending
                ? t("knowledgeSearching")
                : t("knowledgeSearchAction")}
            </Button>
          </form>
        </>
      )}
      {write.error && <Callout tone="error">{write.error.message}</Callout>}
      {searchId && <LoadState query={saved} />}
      {result && (
        <Section title={result.question}>
          <p className="text-ui-xs text-muted-foreground">
            {t("knowledgeSavedScope")}:{" "}
            {result.filters.category === "all"
              ? t("knowledgeAllEntries")
              : result.filters.category === "_none"
                ? t("knowledgeUnfiled")
                : (categories.find((c) => c.id === result.filters.category)
                    ?.name ?? result.filters.category)}{" "}
            ·{" "}
            {t(
              result.filters.status === "approved"
                ? "approved"
                : result.filters.status === "draft"
                  ? "draft"
                  : "all",
            )}
          </p>
          {result.status === "running" ? (
            <Callout>{t("knowledgeSearching")}</Callout>
          ) : result.status !== "completed" ? (
            <Callout tone="error">{t("knowledgeSearchFailed")}</Callout>
          ) : !result.answer ? (
            <Empty>{t("knowledgeNoEvidence")}</Empty>
          ) : (
            <>
              <div className="whitespace-pre-wrap text-ui-sm leading-relaxed">
                {result.answer}
              </div>
              <h3 className="text-ui-sm font-medium">
                {t("knowledgeSources")}
              </h3>
              {list(result, "citations").map((c, i) => (
                <div
                  key={`${c.id}:${i}`}
                  className="border-l-2 pl-3 flex flex-col gap-1"
                >
                  <div className="flex flex-wrap items-center gap-stack">
                    <Link
                      className="text-ui-sm underline underline-offset-4"
                      to={`/knowledge/${c.id}?${params}`}
                    >
                      {c.title}
                    </Link>
                    <Badge
                      tone={c.status === "approved" ? "success" : "neutral"}
                    >
                      {c.status === "approved" ? t("approved") : t("draft")}
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
            </>
          )}
        </Section>
      )}
      {list(history.data).length > 0 && (
        <Section title={t("knowledgeRecentSearches")}>
          <ul className="flex flex-col gap-stack">
            {list(history.data).map((item) => (
              <li key={item.id}>
                <Link
                  className="text-ui-sm underline underline-offset-4"
                  to={`/knowledge?${new URLSearchParams({ view: "ask", ...item.filters, searchId: item.id })}`}
                >
                  {item.question}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function CompanyDraft({ draftId }: { draftId: string }) {
  const t = useT();
  const { search } = useLocation();
  const query = useApi(`/knowledge/drafts/${draftId}`);
  const [confirm, setConfirm] = useState(false);
  const write = useWrite(`/knowledge/drafts/${draftId}/approve`, () =>
    setConfirm(false),
  );
  const draft = query.data;
  return (
    <Page>
      <Link className="back-link" to={`/knowledge${search}`}>
        ← {t("companyKnowledge")}
      </Link>
      <LoadState query={query} />
      {draft &&
        (draft.projectId ? (
          <Callout>{t("pageNotFoundHint")}</Callout>
        ) : (
          <>
            <PageHeader
              title={draft.title}
              titleAside={
                <Badge
                  tone={draft.status === "approved" ? "success" : "neutral"}
                >
                  {draft.status === "approved" ? t("approved") : t("draft")}
                </Badge>
              }
            />
            <Callout>{t("companyKnowledgeProvenance")}</Callout>
            <Section title={t("companyKnowledgeContent")}>
              <ChatMarkdown>{draft.body}</ChatMarkdown>
            </Section>
            <Section title={t("companyKnowledgeReview")}>
              <p className="text-ui-sm text-muted-foreground">
                {t("companyKnowledgeApprovalHint")}
              </p>
              {draft.status === "approved" ? (
                <Badge tone="success">{t("approved")}</Badge>
              ) : draft.canApprove ? (
                <Dialog
                  open={confirm}
                  onOpenChange={(open) => {
                    if (!write.isPending) {
                      write.reset();
                      setConfirm(open);
                    }
                  }}
                >
                  <DialogTrigger asChild>
                    <Button>{t("companyKnowledgeApprove")}</Button>
                  </DialogTrigger>
                  <DialogContent showCloseButton={false}>
                    <DialogTitle>{t("companyKnowledgeApprove")}</DialogTitle>
                    <DialogDescription>
                      {t("companyKnowledgeApprovalHint")}
                    </DialogDescription>
                    {write.error && (
                      <Callout tone="error">{write.error.message}</Callout>
                    )}
                    <div className="flex justify-end gap-stack">
                      <DialogClose asChild>
                        <Button variant="outline" disabled={write.isPending}>
                          {t("cancel")}
                        </Button>
                      </DialogClose>
                      <Button
                        disabled={write.isPending}
                        onClick={() => write.mutate({})}
                      >
                        {write.isPending
                          ? t("loading")
                          : t("companyKnowledgeApprove")}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              ) : (
                <Callout>{t("companyKnowledgeReadOnly")}</Callout>
              )}
            </Section>
          </>
        ))}
    </Page>
  );
}
