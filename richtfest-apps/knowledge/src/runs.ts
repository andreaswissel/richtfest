import { Router, type Request } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agentPresetSnapshotSchema, ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
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
} from "./schema";
import {
  conversation,
  sources,
  missing,
  conflict,
  createArtifact,
} from "./workspace";
import { repairLegacyRuns } from "./run-recovery";
import { createSupervisor } from "./supervisor";
const runInput = z.object({
  effort: z.enum(["low", "medium", "high", "ultra"]).default("medium"),
  messageId: z.string().uuid().optional(),
  intent: z.enum(["assist", "calculation"]).default("assist"),
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  goal: z.string().trim().min(1).max(5000),
  sourceVersionIds: z.array(z.string().uuid()).max(10).default([]),
});
export const outputInput = z.object({
  summary: z.string().trim().min(1).max(10000),
  rationale: z.string().max(2000),
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
      content: z.string().min(1).max(50000),
      type: z.literal("draft").default("draft"),
    })
    .nullable()
    .optional(),
});
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
export function validateTool(name: string, input: unknown) {
  if (!Object.hasOwn(toolInputs, name))
    throw conflict("Tool is not allowlisted");
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
    if (current.status !== "running") throw conflict("Run is no longer active");
    return fn(tx);
  });
}
export async function executeRun(d: AppDeps, run: any) {
  try {
    const claimed = await d.db.transaction(async (tx: any) => {
      const current = await getRun(d, run.id, tx, true);
      if (current.status !== "queued") return false;
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
    const sourceInventory = await d.listProjectSources(run.projectId);
    const evidence = new Set<string>();
    const sourceContent = [];
    for (const versionId of run.sourceVersionIds as string[]) {
      const resolved = await d.resolveSource(run.projectId, { versionId });
      sourceContent.push(resolved);
      recordResolvedEvidence(evidence, resolved);
    }
    const history = run.conversationId
      ? await d.db
          .select({
            id: messages.id,
            actorKind: messages.actorKind,
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
      .where(
        and(
          eq(artifacts.tenantId, d.tenantId),
          eq(artifacts.projectId, run.projectId),
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
      artifacts: recentArtifacts,
      priorRuns: recentRuns,
      specialistRole: run.specialistRole ?? null,
      delegationAllowed: !run.parentRunId,
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
    const specialistRole = run.specialistRole as "source_reviewer" | "requirements_reviewer" | undefined;
    const executionModel = specialistRole
      ? modelPolicy?.specialists[specialistRole]
      : modelPolicy?.supervisor;
    let partialOutput = "";
    let lastCheckpoint = 0;
    const onSummaryDelta = async (delta: string) => {
      partialOutput = (partialOutput + delta).slice(0, 10000);
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
    let response = await d.executeProvider({
      runId: run.id,
      onSummaryDelta,
      provider: run.provider,
      modelId: executionModel?.modelId,
      reasoningEffort: executionModel?.reasoningEffort,
      maxOutputTokens: executionModel?.maxOutputTokens,
      goal: run.goal,
      context,
    });
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
    let output = outputInput.parse(response.output);
    assertEvidenceCitations(output, evidence);
    await sources(d, run.projectId, output.citations);
    const results: unknown[] = [];
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
    for (const tool of output.tools) {
      const input = validateTool(tool.name, tool.input) as any;
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
          ? await d.resolveSource(run.projectId, input)
          : undefined;
      recordResolvedEvidence(evidence, resolved);
      await active(d, run, async (tx) => {
        let result: any;
        if (tool.name === "resolve_project_source") result = resolved;
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
      partialOutput = "";
      response = await d.executeProvider({
        runId: run.id,
        onSummaryDelta,
        provider: run.provider,
        modelId: executionModel?.modelId,
        reasoningEffort: executionModel?.reasoningEffort,
        maxOutputTokens: executionModel?.maxOutputTokens,
        goal: run.goal,
        context,
        toolResults: results,
      });
      if (response.status !== "completed")
        throw conflict("Provider connection is no longer configured");
      output = outputInput.parse(response.output);
      assertEvidenceCitations(output, evidence);
      if (output.tools.length)
        throw conflict("Provider exceeded the permitted tool round");
      await sources(d, run.projectId, output.citations);
    }
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
  } catch {
    // Never persist provider exceptions or raw tool arguments; errors may contain credentials.
    await d.db.transaction(async (tx: any) => {
      const current = await getRun(d, run.id, tx, true);
      if (current.status !== "running" && current.status !== "queued") return;
      await tx
        .update(agentRuns)
        .set({
          status: "failed",
          error:
            "Execution failed or returned unsupported output. Check the provider connection and retry. No output was approved.",
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));
      await event(
        d,
        tx,
        run,
        "failed",
        undefined,
        "Provider or tool validation failed; no output approved",
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
            `event: status\ndata: ${JSON.stringify({ id: run.id, status: run.status, partialOutput: run.partialOutput, outputSummary: run.outputSummary })}\n\n`,
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
    await sources(d, input.projectId, input.sourceVersionIds);
    const provider = providerOverride ?? await d.resolveActiveProvider?.() ?? "openai";
    const calculation = input.intent === "calculation";
    const configured = calculation
      ? false
      : await d.providerConfigured(provider);
    const useSupervisor = d.supervisorEnabled && !lineage?.parentRunId;
    const modelPolicy = modelPolicyOverride
      ? agentPresetSnapshotSchema.parse(modelPolicyOverride)
      : configured
        ? await d.resolveSupervisorPreset?.(input.effort, provider)
        : undefined;
    if (useSupervisor && configured && !modelPolicy)
      throw conflict("Supervisor model policy unavailable");
    const row = await d.db.transaction(async (tx: any) => {
      const [created] = await tx
        .insert(agentRuns)
        .values({
          ...input,
          provider,
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
          retryOfRunId,
          correlationId: created.correlationId,
        },
      );
      return created;
    });
    if (configured && !useSupervisor)
      void executeRun(d, row).catch(() => undefined);
    return row;
  }
  route("post", "/runs", "agent:run", (d, req) =>
    create(d, runInput.parse(req.body)),
  );
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
    return {
      run,
      events,
      approvals,
      artifacts: output,
      orchestration: orchestration
        ? { ...orchestration, leaseToken: undefined }
        : null,
      children,
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
      await tx
        .update(agentRuns)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(agentRuns.parentRunId, run.id),
            eq(agentRuns.tenantId, d.tenantId),
          ),
        );
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
  route("post", "/runs/:runId/retry", "agent:run", async (d, req) => {
    const run = await getRun(d, String(req.params.runId));
    await requireIndependentRun(d, run);
    if (
      ![
        "unconfigured",
        "failed",
        "cancelled",
        "validated_tool_unavailable",
      ].includes(run.status)
    )
      throw conflict("Only a stopped or unsuccessful run can be retried");
    const [previousPolicy] = await d.db
      .select()
      .from(supervisorRuns)
      .where(eq(supervisorRuns.runId, run.id));
    return create(
      d,
      runInput.parse({
        ...run,
        effort: previousPolicy?.effort ?? "medium",
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
      run.modelPolicy ?? previousPolicy?.modelPolicy,
    );
  });
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
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(agentRuns.id, run.id))
        .returning();
      const children = await tx
        .update(agentRuns)
        .set({ status: "cancelled", updatedAt: new Date() })
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
          "Parent run cancelled",
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
      })
      .parse(req.body);
    return d.db.transaction(async (tx: any) => {
      const run = await getRun(d, String(req.params.runId), tx, true);
      await requireIndependentRun(d, run, tx);
      if (run.status !== "needs_review" || !run.outputSummary?.trim())
        throw conflict(
          "Only a completed run with persisted output can be reviewed",
        );
      const [approval] = await tx
        .insert(agentRunApprovals)
        .values({
          tenantId: d.tenantId,
          runId: run.id,
          ...input,
          decidedBy: d.actorId,
        })
        .returning();
      const [updated] = await tx
        .update(agentRuns)
        .set({
          status: input.decision === "approved" ? "approved" : "cancelled",
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
          runId: run.id,
          correlationId: run.correlationId,
        },
      );
      return { run: updated, approval };
    });
  });
  return router;
}
