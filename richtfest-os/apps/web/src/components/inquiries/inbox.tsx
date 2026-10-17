import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api";
import { queryClient, useApi } from "../../query";
import type { useT } from "../../i18n";
import { Section } from "../layout";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { Callout } from "../ui/primitives";
import { inquiryDirectionLabel } from "./labels";
import type { InquirySummary } from "./types";

type T = ReturnType<typeof useT>;
type InboundEmail = { id: string; fromAddress: string | null; fromName: string | null; direction: "incoming" | "outgoing"; subject: string | null; body: string | null;
  receivedAt: string; fileId: string | null; attachments: Array<{ fileId: string; name: string | null }> };
const invalidate = (projectId: string) => queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith(`/projects/${projectId}/`) });
const formatDate = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); };

/** Copies a forwarding address; the button confirms in place. */
export function CopyAddress({ address, t }: { address: string; t: T }) {
  const [copied, setCopied] = useState(false);
  return <span className="inquiry-address">
    <code>{address}</code>
    <Button type="button" size="xs" variant="ghost" onClick={() => void navigator.clipboard.writeText(address).then(() => setCopied(true))}>{copied ? t("inquiryAddressCopied") : t("inquiryAddressCopy")}</Button>
  </span>;
}

/** The project's forwarding address and the emails sent to it that no inquiry claimed yet. */
export function ForwardingInbox({ projectId, inquiries, t }: { projectId: string; inquiries: InquirySummary[]; t: T }) {
  const mailbox = useApi(`/projects/${projectId}/inbound-mailbox`);
  const config = mailbox.data as { configured: boolean; address: string | null; unfiled: InboundEmail[] } | undefined;
  const emails = config?.unfiled ?? [];
  const create = useMutation({ mutationFn: () => api(`/projects/${projectId}/inbound-mailbox`, {}), onSuccess: () => invalidate(projectId) });
  if (!config) return null;
  return <>
    <div className="inquiry-forwarding">
      <span className="muted text-ui-xs">{t("inquiryForwardingAddress")}</span>
      {!config.configured ? <span className="muted text-ui-xs">{t("inquiryForwardingUnconfigured")}</span>
        : config.address ? <><CopyAddress address={config.address} t={t} /><span className="muted text-ui-xs">{t("inquiryForwardingHint")}</span></>
        : <Button size="xs" variant="outline" disabled={create.isPending} onClick={() => create.mutate()}>{t("inquiryForwardingCreate")}</Button>}
    </div>
    {create.isError && <Callout tone="error">{(create.error as Error).message}</Callout>}
    {emails.length > 0 && <div className="inquiry-inbox"><Section title={`${t("inquiryInbox")} · ${emails.length}`}>
      <ol className="inquiry-timeline">
        {emails.map((email) => <InboxItem key={email.id} projectId={projectId} email={email} inquiries={inquiries} t={t} />)}
      </ol>
    </Section></div>}
  </>;
}

function InboxItem({ projectId, email, inquiries, t }: { projectId: string; email: InboundEmail; inquiries: InquirySummary[]; t: T }) {
  const open = inquiries.filter((inquiry) => inquiry.status !== "closed");
  // No preselection: filing into the wrong inquiry is worse than one more click.
  const [target, setTarget] = useState("_none");
  const act = useMutation({
    mutationFn: (action: "file" | "dismiss") => api(`/projects/${projectId}/inbound-emails/${email.id}/${action}`, action === "file" ? { inquiryId: target } : {}),
    onSuccess: () => invalidate(projectId),
  });
  return <li className={`inquiry-entry inquiry-entry-${email.direction}`}>
    <div className="inquiry-entry-head">
      <strong>{email.fromName || email.fromAddress || "—"}</strong>
      <span className="muted">{inquiryDirectionLabel(email.direction, t)} · {formatDate(email.receivedAt)}</span>
      {email.subject && <span className="inquiry-entry-subject">{email.subject}</span>}
    </div>
    {email.body && <p className="inquiry-entry-body inquiry-entry-preview">{email.body}</p>}
    <div className="inline-actions text-ui-xs">
      {[{ fileId: email.fileId, name: t("inquiryOriginalEmail") }, ...email.attachments].filter((file) => file.fileId).map((file) =>
        <Link key={file.fileId} to={`/projects/${projectId}?view=sources&file=${file.fileId}`}>{file.name ?? file.fileId}</Link>)}
    </div>
    <div className="inline-actions">
      <NativeSelect size="sm" aria-label={t("inquiryFileTo")} value={target} disabled={act.isPending} onChange={(event) => setTarget(event.target.value)}>
        <option value="_none" disabled>{t("inquiryFileTo")}</option>
        {open.map((inquiry) => <option key={inquiry.id} value={inquiry.id}>{inquiry.title} · {inquiry.counterpart}</option>)}
      </NativeSelect>
      <Button size="xs" variant="outline" disabled={act.isPending || target === "_none"} onClick={() => act.mutate("file")}>{t("inquiryFileEmail")}</Button>
      <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => act.mutate("dismiss")}>{t("inquiryDismissEmail")}</Button>
      {act.isError && <span className="text-ui-xs" role="alert">{(act.error as Error).message}</span>}
    </div>
  </li>;
}
