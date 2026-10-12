import { expect, test } from "bun:test";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { acousticConceptFixture } from "./fixtures/acoustic-concepts";
import {
  stepSupervisor,
  createSupervisor,
} from "../richtfest-apps/knowledge/src/supervisor";
import {
  agentRuns,
  supervisorRuns,
  conversations,
  messages,
  artifacts,
  artifactRevisions,
  agentRunEvents,
  agentRunAttempts,
  agentRunUsage,
  tasks,
} from "../richtfest-apps/knowledge/src/schema";
const integration = process.env.DATABASE_URL ? test : test.skip;

for (const templateId of ["sound-insulation-review", "interior-noise-concept", "exterior-noise-concept"] as const)
for (const independentReviewEnabled of [false, true]) integration(
  `${templateId} delegation preserves revision-linked template data (independent review: ${independentReviewEnabled})`,
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID(), versionId = crypto.randomUUID();
    const model = { modelId: "test-model", maxOutputTokens: 2048, maxSteps: 1 };
    const template = templateId !== "sound-insulation-review" ? acousticConceptFixture(templateId, "en", versionId) : {
      id: "sound-insulation-review", version: 1, language: "en", scope: "Review one room.",
      sourcesAndRevisions: `Imported source declarations [${versionId}].`, requirements: "External noise level missing.",
      entities: [{ kind: "room", label: "Room 101", versionId, entityKey: "#42", page: null,
        globalId: "1AbCdEfGhIjKlMnOpQrStu", observations: "Declared room; no verified acoustic properties." }],
      findings: "No calculation performed.", measures: "Obtain window evidence.", openIssues: "Confirm input values.",
    };
    const sourceText = JSON.stringify({ entity: { key: "#42", name: "Room 101", kind: "IFCSPACE", globalId: "1AbCdEfGhIjKlMnOpQrStu" },
      predicate: "Name", value: { type: "text", value: "Room 101" }, provenance: "deterministic", reviewStatus: "unreviewed" });
    const d: any = {
      db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
      validateProject: async () => true, validateSourceVersion: async (_: string, id: string) => id === versionId,
      listProjectSources: async () => ({ sources: [{ versionId, name: "model.ifc" }], truncated: false }),
      resolveSource: async () => ({ status: "resolved", source: { versionId, name: "model.ifc" },
        content: { status: "available", text: sourceText, truncated: true, model: { method: "ifc", status: "complete" } } }),
      executeSupervisor: async (input: any) => {
        if (input.phase === "plan") {
          expect(input.context.workspaceGuidance.availableRoles).toEqual(["source_reviewer", "requirements_reviewer", "sound_insulation"]);
          return { status: "completed", output: { tasks: [{ role: "sound_insulation", goal: "Review room acoustic declarations", sourceVersionIds: [versionId] }] } };
        }
        if (input.phase === "specialist") {
          expect(input.context.workspaceGuidance.profile.key).toBe("sound_insulation");
          expect(input.context.sources[0].text).toBe(sourceText);
          return { status: "completed", output: { summary: "Room 101, #42, GlobalId 1AbCdEfGhIjKlMnOpQrStu. Acoustic values absent from selected evidence.", rationale: "Unreviewed declaration", citations: [versionId] } };
        }
        if (input.phase === "independent_review") {
          expect(input.context.firstPassReview.document.content).toContain(templateId === "sound-insulation-review" ? "## 8. Review status" : "## Review status and acknowledgment");
          expect(input.context.firstPassReview.document.template).toEqual(template);
          return { status: "completed", output: { summary: "Draft checked", rationale: "Declarations remain unreviewed", decision: "accept", revisions: [], findings: [], citations: [versionId] } };
        }
        expect(input.context.documentTemplate).toEqual({ id: "sound-insulation-review", version: 1 });
        return { status: "completed", output: { summary: "Review ready", rationale: "Needs specialist review", decision: "accept", revisions: [], citations: [versionId],
          document: { title: "Sound insulation review", content: "MODEL CONTENT MUST NOT WIN", template } } };
      },
    };
    try {
      const [run] = await db.insert(agentRuns).values({ tenantId, projectId, goal: "Review room acoustics", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
      await createSupervisor(d, db, run, "medium", { provider: "openai", effort: "medium", version: 1, source: "workspace", supervisor: model,
        specialists: { source_reviewer: model, requirements_reviewer: model, sound_insulation: model }, independentReviewEnabled, maxParallel: 2, maxTasks: 4, maxRevisions: 1 });
      for (let step = 0; step < 5; step++) await stepSupervisor(d, run!.id);
      const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
      expect(state!.phase).toBe("done");
      const revisions = await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId));
      expect(revisions).toHaveLength(1);
      expect((revisions[0]!.payload as any).template).toEqual(template);
      expect(revisions[0]!.sourceVersionIds).toEqual([versionId]);
      expect(revisions[0]!.content).not.toContain("MODEL CONTENT MUST NOT WIN");
      expect(revisions[0]!.content).toContain("No calculation was performed.");
      if (templateId === "sound-insulation-review") {
        expect(revisions[0]!.content).toContain("1AbCdEfGhIjKlMnOpQrStu");
        expect(revisions[0]!.content).toContain("## 4. Room and component references");
      } else {
        expect(revisions[0]!.content).toContain("## Appendix · Calculation evidence");
        expect(revisions[0]!.content).toContain("No calculation evidence supplied. No appendix attached.");
        expect(revisions[0]!.content).toContain("Separating wall W-17");
      }
      const children = await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, run!.id));
      expect(children.map(child => child.specialistRole)).toEqual(["sound_insulation"]);
    } finally {
      for (const table of [artifactRevisions, artifacts, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks]) {
        await db.delete(table).where(eq(table.tenantId, tenantId));
      }
      await pool.end();
    }
  },
);

