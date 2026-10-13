import type { PermissionKey, AgentPresetSnapshot, AgentProvider, SourceReference, AgentExecutionLimits, AcousticCalculationInput, AcousticCalculationResult, AcousticCalculationReceipt } from "@richtfest/shared";

/** Only these structural facts may cross the provider/event boundary. */
export function sanitizeProviderDiagnostics(raw: unknown) {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const ids = ["STRUCTURED_OUTPUT_TRUNCATED", "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", "STRUCTURED_OUTPUT_OBJECT_UNDEFINED", "OBJECT_UNDEFINED", "CONTEXT_BUDGET_EXCEEDED", "SOURCE_CITATION_OUT_OF_SCOPE"];
  const finishes = ["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"];
  const keys = ["tasks", "role", "goal", "sourceVersionIds", "summary", "rationale", "document", "content", "title", "citations", "decision", "revisions", "taskId", "findings", "severity", "issue", "recommendation",
    "messages", "recipientRunId", "body", "replyToMessageId",
    "template", "id", "version", "language", "project", "sections", "key", "sources", "attachments", "pageStart", "pageEnd", "complete",
    "preliminaryRemarks", "exteriorNoiseAssessment", "planningLaw", "components", "plans", "sourcesAndRevisions", "openIssues", "calculationAppendix",
    "requirements", "verification", "buildingServices", "heatPumps", "protectionLevels", "scope", "measures", "entities"];
  const codes = ["invalid_type", "invalid_literal", "invalid_union", "invalid_union_discriminator", "invalid_enum_value", "unrecognized_keys", "invalid_arguments", "invalid_return_type", "invalid_date", "invalid_string", "too_small", "too_big", "invalid_intersection_types", "not_multiple_of", "not_finite", "custom"];
  const providerCodes = ["rate_limit_exceeded", "rate_limit_error", "insufficient_quota", "billing_hard_limit_reached", "overloaded_error"];
  const rateLimit: Partial<Record<"limitRequests" | "remainingRequests" | "limitTokens" | "remainingTokens" | "resetRequestsMs" | "resetTokensMs", number>> = {};
  if (value.rateLimit && typeof value.rateLimit === "object") {
    for (const key of ["limitRequests", "remainingRequests", "limitTokens", "remainingTokens", "resetRequestsMs", "resetTokensMs"] as const) {
      const number = (value.rateLimit as Record<string, unknown>)[key];
      if (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1e12) rateLimit[key] = number;
    }
  }
  const issues = Array.isArray(value.issues) ? value.issues.slice(0, 10).flatMap(rawIssue => {
    if (!rawIssue || typeof rawIssue !== "object") return [];
    const issue = rawIssue as Record<string, unknown>;
    if (!codes.includes(issue.code as string) || !Array.isArray(issue.path) || issue.path.length > 8
      || !issue.path.every(part => typeof part === "string" ? keys.includes(part) : typeof part === "number" && Number.isInteger(part) && part >= 0 && part <= 100)) return [];
    const limits: Partial<Record<"minimum" | "maximum" | "multipleOf", number>> = {};
    for (const key of ["minimum", "maximum", "multipleOf"] as const) {
      const number = issue[key];
      if (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 200000) limits[key] = number;
    }
    return [{ code: issue.code as string, path: issue.path as (string | number)[], ...limits,
      ...(issue.validation === "uuid" ? { validation: "uuid" as const } : {}),
    }];
  }) : [];
  const finishReason = value.finishReason && typeof value.finishReason === "object"
    ? (value.finishReason as Record<string, unknown>).unified : value.finishReason;
  // Keep the exact rejected identifiers, never arbitrary response text. Other
  // failures cannot attach citation payloads to their diagnostics.
  const rejectedCitations = value.errorId === "SOURCE_CITATION_OUT_OF_SCOPE" && Array.isArray(value.rejectedCitations)
    ? value.rejectedCitations.slice(0, 100).filter((id): id is string => typeof id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) : [];
  return {
    ...(ids.includes(value.errorId as string) ? { errorId: value.errorId as string } : {}),
    ...(rejectedCitations.length ? { rejectedCitations } : {}),
    ...(finishes.includes(finishReason as string) ? { finishReason: finishReason as string } : {}),
    ...(providerCodes.includes(value.providerCode as string) ? { providerCode: value.providerCode as string } : {}),
    ...(typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0 && value.retryAfterMs <= 1e12
      ? { retryAfterMs: value.retryAfterMs } : {}),
    ...(Object.keys(rateLimit).length ? { rateLimit } : {}),
    ...(issues.length ? { issues } : {}),
  };
}
export type AppDeps = {
  db: any;
  supervisorEnabled?: boolean;
  calculateAcoustics?: (input: AcousticCalculationInput) => AcousticCalculationResult;
  resolveSupervisorPreset?: (
    effort: "low" | "medium" | "high" | "ultra",
    provider: AgentProvider,
  ) => Promise<AgentPresetSnapshot>;
  executeSupervisor?: (input: {
    phase: "plan" | "specialist" | "review" | "independent_review";
    provider: AgentProvider;
    runId: string;
    goal: string;
    context: unknown;
    modelPolicy?: AgentPresetSnapshot;
    calculateAcoustics?: (input: AcousticCalculationInput, signal?: AbortSignal) => Promise<AcousticCalculationReceipt>;
    onSummaryDelta?: (delta: string) => Promise<void>;
    onUsage?: (usage: ProviderUsage) => Promise<void>;
    onRequest?: ProviderTelemetry["onRequest"];
    onResponse?: ProviderTelemetry["onResponse"];
    onPrepared?: ProviderTelemetry["onPrepared"];
  }) => Promise<ProviderResult>;
  cancelExecution: (runId: string) => void;
  providerConfigured: (provider: AgentProvider) => Promise<boolean>;
  resolveActiveProvider?: () => Promise<AgentProvider>;
  executeProvider: (input: ProviderRequest) => Promise<ProviderResult>;
  /** Generate a title from the first user message using the active provider. */
  generateConversationTitle?: (input: { message: string }) => Promise<string | null>;
  /** Tenant-private reviewed supplier references, never project-source citations. */
  componentContext?: (goal: string) => Promise<unknown>;
  listProjectSources: (projectId: string) => Promise<ProjectSourceInventory>;
  sourceReferences: (projectId: string, versionIds: string[]) => Promise<SourceReference[]>;
  /** Exact ready PDF version, scoped to the actor's tenant and project. */
  readSourcePdf?: (projectId: string, versionId: string) => Promise<Buffer | null>;
  resolveSource: (
    projectId: string,
    input: {
      fileId?: string;
      versionId?: string;
      query?: string;
      textQuery?: string;
      pageStart?: number;
      pageEnd?: number;
      entityKey?: string;
      modelOffset?: number;
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
  userNames?: (userIds: string[]) => Promise<Record<string, string>>;
  validateConversation: (conversationId: string) => Promise<boolean>;
};
export type ProviderRequest = {
  provider: AgentProvider;
  modelId?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  maxOutputTokens?: number;
  executionLimits?: AgentExecutionLimits;
  systemInstructions?: string;
  includeOpenUI?: boolean;
  goal: string;
  context: unknown;
  image?: { mediaType: "image/jpeg"; data: string };
  toolResults?: unknown[];
  runId?: string;
  onSummaryDelta?: (delta: string) => Promise<void>;
  onUsage?: (usage: ProviderUsage) => Promise<void>;
  onRequest?: ProviderTelemetry["onRequest"];
  onResponse?: ProviderTelemetry["onResponse"];
  onPrepared?: ProviderTelemetry["onPrepared"];
};
/** Allowlisted metadata only: never headers, credentials, raw prompts or SDK errors. */
export type ProviderExecutionSettings = {
  version: 1;
  adapter: "direct" | "mastra";
  adapterVersion: string;
  appRevision: string | null;
  modelId: string;
  requestedReasoningEffort: string | null;
  reasoningEffort: string | null;
  maxOutputTokens: number;
  maxSteps: number;
  maxRetries: number;
  timeoutMs: number;
  stream: boolean;
  store: boolean | null;
  instructionsHash: string;
  promptHash: string;
  outputSchemaHash: string | null;
  toolSchemaHash?: string;
};
export type ProviderResponseMetadata = {
  modelId: string | null;
  responseId: string | null;
  finishReason: string | null;
};
export type ProviderTelemetry = {
  onRequest?: (settings: ProviderExecutionSettings) => Promise<void>;
  onResponse?: (response: ProviderResponseMetadata) => Promise<void>;
  onUsage?: (usage: ProviderUsage) => Promise<void>;
  /** Sanitized model-visible input only. A hit skips inference, not application validation. */
  onPrepared?: (input: { version: 1; instructions: string; prompt: string; outputSchema?: unknown; tools?: unknown }) => Promise<{ output: unknown } | undefined>;
};
export type ProviderUsage = {
  provider: AgentProvider;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd?: number | null;
  pricingVersion?: string | null;
};
export type ProviderResult =
  | { status: "unconfigured" }
  | { status: "completed"; output: unknown; usage?: ProviderUsage };

/** Discovery metadata only; a source must be resolved before it can be cited. */
export type ProjectSourceInventory = {
  sources: {
    fileId: string;
    name: string;
    versionId: string;
    version: number;
    mimeType: string;
  }[];
  truncated: boolean;
  authority: "unreviewed_source_inventory";
};
