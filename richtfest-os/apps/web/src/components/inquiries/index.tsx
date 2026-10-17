import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, list, uploadFile, type RecordData } from "../../api";
import { queryClient, useApi } from "../../query";
import { useT } from "../../i18n";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Badge, Callout, Empty, Field, RowLink, Segmented, Table } from "../ui/primitives";
import { inquiryDirectionLabel, inquiryEntryKindLabel, inquiryStatusLabel } from "./labels";
import { inquiryLink, type InquiryDetail, type InquiryDirection, type InquiryEntry, type InquiryStatus, type InquirySummary } from "./types";
import { fieldLabel, optionLabel } from "../building-model/component-properties";
import { dataRequestText } from "../building-model/sound-insulation";
import { importEmail } from "./email-import";
import { CopyAddress, ForwardingInbox } from "./inbox";
import "./inquiries.css";

type T = ReturnType<typeof useT>;
const formatDate = (value: string | null | undefined, withTime = false) => {
  const date = value ? new Date(value) : null;
  return !date || Number.isNaN(date.getTime()) ? "" : withTime ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : date.toLocaleDateString();
};
const statusTone = (status: InquiryStatus) => status === "closed" ? "outline" : "secondary";
const progressText = (inquiry: Pick<InquirySummary, "progress">, t: T) => inquiry.progress
  ? t("buildingRequestProgress").replace("{answered}", String(inquiry.progress.answered)).replace("{total}", String(inquiry.progress.total)) : "—";
const invalidate = (projectId: string) => queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith(`/projects/${projectId}/`) });

/**
 * Inquiries to the architect, client or authorities: one ticket per question,
 * bundling the sent request with every email, call note and document received.
 */
export function Inquiries({ projectId, selectedId }: { projectId: string; selectedId: string | null }) {
  const t = useT();
  const query = useApi(`/projects/${projectId}/inquiries`);
  const inquiries = (query.data as InquirySummary[] | undefined) ?? [];
  const [creating, setCreating] = useState(false);
  return <div className="inquiries">
    <Section title={t("inquiries")} meta={<Button size="sm" variant="outline" onClick={() => setCreating((value) => !value)} aria-expanded={creating}>＋ {t("inquiryNew")}</Button>}>
      <ForwardingInbox projectId={projectId} inquiries={inquiries} t={t} />
      {creating && <NewInquiry projectId={projectId} t={t} onDone={() => setCreating(false)} />}
      {query.isError && <Callout tone="error">{(query.error as Error).message}</Callout>}
      {inquiries.length ? <Table headers={[t("inquiryTitle"), t("inquiryCounterpart"), t("inquiryStatus"), t("inquiryOutstanding"), t("inquiryUpdated")]}
        rows={inquiries.map((inquiry) => ({
          id: inquiry.id,
          sort: [inquiry.title, inquiry.counterpart, inquiry.status, String(inquiry.progress ? inquiry.progress.total - inquiry.progress.answered : -1), inquiry.updatedAt],
          cells: [
            <RowLink to={inquiryLink(projectId, inquiry.id)}>{inquiry.title}</RowLink>,
            inquiry.counterpart,
            <Badge variant={statusTone(inquiry.status)}>{inquiryStatusLabel(inquiry.status, t)}</Badge>,
            <span className="text-ui-xs">{progressText(inquiry, t)}</span>,
            <span className="text-ui-xs muted">{formatDate(inquiry.updatedAt)}</span>,
          ],
        }))} /> : !query.isPending && <Empty>{t("inquiriesEmpty")}</Empty>}
    </Section>
    {selectedId && <InquiryView key={selectedId} projectId={projectId} inquiryId={selectedId} t={t} />}
  </div>;
}