integration(
  "supervisor completion creates exact proposed artifact revision once per generation",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID(),
      sourceId = crypto.randomUUID();
    const model = { modelId: "test-model", maxOutputTokens: 1024, maxSteps: 1 };
    const policy = {
      provider: "openai",
      effort: "medium",
      version: 1,
      source: "vendor",
      supervisor: model,
      specialists: { source_reviewer: model, requirements_reviewer: model },
      maxParallel: 2,
      maxTasks: 4,
      maxRevisions: 2,
    };
    let providerCalls = 0;
    const document = { title: "Source-based project concept", content: `# Requested concept\n\nProposed measures [${sourceId}]\n\n${"Full review-ready detail. ".repeat(500)}`.trim() };
    const d: any = {
      db,
      tenantId,
      actorId,
      requirePermission: () => {},
      validateProject: async () => true,
      validateSourceVersion: async () => true,
      auditRun: async () => {},
      resolveSource: async () => ({ status: "resolved", source: { versionId: sourceId, name: "Evidence" }, content: { status: "available", text: "Source requirements" } }),
      executeSupervisor: async (input: any) => {
        providerCalls++;
        await input.onUsage?.({ provider: "openai", modelId: "test-model", inputTokens: 17, outputTokens: 3, totalTokens: 20, reasoningTokens: null, cachedInputTokens: null });
        if (providerCalls === 1) throw Object.assign(new Error("sk-do-not-persist"), {
          providerFailure: true, retryable: true, failureCategory: "validation",
        });
        if (input.phase === "independent_review") {
          expect(input.context.firstPassReview.document).toEqual(document);
          return { status: "completed", output: { decision: "accept", summary: "Independently checked", rationale: "Source reread", citations: [], revisions: [],
            findings: [{ severity: "note", issue: "Keep assumptions visible", recommendation: "Confirm scope", citations: [] }] } };
        }
        return {
        status: "completed",
        output: {
          decision: "accept",
          summary: "Actual reviewed result",
          document,
          rationale: "Checked source evidence",
          citations: [sourceId],
          revisions: [],
        },
        };
      },
    };
    try {
      const [thread] = await db
        .insert(conversations)
        .values({ tenantId, projectId, title: "Review", createdBy: actorId })
        .returning();
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId,
          conversationId: thread!.id,
          goal: "Review the project requirements",
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      await createSupervisor(d, db, run, "medium", policy);
      const assignments = [
        {
          runId: crypto.randomUUID(),
          taskId: crypto.randomUUID(),
          goal: "Review evidence",
          role: "source_reviewer",
          sourceVersionIds: [sourceId],
          output: {
            summary: "Child evidence",
            rationale: "Bounded",
            citations: [sourceId],
          },
        },
      ];
      await db
        .update(supervisorRuns)
        .set({ phase: "review", assignments })
        .where(eq(supervisorRuns.runId, run!.id));
      await stepSupervisor(d, run!.id);
      await stepSupervisor(d, run!.id);
      const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, run!.id)).orderBy(agentRunAttempts.startedAt);
      expect(attempts.map(attempt => [attempt.status, attempt.attemptNumber, attempt.usageStatus])).toEqual([
        ["failed", 1, "reported"], ["completed", 2, "reported"],
      ]);
      expect(attempts[0]!.operationId).toBe(attempts[1]!.operationId);
      expect(attempts[0]!.generation).toBe(0);
      expect(attempts[0]!.failureCategory).toBe("validation");
      expect(JSON.stringify(attempts)).not.toContain("sk-do-not-persist");
      const usage = await db.select().from(agentRunUsage).where(eq(agentRunUsage.runId, run!.id));
      expect(usage).toHaveLength(2);
      expect(usage.map(row => row.attemptId).sort()).toEqual(attempts.map(attempt => attempt.id).sort());
      const artifactRows = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.runId, run!.id));
      expect(artifactRows).toHaveLength(1);
      expect(artifactRows[0]!.status).toBe("draft");
      expect(artifactRows[0]!.title).toBe(document.title);
      const revisions = await db
        .select()
        .from(artifactRevisions)
        .where(eq(artifactRevisions.artifactId, artifactRows[0]!.id));
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.content).toContain(document.content);
      expect(revisions[0]!.content).toContain("Checked source evidence");
      expect(revisions[0]!.sourceVersionIds).toEqual([sourceId]);
      const outputs = await db
        .select()
        .from(messages)
        .where(eq(messages.runId, run!.id));
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.body).toBe("Actual reviewed result");
      const reference = {
        kind: "supervisor_result",
        artifactId: artifactRows[0]!.id,
        revisionId: revisions[0]!.id,
        generation: 0,
      };
      expect(outputs[0]!.openui).toBe(
        `root = ArtifactPdf(${JSON.stringify(reference.artifactId)}, ${JSON.stringify(reference.revisionId)})`,
      );
      expect(outputs[0]!.sourceRef).toBeNull();
      const [parent] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, run!.id));
      expect(parent!.status).toBe("needs_review");
      expect(parent!.outputSummary).toBe("Actual reviewed result");
      // A later human-steered generation must have its own immutable proposal and exact reference.
      await db
        .update(supervisorRuns)
        .set({ generation: 1, phase: "review", modelPolicy: { ...policy, independentReviewEnabled: true } })
        .where(eq(supervisorRuns.runId, run!.id));
      await db
        .update(agentRuns)
        .set({ status: "queued" })
        .where(eq(agentRuns.id, run!.id));
      await stepSupervisor(d, run!.id);
      await stepSupervisor(d, run!.id);
      await stepSupervisor(d, run!.id);
      const later = await db
        .select()
        .from(messages)
        .where(eq(messages.runId, run!.id));
      expect(later).toHaveLength(2);
      const [resultState] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, run!.id));
      const newest = (resultState!.review as any).result;
      expect(
        later.some(
          (m) =>
            m.openui ===
            `root = ArtifactPdf(${JSON.stringify(newest.artifactId)}, ${JSON.stringify(newest.revisionId)})`,
        ),
      ).toBe(true);
      expect(newest.artifactId).not.toBe(reference.artifactId);
      expect(newest.revisionId).not.toBe(reference.revisionId);
      const [independentlyReviewed] = await db.select().from(artifactRevisions).where(eq(artifactRevisions.id, newest.revisionId));
      expect(independentlyReviewed!.content).toContain(document.content);
      expect(independentlyReviewed!.content).toContain("Keep assumptions visible");
      expect(independentlyReviewed!.content).toContain("coverage complete");
      expect(independentlyReviewed!.sourceVersionIds).toEqual([sourceId]);
      expect(later.every(message => !message.body.includes("Full review-ready detail"))).toBe(true);
      expect(
        await db
          .select()
          .from(artifactRevisions)
          .where(eq(artifactRevisions.id, revisions[0]!.id)),
      ).toEqual(revisions);
      const [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, run!.id));
      expect((state!.review as any).result).toEqual(newest);
    } finally {
      await db.delete(agentRunUsage).where(eq(agentRunUsage.tenantId, tenantId));
      await db.delete(agentRunAttempts).where(eq(agentRunAttempts.tenantId, tenantId));
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db.delete(messages).where(eq(messages.tenantId, tenantId));
      await db
        .delete(conversations)
        .where(eq(conversations.tenantId, tenantId));
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await pool.end();
    }
  },
);
