import type { PermissionKey, AgentPresetSnapshot, AgentProvider, SourceReference, AgentExecutionLimits, AcousticCalculationInput, AcousticCalculationResult, AcousticCalculationReceipt, CompanyKnowledgeSearch, CompanyKnowledgeReceipt, SourceVisualRequest, SourceVisual } from "@richtfest/shared";
import type { SourceImageInference, SourceImageQuery, SourceImageReceipt } from "@richtfest/shared";
import { acousticSectionKeySchema } from "@richtfest/shared";

/** Defense in depth; adapters also remove the actual credential and known input text. */
export function redactProviderDiagnosticText(text: string) {
  return text.replace(/\bsk-[a-zA-Z0-9_.*-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\b(api[_ -]?key|authorization|password|secret|access[_ -]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL omitted]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
}

/** Bounded diagnostic fields only, never complete exceptions, bodies or headers. */
export function sanitizeProviderDiagnostics(raw: unknown) {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const ids = ["STRUCTURED_OUTPUT_TRUNCATED", "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", "STRUCTURED_OUTPUT_OBJECT_UNDEFINED", "OBJECT_UNDEFINED", "CONTEXT_BUDGET_EXCEEDED", "SOURCE_CITATION_OUT_OF_SCOPE"];
  const finishes = ["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"];
  const keys = ["tasks", "role", "goal", "sourceVersionIds", "summary", "rationale", "document", "content", "title", "citations", "decision", "revisions", "taskId", "findings", "severity", "issue", "recommendation",
    "messages", "recipientRunId", "body", "replyToMessageId",
    "template", "id", "version", "language", "project", "sections", "key", "sources", "attachments", "pageStart", "pageEnd", "complete", "editorial",
    "preliminaryRemarks", "exteriorNoiseAssessment", "planningLaw", "components", "plans", "sourcesAndRevisions", "openIssues", "calculationAppendix",
    "requirements", "verification", "buildingServices", "heatPumps", "protectionLevels", "scope", "measures", "entities"];
  const acousticKeys = ["exteriorNoiseExtraction", "inventory", "rooms", "facts", "blockers", "roomId", "target", "id", "field", "value",
    "provenance", "kind", "versionId", "page", "excerpt", "reason", "standard", "room", "use", "floorAreaM2",
    "applicability", "assessment", "basis", "envelopeComplete", "facades", "areaM2", "noise", "metric", "levelDb",
    "fieldEvidence", "elementsComplete", "flanking", "elements", "facadeId", "ratingBasis", "configuration", "rwDb",
    "construction", "dnEWDb", "count", "openingAreaM2", "visualCandidates", "apartmentLabel", "roomLabel", "mapping",
    "receiptId", "imageHash", "crop", "reviewStatus", "x", "y", "width", "height"];
  const codes = ["invalid_type", "invalid_literal", "invalid_union", "invalid_union_discriminator", "invalid_enum_value", "unrecognized_keys", "invalid_arguments", "invalid_return_type", "invalid_date", "invalid_string", "too_small", "too_big", "invalid_intersection_types", "not_multiple_of", "not_finite", "custom"];
  const providerCodes = ["rate_limit_exceeded", "rate_limit_error", "insufficient_quota", "billing_hard_limit_reached", "overloaded_error",
    "invalid_request_error", "invalid_function_parameters", "invalid_json_schema", "unsupported_parameter", "unsupported_value",
    "invalid_value", "missing_required_parameter", "context_length_exceeded", "model_not_found", "invalid_api_key",
    "authentication_error", "permission_error", "permission_denied", "not_found_error", "request_too_large", "api_error", "server_error"];
  const textField = (key: string, limit: number) => typeof value[key] === "string"
    ? redactProviderDiagnosticText(value[key] as string).slice(0, limit).trim() : undefined;
  const providerMessage = textField("providerMessage", 2000);
  const providerParam = textField("providerParam", 200);
  const providerRequestId = textField("providerRequestId", 200);
  const transportCodes = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"];
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
    if (!codes.includes(issue.code as string) || !Array.isArray(issue.path)) return [];
    const acoustic = issue.path[0] === "exteriorNoiseExtraction";
    if (issue.path.length > (acoustic ? 9 : 8)) return [];
    // Extraction permits 5,000 facts and 3,000 evidence entries per room. Keep
    // their bounded indices, not arbitrary field names or rejected source text.
    if (!issue.path.every((part, index, path) => typeof part === "string" ? (acoustic ? acousticKeys : keys).includes(part)
      : typeof part === "number" && Number.isInteger(part) && part >= 0
        && part <= (acoustic && path[index - 1] === "facts" ? 4999 : acoustic && path[index - 1] === "fieldEvidence" ? 2999 : 100))) return [];
    const limits: Partial<Record<"minimum" | "maximum" | "multipleOf", number>> = {};
    for (const key of ["minimum", "maximum", "multipleOf"] as const) {
      const number = issue[key];
      if (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= (acoustic ? 1000000 : 200000)) limits[key] = number;
    }
    // Preserve actionable packet errors, never rejected prose or arbitrary Zod
    // params. Accept the sanitized form too: diagnostics cross several layers.
    const details = (issue.params as { editorial?: unknown } | undefined)?.editorial ?? issue.editorial;
    let editorial: { reason: "incomplete" | "references"; missingReferences?: string[]; addedReferences?: string[] } | undefined;
    if (issue.code === "custom" && details && typeof details === "object") {
      const data = details as Record<string, unknown>;
      if (data.reason === "incomplete" && JSON.stringify(issue.path) === '["complete"]') editorial = { reason: "incomplete" };
      if (data.reason === "references" && JSON.stringify(issue.path) === '["sections",0,"content"]') {
        const refs = (value: unknown) => Array.isArray(value) ? value.slice(0, 100).filter((id): id is string => typeof id === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) : [];
        editorial = { reason: "references", missingReferences: refs(data.missingReferences), addedReferences: refs(data.addedReferences) };
      }
    }
    const sectionKey = issue.code === "invalid_literal" && issue.path[0] === "sections" && issue.path[2] === "key";
    const acousticReason = (issue.params as { acoustic?: unknown } | undefined)?.acoustic ?? issue.acoustic;
    const safeAcousticReason = acoustic && issue.code === "custom" && typeof acousticReason === "string"
      && ["invalid_fact_value", "room_fact_id", "source_required", "source_not_in_packet", "quote_not_in_source", "duplicate_room", "room_not_declared",
        "visual_source_not_in_packet", "visual_receipt_mismatch"].includes(acousticReason)
      ? acousticReason : undefined;
    const messagingReason = (issue.params as { messaging?: unknown } | undefined)?.messaging ?? issue.messaging;
    const safeMessagingReason = issue.path[0] === "messages" && issue.code === "custom" && typeof messagingReason === "string"
      && ["recipient_not_supplied", "reply_not_supplied", "reply_recipient_mismatch", "message_limit"].includes(messagingReason)
      ? messagingReason : undefined;
    return [{ code: issue.code as string, path: issue.path as (string | number)[], ...limits,
      ...(safeAcousticReason ? { acoustic: safeAcousticReason } : {}),
      ...(safeMessagingReason ? { messaging: safeMessagingReason } : {}),
      ...(editorial ? { editorial } : {}),
      ...(sectionKey && acousticSectionKeySchema.safeParse(issue.expected).success ? { expected: issue.expected as string } : {}),
      ...(sectionKey && acousticSectionKeySchema.safeParse(issue.received).success ? { received: issue.received as string } : {}),
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
    ...(providerCodes.includes(value.providerType as string) ? { providerType: value.providerType as string } : {}),
    ...(providerMessage ? { providerMessage } : {}),
    ...(providerParam && /^[a-zA-Z][\w.[\]-]*$/.test(providerParam) ? { providerParam } : {}),
    ...(providerRequestId && /^[a-zA-Z0-9_-]{1,200}$/.test(providerRequestId) ? { providerRequestId } : {}),
    ...(transportCodes.includes(value.transportCode as string) ? { transportCode: value.transportCode as string } : {}),
    ...(typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0 && value.retryAfterMs <= 1e12
      ? { retryAfterMs: value.retryAfterMs } : {}),
    ...(Object.keys(rateLimit).length ? { rateLimit } : {}),
    ...(issues.length ? { issues } : {}),
  };
}
export type AppDeps = {
  db: any;
  /** App-owned, permission-scoped saved view data. No browser state, writes or vendor queries. */
  projectViewData?: (context: import("@richtfest/shared").ProjectViewContext) => Promise<import("@richtfest/shared").ProjectViewData>;
  /** Projects owns tenant authorization, bounded reviewed state and proposal persistence. */
  buildingModelContext?: (projectId: string, selection?: import("@richtfest/shared").BuildingEntityRef) => Promise<unknown>;
  proposeBuildingModelChange?: (projectId: string, input: import("@richtfest/shared").BuildingEntityRef & {
    baseRevision: number; propertyKey: string; value: unknown; unit?: string | null;
    reason: string; evidence: import("@richtfest/shared").BuildingEvidence[];
  }, execution: { runId: string; agentId: string }, tx: any) => Promise<unknown>;
  supervisorEnabled?: boolean;
  estimateCallCost?: (provider: ProviderUsage["provider"], settings: ProviderExecutionSettings, inputBytes: number, hasTools: boolean, inputTokenUpperBound?: number) => number | null;
  calculateAcoustics?: (input: AcousticCalculationInput) => AcousticCalculationResult;
  /** Projects assembles the exterior noise verification inputs from the building model and facade levels. */
  exteriorNoiseProof?: (projectId: string) => Promise<import("@richtfest/shared").ExteriorNoiseProof>;
  /** Writes the agent's cited exterior noise suggestions as unreviewed building-model values (Projects). */
  proposeExteriorNoiseInputs?: (projectId: string, input: unknown, execution: { runId: string; agentId: string }, tx: any) => Promise<unknown>;
  /** Suggests wall Rw from the component catalogue for walls of the verification without one (Projects). */
  suggestExteriorNoiseCatalogue?: (projectId: string, tx: any) => Promise<{ written: number }>;
  /** Projects assembles the interior sound verification (separating walls and ceilings) from the building model. */
  interiorSoundProof?: (projectId: string) => Promise<import("@richtfest/shared").InteriorSoundProof>;
  /** Writes the agent's cited interior sound suggestions as unreviewed building-model values (Projects). */
  proposeInteriorSoundInputs?: (projectId: string, input: unknown, execution: { runId: string; agentId: string }, tx: any) => Promise<unknown>;
  /** Projects supplies a consistent tenant-scoped snapshot, never model-provided calculation inputs. */
  fireProtectionSnapshot?: (projectId: string) => Promise<import("@richtfest/shared/fire-plan").FireProtectionSnapshot>;
  executeDecision?: (input: {
    // Pre-submit recommendations have no run; authorization is checked by the app.
    runId?: string;
    signal?: AbortSignal;
    state: unknown;
    questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
  } & ProviderTelemetry) => Promise<ProviderResult>;
  executeImageDecision?: (input: SourceImageInference & ProviderTelemetry & { runId?: string }) => Promise<ProviderResult>;
  /** Projects owns authorization/rendering/cache; Knowledge supplies tracked inference. */
  querySourceImage?: (projectId: string, input: SourceImageQuery,
    infer: (input: SourceImageInference) => Promise<ProviderResult>, signal?: AbortSignal) => Promise<SourceImageReceipt>;
  /** Cached Projects research, creating only when absent; never refresh from an agent. */
  researchProjectEnvironment?: (projectId: string, signal?: AbortSignal) => Promise<import("@richtfest/shared").EnvironmentSurvey>;
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
    prepareFireProtection?: (signal?: AbortSignal) => Promise<import("./fire-protection-assessment").FireProtectionToolResult>;
    researchProjectEnvironment?: (signal?: AbortSignal) => Promise<import("@richtfest/shared").EnvironmentSurvey>;
    searchCompanyKnowledge?: (input: CompanyKnowledgeSearch, signal?: AbortSignal) => Promise<CompanyKnowledgeReceipt>;
    inspectSource?: (input: SourceVisualRequest, signal?: AbortSignal) => Promise<SourceVisual & { receiptId?: string; imageHash?: string }>;
    querySourceImage?: (input: SourceImageQuery, signal?: AbortSignal) => Promise<SourceImageReceipt>;
    onSummaryDelta?: (delta: string) => Promise<void>;
    onUsage?: (usage: ProviderUsage) => Promise<void>;
    onRequest?: ProviderTelemetry["onRequest"];
    onResponse?: ProviderTelemetry["onResponse"];
    onPrepared?: ProviderTelemetry["onPrepared"];
    onBeforeModelStep?: ProviderTelemetry["onBeforeModelStep"];
    onModelStepSettled?: ProviderTelemetry["onModelStepSettled"];
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
  /** Eligibility of immutable PDF attachments, without downloading their bytes. */
  sourcePdfVersionIds?: (projectId: string, versionIds: string[]) => Promise<string[]>;
  /** Private generated exports; keys never leave the server. */
  pdfStorage?: {
    write: (key: string, bytes: Buffer) => Promise<void>;
    read: (key: string) => Promise<{ stream: AsyncIterable<Uint8Array>; sizeBytes: number } | null>;
    remove: (key: string) => Promise<void>;
  };
  /** Targeted original visual; rendering belongs to Projects, run receipts to Knowledge. */
  inspectSource?: (projectId: string, input: SourceVisualRequest, signal?: AbortSignal) => Promise<SourceVisual>;
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
      /** Read the saved deterministic page model, without preparing or re-indexing it. */
      documentModel?: boolean;
      documentOffset?: number;
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
  validateProject: (projectId: string, tx?: any) => Promise<boolean>;
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
  onBeforeModelStep?: ProviderTelemetry["onBeforeModelStep"];
  onModelStepSettled?: ProviderTelemetry["onModelStepSettled"];
};
/** Allowlisted metadata only: never headers, credentials, raw prompts or SDK errors. */
export type ProviderExecutionSettings = {
  version: 1;
  adapter: "direct" | "mastra" | "decision";
  adapterVersion: string;
  appRevision: string | null;
  modelId: string;
  /** Root policy slot; specialists retain their durable specialistRole. */
  modelRole?: "supervisor" | "writer";
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
  /** Explicit-only cache ending before changing report packet content. */
  promptCache?: "report-prefix-v1";
  /** Opt in only when every network model dispatch is gated and settled below. */
  stepAccounting?: "per-model-dispatch-v1";
};
export type ProviderResponseMetadata = {
  modelId: string | null;
  responseId: string | null;
  finishReason: string | null;
};
export type ProviderTelemetry = {
  /** Await immediately before dispatch. Ordinals start at 1; bytes are the exact
   * normalized SDK request UTF-8 bytes (including schemas/tools/history).
   * An optional model-specific token bound replaces byte-based estimation only
   * when all native media is covered. It never changes the dispatched request.
   * Call onRequest and onPrepared first; a cache hit skips all step callbacks.
   * Steps are serial and bounded by min(maxSteps, 100). A rejection forbids
   * dispatch. Pause, do not reset, the adapter's active-time deadline while awaiting. */
  onBeforeModelStep?: (input: { ordinal: number; inputBytes: number; hasMedia: boolean; inputTokenUpperBound?: number }, signal?: AbortSignal) => Promise<void>;
  /** Await once each dispatch ends, including errors. Undefined usage is unknown,
   * not zero. Supply per-step usage with estimatedCostUsd, never cumulative usage.
   * Duplicate settlement of the same ordinal is a no-op (first result wins).
   * Aggregate onUsage/result.usage is ignored by explicitly step-accounted adapters. */
  onModelStepSettled?: (input: { ordinal: number; usage?: ProviderUsage }) => Promise<void>;
  onRequest?: (settings: ProviderExecutionSettings) => Promise<void>;
  onResponse?: (response: ProviderResponseMetadata) => Promise<void>;
  onUsage?: (usage: ProviderUsage) => Promise<void>;
  /** Sanitized model-visible input only. A hit skips inference, not application validation. */
  onPrepared?: (input: { version: 1; instructions: string; prompt: string; inputBytes?: number; outputSchema?: unknown; tools?: unknown }, signal?: AbortSignal) => Promise<{ output: unknown } | undefined>;
};
export type ProviderUsage = {
  provider: AgentProvider | "typesafe";
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  /** Subset of input, distinct from cache reads; null means unreported. */
  cacheWriteInputTokens?: number | null;
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
    pdfRepresentation?: import("@richtfest/shared").SourcePdfRepresentation;
  }[];
  truncated: boolean;
  authority: "unreviewed_source_inventory";
};
