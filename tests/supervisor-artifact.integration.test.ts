import { expect, test } from "bun:test";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { acousticConceptFixture } from "./fixtures/acoustic-concepts";
import { acousticSectionKeys } from "../richtfest-shared/src/acoustic-concept";
import { agentExecutionLimitsSchema } from "../richtfest-shared/src/agent-policy";
import { calculateAcoustics } from "../richtfest-apps/acoustics/src/calculations";
import { authorAcousticConcept } from "../richtfest-apps/knowledge/src/acoustic-authoring";
import express from "../richtfest-os/apps/api/node_modules/express";
import { workspaceRouter } from "../richtfest-apps/knowledge/src/workspace";
import { runsRouter } from "../richtfest-apps/knowledge/src/runs";
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
  annotations,
} from "../richtfest-apps/knowledge/src/schema";
const integration = process.env.DATABASE_URL ? test : test.skip;

test("concept appendices can cite saved arithmetic inputs without treating receipt IDs as sources", async () => {
  const versionId = crypto.randomUUID();
  const receipt = { ...calculateAcoustics({ method: "sum_sound_levels", receiver: "North facade", weighting: "A", period: "Day", uncorrelatedSources: true,
    sources: [60, 70].map(levelDb => ({ label: String(levelDb), levelDb,
      provenance: { kind: "source", versionId, page: 2, excerpt: "Simultaneous uncorrelated contributions: 60 and 70 dB(A)." } })),
  }), receiptId: crypto.randomUUID() };
  for (const citation of [versionId, receipt.receiptId, crypto.randomUUID()]) {
    const result = authorAcousticConcept({ d: {} as any, projectId: crypto.randomUUID(), id: "exterior-noise-concept",
      goal: "Document source-backed arithmetic", findings: [], sourceVersionIds: [versionId], calculationReceipts: [receipt],
      limits: agentExecutionLimitsSchema.parse({}), maxOutputTokens: 2048, maxParallel: 1,
      assertActive: async () => {}, checkpoint: async () => {},
      call: async context => {
        if (context.documentTask === "outline") return { id: "exterior-noise-concept", title: "Acoustic arithmetic", language: "en",
          project: { name: "Synthetic project", number: null, client: null, designer: null, author: null, date: null },
          sections: acousticSectionKeys("exterior-noise-concept").map(key => ({ key, sources: [] })), attachments: [],
        };
        if (context.section !== "calculationAppendix") return { content: "No further evidence supplied.", citations: [], complete: true };
        const [saved] = context.calculationReceipts as typeof receipt[];
        return { content: `Tool result: ${saved!.value.toFixed(3)} ${saved!.unit} [${citation}]. Inputs and applicability require review.`, citations: [citation], complete: true };
      },
    });
    if (citation !== versionId) await expect(result).rejects.toThrow("Cite only source versions");
    else {
      const report = await result;
      expect(report.document.content).toContain(`70.414 dB(A) [${versionId}]`);
      expect(report.document.content).toContain("tool calculations remain subject to specialist review");
      expect(report.citations).toEqual([versionId]);
    }
  }
});