function NewInquiry({ projectId, t, onDone }: { projectId: string; t: T; onDone: () => void }) {
  const [title, setTitle] = useState(""), [counterpart, setCounterpart] = useState(""), [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () => api<RecordData>(`/projects/${projectId}/inquiries`, { kind: "general", title: title.trim(), counterpart: counterpart.trim(), request: body.trim() ? { subject: title.trim(), body } : null }),
    onSuccess: async () => { await invalidate(projectId); onDone(); },
  });
  return <form className="inquiry-form" onSubmit={(event) => { event.preventDefault(); if (title.trim() && counterpart.trim()) create.mutate(); }}>
    <div className="inquiry-form-row">
      <Field label={t("inquiryTitle")}><Input value={title} onChange={(event) => setTitle(event.target.value)} required /></Field>
      <Field label={t("inquiryCounterpart")} hint={t("inquiryCounterpartHint")}><Input value={counterpart} onChange={(event) => setCounterpart(event.target.value)} required /></Field>
    </div>
    <Field label={t("inquiryRequestBody")} hint={t("inquiryRequestBodyHint")}><Textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} /></Field>
    {create.isError && <Callout tone="error">{(create.error as Error).message}</Callout>}
    <div className="inline-actions"><Button type="submit" size="sm" disabled={create.isPending || !title.trim() || !counterpart.trim()}>{t("inquiryCreate")}</Button></div>
  </form>;
}

function InquiryView({ projectId, inquiryId, t }: { projectId: string; inquiryId: string; t: T }) {
  const path = `/projects/${projectId}/inquiries/${inquiryId}`;
  const query = useApi(path);
  const inquiry = query.data as InquiryDetail | undefined;
  const update = useMutation({
    mutationFn: (status: InquiryStatus) => api(path, { status }, "PATCH"),
    onSuccess: () => invalidate(projectId),
  });
  if (query.isError) return <Section title={t("inquiries")}><Callout tone={query.error instanceof ApiError && query.error.status === 404 ? "info" : "error"}>
    {query.error instanceof ApiError && query.error.status === 404 ? t("inquiryNotFound") : (query.error as Error).message}</Callout></Section>;
  if (!inquiry) return null;
  return <Section title={inquiry.title} meta={<div className="inline-actions">
    <Badge variant={statusTone(inquiry.status)}>{inquiryStatusLabel(inquiry.status, t)}</Badge>
    <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => update.mutate(inquiry.status === "closed" ? "open" : "closed")}>
      {inquiry.status === "closed" ? t("inquiryReopen") : t("inquiryClose")}</Button>
  </div>}>
    <dl className="inquiry-facts">
      <dt>{t("inquiryCounterpart")}</dt><dd>{inquiry.counterpart}</dd>
      {inquiry.replyAddress && <><dt>{t("inquiryReplyAddress")}</dt><dd className="inquiry-stack"><CopyAddress address={inquiry.replyAddress} t={t} />
        <span className="muted text-ui-xs">{t("inquiryReplyAddressHint")}</span></dd></>}
      <dt>{t("inquiryKind")}</dt>
      <dd>{inquiry.kind === "component_data" ? t("inquiryKindComponentData") : t("inquiryKindGeneral")}</dd>
      {inquiry.progress && <>
        <dt>{t("inquiryOutstanding")}</dt>
        <dd className="inquiry-stack">
          <span>{progressText(inquiry, t)}</span>
          {inquiry.progress.outstanding.length ? inquiry.progress.outstanding.map((group) => <span key={`${group.componentType}:${group.wallRole}`} className="muted text-ui-xs">
            {group.componentType === "ceiling" ? t("buildingSoundCeilings") : group.wallRole ? optionLabel("wallRole", group.wallRole, t) : t("buildingSoundWallsWithoutRole")}: {group.fields.map((field) => fieldLabel(field.field, t)).join(", ")}
          </span>) : <span className="muted text-ui-xs">{t("inquiryAllAnswered")}</span>}
          <Link className="text-ui-xs" to={`/projects/${projectId}?view=building-model`}>{t("inquiryOpenModel")} →</Link>
        </dd>
      </>}
    </dl>
    {inquiry.followUp?.length > 0 && inquiry.status !== "closed" && <FollowUp projectId={projectId} inquiry={inquiry} t={t} />}
    <h3 className="inquiry-subtitle">{t("inquiryTimeline")}</h3>
    {inquiry.entries.length ? <ol className="inquiry-timeline">
      {inquiry.entries.map((entry) => <EntryItem key={entry.id} projectId={projectId} inquiry={inquiry} entry={entry} t={t} />)}
    </ol> : <p className="muted text-ui-xs">{t("inquiryTimelineEmpty")}</p>}
    <NewEntry projectId={projectId} path={path} t={t} />
  </Section>;
}

