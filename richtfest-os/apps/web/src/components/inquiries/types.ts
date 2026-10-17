import type { ComponentRequestGroup, DataRequestProgress, NoiseRequestItem, NoiseRequestProgress } from "@richtfest/shared";

export type InquiryStatus = "open" | "waiting" | "answered" | "closed";
export type InquiryEntryKind = "request" | "email" | "call" | "note" | "document";
export type InquiryDirection = "outgoing" | "incoming" | "internal";

export type InquirySummary = {
  id: string; kind: "component_data" | "noise_data" | "general"; title: string; counterpart: string; status: InquiryStatus;
  items: ComponentRequestGroup[] | NoiseRequestItem[]; createdAt: string; updatedAt: string; closedAt: string | null;
  entryCount: number; progress: DataRequestProgress | NoiseRequestProgress | null;
};
export type InquiryEntry = {
  id: string; kind: InquiryEntryKind; direction: InquiryDirection; subject: string | null; body: string | null;
  fileId: string | null; fileName: string | null; occurredAt: string; createdBy: string; inboundEmailId?: string | null;
};
export type InquiryDetail = Omit<InquirySummary, "entryCount"> & { entries: InquiryEntry[]; replyAddress: string | null; followUp: ComponentRequestGroup[] };

export const inquiryLink = (projectId: string, inquiryId: string) => `/projects/${projectId}?view=inquiries&inquiry=${inquiryId}`;
