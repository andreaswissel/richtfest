import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, list } from "../api";
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
import { Checkbox } from "../components/ui/checkbox";
import { CompanyKnowledgeChat } from "./company-knowledge-chat";
import "./company-knowledge.css";
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
  const [chatActive, setChatActive] = useState(!!params.get("searchId"));
  const query = useApi(
    `/knowledge/library?${new URLSearchParams({ category, status, q: search, page: String(page) })}`,
  );
  const data = query.data;
  const drafts = list(data);
  const categories = list(data, "categories");
  const [selected, setSelected] = useState<string[]>([]);
  const [destination, setDestination] = useState("_none");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewIds, setReviewIds] = useState<string[]>([]);
  const pendingSelected = drafts.filter(
    (d) => selected.includes(d.id) && d.status === "draft",
  );
  const approve = useMutation({
    retry: false,
    mutationFn: () => api("/knowledge/drafts/approve", { draftIds: reviewIds }),
    onSuccess: () => {
      setReviewOpen(false);
      setSelected([]);
      void queryClient.invalidateQueries();
    },
  });
  const selectionScope = `${category}:${status}:${search}:${page}:${chatActive}`;
  useEffect(() => {
    setSelected([]);
    setReviewOpen(false);
  }, [selectionScope]);
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
    <div className="company-knowledge">
      <Page>
        <PageHeader title={t("companyKnowledge")} />
        <LoadState query={query} />
        <div className="grid min-w-0 gap-section md:grid-cols-[12rem_minmax(0,1fr)]">
          <aside className="knowledge-categories flex flex-col gap-stack md:border-r md:pr-4">
            <h2 className="hidden text-ui-sm font-medium md:block">
              {t("knowledgeCategories")}
            </h2>
            <div className="md:hidden">
              <Field label={t("knowledgeCategories")}>
                <NativeSelect
                  value={category}
                  disabled={chatActive}
                  onChange={(e) => setFilter("category", e.target.value)}
                >
                  <option value="all">
                    {t("knowledgeAllEntries")} ({data?.totalCount ?? 0})
                  </option>
                  <option value="_none">
                    {t("knowledgeUnfiled")} ({data?.unfiledCount ?? 0})
                  </option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.count})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <nav
              aria-label={t("knowledgeCategories")}
              className="knowledge-category-nav hidden flex-col gap-1 md:flex"
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
                  aria-disabled={chatActive}
                  onClick={(e) => {
                    if (chatActive) e.preventDefault();
                  }}
                  aria-current={category === c.id ? "page" : undefined}
                  className={`flex min-h-control items-center justify-between gap-stack rounded-md px-2 py-cell text-ui-sm hover:bg-muted ${category === c.id ? "bg-muted font-medium" : "text-muted-foreground"}`}
                >
                  <span className="break-words min-w-0">{c.name}</span>
                  <span className="text-ui-xs tabular-nums">{c.count}</span>
                </Link>
              ))}
            </nav>
            {data?.canManage && !chatActive && <CategoryEditor />}
          </aside>
          <div className="flex min-w-0 flex-col gap-section">
            <CompanyKnowledgeChat
              category={category}
              status={status}
              categories={categories}
              onActive={setChatActive}
            >
              <div className="knowledge-filters flex flex-wrap items-end gap-stack [&_.segmented]:self-end">
                <Field label={t("companyKnowledgeSearch")}>
                  <Input
                    value={search}
                    maxLength={300}
                    onChange={(e) => setFilter("q", e.target.value)}
                  />
                </Field>
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
                {data?.canManage && selectedCategory && (
                  <CategoryEditor
                    key={selectedCategory.id}
                    category={selectedCategory as { id: string; name: string }}
                  />
                )}
              </div>
              {data && (
                <div className="knowledge-library relative">
                  {selected.length > 0 && (
                    <form
                      className="knowledge-bulk flex flex-wrap items-center gap-stack rounded-lg border bg-background p-3 shadow-sm"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (data.canManage && !approve.isPending) move.mutate();
                      }}
                    >
                      <span className="whitespace-nowrap border-r pr-3 text-ui-xs">
                        {selected.length} {t("knowledgeSelected")}
                      </span>
                      {data.canManage && (
                        <>
                          <NativeSelect
                            aria-label={t("knowledgeDestination")}
                            value={destination}
                            onChange={(e) => setDestination(e.target.value)}
                            disabled={move.isPending || approve.isPending}
                          >
                            <option value="_none">
                              {t("knowledgeUnfiled")}
                            </option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </NativeSelect>
                          <Button
                            variant="outline"
                            disabled={move.isPending || approve.isPending}
                          >
                            {move.isPending ? t("loading") : t("knowledgeMove")}
                          </Button>
                        </>
                      )}
                      {data.canApprove && (
                        <Dialog
                          open={reviewOpen}
                          onOpenChange={(open) => {
                            if (!approve.isPending) {
                              approve.reset();
                              if (open) {
                                setReviewIds(pendingSelected.map((d) => d.id));
                              }
                              setReviewOpen(open);
                            }
                          }}
                        >
                          <DialogTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={
                                move.isPending || pendingSelected.length === 0
                              }
                            >
                              {t("knowledgeApproveSelected")} (
                              {pendingSelected.length})
                            </Button>
                          </DialogTrigger>
                          <DialogContent showCloseButton={false}>
                            <DialogTitle>
                              {t("knowledgeApproveSelected")} (
                              {reviewIds.length})
                            </DialogTitle>
                            <DialogDescription>
                              {t("knowledgeBulkApproveHint")}
                            </DialogDescription>
                            <ul className="max-h-48 overflow-y-auto text-ui-sm space-y-2">
                              {drafts
                                .filter((d) => reviewIds.includes(d.id))
                                .map((d) => (
                                  <li key={d.id}>
                                    <Link
                                      className="underline underline-offset-4"
                                      to={`/knowledge/${d.id}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      {d.title}
                                    </Link>
                                  </li>
                                ))}
                            </ul>
                            {approve.error && (
                              <Callout tone="error">
                                {approve.error.message}
                              </Callout>
                            )}
                            <div className="flex justify-end gap-stack">
                              <DialogClose asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={approve.isPending}
                                >
                                  {t("cancel")}
                                </Button>
                              </DialogClose>
                              <Button
                                type="button"
                                disabled={
                                  approve.isPending || !reviewIds.length
                                }
                                onClick={() => approve.mutate()}
                              >
                                {approve.isPending
                                  ? t("loading")
                                  : t("knowledgeApproveSelected")}
                              </Button>
                            </div>
                          </DialogContent>
                        </Dialog>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("cancel")}
                        title={t("cancel")}
                        disabled={move.isPending || approve.isPending}
                        onClick={() => setSelected([])}
                      >
                        <X className="size-icon-sm" />
                      </Button>
                      {move.error && (
                        <div className="w-full">
                          <Callout tone="error">{move.error.message}</Callout>
                        </div>
                      )}
                    </form>
                  )}
                  <Section
                    title={`${selectedCategory?.name ?? t(category === "_none" ? "knowledgeUnfiled" : "companyKnowledgeEntries")} · ${data.total}`}
                  >
                    {drafts.length ? (
                      <Table className="knowledge-table [&_td]:whitespace-normal [&_.row-link]:break-words">
                        <TableHeader>
                          <TableRow>
                            {(data.canManage || data.canApprove) && (
                              <TableHead className="knowledge-selection">
                                <Checkbox
                                  aria-label={t("knowledgeSelectPage")}
                                  checked={
                                    drafts.every((d) => selected.includes(d.id))
                                      ? true
                                      : selected.length
                                        ? "indeterminate"
                                        : false
                                  }
                                  disabled={move.isPending || approve.isPending}
                                  onCheckedChange={(checked) =>
                                    setSelected(
                                      checked === true
                                        ? drafts.map((d) => d.id)
                                        : [],
                                    )
                                  }
                                />
                              </TableHead>
                            )}
                            <TableHead>{t("title")}</TableHead>
                            <TableHead className="knowledge-metadata">
                              {t("knowledgeCategories")}
                            </TableHead>
                            <TableHead>{t("status")}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {drafts.map((draft) => (
                            <TableRow key={draft.id} {...linkedRow}>
                              {(data.canManage || data.canApprove) && (
                                <TableCell className="knowledge-selection">
                                  <Checkbox
                                    className="relative z-10"
                                    aria-label={`${t("knowledgeSelect")} ${draft.displayTitle ?? draft.title}`}
                                    checked={selected.includes(draft.id)}
                                    disabled={
                                      move.isPending || approve.isPending
                                    }
                                    onCheckedChange={(checked) =>
                                      setSelected((ids) =>
                                        checked === true
                                          ? [...ids, draft.id]
                                          : ids.filter((id) => id !== draft.id),
                                      )
                                    }
                                  />
                                </TableCell>
                              )}
                              <TableCell>
                                <RowLink
                                  to={`/knowledge/${draft.id}?${params}`}
                                >
                                  {draft.displayTitle ?? draft.title}
                                </RowLink>
                                <div className="knowledge-source text-ui-xs text-muted-foreground">
                                  {[draft.sourceLabel, draft.chapter]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </div>
                                <div className="knowledge-mobile-metadata text-ui-xs text-muted-foreground">
                                  {categories.find(
                                    (c) => c.id === draft.categoryId,
                                  )?.name ?? t("knowledgeUnfiled")}
                                </div>
                              </TableCell>
                              <TableCell className="knowledge-metadata text-ui-xs text-muted-foreground">
                                {categories.find(
                                  (c) => c.id === draft.categoryId,
                                )?.name ?? t("knowledgeUnfiled")}
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
                </div>
              )}
            </CompanyKnowledgeChat>
          </div>
        </div>
      </Page>
    </div>
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
              title={draft.displayTitle ?? draft.title}
              titleAside={
                <Badge
                  tone={draft.status === "approved" ? "success" : "neutral"}
                >
                  {draft.status === "approved" ? t("approved") : t("draft")}
                </Badge>
              }
            />
            <p className="text-ui-xs text-muted-foreground">
              {[draft.sourceLabel, draft.chapter].filter(Boolean).join(" · ")}
            </p>
            <p className="text-ui-xs text-muted-foreground">
              {t("knowledgeOriginalTitle")}: {draft.title}
            </p>
            <p className="text-ui-xs text-muted-foreground">
              {t("companyKnowledgeProvenance")}
            </p>
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
