import { z } from "zod";

export const supportKind = z.enum(["bug", "feature"]);
export const supportStatus = z.enum(["open", "in_progress", "resolved"]);
// Paths only: never let a generated or submitted reference become an external link.
export const supportPath = z.string().max(500).regex(/^\/(?!\/)[^\\\s\u0000-\u001f]*$/);
export const supportProposal = z.object({
  kind: supportKind,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(12000),
  pagePath: supportPath.nullable().default(null),
});
export const supportAnswer = z.object({
  summary: z.string().trim().min(1).max(16000),
  openui: z.string().max(20000).nullable().optional(),
  proposal: supportProposal.nullable().default(null),
});
export type SupportProposal = z.infer<typeof supportProposal>;
export type SupportSource = { title: string; path: string };
export type SupportMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
  status: "completed" | "pending" | "failed" | "unconfigured";
  openui: string | null;
  proposal: SupportProposal | null;
  reportId: string | null;
  sources: SupportSource[];
  createdAt: string;
};
export type SupportReport = SupportProposal & {
  id: string;
  status: z.infer<typeof supportStatus>;
  conversationId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  url: string;
};
export type SupportConversation = { id: string; title: string; createdAt: string };
export type SupportOverview = {
  conversations: SupportConversation[];
  readiness: { configured: boolean; provider: string; canRun: boolean };
  canManage: boolean;
};
