import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import express from "../richtfest-os/apps/api/node_modules/express";
import { and, eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import {
  artifactRevisions,
  artifacts,
  agentRuns,
  supervisorRuns,
  tasks,
  agentRunEvents,
  agentRunUsage,
  agentRunAttempts,
  agentRunSteps,
  conversations,
  messages,
} from "../richtfest-apps/knowledge/src/schema";
import {
  stepSupervisor,
  createSupervisor,
} from "../richtfest-apps/knowledge/src/supervisor";
import { workspaceRouter } from "../richtfest-apps/knowledge/src/workspace";
import { runsRouter } from "../richtfest-apps/knowledge/src/runs";
import { stepHash } from "../richtfest-apps/knowledge/src/run-steps";
import { soundInsulationPlanningFixture as fixture } from "./fixtures/sound-insulation-planning";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";
import { calculateAcoustics } from "../richtfest-apps/acoustics/src/calculations";
import { acousticConceptFixture } from "./fixtures/acoustic-concepts";
import { exteriorNoiseFixture } from "./fixtures/exterior-noise";
const integration = process.env.DATABASE_URL ? test : test.skip;
const config = { modelId: "test-model", maxOutputTokens: 1024, maxSteps: 1 };
const policy = {
  provider: "openai" as const,
  effort: "medium" as const,
  version: 1,
  source: "vendor" as const,
  supervisor: config,
  specialists: { source_reviewer: config, requirements_reviewer: config },
  maxParallel: 2,
  maxTasks: 4,
  maxRevisions: 2,
};

for (const scenario of ["success", "recover", "unavailable", "no_call", "abort"] as const)
integration(`visual source scope and durable citation authorization: ${scenario}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const versionId = crypto.randomUUID(), siblingVersionId = crypto.randomUUID();
  const image = Buffer.from("private-rendered-image-bytes");
  const target = { versionId, page: 1, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } };
  let renders = 0, calls = 0;
  const d: any = { db, tenantId, actorId, supervisorEnabled: true, providerConfigured: async () => false, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async () => true,
    listProjectSources: async () => ({ sources: [versionId, siblingVersionId].map(versionId => ({ versionId, name: "Unreadable drawing", version: 1 })), truncated: false }),
    resolveSource: async (_project: string, input: any) => ({ status: "resolved", source: { versionId: input.versionId, name: "Unreadable drawing", version: 1 },
      content: { status: "extraction_failed", reason: "No readable text" } }),
    inspectSource: async (project: string, input: any) => {
      expect(project).toBe(projectId); renders++;
      const unavailable = scenario === "unavailable" || (scenario === "recover" && calls === 1);
      return { ...input, status: unavailable ? "unavailable" : "available", scope: "pdf_page", reason: "Unreviewed visual evidence",
        ...(unavailable ? {} : { image: { mediaType: "image/jpeg", data: image.toString("base64") } }) };
    },
    executeSupervisor: async (request: any) => {
      if (request.phase === "plan") {
        expect(request.inspectSource).toBeUndefined();
        return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Inspect drawing", sourceVersionIds: [versionId] }] } };
      }
      calls++;
      if ((scenario === "success" && calls === 2) || (scenario === "recover" && calls === 3)) {
        // A replay must restore authorization from the persisted receipt even
        // when this model attempt never requests the image again.
        return { status: "completed", output: { summary: "Visual evidence recovered", rationale: "Unreviewed", citations: [versionId] } };
      }
      await expect(request.inspectSource({ ...target, versionId: siblingVersionId })).rejects.toThrow("outside this call's source scope");
      await expect(request.inspectSource(target, AbortSignal.abort())).rejects.toThrow();
      if (scenario === "success" || scenario === "recover" || scenario === "unavailable") {
        const [first, duplicate] = await Promise.all([request.inspectSource(target), request.inspectSource(target)]);
        expect(first).toEqual(duplicate);
        for (const page of [2, 3, 4]) await request.inspectSource({ versionId, page });
        expect(await request.inspectSource({ versionId, page: 5 })).toMatchObject({ status: "budget_exhausted" });
      }
      if (scenario === "success" || scenario === "recover") throw Object.assign(new Error("Interrupted after visual read"), { code: "timeout", providerFailure: true, retryable: false });
      return { status: "completed", output: { summary: "Must not authorize unreadable citation", rationale: "", citations: [versionId] } };
    },
  };
  const server = express().use(express.json()).use(runsRouter(() => d)).listen(0);
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId, goal: "Visual citation regression", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)))[0]!.status).toBe("failed");
    const steps = await db.select().from(agentRunSteps).where(and(eq(agentRunSteps.tenantId, tenantId), eq(agentRunSteps.kind, "tool")));
    expect(steps).toHaveLength(scenario === "success" || scenario === "recover" || scenario === "unavailable" ? 5 : 0);
    expect(renders).toBe(scenario === "success" || scenario === "recover" || scenario === "unavailable" ? 4 : 0);
    const serialized = JSON.stringify(steps);
    expect(serialized).not.toContain(image.toString("base64"));
    expect(serialized).not.toContain("private-rendered-image-bytes");
    if (scenario === "success" || scenario === "recover") {
      if (scenario === "recover") {
        expect(steps.filter(step => (step.output as any).status === "unavailable")).toHaveLength(4);
        expect(steps.filter(step => (step.output as any).status === "budget_exhausted")).toHaveLength(1);
        expect((await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${run!.id}/retry`, { method: "POST" })).status).toBe(201);
        await stepSupervisor(d, run!.id);
        expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)))[0]!.status).toBe("failed");
      }
      const receipts = await db.select().from(agentRunSteps).where(and(eq(agentRunSteps.tenantId, tenantId), eq(agentRunSteps.kind, "tool")));
      const cropped = receipts.find(step => (step.output as any).page === 1 && (step.output as any).status === "available")!;
      expect(cropped.input).toEqual({ name: "inspect_project_source", input: target });
      expect(cropped.output).toMatchObject({ ...target, status: "available", imageHash: createHash("sha256").update(image).digest("hex") });
      expect((cropped.output as any).image).toBeUndefined();
      const detail = await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${cropped.runId}/steps/${cropped.id}`);
      expect(detail.status).toBe(200);
      expect((await detail.json()).data.output).toEqual(cropped.output);
      expect((await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${run!.id}/retry`, { method: "POST" })).status).toBe(201);
      await stepSupervisor(d, run!.id);
      expect(renders).toBe(scenario === "recover" ? 8 : 4);
      const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
      expect(state!.phase).toBe("review");
      expect((state!.assignments as any[])[0].output.citations).toEqual([versionId]);
    } else {
      const failures = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.tenantId, tenantId));
      expect(failures.filter(attempt => attempt.failureCategory === "validation")).toHaveLength(3);
      const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
      expect((state!.assignments as any[])[0].output).toBeUndefined();
    }
  } finally {
    server.close();
    for (const table of [agentRunSteps, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

for (const format of ["stable", "legacy"] as const)
for (const changed of ["none", "source", "goal", "run", "revision", "batch", "findings", "scope", "missing_prompt", "malformed_prompt", "redacted_prompt"] as const)
integration(`visual replay proves logical receipt identity: ${format}/${changed}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), versionId = crypto.randomUUID();
  const target = { versionId, page: 1, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } };
  const compatible = changed === "none" || changed === "redacted_prompt"
    || (format === "stable" && (changed === "missing_prompt" || changed === "malformed_prompt"));
  let calls = 0, renders = 0;
  let original: any;
  const d: any = { db, tenantId, actorId, supervisorEnabled: true, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async () => true,
    listProjectSources: async () => ({ sources: [{ versionId }], truncated: false }),
    resolveSource: async () => ({ status: "resolved", source: { versionId, name: "Drawing", version: 1 },
      content: { status: "extraction_failed", reason: "No readable text" } }),
    inspectSource: async (_: string, input: any) => {
      expect(input).toEqual(target);
      renders++;
      return { ...input, status: "available", scope: "pdf_page", reason: "Unreviewed",
        image: { mediaType: "image/jpeg", data: "c3ludGhldGlj" } };
    },
    executeSupervisor: async (request: any) => {
      if (request.phase === "plan") return { status: "completed", output: { tasks: [
        { role: "source_reviewer", goal: "Inspect drawing", sourceVersionIds: [versionId] },
      ] } };
      calls++;
      // Match the runtime's persisted prepared prompt, including host enrichment.
      await request.onPrepared({ version: 1, instructions: "Inspect supplied evidence",
        prompt: JSON.stringify({ goal: request.goal, context: request.context }) });
      if (calls === 1) {
        const { fireProtection, buildingModel, buildingModelPolicy, companyKnowledge, companyKnowledgeCategories,
          acousticToolsAvailable, messaging, componentCatalog, documentReview, workspaceGuidance, budgets,
          outputValidationFeedback, ...context } = request.context;
        original = { phase: "specialist", goal: request.goal, context, runId: request.runId, revision: 0 };
        await request.inspectSource(target);
        throw Object.assign(new Error("Interrupted after visual read"), { code: "timeout", providerFailure: true, retryable: false });
      }
      if (calls === 2) {
        expect(request.context.visualReadCoverage.entries).toHaveLength(1);
        expect(renders).toBe(1);
        // The presence of an assignment receipt alone must never authorize this.
      } else {
        expect(compatible).toBe(false);
        expect(request.context.outputValidationFeedback).toMatchObject({
          errorId: "SOURCE_CITATION_OUT_OF_SCOPE", rejectedCitations: [versionId],
        });
        await request.inspectSource(target);
      }
      return { status: "completed", output: { summary: "Visual findings", rationale: "Unreviewed", citations: [versionId] } };
    },
  };
  const server = express().use(express.json()).use(runsRouter(() => d)).listen(0);
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(),
      goal: "Replay identity regression", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    const retry = (state!.history as any[]).find(entry => entry.phase === "provider_retry");
    const { visualReadCoverage, ...stableContext } = original.context;
    expect(stepHash({ ...original, context: stableContext })).toBe(retry.callKey);
    const historical = structuredClone(original);
    if (format === "stable") delete historical.context.visualReadCoverage;
    // Synthesize saved calls with one differing identity dimension. Their
    // receipts stay in the same assignment, but must not authorize this replay.
    if (changed === "source") historical.context.unreadableSources[0].reason = "Different extraction";
    if (changed === "goal") historical.goal = "A different instruction";
    if (changed === "run") historical.runId = crypto.randomUUID();
    if (changed === "revision") historical.revision = 1;
    if (changed === "batch") historical.context.sourceCoverage.batch = 2;
    if (changed === "findings") historical.context.previousFindings = { summary: "Other findings", rationale: "", citations: [] };
    if (changed === "scope") historical.context.visualRequests = [{ ...target, page: 2 }];
    const historicalKey = stepHash(historical);
    await db.update(supervisorRuns).set({ history: (state!.history as any[]).map(entry => entry === retry
      ? { ...entry, callKey: historicalKey } : entry) }).where(eq(supervisorRuns.runId, run!.id));
    const saved = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, original.runId));
    expect(saved.filter(step => step.kind === "model" && typeof (step.input as any).prompt === "string")).toHaveLength(2);
    for (const step of saved) {
      if (step.kind === "tool") await db.update(agentRunSteps).set({
        stepKey: step.stepKey.replace(retry.callKey, historicalKey),
      }).where(eq(agentRunSteps.id, step.id));
      if (step.kind === "model") {
        const input = { ...(step.input as any) };
        if (changed === "missing_prompt") delete input.prompt;
        else if (changed === "malformed_prompt") input.prompt = "not JSON";
        else input.prompt = JSON.stringify({ goal: changed === "redacted_prompt" ? "[redacted]" : historical.goal,
          context: { ...JSON.parse(input.prompt).context, ...historical.context } });
        await db.update(agentRunSteps).set({ input }).where(eq(agentRunSteps.id, step.id));
      }
    }
    const retryResponse = await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${run!.id}/retry`, { method: "POST" });
    expect(retryResponse.status).toBe(201);
    await stepSupervisor(d, run!.id);
    const [done] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    expect(done!.phase).toBe("review");
    expect((done!.assignments as any[])[0].output.citations).toEqual([versionId]);
    expect(calls).toBe(compatible ? 2 : 3);
    expect(renders).toBe(compatible ? 1 : 2);
    const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, original.runId));
    expect(attempts.filter(attempt => attempt.failureCategory === "validation")).toHaveLength(compatible ? 0 : 1);
    const receipts = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, original.runId));
    expect(JSON.stringify(receipts)).not.toContain("c3ludGhldGlj");
  } finally {
    server.close();
    for (const table of [agentRunSteps, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

for (const inspect of [false, true])
integration(`image triage receipts never authorize unreadable citations without vision: ${inspect}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID(), versionId = crypto.randomUUID();
  let queries = 0;
  const d: any = { db, tenantId, actorId, supervisorEnabled: true, providerConfigured: async () => false,
    requirePermission: () => {}, auditRun: async () => {}, validateProject: async () => true, validateSourceVersion: async () => true,
    listProjectSources: async () => ({ sources: [{ versionId, name: "Plan", version: 1 }], truncated: false }),
    resolveSource: async () => ({ status: "resolved", source: { versionId, name: "Plan", version: 1 },
      content: { status: "extraction_failed", reason: "No readable text" } }),
    executeImageDecision: async () => { throw new Error("Cached upload result must not buy inference"); },
    querySourceImage: async (_project: string, input: any) => { queries++; return { ...input, status: "completed", reused: true,
      provenance: "inferred", semanticInspection: false, model: "jev-1.14.0", queryVersion: "image-triage-v1",
      reason: "Experimental classification", answers: { table: { type: "noul", noul: 0.999 } } }; },
    inspectSource: async (_project: string, input: any) => ({ ...input, status: "available", scope: "pdf_page", reason: "Unreviewed",
      image: { mediaType: "image/jpeg", data: "c3ludGhldGlj" } }),
    executeSupervisor: async (request: any) => {
      if (request.phase === "plan") {
        expect(request.querySourceImage).toBeUndefined();
        return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Inspect drawing", sourceVersionIds: [versionId] }] } };
      }
      await expect(request.querySourceImage({ versionId: crypto.randomUUID(), page: 1 })).rejects.toThrow("outside this call's source scope");
      const first = await request.querySourceImage({ versionId, page: 1 });
      expect(await request.querySourceImage({ versionId, page: 1 })).toEqual(first);
      for (const page of [2, 3, 4]) await request.querySourceImage({ versionId, page });
      expect(await request.querySourceImage({ versionId, page: 5 })).toMatchObject({ status: "limit_reached" });
      if (inspect) await request.inspectSource({ versionId, page: 1 });
      return { status: "completed", output: { summary: "Source claim", rationale: "Unreviewed", citations: [versionId] } };
    },
  };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId, goal: "Image triage", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, run!.id); await stepSupervisor(d, run!.id);
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    if (inspect) {
      expect(state!.phase).toBe("review");
      expect((state!.assignments as any[])[0].output.citations).toEqual([versionId]);
      expect(queries).toBe(4);
    } else {
      expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)))[0]!.status).toBe("failed");
      expect((state!.assignments as any[])[0].output).toBeUndefined();
    }
    const steps = await db.select().from(agentRunSteps).where(and(eq(agentRunSteps.tenantId, tenantId), eq(agentRunSteps.kind, "tool")));
    expect(steps.filter(step => step.stepKey.startsWith("image-query:")).length).toBeGreaterThanOrEqual(4);
    expect(steps.filter(step => step.stepKey.startsWith("visual:"))).toHaveLength(inspect ? 1 : 0);
    expect(JSON.stringify(steps)).not.toContain("c3ludGhldGlj");
    expect(await db.select().from(agentRunUsage).where(eq(agentRunUsage.tenantId, tenantId))).toHaveLength(0);
  } finally {
    for (const table of [agentRunSteps, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

for (const scenario of ["recover", "report", "report_exhausted", "exhausted", "ignored"] as const)
integration(`visual budget recovery preserves findings and shares the revision limit: ${scenario}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const versions = Array.from({ length: 10 }, () => crypto.randomUUID());
  const requests = versions.slice(0, 9).map((versionId, index) => ({ versionId, page: 1,
    ...(index === 8 ? { crop: { x: 0.2, y: 0.1, width: 0.5, height: 0.6 } } : {}) }));
  const renders: any[] = [], sourceCalls: string[] = [], normalBatches: any[] = [], followups: any[] = [];
  let siblingCalls = 0, reviewerCalls = 0;
  let runId = "", interrupted = false;
  const recovers = scenario === "recover" || scenario === "report";
  const maxRevisions = recovers ? 2 : 1;
  const concept = acousticConceptFixture("exterior-noise-concept", "en", versions[0]!);
  const d: any = { db, tenantId, actorId, supervisorEnabled: true, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async () => true,
    sourceReferences: async (_: string, ids: string[]) => ids.map(versionId => ({ versionId, name: "Synthetic source", version: 1 })),
    listProjectSources: async () => ({ sources: versions.map(versionId => ({ versionId, name: "Synthetic source", version: 1 })), truncated: false }),
    resolveSource: async (_: string, { versionId }: any) => {
      sourceCalls.push(versionId);
      return { status: "resolved", source: { versionId, name: "Synthetic source", version: 1 },
        content: { status: "available", text: "Saved evidence" } };
    },
    inspectSource: async (_: string, input: any) => {
      renders.push(input);
      return input.versionId === versions[1]
        ? { ...input, status: "unavailable", scope: "image", reason: "Render failed" }
        : { ...input, status: "available", scope: "image", reason: "Unreviewed", image: { mediaType: "image/jpeg", data: "c3ludGhldGlj" } };
    },
    executeSupervisor: async (request: any) => {
      const context = request.context;
      if (request.phase === "plan") return { status: "completed", output: { tasks: [
        { role: "source_reviewer", goal: "Read sources", sourceVersionIds: versions },
        { role: "requirements_reviewer", goal: "Independent requirement", sourceVersionIds: [] },
      ] } };
      if (request.phase === "review") {
        if (context.documentTask) expect(context.outstandingVisualReads).toBeUndefined();
        if (context.documentTask === "outline") {
          reviewerCalls++;
          expect(context.findings.map((f: any) => f.output.summary)).toEqual([
            "Saved batch 1", "Saved batch 2", "Saved batch 3", "Saved batch 4",
            "Saved batch 4; visual supplement", ...(recovers ? ["Saved batch 4; visual supplement; visual supplement"] : []), "Saved sibling",
          ]);
          return { status: "completed", output: { id: "exterior-noise-concept", title: "Visual evidence report", language: "en", project: concept.project,
            sections: context.sectionKeys.map((key: string) => ({ key, sources: [{ versionId: versions[0], pageStart: 1, pageEnd: 1 }] })), attachments: [] } };
        }
        if (context.documentTask === "editorial") return { status: "completed", output: {
          sections: context.sectionKeys.map((key: string) => ({ key, content: context.original[key] })), complete: true } };
        if (context.documentTask === "editorial_check") return { status: "completed", output: { preserved: true, issues: [] } };
        if (context.documentTask === "consolidation") return { status: "completed", output: {
          complete: true, replacements: context.original.map((fragment: any) => ({ id: fragment.id, content: null })) } };
        if (context.documentTask === "section") return { status: "completed", output: {
          content: (concept as any)[context.section], citations: [versions[0]], complete: true } };
        reviewerCalls++;
        expect(context.assignments.find((a: any) => a.role === "requirements_reviewer").output.summary).toBe("Saved sibling");
        expect(context.assignments.find((a: any) => a.role === "source_reviewer").output.citations).toEqual(versions);
        return { status: "completed", output: { summary: "Everything inspected", rationale: "Accept", citations: versions,
          decision: "accept", revisions: [], document: null } };
      }
      if (context.role === "requirements_reviewer") {
        siblingCalls++;
        return { status: "completed", output: { summary: "Saved sibling", rationale: "", citations: [] } };
      }
      if (context.visualRequests) {
        followups.push(context);
        expect(context.sources).toEqual([]);
        expect(context.previousFindings.summary).toContain("Saved batch");
        expect(request.calculateAcoustics).toBeUndefined();
        expect(request.searchCompanyKnowledge).toBeUndefined();
        expect(context.visualRequests.length).toBeLessThanOrEqual(4);
        for (const target of context.visualRequests) expect(requests.slice(4)).toContainEqual(target);
        await expect(request.inspectSource({ ...context.visualRequests[0], page: 2 })).rejects.toThrow("exact page/crop scope");
        if (scenario === "recover" && !interrupted) {
          interrupted = true;
          await db.update(supervisorRuns).set({ leaseToken: null, leaseUntil: null }).where(eq(supervisorRuns.runId, runId));
          return { status: "completed", output: { summary: "Discard late result", rationale: "", citations: [] } };
        }
        if (scenario !== "ignored") for (const target of context.visualRequests) await request.inspectSource(target);
        return { status: "completed", output: { summary: `${context.previousFindings.summary}; visual supplement`, rationale: "Unreviewed", citations: [] } };
      }
      normalBatches.push(context);
      if (context.sourceCoverage.batch === 1) {
        for (const target of requests) await request.inspectSource(target);
        // Null and absent crops identify the same already-counted request.
        expect((await request.inspectSource({ ...requests[0], crop: null })).status).toBe("available");
        await request.inspectSource(requests[8]);
      }
      return { status: "completed", output: { summary: `Saved batch ${context.sourceCoverage.batch}`, rationale: "Render failure retained", citations: context.sourceVersionIds } };
    },
  };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId, sourceVersionIds: versions, goal: "Budget recovery", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    runId = run!.id;
    await createSupervisor(d, db, run, "medium", { ...policy, maxRevisions, workflow: scenario === "report" || scenario === "report_exhausted"
      ? { mode: "report", reportTemplate: "exterior-noise-concept" } : { mode: "team" } });
    await stepSupervisor(d, run!.id);
    const [planned] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    // Legacy small batches exercise saved findings across several normal calls.
    await db.update(supervisorRuns).set({ assignments: (planned!.assignments as any[]).map(({ sourceInputByteBudget, sourceBatchingVersion, exteriorNoiseExtractionVersion, ...a }) => a) }).where(eq(supervisorRuns.runId, run!.id));
    await stepSupervisor(d, run!.id);
    const sourceReadsBeforeFollowup = sourceCalls.length;
    const receipts = await db.select().from(agentRunSteps).where(and(eq(agentRunSteps.tenantId, tenantId), eq(agentRunSteps.kind, "tool")));
    expect(receipts).toHaveLength(9);
    expect(receipts.filter(r => (r.output as any).status === "budget_exhausted")).toHaveLength(5);
    expect(JSON.stringify(receipts)).not.toContain("c3ludGhldGlj");
    expect(renders).toHaveLength(4);
    // Each separately invoked step reloads Postgres checkpoints, as after restart.
    for (let round = 0; round < maxRevisions; round++) {
      await stepSupervisor(d, run!.id);
      const [queued] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
      expect(queued!.revision).toBe(round + 1);
      expect(queued!.phase).toBe("specialists");
      const frozen = (queued!.assignments as any[]).find(a => a.visualFollowup).visualFollowup;
      await stepSupervisor(d, run!.id);
      if (scenario === "recover" && round === 0) {
        const [interruptedState] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
        expect(interruptedState!.revision).toBe(1);
        expect((interruptedState!.assignments as any[]).find(a => a.visualFollowup).visualFollowup).toEqual(frozen);
        await stepSupervisor(d, runId);
      }
      expect(followups.at(-1).visualRequests).toEqual(frozen.requests);
      expect(reviewerCalls).toBe(0);
    }
    expect(sourceCalls.length).toBe(sourceReadsBeforeFollowup);
    await stepSupervisor(d, run!.id);
    const [done] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    const [parent] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(done!.phase).toBe("done");
    expect(parent!.status).toBe("needs_review");
    expect(normalBatches).toHaveLength(4);
    expect(siblingCalls).toBe(1);
    expect(followups).toHaveLength(maxRevisions + (scenario === "recover" ? 1 : 0));
    expect(reviewerCalls).toBe(1);
    expect(renders.filter(r => r.versionId === versions[1])).toHaveLength(1);
    expect(renders.some(r => r.versionId === versions[9])).toBe(false);
    const review = done!.review as any;
    expect(review.outstandingVisualReads).toHaveLength(recovers ? 0 : scenario === "ignored" ? 5 : 1);
    expect(review.decision).toBe(recovers ? "accept" : "revise");
    if (!recovers) {
      expect(parent!.outputSummary).toContain("remain uninspected");
      expect(parent!.rationale).not.toContain(versions[9]!);
      for (const target of review.outstandingVisualReads) expect(parent!.rationale).toContain(target.versionId);
    }
    if (scenario === "report_exhausted") {
      const revisions = await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId));
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.content).toContain("1 requested visual inspection(s) remain uninspected");
      expect(revisions[0]!.content).toContain("This does not establish that the sources are unreadable");
      expect(review.document.template.openIssues).toContain(concept.openIssues);
    }
    expect(renders).toHaveLength(recovers ? 9 : scenario === "ignored" ? 4 : 8);
  } finally {
    for (const table of [artifactRevisions, artifacts, agentRunSteps, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

for (const scenario of ["off", "shadow", "enabled", "uncertain", "broader", "unconfigured", "failure", "malformed", "unreadable", "custom_guidance", "long_context", "cancel", "recover", "foreign_source"] as const)
integration(`decision routing preserves review and fallback: ${scenario}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  let decisionCalls = 0, recover = scenario === "recover";
  const usage = { provider: "openai" as const, modelId: "test-model", inputTokens: 1000, outputTokens: 100,
    totalTokens: 1100, cachedInputTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.01 };
  const goal = scenario === "long_context" ? "Summarize. ".repeat(250) : "Fasse ausschließlich das ausgewählte Dokument zusammen.";
  const d: any = { db, tenantId, actorId, requirePermission: () => {}, audit: async () => {}, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async (_p: string, id: string) => scenario !== "foreign_source" && id === versionId,
    listProjectSources: async () => ({ sources: [{ versionId }], truncated: false }),
    resolveSource: async (_p: string, input: any) => {
      const page = input.pageStart ?? 1;
      return { status: "resolved", source: { versionId, name: "Selected.pdf", version: 1 }, content: {
        status: scenario === "unreadable" ? "unsupported" : "available",
        text: page === 1 ? "First page evidence." : "Essential second page evidence.",
        truncated: page === 1,
        coverage: { pageStart: page, pageEnd: page, totalPages: 2, truncated: page === 1, nextPage: page === 1 ? 2 : null },
        retrieval: { mode: "pages", pageNumbers: [page] },
      } };
    },
    executeDecision: async ({ runId, state }: any) => {
      decisionCalls++;
      expect(state.goal).toBe(goal);
      expect(JSON.stringify(state)).not.toContain("First page evidence");
      if (scenario === "cancel") await db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, runId));
      if (scenario === "failure") throw new Error("secret provider body");
      if (scenario === "unconfigured") return { status: "unconfigured" };
      return { status: "completed", usage: { ...usage, provider: "typesafe", modelId: "jev-1.13.0", estimatedCostUsd: 0.000038 },
        output: scenario === "malformed" ? { answers: "secret" } : { model: "jev-1.13.0", answers: {
          workflow: { type: "choice", choice: "summarize_sources", confidence: scenario === "uncertain" ? 0.989 : 0.99,
            probabilities: { summarize_sources: 0.99, source_question: 0.004, supervisor: 0.004, uncertain: 0.002 } },
          scope: { type: "choice", choice: scenario === "broader" ? "broader" : "self_contained", confidence: 0.995,
            probabilities: scenario === "broader" ? { self_contained: 0.003, broader: 0.995, uncertain: 0.002 }
              : { self_contained: 0.995, broader: 0.003, uncertain: 0.002 } },
        } } };
    },
    executeSupervisor: async ({ phase, context, runId }: any) => {
      if (phase === "plan") {
        if (recover) {
          // Simulate losing the worker lease after the decision checkpoint.
          await db.update(supervisorRuns).set({ leaseToken: null, leaseUntil: null }).where(eq(supervisorRuns.runId, runId));
          throw new Error("worker lease lost");
        }
        return { status: "completed", usage, output: { tasks: [
          { role: "requirements_reviewer", goal: "Normal planner assignment", sourceVersionIds: [versionId] },
        ] } };
      }
      if (phase === "specialist") return { status: "completed", usage, output: {
        summary: context.sources.map((s: any) => s.text).join("\n") || "Missing source", rationale: "Fixture evidence", citations: context.sourceVersionIds,
      } };
      if (phase === "independent_review") return { status: "completed", usage, output: {
        summary: "Independent review complete", rationale: "Reviewed", citations: [versionId], decision: "accept", revisions: [], findings: [],
      } };
      return { status: "completed", usage, output: { decision: "accept", summary: "Summary awaiting human approval", rationale: "Reviewed",
        citations: [versionId], revisions: [], document: { title: "Selected source summary", content: "Reviewed draft" } } };
    },
  };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId, goal, sourceVersionIds: [versionId],
      provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    const mode = scenario === "off" ? "off" : scenario === "shadow" || scenario === "recover" ? "shadow" : "enabled";
    await createSupervisor(d, db, run, "medium", { ...policy, independentReviewEnabled: true,
      decisionRouting: { mode, minConfidence: 0.99 } });
    if (scenario === "custom_guidance") await db.update(supervisorRuns).set({ profileSnapshot: [{ key: "supervisor", version: 1 }] })
      .where(eq(supervisorRuns.runId, run!.id));
    await stepSupervisor(d, run!.id);
    if (scenario === "recover") {
      recover = false;
      await db.update(agentRuns).set({ status: "queued" }).where(eq(agentRuns.id, run!.id));
      await stepSupervisor(d, run!.id);
    }
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    const [parent] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    if (scenario === "cancel" || scenario === "foreign_source") {
      expect(parent!.status).toBe(scenario === "cancel" ? "cancelled" : "failed");
      expect(state!.assignments).toEqual([]);
      if (scenario === "foreign_source") expect(decisionCalls).toBe(0);
      return;
    }
    const assignment = (state!.assignments as any[])[0];
    expect(assignment.sourceVersionIds).toEqual([versionId]);
    expect(assignment.role).toBe(scenario === "enabled" ? "source_reviewer" : "requirements_reviewer");
    expect(assignment.goal).toBe(scenario === "enabled" ? goal : "Normal planner assignment");
    expect(decisionCalls).toBe(["off", "custom_guidance", "long_context"].includes(scenario) ? 0 : 1);
    if (scenario !== "off") {
      const decision = (state!.history as any[]).find(e => e.phase === "decision")?.output;
      expect(decision.selectedRoute).toBe(scenario === "enabled" ? "selected_source_summary" : "supervisor");
      expect(JSON.stringify(decision)).not.toContain("secret");
    }
    if (scenario === "enabled" || scenario === "off") {
      await stepSupervisor(d, run!.id); // specialist
      const [specialists] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
      if (scenario === "enabled") expect((specialists!.assignments as any[])[0].output.summary).toContain("Essential second page evidence");
      await stepSupervisor(d, run!.id); // review
      const [review] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
      expect(review!.phase).toBe("independent_review");
      await stepSupervisor(d, run!.id);
      const [completed] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
      expect(completed!.status).toBe("needs_review");
      const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.tenantId, tenantId));
      expect(attempts.filter(a => a.phase === "plan")).toHaveLength(scenario === "enabled" ? 0 : 1);
      expect(attempts.filter(a => a.phase === "review")).toHaveLength(1);
      expect(attempts.filter(a => a.phase === "independent_review")).toHaveLength(1);
      const costs = await db.select().from(agentRunUsage).where(eq(agentRunUsage.tenantId, tenantId));
      expect(costs.reduce((sum, r) => sum + Number(r.estimatedCostUsd), 0)).toBe(scenario === "enabled" ? 30038 : 40000);
    }
  } finally {
    for (const table of [artifactRevisions, artifacts, messages, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

for (const outcome of ["recover", "exhaust", "cancel", "quota", "long_cooldown"] as const) integration(
  `429 recovery is durable, bounded and cancellable: ${outcome}`, async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
    let now = Date.now(), calls = 0, runId = "", finished = false;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let pending: Promise<void> | undefined;
    const d: any = { db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
      validateProject: async () => true, listProjectSources: async () => ({ sources: [], truncated: false }),
      executeSupervisor: async () => {
        calls++;
        if (outcome === "recover" && calls === 5) return { status: "completed", output: {
          tasks: [{ role: "source_reviewer", goal: "Read evidence", sourceVersionIds: [] }],
        } };
        throw Object.assign(new Error("secret provider response"), { providerFailure: true, retryable: true,
          providerStatus: 429, failureCategory: "provider",
          retryAfterMs: outcome === "long_cooldown" ? 600001 : calls === 1 ? 75000 : undefined,
          diagnostics: { providerCode: outcome === "quota" ? "insufficient_quota" : "rate_limit_exceeded", raw: "secret",
            ...(calls === 2 ? { rateLimit: { remainingTokens: 0, resetTokensMs: 90000 } } : {}),
          },
        });
      },
    };
    try {
      const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Recover rate limit",
        provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
      runId = run!.id;
      await createSupervisor(d, db, run, "medium", policy);
      pending = stepSupervisor(d, runId).finally(() => { finished = true; });
      let restarted = false;
      const delays: number[] = [];
      let seenAttempt = 0;
      for (let polls = 0; !finished && polls < 1500; polls++) {
        const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
        const saved = (state!.history as any[]).find(entry => entry.phase === "provider_retry");
        if (saved && !saved.terminal && saved.attempt > seenAttempt) {
          seenAttempt = saved.attempt;
          delays.push(saved.retryAt - now);
          if (outcome === "cancel") {
            await db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, runId));
          } else {
            if (outcome === "recover" && !restarted) {
              // Lose the worker during cooldown, then restart before it expires.
              await db.update(supervisorRuns).set({ leaseToken: null, leaseUntil: null }).where(eq(supervisorRuns.runId, runId));
              await pending;
              finished = false;
              pending = stepSupervisor(d, runId).finally(() => { finished = true; });
              await new Promise(resolve => setTimeout(resolve, 50));
              expect(calls).toBe(1); // Restart must not bypass the saved cooldown.
              restarted = true;
            }
            now = saved.retryAt;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(finished).toBe(true);
      await pending;
      const [result] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
      expect(result!.status).toBe(outcome === "recover" ? "running" : outcome === "cancel" ? "cancelled" : "failed");
      expect(calls).toBe(outcome === "recover" || outcome === "exhaust" ? 5 : 1);
      if (calls === 5) expect(delays).toEqual([75000, 90000, 120000, 120000]);
      const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, runId));
      expect(attempts.map(a => a.attemptNumber).sort()).toEqual(Array.from({ length: calls }, (_, i) => i + 1));
      expect(new Set(attempts.map(a => a.operationId)).size).toBe(1);
      const events = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId));
      expect(JSON.stringify(events)).not.toContain("secret");
      if (outcome === "recover") {
        const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
        expect(state!.phase).toBe("specialists");
      }
    } finally {
      await db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, runId));
      await pending;
      clock.mockRestore();
      for (const table of [agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
        await db.delete(table).where(eq(table.tenantId, tenantId));
      await pool.end();
    }
  }, 20000,
);

for (const failure of ["rate_limit", "timeout", "service"] as const)
for (const changedEvidence of [false, true]) integration(`${failure} review resumes saved work, invalidating changed evidence: ${changedEvidence}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const versions = Array.from({ length: 4 }, () => crypto.randomUUID());
  const calls: string[] = [];
  const componentCatalog = { status: "available", truncated: false, items: [{
    id: crypto.randomUUID(), revisionId: crypto.randomUUID(), reviewStatus: "reviewed",
    data: { name: "Conditional slab reference", facts: [{ value: 7.5, unit: "m", conditions: "Requires 65 mm topping and temporary support", page: 8 }] },
  }] };
  let rateLimited = true, evidence = "Original evidence", permitted = true;
  const d: any = { db, tenantId, actorId, supervisorEnabled: true,
    requirePermission: () => { if (!permitted) throw Object.assign(new Error("Forbidden"), { status: 403 }); }, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async (_p: string, id: string) => versions.includes(id),
    componentContext: async () => componentCatalog,
    listProjectSources: async () => ({ sources: versions.map(versionId => ({ versionId })), truncated: false }),
    resolveSource: async (_p: string, { versionId }: any) => ({ status: "resolved", source: { versionId }, content: { status: "available", text: `${evidence} ${versionId} ${"x".repeat(14000)}` } }),
    executeSupervisor: async ({ phase, context }: any) => {
      expect(context.componentCatalog).toEqual(componentCatalog);
      calls.push(phase === "independent_review" ? context.reviewTask === "consistency" ? "consistency" : `slice-${context.sourceCoverage.slice}` : phase);
      if (phase === "plan") return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Read all sources", sourceVersionIds: versions }] } };
      if (phase === "specialist") return { status: "completed", output: { summary: "Saved findings", rationale: "Evidence", citations: context.sourceVersionIds } };
      if (phase === "review") return { status: "completed", output: { summary: "Saved handoff", rationale: "Draft only", citations: versions,
        decision: "accept", revisions: [], document: { title: "Preserved draft", content: "# Original document\n\nDo not regenerate this draft." } } };
      if (context.sourceCoverage.slice === 2 && rateLimited) throw Object.assign(new Error("secret"), {
        providerFailure: true, retryable: false,
        ...(failure === "timeout" ? { code: "timeout" } : failure === "service" ? { providerStatus: 500, failureCategory: "provider" }
          : { providerStatus: 429, failureCategory: "provider", diagnostics: { providerCode: "insufficient_quota" } }),
      });
      return { status: "completed", output: { summary: `Reviewed slice ${context.sourceCoverage.slice}`, rationale: "Checked evidence. ".repeat(150), citations: context.sourceCoverage.sliceVersionIds,
        decision: "accept", revisions: [], findings: [] } };
    },
  };
  const server = express().use(express.json()).use(runsRouter(() => d)).use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 500).json({ error: e.message })).listen(0);
  const address = server.address() as { port: number };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId, goal: "Draft with independent review", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", { ...policy, independentReviewEnabled: true,
      executionLimits: { summaryMaxCharacters: 10000, rationaleMaxCharacters: 4000, documentMaxCharacters: 60000, timeoutSeconds: 180 },
    });
    for (let phase = 0; phase < 4; phase++) await stepSupervisor(d, run!.id);
    const [failed] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(failed!.status).toBe("failed");
    const [checkpoint] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    expect((checkpoint!.review as any).document.title).toBe("Preserved draft");
    const before = [...calls];
    permitted = false;
    expect((await fetch(`http://127.0.0.1:${address.port}/runs/${run!.id}/retry`, { method: "POST" })).status).toBe(403);
    permitted = true;
    const retry = await fetch(`http://127.0.0.1:${address.port}/runs/${run!.id}/retry`, { method: "POST" });
    expect(retry.status).toBe(201);
    expect((await retry.json()).data.id).toBe(run!.id);
    expect((await fetch(`http://127.0.0.1:${address.port}/runs/${run!.id}/retry`, { method: "POST" })).status).toBe(409);
    rateLimited = false;
    if (changedEvidence) evidence = "Corrected extraction";
    // Advance past the recorded rate-limit cooldown, without waiting in real time.
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120001);
    try { await stepSupervisor(d, run!.id); } finally { clock.mockRestore(); }
    expect(calls.slice(before.length)).toEqual(changedEvidence ? ["slice-1", "slice-2", "consistency"] : ["slice-2", "consistency"]);
    const [completed] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(completed!.status).toBe("needs_review");
    const revisions = await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.content).toContain("Do not regenerate this draft.");
  } finally {
    server.close();
    for (const table of [artifactRevisions, artifacts, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

for (const scenario of ["complete", "oversized", "legacy"] as const)
integration(`independent review packs requests without losing evidence or saved findings: ${scenario}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const evidence = Array.from({ length: scenario === "complete" ? 40 : 10 }, (_, index) => ({ versionId: crypto.randomUUID(),
    text: `${index}:ä🧱\n${"x".repeat(scenario === "oversized" && index === 0 ? 950000 : 2000)}\nEnd ${index}.`,
  }));
  const versions = evidence.map(source => source.versionId);
  const visualReads = versions.map((versionId, index) => ({ request: { versionId, page: index + 1,
    crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } },
    status: index % 2 ? "budget_exhausted" : "available", receiptId: crypto.randomUUID() }));
  const document = { title: "Review packing", content: `# Draft\n\n## First source\n[${versions[0]}]\nFirst claim.\n\n## Last source\n[${versions[9]}]\nLast claim.\n\n## Assumptions\nKeep uncertainty visible.` };
  const contexts: any[] = [];
  const finding = { severity: "blocking", issue: "First claim contradicts its source", recommendation: "Correct the claim", citations: [versions[0]] };
  const accepted = { summary: "Reviewed evidence", rationale: "Independent check", citations: [], decision: "accept", revisions: [], findings: [] };
  const resolution = (versionId: string) => ({ status: "resolved", source: { versionId },
    content: { status: "available", text: evidence.find(source => source.versionId === versionId)!.text, truncated: false } });
  const d: any = { db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async () => true,
    listProjectSources: async () => ({ sources: versions.map(versionId => ({ versionId })), truncated: false }),
    resolveSource: async (_: string, { versionId }: any) => resolution(versionId),
    executeSupervisor: async ({ phase, context }: any) => {
      if (phase === "plan") return { status: "completed", output: { tasks: Array.from({ length: versions.length / 10 }, (_, index) => ({
        role: "source_reviewer", goal: `Read evidence group ${index + 1}`, sourceVersionIds: versions.slice(index * 10, (index + 1) * 10),
      })) } };
      if (phase === "specialist") return { status: "completed", output: { summary: "Specialist findings", rationale: "Unreviewed", citations: context.sourceVersionIds } };
      if (phase === "review") return { status: "completed", output: { ...accepted, citations: versions, document } };
      contexts.push(context);
      expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(838976);
      expect(context.specialistResults).toBeUndefined();
      const scopedIds = context.sourceCoverage.sliceVersionIds;
      expect(context.assignments.flatMap((assignment: any) => assignment.visualReads ?? [])).toEqual(
        context.reviewTask === "evidence" ? visualReads.filter(read => scopedIds.includes(read.request.versionId)) : visualReads);
      if (context.reviewTask === "consistency") {
        expect(context.firstPassReview.document).toEqual(document);
        expect(context.sourceExcerpts).toEqual([]);
        expect(context.evidenceReview.findings).toContainEqual(finding);
      }
      return { status: "completed", output: scenario === "oversized" && contexts.length === 1
        ? { ...accepted, decision: "revise", findings: [finding], citations: [versions[0]] } : accepted };
    },
  };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Review packing",
      provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", { ...policy, supervisor: { ...config, modelId: "gpt-6-astra" }, independentReviewEnabled: true });
    for (let phase = 0; phase < 3; phase++) await stepSupervisor(d, run!.id);
    const [beforeReview] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    await db.update(supervisorRuns).set({ assignments: (beforeReview!.assignments as any[]).map(assignment => ({
      ...assignment, visualReads: visualReads.filter(read => assignment.sourceVersionIds.includes(read.request.versionId)),
    })) }).where(eq(supervisorRuns.runId, run!.id));
    if (scenario === "legacy") {
      const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
      const sourceSlices = [versions.slice(0, 3), versions.slice(3, 6), versions.slice(6, 9), versions.slice(9)]
        .map(ids => ids.map(versionId => ({ versionId, resolution: resolution(versionId) })));
      // Persist the pre-upgrade wire format, not the new packer's output.
      const inputHash = createHash("sha256").update(JSON.stringify({ goal: run!.goal, assignments: state!.assignments,
        firstPassReview: state!.review, sourceSlices, modelPolicy: state!.modelPolicy, profiles: state!.profileSnapshot },
      (_key, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest("hex");
      await db.update(supervisorRuns).set({ history: [...state!.history, { phase: "independent_review_slice", inputHash, index: 0,
        output: { ...accepted, decision: "revise", findings: [finding], citations: [versions[0]] } }] }).where(eq(supervisorRuns.runId, run!.id));
    }
    await stepSupervisor(d, run!.id);
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    expect(state!.phase).toBe("done");
    expect(contexts.map(context => context.reviewTask)).toEqual(scenario === "oversized"
      ? ["evidence", "evidence", "consistency"] : ["complete"]);
    const supplied = contexts.flatMap(context => context.sourceExcerpts);
    for (const source of evidence) {
      const slices = supplied.filter(item => item.versionId === source.versionId);
      expect(slices.map(item => item.resolution.content.text).join("")).toBe(source.text);
    }
    if (scenario === "oversized") {
      expect((state!.review as any).unresolved).toBe(true);
      expect((state!.review as any).findings).toContainEqual(finding);
    }
    if (scenario === "legacy") {
      // Old scope/length-contract verdicts remain diagnostic history, not current approval.
      expect(state!.history.find((entry: any) => entry.phase === "independent_review_slice")).toMatchObject({
        output: { findings: [finding] },
      });
      expect((state!.review as any).findings).toEqual([]);
    }
    const revisions = await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.content).toContain(document.content);
  } finally {
    for (const table of [artifactRevisions, artifacts, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

for (const failure of ["rate_limit", "timeout"] as const)
integration(`retrying a ${failure} specialist preserves its successful sibling`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const calls: string[] = [];
  let limited = true;
  const d: any = { db, tenantId, actorId, supervisorEnabled: true,
    requirePermission: () => {}, auditRun: async () => {}, validateProject: async () => true,
    listProjectSources: async () => ({ sources: [], truncated: false }),
    executeSupervisor: async ({ phase, goal }: any) => {
      calls.push(phase === "specialist" ? goal : phase);
      if (phase === "plan") return { status: "completed", output: { tasks: [
        { role: "source_reviewer", goal: "Successful sibling", sourceVersionIds: [] },
        { role: "requirements_reviewer", goal: "Interrupted specialist", sourceVersionIds: [] },
      ] } };
      if (phase === "specialist" && goal === "Interrupted specialist" && limited)
        throw Object.assign(new Error("Provider interrupted"), { providerFailure: true, retryable: true,
          ...(failure === "timeout" ? { code: "timeout" } : { providerStatus: 429, diagnostics: { providerCode: "insufficient_quota" } }) });
      return { status: "completed", output: { summary: goal, rationale: "Checked", citations: [],
        ...(phase === "review" ? { decision: "accept", revisions: [] } : {}),
      } };
    },
  };
  const server = express().use(express.json()).use(runsRouter(() => d)).listen(0);
  const address = server.address() as { port: number };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Recover specialists",
      provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    const [failed] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(failed!.status).toBe("failed");
    const retry = await fetch(`http://127.0.0.1:${address.port}/runs/${run!.id}/retry`, { method: "POST" });
    expect(retry.status).toBe(201);
    expect((await retry.json()).data.id).toBe(run!.id);
    limited = false;
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 30001);
    try { await stepSupervisor(d, run!.id); } finally { clock.mockRestore(); }
    await stepSupervisor(d, run!.id);
    expect(calls.filter(c => c === "Successful sibling")).toHaveLength(1);
    expect(calls.filter(c => c === "Interrupted specialist")).toHaveLength(2);
    expect(calls.filter(c => c === "plan")).toHaveLength(1);
    const [result] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(result!.status).toBe("needs_review");
  } finally {
    server.close();
    for (const table of [artifactRevisions, artifacts, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

integration("acoustic tools retain scoped, repeatable receipts through failure, retry and changed evidence", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), versionId = crypto.randomUUID();
  const model = { ...config, maxSteps: 2 };
  let text = "Traffic 60 dB(A). Plant 70 dB(A).", interrupted = false, calculations = 0, captured: any, reviewReceipts: any[] = [];
  const input = { method: "sum_sound_levels" as const, receiver: "North facade", weighting: "A" as const, period: "Day", uncorrelatedSources: true as const,
    sources: [60, 70].map((levelDb, i) => ({ label: i ? "Plant" : "Traffic", levelDb,
      provenance: { kind: "source" as const, versionId, page: 1, excerpt: i ? "Plant 70 dB(A)." : "Traffic 60 dB(A)." } })),
  };
  const d: any = { db, tenantId, actorId, supervisorEnabled: true, requirePermission: () => {}, auditRun: async () => {}, audit: async () => {},
    validateProject: async () => true, validateSourceVersion: async (_project: string, id: string) => id === versionId, providerConfigured: async () => false,
    listProjectSources: async () => ({ sources: [{ versionId, name: "Noise evidence" }], truncated: false }),
    resolveSource: async () => ({ status: "resolved", source: { versionId, name: "Noise evidence", version: 1 }, content: { status: "available", text } }),
    calculateAcoustics: (value: any) => { calculations++; return calculateAcoustics(value); },
    executeSupervisor: async (request: any) => {
      if (request.phase === "plan") return { status: "completed", output: { tasks: [
        { role: "sound_insulation", goal: "Combine stated simultaneous noise contributions", sourceVersionIds: [versionId] },
        { role: "source_reviewer", goal: "Check gaps", sourceVersionIds: [] },
      ] } };
      if (request.phase === "review") {
        expect(request.calculateAcoustics).toBeUndefined();
        reviewReceipts = request.context.assignments.find((a: any) => a.role === "sound_insulation").calculationReceipts;
        return { status: "completed", output: { summary: "Unreviewed arithmetic available", rationale: "Review required", decision: "accept", revisions: [], citations: [versionId],
          document: { title: "Noise review", content: "Rendered from template", template: acousticConceptFixture("exterior-noise-concept", "en", versionId) } } };
      }
      if (request.context.role !== "sound_insulation") {
        expect(request.calculateAcoustics).toBeUndefined();
        return { status: "completed", output: { summary: "No additional evidence", rationale: "", citations: [] } };
      }
      captured = request.calculateAcoustics;
      expect(captured).toBeFunction();
      await expect(captured({ ...input, sources: [{ ...input.sources[0], provenance: { ...input.sources[0]!.provenance, versionId: crypto.randomUUID() } }] })).rejects.toThrow("outside the current readable batch");
      await expect(captured({ ...input, sources: [{ ...input.sources[0], provenance: { ...input.sources[0]!.provenance, excerpt: "Fabricated quotation" } }] })).rejects.toThrow("absent from the current source text");
      await expect(captured(input, AbortSignal.abort())).rejects.toThrow();
      const [first, duplicate] = await Promise.all([captured(input), captured(input)]);
      expect(first.receiptId).toBe(duplicate.receiptId);
      expect(first.value).toBeCloseTo(70.41392685158225, 10);
      const scenario = await captured({ ...input, sources: [input.sources[0], { label: "Sensitivity case", levelDb: 80, provenance: { kind: "assumption", reason: "User scenario: plant ten dB louder" } }] });
      expect(scenario.receiptId).not.toBe(first.receiptId);
      expect(scenario.value).toBeCloseTo(80.04321373782642, 10);
      const facade = exteriorNoiseFixture();
      // Nested geometry, noise, applicability, flanking and rating provenance all retain scope checks.
      for (const record of [facade.room, facade.applicability, facade.facades[0]!, facade.facades[0]!.noise, facade.flanking, facade.elements[0]!]) {
        const original = record.provenance;
        record.provenance = { kind: "source", versionId: crypto.randomUUID(), page: 1, excerpt: "Traffic 60 dB(A)." };
        await expect(captured(facade)).rejects.toThrow("outside the current readable batch");
        record.provenance = { kind: "source", versionId, page: 1, excerpt: "Invented facade geometry" };
        await expect(captured(facade)).rejects.toThrow("absent from the current source text");
        record.provenance = original;
      }
      expect(await captured(facade)).toMatchObject({ status: "calculated", value: expect.closeTo(44.66896537322387, 10) });
      expect(await captured({ ...facade, elementsComplete: false })).toMatchObject({ status: "unsupported", value: null });
      if (!interrupted) { interrupted = true; throw Object.assign(new Error("Interrupted after calculation"), { code: "timeout", providerFailure: true, retryable: false }); }
      // Tool input citations must survive even if the model omits them.
      return { status: "completed", output: { summary: "70.414 dB(A), inputs and applicability not reviewed", rationale: "Saved arithmetic, not a compliance decision", citations: [] } };
    },
  };
  const server = express().use(express.json()).use(runsRouter(() => d)).listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Check noise arithmetic", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", { ...policy, specialists: { ...policy.specialists, sound_insulation: model } });
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    expect(calculations).toBe(4);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)))[0]!.status).toBe("failed");
    const initialSteps = await db.select().from(agentRunSteps).where(and(eq(agentRunSteps.tenantId, tenantId), eq(agentRunSteps.kind, "tool")));
    expect(initialSteps).toHaveLength(4);
    const step = initialSteps[0]!;
    const detail = await fetch(`${base}/runs/${step.runId}/steps/${step.id}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.output).toMatchObject({ engine: "richtfest-acoustics", version: 1, reviewStatus: "not_reviewed" });
    expect((await fetch(`${base}/runs/${run!.id}/retry`, { method: "POST" })).status).toBe(201);
    await stepSupervisor(d, run!.id);
    expect(calculations).toBe(4);
    const [completed] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    const receipts = (completed!.assignments as any[]).find(a => a.role === "sound_insulation").calculationReceipts;
    expect(receipts).toHaveLength(4);
    expect(receipts.find((r: any) => r.status === "unsupported")).toMatchObject({ method: "exterior_noise_facade", value: null });
    expect(receipts.find((r: any) => r.method === "exterior_noise_facade" && r.status === "calculated").exteriorNoise.marginDb).toBeCloseTo(0.019312208551912345, 10);
    expect((completed!.assignments as any[]).find(a => a.role === "sound_insulation").output.citations).toEqual([versionId]);
    expect(receipts.map((r: any) => r.receiptId).sort()).toEqual(initialSteps.map(s => s.id).sort());
    await stepSupervisor(d, run!.id);
    expect(reviewReceipts).toEqual(receipts);
    // Re-reading changed evidence invalidates the assignment's active receipts,
    // but retains its historical execution records for inspection.
    text += "\nAdditional extraction context.";
    await db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, run!.id));
    await db.update(supervisorRuns).set({ phase: "specialists", assignments: (completed!.assignments as any[]).map(a => a.role === "sound_insulation" ? { ...a, output: undefined } : a) }).where(eq(supervisorRuns.runId, run!.id));
    await stepSupervisor(d, run!.id);
    expect(calculations).toBe(8);
    const [updated] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    const changedReceipts = (updated!.assignments as any[]).find(a => a.role === "sound_insulation").calculationReceipts;
    expect(changedReceipts).toHaveLength(4);
    expect(changedReceipts.every((r: any) => !initialSteps.some(s => s.id === r.receiptId))).toBe(true);
    await db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, run!.id));
    await expect(captured(input)).rejects.toThrow("no longer active");
    expect(calculations).toBe(8);
    expect(await db.select().from(agentRunSteps).where(and(eq(agentRunSteps.tenantId, tenantId), eq(agentRunSteps.kind, "tool")))).toHaveLength(8);
  } finally {
    server.close();
    for (const table of [artifactRevisions, artifacts, agentRunSteps, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

for (const overflow of ["none", "summary", "rationale"] as const)
integration(`specialist finalization honors snapshotted output limits: ${overflow}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const versions = [crypto.randomUUID(), crypto.randomUUID()];
  const executionLimits = { summaryMaxCharacters: 30000, rationaleMaxCharacters: 4000,
    documentMaxCharacters: 60000, timeoutSeconds: 180 };
  const findings = { summary: "S".repeat(executionLimits.summaryMaxCharacters),
    rationale: "R".repeat(executionLimits.rationaleMaxCharacters) };
  const batches: number[] = [];
  const d: any = { db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async () => true,
    listProjectSources: async () => ({ sources: versions.map(versionId => ({ versionId })), truncated: false }),
    resolveSource: async (_: string, { versionId }: any) => ({ status: "resolved", source: { versionId },
      content: { status: "available", text: "Evidence ".repeat(4000) } }),
    executeSupervisor: async ({ phase, context }: any) => {
      if (phase === "plan") return { status: "completed", output: { tasks: [
        { role: "source_reviewer", goal: "Read every source", sourceVersionIds: versions },
      ] } };
      if (phase === "review") {
        expect(context.assignments[0].output).toEqual({ ...findings, citations: versions });
        return { status: "completed", output: { summary: "Review required", rationale: "Draft only",
          citations: versions, decision: "accept", revisions: [] } };
      }
      const batch = context.sourceCoverage.batch;
      batches.push(batch);
      expect(context.sourceCoverage.batchCount).toBe(2);
      if (batch === 2) expect(context.previousFindings).toEqual({ ...findings, citations: [versions[0]] });
      return { status: "completed", output: { ...findings,
        ...(batch === 2 && overflow !== "none" ? { [overflow]: findings[overflow] + "!" } : {}),
        citations: context.sourceVersionIds,
      } };
    },
  };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(),
      goal: "Configured specialist limits", provider: "openai", requestedBy: actorId,
      correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", { ...policy, executionLimits });
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    const assignment = (state!.assignments as any[])[0];
    if (overflow === "none") {
      expect(batches).toEqual([1, 2]);
      expect(state!.phase).toBe("review");
      expect(assignment.output).toEqual({ ...findings, citations: versions });
      expect(assignment.sourceProgress).toBeUndefined();
      const [child] = await db.select().from(agentRuns).where(eq(agentRuns.id, assignment.runId));
      expect(child!.status).toBe("needs_review");
      expect(child!.outputSummary).toBe(findings.summary);
      expect(child!.rationale).toBe(findings.rationale);
      await stepSupervisor(d, run!.id);
      const [reviewed] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
      expect(reviewed!.status).toBe("needs_review");
    } else {
      expect(batches).toEqual([1, 2, 2, 2]);
      const [failed] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
      expect(failed!.status).toBe("failed");
      expect(assignment.output).toBeUndefined();
      expect(assignment.sourceProgress.completedBatches).toBe(1);
      expect(assignment.sourceProgress.output).toEqual({ ...findings, citations: [versions[0]] });
      const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, assignment.runId));
      const failures = attempts.filter(attempt => attempt.status === "failed");
      expect(failures).toHaveLength(3);
      expect(failures.every(attempt => attempt.failureCategory === "validation")).toBe(true);
    }
  } finally {
    for (const table of [artifactRevisions, artifacts, agentRunSteps, agentRunUsage, agentRunAttempts,
      agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

for (const batching of ["unknown-model", "model-aware", "saved-legacy"] as const) integration(`large specialist assignments preserve every UTF-8 source slice and resume checkpointed findings: ${batching}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const model = { ...config, modelId: batching === "unknown-model" ? "test-model" : "gpt-6-luna" };
  const selectedPolicy = { ...policy, specialists: { source_reviewer: model, requirements_reviewer: model } };
  // Oversized multi-byte text, a nearly full batch, several tiny files and an
  // unreadable file exercise byte and file-count boundaries independently.
  const evidence = [batching === "model-aware"
    ? Array.from({ length: 5 }, (_, i) => `[Page ${i + 1}]\n${"A".repeat(250000)}🧱ß\n`).join("")
    : "A".repeat(49151) + "🧱ß", "ä🧱\n".repeat(9000),
    "First requirement", "Second requirement", "Third requirement", "Fourth requirement",
    "Fifth requirement", "Last requirement", null].map((text, index) => ({
      versionId: crypto.randomUUID(), name: `Source ${index + 1}`, text,
    }));
  let runId = "", interrupted = false;
  const accepted: any[] = [];
  const d = {
    db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async () => true,
    listProjectSources: async () => ({ sources: evidence, truncated: false }),
    resolveSource: async (_project: string, input: { versionId: string }) => {
      const source = evidence.find(item => item.versionId === input.versionId)!;
      return { status: "resolved", source, content: source.text === null
        ? { status: "unsupported", reason: "Export required" }
        : { status: "available", text: source.text, truncated: source.versionId === evidence[1]!.versionId } };
    },
    executeSupervisor: async (input: any) => {
      if (input.phase === "plan") return { status: "completed", output: { tasks: [
        { role: "requirements_reviewer", goal: "Read every source", sourceVersionIds: evidence.map(source => source.versionId) },
      ] } };
      expect(input.modelPolicy.specialists.requirements_reviewer.maxOutputTokens).toBe(1024);
      const context = input.context;
      const liveEvents = await db.select().from(agentRunEvents).where(and(
        eq(agentRunEvents.runId, input.runId), eq(agentRunEvents.eventType, "work_progress"),
      )).orderBy(agentRunEvents.createdAt);
      const liveProgress = JSON.parse(liveEvents.at(-1)!.paramsSummary!);
      expect(liveProgress).toMatchObject({
        runId: input.runId, stage: "reading_sources",
        batch: context.sourceCoverage.batch, batchCount: context.sourceCoverage.batchCount,
        sources: context.sourceVersionIds.map((versionId: string) => ({
          versionId, name: evidence.find(source => source.versionId === versionId)!.name,
        })),
      });
      expect(liveProgress.summary).toBe(context.previousFindings?.summary);
      expect(JSON.stringify(liveProgress)).not.toContain("textRange");
      expect(JSON.stringify(liveProgress)).not.toContain("AAAA");
      if (context.sourceCoverage.batch === 2 && !interrupted) {
        interrupted = true;
        // Simulate a worker losing its lease after one saved batch. Its late
        // response must not be checkpointed, and the next worker must resume.
        await db.update(supervisorRuns).set({ leaseToken: null, leaseUntil: null }).where(eq(supervisorRuns.runId, runId));
        return { status: "completed", output: { summary: "Discard this late response", rationale: "", citations: [] } };
      }
      accepted.push(context);
      return { status: "completed", output: {
        summary: `Accumulated through batch ${context.sourceCoverage.batch}`,
        rationale: "Source 9 is unreadable; export required.",
        // Deliberately omit earlier citations: the checkpoint must retain them.
        citations: context.sourceVersionIds,
      } };
    },
  } as unknown as AppDeps;
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Batched evidence", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    runId = run!.id;
    await createSupervisor(d, db, run, "medium", selectedPolicy);
    await stepSupervisor(d, runId);
    if (batching === "saved-legacy") {
      const [planned] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
      await db.update(supervisorRuns).set({ assignments: (planned!.assignments as any[]).map(({ sourceInputByteBudget, sourceBatchingVersion, ...assignment }) => assignment) }).where(eq(supervisorRuns.runId, runId));
    }
    await stepSupervisor(d, runId);
    const [checkpoint] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
    expect(checkpoint!.phase).toBe("specialists");
    expect((checkpoint!.assignments as any[])[0].sourceProgress.completedBatches).toBe(1);
    await stepSupervisor(d, runId);
    const [completed] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
    expect(completed!.phase).toBe("review");
    if (batching === "model-aware") {
      expect(accepted).toHaveLength(3);
      expect(accepted.some(context => context.sources.length > 3)).toBe(true);
    } else if (batching === "saved-legacy") expect(accepted.length).toBeGreaterThan(3);
    else expect(accepted.some(context => context.sources.length > 3)).toBe(true);
    expect(accepted.map(item => item.sourceCoverage.batch)).toEqual(accepted.map((_, index) => index + 1));
    for (const [index, context] of accepted.entries()) {
      if (batching === "model-aware") expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(838976);
      else {
        if (batching === "saved-legacy") expect(context.sources.length).toBeLessThanOrEqual(3);
        expect(context.sources.reduce((sum: number, source: any) => sum + Buffer.byteLength(source.text), 0)).toBeLessThanOrEqual(49152);
      }
      expect(context.unreadableSources).toEqual([{ name: "Source 9", reason: "Export required" }]);
      expect(context.sourceVersionIds).not.toContain(evidence[8]!.versionId);
      if (index) expect(context.previousFindings.summary).toBe(`Accumulated through batch ${index}`);
      else expect(context.previousFindings).toBeUndefined();
    }
    for (const source of evidence.filter(item => item.text !== null)) {
      const slices = accepted.flatMap(context => context.sources).filter(item => item.versionId === source.versionId);
      expect(slices.map(item => item.text).join("")).toBe(source.text!);
      let offset = 0;
      for (const slice of slices) {
        expect(slice.textRange).toEqual({ startByte: offset, endByte: offset + Buffer.byteLength(slice.text), totalBytes: Buffer.byteLength(source.text!) });
        expect(slice.extractionTruncated).toBe(source.versionId === evidence[1]!.versionId);
        offset = slice.textRange.endByte;
        if (slices.length > 1) expect(slice.truncated).toBe(true);
      }
    }
    const assignment = (completed!.assignments as any[])[0];
    expect(assignment.output.summary).toBe(`Accumulated through batch ${accepted.length}`);
    expect(assignment.output.citations).toEqual(evidence.slice(0, 8).map(source => source.versionId));
    expect(assignment.sourceProgress).toBeUndefined();
    expect(JSON.stringify(completed)).not.toContain("Discard this late response");
    const workEvents = await db.select().from(agentRunEvents).where(and(
      eq(agentRunEvents.tenantId, tenantId), eq(agentRunEvents.eventType, "work_progress"),
    )).orderBy(agentRunEvents.createdAt);
    const parentProgress = workEvents.filter(event => event.runId === runId).map(event => JSON.parse(event.paramsSummary!));
    const childProgress = workEvents.filter(event => event.runId === assignment.runId).map(event => JSON.parse(event.paramsSummary!));
    expect(parentProgress.filter(event => event.runId === assignment.runId)).toEqual(childProgress);
    expect(parentProgress.at(-1).stage).toBe("reviewing_findings");
    expect(childProgress.at(-1)).toMatchObject({ stage: "source_findings", summary: `Accumulated through batch ${accepted.length}` });
    expect(JSON.stringify(workEvents)).not.toContain("Discard this late response");
    // A new extraction of the immutable file cannot inherit an older text
    // checkpoint, even when the version IDs are unchanged.
    evidence[0]!.text += "\nNewly recovered OCR line.";
    await db.update(supervisorRuns).set({ phase: "specialists", assignments: checkpoint!.assignments }).where(eq(supervisorRuns.runId, runId));
    const beforeChangedExtraction = accepted.length;
    await stepSupervisor(d, runId);
    expect(accepted[beforeChangedExtraction].sourceCoverage.batch).toBe(1);
    expect(accepted[beforeChangedExtraction].previousFindings).toBeUndefined();
    expect(accepted.slice(beforeChangedExtraction).flatMap(context => context.sources)
      .filter(source => source.versionId === evidence[0]!.versionId).map(source => source.text).join("")).toBe(evidence[0]!.text!);
    // Being assigned a version is not permission to cite it before its batch
    // was read. The last readable source is absent from the first batch.
    const invalidDeps: AppDeps = { ...d, executeSupervisor: async input => input.phase === "plan"
      ? d.executeSupervisor!(input)
      : { status: "completed", output: { summary: "Unsupported future citation", rationale: "", citations: [evidence[7]!.versionId] } } };
    const [invalid] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Reject unread evidence", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(invalidDeps, db, invalid, "medium", selectedPolicy);
    await stepSupervisor(invalidDeps, invalid!.id);
    if (batching === "saved-legacy") {
      const [planned] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, invalid!.id));
      await db.update(supervisorRuns).set({ assignments: (planned!.assignments as any[]).map(({ sourceInputByteBudget, sourceBatchingVersion, ...assignment }) => assignment) }).where(eq(supervisorRuns.runId, invalid!.id));
    }
    await stepSupervisor(invalidDeps, invalid!.id);
    const [rejected] = await db.select().from(agentRuns).where(eq(agentRuns.id, invalid!.id));
    expect(rejected!.status).toBe("failed");
    const [rejectedState] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, invalid!.id));
    expect((rejectedState!.assignments as any[])[0].sourceProgress).toBeUndefined();
    expect((rejectedState!.assignments as any[])[0].output).toBeUndefined();
  } finally {
    for (const table of [agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});
for (const outcome of ["recover", "exhaust"] as const) integration(`invalid specialist citations recover without losing saved batches and retain failure evidence: ${outcome}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const evidence = Array.from({ length: 5 }, (_, index) => ({ versionId: crypto.randomUUID(), name: `Source ${index + 1}` }));
  let firstBatchCalls = 0, secondBatchCalls = 0;
  const d: any = { db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, validateSourceVersion: async () => true,
    listProjectSources: async () => ({ sources: evidence, truncated: false }),
    resolveSource: async (_project: string, input: { versionId: string }) => ({ status: "resolved",
      source: evidence.find(source => source.versionId === input.versionId),
      content: input.versionId === evidence[4]!.versionId ? { status: "unsupported", reason: "Unreadable" }
        : { status: "available", text: "Source evidence " + "x".repeat(14000), truncated: false },
    }),
    executeSupervisor: async (input: any) => {
      if (input.phase === "plan") return { status: "completed", output: { tasks: [
        { role: "requirements_reviewer", goal: "Inspect every source", sourceVersionIds: evidence.map(source => source.versionId) },
      ] } };
      const context = input.context;
      await input.onPrepared({ version: 1, instructions: "Read only supplied evidence", prompt: JSON.stringify(context) });
      await input.onResponse({ modelId: "test-model", responseId: null, finishReason: "stop" });
      if (context.sourceCoverage.batch === 1) {
        firstBatchCalls++;
        return { status: "completed", output: { summary: "Saved first batch", rationale: "", citations: context.sourceVersionIds } };
      }
      secondBatchCalls++;
      expect(context.previousFindings.summary).toBe("Saved first batch");
      if (secondBatchCalls > 1) expect(context.outputValidationFeedback).toMatchObject({
        errorId: "SOURCE_CITATION_OUT_OF_SCOPE", rejectedCitations: [evidence[4]!.versionId],
      });
      if (outcome === "exhaust" || secondBatchCalls === 1) return { status: "completed", output: {
        summary: "REJECTED_OUTPUT_MUST_NOT_BE_RETAINED", rationale: "", citations: [evidence[4]!.versionId],
      } };
      return { status: "completed", output: { summary: "All readable evidence reviewed", rationale: "Source 5 remains unreadable",
        citations: [...context.previousFindings.citations, ...context.sourceVersionIds] } };
    },
  };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Citation recovery",
      provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
    const assignment = (state!.assignments as any[])[0];
    expect(firstBatchCalls).toBe(1);
    expect(secondBatchCalls).toBe(outcome === "recover" ? 2 : 3);
    if (outcome === "recover") {
      expect(state!.phase).toBe("review");
      expect(assignment.output.citations).toEqual(evidence.slice(0, 4).map(source => source.versionId));
      expect(assignment.output.summary).toBe("All readable evidence reviewed");
    } else {
      const [failed] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
      expect(failed!.status).toBe("failed");
      expect(assignment.sourceProgress.completedBatches).toBe(1);
      expect(assignment.sourceProgress.output.summary).toBe("Saved first batch");
      expect(assignment.output).toBeUndefined();
    }
    const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, assignment.runId));
    const failures = steps.filter(step => step.status === "failed");
    expect(failures).toHaveLength(outcome === "recover" ? 1 : 3);
    for (const step of failures) expect(step.output).toMatchObject({ failure: { category: "validation", diagnostics: {
      errorId: "SOURCE_CITATION_OUT_OF_SCOPE", finishReason: "stop", rejectedCitations: [evidence[4]!.versionId],
      issues: [{ code: "custom", path: ["citations", 0] }],
    } } });
    const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, assignment.runId));
    expect(attempts.filter(attempt => attempt.status === "failed").every(attempt => attempt.failureCategory === "validation")).toBe(true);
    expect(JSON.stringify({ steps, state })).not.toContain("REJECTED_OUTPUT_MUST_NOT_BE_RETAINED");
  } finally {
    for (const table of [agentRunSteps, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});
for (const outcome of ["complete", "failure", "cancel"] as const) integration(`specialist slots refill immediately and settle safely: ${outcome}`, async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const gates = new Map<string, { resolve: () => void; reject: () => void }>();
  const calls: string[] = [];
  let active = 0, peak = 0, releaseAll = false;
  let pending: Promise<void> | undefined;
  const waitFor = async (condition: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 300; i++) {
      if (await condition()) return;
      await Bun.sleep(10);
    }
    throw new Error("Expected specialist progress was not reached");
  };
  const d: any = { db, tenantId, actorId, supervisorEnabled: true, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, providerConfigured: async () => false,
    listProjectSources: async () => ({ sources: [], truncated: false }),
    executeSupervisor: async ({ phase, goal }: any) => {
      if (phase === "plan") return { status: "completed", output: { tasks: ["Slow", "Fast", "Next", "Last"].map(goal => ({ role: "source_reviewer", goal, sourceVersionIds: [] })) } };
      calls.push(goal);
      active++;
      peak = Math.max(peak, active);
      try {
        if (!releaseAll) await new Promise<void>((resolve, reject) => gates.set(goal, { resolve,
          reject: () => reject(Object.assign(new Error("Deadline exceeded"), { code: "timeout", providerFailure: true, retryable: false })),
        }));
        return { status: "completed", output: { summary: `Saved ${goal}`, rationale: "", citations: [] } };
      } finally { active--; }
    },
  };
  const server = express().use(express.json()).use(runsRouter(() => d)).listen(0);
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Refill specialist slots", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    const id = run!.id;
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, id);
    pending = stepSupervisor(d, id);
    await waitFor(() => gates.size === 2);
    gates.get("Fast")!.resolve();
    // The third assignment must begin while the first is still blocked.
    await waitFor(() => gates.has("Next"));
    expect(calls.slice(0, 2).sort()).toEqual(["Fast", "Slow"]);
    expect(calls.slice(2)).toEqual(["Next"]);
    expect(active).toBe(2);
    if (outcome === "failure") {
      gates.get("Next")!.reject();
      await waitFor(async () => (await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, id))).some(event => event.eventType === "provider_call_failed"));
      await Bun.sleep(20);
      const [draining] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
      expect(draining!.status).toBe("running");
      const [lease] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, id));
      expect(lease!.leaseToken).not.toBeNull();
    } else if (outcome === "cancel") {
      await db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, id));
    }
    releaseAll = true;
    for (const gate of gates.values()) gate.resolve();
    await pending;
    expect(active).toBe(0);
    expect(peak).toBe(2);
    if (outcome !== "complete") {
      expect(calls).not.toContain("Last");
      const [stopped] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
      expect(stopped!.status).toBe(outcome === "failure" ? "failed" : "cancelled");
      if (outcome === "failure") expect(stopped!.error).toContain("category=timeout");
      const beforeRetry = calls.length;
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${id}/retry`, { method: "POST" });
      expect(response.status).toBe(201);
      await stepSupervisor(d, id);
      expect(calls.slice(beforeRetry)).not.toContain("Fast");
      if (outcome === "failure") expect(calls.slice(beforeRetry).sort()).toEqual(["Last", "Next"]);
      else expect(calls.slice(beforeRetry).sort()).toEqual(["Last", "Next", "Slow"]);
    }
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, id));
    expect(state!.phase).toBe("review");
    expect((state!.assignments as any[]).map(a => a.output.summary)).toEqual(["Saved Slow", "Saved Fast", "Saved Next", "Saved Last"]);
  } finally {
    releaseAll = true;
    for (const gate of gates.values()) gate.resolve();
    await pending;
    server.close();
    for (const table of [agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
}, 10000);

integration("specialist timeouts stop unchanged retries and preserve completed siblings", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const d = {
    db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true, listProjectSources: async () => ({ sources: [], truncated: false }),
    executeSupervisor: async (input: any) => {
      await input.onPrepared?.({ version: 1, instructions: "", prompt: input.goal });
      if (input.phase === "plan") return { status: "completed", output: { tasks: [
        { role: "source_reviewer", goal: "Completes", sourceVersionIds: [] },
        { role: "requirements_reviewer", goal: "Times out", sourceVersionIds: [] },
      ] } };
      if (input.goal === "Completes") return { status: "completed", output: { summary: "Saved evidence", rationale: "", citations: [] } };
      // Even a retryable wrapper must not restart a deadline-limited request.
      throw Object.assign(new Error("sk-secret timeout body"), { code: "timeout", providerFailure: true, retryable: true });
    },
  } as unknown as AppDeps;
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Timeout regression", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", { ...policy, maxParallel: 1 });
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    const [parent] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(parent!.status).toBe("failed");
    expect(parent!.error).toContain("phase=specialist; category=timeout;");
    expect(parent!.error).toContain("Retry run reuses available saved progress");
    const children = await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, run!.id));
    expect(children.find(child => child.goal === "Completes")).toMatchObject({ status: "needs_review", outputSummary: "Saved evidence" });
    const failed = children.find(child => child.goal === "Times out")!;
    expect(failed.error).toContain("category=timeout");
    const attempts = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, failed.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: "failed", failureCategory: "timeout", usageStatus: "missing" });
    const events = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, run!.id));
    expect(events.some(event => event.eventType === "provider_call_retrying")).toBe(false);
    expect(JSON.stringify([parent, children, attempts, events])).not.toContain("sk-secret");
  } finally {
    for (const table of [agentRunSteps, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});
integration("specialist costs belong to each child while the supervisor retains the total", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const d = {
    db, tenantId, actorId,
    requirePermission: () => {},
    validateProject: async () => true,
    auditRun: async () => {},
    listProjectSources: async () => ({ sources: [], truncated: false, authority: "unreviewed_source_inventory" }),
    executeSupervisor: async (input) => {
      await input.onUsage?.({
        provider: "openai", modelId: "test-model",
        inputTokens: 1000, outputTokens: 100, totalTokens: 1100,
        reasoningTokens: 0, cachedInputTokens: 0,
        estimatedCostUsd: input.phase === "plan" ? 0.01 : input.goal === "Review A" ? 0.02 : 0.03,
        pricingVersion: "test",
      });
      return {
        status: "completed",
        output: input.phase === "plan"
          ? { tasks: [
              { role: "source_reviewer", goal: "Review A", sourceVersionIds: [] },
              { role: "requirements_reviewer", goal: "Review B", sourceVersionIds: [] },
            ] }
          : { summary: "Reviewed", rationale: "No sources supplied", citations: [] },
      };
    },
  } as AppDeps;
  let server: any;
  try {
    const [parent] = await db.insert(agentRuns).values({
      tenantId, projectId, requestedBy: actorId,
      goal: "Review project", provider: "openai", correlationId: crypto.randomUUID(),
    }).returning();
    await createSupervisor(d, db, parent, "medium", policy);
    await stepSupervisor(d, parent!.id);
    await stepSupervisor(d, parent!.id);
    server = express()
      .use("/api/knowledge", workspaceRouter(() => d))
      .use("/api/knowledge", runsRouter(() => d))
      .listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/knowledge`;
    const workspace = await (await fetch(`${baseUrl}/workspaces/${projectId}`)).json() as any;
    const parentUsage = workspace.data.runs.find((run: any) => run.id === parent!.id).usage;
    expect(parentUsage.own.callCount).toBe(1);
    expect(parentUsage.own.estimatedCostUsd).toBe(0.01);
    expect(parentUsage.aggregate.callCount).toBe(3);
    expect(parentUsage.aggregate.estimatedCostUsd).toBe(0.06);
    for (const [goal, cost] of [["Review A", 0.02], ["Review B", 0.03]] as const) {
      const child = workspace.data.runs.find((run: any) => run.goal === goal);
      expect(child.usage.callCount).toBe(1);
      expect(child.usage.estimatedCostUsd).toBe(cost);
      const detail = await (await fetch(`${baseUrl}/runs/${child.id}`)).json() as any;
      expect(detail.data.usage.estimatedCostUsd).toBe(cost);
      expect(detail.data.usage.calls).toHaveLength(1);
      expect(detail.data.usage.calls[0].runId).toBe(child.id);
    }
    const analytics = async (page = 0) => {
      const response = await fetch(`${baseUrl}/workspaces/${projectId}/analytics?page=${page}`);
      expect(response.status).toBe(200);
      return (await response.json() as any).data;
    };
    const initial = await analytics();
    expect(initial.runs[0].aggregate.estimatedCostUsd).toBe(0.06);
    expect(initial.runs[0].usage.estimatedCostUsd).toBe(0.01);
    expect(initial.runs[0].isSupervisor).toBe(true);
    expect(initial.runs[0].aggregate.missingUsageAttempts).toBe(0);
    expect(initial.summary.usage.totalTokens).toBe(3300);
    expect(initial.summary.averagedRunCount).toBe(0);
    expect(initial.summary.averageTokensPerRun).toBeNull();
    await db.update(agentRuns).set({ status: "needs_review" }).where(eq(agentRuns.id, parent!.id));
    expect((await analytics()).summary.averageTokensPerRun).toBe(3300);

    // An old grandchild must survive both the workspace's 50-row window and root pagination.
    const [grandchild] = await db.insert(agentRuns).values({
      tenantId, projectId, requestedBy: actorId, parentRunId: workspace.data.runs.find((run: any) => run.goal === "Review A").id,
      goal: "Nested review", status: "completed", provider: "openai", correlationId: crypto.randomUUID(), createdAt: new Date("2020-01-01"),
    }).returning();
    await db.insert(agentRunUsage).values({ tenantId, runId: grandchild!.id, provider: "openai", modelId: "nested-model",
      callIndex: 0, inputTokens: 77, outputTokens: 13, reasoningTokens: 5, cachedInputTokens: 23, estimatedCostUsd: 40000, startedAt: new Date(), completedAt: new Date() });
    const older = await db.insert(agentRuns).values(Array.from({ length: 51 }, (_, i) => ({
      tenantId, projectId, requestedBy: actorId, goal: `Older run ${i}`, provider: "openai", correlationId: crypto.randomUUID(), createdAt: new Date("2021-01-01"),
    }))).returning();
    await db.update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, older[0]!.id));
    await db.insert(agentRunUsage).values({ tenantId, runId: older[0]!.id, provider: "anthropic", modelId: "test-model",
      callIndex: 0, inputTokens: 100, outputTokens: 20, estimatedCostUsd: 10000, startedAt: new Date(), completedAt: new Date() });
    const foreignTenant = crypto.randomUUID(), foreignProject = crypto.randomUUID();
    const foreignIds = [crypto.randomUUID(), crypto.randomUUID()];
    try {
      await db.insert(agentRuns).values(foreignIds.map((id, i) => ({
        id, tenantId: i ? tenantId : foreignTenant, projectId: i ? foreignProject : projectId,
        requestedBy: actorId, parentRunId: parent!.id, goal: "Must not leak", provider: "openai", correlationId: crypto.randomUUID(),
      })));
      await db.insert(agentRunAttempts).values(foreignIds.map((runId, i) => ({
        runId, tenantId: i ? tenantId : foreignTenant, operationId: crypto.randomUUID(), phase: "specialist", attemptNumber: 1,
        provider: "openai", status: "interrupted", usageStatus: "missing", settings: { settledCostUsd: 99, modelId: "must-not-leak" },
      })));
      const first = await analytics();
      expect(first.runs).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.runs[0].members).toHaveLength(4);
      expect(first.runs[0].aggregate.estimatedCostUsd).toBe(0.10);
      expect(first.runs[0].aggregate.inputTokens).toBe(3077);
      expect(first.runs[0].aggregate.outputTokens).toBe(313);
      expect(first.runs[0].aggregate.callCount).toBe(4);
      expect(first.summary).toMatchObject({ runCount: 52, averagedRunCount: 2, averageTokensPerRun: 1755,
        unreportedRuns: 50, missingUsageAttempts: 0,
        usage: { inputTokens: 3177, outputTokens: 333, totalTokens: 3510, recordedCostUsd: 0.11, reasoningTokens: 5, cachedInputTokens: 23 } });
      expect(first.summary.models).toHaveLength(3);
      expect(first.summary.models.find((model: any) => model.provider === "anthropic")).toMatchObject({ modelId: "test-model", totalTokens: 120, recordedCostUsd: 0.01 });
      const second = await analytics(1), third = await analytics(2);
      expect(second.runs).toHaveLength(20);
      expect(third.runs).toHaveLength(12);
      expect(third.hasMore).toBe(false);
      expect(new Set([...first.runs, ...second.runs, ...third.runs].map((run: any) => run.id)).size).toBe(52);
      expect(second.summary).toEqual(first.summary);
      expect(third.summary).toEqual(first.summary);
      expect((await analytics(3)).summary).toEqual(first.summary);
      const emptyRun = second.runs.find((run: any) => run.id !== older[0]!.id);
      expect(emptyRun.aggregate.estimatedCostUsd).toBeNull();
      expect(emptyRun.aggregate.recordedCostUsd).toBeNull();

      await db.insert(agentRunAttempts).values({ tenantId, runId: grandchild!.id, operationId: crypto.randomUUID(), phase: "specialist", attemptNumber: 2, provider: "openai", status: "failed", usageStatus: "missing" });
      await db.insert(agentRunUsage).values({ tenantId, runId: grandchild!.id, provider: "openai", modelId: "unpriced-model",
        callIndex: 1, inputTokens: 11, outputTokens: 3, startedAt: new Date(), completedAt: new Date() });
      const partialData = await analytics();
      expect(partialData.summary).toMatchObject({ averagedRunCount: 1, averageTokensPerRun: 120, missingUsageAttempts: 1,
        usage: { totalTokens: 3524, recordedCostUsd: 0.11, unpricedCalls: 1 } });
      const partial = partialData.runs[0];
      expect(partial.aggregate.estimatedCostUsd).toBeNull();
      expect(partial.aggregate.recordedCostUsd).toBe(0.10);
      expect(partial.aggregate.missingUsageAttempts).toBe(1);
      expect(partial.aggregate.unpricedCalls).toBe(1);
      expect(partial.members.find((run: any) => run.id === grandchild!.id).usage.recordedCostUsd).toBe(0.04);
      // Unknown model and partially reported tokens remain visible, not zeroed or invented.
      await db.insert(agentRunUsage).values({ tenantId, runId: older[1]!.id, provider: "openai", modelId: null,
        callIndex: 0, inputTokens: 7, outputTokens: null, startedAt: new Date(), completedAt: new Date() });
      const unknown = (await analytics()).summary;
      expect(unknown.usage.totalTokens).toBe(3531);
      expect(unknown.usage.incompleteTokenCalls).toBe(1);
      expect(unknown.models.find((model: any) => model.modelId === null)).toMatchObject({ inputTokens: 7, outputTokens: null, totalTokens: 7, recordedCostUsd: null });
      await db.update(agentRunUsage).set({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }).where(eq(agentRunUsage.runId, older[0]!.id));
      const zero = (await analytics()).summary;
      expect(zero).toMatchObject({ averagedRunCount: 1, averageTokensPerRun: 0 });
      expect(zero.models.find((model: any) => model.provider === "anthropic")).toMatchObject({ totalTokens: 0, recordedCostUsd: 0 });
      // A step receipt is a known subtotal, not a complete call or a reservation.
      const [settled] = await db.insert(agentRunAttempts).values({ tenantId, runId: grandchild!.id,
        operationId: crypto.randomUUID(), phase: "specialist", attemptNumber: 3, provider: "openai",
        status: "interrupted", usageStatus: "missing", settings: { modelId: "partial-model", settledCostUsd: 2.405285,
          reservedCostUsd: 90, stepReceipts: [{ status: "settled" }, { status: "unknown" }] } }).returning();
      const known = await analytics();
      expect(known.summary.usage.recordedCostUsd).toBeCloseTo(2.505285, 6);
      expect(known.summary.usage.callCount).toBe(zero.usage.callCount);
      expect(known.summary.usage.totalTokens).toBe(zero.usage.totalTokens);
      expect(known.summary.missingUsageAttempts).toBe(zero.missingUsageAttempts + 1);
      expect(known.summary.models.find((m: any) => m.modelId === "partial-model")).toMatchObject({
        recordedCostUsd: 2.405285, partialCost: true, callCount: 0, totalTokens: null, unpricedCalls: 0, incompleteTokenCalls: 0,
      });
      expect(known.runs[0].aggregate).toMatchObject({ recordedCostUsd: 2.505285, estimatedCostUsd: null, inputTokens: null });
      expect(known.runs[0].members.find((m: any) => m.id === grandchild!.id).usage.recordedCostUsd).toBeCloseTo(2.445285, 6);
      expect((await analytics(2)).summary).toEqual(known.summary);
      const detail = (await (await fetch(`${baseUrl}/runs/${grandchild!.id}`)).json() as any).data;
      expect(detail.usage).toMatchObject({ recordedCostUsd: 2.445285, estimatedCostUsd: null, inputTokens: null, callCount: 2 });
      const workspaceKnown = (await (await fetch(`${baseUrl}/workspaces/${projectId}`)).json() as any).data;
      // The workspace window may omit old records, but visible rows share the same accounting contract.
      expect(workspaceKnown.runs.find((r: any) => r.id === parent!.id).usage.aggregate.recordedCostUsd).toBe(0.06);
      await db.insert(agentRunUsage).values({ tenantId, runId: grandchild!.id, attemptId: settled!.id,
        provider: "openai", modelId: "partial-model", callIndex: 2, estimatedCostUsd: 3000000,
        inputTokens: 1, outputTokens: 1, startedAt: new Date(), completedAt: new Date() });
      const replaced = await analytics();
      expect(replaced.summary.usage.recordedCostUsd).toBeCloseTo(3.10, 6);
      expect(replaced.summary.models.find((m: any) => m.modelId === "partial-model")).toMatchObject({ recordedCostUsd: 3, partialCost: false, callCount: 1 });
      expect(replaced.runs[0].aggregate.estimatedCostUsd).toBeNull(); // other unknown attempts remain unknown
      await db.update(agentRunUsage).set({ estimatedCostUsd: 0 }).where(eq(agentRunUsage.attemptId, settled!.id));
      expect((await analytics()).summary.usage.recordedCostUsd).toBeCloseTo(0.10, 6);
      await db.insert(agentRunAttempts).values({ tenantId, runId: older[2]!.id, operationId: crypto.randomUUID(),
        phase: "specialist", attemptNumber: 1, provider: "openai", status: "interrupted", usageStatus: "missing",
        settings: { modelId: "settled-zero", settledCostUsd: 0, reservedCostUsd: 99 } });
      const settledOnly = await analytics();
      expect(settledOnly.summary.models.find((m: any) => m.modelId === "settled-zero")).toMatchObject({
        recordedCostUsd: 0, partialCost: true, totalTokens: null, callCount: 0, incompleteTokenCalls: 0,
      });
      const pages = [settledOnly, await analytics(1), await analytics(2)];
      expect(pages.flatMap(p => p.runs).find((r: any) => r.id === older[2]!.id).usage).toMatchObject({
        recordedCostUsd: 0, estimatedCostUsd: null, callCount: 0, inputTokens: null,
      });
      const empty = await (await fetch(`${baseUrl}/workspaces/${crypto.randomUUID()}/analytics`)).json() as any;
      expect(empty.data.summary).toMatchObject({ runCount: 0, averagedRunCount: 0, averageTokensPerRun: null, models: [],
        usage: { totalTokens: null, recordedCostUsd: null, callCount: 0 } });
      expect((await fetch(`${baseUrl}/workspaces/${projectId}/analytics?page=-1`)).status).not.toBe(200);
      d.validateProject = async () => false;
      expect((await fetch(`${baseUrl}/workspaces/${projectId}/analytics`)).status).toBe(404);
      d.requirePermission = () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };
      expect((await fetch(`${baseUrl}/workspaces/${projectId}/analytics`)).status).toBe(403);
    } finally {
      for (const id of foreignIds) {
        await db.delete(agentRunAttempts).where(eq(agentRunAttempts.runId, id));
        await db.delete(agentRuns).where(eq(agentRuns.id, id));
      }
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(resolve));
    await db.delete(agentRunUsage).where(eq(agentRunUsage.tenantId, tenantId));
    await db.delete(agentRunAttempts).where(eq(agentRunAttempts.tenantId, tenantId));
    await db.delete(agentRunEvents).where(eq(agentRunEvents.tenantId, tenantId));
    await db.delete(supervisorRuns).where(eq(supervisorRuns.tenantId, tenantId));
    await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
    await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
    await pool.end();
  }
});
integration(
  "Bendenweg sound-insulation fixture reaches specialist review and a downloadable OpenUI PDF",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID(),
      inventoryVersionId = fixture.sources[0].versionId;
    const calls: { phase: string; goal: string; context: any }[] = [];
    const pdfs = new Map<string, Buffer>();
    let reviewCount = 0;
    let conversationId = "";
    let server: any;
    const d: AppDeps = {
      db,
      tenantId,
      actorId,
      supervisorEnabled: true,
      requirePermission: () => {},
      audit: async () => {},
      auditRun: async () => {},
      validateProject: async () => true,
      validateSource: async () => true,
      validateSourceVersion: async () => true,
      validateUser: async () => true,
      validateConversation: async () => true,
      cancelExecution: () => {},
      providerConfigured: async () => true,
      executeProvider: async () => ({ status: "unconfigured" }),
      sourceReferences: async (_projectId, versionIds) => fixture.sources
        .filter(source => versionIds.includes(source.versionId))
        .map(source => ({ versionId: source.versionId, fileName: source.name, version: 1 })),
      sourcePdfVersionIds: async () => [],
      pdfStorage: {
        write: async (key, bytes) => { pdfs.set(key, bytes); },
        read: async key => {
          const bytes = pdfs.get(key);
          return bytes ? { stream: Readable.from([bytes]), sizeBytes: bytes.length } : null;
        },
        remove: async key => { pdfs.delete(key); },
      },
      listProjectSources: async () => ({
        sources: [...fixture.sources],
        truncated: false,
        authority: "unreviewed_source_inventory",
      }),
      resolveSource: async (_projectId: string, input: { versionId?: string }) => {
        const source = fixture.sources.find(
          (item) => item.versionId === input.versionId,
        );
        const text = input.versionId
          ? fixture.excerpts[input.versionId as keyof typeof fixture.excerpts]
          : undefined;
        return source && text
          ? {
              status: "resolved",
              source: { versionId: source.versionId, name: source.name },
              content: { status: "available", text },
            }
          : { status: "unavailable" };
      },
      executeSupervisor: async (input) => {
        calls.push({ phase: input.phase, goal: input.goal, context: input.context });
        if (input.phase === "plan")
          return {
            status: "completed",
            output: {
              tasks: [
                {
                  role: "source_reviewer",
                  goal: "Review A",
                  sourceVersionIds: [inventoryVersionId],
                },
                {
                  role: "requirements_reviewer",
                  goal: "Review B",
                  sourceVersionIds: [],
                },
              ],
            },
          };
        if (input.phase === "specialist")
          return {
            status: "completed",
            output: {
              summary: `Evidence for ${input.goal}`,
              rationale: "Bounded evidence",
              citations: (input.context as { sourceVersionIds: string[] }).sourceVersionIds,
            },
          };
        await input.onSummaryDelta?.("Vorläufige ");
        // Streaming checkpoints are throttled; a later delta persists the accumulated text.
        await Bun.sleep(160);
        await input.onSummaryDelta?.("Planungsvorlage");
        const [checkpoint] = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, input.runId));
        expect(checkpoint!.partialOutput).toBe("Vorläufige Planungsvorlage");
        const context = input.context as any;
        expect(
          context.assignments.every((a: any) =>
            a.output.summary.startsWith("Evidence"),
          ),
        ).toBe(true);
        return {
          status: "completed",
          output: {
            decision: reviewCount++ === 0 ? "revise" : "accept",
            summary: fixture.expectedSummary,
            rationale:
              "Die Quellen wurden abgeglichen. Maße und Bauteilaufbauten sind vor Ausführung durch eine Fachplanung zu prüfen.",
            citations: [inventoryVersionId],
            revisions:
              reviewCount === 1
                ? [{ taskId: context.assignments[0].taskId, goal: "Recheck A" }]
                : [],
          },
        };
      },
    };
    let id = "";
    try {
      const [thread] = await db
        .insert(conversations)
        .values({
          tenantId,
          projectId,
          title: fixture.projectName,
          createdBy: actorId,
        })
        .returning();
      conversationId = thread!.id;
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId,
          conversationId,
          goal: fixture.prompt,
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", policy);
      await stepSupervisor(d, id); // durable plan
      const planCall = calls.find((call) => call.phase === "plan");
      expect(planCall!.goal).toBe(fixture.prompt);
      expect((planCall!.context as any).sourceInventory.sources).toEqual(
        fixture.sources,
      );
      expect(
        (planCall!.context as any).sourceInventory.sources[0].versionId,
      ).toBe(inventoryVersionId);
      // Simulate one successfully committed specialist and process death before its sibling.
      const [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      const assignments = state!.assignments as any[];
      expect(assignments[0]!.sourceVersionIds).toEqual([inventoryVersionId]);
      assignments[0].output = {
        summary: "Evidence recovered from prior process",
        rationale: "saved",
        citations: [inventoryVersionId],
      };
      await db
        .update(supervisorRuns)
        .set({
          assignments,
          leaseToken: crypto.randomUUID(),
          leaseUntil: new Date(0),
        })
        .where(eq(supervisorRuns.runId, id));
      await stepSupervisor({ ...d }, id);
      expect(calls.filter((c) => c.phase === "specialist")).toHaveLength(1);
      await stepSupervisor({ ...d }, id); // reviews and requests revision
      await stepSupervisor({ ...d }, id); // only revised task
      await stepSupervisor({ ...d }, id); // reviews actual revision
      expect(calls.filter((c) => c.phase === "specialist")).toHaveLength(2);
      const [result] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, id));
      expect(result!.status).toBe("needs_review");
      expect(result!.outputSummary).toBe(fixture.expectedSummary);
      const outputMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.runId, id));
      expect(outputMessages).toHaveLength(1);
      const [resultArtifact] = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.runId, id));
      const [resultRevision] = await db
        .select()
        .from(artifactRevisions)
        .where(eq(artifactRevisions.artifactId, resultArtifact!.id));
      expect(outputMessages[0]!.openui).toBe(
        `root = ArtifactPdf(${JSON.stringify(resultArtifact!.id)}, ${JSON.stringify(resultRevision!.id)})`,
      );
      expect(resultRevision!.sourceVersionIds).toEqual([inventoryVersionId]);
      server = express()
        .use("/api/knowledge", workspaceRouter(() => d))
        .listen(0);
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      const pdfResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/knowledge/artifacts/${resultArtifact!.id}/revisions/${resultRevision!.id}/pdf`,
      );
      expect(pdfResponse.status).toBe(200);
      expect(pdfResponse.headers.get("content-type")).toContain("application/pdf");
      expect(pdfResponse.headers.get("content-disposition")).toContain("attachment");
      const pdf = Buffer.from(await pdfResponse.arrayBuffer());
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      const extracted = Bun.spawnSync(["pdftotext", "-", "-"], { stdin: pdf });
      expect(extracted.exitCode).toBe(0);
      expect(extracted.stdout.toString()).toContain(fixture.sources[0].name);
      expect(extracted.stdout.toString()).not.toContain(inventoryVersionId);
      await stepSupervisor({ ...d }, id); // terminal is idempotent
      expect(calls.filter((c) => c.phase === "review")).toHaveLength(2);
      const [final] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      expect(final!.revision).toBe(1);
      expect(
        (final!.history as any[]).filter((h) => h.phase === "review"),
      ).toHaveLength(2);
      await stepSupervisor({ ...d, tenantId: crypto.randomUUID() }, id);
      expect(calls).toHaveLength(5);
    } finally {
      if (server) await new Promise<void>((resolve) => server.close(resolve));
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await db.delete(messages).where(eq(messages.tenantId, tenantId));
      await db
        .delete(conversations)
        .where(eq(conversations.tenantId, tenantId));
      await pool.end();
    }
  },
);
integration("failed specialist attempts persist bounded diagnostics and usage exactly once", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  let attempts = 0;
  const d: any = {
    db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
    validateProject: async () => true,
    listProjectSources: async () => ({ sources: [], truncated: false }),
    executeSupervisor: async (input: any) => {
      if (input.phase === "plan") return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Inspect", sourceVersionIds: [] }] } };
      attempts++;
      const usage = { provider: "openai", modelId: "test-model", inputTokens: 12, outputTokens: 50, totalTokens: 62, reasoningTokens: null, cachedInputTokens: null };
      await input.onUsage(usage);
      await input.onUsage(usage); // Defensive boundary deduplication, not two calls.
      throw Object.assign(new Error("sk-secret raw provider body"), {
        providerFailure: true, retryable: true, failureCategory: "validation",
        diagnostics: {
          errorId: attempts === 1 ? "STRUCTURED_OUTPUT_TRUNCATED" : "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
          finishReason: attempts === 1 ? "length" : "error",
          providerCode: "invalid_json_schema", providerType: "invalid_request_error", providerParam: "text.format.schema",
          providerRequestId: "req_diagnostic_123", providerMessage: "Invalid schema: required is missing. sk-secret",
          raw: "sk-secret", stack: "sk-secret",
          issues: [{ code: "too_big", path: ["summary"], maximum: 10000, message: "sk-secret", value: "sk-secret" }, { code: "invalid_type", path: ["sk-secret"] }],
        },
      });
    },
  };
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Diagnostic regression", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", policy);
    await stepSupervisor(d, run!.id);
    await stepSupervisor(d, run!.id);
    expect(attempts).toBe(3);
    const events = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, run!.id));
    const failed = events.filter(event => ["provider_call_retrying", "provider_call_failed"].includes(event.eventType));
    const metadata = failed.map(event => JSON.parse(event.paramsSummary!)).sort((a, b) => a.attempt - b.attempt);
    expect(metadata.map(value => value.attempt)).toEqual([1, 2, 3]);
    expect(new Set(metadata.map(value => value.callId)).size).toBe(1);
    const children = await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, run!.id));
    expect(children).toHaveLength(1);
    expect(metadata.every(value => value.runId === children[0]!.id)).toBe(true);
    expect(metadata[0].diagnostics.errorId).toBe("STRUCTURED_OUTPUT_TRUNCATED");
    expect(metadata[2].diagnostics.errorId).toBe("STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED");
    expect(metadata[2].diagnostics).toMatchObject({ providerCode: "invalid_json_schema", providerType: "invalid_request_error",
      providerParam: "text.format.schema", providerRequestId: "req_diagnostic_123",
      providerMessage: "Invalid schema: required is missing. [redacted]" });
    expect(metadata[2].diagnostics.issues).toEqual([{ code: "too_big", path: ["summary"], maximum: 10000 }]);
    expect(JSON.stringify(events)).not.toContain("sk-secret");
    const usage = await db.select().from(agentRunUsage).where(eq(agentRunUsage.runId, children[0]!.id));
    expect(usage).toHaveLength(3);
    expect(usage.reduce((sum, row) => sum + row.totalTokens!, 0)).toBe(186);
    const tracked = await db.select().from(agentRunAttempts).where(eq(agentRunAttempts.runId, children[0]!.id));
    expect(tracked).toHaveLength(3);
    for (const event of metadata) {
      const attempt = tracked.find(row => row.operationId === event.callId && row.attemptNumber === event.attempt);
      expect(attempt?.status).toBe("failed");
      expect(usage.filter(row => row.attemptId === attempt?.id)).toHaveLength(1);
    }
    // Failures before onPrepared still get a safe, inspectable ledger entry.
    const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, children[0]!.id));
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      const attempt = tracked.find(row => row.id === step.attemptId)!;
      const event = metadata.find(value => value.attempt === attempt.attemptNumber);
      expect(step.status).toBe("failed");
      expect(step.input).toEqual({});
      expect(step.output).toEqual({ failure: { category: "validation", providerStatus: null, diagnostics: event.diagnostics } });
    }
    expect(JSON.stringify(steps)).not.toContain("sk-secret");
    const attemptEvents = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, children[0]!.id));
    expect(attemptEvents.filter(event => event.eventType === "provider_attempt_failed").map(event => JSON.parse(event.paramsSummary!).diagnostics.providerRequestId))
      .toEqual(["req_diagnostic_123", "req_diagnostic_123", "req_diagnostic_123"]);
  } finally {
    await db.delete(agentRunSteps).where(eq(agentRunSteps.tenantId, tenantId));
    await db.delete(agentRunUsage).where(eq(agentRunUsage.tenantId, tenantId));
    await db.delete(agentRunAttempts).where(eq(agentRunAttempts.tenantId, tenantId));
    await db.delete(agentRunEvents).where(eq(agentRunEvents.tenantId, tenantId));
    await db.delete(supervisorRuns).where(eq(supervisorRuns.tenantId, tenantId));
    await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
    await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
    await pool.end();
  }
});
integration(
  "cancelled parent fences late provider result and prevents child writes",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID();
    let id = "";
    const d: any = {
      db,
      tenantId,
      actorId,
      requirePermission: () => {},
      validateProject: async () => true,
      listProjectSources: async () => ({
        sources: [],
        truncated: false,
        authority: "unreviewed_source_inventory",
      }),
      auditRun: async () => {},
      executeSupervisor: async () => {
        await db
          .update(agentRuns)
          .set({ status: "cancelled" })
          .where(and(eq(agentRuns.id, id), eq(agentRuns.tenantId, tenantId)));
        return {
          status: "completed",
          output: {
            tasks: [
              {
                role: "source_reviewer",
                goal: "Cancelled task",
                sourceVersionIds: [],
              },
            ],
          },
        };
      },
    };
    try {
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId: crypto.randomUUID(),
          goal: "Cancelled goal",
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", policy);
      await stepSupervisor(d, id);
      expect(
        await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, id)),
      ).toHaveLength(0);
      const [parent] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, id));
      expect(parent!.status).toBe("cancelled");
    } finally {
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
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
integration(
  "steering replacement fences old plan and preserves its model policy; provider failure stops children",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID();
    let id = "",
      mode = "steer";
    const d: any = {
      db,
      tenantId,
      actorId,
      requirePermission: () => {},
      validateProject: async () => true,
      listProjectSources: async () => ({
        sources: [],
        truncated: false,
        authority: "unreviewed_source_inventory",
      }),
      auditRun: async () => {},
      executeSupervisor: async (input: any) => {
        expect(input.modelPolicy.version).toBe(1);
        if (mode === "steer") {
          await db
            .update(supervisorRuns)
            .set({
              generation: 1,
              steering: "New human direction",
              leaseToken: null,
              leaseUntil: null,
            })
            .where(eq(supervisorRuns.runId, id));
          await db
            .update(agentRuns)
            .set({ status: "queued" })
            .where(eq(agentRuns.id, id));
          return {
            status: "completed",
            output: {
              tasks: [
                {
                  role: "source_reviewer",
                  goal: "Obsolete plan",
                  sourceVersionIds: [],
                },
              ],
            },
          };
        }
        if (input.phase === "plan")
          return {
            status: "completed",
            output: {
              tasks: [
                {
                  role: "source_reviewer",
                  goal: "Fresh plan",
                  sourceVersionIds: [],
                },
              ],
            },
          };
        throw new Error("secret-provider-error-not-for-persistence");
      },
    };
    try {
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId: crypto.randomUUID(),
          goal: "Initial direction",
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", policy);
      await stepSupervisor(d, id);
      expect(
        await db.select().from(agentRuns).where(eq(agentRuns.parentRunId, id)),
      ).toHaveLength(0);
      mode = "failure";
      // A newer admin config is available; execution must keep the saved version.
      d.resolveSupervisorPreset = async () => ({ ...policy, version: 2 });
      await stepSupervisor(d, id);
      await stepSupervisor(d, id);
      const [parent] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, id));
      expect(parent!.status).toBe("failed");
      expect(parent!.error).not.toContain("secret-provider");
      const children = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.parentRunId, id));
      expect(children).toHaveLength(1);
      expect(children[0]!.status).toBe("cancelled");
      const [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      expect((state!.modelPolicy as any).version).toBe(1);
      expect(state!.generation).toBe(1);
    } finally {
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await pool.end();
    }
  },
);
integration(
  "legacy recovery marks only abandoned legacy executions and excludes supervised children",
  async () => {
    const { repairLegacyRuns } =
      await import("../richtfest-apps/knowledge/src/run-recovery");
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID(),
      projectId = crypto.randomUUID();
    const d: any = { db, tenantId, actorId, auditRun: async () => {} };
    try {
      const base = {
        tenantId,
        projectId,
        goal: "stale",
        provider: "openai",
        requestedBy: actorId,
        correlationId: crypto.randomUUID(),
        status: "running",
        updatedAt: new Date(0),
      };
      const [parent] = await db.insert(agentRuns).values(base).returning();
      await createSupervisor(d, db, parent, "medium", policy);
      const [child] = await db
        .insert(agentRuns)
        .values({ ...base, parentRunId: parent!.id })
        .returning();
      const [legacy] = await db.insert(agentRuns).values(base).returning();
      await repairLegacyRuns(d, { projectId });
      await repairLegacyRuns(d, { projectId });
      const records = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.tenantId, tenantId));
      expect(records.find((r) => r.id === parent!.id)!.status).toBe("running");
      expect(records.find((r) => r.id === child!.id)!.status).toBe("running");
      expect(records.find((r) => r.id === legacy!.id)!.status).toBe("failed");
      expect(
        await db
          .select()
          .from(agentRunEvents)
          .where(eq(agentRunEvents.tenantId, tenantId)),
      ).toHaveLength(1);
    } finally {
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
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
integration(
  "cancellation during a specialist prevents subsequent batches and discards late output",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(),
      actorId = crypto.randomUUID();
    let id = "",
      specialistCalls = 0;
    const d: any = {
      db,
      tenantId,
      actorId,
      requirePermission: () => {},
      validateProject: async () => true,
      listProjectSources: async () => ({
        sources: [],
        truncated: false,
        authority: "unreviewed_source_inventory",
      }),
      auditRun: async () => {},
      executeSupervisor: async (input: any) => {
        if (input.phase === "plan")
          return {
            status: "completed",
            output: {
              tasks: [
                {
                  role: "source_reviewer",
                  goal: "First",
                  sourceVersionIds: [],
                },
                {
                  role: "source_reviewer",
                  goal: "Never start",
                  sourceVersionIds: [],
                },
              ],
            },
          };
        specialistCalls++;
        await db
          .update(agentRuns)
          .set({ status: "cancelled" })
          .where(eq(agentRuns.id, id));
        return {
          status: "completed",
          output: {
            summary: "Late output",
            rationale: "discard",
            citations: [],
          },
        };
      },
    };
    try {
      const [run] = await db
        .insert(agentRuns)
        .values({
          tenantId,
          projectId: crypto.randomUUID(),
          goal: "Cancel while working",
          provider: "openai",
          requestedBy: actorId,
          correlationId: crypto.randomUUID(),
        })
        .returning();
      id = run!.id;
      await createSupervisor(d, db, run, "medium", {
        ...policy,
        maxParallel: 1,
      });
      await stepSupervisor(d, id);
      await stepSupervisor(d, id);
      expect(specialistCalls).toBe(1);
      const [state] = await db
        .select()
        .from(supervisorRuns)
        .where(eq(supervisorRuns.runId, id));
      expect((state!.assignments as any[]).every((a) => !a.output)).toBe(true);
      expect(state!.phase).toBe("specialists");
    } finally {
      await db
        .delete(artifactRevisions)
        .where(eq(artifactRevisions.tenantId, tenantId));
      await db.delete(artifacts).where(eq(artifacts.tenantId, tenantId));
      await db
        .delete(agentRunEvents)
        .where(eq(agentRunEvents.tenantId, tenantId));
      await db
        .delete(supervisorRuns)
        .where(eq(supervisorRuns.tenantId, tenantId));
      await db.delete(agentRuns).where(eq(agentRuns.tenantId, tenantId));
      await db.delete(tasks).where(eq(tasks.tenantId, tenantId));
      await pool.end();
    }
  },
);
