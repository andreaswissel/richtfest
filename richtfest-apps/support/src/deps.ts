import type { SupportContext, SupportProposal, SupportSource } from "@richtfest/shared";

export type AppDeps = {
  db: any;
  tenantId: string;
  actorId: string;
  canManage: boolean;
  canRun: boolean;
  readiness: () => Promise<{ configured: boolean; provider: string }>;
  validateContext: (context: SupportContext) => Promise<SupportContext>;
  answer: (history: { role: string; body: string }[], context: SupportContext) => Promise<
    | { status: "unconfigured" }
    | { status: "completed"; summary: string; openui?: string | null; proposal: SupportProposal | null; sources: SupportSource[] }
  >;
  audit: (tx: any, action: string, entityType: string, entityId: string, metadata?: unknown) => Promise<void>;
};