integration("continued document review receives only its thread's comments and their exact historical revision", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const model = { modelId: "test-model", maxOutputTokens: 2048, maxSteps: 1 };
  let received: any;
  const d: any = { db, tenantId, actorId, auditRun: async () => {}, audit: async () => {}, requirePermission: () => {},
    validateProject: async () => true,
    executeSupervisor: async (input: any) => {
      received = input.context.documentReview;
      return { status: "completed", output: { summary: "Needs evidence", rationale: "Human feedback checked", decision: "accept", revisions: [], citations: [], document: { title: "Revised proposal", content: "Request the missing specification." } } };
    },
  };
  const app = express(); app.use(express.json()); app.use(workspaceRouter(() => d));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const threadIds: string[] = [], revisionIds: string[] = [];
    for (const title of ["Acoustics", "Other thread"]) {
      const [thread] = await db.insert(conversations).values({ tenantId, projectId, title, createdBy: actorId }).returning();
      threadIds.push(thread!.id);
      const [origin] = await db.insert(agentRuns).values({ tenantId, projectId, conversationId: thread!.id, goal: title, provider: "openai", status: "needs_review", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
      const [artifact] = await db.insert(artifacts).values({ tenantId, projectId, runId: origin!.id, title, type: "document", createdBy: actorId }).returning();
      const [revision] = await db.insert(artifactRevisions).values({ tenantId, artifactId: artifact!.id, version: 1, title, content: `${title}: original window specification`, createdBy: actorId }).returning();
      revisionIds.push(revision!.id);
      await db.insert(artifactRevisions).values({ tenantId, artifactId: artifact!.id, version: 2, title, content: "LATER CONTENT MUST NOT REPLACE THE ANCHOR", createdBy: actorId });
      const response = await fetch(`${url}/annotations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, artifactRevisionId: revision!.id, body: `${title}: verify this specification`, quote: "original window specification", selection: { start: title.length + 2, end: title.length + 31 } }) });
      expect(response.status).toBe(201);
    }
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId, conversationId: threadIds[0], goal: "Revise using my comments", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
    await createSupervisor(d, db, run, "medium", { provider: "openai", effort: "medium", version: 1, source: "workspace", supervisor: model, specialists: { source_reviewer: model, requirements_reviewer: model }, maxParallel: 2, maxTasks: 4, maxRevisions: 1 });
    await db.update(supervisorRuns).set({ phase: "review", assignments: [] }).where(eq(supervisorRuns.runId, run!.id));
    await stepSupervisor(d, run!.id);
    expect(received.comments).toEqual([{ revisionId: revisionIds[0], body: "Acoustics: verify this specification", quote: "original window specification" }]);
    expect(received.documents).toEqual([{ revisionId: revisionIds[0], title: "Acoustics", excerpt: "Acoustics: original window specification", truncated: false }]);
  } finally {
    server.close();
    for (const table of [annotations, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, messages, artifactRevisions, artifacts, agentRuns, conversations])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});

integration("acoustic reports preserve oversized sections and resume old character failures; incomplete reports publish no artifact", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const { PDFDocument } = await import("../richtfest-apps/knowledge/node_modules/pdf-lib");
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= 3; page++) pdf.addPage().drawText(`Original evidence page ${page}`);
  const bytes = Buffer.from(await pdf.save());
  const model = { modelId: "test-model", maxOutputTokens: 2048, maxSteps: 1 };
  try {
    for (const scenario of ["resume", "timeout", "review", "large", "legacy_limit", "legacy_piece_limit", "tokens", "characters", "placeholder", "incomplete"] as const) {
      const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID(), versionId = crypto.randomUUID();
      const keys = acousticSectionKeys("exterior-noise-concept");
      const legacyLimit = scenario === "legacy_limit" || scenario === "legacy_piece_limit";
      const large = ["large", "legacy_limit", "legacy_piece_limit", "review"].includes(scenario);
      let interrupted = false;
      let permitted = true;
      let runId = "";
      const calls: string[] = [];
      const d: any = {
        db, tenantId, actorId, supervisorEnabled: true,
        requirePermission: () => { if (!permitted) throw Object.assign(new Error("Forbidden"), { status: 403 }); }, auditRun: async () => {},
        audit: async () => {}, providerConfigured: async () => false,
        validateProject: async () => true, validateSourceVersion: async (_: string, id: string) => id === versionId,
        listProjectSources: async () => ({ sources: [{ versionId, name: "Evidence.pdf" }], truncated: false }),
        readSourcePdf: async (_: string, id: string) => id === versionId ? bytes : null,
        resolveSource: async (_: string, input: any) => {
          const page = input.pageStart ?? 1;
          return { status: "resolved", source: { versionId, name: "Evidence.pdf", version: 1, mimeType: "application/pdf" }, content: {
            status: "available", text: `[Page ${page}] ${page === 3 ? "Last room: required 33.2 dB; available 42.1 dB." : `Evidence page ${page}.\n${"Component detail.\n".repeat(400)}`}`,
            coverage: { pageStart: page, pageEnd: page, totalPages: 3, nextPage: page < 3 ? page + 1 : null },
            retrieval: { pageNumbers: [page] }, truncated: page < 3,
          } };
        },
        executeSupervisor: async ({ phase, context }: any) => {
          calls.push(context.documentTask === "section" ? context.section : context.documentTask ?? phase);
          let output: any;
          if (phase === "plan") output = { tasks: [{ role: "source_reviewer", goal: "Read report evidence", sourceVersionIds: [versionId] }] };
          else if (phase === "specialist") {
            expect(context.sources.map((s: any) => s.text).join("\n")).toContain("Last room: required 33.2 dB");
            output = { summary: "Three pages: plan page 2, calculation page 3. Last room: required 33.2 dB; available 42.1 dB.", rationale: "Unverified source results", citations: [versionId] };
          } else if (phase === "independent_review") {
            expect(context.sourceExcerpts[0].resolution.content.text).toContain("Last room: required 33.2 dB");
            expect(context.firstPassReview.document.content).toContain("Last room: required 33.2 dB");
            output = { summary: "Source claims retained, not validated", rationale: "All saved pages read", decision: "accept", citations: [versionId], revisions: [], findings: [] };
          } else if (context.documentTask === "outline") output = {
            id: "exterior-noise-concept", title: "Acoustic report", language: "en",
            project: { name: "Report test", number: null, client: null, designer: null, author: null, date: null },
            sections: keys.map(key => ({ key, sources: key === "components" ? [{ versionId, pageStart: 1, pageEnd: 3 }] : [] })),
            attachments: [{ versionId, pageStart: 2, pageEnd: 2, section: "plans", label: "Ground floor" },
              { versionId, pageStart: 3, pageEnd: 3, section: "calculationAppendix", label: "All calculation pages" }],
          };
          else if (context.documentTask === "section") {
            if (legacyLimit && context.section === "openIssues" && !interrupted) {
              interrupted = true;
              // Stop with a real saved draft above the old aggregate cap. Below,
              // seed the terminal diagnostics emitted by the previous version.
              await db.update(supervisorRuns).set({ leaseToken: null, leaseUntil: null }).where(eq(supervisorRuns.runId, runId));
              throw new Error("Worker disconnected");
            }
            if (context.section === "components" && (scenario === "resume" || scenario === "timeout") && !interrupted) {
              interrupted = true;
              if (scenario === "timeout") throw Object.assign(new Error("Call timed out"), { code: "timeout", providerFailure: true, retryable: true });
              // Simulate loss of the worker lease, not a user retry/new generation.
              await db.update(supervisorRuns).set({ leaseToken: null, leaseUntil: null }).where(eq(supervisorRuns.runId, runId));
              throw new Error("Worker disconnected");
            }
            if (context.section === "components" && scenario === "tokens") throw Object.assign(new Error("Output stopped"), {
              providerFailure: true, retryable: false, failureCategory: "validation",
              diagnostics: { errorId: "STRUCTURED_OUTPUT_TRUNCATED", finishReason: "length" },
            });
            output = { complete: scenario !== "incomplete", citations: context.sources.length ? [versionId] : [], content:
              scenario === "placeholder" ? "Nicht verwendet."
                : context.sources.length ? `${context.sources.map((s: any) => s.text).join("\n")} [${versionId}]`
                : `No further ${context.section} evidence supplied; obtain the missing project input.${large ? "\n" + "Detailed evidence gap; obtain the original project specification. ".repeat(170) : ""}`,
            };
            if (scenario === "characters" && context.sources.length)
              output.content += `\n\n${"Long evidence note. ".repeat(3000)}\n\n| Source | Final result |\n| --- | --- |\n| [${versionId}] | Unverified, retain for review |`;
          } else throw new Error("Unexpected document call");
          return { status: "completed", output };
        },
      };
      const server = express().use(express.json()).use(runsRouter(() => d))
        .use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 500).json({ error: e.message })).listen(0);
      try {
        const [run] = await db.insert(agentRuns).values({ tenantId, projectId, goal: "Create exterior-noise-concept v1", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
        runId = run!.id;
        await createSupervisor(d, db, run, "medium", { provider: "openai", effort: "medium", version: 1, source: "workspace", supervisor: model,
          specialists: { source_reviewer: model, requirements_reviewer: model }, independentReviewEnabled: scenario === "review" || scenario === "characters", maxParallel: 2, maxTasks: 4, maxRevisions: 1,
          executionLimits: { summaryMaxCharacters: 10000, rationaleMaxCharacters: 2000, documentMaxCharacters: 60000, timeoutSeconds: 180 },
        });
        for (let step = 0; step < (legacyLimit ? 3 : 5); step++) await stepSupervisor(d, runId);
        if (legacyLimit) {
          const [saved] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
          const parts = Object.values((saved!.review as any).documentDraft.sections).flatMap((s: any) => s.parts);
          expect(parts.map((p: any) => p.content).join("\n\n").length).toBeGreaterThan(60000);
          expect(parts.every((p: any) => p.content.length <= 12000)).toBe(true);
          await db.update(agentRuns).set({ status: "failed", error: "phase=review; category=validation; The run returned unsupported or invalid output. Review the inputs and retry." }).where(eq(agentRuns.id, runId));
          // Run again stays fresh regardless of saved drafts or failure diagnostics.
          for (const metadata of [
            { callId: crypto.randomUUID(), diagnostics: { errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", issues: [{ code: "too_big", path: ["content"], maximum: 60000 }] } },
            { diagnostics: { errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", issues: [{ code: "too_big", path: ["document", "template", "components"], maximum: 200000 }] } },
            { diagnostics: { errorId: "STRUCTURED_OUTPUT_TRUNCATED", finishReason: "length" } },
          ]) {
            await db.insert(agentRunEvents).values({ tenantId, runId, eventType: "provider_call_failed", resultSummary: "review", paramsSummary: JSON.stringify({ runId, ...metadata }) });
            const retry = await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${runId}/rerun`, { method: "POST" });
            expect(retry.status).toBe(201);
            expect((await retry.json()).data.id).not.toBe(runId);
            const [original] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
            expect(original!.status).toBe("failed");
          }
          await db.insert(agentRunEvents).values({ tenantId, runId, eventType: "provider_call_failed", resultSummary: "review",
            paramsSummary: JSON.stringify({ runId, diagnostics: { errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
              issues: [{ code: "too_big", path: ["content"], maximum: scenario === "legacy_piece_limit" ? 12000 : 60000 }] } }),
          });
        }
        if (scenario === "timeout" || legacyLimit) {
          const [failed] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
          expect(failed!.status).toBe("failed");
          expect(failed!.error).toContain(`phase=review; category=${scenario === "timeout" ? "timeout" : "validation"};`);
          const [saved] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
          expect(Object.keys((saved!.review as any).documentDraft.sections).length).toBeGreaterThan(0);
          permitted = false;
          expect((await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${runId}/retry`, { method: "POST" })).status).toBe(403);
          permitted = true;
          const retry = await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${runId}/retry`, { method: "POST" });
          expect(retry.status).toBe(201);
          expect((await retry.json()).data.id).toBe(runId);
          expect((await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${runId}/retry`, { method: "POST" })).status).toBe(409);
          const [resumed] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, runId));
          expect(resumed!.review).toEqual(saved!.review);
          expect(resumed!.assignments).toEqual(saved!.assignments);
          expect(resumed!.modelPolicy).toEqual(saved!.modelPolicy);
          const before = calls.length;
          await stepSupervisor(d, runId);
          expect(calls.slice(before)[0]).toBe(scenario === "timeout" ? "components" : "openIssues");
          for (const completed of ["plan", "specialist", "outline", "preliminaryRemarks"])
            expect(calls.filter(call => call === completed)).toHaveLength(1);
        }
        const [result] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
        const revisions = await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId));
        if (scenario === "resume" || scenario === "timeout" || scenario === "characters" || large) {
          expect(interrupted).toBe(["resume", "timeout", "legacy_limit", "legacy_piece_limit"].includes(scenario));
          expect(result!.status).toBe("needs_review");
          expect(revisions).toHaveLength(1);
          if (large) {
            expect(revisions[0]!.content.length).toBeGreaterThan(60000);
            expect(revisions[0]!.content.match(/Detailed evidence gap;/g)).toHaveLength((keys.length - 1) * 170);
          }
          if (scenario === "characters") {
            const components = (revisions[0]!.payload as any).template.components;
            expect(components.length).toBeGreaterThan(200000);
            expect(revisions[0]!.content).toContain(components);
            const pieces = calls.filter(call => call === "components").length;
            expect(components.match(/Long evidence note\./g)).toHaveLength(pieces * 3000);
            expect(components.match(/Unverified, retain for review/g)).toHaveLength(pieces);
          }
          expect(revisions[0]!.content).toContain("Last room: required 33.2 dB; available 42.1 dB.");
          expect(revisions[0]!.content.match(/Component detail\./g)).toHaveLength(800);
          expect(revisions[0]!.content.match(/No further preliminaryRemarks evidence/g)).toHaveLength(1);
          expect((revisions[0]!.payload as any).template.id).toBe("exterior-noise-concept");
          expect((revisions[0]!.payload as any).template.attachments.map((a: any) => a.pageStart)).toEqual([2, 3]);
        } else {
          expect(result!.status).toBe("failed");
          expect(revisions).toHaveLength(0);
          const events = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId));
          const failure = events.find(e => e.eventType === "provider_call_failed");
          const diagnostics = JSON.parse(failure!.paramsSummary!).diagnostics;
          if (scenario === "tokens") expect(diagnostics.finishReason).toBe("length");
          if (scenario === "placeholder") expect(diagnostics.issues[0].path).toEqual(["document", "template", "preliminaryRemarks"]);
          if (scenario === "incomplete") expect(diagnostics.issues[0].path).toEqual(["complete"]);
        }
      } finally {
        server.close();
        for (const table of [artifactRevisions, artifacts, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns, tasks])
          await db.delete(table).where(eq(table.tenantId, tenantId));
      }
    }
  } finally { await pool.end(); }
}, 15000);

for (const scenario of ["serial", "parallel", "failure", "cancel", "context", "context_multi", "context_incomplete", "context_truncated", "context_resume"] as const) integration(
  `acoustic drafting preserves ordered evidence and bounded, resumable work: ${scenario}`, async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID(), versionId = crypto.randomUUID();
    const longContext = scenario.startsWith("context");
    const model = { modelId: longContext ? "gpt-6-astra" : "test-model", maxOutputTokens: 2048, maxSteps: 1 };
    const maxParallel = scenario === "serial" ? 1 : 3;
    const pages = Array.from({ length: 8 }, (_, index) => `[Page ${index + 1}] ${String(index + 1).repeat(scenario === "context_multi" ? 120000 : 2490)}`);
    const gates = new Map<number, { resolve: () => void; reject: () => void }>();
    const calls: number[] = [];
    const pieceCalls: { batch: number; parentBatch?: number }[] = [];
    let active = 0, peak = 0, interrupted = false;
    let pending: Promise<void> | undefined;
    const waitFor = async (condition: () => Promise<boolean> | boolean) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await condition()) return;
        await Bun.sleep(10);
      }
      throw new Error("Expected drafting milestone was not reached");
    };
    const d: any = {
      db, tenantId, actorId, supervisorEnabled: true, requirePermission: () => {}, auditRun: async () => {}, audit: async () => {},
      validateProject: async () => true, validateSourceVersion: async (_: string, id: string) => id === versionId,
      providerConfigured: async () => false,
      listProjectSources: async () => ({ sources: [{ versionId, name: "Evidence.pdf" }], truncated: false }),
      resolveSource: async (_: string, input: any) => {
        const pageStart = input.pageStart, pageEnd = input.pageEnd;
        return { status: "resolved", source: { versionId, name: "Evidence.pdf", version: 1 }, content: {
          status: "available", text: pages.slice(pageStart - 1, pageEnd).join("\n"),
          coverage: { pageStart, pageEnd, totalPages: 8, nextPage: null, truncated: false },
          retrieval: { pageNumbers: Array.from({ length: pageEnd - pageStart + 1 }, (_, i) => pageStart + i) },
        } };
      },
      executeSupervisor: async ({ context, onSummaryDelta, modelPolicy }: any) => {
        expect(modelPolicy.supervisor.maxOutputTokens).toBe(2048);
        if (longContext && context.documentTask === "section") {
          expect(Buffer.byteLength(JSON.stringify(context), "utf8")).toBeLessThan(837952);
          if (scenario === "context_multi") for (const source of context.sources) expect(pages).toContain(source.text.trimEnd());
        }
        // No per-piece stream may alter the shared conversational summary.
        if (onSummaryDelta) await onSummaryDelta("MIXED PIECE STREAM");
        if (context.documentTask === "outline") return { status: "completed", output: {
          id: "exterior-noise-concept", title: "Ordered acoustic report", language: "en",
          project: { name: "Parallel test", number: null, client: null, designer: null, author: null, date: null },
          sections: acousticSectionKeys("exterior-noise-concept").map(key => ({ key, sources: key === "components"
            ? [{ versionId, pageStart: 4, pageEnd: 8 }, { versionId, pageStart: 1, pageEnd: 4 }, { versionId, pageStart: 3, pageEnd: 5 }]
            : key === "plans" ? [{ versionId, pageStart: 1, pageEnd: 1 }, { versionId, pageStart: 8, pageEnd: 8 }] : [] })),
          attachments: [],
        } };
        if (context.section === "components") {
          calls.push(context.batch);
          pieceCalls.push({ batch: context.batch, parentBatch: context.parentBatch });
          active++;
          peak = Math.max(peak, active);
          try {
            if (longContext && context.splitOnTruncation && !["context", "context_multi"].includes(scenario)) {
              if (scenario === "context_truncated") throw Object.assign(new Error("Truncated output"), { providerFailure: true, retryable: true,
                failureCategory: "validation", diagnostics: { errorId: "STRUCTURED_OUTPUT_TRUNCATED", finishReason: "length" } });
              return { status: "completed", output: { complete: false, content: "Output budget too small for complete evidence.", citations: [] } };
            }
            if (scenario === "context_resume" && context.parentBatch && context.batch === 2 && !interrupted) {
              interrupted = true;
              throw Object.assign(new Error("Timed out"), { code: "timeout", providerFailure: true, retryable: false });
            }
            if (!longContext && !interrupted && maxParallel > 1) await new Promise<void>((resolve, reject) => gates.set(context.batch, {
              resolve, reject: () => reject(Object.assign(new Error("Timed out"), { code: "timeout", providerFailure: true, retryable: false })),
            }));
          } finally { active--; }
        }
        return { status: "completed", output: { complete: true, citations: context.sources.length ? [versionId] : [],
          content: context.sources.length ? context.sources.map((source: any) => source.text).join("")
            : `No ${context.section} evidence supplied; request the missing input.`,
        } };
      },
    };
    const server = express().use(express.json()).use(runsRouter(() => d)).listen(0);
    try {
      const [run] = await db.insert(agentRuns).values({ tenantId, projectId, goal: "Create exterior-noise-concept", provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID() }).returning();
      const id = run!.id;
      await createSupervisor(d, db, run, "medium", { provider: "openai", effort: "medium", version: 1, source: "workspace", supervisor: model,
        specialists: { source_reviewer: model, requirements_reviewer: model }, maxParallel, maxTasks: 4, maxRevisions: 1 });
      await db.update(supervisorRuns).set({ phase: "review", assignments: [{ role: "source_reviewer", sourceVersionIds: [versionId],
        runId: crypto.randomUUID(), taskId: crypto.randomUUID(), output: { citations: [versionId] } }] }).where(eq(supervisorRuns.runId, id));
      const savedParts = async () => {
        const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, id));
        return (state!.review as any).documentDraft?.sections.components?.parts ?? [];
      };
      pending = stepSupervisor(d, id);
      if (!longContext && maxParallel > 1) {
        await waitFor(() => gates.size === 3);
        expect([...calls].sort()).toEqual([1, 2, 3]);
        if (scenario === "failure") {
          gates.get(2)!.reject();
          await waitFor(async () => (await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, id))).some(event => event.eventType === "provider_call_failed"));
          // The failed worker must stop scheduling, but let healthy siblings save.
          await Bun.sleep(20);
        }
        gates.get(3)!.resolve();
        await waitFor(async () => Boolean((await savedParts())[2]));
        expect((await savedParts()).slice(0, 2)).toEqual([null, null]);
        if (scenario === "cancel") {
          await db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, id));
        }
        interrupted = true;
        for (const gate of gates.values()) gate.resolve();
      }
      await pending;
      expect(active).toBe(0);
      expect(peak).toBe(longContext ? 1 : maxParallel);
      if (scenario === "context_resume") {
        const [failed] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
        expect(failed!.status).toBe("failed");
        expect(await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId))).toHaveLength(0);
        const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${id}/retry`, { method: "POST" });
        expect(response.status).toBe(201);
        const previousCalls = pieceCalls.length;
        await stepSupervisor(d, id);
        expect(pieceCalls.slice(previousCalls).every(call => call.parentBatch === 1 && call.batch > 1)).toBe(true);
      }
      if (scenario === "failure" || scenario === "cancel") {
        expect(await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId))).toHaveLength(0);
        const [stopped] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
        expect(stopped!.status).toBe(scenario === "failure" ? "failed" : "cancelled");
        const parts = await savedParts();
        expect(parts[2]).toBeTruthy();
        expect(parts[1]).toBeNull();
        if (scenario === "failure") {
          expect(parts[0]).toBeTruthy();
          expect(calls).toHaveLength(3);
        } else expect(parts[0]).toBeNull();
        const previousCalls = calls.length;
        const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/runs/${id}/retry`, { method: "POST" });
        expect(response.status).toBe(201);
        await stepSupervisor(d, id);
        expect(calls.slice(previousCalls)).not.toContain(3);
        if (scenario === "failure") expect(calls.slice(previousCalls)).not.toContain(1);
      }
      const [result] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
      expect(result!.status).toBe("needs_review");
      const revisions = await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId));
      expect(revisions).toHaveLength(1);
      const template = (revisions[0]!.payload as any).template;
      // Whitespace between pieces is harmless; no page may be repeated, lost or reordered.
      expect(template.components.replace(/\s/g, "")).toBe(pages.join("").replace(/\s/g, ""));
      expect(template.plans.replace(/\s/g, "")).toBe((pages[0]! + pages[7]!).replace(/\s/g, ""));
      expect(revisions[0]!.sourceVersionIds).toEqual([versionId]);
      if (longContext) {
        // One initial section call, never an unchanged retry after truncation.
        expect(pieceCalls.filter(call => !call.parentBatch).map(call => call.batch).sort()).toEqual(scenario === "context_multi" ? [1, 2] : [1]);
        if (scenario === "context" || scenario === "context_multi") expect(calls).toHaveLength(scenario === "context_multi" ? 2 : 1);
        else expect(pieceCalls.some(call => call.parentBatch === 1)).toBe(true);
      } else {
        // Each 2.5 KB page ends at a preferred line boundary within the 4 KB budget.
        expect(new Set(calls).size).toBe(8);
      }
      const events = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, id));
      expect(events.filter(event => event.eventType === "output_progress")).toHaveLength(0);
    } finally {
      interrupted = true;
      for (const gate of gates.values()) gate.resolve();
      await pending;
      server.close();
      for (const table of [artifactRevisions, artifacts, agentRunUsage, agentRunAttempts, agentRunEvents, supervisorRuns, agentRuns])
        await db.delete(table).where(eq(table.tenantId, tenantId));
      await pool.end();
    }
  }, 10000,
);

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
      expect(revisions[0]!.content).toContain("not a standards-based engineering verification");
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
      executionLimits: { summaryMaxCharacters: 20000, rationaleMaxCharacters: 5000, documentMaxCharacters: 100000, timeoutSeconds: 10 },
    };
    let providerCalls = 0;
    const summary = "Actual reviewed result. ".repeat(600);
    const rationale = "Checked source evidence. ".repeat(150);
    const document = { title: "Source-based project concept", content: `# Requested concept\n\nProposed measures [${sourceId}]\n\n${"Full review-ready detail. ".repeat(3000)}`.trim() };
    const d: any = {
      db,
      tenantId,
      actorId,
      requirePermission: () => {},
      validateProject: async () => true,
      validateSourceVersion: async () => true,
      auditRun: async () => {},
      audit: async () => {},
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
          summary,
          document,
          rationale,
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
      const [snapshot] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run!.id));
      expect((snapshot.modelPolicy as any).executionLimits).toEqual(policy.executionLimits);
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
      expect(revisions[0]!.content).toContain(rationale);
      expect(revisions[0]!.sourceVersionIds).toEqual([sourceId]);
      const outputs = await db
        .select()
        .from(messages)
        .where(eq(messages.runId, run!.id));
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.body).toBe(summary);
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
      expect(parent!.outputSummary).toBe(summary);
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
      // Exercise the public revision API with an escaped JSON body above the old parser ceiling.
      const app = express();
      app.use(express.json({ limit: "4mb" }));
      app.use(workspaceRouter(() => d));
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      try {
        const edited = `${document.content}\n${"\u0001".repeat(220000)}`;
        expect(JSON.stringify(edited).length).toBeGreaterThan(1024 * 1024);
        const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/artifacts/${reference.artifactId}/revisions`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: document.title, content: edited, sourceVersionIds: [sourceId] }),
        });
        expect(response.status).toBe(201);
        expect((await response.json()).data.content).toBe(edited);
        const editedRows = await db.select().from(artifactRevisions).where(eq(artifactRevisions.artifactId, reference.artifactId));
        expect(editedRows).toHaveLength(2);
        expect(editedRows.find(row => row.version === 2)!.content).toBe(edited);
        expect(editedRows.find(row => row.id === reference.revisionId)).toEqual(revisions[0]);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
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
