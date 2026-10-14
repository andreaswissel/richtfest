import { Download } from "lucide-react";
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

type ExportRevision = {
  content?: unknown;
  sourceVersionIds?: unknown;
  sourceReferences?: SourceReference[];
};
type ArtifactContentProps = {
  projectId: string;
  revision: ExportRevision;
};

export function ArtifactContent({ projectId, revision }: ArtifactContentProps) {
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
}: ArtifactContentProps) {
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

export function ArtifactExportActions({
  artifactId,
  revisionId,
}: {
  artifactId: string;
  revisionId: string;
}) {
  const t = useT();
  return (
    <div className="artifact-export-actions">
      <Button asChild variant="outline" size="sm">
        <a
          href={`/api/knowledge/artifacts/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(revisionId)}/pdf`}
          download
          title={t("workspaceExportPdfHint")}
        >
          <Download aria-hidden="true" />
          {t("workspaceExportPdf")}
        </a>
      </Button>
    </div>
  );
}
