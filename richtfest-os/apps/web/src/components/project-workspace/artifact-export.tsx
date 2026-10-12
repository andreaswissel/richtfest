import { Printer } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import {
  formatSourceCitations,
  sourceReferenceLabel,
  type SourceReference,
} from "@richtfest/shared";
import { ChatMarkdown } from "../chat-markdown";
import { Button } from "../ui/button";
import { useT } from "../../i18n";
import "./artifact-export.css";

type ExportArtifact = {
  title: string;
  status?: string | null;
  type?: string | null;
};
type ExportRevision = {
  id?: string | null;
  version?: number | null;
  title?: string | null;
  content?: unknown;
  sourceVersionIds?: unknown;
  sourceReferences?: SourceReference[];
  createdAt?: string | Date | null;
};
type ArtifactExportProps = {
  projectId: string;
  artifact: ExportArtifact;
  revision: ExportRevision;
};

export function ArtifactContent({
  projectId,
  revision,
}: Pick<ArtifactExportProps, "projectId" | "revision">) {
  const t = useT();
  if (typeof revision.content !== "string")
    return (
      <pre className="preserve-lines">
        {JSON.stringify(revision.content, null, 2) ||
          t("workspaceExportNoContent")}
      </pre>
    );
  return (
    <ChatMarkdown>
      {formatSourceCitations(
        revision.content,
        projectId,
        revision.sourceReferences ?? [],
        t("workspaceSourceUnavailable"),
      ) || t("workspaceExportNoContent")}
    </ChatMarkdown>
  );
}

export function ArtifactSourceRegister({
  projectId,
  revision,
}: Pick<ArtifactExportProps, "projectId" | "revision">) {
  const t = useT();
  const location = useLocation();
  const conversationId = new URLSearchParams(location.search).get(
    "conversation",
  );
  const sources = revision.sourceReferences ?? [];
  const ids = Array.isArray(revision.sourceVersionIds)
    ? revision.sourceVersionIds.flatMap((ref) =>
        typeof ref === "string"
          ? [ref]
          : ref && typeof ref.id === "string"
            ? [ref.id]
            : [],
      )
    : [];
  const sourceIds = [
    ...new Set([...ids, ...sources.map((source) => source.versionId)]),
  ];
  return (
    <section className="artifact-source-register">
      <h3>{t("workspaceExportSourceRefs")}</h3>
      {sourceIds.length ? (
        <ol>
          {sourceIds.map((id) => {
            const source = sources.find((item) => item.versionId === id);
            return (
              <li key={id}>
                {source ? (
                  <Link
                    to={`/projects/${encodeURIComponent(projectId)}?panel=documents&sourceVersion=${encodeURIComponent(id)}${conversationId ? `&conversation=${encodeURIComponent(conversationId)}` : ""}`}
                  >
                    {sourceReferenceLabel(source)}
                  </Link>
                ) : (
                  t("workspaceSourceUnavailable")
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p>{t("workspaceExportNoSourceRefs")}</p>
      )}
    </section>
  );
}

function revisionLabel(revision: ExportRevision, t: ReturnType<typeof useT>) {
  return revision.version
    ? `${t("workspaceExportRevision")} ${revision.version}`
    : t("workspaceExportCurrentRevision");
}

function formattedCreatedAt(value: ExportRevision["createdAt"]) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export function ArtifactExportActions({
  artifact,
  revision,
}: Pick<ArtifactExportProps, "artifact" | "revision">) {
  const t = useT();
  const print = async () => {
    // Ensure the shared lazy renderer has loaded before opening the print dialog.
    await import("../chat-markdown-content");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const previousTitle = document.title;
    const restoreTitle = () => {
      document.title = previousTitle;
      window.removeEventListener("afterprint", restoreTitle);
    };
    document.title = `${artifact.title.trim() || t("workspaceExportArtifact")} · ${revisionLabel(revision, t)}`;
    window.addEventListener("afterprint", restoreTitle);
    window.print();
  };
  return (
    <div className="artifact-export-actions">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={print}
        title={t("workspaceExportPdfHint")}
      >
        <Printer aria-hidden="true" />
        {t("workspaceExportPdf")}
      </Button>
    </div>
  );
}

export function ArtifactPrintDocument({
  projectId,
  artifact,
  revision,
}: ArtifactExportProps) {
  const t = useT();
  const createdAt = formattedCreatedAt(revision.createdAt);
  return (
    <section className="artifact-export-print-document">
      <header className="artifact-export-print-header">
        <p className="artifact-export-print-eyebrow">
          {t("workspaceExportEyebrow")}
        </p>
        <h1>
          {artifact.title || revision.title || t("workspaceExportArtifact")}
        </h1>
        <dl className="artifact-export-print-meta">
          <div>
            <dt>{t("workspaceExportArtifactStatus")}</dt>
            <dd>{artifact.status || t("workspaceExportDraft")}</dd>
          </div>
          <div>
            <dt>{t("workspaceExportRevision")}</dt>
            <dd>{revisionLabel(revision, t)}</dd>
          </div>
          {artifact.type && (
            <div>
              <dt>{t("workspaceExportType")}</dt>
              <dd>{artifact.type}</dd>
            </div>
          )}
          {createdAt && (
            <div>
              <dt>{t("workspaceExportCreated")}</dt>
              <dd>{createdAt}</dd>
            </div>
          )}
          {revision.id && (
            <div>
              <dt>{t("workspaceExportRevisionId")}</dt>
              <dd>{revision.id}</dd>
            </div>
          )}
        </dl>
      </header>
      <article className="artifact-export-print-content">
        <h2>{revision.title || artifact.title}</h2>
        <ArtifactContent projectId={projectId} revision={revision} />
      </article>
      <div className="artifact-export-print-sources">
        <ArtifactSourceRegister projectId={projectId} revision={revision} />
      </div>
      <footer className="artifact-export-print-footer">
        {t("workspaceExportFooter")}
      </footer>
    </section>
  );
}