/** What is still open after the replies so far, as a follow-up to copy into an email and log once sent. */
function FollowUp({ projectId, inquiry, t }: { projectId: string; inquiry: InquiryDetail; t: T }) {
  const text = dataRequestText(inquiry.followUp, t, t("inquiryFollowUpIntro"));
  const [copied, setCopied] = useState(false);
  const log = useMutation({
    mutationFn: () => api(`/projects/${projectId}/inquiries/${inquiry.id}/entries`, { kind: "email", direction: "outgoing", subject: `${t("inquiryFollowUpSubject")}: ${inquiry.title}`, body: text }),
    onSuccess: () => invalidate(projectId),
  });
  return <>
    <h3 className="inquiry-subtitle">{t("inquiryFollowUp")}</h3>
    <p className="inquiry-entry-body inquiry-followup">{text}</p>
    <div className="inline-actions">
      <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>{copied ? t("inquiryAddressCopied") : t("inquiryFollowUpCopy")}</Button>
      <Button size="sm" variant="ghost" disabled={log.isPending} onClick={() => log.mutate()}>{t("inquiryFollowUpLog")}</Button>
      <span className="muted text-ui-xs">{t("inquiryFollowUpHint")}</span>
    </div>
    {log.isError && <Callout tone="error">{(log.error as Error).message}</Callout>}
  </>;
}

function EntryItem({ projectId, inquiry, entry, t }: { projectId: string; inquiry: InquiryDetail; entry: InquiryEntry; t: T }) {
  const read = useMutation({
    mutationFn: async () => {
      const raw = await api<RecordData>(`/projects/${projectId}/building-model`);
      const revision = Number((raw.model && typeof raw.model === "object" ? raw.model : raw).revision ?? 0);
      return api<{ summary: { statements: number; proposals: number } }>(`/projects/${projectId}/inquiries/${inquiry.id}/entries/${entry.id}/read-components`, { baseRevision: revision });
    },
    onSuccess: () => invalidate(projectId),
  });
  return <li className={`inquiry-entry inquiry-entry-${entry.direction}`}>
    <div className="inquiry-entry-head">
      <strong>{inquiryEntryKindLabel(entry.kind, t)}</strong>
      <span className="muted">{inquiryDirectionLabel(entry.direction, t)} · {formatDate(entry.occurredAt, true)}</span>
      {entry.subject && <span className="inquiry-entry-subject">{entry.subject}</span>}
      {entry.inboundEmailId && <Badge variant="outline">{t("inquiryViaForwarding")}</Badge>}
    </div>
    {entry.body && <p className="inquiry-entry-body">{entry.body}</p>}
    {entry.fileId && <Link className="text-ui-xs" to={`/projects/${projectId}?view=sources&file=${entry.fileId}`}>{entry.fileName ?? t("inquiryEntryDocument")}</Link>}
    {inquiry.kind === "component_data" && entry.direction === "incoming" && <div className="inline-actions">
      <Button size="xs" variant="outline" disabled={read.isPending} onClick={() => read.mutate()}>{t("inquiryReadComponents")}</Button>
      {read.data && <span className="muted text-ui-xs" role="status">{t("inquiryReadResult").replace("{statements}", String(read.data.summary.statements)).replace("{proposals}", String(read.data.summary.proposals))}</span>}
      {read.isError && <span className="text-ui-xs" role="alert">{(read.error as Error).message}</span>}
    </div>}
  </li>;
}

