import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, list, uploadFile, type RecordData } from "../../api";
import { useApi, useWrite, queryClient } from "../../query";
import { useT } from "../../i18n";
import { SubagentList } from "./subagent-thread";
import {
  ArtifactContent,
  ArtifactSourceRegister,
  ArtifactExportActions,
  ArtifactPrintDocument,
} from "./artifact-export";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Empty, Field } from "../ui/primitives";
const ProjectOpenUI = lazy(() => import("./openui"));
const IMAGE_PREVIEW_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
export function ArtifactPanel({
  projectId,
  conversationId,
  artifacts,
  runs,
  tasks,
  initialFiles,
}: {
  projectId: string;
  conversationId?: string;
  artifacts: RecordData[];
  runs: RecordData[];
  tasks: RecordData[];
  initialFiles?: RecordData[];
}) {
  const t = useT(),
    [params, setParams] = useSearchParams();
  const reply = useWrite(`/knowledge/conversations/${conversationId}/messages`);
  const files = useApi(
    `/projects/${projectId}/files`,
    initialFiles === undefined,
  );
  const filesData = files.data ?? initialFiles;
  const sourceVersion = params.get("sourceVersion");
  const exactSource = useApi(
    `/projects/${projectId}/source-versions/${sourceVersion}`,
    !!sourceVersion && !params.get("file"),
  );
  const fileId = params.get("file") || exactSource.data?.fileId,
    artifactId = params.get("artifact");
  const versions = useApi(
    `/projects/${projectId}/files/${fileId}/versions`,
    !!fileId,
  );
  const artifactQuery = useApi(
    `/knowledge/artifacts/${artifactId}`,
    !!artifactId,
  );
  const artifact = {
    ...artifactQuery,
    data:
      artifactQuery.data?.artifact?.projectId === projectId
        ? artifactQuery.data
        : undefined,
  };
  const review = useWrite(`/knowledge/artifacts/${artifactId}/review`);
  const revisionId = params.get("revision"),
    versionId = params.get("sourceVersion");
  const revision = list(artifact.data?.revisions).find(
    (r) => r.id === revisionId,
  );
  const version =
    list(versions.data).find((r) => r.id === versionId) ||
    (exactSource.data
      ? { ...exactSource.data, id: exactSource.data.versionId }
      : undefined);
  useEffect(() => {
    if (fileId && !versionId && versions.data) {
      const latest = list(versions.data)
        .filter((v) => v.status === "ready")
        .sort((a, b) => b.version - a.version)[0];
      if (latest) {
        const next = new URLSearchParams(params);
        next.set("sourceVersion", latest.id);
        setParams(next, { replace: true });
      }
    }
  }, [fileId, versionId, versions.data]);
  useEffect(() => {
    if (artifactId && !revisionId && artifact.data?.revisions) {
      const latest = list(artifact.data.revisions)[0];
      if (latest) {
        const next = new URLSearchParams(params);
        next.set("revision", latest.id);
        setParams(next, { replace: true });
      }
    }
  }, [artifactId, revisionId, artifact.data?.revisions]);
  const selectedFile = list(filesData, "files").find((f) => f.id === fileId);
  const selectedFileName =
    selectedFile?.name || exactSource.data?.fileName || "";
  const isAffinityPublisher = /\.afpub$/i.test(selectedFileName);
  const tab = params.get("panel") || "documents";
  const target = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates))
      v ? next.set(k, v) : next.delete(k);
    return `?${next}`;
  };
  return (
    <aside className="project-artifacts" aria-label={t("workspaceArtifacts")}>
      <nav
        className="workspace-view-links"
        aria-label={t("workspaceArtifacts")}
      >
        <Link
          aria-current={tab === "documents" ? "page" : undefined}
          to={target({ panel: "documents" })}
        >
          {t("sources")}
        </Link>
        <Link
          aria-current={tab === "artifacts" ? "page" : undefined}
          to={target({ panel: "artifacts" })}
        >
          {t("workspaceArtifacts")}
        </Link>
        <Link
          aria-current={tab === "runs" ? "page" : undefined}
          to={target({ panel: "runs" })}
        >
          {t("agentThreadList")} ·{" "}
          {
            runs.filter(
              (run) =>
                (run.isSupervisor ||
                  (run.parentRunId && run.status !== "cancelled")) &&
                (!conversationId || run.conversationId === conversationId),
            ).length
          }
        </Link>
        <Link
          aria-current={tab === "tasks" ? "page" : undefined}
          to={target({ panel: "tasks" })}
        >
          {t("sharedWork")} · {tasks.length}
        </Link>
      </nav>
      <div className="artifact-panel-body">
        {reply.error && <Callout tone="error">{reply.error.message}</Callout>}
        {reply.data && <p role="status">{t("workspaceInputSent")}</p>}
        {tab === "runs" ? (
          <SubagentList
            projectId={projectId}
            conversationId={conversationId}
            runs={runs}
          />
        ) : tab === "tasks" ? (
          <>
            {tasks.map((task) => (
              <div className="task-row" key={task.id}>
                <Badge>{task.status}</Badge>
                <span>{task.title}</span>
              </div>
            ))}
            {!tasks.length && <Empty>{t("noWork")}</Empty>}
            <Link to={`/projects/${projectId}?view=sharedWork`}>
              {t("addTask")}
            </Link>
          </>
        ) : tab === "documents" ? (
          <>
            {exactSource.error && (
              <Callout tone="error">{exactSource.error.message}</Callout>
            )}
            {files.error && (
              <Callout tone="error">{files.error.message}</Callout>
            )}
            {!fileId && (
              <>
                {list(filesData, "files").map((file) => (
                  <Link
                    className="artifact-list-item"
                    key={file.id}
                    to={target({
                      file: file.id,
                      artifact: null,
                      sourceVersion: null,
                    })}
                  >
                    <span>{file.name}</span>
                    <Badge>
                      {t("version")} {file.version}
                    </Badge>
                  </Link>
                ))}
                {filesData && !list(filesData, "files").length && (
                  <Empty>{t("noSources")}</Empty>
                )}
                <Button asChild variant="outline">
                  <Link to={`/projects/${projectId}?view=sources`}>
                    {t("attachFile")}
                  </Link>
                </Button>
              </>
            )}
            {fileId && (
              <>
                <Link to={target({ file: null, sourceVersion: null })}>
                  ← {t("sources")}
                </Link>
                <h3>
                  {selectedFile?.name ||
                    exactSource.data?.fileName ||
                    t("source")}
                </h3>
                <Field label={t("version")}>
                  <NativeSelect
                    value={versionId || ""}
                    onChange={(e) =>
                      setParams(
                        target({ sourceVersion: e.target.value }).slice(1),
                      )
                    }
                  >
                    <option value="" disabled>
                      {t("workspaceChooseRevision")}
                    </option>
                    {list(versions.data)
                      .filter((v) => v.status === "ready")
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.version} · {v.mimeType}
                        </option>
                      ))}
                  </NativeSelect>
                </Field>
                {!version && <Callout>{t("workspaceExactVersion")}</Callout>}
                {version && (
                  <>
                    <Badge>
                      {version.version ===
                      Math.max(
                        ...list(versions.data)
                          .filter((v) => v.status === "ready")
                          .map((v) => v.version),
                      )
                        ? t("workspaceLatestUploaded")
                        : t("version")}{" "}
                      · {version.version}
                    </Badge>
                    <Button asChild variant="outline">
                      <a
                        href={`/api/projects/${projectId}/files/${fileId}/versions/${version.version}/download`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("downloadFile")} · {version.version}
                      </a>
                    </Button>
                    {isAffinityPublisher ? (
                      <AffinityPublisherPreview
                        key={version.id}
                        projectId={projectId}
                        fileId={fileId}
                        version={version.version}
                        fileName={selectedFileName}
                      />
                    ) : version.mimeType === "application/pdf" ? (
                      <iframe
                        className="source-preview"
                        title={`${selectedFile?.name} · ${version.version}`}
                        src={`/api/projects/${projectId}/files/${fileId}/versions/${version.version}/download#page=${params.get("page") || 1}`}
                      />
                    ) : IMAGE_PREVIEW_MIME_TYPES.includes(version.mimeType) ? (
                      <img
                        className="source-image"
                        src={`/api/projects/${projectId}/files/${fileId}/versions/${version.version}/download`}
                        alt={
                          selectedFile?.name ||
                          exactSource.data?.fileName ||
                          t("source")
                        }
                      />
                    ) : (
                      <Callout>{t("workspaceUnsupportedPreview")}</Callout>
                    )}
                    <p className="muted text-ui-xs">
                      {t("workspaceUnreviewedSource")} ·{" "}
                      {version.checksum || t("workspaceChecksumUnavailable")}
                    </p>
                    <SourceText
                      key={version.id}
                      projectId={projectId}
                      conversationId={conversationId}
                      versionId={version.id}
                    />
                  </>
                )}
                <VersionUpload projectId={projectId} fileId={fileId} />
              </>
            )}
          </>
        ) : (
          <>
            {artifactQuery.data && !artifact.data && (
              <Callout tone="error">{t("workspaceWrongProject")}</Callout>
            )}
            {!artifactId && (
              <>
                {artifacts.map((a) => (
                  <Link
                    key={a.id}
                    className="artifact-list-item"
                    to={target({ artifact: a.id, file: null, revision: null })}
                  >
                    <span>{a.title}</span>
                    <Badge>
                      {a.status === "approved" ? t("approved") : t("draft")}
                    </Badge>
                  </Link>
                ))}
                {!artifacts.length && (
                  <Empty>{t("workspaceNoArtifacts")}</Empty>
                )}
              </>
            )}
            {artifactId && (
              <>
                <Link to={target({ artifact: null, revision: null })}>
                  ← {t("workspaceArtifacts")}
                </Link>
                <h3>{artifact.data?.artifact?.title}</h3>
                <Field label={t("version")}>
                  <NativeSelect
                    value={revisionId || ""}
                    onChange={(e) =>
                      setParams(target({ revision: e.target.value }).slice(1))
                    }
                  >
                    <option value="" disabled>
                      {t("workspaceChooseRevision")}
                    </option>
                    {list(artifact.data?.revisions).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.revision || r.version} · {r.status || t("draft")}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                {revision ? (
                  <>
                    <ArtifactExportActions
                      artifact={
                        artifact.data?.artifact || { title: "Artifact" }
                      }
                      revision={revision}
                    />
                    <ArtifactPrintDocument
                      projectId={projectId}
                      artifact={
                        artifact.data?.artifact || { title: "Artifact" }
                      }
                      revision={revision}
                    />
                    <Badge>
                      {revision.status === "approved"
                        ? t("approved")
                        : t("draft")}
                    </Badge>
                    {revision.format === "openui" ||
                    artifact.data?.artifact?.type === "openui" ? (
                      <Suspense fallback={<span>{t("loading")}</span>}>
                        <ProjectOpenUI
                          projectId={projectId}
                          conversationId={conversationId}
                          onReply={
                            conversationId
                              ? (body) => reply.mutate({ body })
                              : undefined
                          }
                          response={
                            typeof revision.content === "string"
                              ? revision.content
                              : ""
                          }
                        />
                      </Suspense>
                    ) : (
                      <div className="artifact-content">
                        <ArtifactContent
                          projectId={projectId}
                          revision={revision}
                        />
                      </div>
                    )}
                    <ArtifactSourceRegister
                      projectId={projectId}
                      revision={revision}
                    />
                    {artifact.data?.artifact?.status === "approved" ? (
                      <Callout tone="success">
                        {t("workspaceReviewedFinding")} ·{" "}
                        <Link to={`/projects/${projectId}?view=knowledge`}>
                          {t("reviewedKnowledge")}
                        </Link>
                      </Callout>
                    ) : revision.id ===
                      list(artifact.data?.revisions)[0]?.id ? (
                      <div className="artifact-review-action">
                        <Callout>{t("workspaceReviewBoundary")}</Callout>
                        <Button
                          disabled={review.isPending}
                          onClick={() =>
                            review.mutate({ expectedRevisionId: revision.id })
                          }
                        >
                          {t("workspaceApproveFinding")}
                        </Button>
                      </div>
                    ) : (
                      <Callout>{t("workspaceReviewLatest")}</Callout>
                    )}
                    {review.data &&
                      artifact.data?.artifact?.status !== "approved" && (
                        <p role="status">
                          {t("workspaceReviewedFinding")} ·{" "}
                          <Link to={`/projects/${projectId}?view=knowledge`}>
                            {t("reviewedKnowledge")}
                          </Link>
                        </p>
                      )}
                    {review.error && (
                      <Callout tone="error">{review.error.message}</Callout>
                    )}
                    <Annotation
                      key={revision.id}
                      projectId={projectId}
                      conversationId={conversationId}
                      artifactRevisionId={revision.id}
                    />
                  </>
                ) : (
                  <Callout>{t("workspaceExactVersion")}</Callout>
                )}
                {list(artifact.data?.annotations)
                  .filter((a) => a.artifactRevisionId === revisionId)
                  .map((a) => (
                    <div className="artifact-annotation" key={a.id}>
                      <Badge>{t("workspaceAnnotation")}</Badge>
                      <p>{a.body}</p>
                    </div>
                  ))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
function Annotation({
  projectId,
  conversationId,
  sourceVersionId,
  artifactRevisionId,
  selectedQuote,
  selectedPage,
}: {
  projectId: string;
  conversationId?: string;
  sourceVersionId?: string;
  artifactRevisionId?: string;
  selectedQuote?: string;
  selectedPage?: number;
}) {
  const t = useT();
  const [body, setBody] = useState("");
  const write = useWrite("/knowledge/annotations", () => setBody(""));
  return (
    <form
      className="annotation-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        write.mutate({
          projectId,
          conversationId,
          sourceVersionId,
          artifactRevisionId,
          body,
          page: f.get("page") ? Number(f.get("page")) : undefined,
          quote: f.get("quote") || undefined,
        });
      }}
    >
      <h3>{t("workspaceAnnotation")}</h3>
      <div className="annotation-context">
        <Field label={t("workspacePage")}>
          <Input
            type="number"
            min="1"
            name="page"
            key={selectedPage}
            defaultValue={selectedPage}
          />
        </Field>
        <Field label={t("workspaceSelection")}>
          <Input
            name="quote"
            key={selectedQuote}
            defaultValue={selectedQuote}
          />
        </Field>
      </div>
      <Field label={t("workspaceComment")}>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
        />
      </Field>
      <Button
        variant="outline"
        disabled={!conversationId || write.isPending || !body.trim()}
      >
        {t("workspacePostAnnotation")}
      </Button>
      {write.data && (
        <p role="status">
          {t("workspaceAnnotationSaved")}{" "}
          <Link
            to={`/projects/${projectId}?conversation=${conversationId}${write.data.message?.id ? `&message=${write.data.message.id}` : ""}`}
          >
            {t("workspaceConversation")}
          </Link>
        </p>
      )}
      {write.error && <Callout tone="error">{write.error.message}</Callout>}
    </form>
  );
}

