import { Router, type Request } from "express";
import { and, desc, eq, inArray, ne, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { agentBudgetDecisionSchema } from "@richtfest/shared";
import { companyKnowledgeSearchSchema, type CompanyKnowledgeReceipt, agentMessageInputSchema, agentPresetSnapshotSchema, agentRunBudgetSchema, agentRunEvaluationSchema, agentWorkflowSchema, agentWorkflowRequestSchema, requestedAcousticConcept, specialistRoleSchema, type AgentExecutionLimits, ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { agentMessagingContext, deliverAgentMessage, runThreadMessages } from "./agent-messages";
import { companyKnowledgeCategories, searchCompanyKnowledge, assertCompanyKnowledgeCurrent } from "./company-knowledge";
import {
  supervisorRuns,
  agentRuns,
  agentRunEvents,
  agentRunApprovals,
  artifacts,
  artifactRevisions,
  messages,
  tasks,
  annotations,
  agentRunUsage,
  agentRunAttempts,
  agentRunSteps,
} from "./schema";
import {
  conversation,
  sources,
  missing,
  conflict,
  createArtifact,
  artifactReviewContext,
} from "./workspace";
import { repairLegacyRuns } from "./run-recovery";
import { createSupervisor } from "./supervisor";
import { executeTrackedProvider, summarizeUsageRows, runAccounting, interruptProviderAttempts } from "./usage";
import { recordStep, savedStep, stepHash } from "./run-steps";
import { resolveRunSource } from "./source-evidence";
import { recommendMode } from "./decision-routing";
import { workflowProposalsRouter } from "./workflow-proposals";
import {
  classifyRunFailure,
  formatChildCancellationReason,
  formatRunFailureReason,
  reviewRejectionReason,
  userCancellationReason,
  type RunFailureCategory,
  type RunFailurePhase,
} from "./run-reasons";
const runInput = z.object({
  effort: z.enum(["low", "medium", "high", "ultra"]).default("medium"),
  budget: agentRunBudgetSchema.optional(),
  workflow: agentWorkflowRequestSchema.optional(),
  messageId: z.string().uuid().optional(),
  intent: z.enum(["assist", "calculation"]).default("assist"),
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  goal: z.string().trim().min(1).max(5000),
  sourceVersionIds: z.array(z.string().uuid()).max(100).default([]),
});
export const directOutputSchema = (limits?: AgentExecutionLimits) => z.object({
  summary: z.string().trim().min(1).max(limits?.summaryMaxCharacters ?? 10000),
  rationale: z.string().max(limits?.rationaleMaxCharacters ?? 2000),
  citations: z.array(z.string().uuid()).max(100).default([]),
  tools: z
    .array(z.object({ name: z.string().max(100), input: z.unknown() }))
    .max(5)
    .default([]),
  openui: z.string().max(20000).optional(),
  openuiReferences: z
    .object({
      sourceVersionIds: z.array(z.string().uuid()),
      artifactIds: z.array(z.string().uuid()),
    })
    .optional(),
  artifact: z
    .object({
      title: z.string().min(1).max(300),
      content: z.string().min(1).max(limits?.documentMaxCharacters ?? 50000),
      type: z.literal("draft").default("draft"),
    })
    .nullable()
    .optional(),
});
export const outputInput = directOutputSchema();
// Membership in the project is necessary but not enough: citations must name
// evidence supplied to this execution, never merely referenced by old history.
export function assertEvidenceCitations(
  output: {
    citations: string[];
    openuiReferences?: { sourceVersionIds: string[] };
  },
  evidence: ReadonlySet<string>,
) {
  for (const versionId of [
    ...output.citations,
    ...(output.openuiReferences?.sourceVersionIds ?? []),
  ]) {
    if (!evidence.has(versionId))
      throw conflict("Citation was not supplied or resolved in this run");
  }
}
export function recordResolvedEvidence(evidence: Set<string>, result: unknown) {
  const resolved = z
    .object({
      status: z.literal("resolved"),
      source: z.object({ versionId: z.string().uuid() }),
      content: z.object({
        status: z.literal("available"),
        text: z.string().trim().min(1),
      }),
    })
    .safeParse(result);
  if (resolved.success) evidence.add(resolved.data.source.versionId);
}

export const toolInputs = {
  send_thread_message: agentMessageInputSchema,
  search_company_knowledge: companyKnowledgeSearchSchema,
  delegate_source_review: z
    .object({
      goal: z.string().min(1).max(2000),
      sourceVersionIds: z.array(z.string().uuid()).min(1).max(5),
    })
    .strict(),
  resolve_project_source: z
    .object({
      pageStart: z.number().int().positive().optional(),
      pageEnd: z.number().int().positive().optional(),
      fileId: z.string().uuid().optional(),
      versionId: z.string().uuid().optional(),
      query: z.string().trim().min(1).max(300).optional(),
      textQuery: z.string().trim().min(1).max(5000).optional(),
      entityKey: z.string().min(1).max(200).optional(),
      modelOffset: z.number().int().min(0).max(1000000).optional(),
    })
    .strict(),
  create_draft: z
    .object({
      title: z.string().min(1).max(300),
      content: z.string().min(1).max(50000),
    })
    .strict(),
  ask_missing_input: z
    .object({ question: z.string().min(1).max(2000) })
    .strict(),
  validated_calculation: z
    .object({ request: z.string().min(1).max(5000) })
    .strict(),
};
export function validateTool(name: string, input: unknown, limits?: AgentExecutionLimits) {
  if (!Object.hasOwn(toolInputs, name))
    throw conflict("Tool is not allowlisted");
  if (name === "create_draft" && limits)
    return toolInputs.create_draft.extend({ content: z.string().min(1).max(limits.documentMaxCharacters) }).parse(input);
  return toolInputs[name as keyof typeof toolInputs].parse(input);
}
async function getRun(d: AppDeps, id: string, tx = d.db, lock = false) {
  let query = tx
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, id), eq(agentRuns.tenantId, d.tenantId)));
  if (lock) query = query.for("update");
  const [run] = await query;
  if (!run) throw missing("Run not found");
  return run;
}
async function event(
  d: AppDeps,
  tx: any,
  run: any,
  eventType: string,
  toolName?: string,
  resultSummary?: string,
) {
  const [row] = await tx
    .insert(agentRunEvents)
    .values({
      tenantId: d.tenantId,
      runId: run.id,
      eventType,
      toolName,
      resultSummary,
      createdBy: d.actorId,
    })
    .returning();
  await d.auditRun(
    tx,
    `knowledge.agent_run.${eventType}`,
    "agent_run",
    run.id,
    run.id,
    run.correlationId,
    { eventId: row.id, toolName, summary: resultSummary },
  );
}
async function active(d: AppDeps, run: any, fn: (tx: any) => Promise<unknown>) {
  return d.db.transaction(async (tx: any) => {
    const current = await getRun(d, run.id, tx, true);
    if (current.status !== "running" || current.generation !== (run.generation ?? 0)) throw conflict("Run is no longer active");
    return fn(tx);
  });
}
export async function executeRun(d: AppDeps, run: any) {
  let failurePhase: RunFailurePhase = "execution";
  let failureCategory: RunFailureCategory = "execution";
  try {
    const claimed = await d.db.transaction(async (tx: any) => {
      const current = await getRun(d, run.id, tx, true);
      if (current.status !== "queued" || current.generation !== (run.generation ?? 0)) return false;
      await tx
        .update(agentRuns)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agentRuns.id, run.id));
      await event(
        d,
        tx,
        run,
        "started",
        undefined,
        "Trusted project execution started",
      );
      return true;
    });
    if (!claimed) return;
    d.requirePermission("agent:run");
    d.requirePermission("knowledge:read");
    d.requirePermission("projects:read");
    if (!(await d.validateProject(run.projectId))) throw missing("Project not found");
    await sources(d, run.projectId, run.sourceVersionIds);
    failurePhase = "source_resolution";
    failureCategory = "execution";
    const sourceInventory = await d.listProjectSources(run.projectId);
    const evidence = new Set<string>();
    const sourceContent = [];
    for (const versionId of new Set<string>(run.sourceVersionIds)) {
      const resolved = await resolveRunSource(d, run.projectId, { versionId, textQuery: run.goal }, () => active(d, run, async () => {}));
      sourceContent.push(resolved);
      recordResolvedEvidence(evidence, resolved);
    }
    const history = run.conversationId
      ? await d.db
          .select({
            id: messages.id,
            actorKind: messages.actorKind,
            agentMessage: messages.agentMessage,
            body: messages.body,
            sourceVersionIds: messages.sourceVersionIds,
            annotation: {
              sourceVersionId: annotations.sourceVersionId,
              artifactRevisionId: annotations.artifactRevisionId,
              page: annotations.page,
              quote: annotations.quote,
            },
          })
          .from(messages)
          .leftJoin(
            annotations,
            and(
              eq(messages.annotationId, annotations.id),
              eq(annotations.tenantId, d.tenantId),
            ),
          )
          .where(
            and(
              eq(messages.tenantId, d.tenantId),
              eq(messages.conversationId, run.conversationId),
              or(isNull(messages.runId), ne(messages.runId, run.id)),
            ),
          )
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(30)
      : [];
    const recentArtifacts = await d.db
      .select({
        id: artifacts.id,
        title: artifacts.title,
        status: artifacts.status,
      })
      .from(artifacts)
      .innerJoin(agentRuns, and(eq(artifacts.runId, agentRuns.id), eq(agentRuns.tenantId, d.tenantId)))
      .where(
        and(
          eq(artifacts.tenantId, d.tenantId),
          eq(artifacts.projectId, run.projectId),
          ne(artifacts.runId, run.id),
          run.conversationId ? eq(agentRuns.conversationId, run.conversationId) : sql`false`,
        ),
      )
      .orderBy(desc(artifacts.createdAt))
      .limit(20);
    const recentRuns = run.conversationId
      ? await d.db
          .select({
            id: agentRuns.id,
            status: agentRuns.status,
            summary: agentRuns.outputSummary,
          })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.tenantId, d.tenantId),
              eq(agentRuns.conversationId, run.conversationId),
              ne(agentRuns.id, run.id),
            ),
          )
          .orderBy(desc(agentRuns.createdAt))
          .limit(10)
      : [];
    let historyBudget = 24000;
    const boundedHistory = history
      .map((m: any) => {
        const body = m.body.slice(0, Math.min(2000, historyBudget));
        historyBudget -= body.length;
        return { ...m, body };
      })
      .filter((m: any) => m.body)
      .reverse();
    const context = {
      history: boundedHistory,
      messaging: await agentMessagingContext(d, run),
      companyKnowledgeCategories: await companyKnowledgeCategories(d),
      componentCatalog: await d.componentContext?.(run.goal),
      documentReview: await artifactReviewContext(d, run.conversationId),
      artifacts: recentArtifacts,
      priorRuns: recentRuns,
      specialistRole: run.specialistRole ?? null,
      workflow: run.modelPolicy?.workflow,
      delegationAllowed: !run.parentRunId && run.modelPolicy?.workflow?.mode !== "chat",
      sources: sourceContent,
      sourceInventory,
      projectId: run.projectId,
      sourceVersionIds: run.sourceVersionIds,
      capabilities:
        "Immutable bounded source text when supported and reviewable drafts only. No validated engineering calculation tool.",
    };
    const modelPolicy = run.modelPolicy
      ? agentPresetSnapshotSchema.parse(run.modelPolicy)
      : d.resolveSupervisorPreset
        ? await d.resolveSupervisorPreset(run.effort, run.provider)
        : undefined;
    const specialistRole = run.specialistRole ? specialistRoleSchema.parse(run.specialistRole) : undefined;
    const executionModel = specialistRole
      ? modelPolicy?.specialists[specialistRole]
      : modelPolicy?.supervisor;
    if (specialistRole && !executionModel) throw conflict("Specialist is disabled in the snapshotted preset");
    // Historical direct runs retain their original 50k draft cap.
    const limits = run.modelPolicy?.executionLimits ? modelPolicy?.executionLimits : undefined;
    const outputSchema = directOutputSchema(limits).refine(output =>
      modelPolicy?.workflow?.mode !== "chat" || (!output.artifact
        && !output.tools.some(tool => ["delegate_source_review", "create_draft"].includes(tool.name))),
    "Chat cannot delegate or create report artifacts. Ask the user to choose Team or Report.");
    let partialOutput = "";
    let lastCheckpoint = 0;
    const onSummaryDelta = async (delta: string) => {
      partialOutput = (partialOutput + delta).slice(0, limits?.summaryMaxCharacters ?? 10000);
      if (Date.now() - lastCheckpoint < 150) return;
      lastCheckpoint = Date.now();
      await active(d, run, async (tx) => {
        await tx
          .update(agentRuns)
          .set({ partialOutput, updatedAt: new Date() })
          .where(eq(agentRuns.id, run.id));
        await event(
          d,
          tx,
          run,
          "output_progress",
          undefined,
          `Summary checkpoint: ${partialOutput.length} characters`,
        );
      });
    };
    failurePhase = "provider";
    failureCategory = "provider";
    let response = await executeTrackedProvider(d, run, { phase: "direct", generation: run.generation,
      assertActive: () => active(d, run, async () => {}).then(() => {}) }, async telemetry => {
      const result = await d.executeProvider({
      ...telemetry,
      runId: run.id,
      onSummaryDelta,
      provider: run.provider,
      modelId: executionModel?.modelId,
      reasoningEffort: executionModel?.reasoningEffort,
      maxOutputTokens: executionModel?.maxOutputTokens,
      executionLimits: limits,
      goal: run.goal,
      context,
      });
      if (result.status === "completed") {
        result.output = outputSchema.parse(result.output);
        assertEvidenceCitations(result.output as z.infer<typeof outputSchema>, evidence);
        for (const tool of (result.output as z.infer<typeof outputSchema>).tools) validateTool(tool.name, tool.input, limits);
      }
      return result;
    });
    failurePhase = "execution";
    failureCategory = "execution";
    if (response.status === "unconfigured") {
      await active(d, run, async (tx) => {
        await tx
          .update(agentRuns)
          .set({
            status: "unconfigured",
            error:
              "Configure a personal or workspace connection for the selected provider.",
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await event(d, tx, run, "unconfigured");
      });
      return;
    }
    let output = outputSchema.parse(response.output);
    assertEvidenceCitations(output, evidence);
    await sources(d, run.projectId, output.citations);
    const results: unknown[] = [];
    const companyKnowledge: CompanyKnowledgeReceipt[] = [];
    let calculationUnavailable = false;
    const runDeps = {
      ...d,
      audit: (
        tx: any,
        action: string,
        type: string,
        id: string,
        metadata?: unknown,
      ) =>
        d.auditRun(tx, action, type, id, run.id, run.correlationId, metadata),
    };
    failurePhase = "tool_execution";
    failureCategory = "execution";
    for (const [toolIndex, tool] of output.tools.entries()) {
      const input = validateTool(tool.name, tool.input, limits) as any;
      if (tool.name === "delegate_source_review") {
        if (run.parentRunId)
          throw conflict("Specialist runs cannot delegate recursively");
        d.requirePermission("agent:run");
        await sources(d, run.projectId, input.sourceVersionIds);
      }
      d.requirePermission(
        tool.name === "create_draft" || tool.name === "ask_missing_input"
          ? "knowledge:write"
          : "knowledge:read",
      );
      let childRun: any;
      const resolved =
        tool.name === "resolve_project_source"
          ? await resolveRunSource(d, run.projectId, { textQuery: run.goal, ...input }, () => active(d, run, async () => {}))
          : undefined;
      recordResolvedEvidence(evidence, resolved);
      // Reranking records its own tracked provider transaction. Never invoke it
      // while holding the run lock in active(), or the two transactions deadlock.
      const search = tool.name === "search_company_knowledge"
        ? await searchCompanyKnowledge(d, input, d.db, companyKnowledge.length >= 2,
          modelPolicy?.knowledgeRerankingEnabled ? { runId: run.id, correlationId: run.correlationId,
            goal: run.goal, generation: run.generation } : undefined)
        : undefined;
      await active(d, run, async (tx) => {
        const stepKey = `tool:${toolIndex}`;
        const stepInput = { name: tool.name, input, citations: output.citations, ...(resolved ? { resolved } : {}) };
        const inputHash = stepHash(stepInput);
        const saved = await savedStep(d, run.id, "tool", stepKey, undefined, tx);
        if (saved && tool.name !== "resolve_project_source" && tool.name !== "search_company_knowledge") {
          if (saved.inputHash !== inputHash) throw conflict("Saved action inputs changed. Start a new run instead of repeating a completed action.");
          results.push({ tool: tool.name, result: saved.output });
          if (tool.name === "validated_calculation") calculationUnavailable = true;
          if (tool.name === "delegate_source_review") {
            childRun = await getRun(d, saved.output.runId, tx, true);
            if (!childRun.outputSummary && ["failed", "cancelled", "unconfigured"].includes(childRun.status)) {
              [childRun] = await tx.update(agentRuns).set({ status: "queued", error: null,
                generation: childRun.generation + 1, requestedBy: d.actorId, updatedAt: new Date() })
                .where(eq(agentRuns.id, childRun.id)).returning();
              await tx.update(tasks).set({ status: "in_progress" }).where(and(eq(tasks.id, childRun.taskId), eq(tasks.tenantId, d.tenantId)));
              await event(d, tx, childRun, "resumed");
            }
          }
          await recordStep(d, tx, run, { kind: "tool", stepKey, inputHash, input: stepInput,
            output: saved.output, status: "reused", reusedFromStepId: saved.id });
          return;
        }
        let result: any;
        if (tool.name === "resolve_project_source") result = resolved;
        else if (tool.name === "search_company_knowledge") {
          await assertCompanyKnowledgeCurrent(d, [search!], tx);
          result = search;
        }
        else if (tool.name === "send_thread_message")
          result = await deliverAgentMessage(d, tx, run, input, stepKey);
        else if (tool.name === "delegate_source_review") {
          const [task] = await tx
            .insert(tasks)
            .values({
              tenantId: d.tenantId,
              projectId: run.projectId,
              conversationId: run.conversationId,
              title: input.goal.slice(0, 300),
              assigneeType: "agent",
              createdBy: d.actorId,
            })
            .returning();
          const [child] = await tx
            .insert(agentRuns)
            .values({
              tenantId: d.tenantId,
              projectId: run.projectId,
              conversationId: run.conversationId,
              taskId: task.id,
              parentRunId: run.id,
              specialistRole: "source_reviewer",
              goal: input.goal,
              sourceVersionIds: input.sourceVersionIds,
              provider: run.provider,
              modelPolicy: modelPolicy ?? run.modelPolicy ?? null,
              checkpointVersion: 1,
              status: "queued",
              correlationId: run.correlationId,
              requestedBy: d.actorId,
            })
            .returning();
          childRun = child;
          await d.auditRun(
            tx,
            "knowledge.task.created",
            "task",
            task.id,
            run.id,
            run.correlationId,
            { childRunId: child.id },
          );
          await d.auditRun(
            tx,
            "knowledge.agent_run.delegated",
            "agent_run",
            child.id,
            run.id,
            run.correlationId,
            { parentRunId: run.id, specialistRole: "source_reviewer" },
          );
          result = { status: "delegated", runId: child.id, taskId: task.id };
        } else if (tool.name === "create_draft")
          result = await createArtifact(
            runDeps,
            tx,
            {
              projectId: run.projectId,
              title: input.title,
              content: input.content,
              type: "draft",
              sourceVersionIds: output.citations,
            },
            run.id,
          );
        else if (tool.name === "ask_missing_input") {
          result = { status: "missing_input", question: input.question };
          if (run.conversationId) {
            const [message] = await tx
              .insert(messages)
              .values({
                tenantId: d.tenantId,
                conversationId: run.conversationId,
                authorId: d.actorId,
                actorKind: "agent",
                runId: run.id,
                body: input.question,
              })
              .returning();
            result.messageId = message.id;
            await d.auditRun(
              tx,
              "knowledge.message.created",
              "message",
              message.id,
              run.id,
              run.correlationId,
            );
          }
        } else {
          result = {
            status: "validated_tool_unavailable",
            message:
              "No validated deterministic calculation tool is available. No calculation was performed.",
          };
          calculationUnavailable = true;
        }
        // Recheck the read, but retain its identity when nothing changed so a
        // completed follow-up can still reuse its matching model checkpoint.
        const step = tool.name === "search_company_knowledge" && saved?.inputHash === inputHash && stepHash(saved.output) === stepHash(result)
          ? saved
          : await recordStep(d, tx, run, { kind: "tool", stepKey, inputHash, input: stepInput, output: result, status: "completed" });
        if (tool.name === "search_company_knowledge") {
          result = { ...result, receiptId: step.id };
          companyKnowledge.push(result);
        }
        // Duplicate reads must not duplicate the same evidence in model input.
        if (tool.name !== "resolve_project_source" || !results.some((entry: any) =>
          entry.tool === tool.name && JSON.stringify(entry.result) === JSON.stringify(result)))
          results.push({ tool: tool.name, result });
        await event(
          d,
          tx,
          run,
          "tool_executed",
          tool.name,
          tool.name === "validated_calculation"
            ? "validated_tool_unavailable"
            : tool.name === "resolve_project_source"
              ? result.status
              : tool.name === "search_company_knowledge"
                ? `${result.status}: ${result.entries.length} approved company references retrieved`
              : tool.name === "send_thread_message"
                ? "Message delivered; recipient execution unchanged"
              : "Draft or question persisted; review required",
        );
      });
      if (childRun) void executeRun(d, childRun).catch(() => undefined);
    }
    if (calculationUnavailable) {
      await active(d, run, async (tx) => {
        await tx
          .update(agentRuns)
          .set({
            status: "validated_tool_unavailable",
            outputSummary:
              "No validated deterministic calculation tool is available. No calculation was performed.",
            rationale:
              "Engineering results require a versioned validated deterministic tool.",
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        await event(d, tx, run, "validated_tool_unavailable");
      });
      return;
    }
    if (results.length) {
      await assertCompanyKnowledgeCurrent(d, companyKnowledge);
      partialOutput = "";
      failurePhase = "provider";
      failureCategory = "provider";
      response = await executeTrackedProvider(d, run, { phase: "tool_followup", generation: run.generation,
        assertActive: () => active(d, run, async () => {}).then(() => {}) }, async telemetry => {
        const result = await d.executeProvider({
        ...telemetry,
        runId: run.id,
        onSummaryDelta,
        provider: run.provider,
        modelId: executionModel?.modelId,
        reasoningEffort: executionModel?.reasoningEffort,
        maxOutputTokens: executionModel?.maxOutputTokens,
        executionLimits: limits,
        goal: run.goal,
        context: { ...context, messaging: await agentMessagingContext(d, run), sources: context.sources.filter(source => !results.some((entry: any) =>
          entry.tool === "resolve_project_source" && JSON.stringify(entry.result) === JSON.stringify(source))) },
        toolResults: results,
        });
        if (result.status === "completed") {
          const parsed = outputSchema.parse(result.output);
          assertEvidenceCitations(parsed, evidence);
          if (parsed.tools.length) throw conflict("Provider exceeded the permitted tool round");
          result.output = parsed;
        }
        return result;
      });
      failurePhase = "execution";
      failureCategory = "execution";
      if (response.status !== "completed")
        throw conflict("Provider connection is no longer configured");
      output = outputSchema.parse(response.output);
      assertEvidenceCitations(output, evidence);
      if (output.tools.length)
        throw conflict("Provider exceeded the permitted tool round");
      await sources(d, run.projectId, output.citations);
    }
    await assertCompanyKnowledgeCurrent(d, companyKnowledge);
    await sources(
      d,
      run.projectId,
      output.openuiReferences?.sourceVersionIds ?? [],
    );
    for (const id of output.openuiReferences?.artifactIds ?? []) {
      const [artifact] = await d.db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, id),
            eq(artifacts.tenantId, d.tenantId),
            eq(artifacts.projectId, run.projectId),
          ),
        );
      if (!artifact)
        throw missing("Generated artifact reference is not in project");
    }
    failurePhase = "finalization";
    failureCategory = "execution";
    await active(d, run, async (tx) => {
      if (output.artifact) {
        d.requirePermission("knowledge:write");
        await createArtifact(
          runDeps,
          tx,
          {
            projectId: run.projectId,
            title: output.artifact.title,
            content: output.artifact.content,
            type: "draft",
            sourceVersionIds: output.citations,
          },
          run.id,
        );
      }
      if (run.conversationId) {
        const [message] = await tx
          .insert(messages)
          .values({
            tenantId: d.tenantId,
            conversationId: run.conversationId,
            authorId: d.actorId,
            actorKind: "agent",
            runId: run.id,
            parentMessageId: run.messageId,
            openui: output.openui,
            body: output.summary,
            sourceVersionIds: output.citations,
          })
          .returning();
        await d.auditRun(
          tx,
          "knowledge.message.created",
          "message",
          message.id,
          run.id,
          run.correlationId,
        );
      }
      await tx
        .update(agentRuns)
        .set({
          status: "needs_review",
          partialOutput: output.summary,
          outputSummary: output.summary,
          rationale: output.rationale,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));
      await event(
        d,
        tx,
        run,
        "completed",
        undefined,
        "Output persisted for human review",
      );
    });
  } catch (error) {
    const classified = classifyRunFailure(error, failurePhase);
    const category =
      failureCategory === "execution" || classified === "timeout"
        ? classified
        : failureCategory;
    const failureReason = formatRunFailureReason(failurePhase, category);
    // Never persist provider exceptions or raw tool arguments; errors may contain credentials.
    await d.db.transaction(async (tx: any) => {
      const current = await getRun(d, run.id, tx, true);
      if (current.generation !== (run.generation ?? 0)) return;
      if (current.status !== "running" && current.status !== "queued") return;
      await tx
        .update(agentRuns)
        .set({
          status: "failed",
          error: failureReason,
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));
      await event(
        d,
        tx,
        run,
        "failed",
        undefined,
        failureReason,
      );
    });
  }
}
async function requireIndependentRun(d: AppDeps, run: any, tx = d.db) {
  if (!run.parentRunId) return;
  const [supervisor] = await tx
    .select()
    .from(supervisorRuns)
    .where(
      and(
        eq(supervisorRuns.runId, run.parentRunId),
        eq(supervisorRuns.tenantId, d.tenantId),
      ),
    );
  if (supervisor)
    throw conflict(
      "Use the supervisor run to steer, retry, cancel, or approve this assignment",
    );
}
export function runsRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.get("/runs/:runId/events/stream", async (req, res, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      const id = z.string().uuid().parse(req.params.runId);
      await getRun(d, id);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      const seen = new Set<string>();
      req.on("close", () => {
        closed = true;
        if (timer) clearTimeout(timer);
      });
      const poll = async () => {
        if (closed) return;
        try {
          await repairLegacyRuns(d, { runId: id });
          const run = await getRun(d, id);
          const events = await d.db
            .select()
            .from(agentRunEvents)
            .where(
              and(
                eq(agentRunEvents.runId, id),
                eq(agentRunEvents.tenantId, d.tenantId),
              ),
            )
            .orderBy(agentRunEvents.createdAt);
          for (const item of events) {
            if (seen.has(item.id)) continue;
            res.write(
              `id: ${item.id}\nevent: activity\ndata: ${JSON.stringify(item)}\n\n`,
            );
            seen.add(item.id);
          }
          res.write(
            `event: status\ndata: ${JSON.stringify({ id: run.id, status: run.status, partialOutput: run.partialOutput, outputSummary: run.outputSummary, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: run.durationMs })}\n\n`,
          );
          if (!["queued", "running"].includes(run.status)) {
            res.end();
            return;
          }
          timer = setTimeout(poll, 750);
        } catch {
          res.end();
        }
      };
      void poll();
    } catch (e) {
      next(e);
    }
  });
  const route = (
    method: "get" | "post",
    path: string,
    permission:
      "knowledge:read" | "knowledge:write" | "knowledge:approve" | "agent:run",
    fn: (d: AppDeps, req: Request) => Promise<any>,
  ) =>
    router[method](path, async (req, res, next) => {
      try {
        const d = getDeps(req);
        d.requirePermission(permission);
        res.status(method === "post" ? 201 : 200).json(ok(await fn(d, req)));
      } catch (e) {
        next(e);
      }
    });
  async function create(
    d: AppDeps,
    input: z.infer<typeof runInput>,
    retryOfRunId?: string,
    lineage?: { parentRunId?: string; specialistRole?: string },
    providerOverride?: import("@richtfest/shared").AgentProvider,
    modelPolicyOverride?: unknown,
    deferExecution = false,
  ) {
    if (!(await d.validateProject(input.projectId)))
      throw missing("Project not found");
    d.requirePermission("knowledge:read");
    d.requirePermission("projects:read");
    if (input.conversationId)
      await conversation(d, input.conversationId, input.projectId);
    if (input.messageId) {
      if (!input.conversationId)
        throw missing("Message requires a conversation");
      const [message] = await d.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, input.messageId),
            eq(messages.conversationId, input.conversationId),
            eq(messages.tenantId, d.tenantId),
          ),
        );
      if (!message) throw missing("Message not found in conversation");
    }
    if (input.taskId) {
      const [task] = await d.db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.tenantId, d.tenantId),
            eq(tasks.projectId, input.projectId),
          ),
        );
      if (
        !task ||
        (task.conversationId && task.conversationId !== input.conversationId)
      )
        throw missing("Task not found in project and conversation");
    }
    const workflow = input.workflow?.mode === "report"
      ? agentWorkflowSchema.parse({ ...input.workflow,
          reportTemplate: input.workflow.reportTemplate ?? requestedAcousticConcept(input.goal) ?? "sound-insulation-review" })
      : input.workflow;
    if (workflow && workflow.mode !== "chat" && !d.supervisorEnabled)
      throw conflict("Team, Report and Calculation require supervisor execution to be enabled");
    if ((workflow?.mode === "report" || workflow?.mode === "calculation") && !input.sourceVersionIds.length) {
      const inventory = await d.listProjectSources(input.projectId);
      if (inventory.truncated)
        throw conflict("Project evidence exceeds the automatic selection limit. Narrow the evidence scope before starting a report.");
      const sourceVersionIds = [...new Set(inventory.sources.map(source =>
        source.pdfRepresentation?.pdf.versionId ?? source.versionId))];
      if (!sourceVersionIds.length)
        throw conflict("No ready project evidence is available. Reference and comparison reports cannot supply project facts.");
      input = { ...input, sourceVersionIds };
    }
    await sources(d, input.projectId, input.sourceVersionIds);
    const provider = providerOverride ?? await d.resolveActiveProvider?.() ?? "openai";
    const calculation = input.intent === "calculation" && workflow?.mode !== "calculation";
    const configured = calculation
      ? false
      : await d.providerConfigured(provider);
    const useSupervisor = d.supervisorEnabled && !lineage?.parentRunId && workflow?.mode !== "chat";
    const resolvedPolicy = modelPolicyOverride
      ? agentPresetSnapshotSchema.parse(modelPolicyOverride)
      : configured || workflow
        ? await d.resolveSupervisorPreset?.(input.effort, provider)
        : undefined;
    if (workflow && !resolvedPolicy) throw conflict("Workflow model policy unavailable");
    const modelPolicy = resolvedPolicy ? { ...resolvedPolicy, ...(workflow ? { workflow } : {}),
      ...(useSupervisor && d.estimateCallCost
        ? { runBudget: { ...agentRunBudgetSchema.parse(input.budget ?? {}), authorizedAt: new Date().toISOString() } } : {}),
    } : undefined;
    if (useSupervisor && configured && !modelPolicy)
      throw conflict("Supervisor model policy unavailable");
    const { workflow: _workflow, budget: _budget, ...runValues } = input;
    const row = await d.db.transaction(async (tx: any) => {
      const [created] = await tx
        .insert(agentRuns)
        .values({
          ...runValues,
          provider,
          checkpointVersion: configured ? 1 : 0,
          modelPolicy: modelPolicy ?? null,
          retryOfRunId,
          parentRunId: lineage?.parentRunId,
          specialistRole: lineage?.specialistRole,
          tenantId: d.tenantId,
          status: calculation
            ? "validated_tool_unavailable"
            : configured
              ? "queued"
              : "unconfigured",
          error: calculation
            ? "No validated deterministic calculation tool is available. No calculation was performed."
            : configured
              ? null
              : "Configure a personal or workspace connection for the selected provider.",
          correlationId: crypto.randomUUID(),
          requestedBy: d.actorId,
        })
        .returning();
      if (useSupervisor && configured)
        await createSupervisor(d, tx, created, input.effort, modelPolicy);
      await d.audit(
        tx,
        "knowledge.agent_run.created",
        "agent_run",
        created.id,
        {
          projectId: input.projectId,
          provider,
          status: created.status,
          workflow,
          retryOfRunId,
          correlationId: created.correlationId,
        },
      );
      return created;
    });
    if (configured && !useSupervisor && !deferExecution)
      void executeRun(d, row).catch(() => undefined);
    return row;
  }
  router.use(workflowProposalsRouter(getDeps,
    (d, input) => create(d, runInput.parse(input), undefined, undefined, undefined, undefined, true),
    (d, run) => { void executeRun(d, run).catch(() => undefined); }));
  route("post", "/runs", "agent:run", (d, req) =>
    create(d, runInput.parse(req.body)),
  );
  route("post", "/mode-recommendation", "agent:run", async (d, req) => {
    const input = runInput.pick({ projectId: true, conversationId: true, goal: true, sourceVersionIds: true }).parse(req.body);
    d.requirePermission("knowledge:read");
    d.requirePermission("projects:read");
    if (!(await d.validateProject(input.projectId))) throw missing("Project not found");
    if (input.conversationId) await conversation(d, input.conversationId, input.projectId);
    await sources(d, input.projectId, input.sourceVersionIds);
    const history = input.conversationId ? await d.db.select({ body: messages.body, actorKind: messages.actorKind })
      .from(messages).where(and(eq(messages.tenantId, d.tenantId), eq(messages.conversationId, input.conversationId)))
      .orderBy(desc(messages.createdAt), desc(messages.id)).limit(21) : [];
    return recommendMode(d, input.projectId, { goal: input.goal,
      selectedSourceCount: input.sourceVersionIds.length, history: history.slice(0, 20).reverse() },
    history.length <= 20 && history.every((message: any) => message.body.length <= 2000));
  });
  route("get", "/runs/:runId/steps", "knowledge:read", async (d, req) => {
    const run = await getRun(d, String(req.params.runId));
    const page = z.coerce.number().int().min(0).default(0).parse(req.query.page);
    return d.db.select({ id: agentRunSteps.id, runId: agentRunSteps.runId, attemptId: agentRunSteps.attemptId,
      version: agentRunSteps.version, generation: agentRunSteps.generation, kind: agentRunSteps.kind,
      stepKey: agentRunSteps.stepKey, inputHash: agentRunSteps.inputHash, status: agentRunSteps.status,
      reusedFromStepId: agentRunSteps.reusedFromStepId, createdAt: agentRunSteps.createdAt,
    }).from(agentRunSteps).where(and(eq(agentRunSteps.tenantId, d.tenantId), eq(agentRunSteps.runId, run.id)))
      .orderBy(agentRunSteps.createdAt, agentRunSteps.id).limit(50).offset(page * 50);
  });
  route("get", "/runs/:runId/steps/:stepId", "knowledge:read", async (d, req) => {
    const run = await getRun(d, String(req.params.runId));
    const [step] = await d.db.select().from(agentRunSteps).where(and(eq(agentRunSteps.tenantId, d.tenantId),
      eq(agentRunSteps.runId, run.id), eq(agentRunSteps.id, z.string().uuid().parse(req.params.stepId))));
    if (!step) throw missing("Run step not found");
    return step;
  });
  route("get", "/runs/:runId", "knowledge:read", async (d, req) => {
    let run = await getRun(d, String(req.params.runId));
    const [orchestration] = await d.db
      .select()
      .from(supervisorRuns)
      .where(
        and(
          eq(supervisorRuns.runId, run.id),
          eq(supervisorRuns.tenantId, d.tenantId),
        ),
      );
    await repairLegacyRuns(d, { runId: run.id });
    run = await getRun(d, run.id);
    const [events, approvals, output] = await Promise.all([
      d.db
        .select()
        .from(agentRunEvents)
        .where(
          and(
            eq(agentRunEvents.runId, run.id),
            eq(agentRunEvents.tenantId, d.tenantId),
          ),
        )
        .orderBy(agentRunEvents.createdAt),
      d.db
        .select()
        .from(agentRunApprovals)
        .where(
          and(
            eq(agentRunApprovals.runId, run.id),
            eq(agentRunApprovals.tenantId, d.tenantId),
          ),
        ),
      d.db
        .select()
        .from(artifacts)
        .where(
          and(eq(artifacts.runId, run.id), eq(artifacts.tenantId, d.tenantId)),
        ),
    ]);
    const children = await d.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.parentRunId, run.id),
          eq(agentRuns.tenantId, d.tenantId),
        ),
      );
    const usageRows = await d.db
      .select()
      .from(agentRunUsage)
      .where(
        and(
          eq(agentRunUsage.tenantId, d.tenantId),
          inArray(agentRunUsage.runId, [run.id, ...children.map((child: any) => child.id)]),
        ),
      )
      .orderBy(agentRunUsage.startedAt);
    const callRows = usageRows.map((row: any) => ({
      id: row.id,
      runId: row.runId,
      attemptId: row.attemptId,
      callIndex: row.callIndex,
      provider: row.provider,
      modelId: row.modelId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      cachedInputTokens: row.cachedInputTokens,
      totalTokens: row.totalTokens,
      estimatedCostUsd: row.estimatedCostUsd == null ? null : Number(row.estimatedCostUsd) / 1_000_000,
      pricingVersion: row.pricingVersion,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    }));
    const ownUsage = summarizeUsageRows(usageRows.filter((row: any) => row.runId === run.id));
    const aggregateUsage = summarizeUsageRows(usageRows);
    const attempts = await d.db.select().from(agentRunAttempts).where(and(
      eq(agentRunAttempts.tenantId, d.tenantId),
      inArray(agentRunAttempts.runId, [run.id, ...children.map((child: any) => child.id)]),
    )).orderBy(agentRunAttempts.startedAt);
    return {
      run,
      events,
      threadMessages: await runThreadMessages(d, run),
      approvals,
      attempts,
      artifacts: output,
      orchestration: orchestration
        ? { ...orchestration, leaseToken: undefined }
        : null,
      children,
      usage: {
        calls: callRows,
        ...ownUsage,
        own: ownUsage,
        aggregate: aggregateUsage,
      },
    };
  });
  route("post", "/runs/:runId/steer", "agent:run", async (d, req) => {
    d.requirePermission("knowledge:write");
    d.requirePermission("knowledge:read");
    d.requirePermission("projects:read");
    const { instruction, messageId, sourceVersionIds } = z
      .object({
        instruction: z.string().trim().min(1).max(5000),
        messageId: z.string().uuid().optional(),
        sourceVersionIds: z.array(z.string().uuid()).max(10).optional(),
      })
      .parse(req.body);
    return d.db.transaction(async (tx: any) => {
      const run = await getRun(d, String(req.params.runId), tx, true);
      const [state] = await tx
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, run.id))
        .for("update");
      if (
        !d.supervisorEnabled ||
        !state ||
        !["queued", "running"].includes(run.status)
      )
        throw conflict("This run cannot be steered");
      if (!(await d.validateProject(run.projectId)))
        throw missing("Project not found");
      if (run.conversationId)
        await conversation({ ...d, db: tx }, run.conversationId, run.projectId);
      if (messageId) {
        if (!run.conversationId)
          throw missing("Message requires a conversation");
        const [message] = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.id, messageId),
              eq(messages.tenantId, d.tenantId),
              eq(messages.conversationId, run.conversationId),
              eq(messages.authorId, d.actorId),
              eq(messages.actorKind, "user"),
            ),
          );
        if (!message) throw missing("User message not found in conversation");
      }
      const selectedSources =
        sourceVersionIds ?? (run.sourceVersionIds as string[]);
      await sources(d, run.projectId, selectedSources);
      let steeringMessageId = messageId ?? null;
      if (!messageId && run.conversationId) {
        const [message] = await tx
          .insert(messages)
          .values({
            tenantId: d.tenantId,
            conversationId: run.conversationId,
            authorId: d.actorId,
            actorKind: "user",
            runId: run.id,
            body: instruction,
            sourceVersionIds: selectedSources,
          })
          .returning();
        steeringMessageId = message.id;
      }
      const steeringCancellationReason = formatChildCancellationReason(
        "cancellation",
        "cancellation",
        "supervisor_steered",
      );
      const stoppedChildren = await tx
        .update(agentRuns)
        .set({
          status: "cancelled",
          error: steeringCancellationReason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentRuns.parentRunId, run.id),
            eq(agentRuns.tenantId, d.tenantId),
            inArray(agentRuns.status, ["queued", "running", "needs_review"]),
          ),
        )
        .returning();
      for (const assignment of state.assignments as any[]) {
        d.cancelExecution(assignment.runId);
        await tx
          .update(tasks)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(tasks.id, assignment.taskId),
              eq(tasks.tenantId, d.tenantId),
            ),
          );
      }
      for (const child of stoppedChildren)
        await event(d, tx, child, "cancelled", undefined, steeringCancellationReason);
      await tx
        .update(supervisorRuns)
        .set({
          generation: state.generation + 1,
          phase: "plan",
          revision: 0,
          assignments: [],
          review: null,
          steering: instruction,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(eq(supervisorRuns.runId, run.id));
      const [updated] = await tx
        .update(agentRuns)
        .set({
          status: "queued",
          messageId: steeringMessageId,
          sourceVersionIds: selectedSources,
          outputSummary: null,
          rationale: null,
          partialOutput: "",
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id))
        .returning();
      d.cancelExecution(run.id);
      await event(
        d,
        tx,
        run,
        "steered",
        undefined,
        "Human steering saved; previous assignments cancelled",
      );
      await d.auditRun(
        tx,
        "knowledge.agent_run.steering_context",
        "agent_run",
        run.id,
        run.id,
        run.correlationId,
        {
          generation: state.generation + 1,
          messageId: steeringMessageId,
          sourceVersionIds: selectedSources,
        },
      );
      return updated;
    });
  });
  const recoveryPreview = async (d: AppDeps, run: any, state: any, tx = d.db) => {
    const accounting = await runAccounting(d, run.id, state?.modelPolicy?.runBudget?.authorizedAt, tx);
    const stopped = /(?:^|;)\s*category=budget(?:;|$)/.test(run.error ?? "")
      ? await tx.select({ settings: agentRunAttempts.settings }).from(agentRunAttempts)
        .innerJoin(agentRuns, eq(agentRuns.id, agentRunAttempts.runId)).where(and(
          eq(agentRunAttempts.tenantId, d.tenantId), eq(agentRuns.tenantId, d.tenantId),
          or(eq(agentRuns.id, run.id), eq(agentRuns.parentRunId, run.id)),
          eq(agentRunAttempts.generation, state?.generation ?? run.generation), eq(agentRunAttempts.failureCategory, "budget"),
        )).orderBy(desc(agentRunAttempts.completedAt)).limit(1) : [];
    const decision = agentBudgetDecisionSchema.safeParse(stopped[0]?.settings?.budgetDecision);
    const draft = state?.review?.documentDraft;
    const sections = Object.entries(draft?.sections ?? {}).map(([key, value]: [string, any]) => ({
      key, savedPieces: value.parts?.filter(Boolean).length ?? 0,
      savedFallbackPieces: Object.values(value.fallbacks ?? {}).reduce((n: number, pieces: any) => n + pieces.filter(Boolean).length, 0),
    }));
    return {
      resumable: !!state && state.phase !== "done" && ["failed", "cancelled"].includes(run.status),
      generation: state?.generation ?? run.generation,
      checkpointHash: stepHash({ status: run.status, state, sources: run.sourceVersionIds, accounting }),
      phase: state?.phase ?? "provider",
      completedSpecialists: state?.assignments?.filter((a: any) => a.output).length ?? 0,
      totalSpecialists: state?.assignments?.length ?? 0,
      sections,
      savedPieces: sections.reduce((n, s) => n + s.savedPieces, 0),
      editorialCandidate: !!draft?.editorial?.candidate,
      preservationChecked: !!draft?.editorial?.check?.preserved,
      accounting,
      ...(decision.success && decision.data.state === "stopped" ? { budgetDecision: decision.data } : {}),
      budgetRequired: !!d.estimateCallCost,
      budget: agentRunBudgetSchema.parse(state?.modelPolicy?.runBudget
        ? { maxCostUsd: state.modelPolicy.runBudget.maxCostUsd, maxAutomaticRetries: state.modelPolicy.runBudget.maxAutomaticRetries } : {}),
    };
  };
  route("get", "/runs/:runId/recovery", "knowledge:read", async (d, req) => {
    const run = await getRun(d, String(req.params.runId));
    await requireIndependentRun(d, run);
    d.requirePermission("projects:read");
    if (!(await d.validateProject(run.projectId))) throw missing("Project not found");
    const [state] = await d.db.select().from(supervisorRuns).where(and(eq(supervisorRuns.runId, run.id), eq(supervisorRuns.tenantId, d.tenantId)));
    return recoveryPreview(d, run, state);
  });
  const retryRun = async (d: AppDeps, req: Request, fresh: boolean) => {
    const run = await getRun(d, String(req.params.runId));
    await requireIndependentRun(d, run);
    if (
      ![
        "unconfigured",
        "failed",
        "cancelled",
        "validated_tool_unavailable",
        ...(fresh ? ["needs_review", "approved"] : []),
      ].includes(run.status)
    )
      throw conflict("Only a stopped or unsuccessful run can be retried");
    const [previousPolicy] = await d.db
      .select()
      .from(supervisorRuns)
      .where(eq(supervisorRuns.runId, run.id));
    if (!fresh && previousPolicy && previousPolicy.phase !== "done") {
      if (!d.supervisorEnabled) throw conflict("Supervisor execution is disabled");
      d.requirePermission("knowledge:read");
      d.requirePermission("knowledge:write");
      d.requirePermission("projects:read");
      if (!(await d.validateProject(run.projectId))) throw missing("Project not found");
      if (run.conversationId) await conversation(d, run.conversationId, run.projectId);
      return d.db.transaction(async (tx: any) => {
        const current = await getRun(d, run.id, tx, true);
        const [state] = await tx.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run.id)).for("update");
        if (!["failed", "cancelled"].includes(current.status) || !state || state.phase === "done") throw conflict("Run is no longer resumable");
        let modelPolicy = state.modelPolicy;
        if (d.estimateCallCost || req.body?.checkpointHash) {
          const input = z.object({ checkpointHash: z.string().length(64), generation: z.number().int(),
            budget: agentRunBudgetSchema, acknowledgeUnknownOutcomes: z.boolean().default(false) }).strict().parse(req.body);
          const preview = await recoveryPreview(d, current, state, tx);
          if (input.checkpointHash !== preview.checkpointHash || input.generation !== preview.generation)
            throw conflict("Saved progress changed. Reload the recovery preview before authorizing execution.");
          if ((preview.accounting.unknownOutcomes || preview.accounting.unpricedAttempts) && !input.acknowledgeUnknownOutcomes)
            throw conflict("Acknowledge unknown provider outcomes and usage before authorizing recovery.");
          modelPolicy = { ...state.modelPolicy, runBudget: { ...input.budget, authorizedAt: new Date().toISOString() } };
          await d.auditRun(tx, "knowledge.agent_run.recovery_authorized", "agent_run", run.id, run.id, run.correlationId,
            { checkpointHash: input.checkpointHash, generation: input.generation, budget: modelPolicy.runBudget,
              acknowledgeUnknownOutcomes: input.acknowledgeUnknownOutcomes, accounting: preview.accounting });
        }
        await interruptProviderAttempts(d, tx, run.id, "human_authorized_recovery");
        await sources({ ...d, db: tx }, run.projectId, [...new Set<string>([
          ...run.sourceVersionIds, ...state.assignments.flatMap((a: any) => a.sourceVersionIds),
        ])]);
        for (const assignment of state.assignments) {
          await tx.update(agentRuns).set({ status: assignment.output ? "needs_review" : "queued", error: null, finishedAt: null, durationMs: null, updatedAt: new Date() })
            .where(and(eq(agentRuns.id, assignment.runId), eq(agentRuns.tenantId, d.tenantId)));
          await tx.update(tasks).set({ status: assignment.output ? "needs_review" : "in_progress" })
            .where(and(eq(tasks.id, assignment.taskId), eq(tasks.tenantId, d.tenantId)));
        }
        await tx.update(supervisorRuns).set({ generation: state.generation + 1, leaseToken: null, leaseUntil: null, modelPolicy })
          .where(eq(supervisorRuns.runId, run.id));
        const [updated] = await tx.update(agentRuns).set({ status: "queued", error: null, requestedBy: d.actorId, modelPolicy,
          startedAt: null, finishedAt: null, durationMs: null, updatedAt: new Date() }).where(eq(agentRuns.id, run.id)).returning();
        await event(d, tx, run, "resumed", undefined, "Interrupted run resumed from saved progress");
        return updated;
      });
    }
    if (!fresh && !previousPolicy && run.checkpointVersion === 1 && !run.outputSummary && run.intent !== "calculation") {
      d.requirePermission("knowledge:read");
      d.requirePermission("projects:read");
      if (!(await d.validateProject(run.projectId))) throw missing("Project not found");
      if (run.conversationId) await conversation(d, run.conversationId, run.projectId);
      if (!(await d.providerConfigured(run.provider))) throw conflict("Configure the selected provider before retrying");
      const modelPolicy = run.modelPolicy ?? await d.resolveSupervisorPreset?.("medium", run.provider);
      const updated = await d.db.transaction(async (tx: any) => {
        const current = await getRun(d, run.id, tx, true);
        if (!["failed", "cancelled", "unconfigured", "validated_tool_unavailable"].includes(current.status)
          || current.generation !== run.generation) throw conflict("Run is no longer resumable");
        await sources({ ...d, db: tx }, run.projectId, run.sourceVersionIds);
        const [row] = await tx.update(agentRuns).set({ status: "queued", error: null, modelPolicy,
          generation: current.generation + 1, requestedBy: d.actorId, partialOutput: "",
          startedAt: null, finishedAt: null, durationMs: null, updatedAt: new Date() })
          .where(eq(agentRuns.id, run.id)).returning();
        await event(d, tx, run, "resumed", undefined, "Run resumed from saved steps");
        return row;
      });
      void executeRun(d, updated).catch(() => undefined);
      return updated;
    }
    return create(
      d,
      runInput.parse({
        ...run,
        workflow: run.modelPolicy?.workflow,
        effort: previousPolicy?.effort ?? run.modelPolicy?.effort ?? "medium",
        messageId: run.messageId ?? undefined,
        conversationId: run.conversationId ?? undefined,
        taskId: run.taskId ?? undefined,
      }),
      run.id,
      {
        parentRunId: run.parentRunId ?? undefined,
        specialistRole: run.specialistRole ?? undefined,
      },
      run.provider,
      fresh ? undefined : run.modelPolicy ?? previousPolicy?.modelPolicy,
    );
  };
  route("post", "/runs/:runId/retry", "agent:run", (d, req) => retryRun(d, req, false));
  route("post", "/runs/:runId/rerun", "agent:run", (d, req) => retryRun(d, req, true));
  route("post", "/runs/:runId/cancel", "knowledge:write", async (d, req) =>
    d.db.transaction(async (tx: any) => {
      const run = await getRun(d, String(req.params.runId), tx, true);
      await requireIndependentRun(d, run, tx);
      if (
        !["queued", "running", "needs_review", "unconfigured"].includes(
          run.status,
        )
      )
        throw conflict("Run cannot be cancelled in its current state");
      const [updated] = await tx
        .update(agentRuns)
        .set({ status: "cancelled", error: userCancellationReason, updatedAt: new Date() })
        .where(eq(agentRuns.id, run.id))
        .returning();
      await interruptProviderAttempts(d, tx, run.id, "human_cancelled_run");
      const children = await tx
        .update(agentRuns)
        .set({
          status: "cancelled",
          error: formatChildCancellationReason(
            "cancellation",
            "cancellation",
            "supervisor_cancelled",
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentRuns.parentRunId, run.id),
            eq(agentRuns.tenantId, d.tenantId),
            inArray(agentRuns.status, ["queued", "running", "needs_review"]),
          ),
        )
        .returning();
      for (const child of children) {
        if (child.taskId)
          await tx
            .update(tasks)
            .set({ status: "cancelled" })
            .where(
              and(eq(tasks.id, child.taskId), eq(tasks.tenantId, d.tenantId)),
            );
        d.cancelExecution(child.id);
        await event(
          d,
          tx,
          child,
          "cancelled",
          undefined,
          "Parent run cancelled by user; child run cancelled as a consequence",
        );
      }
      d.cancelExecution(run.id);
      await d.audit(tx, "knowledge.agent_run.cancelled", "agent_run", run.id, {
        runId: run.id,
        correlationId: run.correlationId,
      });
      await event(d, tx, run, "cancelled");
      return updated;
    }),
  );
  route("post", "/runs/:runId/approve", "knowledge:approve", async (d, req) => {
    const input = z
      .object({
        decision: z.enum(["approved", "rejected"]),
        note: z.string().max(2000).optional(),
        evaluation: agentRunEvaluationSchema.optional(),
      })
      .parse(req.body);
    return d.db.transaction(async (tx: any) => {
      const run = await getRun(d, String(req.params.runId), tx, true);
      await requireIndependentRun(d, run, tx);
      if (run.status !== "needs_review" || !run.outputSummary?.trim())
        throw conflict(
          "Only a completed run with persisted output can be reviewed",
        );
      // Evaluate the generated output, not later human edits to its artifacts.
      const [supervisor] = input.evaluation ? await tx.select({ review: supervisorRuns.review })
        .from(supervisorRuns).where(and(eq(supervisorRuns.runId, run.id), eq(supervisorRuns.tenantId, d.tenantId))) : [];
      const finalRevision = z.object({ result: z.object({ revisionId: z.string().uuid() }) }).safeParse(supervisor?.review);
      const revisions = input.evaluation ? await tx.select({ id: artifactRevisions.id })
        .from(artifactRevisions).innerJoin(artifacts, eq(artifactRevisions.artifactId, artifacts.id))
        .where(and(eq(artifacts.runId, run.id), eq(artifacts.tenantId, d.tenantId),
          eq(artifactRevisions.tenantId, d.tenantId),
          finalRevision.success ? eq(artifactRevisions.id, finalRevision.data.result.revisionId) : eq(artifactRevisions.version, 1))) : [];
      const [approval] = await tx
        .insert(agentRunApprovals)
        .values({
          tenantId: d.tenantId,
          runId: run.id,
          ...input,
          evaluation: input.evaluation ? { ...input.evaluation, rubricVersion: 1 } : null,
          evaluatedOutput: input.evaluation ? {
            summary: run.outputSummary, rationale: run.rationale,
            artifactRevisionIds: revisions.map((revision: any) => revision.id),
          } : null,
          decidedBy: d.actorId,
        })
        .returning();
      const [updated] = await tx
        .update(agentRuns)
        .set({
          status: input.decision === "approved" ? "approved" : "cancelled",
          error: input.decision === "approved" ? null : reviewRejectionReason,
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id))
        .returning();
      await d.audit(
        tx,
        "knowledge.agent_run.approval_recorded",
        "agent_run",
        run.id,
        {
          decision: input.decision,
          approvalId: approval.id,
          evaluation: approval.evaluation,
          runId: run.id,
          correlationId: run.correlationId,
        },
      );
      return { run: updated, approval };
    });
  });
  return router;
}