const entryKinds = ["email", "call", "document", "note"] as const;
const toLocalInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function NewEntry({ projectId, path, t }: { projectId: string; path: string; t: T }) {
  const [kind, setKind] = useState<(typeof entryKinds)[number]>("email");
  const [direction, setDirection] = useState<Exclude<InquiryDirection, "internal">>("incoming");
  const [subject, setSubject] = useState(""), [body, setBody] = useState(""), [fileId, setFileId] = useState("_none"), [occurredAt, setOccurredAt] = useState<string | null>(null);
  const filesQuery = useApi(`/projects/${projectId}/files`);
  const files = list(filesQuery.data, "files");
  const me = useApi("/auth/me");
  const ownAddress: string | null = me.data?.user?.email ?? me.data?.email ?? null;
  const emailInput = useRef<HTMLInputElement>(null);
  // The original email and its attachments are kept in Sources; the form is filled for review before adding.
  const importMail = useMutation({
    mutationFn: async (file: File) => {
      const email = await importEmail(file, ownAddress);
      const upload = async (item: File) => { const form = new FormData(); form.set("file", item); form.set("label", ""); return uploadFile<{ id: string; name: string }>(`/projects/${projectId}/files`, form); };
      const original = await upload(file);
      const attachments = [];
      for (const attachment of email.attachments) attachments.push(await upload(attachment));
      return { email, original, attachments };
    },
    onSuccess: async ({ email, original, attachments }) => {
      setKind("email"); setDirection(email.direction); setSubject(email.subject); setBody(email.body);
      setOccurredAt(email.occurredAt ? toLocalInput(new Date(email.occurredAt)) : null);
      // A PDF attachment carries the content worth reading; the original email stays in Sources either way.
      setFileId((attachments.find((item) => /\.pdf$/i.test(item.name)) ?? original).id);
      await invalidate(projectId);
    },
  });
  const add = useMutation({
    mutationFn: () => api(`${path}/entries`, { kind, direction: kind === "note" ? "internal" : direction, subject: subject.trim() || null, body: body.trim() ? body : null,
      fileId: fileId === "_none" ? null : fileId, occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null }),
    onSuccess: async () => { setSubject(""); setBody(""); setFileId("_none"); setOccurredAt(null); await invalidate(projectId); },
  });
  // Without a chosen date the entry is dated when it is added.
  const ready = Boolean(body.trim() || fileId !== "_none") && (!occurredAt || !Number.isNaN(new Date(occurredAt).getTime()));
  return <form className="inquiry-form" onSubmit={(event) => { event.preventDefault(); if (ready) add.mutate(); }}>
    <h3 className="inquiry-subtitle">{t("inquiryAddEntry")}</h3>
    <div className="inline-actions">
      <input ref={emailInput} type="file" accept=".eml,.msg,message/rfc822,application/vnd.ms-outlook" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) importMail.mutate(file); }} />
      <Button type="button" size="sm" variant="outline" disabled={importMail.isPending} onClick={() => emailInput.current?.click()}>{t("inquiryImportEmail")}</Button>
      <span className="muted text-ui-xs" role="status">{importMail.isPending ? t("inquiryImportEmailPending")
        : importMail.data ? t("inquiryImportEmailDone").replace("{from}", importMail.data.email.from || "—").replace("{files}", [importMail.data.original, ...importMail.data.attachments].map((item) => item.name).join(", "))
        : t("inquiryImportEmailHint")}</span>
    </div>
    {importMail.isError && <Callout tone="error">{(importMail.error as Error).message}</Callout>}
    <div className="inquiry-form-row">
      <Field label={t("inquiryEntryKind")}><Segmented value={kind} onChange={(value) => setKind(value as typeof kind)} items={entryKinds.map((value) => ({ value, label: inquiryEntryKindLabel(value, t) }))} /></Field>
      <Field label={t("inquiryEntryDirection")}><Segmented value={kind === "note" ? "internal" : direction} onChange={(value) => setDirection(value as typeof direction)}
        items={kind === "note" ? [{ value: "internal", label: inquiryDirectionLabel("internal", t) }]
          : (["incoming", "outgoing"] as const).map((value) => ({ value, label: inquiryDirectionLabel(value, t) }))} /></Field>
      <Field label={t("inquiryEntryDate")}><Input type="datetime-local" value={occurredAt ?? toLocalInput(new Date())} onChange={(event) => setOccurredAt(event.target.value || null)} /></Field>
    </div>
    <Field label={t("inquiryEntrySubject")}><Input value={subject} onChange={(event) => setSubject(event.target.value)} /></Field>
    <Field label={t("inquiryEntryBody")} hint={t("inquiryEntryBodyHint")}><Textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} /></Field>
    <Field label={t("inquiryEntryFile")}>
      <NativeSelect value={fileId} onChange={(event) => setFileId(event.target.value)}>
        <option value="_none">{t("inquiryEntryNoFile")}</option>
        {files.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}
      </NativeSelect>
    </Field>
    {add.isError && <Callout tone="error">{(add.error as Error).message}</Callout>}
    <div className="inline-actions"><Button type="submit" size="sm" disabled={add.isPending || !ready}>{t("inquiryAddEntry")}</Button></div>
  </form>;
}