function AffinityPublisherPreview({
  projectId,
  fileId,
  version,
  fileName,
}: {
  projectId: string;
  fileId: string;
  version: number;
  fileName: string;
}) {
  const t = useT();
  const [unavailable, setUnavailable] = useState(false);

  if (unavailable) return <Callout>{t("workspaceUnsupportedPreview")}</Callout>;

  return (
    <img
      className="source-image affinity-publisher-preview"
      src={`/api/projects/${projectId}/files/${fileId}/versions/${version}/preview`}
      alt={`${t("workspaceAffinityPreview")}: ${fileName || t("source")}`}
      onError={() => setUnavailable(true)}
    />
  );
}

function VersionUpload({
  projectId,
  fileId,
}: {
  projectId: string;
  fileId: string;
}) {
  const t = useT();
  const upload = useMutation({
    mutationFn: (form: FormData) =>
      uploadFile(`/projects/${projectId}/files/${fileId}/versions`, form),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <details>
      <summary>{t("workspaceNewRevision")}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          upload.mutate(new FormData(e.currentTarget));
        }}
      >
        <Field label={t("file")}>
          <Input name="file" type="file" required />
        </Field>
        <Button variant="outline" disabled={upload.isPending}>
          {t("workspaceNewRevision")}
        </Button>
        {upload.error && <Callout tone="error">{upload.error.message}</Callout>}
      </form>
    </details>
  );
}

