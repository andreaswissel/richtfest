export type AgentUsageAnalytics = {
  callCount: number;
  attemptCount: number;
  missingUsageAttempts: number;
  unreportedRuns: number;
  unpricedCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCostUsd: number | null;
  recordedCostUsd: number | null;
  models: string[];
};

export type AgentAnalyticsMember = {
  id: string;
  parentRunId: string | null;
  goal: string;
  specialistRole: string | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  usage: AgentUsageAnalytics;
};

export type ProjectAgentAnalytics = {
  runs: (AgentAnalyticsMember & {
    isSupervisor: boolean;
    aggregate: AgentUsageAnalytics;
    members: AgentAnalyticsMember[];
  })[];
  hasMore: boolean;
};
