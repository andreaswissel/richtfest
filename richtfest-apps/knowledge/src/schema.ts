import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
export const conversations = pgTable("knowledge_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id"),
  title: text("title").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const messages = pgTable("knowledge_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  authorId: uuid("author_id").notNull(),
  body: text("body").notNull(),
  sourceRef: text("source_ref"),
  actorKind: text("actor_kind").notNull().default("user"),
  parentMessageId: uuid("parent_message_id"),
  sourceVersionIds: jsonb("source_version_ids").notNull().default([]),
  openui: text("openui"),
  annotationId: uuid("annotation_id"),
  runId: uuid("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const tasks = pgTable("knowledge_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id"),
  conversationId: uuid("conversation_id"),
  title: text("title").notNull(),
  status: text("status").notNull().default("open"),
  assigneeType: text("assignee_type").notNull().default("user"),
  assigneeId: uuid("assignee_id"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const drafts = pgTable("knowledge_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sourceRefs: jsonb("source_refs").notNull().default([]),
  status: text("status").notNull().default("draft"),
  createdBy: uuid("created_by").notNull(),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const agentRuns = pgTable("knowledge_agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id"),
  conversationId: uuid("conversation_id"),
  taskId: uuid("task_id"),
  messageId: uuid("message_id"),
  intent: text("intent").notNull().default("assist"),
  parentRunId: uuid("parent_run_id"),
  specialistRole: text("specialist_role"),
  retryOfRunId: uuid("retry_of_run_id"),
  checkpointVersion: integer("checkpoint_version").notNull().default(0),
  generation: integer("generation").notNull().default(0),
  goal: text("goal").notNull(),
  sourceVersionIds: jsonb("source_version_ids").notNull().default([]),
  provider: text("provider").notNull(),
  modelPolicy: jsonb("model_policy"),
  status: text("status").notNull().default("queued"),
  partialOutput: text("partial_output").notNull().default(""),
  outputSummary: text("output_summary"),
  rationale: text("rationale"),
  error: text("error"),
  correlationId: uuid("correlation_id").notNull(),
  requestedBy: uuid("requested_by").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const agentRunUsage = pgTable("knowledge_agent_run_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  runId: uuid("run_id").notNull(),
  attemptId: uuid("attempt_id"),
  callIndex: integer("call_index").notNull(),
  provider: text("provider").notNull(),
  modelId: text("model_id"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  totalTokens: integer("total_tokens"),
  estimatedCostUsd: integer("estimated_cost_usd_micros"),
  pricingVersion: text("pricing_version"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ runCall: uniqueIndex("knowledge_agent_run_usage_run_call").on(table.runId, table.callIndex) }));
export const agentRunAttempts = pgTable("knowledge_agent_run_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  runId: uuid("run_id").notNull(),
  operationId: uuid("operation_id").notNull(),
  phase: text("phase").notNull(),
  generation: integer("generation"),
  attemptNumber: integer("attempt_number").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull().default("running"),
  settings: jsonb("settings"),
  response: jsonb("response"),
  usageStatus: text("usage_status").notNull().default("pending"),
  failureCategory: text("failure_category"),
  providerStatus: integer("provider_status"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => ({ tenantRun: index("knowledge_agent_run_attempts_tenant_run").on(table.tenantId, table.runId) }));
export const agentRunEvents = pgTable("knowledge_agent_run_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  runId: uuid("run_id").notNull(),
  eventType: text("event_type").notNull(),
  toolName: text("tool_name"),
  paramsSummary: text("params_summary"),
  resultSummary: text("result_summary"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
/** Immutable execution records; provider failures retain metadata, never raw SDK errors. */
export const agentRunSteps = pgTable("knowledge_agent_run_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  runId: uuid("run_id").notNull(),
  attemptId: uuid("attempt_id"),
  generation: integer("generation").notNull(),
  version: integer("version").notNull().default(1),
  kind: text("kind").notNull(),
  stepKey: text("step_key").notNull(),
  inputHash: text("input_hash").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  status: text("status").notNull(),
  reusedFromStepId: uuid("reused_from_step_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  lookup: index("knowledge_agent_run_steps_lookup").on(table.tenantId, table.runId, table.kind, table.stepKey, table.inputHash),
}));
export const agentRunApprovals = pgTable("knowledge_agent_run_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  runId: uuid("run_id").notNull(),
  decision: text("decision").notNull(),
  note: text("note"),
  evaluation: jsonb("evaluation"),
  evaluatedOutput: jsonb("evaluated_output"),
  decidedBy: uuid("decided_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const conversationReads = pgTable(
  "knowledge_conversation_reads",
  {
    tenantId: uuid("tenant_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    userId: uuid("user_id").notNull(),
    composerDraft: text("composer_draft").notNull().default(""),
    lastReadMessageId: uuid("last_read_message_id"),
    meaningfulMessageId: uuid("meaningful_message_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.conversationId, t.userId] }),
  }),
);
export const artifacts = pgTable("knowledge_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("draft"),
  createdBy: uuid("created_by").notNull(),
  runId: uuid("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const artifactRevisions = pgTable("knowledge_artifact_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  artifactId: uuid("artifact_id").notNull(),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  payload: jsonb("payload"),
  sourceVersionIds: jsonb("source_version_ids").notNull().default([]),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const annotations = pgTable("knowledge_annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull(),
  artifactRevisionId: uuid("artifact_revision_id"),
  sourceVersionId: uuid("source_version_id"),
  page: integer("page"),
  selection: jsonb("selection"),
  quote: text("quote"),
  body: text("body").notNull(),
  messageId: uuid("message_id"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const supervisorRuns = pgTable("knowledge_supervisor_runs", {
  runId: uuid("run_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  generation: integer("generation").notNull().default(0),
  phase: text("phase").notNull().default("plan"),
  revision: integer("revision").notNull().default(0),
  profileSnapshot: jsonb("profile_snapshot").notNull().default([]),
  assignments: jsonb("assignments").notNull().default([]),
  review: jsonb("review"),
  history: jsonb("history").notNull().default([]),
  steering: text("steering"),
  effort: text("effort").notNull().default("medium"),
  modelPolicy: jsonb("model_policy"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
});

export const agentProfiles = pgTable("knowledge_agent_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  key: text("key").notNull(),
  instructions: text("instructions").notNull().default(""),
  triggerPhrases: jsonb("trigger_phrases").notNull().default([]),
  knowledgeIds: jsonb("knowledge_ids").notNull().default([]),
  version: integer("version").notNull().default(1),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ workspaceRole: uniqueIndex("knowledge_agent_profiles_tenant_role").on(table.tenantId, table.key) }));