function SourceText({
  projectId,
  conversationId,
  versionId,
}: {
  projectId: string;
  conversationId?: string;
  versionId: string;
}) {
  const t = useT(),
    [params] = useSearchParams(),
    [page, setPage] = useState(Math.max(1, Number(params.get("page")) || 1)),
    [quote, setQuote] = useState(""),
    [selection, setSelection] = useState(""),
    [quotePage, setQuotePage] = useState<number>();
  const textRef = useRef<HTMLDivElement>(null);
  const source = useApi(
    `/knowledge/projects/${projectId}/sources/${versionId}/content?pageStart=${page}&pageEnd=${page}`,
  );
  const content = source.data?.content;
  useEffect(() => {
    const captureSelection = () => {
      const selected = window.getSelection();
      const root = textRef.current;
      if (
        !root ||
        !selected?.toString() ||
        !selected.anchorNode ||
        !selected.focusNode ||
        !root.contains(selected.anchorNode) ||
        !root.contains(selected.focusNode)
      )
        return;
      setSelection(selected.toString());
    };
    document.addEventListener("selectionchange", captureSelection);
    return () =>
      document.removeEventListener("selectionchange", captureSelection);
  }, [versionId, page]);
  return (
    <>
      <details open>
        <summary>{t("workspaceSourceText")}</summary>
        {source.isPending && <span>{t("loading")}</span>}
        {source.error && <Callout tone="error">{source.error.message}</Callout>}
        {content?.status === "available" ? (
          <>
            <div
              ref={textRef}
              className="source-text preserve-lines"
              tabIndex={0}
              onMouseUp={() =>
                setSelection(window.getSelection()?.toString() || "")
              }
              onKeyUp={() =>
                setSelection(window.getSelection()?.toString() || "")
              }
            >
              {content.text}
            </div>
            <div className="inline-actions">
              <Button
                variant="outline"
                disabled={!selection}
                onClick={() => {
                  setQuote(selection);
                  setQuotePage(page);
                }}
              >
                {t("workspaceUseSelection")}
              </Button>
              {content.coverage && (
                <>
                  <Button
                    variant="ghost"
                    disabled={page <= 1}
                    onClick={() => {
                      setPage(page - 1);
                      setSelection("");
                    }}
                  >
                    {t("workspacePreviousPage")}
                  </Button>
                  <span>
                    {page} / {content.coverage.totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    disabled={!content.coverage.nextPage}
                    onClick={() => {
                      setPage(content.coverage.nextPage);
                      setSelection("");
                    }}
                  >
                    {t("workspaceNextPage")}
                  </Button>
                </>
              )}
            </div>
            {content.coverage?.truncated && (
              <p className="muted text-ui-xs">{t("workspacePartialText")}</p>
            )}
          </>
        ) : (
          content && (
            <Callout>
              {content.reason || t("workspaceUnsupportedPreview")}
            </Callout>
          )
        )}
      </details>
      <Annotation
        projectId={projectId}
        conversationId={conversationId}
        sourceVersionId={versionId}
        selectedQuote={quote}
        selectedPage={quotePage || page}
      />
    </>
  );
}
