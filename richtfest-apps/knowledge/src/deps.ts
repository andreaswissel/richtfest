import type { PermissionKey, AgentPresetSnapshot, AgentProvider } from "@richtfest/shared";
export type AppDeps = {
  db: any;
  supervisorEnabled?: boolean;
  resolveSupervisorPreset?: (
    effort: "low" | "medium" | "high" | "ultra",
    provider: AgentProvider,
  ) => Promise<AgentPresetSnapshot>;
  executeSupervisor?: (input: {
    phase: "plan" | "specialist" | "review";
    provider: AgentProvider;
    runId: string;
    goal: string;
    context: unknown;
    modelPolicy?: AgentPresetSnapshot;
    onSummaryDelta?: (delta: string) => Promise<void>;
  }) => Promise<ProviderResult>;
  cancelExecution: (runId: string) => void;
  providerConfigured: (provider: AgentProvider) => Promise<boolean>;
  resolveActiveProvider?: () => Promise<AgentProvider>;
  executeProvider: (input: ProviderRequest) => Promise<ProviderResult>;
  /** Generate a title from the first user message using the active provider. */
  generateConversationTitle?: (input: { message: string }) => Promise<string | null>;
  resolveSource: (
    projectId: string,
    input: {
      fileId?: string;
      versionId?: string;
      query?: string;
      pageStart?: number;
      pageEnd?: number;
    },
  ) => Promise<unknown>;
  auditRun: (
    tx: any,
    action: string,
    entityType: string,
    entityId: string,
    runId: string,
    correlationId: string,
    metadata?: unknown,
  ) => Promise<void>;
  tenantId: string;
  actorId: string;
  requirePermission: (key: PermissionKey) => void;
  audit: (
    tx: any,
    action: string,
    entityType: string,
    entityId: string,
    metadata?: unknown,
  ) => Promise<void>;
  validateProject: (projectId: string) => Promise<boolean>;
  validateSource: (projectId: string, sourceId: string) => Promise<boolean>;
  validateSourceVersion: (
    projectId: string,
    versionId: string,
  ) => Promise<boolean>;
  validateUser: (userId: string) => Promise<boolean>;
  validateConversation: (conversationId: string) => Promise<boolean>;
};
export type ProviderRequest = {
  provider: AgentProvider;
  modelId?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  maxOutputTokens?: number;
  goal: string;
  context: unknown;
  toolResults?: unknown[];
  runId?: string;
  onSummaryDelta?: (delta: string) => Promise<void>;
};
export type ProviderResult =
  { status: "unconfigured" } | { status: "completed"; output: unknown };
