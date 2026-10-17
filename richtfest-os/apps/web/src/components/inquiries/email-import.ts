import type { InquiryDirection } from "./types";

export type ImportedEmail = { subject: string; body: string; occurredAt: string | null; direction: Exclude<InquiryDirection, "internal">; from: string; attachments: File[] };

const domain = (address: string | null | undefined) => address?.split("@")[1]?.toLowerCase() ?? null;
const isOwn = (address: string | null | undefined, ownAddress: string | null) =>
  Boolean(address && ownAddress && (address.toLowerCase() === ownAddress.toLowerCase() || domain(address) === domain(ownAddress)));
const validDate = (value: string | null | undefined) => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null; };

/** Classic Outlook's .msg export: same fields, read with an Outlook file reader loaded on demand. */
async function importOutlookMessage(file: File, ownAddress: string | null): Promise<ImportedEmail> {
  const { default: MsgReader } = await import("@kenjiuno/msgreader");
  const reader = new MsgReader(await file.arrayBuffer());
  const data = reader.getFileData();
  if (data.error) throw new Error(data.error);
  // Exchange senders carry an internal address; the SMTP address is the one that matches.
  const address = [data.senderSmtpAddress, data.senderEmail].find((value) => value?.includes("@")) ?? null;
  const attachments = (data.attachments ?? []).filter((attachment) => !attachment.attachmentHidden).flatMap((attachment) => {
    const content = reader.getAttachment(attachment);
    return content.fileName && content.content?.length ? [new File([new Uint8Array(content.content)], content.fileName, { type: attachment.attachMimeTag || "application/octet-stream" })] : [];
  });
  return {
    subject: data.subject?.trim() ?? "",
    body: (data.body?.trim() || (data.bodyHtml ? htmlText(data.bodyHtml) : "")).replace(/\r\n/g, "\n"),
    occurredAt: validDate(data.messageDeliveryTime ?? data.clientSubmitTime),
    direction: isOwn(address, ownAddress) ? "outgoing" : "incoming",
    from: data.senderName && address && data.senderName !== address ? `${data.senderName} <${address}>` : address ?? data.senderName ?? "",
    attachments,
  };
}

const htmlText = (html: string) => {
  const document = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li|tr|h\d)>/gi, "\n"), "text/html");
  return (document.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * Reads an exported email (.eml, or .msg from classic Outlook): subject, sending time, plain text and file
 * attachments. A message from the person's own address or domain counts as
 * sent, anything else as received. The parser loads only when an email is imported.
 */
export async function importEmail(file: File, ownAddress: string | null): Promise<ImportedEmail> {
  if (/\.msg$/i.test(file.name)) return importOutlookMessage(file, ownAddress);
  const { default: PostalMime } = await import("postal-mime");
  const email = await PostalMime.parse(await file.arrayBuffer());
  const from = email.from && "address" in email.from ? email.from : null;
  const own = isOwn(from?.address, ownAddress);
  const date = email.date ? new Date(email.date) : null;
  const attachments = email.attachments
    .filter((attachment) => attachment.filename && !attachment.related && attachment.disposition !== "inline")
    .map((attachment) => new File([attachment.content as ArrayBuffer], attachment.filename!, { type: attachment.mimeType }));
  return {
    subject: email.subject?.trim() ?? "",
    body: (email.text?.trim() || (email.html ? htmlText(email.html) : "")).replace(/\r\n/g, "\n"),
    occurredAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    direction: own ? "outgoing" : "incoming",
    from: from ? (from.name ? `${from.name} <${from.address}>` : from.address ?? "") : "",
    attachments,
  };
}
