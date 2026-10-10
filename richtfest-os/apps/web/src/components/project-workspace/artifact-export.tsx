import { Printer } from "lucide-react";
import type { ReactNode } from "react";
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
  createdAt?: string | Date | null;
};

type ArtifactExportProps = {
  projectId: string;
  artifact: ExportArtifact;
  revision: ExportRevision;
};

function artifactSourceVersionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((ref) => {
    if (typeof ref === "string" && ref.trim()) return [ref];
    if (!ref || typeof ref !== "object" || !("id" in ref)) return [];
    const id = (ref as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? [id] : [];
  });
}

function revisionContent(content: unknown) {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content, null, 2);
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

function renderArtifactContent(
  content: string,
  t: ReturnType<typeof useT>,
): ReactNode {
  const lines = content.split(/\r?\n/);
  const output: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      output.push(
        <div
          className="artifact-export-markdown-heading"
          data-level={heading[1].length}
          key={`heading-${index}`}
        >
          {heading[2]}
        </div>,
      );
      index += 1;
      continue;
    }

    if (/^(?:[-*+])\s+(.+)$/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^(?:[-*+])\s+(.+)$/.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      output.push(
        <ul key={`unordered-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{item}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.)]\s+(.+)$/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\d+[.)]\s+(.+)$/.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      output.push(
        <ol key={`ordered-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{item}</li>
          ))}
        </ol>,
      );
      continue;
    }

    output.push(
      line ? (
        <p key={`line-${index}`}>{line}</p>
      ) : (
        <div
          aria-hidden="true"
          className="artifact-export-markdown-blank"
          key={`blank-${index}`}
        />
      ),
    );
    index += 1;
  }

  return output.length ? output : <p>{t("workspaceExportNoContent")}</p>;
}

export function ArtifactExportActions({
  artifact,
  revision,
}: Pick<ArtifactExportProps, "artifact" | "revision">) {
  const t = useT();
  const print = () => {
    const previousTitle = document.title;
    const title = artifact.title.trim() || t("workspaceExportArtifact");
    const restoreTitle = () => {
      document.title = previousTitle;
      window.removeEventListener("afterprint", restoreTitle);
    };

    document.title = `${title} · ${revisionLabel(revision, t)}`;
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
  const sourceVersionIds = artifactSourceVersionIds(revision.sourceVersionIds);
  const content = revisionContent(revision.content);
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
        {renderArtifactContent(content, t)}
      </article>

      <section className="artifact-export-print-sources">
        <h2>{t("workspaceExportSourceRefs")}</h2>
        {sourceVersionIds.length ? (
          <ol>
            {sourceVersionIds.map((sourceVersionId, index) => (
              <li key={`${sourceVersionId}-${index}`}>
                <a
                  href={`/projects/${projectId}?panel=documents&sourceVersion=${encodeURIComponent(sourceVersionId)}`}
                >
                  {sourceVersionId}
                </a>
              </li>
            ))}
          </ol>
        ) : (
          <p>{t("workspaceExportNoSourceRefs")}</p>
        )}
      </section>

      <footer className="artifact-export-print-footer">
        {t("workspaceExportFooter")}
      </footer>
    </section>
  );
}
