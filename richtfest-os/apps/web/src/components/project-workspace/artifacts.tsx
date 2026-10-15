import { useState, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, list, uploadFile, type RecordData } from "../../api";
import { useApi, useWrite, queryClient } from "../../query";
import { useT } from "../../i18n";
import { SubagentList } from "./subagent-thread";
import { AffinityPdfPairing } from "./affinity-pdf-pairing";
import { DeleteFile } from "./delete-file";
import { AcousticScenario } from "./acoustic-scenario";
import {
  ArtifactSourceRegister,
  ArtifactExportActions,
} from "./artifact-export";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Empty, Field } from "../ui/primitives";
import { LazyOpenUI } from "./lazy-openui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { FileText, ExternalLink } from "lucide-react";
import { SharedWork } from "../../screens/foundation";
import {
  AnnotatedDocument,
  type DocumentSelection,
} from "./annotated-document";
import "./document-review.css";
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
  const [documentSelection, setDocumentSelection] =
    useState<DocumentSelection>();
  const [activeNote, setActiveNote] = useState<{ id: string }>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const reply = useWrite(`/knowledge/conversations/${conversationId}/messages`);
  const files = useApi(
    `/projects/${projectId}/files`,
    initialFiles === undefined,
  );
  const filesData = initialFiles ?? files.data;
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
  const approvedRevisionId = artifact.data?.artifact?.status === "approved"
    ? list(artifact.data?.revisions)[0]?.id : undefined;
  useEffect(() => {
    setDocumentSelection(undefined);
    setActiveNote(undefined);
  }, [revisionId]);
  const artifactConversationId = artifact.data?.artifact?.conversationId;
  const revisionNotes = list(artifact.data?.annotations).filter(
    (note) => note.artifactRevisionId === revisionId,
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
  const sourcePurpose = version?.purpose || selectedFile?.purpose || "project_evidence";
  const session = useApi("/auth/me");
  const canClassify = (session.data?.permissions || session.data?.user?.permissions || []).includes("projects:write");
  const classify = useMutation({
    mutationFn: (purpose: string) => api(`/projects/${projectId}/files/${fileId}/purpose`,
      { purpose, expectedPurpose: sourcePurpose }, "PATCH"),
    onSettled: () => queryClient.invalidateQueries(),
  });
  useEffect(() => { classify.reset(); }, [fileId]);
  const isAffinityPublisher = /\.afpub$/i.test(selectedFileName);
  const tab = artifactId
    ? "artifacts"
    : fileId || sourceVersion
      ? "documents"
      : params.get("panel") || "artifacts";
  const previewOpen = Boolean(artifactId || fileId || sourceVersion);
  const target = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates))
      v ? next.set(k, v) : next.delete(k);
    return `?${next}`;
  };
  const artifactCards = (
    <div className="artifact-gallery">
      {artifacts.map((a) => (
        <article className="artifact-preview-card" key={a.id}>
          <Link
            className="artifact-preview-link"
            to={target({
              panel: "artifacts",
              artifact: a.id,
              file: null,
              sourceVersion: null,
              revision: null,
            })}
          >
            <div className="artifact-card-heading">
              <FileText className="size-icon" aria-hidden="true" />
              <strong>{a.title}</strong>
            </div>
            <p className="artifact-card-excerpt">
              {a.preview || t("workspaceExportNoContent")}
            </p>
            <div className="artifact-card-meta">
              <Badge>
                {a.status === "approved" ? t("approved") : t("draft")}
              </Badge>
              <span>
                {t("version")} {a.version}
              </span>
            </div>
          </Link>
          {a.runId && (
            <Link
              className="artifact-run-link"
              to={target({
                artifact: null,
                revision: null,
                file: null,
                sourceVersion: null,
                agentRun: a.runId,
                conversation: a.conversationId,
              })}
            >
              {t("workspaceOriginRun")} · {a.runGoal || a.runId.slice(0, 8)}
            </Link>
          )}
        </article>
      ))}
      {!artifacts.length && <Empty>{t("workspaceNoThreadArtifacts")}</Empty>}
    </div>
  );
  const panelBody = (
    <div className="artifact-panel-body">
      {reply.error && <Callout tone="error">{reply.error.message}</Callout>}
      {reply.data && <p role="status">{t("workspaceInputSent")}</p>}
      {tab === "runs" ? (
        <SubagentList
          projectId={projectId}
          conversationId={conversationId}
          runs={runs.filter(
            (run) => conversationId && run.conversationId === conversationId,
          )}
        />
      ) : tab === "tasks" ? (
        conversationId ? (
          <SharedWork
            key={conversationId}
            projectId={projectId}
            conversationId={conversationId}
            tasks={tasks}
            runs={runs.filter((run) => run.conversationId === conversationId)}
          />
        ) : (
          <Empty>{t("noWork")}</Empty>
        )
      ) : tab === "documents" ? (
        <>
          {exactSource.error && (
            <Callout tone="error">{exactSource.error.message}</Callout>
          )}
          {files.error && <Callout tone="error">{files.error.message}</Callout>}
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
              {selectedFileName && (
                <DeleteFile key={fileId} projectId={projectId} fileId={fileId} name={selectedFileName}
                  onDeleted={() => setParams(target({ file: null, sourceVersion: null, page: null, panel: "documents" }).slice(1), { replace: true })} />
              )}
              {version && (
                <Field label={t("sourcePurpose")}>
                  <NativeSelect
                    value={sourcePurpose}
                    disabled={!canClassify || classify.isPending}
                    onChange={(event) => classify.mutate(event.target.value)}
                  >
                    <option value="project_evidence">{t("sourcePurposeEvidence")}</option>
                    <option value="reference_report">{t("sourcePurposeReference")}</option>
                    <option value="comparison_only">{t("sourcePurposeComparison")}</option>
                  </NativeSelect>
                  <span className="text-ui-xs text-muted-foreground">{t("sourcePurposeHint")}</span>
                </Field>
              )}
              {classify.error && <Callout tone="error">{classify.error.message}</Callout>}
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
                      <ExternalLink
                        className="size-icon-sm"
                        aria-hidden="true"
                      />{" "}
                      {t("workspaceOpenOriginal")} · {version.version}
                    </a>
                  </Button>
                  {isAffinityPublisher && version.status === "ready" && (
                    <AffinityPdfPairing
                      key={version.id}
                      projectId={projectId}
                      version={version}
                    />
                  )}
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
                      title={`${selectedFileName} · ${version.version}`}
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
                  <p className="muted text-ui-xs break-all">
                    {t("workspaceUnreviewedSource")} ·{" "}
                    {version.checksum || t("workspaceChecksumUnavailable")}
                  </p>
                  {sourcePurpose === "project_evidence" ? (
                    <SourceText
                      key={version.id}
                      projectId={projectId}
                      conversationId={conversationId}
                      versionId={version.id}
                    />
                  ) : (
                    <Callout>
                      {t(sourcePurpose === "comparison_only" ? "sourceComparisonOnly" : "sourceReferenceReport")}
                    </Callout>
                  )}
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
          {artifactQuery.error && (
            <Callout tone="error">{artifactQuery.error.message}</Callout>
          )}
          {!artifactId && artifactCards}
          {artifactId && (
            <>
              <Link to={target({ artifact: null, revision: null })}>
                ← {t("workspaceArtifacts")}
              </Link>
              <h3>{artifact.data?.artifact?.title}</h3>
              {artifact.data?.artifact?.runId && (
                <Link
                  to={target({
                    artifact: null,
                    revision: null,
                    agentRun: artifact.data.artifact.runId,
                    conversation: artifactConversationId,
                  })}
                >
                  {t("workspaceOriginRun")} ·{" "}
                  {artifact.data.artifact.runGoal ||
                    artifact.data.artifact.runId.slice(0, 8)}
                </Link>
              )}
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
                      {r.revision || r.version} · {r.id === approvedRevisionId ? t("approved") : r.status || t("draft")}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {revision ? (
                <div className="artifact-review-layout">
                  <div className="artifact-document-sheet">
                    <ArtifactExportActions
                      artifactId={artifactId}
                      revisionId={revision.id}
                    />
                    <Badge>
                      {revision.id === approvedRevisionId
                        ? t("approved")
                        : t("draft")}
                    </Badge>
                    <AcousticScenario
                      key={revision.id}
                      projectId={projectId}
                      artifactId={artifactId}
                      revisionId={revision.id}
                      title={revision.title}
                      payload={revision.payload?.acousticDataset}
                      approved={revision.id === approvedRevisionId}
                      onCreated={(id, revisionId) =>
                        setParams(
                          target({ artifact: id, revision: revisionId }).slice(
                            1,
                          ),
                        )
                      }
                    />
                    {revision.format === "openui" ||
                    artifact.data?.artifact?.type === "openui" ? (
                      <LazyOpenUI
                        projectId={projectId}
                        conversationId={artifactConversationId}
                        onReply={
                          artifactConversationId === conversationId &&
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
                    ) : (
                      <AnnotatedDocument
                        projectId={projectId}
                        revision={revision}
                        notes={revisionNotes}
                        activeNote={activeNote}
                        onSelect={setDocumentSelection}
                      />
                    )}
                    <ArtifactSourceRegister
                      projectId={projectId}
                      revision={revision}
                    />
                    {revision.id === approvedRevisionId ? (
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
                  </div>
                  <aside
                    className="artifact-comments"
                    aria-label={t("workspaceComments")}
                  >
                    <h3>
                      {t("workspaceComments")} · {t("version")}{" "}
                      {revision.version}
                    </h3>
                    <p className="text-ui-xs text-muted-foreground">
                      {t("workspaceCommentRunHint")}
                    </p>
                    {revisionNotes.map((a) => (
                      <article className="artifact-annotation" key={a.id}>
                        <div className="text-ui-xs text-muted-foreground">
                          {a.authorName || t("teamMember")}
                          {a.createdAt &&
                            !Number.isNaN(new Date(a.createdAt).getTime()) && (
                              <>
                                {" "}
                                ·{" "}
                                <time dateTime={a.createdAt}>
                                  {new Date(a.createdAt).toLocaleString()}
                                </time>
                              </>
                            )}
                        </div>
                        {a.quote &&
                          (a.selection ? (
                            <button
                              type="button"
                              className="annotation-quote-link"
                              onClick={() => setActiveNote({ id: a.id })}
                              title={t("workspaceShowPassage")}
                            >
                              <blockquote>{a.quote}</blockquote>
                            </button>
                          ) : (
                            <blockquote>{a.quote}</blockquote>
                          ))}
                        <p className="preserve-lines">{a.body}</p>
                        {artifactConversationId && a.messageId && (
                          <Link
                            to={`/projects/${projectId}?conversation=${artifactConversationId}&message=${a.messageId}`}
                          >
                            {t("workspaceContinueThread")}
                          </Link>
                        )}
                      </article>
                    ))}
                    <Annotation
                      key={revision.id}
                      projectId={projectId}
                      conversationId={artifactConversationId}
                      artifactRevisionId={revision.id}
                      selectedQuote={documentSelection?.quote}
                      selection={documentSelection?.selection}
                    />
                  </aside>
                </div>
              ) : (
                <Callout>{t("workspaceExactVersion")}</Callout>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
  const closePreview = () =>
    setParams(
      target({
        artifact: null,
        revision: null,
        file: null,
        sourceVersion: null,
        page: null,
      }).slice(1),
    );
  return (
    <aside
      className="project-artifacts"
      aria-label={t("workspaceThreadResources")}
    >
      <nav
        className="workspace-view-links thread-resource-tabs"
        aria-label={t("workspaceThreadResources")}
      >
        {(
          [
            ["artifacts", t("workspaceArtifacts"), artifacts.length],
            ["tasks", t("sharedWork"), tasks.length],
            ["runs", t("agentThreadList"), null],
            ["documents", t("sources"), null],
          ] as const
        ).map(([panel, label, count]) => {
          const next = new URLSearchParams({ panel });
          if (conversationId) next.set("conversation", conversationId);
          return (
            <Link
              key={panel}
              to={`?${next}`}
              aria-current={tab === panel ? "page" : undefined}
            >
              {label}
              {count !== null && <Badge tone="neutral">{count}</Badge>}
            </Link>
          );
        })}
      </nav>
      {previewOpen ? artifactCards : panelBody}
      <Dialog
        open={previewOpen}
        onOpenChange={(open) => {
          if (!open) closePreview();
        }}
      >
        <DialogContent
          className="document-review-dialog"
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected)
              returnFocus.current.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {artifactId
                ? artifact.data?.artifact?.title || t("workspaceArtifacts")
                : selectedFileName || t("source")}
            </DialogTitle>
          </DialogHeader>
          {panelBody}
        </DialogContent>
      </Dialog>
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
  selection,
}: {
  projectId: string;
  conversationId?: string;
  sourceVersionId?: string;
  artifactRevisionId?: string;
  selectedQuote?: string;
  selectedPage?: number;
  selection?: DocumentSelection["selection"];
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
          selection: f.get("quote") === selectedQuote ? selection : undefined,
        });
      }}
    >
      <h3>{t("workspaceAddComment")}</h3>
      <div className="annotation-context">
        {sourceVersionId && (
          <Field label={t("workspacePage")}>
            <Input
              type="number"
              min="1"
              name="page"
              key={selectedPage}
              defaultValue={selectedPage}
            />
          </Field>
        )}
        <Field label={t("workspaceSelection")}>
          <Textarea
            name="quote"
            rows={2}
            maxLength={10000}
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
            {t("workspaceContinueThread")}
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
  const sourcePath = `/knowledge/projects/${projectId}/sources/${versionId}/content?pageStart=${page}&pageEnd=${page}`;
  const source = useQuery({
    queryKey: [sourcePath],
    queryFn: () => api(sourcePath),
    refetchInterval: (query) =>
      query.state.data?.content?.status === "processing" ? 2000 : false,
  });
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
                  setQuotePage(content.coverage ? page : undefined);
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
            {content.truncated && (
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
        selectedPage={content?.coverage ? quotePage || page : undefined}
      />
    </>
  );
}
