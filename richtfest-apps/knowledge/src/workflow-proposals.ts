import { Router, type Request } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { agentEffortSchema, agentRunBudgetSchema, agentWorkflowRequestSchema, requestedAcousticConcept,
  workflowProposalSchema, ok, type WorkflowProposal } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { artifacts, artifactRevisions, conversations, messages, agentRuns } from "./schema";
import { conversation, conflict, missing, sources } from "./workspace";
import { recommendMode } from "./decision-routing";

type CreateRun = (d: AppDeps, input: { projectId: string; conversationId: string; messageId: string;
  goal: string; sourceVersionIds: string[]; effort: WorkflowProposal["effort"];
  budget: WorkflowProposal["budget"]; workflow: z.infer<typeof agentWorkflowRequestSchema> }) => Promise<any>;

/** Existing revision JSON holds immutable proposals; artifact status/runId holds their decision.
 * No PDFs or document-list entries: these records belong only to the conversation. */
export function workflowProposalsRouter(getDeps: (req: Request) => AppDeps, createRun: CreateRun,
  dispatchChat: (d: AppDeps, run: any) => void) {
  const router = Router();
  // All visible cards share one query rather than fetching once per historical message.
  router.get("/conversations/:conversationId/workflow-proposals", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      d.requirePermission("projects:read");
      const conversationId = z.string().uuid().parse(req.params.conversationId);
      const chat = await conversation(d, conversationId);
      if (!chat.projectId || !(await d.validateProject(chat.projectId))) throw missing();
      const rows = await d.db.select({ id: artifacts.id, status: artifacts.status, runId: artifacts.runId,
        payload: artifactRevisions.payload }).from(artifacts).innerJoin(artifactRevisions,
        and(eq(artifactRevisions.artifactId, artifacts.id), eq(artifactRevisions.tenantId, d.tenantId)))
        .where(and(eq(artifacts.tenantId, d.tenantId), eq(artifacts.projectId, chat.projectId),
          eq(artifacts.type, "workflow_proposal"),
          sql`${artifactRevisions.version} = (select max(r.version) from knowledge_artifact_revisions r where r.artifact_id = ${artifacts.id} and r.tenant_id = ${d.tenantId})`,
          sql`${artifactRevisions.payload}->'workflowProposal'->>'conversationId' = ${conversationId}`))
        .orderBy(desc(artifacts.createdAt)).limit(100);
      res.json(ok(rows.map(({ payload, ...row }: any) => ({ ...workflowProposalSchema.parse(payload.workflowProposal),
        ...row, supervisorEnabled: !!d.supervisorEnabled }))));
    } catch (error) { next(error); }
  });
  const path = "/conversations/:conversationId/workflow-proposals/:proposalId";
  for (const method of ["get", "post"] as const) router[method](path, async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      d.requirePermission("projects:read");
      if (method === "post") { d.requirePermission("agent:run"); d.requirePermission("knowledge:write"); }
      const conversationId = z.string().uuid().parse(req.params.conversationId);
      const id = z.string().uuid().parse(req.params.proposalId);
      const chat = await conversation(d, conversationId);
      if (!chat.projectId || !(await d.validateProject(chat.projectId))) throw missing();
      const input = method === "post" ? z.discriminatedUnion("action", [
        z.object({ action: z.literal("propose"), effort: agentEffortSchema.default("medium") }).strict(),
        z.object({ action: z.literal("confirm"), workflow: agentWorkflowRequestSchema,
          budget: agentRunBudgetSchema }).strict(),
        z.object({ action: z.literal("cancel") }).strict(),
      ]).parse(req.body) : null;
      let directRun: any;
      const result = await d.db.transaction(async (tx: any) => {
        // Serializes proposals, confirmations and archive actions in this conversation.
        const [lockedChat] = await tx.select().from(conversations).where(and(
          eq(conversations.id, conversationId), eq(conversations.tenantId, d.tenantId))).for("update");
        if (input && lockedChat.archivedAt) throw conflict("Conversation is archived");
        let [record] = await tx.select().from(artifacts).where(and(eq(artifacts.id, id),
          eq(artifacts.tenantId, d.tenantId), eq(artifacts.projectId, chat.projectId),
          eq(artifacts.type, "workflow_proposal")));
        let proposal: z.infer<typeof workflowProposalSchema>;
        if (!record) {
          if (input?.action !== "propose") throw missing();
          // The source message is the idempotency key; never accept a client-authored goal or recommendation.
          const [message] = await tx.select().from(messages).where(and(eq(messages.id, id),
            eq(messages.tenantId, d.tenantId), eq(messages.conversationId, conversationId),
            eq(messages.authorId, d.actorId), eq(messages.actorKind, "user")));
          if (!message) throw missing();
          const selected = z.array(z.string().uuid()).max(100).parse(message.sourceVersionIds);
          await sources(d, chat.projectId, selected);
          const history = await tx.select({ body: messages.body, actorKind: messages.actorKind }).from(messages)
            .where(and(eq(messages.tenantId, d.tenantId), eq(messages.conversationId, conversationId)))
            .orderBy(desc(messages.createdAt), desc(messages.id)).limit(21);
          const recommendation = await recommendMode({ ...d, db: tx }, chat.projectId,
            { goal: message.body, selectedSourceCount: selected.length, history: history.slice(0, 20).reverse() },
            history.length <= 20 && history.every((m: any) => m.body.length <= 2000));
          const mode = recommendation.outcome === "classified" ? recommendation.recommendation : null;
          proposal = workflowProposalSchema.parse({ version: 1, conversationId, messageId: id,
            goal: message.body, sourceVersionIds: selected, effort: input.effort, budget: agentRunBudgetSchema.parse({}),
            recommendation, workflow: !mode || mode === "uncertain" ? null : mode === "report"
              ? { mode, reportTemplate: requestedAcousticConcept(message.body) } : { mode } });
          [record] = await tx.insert(artifacts).values({ id, tenantId: d.tenantId, projectId: chat.projectId,
            type: "workflow_proposal", status: "pending", title: "Workflow proposal", createdBy: d.actorId }).returning();
          await tx.insert(artifactRevisions).values({ tenantId: d.tenantId, artifactId: id, version: 1,
            title: record.title, content: message.body, payload: { workflowProposal: proposal },
            sourceVersionIds: selected, createdBy: d.actorId });
          await d.audit(tx, "knowledge.workflow.proposed", "artifact", id, { recommendation: mode, messageId: id });
          if (mode !== "chat") await tx.insert(messages).values({ tenantId: d.tenantId, conversationId,
            authorId: d.actorId, actorKind: "agent", parentMessageId: id, body: "",
            openui: `root = WorkflowProposal(${JSON.stringify(id)})` });
        } else {
          const [revision] = await tx.select().from(artifactRevisions).where(and(
            eq(artifactRevisions.artifactId, id), eq(artifactRevisions.tenantId, d.tenantId)))
            .orderBy(desc(artifactRevisions.version)).limit(1);
          proposal = workflowProposalSchema.parse(revision?.payload?.workflowProposal);
          if (proposal.conversationId !== conversationId) throw missing();
        }
        if (record.status === "pending" && input?.action === "cancel") {
          [record] = await tx.update(artifacts).set({ status: "cancelled" }).where(eq(artifacts.id, id)).returning();
          await d.audit(tx, "knowledge.workflow.cancelled", "artifact", id, {});
        } else if (record.status === "pending" && (input?.action === "confirm"
          || (input?.action === "propose" && proposal.workflow?.mode === "chat"))) {
          const workflow = input.action === "confirm" ? input.workflow : proposal.workflow!;
          if (workflow.mode === "report" && !workflow.reportTemplate)
            throw conflict("Choose the report format before starting");
          const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(
            eq(agentRuns.tenantId, d.tenantId), eq(agentRuns.conversationId, conversationId),
            inArray(agentRuns.status, ["queued", "running"])) ).limit(1);
          if (active) throw conflict("A run is already active in this conversation");
          const budget = input.action === "confirm" ? input.budget : proposal.budget;
          const run = await createRun({ ...d, db: tx }, { projectId: chat.projectId, conversationId,
            messageId: proposal.messageId, goal: proposal.goal, sourceVersionIds: proposal.sourceVersionIds,
            effort: proposal.effort, budget, workflow });
          proposal = { ...proposal, workflow, budget };
          await tx.insert(artifactRevisions).values({ tenantId: d.tenantId, artifactId: id, version: 2,
            title: record.title, content: proposal.goal, payload: { workflowProposal: proposal },
            sourceVersionIds: proposal.sourceVersionIds, createdBy: d.actorId });
          [record] = await tx.update(artifacts).set({ status: "confirmed", runId: run.id })
            .where(eq(artifacts.id, id)).returning();
          await d.audit(tx, "knowledge.workflow.confirmed", "artifact", id,
            { runId: run.id, workflow, budget, automaticChat: input.action === "propose" });
          if (workflow.mode === "chat" && run.status === "queued") directRun = run;
        }
        return { ...proposal, id, status: record.status, runId: record.runId,
          supervisorEnabled: !!d.supervisorEnabled };
      });
      // Never start a provider before the transaction containing its authorization commits.
      if (directRun) dispatchChat(d, directRun);
      res.json(ok(result));
    } catch (error) { next(error); }
  });
  return router;
}
