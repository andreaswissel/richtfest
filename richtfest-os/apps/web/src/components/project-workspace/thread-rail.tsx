import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Menu,
  MessageSquare,
  PencilLine,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { api, type RecordData } from "../../api";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Callout, Field } from "../ui/primitives";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "../ui/dialog";
import "./thread-rail.css";

export function ThreadRail({
  projectId,
  conversations,
  selectedId,
  onCreate,
  creating = false,
  onArchived,
  mobileMenu,
}: {
  projectId: string;
  conversations: RecordData[];
  selectedId?: string;
  onCreate: () => void;
  creating?: boolean;
  onArchived?: (id: string, archived: boolean) => void;
  mobileMenu?: { title: string; subtitle: string; navigation: ReactNode };
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 850px)");
    const closeOnDesktop = () => {
      if (!media.matches) setMenuOpen(false);
    };
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, []);
  const [editing, setEditing] = useState<RecordData | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api(`/knowledge/conversations/${id}/archive`, { archived }, "PATCH"),
    onSuccess: (data, variables) => {
      queryClient.setQueryData(
        [`/knowledge/workspaces/${projectId}`],
        (old: RecordData | undefined) => {
          if (!old || !Array.isArray(old.conversations)) return old;
          const returned = data?.conversation || data;
          return {
            ...old,
            conversations: old.conversations.map((conversation: RecordData) =>
              conversation.id === variables.id
                ? {
                    ...conversation,
                    archivedAt: variables.archived
                      ? returned?.archivedAt || new Date().toISOString()
                      : null,
                  }
                : conversation,
            ),
          };
        },
      );
      onArchived?.(variables.id, variables.archived);
      void queryClient.invalidateQueries({
        queryKey: [`/knowledge/workspaces/${projectId}`],
      });
      void queryClient.invalidateQueries({
        queryKey: [`/knowledge/conversations?projectId=${projectId}`],
      });
    },
  });
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api<RecordData>(
        `/knowledge/conversations/${id}/title`,
        { title },
        "PATCH",
      ),
    onSuccess: (updated, variables) => {
      queryClient.setQueryData(
        [`/knowledge/workspaces/${projectId}`],
        (old: RecordData | undefined) => {
          if (!old || !Array.isArray(old.conversations)) return old;
          return {
            ...old,
            conversations: old.conversations.map((conversation: RecordData) =>
              conversation.id === variables.id
                ? { ...conversation, title: updated.title }
                : conversation,
            ),
          };
        },
      );
      void queryClient.invalidateQueries({
        queryKey: [`/knowledge/conversations?projectId=${projectId}`],
      });
      setEditing(null);
    },
  });
  const active = conversations.filter(
    (conversation) => !conversation.archivedAt,
  );
  const archived = conversations.filter((conversation) =>
    Boolean(conversation.archivedAt),
  );
  const hrefFor = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("conversation", id);
    next.delete("view");
    next.delete("panel");
    next.delete("agentRun");
    next.delete("message");
    for (const key of ["artifact", "revision", "file", "sourceVersion", "sourceSelection", "page"])
      next.delete(key);
    const query = next.toString();
    return `/projects/${projectId}${query ? `?${query}` : ""}`;
  };
  const titleFor = (conversation: RecordData) =>
    conversation.title || t("workspaceUiConversation");
  const row = (conversation: RecordData) => {
    const isSelected = selectedId === conversation.id;
    const archivedState = Boolean(conversation.archivedAt);
    return (
      <div
        className={`thread-rail-row${isSelected ? " is-selected" : ""}`}
        key={conversation.id}
      >
        <Link
          className="thread-rail-link"
          title={titleFor(conversation)}
          to={hrefFor(conversation.id)}
          aria-current={isSelected ? "page" : undefined}
          onClick={() => {
            setMobileOpen(false);
            setMenuOpen(false);
          }}
        >
          <span className="thread-rail-title">{titleFor(conversation)}</span>
          {conversation.unreadCount > 0 && (
            <span
              className="thread-rail-unread"
              aria-label={t("threadRailUnread")}
              title={t("threadRailUnread")}
            />
          )}
        </Link>
        <button
          type="button"
          className="thread-rail-action"
          disabled={rename.isPending}
          aria-label={`${t("threadRailRename")} ${titleFor(conversation)}`}
          title={t("threadRailRename")}
          onClick={() => {
            setTitleDraft(conversation.title || "");
            setEditing(conversation);
            rename.reset();
          }}
        >
          <PencilLine aria-hidden="true" />
        </button>
        <button
          type="button"
          className="thread-rail-action"
          disabled={archive.isPending}
          aria-label={
            archivedState ? t("sharedWorkRestore") : t("sharedWorkArchive")
          }
          title={
            archivedState ? t("sharedWorkRestore") : t("sharedWorkArchive")
          }
          onClick={() =>
            archive.mutate({ id: conversation.id, archived: !archivedState })
          }
        >
          {archivedState ? (
            <RotateCcw aria-hidden="true" />
          ) : (
            <Archive aria-hidden="true" />
          )}
        </button>
      </div>
    );
  };
  const threadList = (
    <>
      <div className="thread-rail-header">
        <h2>{t("sharedWorkThreads")}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={creating}
          aria-label={t("threadRailNew")}
          title={t("threadRailNew")}
          onClick={() => {
            onCreate();
            setMenuOpen(false);
            setMobileOpen(false);
          }}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      <nav className="thread-rail-list" aria-label={t("sharedWorkThreads")}>
        {active.map(row)}
        {!active.length && (
          <p className="thread-rail-empty">{t("threadRailEmpty")}</p>
        )}
      </nav>
      {archived.length > 0 && (
        <details
          className="thread-rail-archived"
          open={
            archived.some((conversation) => conversation.id === selectedId) ||
            undefined
          }
        >
          <summary>
            <span>{t("sharedWorkArchived")}</span>
            <Badge tone="neutral">{archived.length}</Badge>
          </summary>
          <nav
            className="thread-rail-list"
            aria-label={t("sharedWorkArchived")}
          >
            {archived.map(row)}
          </nav>
        </details>
      )}
      {archive.error && <Callout tone="error">{archive.error.message}</Callout>}
    </>
  );
  return (
    <aside
      className={`thread-rail${mobileMenu ? " has-mobile-menu" : ""}`}
      aria-label={t("sharedWorkThreads")}
    >
      {mobileMenu && (
        <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
          <div className="workspace-mobile-header">
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("workspaceOpenNavigation")}
                title={t("workspaceOpenNavigation")}
              >
                <Menu aria-hidden="true" />
              </Button>
            </DialogTrigger>
            <div className="workspace-mobile-context">
              <strong title={mobileMenu.title}>{mobileMenu.title}</strong>
              <span title={mobileMenu.subtitle}>{mobileMenu.subtitle}</span>
            </div>
          </div>
          <DialogContent
            className="workspace-navigation-dialog"
            showCloseButton={false}
            aria-describedby={undefined}
          >
            <DialogHeader>
              <DialogTitle>{mobileMenu.title}</DialogTitle>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("close")}
                >
                  <X aria-hidden="true" />
                </Button>
              </DialogClose>
            </DialogHeader>
            <div className="workspace-navigation-threads">{threadList}</div>
            <div
              className="workspace-navigation-links"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("a,button"))
                  setMenuOpen(false);
              }}
            >
              {mobileMenu.navigation}
            </div>
          </DialogContent>
        </Dialog>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="thread-rail-toggle"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen((open) => !open)}
      >
        <MessageSquare aria-hidden="true" />
        {t("sharedWorkThreads")}
        {mobileOpen ? (
          <ChevronDown aria-hidden="true" />
        ) : (
          <ChevronRight aria-hidden="true" />
        )}
      </Button>
      <div className={`thread-rail-content${mobileOpen ? " is-open" : ""}`}>
        {threadList}
      </div>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !rename.isPending) {
            setEditing(null);
            rename.reset();
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("threadRailRenameTitle")}</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!editing || !titleDraft.trim()) return;
              rename.mutate({ id: editing.id, title: titleDraft.trim() });
            }}
          >
            <Field label={t("threadRailTitleLabel")}>
              <Input
                autoFocus
                maxLength={300}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                disabled={rename.isPending}
              />
            </Field>
            {rename.error && (
              <Callout tone="error">{rename.error.message}</Callout>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={rename.isPending}
                onClick={() => {
                  setEditing(null);
                  rename.reset();
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  rename.isPending ||
                  !titleDraft.trim() ||
                  titleDraft.trim() === editing?.title
                }
              >
                {t("threadRailRename")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
