import { AgentRuns } from "../components/agent-runs";
import { Activity } from "../components/activity";
import { useMutation } from "@tanstack/react-query";
import { uploadFiles } from "../api";
import { queryClient } from "../query";
import { NativeSelect } from "../components/ui/native-select";
import { Button } from "../components/ui/button";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import "./shared-work.css";
import { list, type RecordData } from "../api";
import { useApi, useWrite } from "../query";
import { useT } from "../i18n";
import { Page, PageHeader, Section } from "../components/layout";
import { Input, Textarea } from "../components/ui/input";
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
          <Badge>{p.status || t("active")}</Badge>,
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
function WorkList({ items, empty }: { items: RecordData[]; empty: string }) {
  return items.length ? (
    <div className="work-list">
      {items.map((item, i) => (
        <Link key={item.id || i} to={`/projects/${item.projectId}`}>
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
            onSubmit={(f) => write.mutate(values(f))}
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
    [contact, setContact] = useState<RecordData | null>(null);
  const contacts = useApi(`/crm/customers/${contact?.id}/contacts`, !!contact);
  const write = useWrite("/crm/customers", () => setCreate(false)),
    writeContact = useWrite(`/crm/customers/${contact?.id}/contacts`, () =>
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
            headers={[t("company"), t("contact"), t("email")]}
            rows={list(query.data, "customers").map((c) => ({
              id: c.id,
              sort: [c.name, c.contactName || "", c.email || ""],
              cells: [
                <strong>{c.name}</strong>,
                <Button variant="link" onClick={() => setContact(c)}>
                  {t("addContact")} ＋
                </Button>,
                c.email || "—",
              ],
            }))}
          />
        ) : (
          <Empty>{t("noCustomers")}</Empty>
        ))}
      {create && (
        <Modal title={t("newCustomer")} onClose={() => setCreate(false)}>
          <Form
            label={t("newCustomer")}
            pending={write.isPending}
            error={write.error}
            onSubmit={(f) => write.mutate(values(f))}
          >
            <Field label={t("company")}>
              <Input name="name" required autoFocus />
            </Field>
          </Form>
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
    onSuccess: (results) => {
      void queryClient.invalidateQueries();
      if (results.every((result) => result.status === "uploaded")) {
        setMode(null);
      }
    },
  });
  const files = list(query.data || initial.files, "files");
  return (
    <Section
      title={t("sources")}
      meta={
        <div className="inline-actions">
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
          headers={[t("sourceName"), t("fileSize"), t("version"), t("source")]}
          rows={files.map((file) => ({
            id: file.id,
            sort: [
              file.name,
              String(file.sizeBytes || 0),
              String(file.version || 1),
              file.name,
            ],
            cells: [
              <strong>{file.name}</strong>,
              file.sizeBytes ? `${(file.sizeBytes / 1024).toFixed(1)} KB` : "—",
              <span className="mono">
                {file.version || file.sourceMetadata?.version || 1}
              </span>,
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
              </Button>,
            ],
          }))}
        />
      ) : (
        !query.isPending && <Empty>{t("noSources")}</Empty>
      )}
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
export function SharedWork({ projectId }: { projectId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const query = useApi(`/knowledge/conversations?projectId=${projectId}`);
  const [create, setCreate] = useState(false);
  const [taskConversation, setTaskConversation] = useState<string | null>(null);
  const write = useWrite("/knowledge/conversations", (data) => {
    setCreate(false);
    navigate(
      `/projects/${projectId}?conversation=${encodeURIComponent(data.id)}`,
    );
  });
  const taskWrite = useWrite("/knowledge/tasks", () =>
    setTaskConversation(null),
  );
  const conversations = list(query.data, "conversations").filter(
    (conversation) => !conversation.archivedAt,
  );
  return (
    <div className="shared-work-view">
      <Section
        title={t("sharedWorkConversations")}
        meta={
          <Button onClick={() => setCreate(true)}>
            ＋ {t("startConversation")}
          </Button>
        }
      >
        <LoadState query={query} />
        {conversations.length ? (
          <ul className="shared-conversation-list">
            {conversations.map((conversation) => (
              <li className="shared-conversation-row" key={conversation.id}>
                <Link
                  className="shared-conversation-link"
                  to={`/projects/${projectId}?conversation=${encodeURIComponent(conversation.id)}`}
                >
                  <MessageSquare
                    className="size-icon muted"
                    aria-hidden="true"
                  />
                  <span className="shared-conversation-title">
                    {conversation.title}
                  </span>
                  <ArrowUpRight
                    className="size-icon-sm muted"
                    aria-hidden="true"
                  />
                </Link>
                <Button
                  variant="ghost"
                  onClick={() => setTaskConversation(conversation.id)}
                >
                  {t("addTask")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          !query.isPending &&
          !query.error && <Empty>{t("noConversations")}</Empty>
        )}
      </Section>
      <AgentRuns projectId={projectId} />
      {create && (
        <Modal title={t("startConversation")} onClose={() => setCreate(false)}>
          <Form
            label={t("startConversation")}
            pending={write.isPending}
            error={write.error}
            onSubmit={(form) => write.mutate({ ...values(form), projectId })}
          >
            <Field label={t("title")}>
              <Input autoFocus required name="title" />
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
      {taskConversation && (
        <Modal title={t("addTask")} onClose={() => setTaskConversation(null)}>
          <Form
            label={t("addTask")}
            pending={taskWrite.isPending}
            error={taskWrite.error}
            onSubmit={(form) =>
              taskWrite.mutate({
                ...values(form),
                projectId,
                conversationId: taskConversation,
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
