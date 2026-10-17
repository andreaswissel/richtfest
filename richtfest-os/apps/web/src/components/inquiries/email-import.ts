import type { InquiryDirection } from "./types";

export type ImportedEmail = { subject: string; body: string; occurredAt: string | null; direction: Exclude<InquiryDirection, "internal">; from: string; attachments: File[] };

const htmlText = (html: string) => {
  const document = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li|tr|h\d)>/gi, "\n"), "text/html");
  return (document.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * Reads an exported email (.eml): subject, sending time, plain text and file
 * attachments. A message from the person's own address or domain counts as
 * sent, anything else as received. The parser loads only when an email is imported.
 */
export async function importEmail(file: File, ownAddress: string | null): Promise<ImportedEmail> {
  const { default: PostalMime } = await import("postal-mime");
  const email = await PostalMime.parse(await file.arrayBuffer());
  const from = email.from && "address" in email.from ? email.from : null;
  const domain = (address: string | null | undefined) => address?.split("@")[1]?.toLowerCase() ?? null;
  const own = Boolean(from?.address && ownAddress && (from.address.toLowerCase() === ownAddress.toLowerCase() || domain(from.address) === domain(ownAddress)));
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
