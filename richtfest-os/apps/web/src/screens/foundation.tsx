import { DocumentTypeCell } from "../components/document-type";
import { EnvironmentSurveyButton } from "../components/location/environment-survey";
import { SourceDocumentInspector } from "../components/project-workspace/source-document-inspector";
import { AgentRuns } from "../components/agent-runs";
import { Activity } from "../components/activity";
import { CustomerForm } from "../components/crm/customer-form";
import { DeleteFile } from "../components/project-workspace/delete-file";
import type { CustomerInput } from "@richtfest/shared";
import { useMutation } from "@tanstack/react-query";
import { uploadFiles } from "../api";
import { queryClient } from "../query";
import { NativeSelect } from "../components/ui/native-select";
import { Button } from "../components/ui/button";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import "./shared-work.css";
import { list, type RecordData } from "../api";
import { useApi, useWrite } from "../query";
import { projectStatusLabel, useT } from "../i18n";
import { Page, PageHeader, Section } from "../components/layout";
import { Input, Textarea } from "../components/ui/input";
import { AddressSelect } from "../components/address-select";
import {
  Badge,
  Callout,
  Empty,
  Field,
  Form,
  Modal,
  RowLink,
  Table,
} from "../components/ui/primitives";
const values = (f: FormData) => Object.fromEntries(f.entries());
const projectValues = (f: FormData) => {
  const result = values(f);
  return {
    ...result,
    addressReference: JSON.parse(String(result.addressReference || "null")),
  };
};
export function LoadState({ query }: { query: ReturnType<typeof useApi> }) {
  const t = useT();
  if (query.isError)
    return (
      <Callout tone="error">
        {query.error.message}{" "}
        <Button variant="link" onClick={() => query.refetch()}>
          {t("retry")}
        </Button>
      </Callout>
    );
  if (query.isPending)
    return (
      <div className="loading-line" role="status">
        {t("loading")}
      </div>
    );
  return null;
}
export function ProjectTable({ projects }: { projects: RecordData[] }) {
  const t = useT();
  return projects.length ? (
    <Table
      headers={[t("project"), t("customer"), t("status")]}
      rows={projects.map((p) => ({
        id: p.id,
        sort: [p.name, p.customerName || "", p.status],
        cells: [
          <RowLink to={`/projects/${p.id}`}>{p.name}</RowLink>,
          p.customerName || "—",
          <Badge>{projectStatusLabel(p.status, t)}</Badge>,
        ],
      }))}
    />
  ) : (
    <Empty>{t("noProjects")}</Empty>
  );
}
export function Dashboard() {
  const t = useT(),
    query = useApi("/dashboard");
  const data = query.data;
  return (
    <Page>
      <PageHeader
        title={t("overview")}
        description={t("homeSubtitle")}
        actions={
          <Button asChild variant="default">
            <Link to="/projects?create=1">＋ {t("newProject")}</Link>
          </Button>
        }
      />
      <LoadState query={query} />
      {data && (
        <>
          <div className="overview-metrics">
            {[
              [t("projects"), list(data.projects).length],
              [
                t("assignedWork"),
                list(data.tasks || data.assignedTasks).length,
              ],
              [
                t("pendingReview"),
                list(data.pendingDrafts || data.pendingReview).length,
              ],
            ].map(([label, n]) => (
              <div className="metric-card" key={label}>
                <span>{label}</span>
                <strong>{n}</strong>
              </div>
            ))}
          </div>
          <Section
            title={t("projects")}
            meta={
              <Button asChild variant="link">
                <Link to="/projects">{t("allProjects")} ↗</Link>
              </Button>
            }
          >
            <ProjectTable projects={list(data.projects)} />
          </Section>
          <div className="split">
            <Section title={t("assignedWork")}>
              <WorkList
                items={list(data.tasks || data.assignedTasks)}
                empty={t("noWork")}
              />
            </Section>
            <Section title={t("pendingReview")}>
              <WorkList
                items={list(data.pendingDrafts || data.pendingReview)}
                empty={t("noReview")}
                knowledge
              />
            </Section>
          </div>
          <Section title={t("missingInfo")}>
            <WorkList
              items={list(data.missingInformation || data.missingInfo)}
              empty={t("noMissing")}
            />
          </Section>
        </>
      )}
    </Page>
  );
}
function WorkList({
  items,
  empty,
  knowledge = false,
}: {
  items: RecordData[];
  empty: string;
  knowledge?: boolean;
}) {
  return items.length ? (
    <div className="work-list">
      {items.map((item, i) => (
        <Link
          key={item.id || i}
          to={
            knowledge
              ? item.projectId
                ? `/projects/${item.projectId}?view=knowledge`
                : `/knowledge/${item.id}`
              : `/projects/${item.projectId}`
          }
        >
          <span>{item.title || item.name || item.message}</span>
          <span>↗</span>
        </Link>
      ))}
    </div>
  ) : (
    <Empty>{empty}</Empty>
  );
}
export function Projects() {
  const t = useT(),
    query = useApi("/projects"),
    customers = useApi("/crm/customers");
  const [create, setCreate] = useState(
    new URLSearchParams(location.search).has("create"),
  );
  const write = useWrite("/projects", () => setCreate(false));
  return (
    <Page>
      <PageHeader
        title={t("projects")}
        description={t("workspace")}
        actions={
          <Button variant="default" onClick={() => setCreate(true)}>
            ＋ {t("newProject")}
          </Button>
        }
      />
      <LoadState query={query} />
      {query.data && (
        <ProjectTable projects={list(query.data, "projects")} />
      )}{" "}
      {create && (
        <Modal title={t("newProject")} onClose={() => setCreate(false)}>
          <Form
            label={t("newProject")}
            pending={write.isPending}
            error={write.error}
            onSubmit={(f) => write.mutate(projectValues(f))}
          >
            <Field label={t("name")}>
              <Input autoFocus required name="name" />
            </Field>
            <Field label={t("customer")}>
              <NativeSelect name="customerId" required defaultValue="">
                <option value="" disabled>
                  {t("selectCustomer")}
                </option>
                {list(customers.data, "customers").map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <AddressSelect
              defaultValue={{
                street: null,
                postalCode: null,
                city: null,
                country: null,
                addressReference: null,
              }}
              disabled={write.isPending}
            />
            {!list(customers.data, "customers").length && (
              <Callout>
                <Link to="/customers">{t("newCustomer")} ↗</Link>
              </Callout>
            )}
          </Form>
        </Modal>
      )}
    </Page>
  );
}
export function Customers() {
  const t = useT(),
    query = useApi("/crm/customers");
  const [create, setCreate] = useState(false),
    [edit, setEdit] = useState<(CustomerInput & { id: string }) | null>(null),
    [contact, setContact] = useState<RecordData | null>(null);
  const contacts = useApi(`/crm/customers/${contact?.id}/contacts`, !!contact);
  const writeContact = useWrite(`/crm/customers/${contact?.id}/contacts`, () =>
    setContact(null),
  );
  return (
    <Page>
      <PageHeader
        title={t("customers")}
        description={t("workspace")}
        actions={
          <Button variant="default" onClick={() => setCreate(true)}>
            ＋ {t("newCustomer")}
          </Button>
        }
      />
      <LoadState query={query} />
      {query.data &&
        (list(query.data, "customers").length ? (
          <Table
            headers={[
              t("company"),
              t("customerAddress"),
              t("email"),
              t("contact"),
              t("manage"),
            ]}
            rows={list(query.data, "customers").map((c) => ({
              id: c.id,
              sort: [c.name, c.city || "", c.email || "", "", ""],
              cells: [
                <strong className="block max-w-56 whitespace-normal break-words">
                  {c.name}
                </strong>,
                <div className="min-w-32 max-w-56 whitespace-normal break-words">
                  {c.street && <div>{c.street}</div>}
                  {(c.postalCode || c.city) && (
                    <div>
                      {[c.postalCode, c.city].filter(Boolean).join(" ")}
                    </div>
                  )}
                  {c.country && <div>{c.country}</div>}
                  {!c.street && !c.postalCode && !c.city && !c.country && "—"}
                </div>,
                <span className="block max-w-48 whitespace-normal break-words">
                  {c.email || "—"}
                </span>,
                <Button variant="link" onClick={() => setContact(c)}>
                  {t("addContact")} ＋
                </Button>,
                <Button
                  variant="link"
                  aria-label={`${t("customerEdit")} · ${c.name}`}
                  onClick={() => setEdit(c as CustomerInput & { id: string })}
                >
                  {t("customerEdit")}
                </Button>,
              ],
            }))}
          />
        ) : (
          <Empty>{t("noCustomers")}</Empty>
        ))}
      {(create || edit) && (
        <Modal
          title={
            edit ? `${t("customerEdit")} · ${edit.name}` : t("newCustomer")
          }
          onClose={() => {
            setCreate(false);
            setEdit(null);
          }}
        >
          <CustomerForm
            customer={edit ?? undefined}
            onSaved={() => {
              setCreate(false);
              setEdit(null);
            }}
          />
        </Modal>
      )}
      {contact && (
        <Modal
          title={`${t("addContact")} · ${contact.name}`}
          onClose={() => setContact(null)}
        >
          <Activity entityType="customer" entityId={contact.id} />
          <div className="contacts-list">
            {list(contacts.data).map((c) => (
              <p key={c.id}>
                <strong>{c.name}</strong> · {c.email}
              </p>
            ))}
          </div>
          <Form
            label={t("addContact")}
            pending={writeContact.isPending}
            error={writeContact.error}
            onSubmit={(f) => writeContact.mutate(values(f))}
          >
            <Field label={t("name")}>
              <Input required autoFocus name="name" />
            </Field>
            <Field label={t("email")}>
              <Input required type="email" name="email" />
            </Field>
          </Form>
        </Modal>
      )}
    </Page>
  );
}
export function Sources({
  projectId,
  initial,
}: {
  projectId: string;
  initial: RecordData;
}) {
  const t = useT();
  const query = useApi(`/projects/${projectId}/files`);
  const [mode, setMode] = useState<"upload" | "link" | null>(null);
  const [selectedFileCount, setSelectedFileCount] = useState(0);
  const [inspectedSource, setInspectedSource] = useState<RecordData | null>(null);
  const [uploadResults, setUploadResults] = useState<
    Array<{
      name: string;
      status: "uploading" | "uploaded" | "failed";
      error?: string;
    }>
  >([]);
  const write = useWrite(`/projects/${projectId}/files`, () => setMode(null));
  const upload = useMutation({
    mutationFn: async (form: FormData) => {
      const files = form
        .getAll("files")
        .filter((value): value is File => value instanceof File);
      return uploadFiles(
        `/projects/${projectId}/files`,
        files,
        files.length === 1 ? String(form.get("label") || "") : "",
        setUploadResults,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
  const files = list(query.data || initial.files, "files");
  const purposeLabel = (purpose: string | undefined) =>
    t(
      purpose === "reference_report"
        ? "sourcePurposeReference"
        : purpose === "comparison_only"
          ? "sourcePurposeComparison"
          : "sourcePurposeEvidence",
    );
  return (
    <Section
      title={t("sources")}
      meta={
        <div className="inline-actions">
          <EnvironmentSurveyButton projectId={projectId} />
          <Button variant="link" onClick={() => setMode("link")}>
            {t("registerSource")}
          </Button>
          <Button
            onClick={() => {
              setUploadResults([]);
              setSelectedFileCount(0);
              upload.reset();
              setMode("upload");
            }}
          >
            ＋ {t("attachFile")}
          </Button>
        </div>
      }
    >
      <LoadState query={query} />
      {files.length ? (
        <Table
          headers={[
            t("sourceName"),
            t("documentType"),
            t("sourcePurpose"),
            t("fileSize"),
            t("version"),
            t("source"),
            t("sourceDocumentModel"),
          ]}
          rows={files.map((file) => ({
            id: file.id,
            sort: [
              file.name,
              file.documentType?.documentType || "",
              purposeLabel(file.purpose),
              String(file.sizeBytes || 0),
              String(file.version || 1),
              file.name,
            ],
            cells: [
              <strong>{file.name}</strong>,
              <DocumentTypeCell projectId={projectId} fileId={file.id} fileName={file.name} state={file.documentType} />,
              <Badge>{purposeLabel(file.purpose)}</Badge>,
              file.sizeBytes ? `${(file.sizeBytes / 1024).toFixed(1)} KB` : "—",
              <span className="mono">
                {file.version || file.sourceMetadata?.version || 1}
              </span>,
              <div className="inline-actions">
                <Button asChild variant="link">
                  <a
                    href={
                      file.downloadUrl
                        ? authorizedDownload(file.downloadUrl)
                        : safeUrl(file.sourceRef)
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {file.downloadUrl ? t("downloadFile") : t("viewSource")} ↗
                  </a>
                </Button>
                <DeleteFile
                  projectId={projectId}
                  fileId={file.id}
                  name={file.name}
                />
              </div>,
              file.versionId ? <Button variant="link" onClick={() => setInspectedSource(file)}>{t("sourceDocumentInspect")}</Button> : "—",
            ],
          }))}
        />
      ) : (
        !query.isPending && <Empty>{t("noSources")}</Empty>
      )}
      {inspectedSource && <SourceDocumentInspector key={inspectedSource.versionId} projectId={projectId} source={inspectedSource} onClose={() => setInspectedSource(null)} />}
      {mode === "upload" && (
        <Modal
          title={t("attachFile")}
          onClose={() => {
            if (!upload.isPending) setMode(null);
          }}
        >
          <Form
            label={
              uploadResults.length &&
              uploadResults.every((result) => result.status !== "uploading")
                ? t("close")
                : t("uploadFiles")
            }
            pending={upload.isPending}
            disabled={upload.isPending}
            onSubmit={(form) => {
              if (
                uploadResults.length &&
                uploadResults.every((result) => result.status !== "uploading")
              ) {
                setMode(null);
                return;
              }
              upload.mutate(form);
            }}
          >
            <Field label={t("files")}>
              <Input
                type="file"
                name="files"
                multiple
                required
                disabled={upload.isPending || uploadResults.length > 0}
                onChange={(event) => {
                  setUploadResults([]);
                  setSelectedFileCount(event.currentTarget.files?.length ?? 0);
                }}
              />
            </Field>
            {uploadResults.length > 0 && (
              <div className="grid gap-stack">
                <Callout>
                  {uploadResults.every(
                    (result) => result.status !== "uploading",
                  )
                    ? t("uploadFinished")
                    : `${t("uploadingFiles")} (${uploadResults.filter((result) => result.status !== "uploading").length}/${uploadResults.length})`}
                </Callout>
                <ul className="grid gap-stack">
                  {uploadResults.map((result, index) => (
                    <li key={`${result.name}-${index}`}>
                      <strong>{result.name}</strong> —{" "}
                      {result.status === "uploaded"
                        ? t("uploadSuccess")
                        : result.status === "failed"
                          ? `${t("uploadFailed")}: ${result.error}`
                          : t("uploadingFiles")}
                    </li>
                  ))}
                </ul>
                {uploadResults.some((result) => result.status === "uploaded" && /\.pdf$/i.test(result.name)) && uploadResults.every((result) => result.status !== "uploading") && (
                  <Callout>
                    <div className="grid gap-stack">
                      <div><strong>{t("uploadPlanAnalysisStarted")}</strong><p className="muted text-ui-xs">{t("uploadPlanAnalysisDescription")}</p></div>
                      <Button asChild variant="outline"><Link to={`/projects/${projectId}?view=building-model`}>{t("uploadOpenBuildingModel")}</Link></Button>
                    </div>
                  </Callout>
                )}
              </div>
            )}
            {!uploadResults.length && selectedFileCount <= 1 && (
              <Field label={t("fileLabel")}>
                <Input name="label" />
              </Field>
            )}
          </Form>
        </Modal>
      )}
      {mode === "link" && (
        <Modal title={t("registerSource")} onClose={() => setMode(null)}>
          <Form
            label={t("registerSource")}
            pending={write.isPending}
            error={write.error}
            onSubmit={(form) =>
              write.mutate({
                name: form.get("name"),
                sourceType: "link",
                sourceRef: form.get("sourceUrl"),
                sourceMetadata: { version: form.get("version") },
              })
            }
          >
            <Callout>{t("sourceNote")}</Callout>
            <Field label={t("sourceName")}>
              <Input name="name" required autoFocus />
            </Field>
            <Field label={t("sourceUrl")}>
              <Input
                name="sourceUrl"
                type="url"
                required
                placeholder="https://"
              />
            </Field>
            <Field label={t("version")}>
              <Input name="version" defaultValue="1" required />
            </Field>
          </Form>
        </Modal>
      )}
    </Section>
  );
}
function authorizedDownload(value: string) {
  return value.startsWith("/api/") && !value.includes("\\") ? value : undefined;
}
function safeUrl(url: unknown) {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}
export function SharedWork({
  projectId,
  conversationId,
  tasks,
  runs,
}: {
  projectId: string;
  conversationId: string;
  tasks: RecordData[];
  runs: RecordData[];
}) {
  const t = useT();
  const [create, setCreate] = useState(false);
  const taskWrite = useWrite("/knowledge/tasks", () => setCreate(false));
  return (
    <div className="shared-work-view">
      <Section
        title={t("sharedWork")}
        meta={
          <Button variant="outline" size="sm" onClick={() => setCreate(true)}>
            {t("addTask")}
          </Button>
        }
      >
        <div className="shared-work-tasks">
          {tasks.map((task) => (
            <details
              className="shared-work-task"
              data-status={task.status}
              key={task.id}
            >
              <summary>
                <span className="shared-work-task-title">{task.title}</span>
                <Badge>
                  {t(`task_${task.status}` as never) || task.status}
                </Badge>
                <ChevronRight className="size-icon-sm" aria-hidden="true" />
              </summary>
              <p className="shared-work-task-instructions">
                {runs.find((run) => run.taskId === task.id)?.goal || task.title}
              </p>
            </details>
          ))}
        </div>
        {!tasks.length && <Empty>{t("noWork")}</Empty>}
      </Section>
      <AgentRuns
        projectId={projectId}
        conversationId={conversationId}
        initialRuns={runs}
      />
      {create && (
        <Modal title={t("addTask")} onClose={() => setCreate(false)}>
          <Form
            label={t("addTask")}
            pending={taskWrite.isPending}
            error={taskWrite.error}
            onSubmit={(form) =>
              taskWrite.mutate({
                ...values(form),
                projectId,
                conversationId,
              })
            }
          >
            <Field label={t("taskTitle")}>
              <Input name="title" required autoFocus />
            </Field>
            <Field label={t("assignTo")}>
              <NativeSelect name="assigneeType">
                <option value="user">{t("yourself")}</option>
                <option value="agent">{t("agent")}</option>
              </NativeSelect>
            </Field>
          </Form>
        </Modal>
      )}
    </div>
  );
}
export function Knowledge({ projectId }: { projectId: string }) {
  const t = useT(),
    query = useApi(`/knowledge/drafts?projectId=${projectId}`),
    files = useApi(`/projects/${projectId}/files`),
    [create, setCreate] = useState(false),
    write = useWrite("/knowledge/drafts", () => setCreate(false));
  return (
    <Section
      title={t("knowledge")}
      meta={
        <Button onClick={() => setCreate(true)}>＋ {t("manualDraft")}</Button>
      }
    >
      <LoadState query={query} />
      {list(query.data, "drafts").length ? (
        <div className="knowledge-list">
          {list(query.data, "drafts").map((d) => (
            <Draft key={d.id} draft={d} />
          ))}
        </div>
      ) : (
        !query.isPending && <Empty>{t("noKnowledge")}</Empty>
      )}
      {create && (
        <Modal title={t("manualDraft")} onClose={() => setCreate(false)}>
          {list(files.data, "files").length ? (
            <Form
              label={t("manualDraft")}
              pending={write.isPending}
              error={write.error}
              onSubmit={(f) =>
                write.mutate({
                  title: f.get("title"),
                  body: f.get("content"),
                  projectId,
                  sourceRefs: [f.get("sourceFileId")],
                })
              }
            >
              <Callout>{t("draftNote")}</Callout>
              <Field label={t("title")}>
                <Input name="title" required autoFocus />
              </Field>
              <Field label={t("source")}>
                <NativeSelect name="sourceFileId" required defaultValue="">
                  <option value="" disabled>
                    {t("chooseSource")}
                  </option>
                  {list(files.data, "files").map((f) => (
                    <option value={f.id} key={f.id}>
                      {f.name || f.title} · {f.version}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={t("content")}>
                <Textarea name="content" required />
              </Field>
            </Form>
          ) : (
            <Callout>{t("sourceRequired")}</Callout>
          )}
        </Modal>
      )}
    </Section>
  );
}
function Draft({ draft }: { draft: RecordData }) {
  const t = useT(),
    write = useWrite(`/knowledge/drafts/${draft.id}/approve`);
  const sourceRefs = Array.isArray(draft.sourceRefs) ? draft.sourceRefs : [];
  const reviewedRefs = sourceRefs.filter(
    (ref) => ref && typeof ref === "object" && ref.kind === "source_version",
  );
  const manualRefs = sourceRefs.filter((ref) => typeof ref === "string");
  return (
    <article className="knowledge-item">
      <div className="knowledge-meta">
        <Badge tone={draft.status === "approved" ? "success" : "neutral"}>
          {draft.status === "approved" ? t("approved") : t("draft")}
        </Badge>
        <span className="mono">
          {reviewedRefs.length ? t("reviewedSourceFinding") : t("manualLabel")}
        </span>
      </div>
      <h3>{draft.title}</h3>
      <p className="preserve-lines">{draft.body || draft.content}</p>
      <div className="knowledge-bottom">
        <span className="muted">
          {t("sourceLinked")} ·{" "}
          {reviewedRefs.length ? (
            reviewedRefs.map((ref, index) => (
              <span key={ref.sourceVersionId}>
                {index > 0 ? ", " : ""}
                <Link
                  className="mono"
                  to={`/projects/${draft.projectId}?panel=documents&sourceVersion=${ref.sourceVersionId}`}
                >
                  {t("sourceRevision")} · {ref.sourceVersionId}
                </Link>
              </span>
            ))
          ) : (
            <span className="mono">
              {draft.sourceName ||
                manualRefs.join(", ") ||
                draft.sourceFileId ||
                draft.sourceId}
            </span>
          )}
        </span>
        {draft.status !== "approved" && (
          <Button disabled={write.isPending} onClick={() => write.mutate({})}>
            ✓ {t("approve")}
          </Button>
        )}
      </div>
      {draft.status !== "approved" && (
        <small className="muted">{t("reviewNote")}</small>
      )}
      {write.error && <Callout tone="error">{write.error.message}</Callout>}
      <Activity entityType="draft" entityId={draft.id} />
    </article>
  );
}
