import { useState } from "react";
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { list } from "../api";
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
import {
  Badge,
  Callout,
  Empty,
  Field,
  RowLink,
  Segmented,
  Table,
} from "../components/ui/primitives";
import { useT } from "../i18n";
import { useApi, useWrite } from "../query";
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
  const query = useApi("/knowledge/drafts?scope=company");
  const [params, setParams] = useSearchParams();
  const search = params.get("q") || "";
  const status = params.get("status") || "draft";
  const drafts = list(query.data).filter(
    (draft) =>
      (status === "all" || draft.status === status) &&
      draft.title
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <Page>
      <PageHeader
        title={t("companyKnowledge")}
        description={t("companyKnowledgeHint")}
      />
      <div className="flex flex-wrap items-end gap-stack [&_.segmented]:self-end">
        <Field label={t("companyKnowledgeSearch")}>
          <Input
            value={search}
            onChange={(event) => setFilter("q", event.target.value)}
          />
        </Field>
        <Segmented
          value={status}
          onChange={(value) => setFilter("status", value)}
          items={[
            { value: "draft", label: t("draft") },
            { value: "approved", label: t("approved") },
            { value: "all", label: t("all") },
          ]}
        />
      </div>
      <LoadState query={query} />
      {query.data && (
        <Section title={`${t("companyKnowledgeEntries")} · ${drafts.length}`}>
          {drafts.length ? (
            <div className="[&_td]:whitespace-normal [&_.row-link]:break-words">
              <Table
                headers={[t("title"), t("status")]}
                rows={drafts.map((draft) => ({
                  id: draft.id,
                  sort: [draft.title, draft.status],
                  cells: [
                    <RowLink to={`/knowledge/${draft.id}?${params.toString()}`}>
                      {draft.title}
                    </RowLink>,
                    <Badge
                      tone={draft.status === "approved" ? "success" : "neutral"}
                    >
                      {draft.status === "approved" ? t("approved") : t("draft")}
                    </Badge>,
                  ],
                }))}
              />
            </div>
          ) : (
            <Empty>{t("companyKnowledgeEmpty")}</Empty>
          )}
        </Section>
      )}
    </Page>
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
