import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";
import { runsRouter } from "../richtfest-apps/knowledge/src/runs";
import { acousticScenariosRouter } from "../richtfest-apps/knowledge/src/acoustic-scenarios";
import { acousticInputReviewRouter } from "../richtfest-apps/knowledge/src/acoustic-input-review";
import { reviewsRouter } from "../richtfest-apps/knowledge/src/reviews";
import { createArtifact, workspaceRouter } from "../richtfest-apps/knowledge/src/workspace";
import { prepareArtifactPdf } from "../richtfest-apps/knowledge/src/artifact-pdf-exports";
import { Readable } from "node:stream";
import { stepSupervisor } from "../richtfest-apps/knowledge/src/supervisor";
import { agentRuns, agentRunSteps, agentRunAttempts, agentRunUsage, agentRunEvents,
  supervisorRuns, tasks, artifacts, artifactRevisions, annotations, conversations, messages, drafts } from "../richtfest-apps/knowledge/src/schema";
import { agentPresetSnapshotSchema } from "../richtfest-shared/src/agent-policy";
import { calculateAcoustics } from "../richtfest-apps/acoustics/src/calculations";
import { exteriorNoiseFixture } from "./fixtures/exterior-noise";
import { exteriorNoisePackets } from "./fixtures/exterior-noise-packets";

const integration = process.env.DATABASE_URL ? test : test.skip;
// Same vendor snapshot as supervisor.integration.test.ts, including a domain role.
const model = { modelId: "test-model", maxOutputTokens: 1024, maxSteps: 3 };
const policy = agentPresetSnapshotSchema.parse({ provider: "openai", effort: "medium", version: 1,
  source: "vendor", supervisor: model,
  specialists: { source_reviewer: model, requirements_reviewer: model, sound_insulation: model },
  maxParallel: 2, maxTasks: 4, maxRevisions: 2 });
const templates = ["sound-insulation-review", "interior-noise-concept", "exterior-noise-concept"] as const;

async function fixture() {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const sourceVersionId = crypto.randomUUID();
  const audits: unknown[][] = [];
  let providerCalls = 0, supervisorCalls = 0, decisionCalls = 0;
  const d: AppDeps = {
    db, tenantId, actorId, supervisorEnabled: true,
    requirePermission: () => {}, audit: async (...args) => { audits.push(args.slice(1)); }, auditRun: async () => {},
    validateProject: async id => id === projectId,
    validateSource: async () => true, validateSourceVersion: async (p, id) => p === projectId && id === sourceVersionId,
    validateUser: async () => true, validateConversation: async () => true, cancelExecution: () => {},
    providerConfigured: async () => true, resolveSupervisorPreset: async () => policy,
    sourceReferences: async () => [], componentContext: async () => ({ status: "available", items: [], truncated: false }),
    listProjectSources: async () => ({ sources: [], truncated: false, authority: "unreviewed_source_inventory" }),
    resolveSource: async () => ({ status: "resolved", source: { versionId: sourceVersionId, name: "Evidence.pdf", version: 1 },
      content: { status: "available", text: "Evidence for discussion", truncated: false } }),
    executeProvider: async () => { providerCalls++; return { status: "completed", output: {
      summary: "Conversational answer", rationale: "Discussion only", citations: [], tools: [],
    } }; },
    executeSupervisor: async ({ phase }) => {
      supervisorCalls++;
      return { status: "completed", output: phase === "plan"
        ? { tasks: [{ role: "sound_insulation", goal: "Discuss acoustic evidence", sourceVersionIds: [] }] }
        : phase === "specialist"
          ? { summary: "Acoustic discussion", rationale: "No report requested", citations: [] }
          : { decision: "accept", summary: "Team answer", rationale: "Discussion complete", citations: [], revisions: [],
              ...(phase === "independent_review" ? { findings: [] } : {}) } };
    },
    executeDecision: async () => { decisionCalls++; return { status: "completed", output: {
      model: "jev-1.13.0", answers: { mode: { type: "choice", choice: "chat", confidence: 0.99,
        probabilities: { chat: 0.99, team: 0.003, report: 0.003, calculation: 0.002, uncertain: 0.002 } } },
    } }; },
  };
  const getDeps = (req: express.Request) => ({ ...d,
    tenantId: req.headers["x-other-tenant"] ? crypto.randomUUID() : tenantId,
    validateProject: req.headers["x-other-tenant"] ? async () => false : d.validateProject,
  });
  const server = express().use(express.json()).use(runsRouter(getDeps))
    .use(acousticScenariosRouter(getDeps)).use(acousticInputReviewRouter(getDeps)).use(reviewsRouter(getDeps)).use(workspaceRouter(getDeps))
    .use((error: any, _req: any, res: any, _next: any) =>
    res.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ error: "rejected" })).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text };
  };
  const rows = (table: any) => db.select().from(table).where(eq(table.tenantId, tenantId));
  const stopped = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
      if (run && !["queued", "running"].includes(run.status)) return run;
      await Bun.sleep(10);
    }
    throw new Error(`Run ${id} did not settle`);
  };
  return { d, db, projectId, sourceVersionId, audits, post, rows, stopped,
    get: async (path: string) => { const response = await fetch(base + path); return { status: response.status, body: await response.json() }; },
    input: { projectId, goal: "Discuss the project's acoustic requirements", sourceVersionIds: [] },
    calls: () => ({ providerCalls, supervisorCalls, decisionCalls }),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const table of [agentRunSteps, agentRunUsage, agentRunAttempts, agentRunEvents, annotations, artifactRevisions,
        artifacts, messages, supervisorRuns, tasks, agentRuns, conversations, drafts])
        await db.delete(table).where(eq(table.tenantId, tenantId));
      await pool.end();
    },
  };
}

integration("explicit chat bypasses supervision; omission keeps legacy supervised behavior", async () => {
  const f = await fixture();
  try {
    const chat = await f.post("/runs", { ...f.input, workflow: { mode: "chat" } });
    expect(chat.status).toBe(201);
    expect(await f.rows(supervisorRuns)).toHaveLength(0);
    const run = await f.stopped(chat.body.data.id);
    expect(run.modelPolicy.workflow).toEqual({ mode: "chat" });
    expect(run.outputSummary).toBe("Conversational answer");
    expect(f.calls()).toMatchObject({ providerCalls: 1, supervisorCalls: 0 });
    expect(await f.rows(supervisorRuns)).toHaveLength(0);
    expect(await f.rows(artifacts)).toHaveLength(0);
    const legacy = await f.post("/runs", f.input);
    expect(legacy.status).toBe(201);
    expect((await f.rows(supervisorRuns)).map((row: any) => row.runId)).toEqual([legacy.body.data.id]);
    expect(legacy.body.data.modelPolicy.workflow).toBeUndefined();
  } finally { await f.close(); }
});

for (const attempt of ["delegate_source_review", "create_draft", "artifact"] as const)
integration(`chat fences malformed provider ${attempt} without child or artifact writes`, async () => {
  const f = await fixture();
  f.d.executeProvider = async () => ({ status: "completed", output: {
    summary: "Forbidden output", rationale: "", citations: [],
    tools: attempt === "artifact" ? [] : [{ name: attempt, input: attempt === "create_draft"
      ? { title: "Forbidden draft", content: "Must not persist" }
      : { goal: "Forbidden delegation", sourceVersionIds: [f.sourceVersionId] } }],
    ...(attempt === "artifact" ? { artifact: { title: "Forbidden artifact", content: "Must not persist", type: "draft" } } : {}),
  } });
  try {
    const created = await f.post("/runs", { ...f.input, workflow: { mode: "chat" } });
    expect(created.status).toBe(201);
    expect(await f.rows(supervisorRuns)).toHaveLength(0);
    await f.stopped(created.body.data.id);
    expect(await f.rows(agentRuns)).toHaveLength(1);
    expect(await f.rows(tasks)).toHaveLength(0);
    expect(await f.rows(artifacts)).toHaveLength(0);
    expect(await f.rows(artifactRevisions)).toHaveLength(0);
    expect(await f.rows(supervisorRuns)).toHaveLength(0);
  } finally { await f.close(); }
});

integration("chat uses opted-in Jev search ranking without supervision or artifacts", async () => {
  const f = await fixture();
  f.d.resolveSupervisorPreset = async () => ({ ...policy, knowledgeRerankingEnabled: true });
  let calls = 0, targetId = "";
  f.d.executeDecision = async input => {
    const candidates = (input.state as { candidates: { id: string }[] }).candidates;
    expect(candidates).toHaveLength(5);
    // Promote the lowest-ranked SQL match, outside the baseline top four.
    targetId = candidates[4]!.id;
    return { status: "completed", output: { model: "jev-1.13.0", answers: Object.fromEntries(candidates.map(({ id }) => [id, {
      type: "choice", choice: id === targetId ? "relevant" : "irrelevant", confidence: 1,
      probabilities: { relevant: id === targetId ? 1 : 0, irrelevant: id === targetId ? 0 : 1, uncertain: 0 },
    }])) } };
  };
  f.d.executeProvider = async input => {
    calls++;
    if (calls > 1) {
      expect(input.toolResults).toHaveLength(1);
      expect(targetId).not.toBe("");
      expect((input.toolResults![0] as any).result.entries[0].id).toBe(targetId);
    }
    return { status: "completed", output: { summary: "Search answer", rationale: "Discussion", citations: [],
      tools: calls === 1 ? [{ name: "search_company_knowledge", input: { terms: ["acoustics"] } }] : [] } };
  };
  try {
    await f.db.insert(drafts).values(Array.from({ length: 5 }, (_, i) => ({
      tenantId: f.d.tenantId, createdBy: f.d.actorId, title: `Acoustics reference ${i}`,
      body: "Acoustics guidance", status: "approved", createdAt: new Date(1700000000000 + i * 1000),
    })));
    const result = await f.post("/runs", { ...f.input, workflow: { mode: "chat" } });
    expect(result.status).toBe(201);
    expect(await f.rows(supervisorRuns)).toHaveLength(0);
    expect((await f.stopped(result.body.data.id)).outputSummary).toBe("Search answer");
    expect(calls).toBe(2);
    expect(await f.rows(artifacts)).toHaveLength(0);
  } finally { await f.close(); }
});

for (const independentReviewEnabled of [false, true])
integration(`team supervision does not force an acoustic report (independent review: ${independentReviewEnabled})`, async () => {
  const f = await fixture();
  f.d.resolveSupervisorPreset = async () => ({ ...policy, independentReviewEnabled });
  try {
    const result = await f.post("/runs", { ...f.input, workflow: { mode: "team" } });
    expect(result.status).toBe(201);
    expect(result.body.data.modelPolicy.workflow).toEqual({ mode: "team" });
    for (let i = 0; i < 5; i++) await stepSupervisor(f.d, result.body.data.id);
    const run = await f.stopped(result.body.data.id);
    expect(run.status).toBe("needs_review");
    expect(run.outputSummary).toBe(independentReviewEnabled
      ? "Team answer\n\nIndependent review: No readable assigned sources were available for independent review."
      : "Team answer");
    expect(await f.rows(artifacts)).toHaveLength(0);
    expect(f.calls().supervisorCalls).toBeGreaterThan(0);
    expect(f.calls().providerCalls).toBe(0);
  } finally { await f.close(); }
});

integration("report rejects empty evidence and invalid formats, and preserves explicit formats", async () => {
  const f = await fixture();
  try {
    for (const workflow of [{ mode: "report" }, { mode: "report", reportTemplate: "unknown" },
      { mode: "chat", reportTemplate: templates[0] }, { mode: "invalid" },
      ...templates.map(reportTemplate => ({ mode: "report", reportTemplate }))]) {
      const result = await f.post("/runs", { ...f.input, workflow });
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.status).toBeLessThan(500);
    }
    expect(await f.rows(agentRuns)).toHaveLength(0);
    for (const reportTemplate of templates) {
      const workflow = { mode: "report", reportTemplate };
      const result = await f.post("/runs", { ...f.input, sourceVersionIds: [f.sourceVersionId], workflow });
      expect(result.status).toBe(201);
      expect(result.body.data.modelPolicy.workflow).toEqual(workflow);
    }
    expect(await f.rows(supervisorRuns)).toHaveLength(3);
  } finally { await f.close(); }
});

integration("report snapshots automatic evidence and infers its format without reusing earlier answers", async () => {
  const f = await fixture();
  const versions = Array.from({ length: 12 }, () => crypto.randomUUID());
  const inventory = versions.map((versionId, index) => ({ fileId: crypto.randomUUID(), name: `Plan ${index}.pdf`, versionId, version: 2, mimeType: "application/pdf" }));
  f.d.validateSourceVersion = async (project, id) => project === f.projectId && versions.includes(id);
  f.d.listProjectSources = async () => ({ sources: [...inventory], truncated: false, authority: "unreviewed_source_inventory" });
  try {
    const [conversation] = await f.db.insert(conversations).values({ tenantId: f.d.tenantId, projectId: f.projectId, title: "Test report", createdBy: f.d.actorId }).returning();
    const [message] = await f.db.insert(messages).values({ tenantId: f.d.tenantId, conversationId: conversation.id, actorKind: "agent", body: "HELD_OUT_EXPECTED_ANSWER", authorId: f.d.actorId }).returning();
    const [artifact] = await f.db.insert(artifacts).values({ tenantId: f.d.tenantId, projectId: f.projectId, title: "Earlier answer", type: "report", createdBy: f.d.actorId }).returning();
    const [revision] = await f.db.insert(artifactRevisions).values({ tenantId: f.d.tenantId, artifactId: artifact.id, version: 1, title: "Earlier answer", content: "HELD_OUT_COMMENTED_DOCUMENT", createdBy: f.d.actorId }).returning();
    await f.db.insert(annotations).values({ tenantId: f.d.tenantId, projectId: f.projectId, artifactRevisionId: revision.id, messageId: message.id, body: "HELD_OUT_FEEDBACK", createdBy: f.d.actorId });
    const result = await f.post("/runs", { ...f.input, conversationId: conversation.id, goal: "Erstelle ein Außenlärmkonzept", workflow: { mode: "report" } });
    expect(result.status).toBe(201);
    expect(result.body.data.sourceVersionIds).toEqual(versions);
    expect(result.body.data.modelPolicy.workflow).toEqual({ mode: "report", reportTemplate: "exterior-noise-concept" });
    // A later upload must not broaden an already pinned report's plan.
    const later = crypto.randomUUID();
    inventory.push({ ...inventory[0], versionId: later, fileId: crypto.randomUUID() });
    let context: any;
    f.d.executeSupervisor = async input => {
      context = input.context;
      return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Review evidence", sourceVersionIds: versions }] } };
    };
    await stepSupervisor(f.d, result.body.data.id);
    expect((await f.rows(supervisorRuns))[0].phase).toBe("specialists");
    expect(context.sourceInventory.sources.map((s: any) => s.versionId)).toEqual(versions);
    expect(JSON.stringify(context)).not.toContain("HELD_OUT_");
    expect(context.history).toEqual([]);
    expect(context.documentReview).toEqual({ comments: [], documents: [] });
    expect((await f.rows(agentRuns)).find((r: any) => r.id === result.body.data.id).sourceVersionIds).toEqual(versions);
    for (const [goal, expected] of [["Write an interior noise report", "interior-noise-concept"], ["Review sound insulation", "sound-insulation-review"]]) {
      const created = await f.post("/runs", { ...f.input, goal, sourceVersionIds: [versions[0]], workflow: { mode: "report" } });
      expect(created.status).toBe(201);
      expect(created.body.data.sourceVersionIds).toEqual([versions[0]]);
      expect(created.body.data.modelPolicy.workflow.reportTemplate).toBe(expected);
    }
    const count = (await f.rows(agentRuns)).length;
    f.d.listProjectSources = async () => ({ sources: [], truncated: true, authority: "unreviewed_source_inventory" });
    expect((await f.post("/runs", { ...f.input, workflow: { mode: "report" } })).status).toBe(409);
    expect(await f.rows(agentRuns)).toHaveLength(count);
    expect(f.calls().providerCalls).toBe(0);
  } finally { await f.close(); }
});

integration("disabled supervisor rejects explicit team and report but permits chat", async () => {
  const f = await fixture();
  f.d.supervisorEnabled = false;
  try {
    for (const workflow of [{ mode: "team" }, { mode: "calculation" }, { mode: "report", reportTemplate: templates[0] }]) {
      const result = await f.post("/runs", { ...f.input, sourceVersionIds: [f.sourceVersionId], workflow });
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.status).toBeLessThan(500);
    }
    expect(await f.rows(agentRuns)).toHaveLength(0);
    const chat = await f.post("/runs", { ...f.input, workflow: { mode: "chat" } });
    expect(chat.status).toBe(201);
    await f.stopped(chat.body.data.id);
  } finally { await f.close(); }
});

for (const independentReviewEnabled of [false, true])
integration(`historical v1 calculation sheet bypasses report writing and retains independent review: ${independentReviewEnabled}`, async () => {
  const f = await fixture();
  const calls: string[] = [];
  const { method, ...room } = exteriorNoiseFixture();
  const provenance = { kind: "source" as const, versionId: f.sourceVersionId, page: 1, excerpt: "Evidence for discussion" };
  for (const record of [room.room, room.applicability, room.flanking, ...room.facades, ...room.facades.map(f => f.noise), ...room.elements])
    record.provenance = provenance;
  f.d.calculateAcoustics = calculateAcoustics;
  f.d.resolveSupervisorPreset = async () => ({ ...policy, independentReviewEnabled });
  f.d.executeSupervisor = async ({ phase, context, calculateAcoustics: tool }) => {
    calls.push(phase);
    expect(tool).toBeUndefined();
    if (phase === "plan") return { status: "completed", output: { documentTemplate: null,
      tasks: [{ role: "source_reviewer", goal: "Extract calculation inputs", sourceVersionIds: [f.sourceVersionId] }] } };
    if (phase === "specialist") return { status: "completed", output: {
      summary: "Extracted inputs", rationale: "Synthetic example", citations: [], exteriorNoiseExtraction: {
        inventory: [{ roomId: room.room.id, provenance }, { roomId: "Missing", provenance }], rooms: [room],
        blockers: [{ roomId: "Missing", reason: "Window area missing" }],
      },
    } };
    expect(phase).toBe("independent_review");
    expect(JSON.stringify(context)).toContain("44.66896537322387");
    return { status: "completed", output: { decision: "accept", summary: "Inputs remain unreviewed", rationale: "Synthetic review", citations: [f.sourceVersionId], revisions: [], findings: [] } };
  };
  try {
    expect((await f.post("/runs", { ...f.input, workflow: { mode: "calculation" } })).status).toBe(409);
    const created = await f.post("/runs", { ...f.input, goal: "Schallschutznachweis", intent: "calculation",
      sourceVersionIds: [f.sourceVersionId], workflow: { mode: "calculation" } });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("queued");
    await stepSupervisor(f.d, created.body.data.id);
    const [planned] = await f.rows(supervisorRuns);
    await f.db.update(supervisorRuns).set({ assignments: planned.assignments.map((a: any) => ({ ...a, exteriorNoiseExtractionVersion: 1 })) })
      .where(eq(supervisorRuns.runId, created.body.data.id));
    for (let step = 0; step < 5; step++) await stepSupervisor(f.d, created.body.data.id);
    expect((await f.stopped(created.body.data.id)).status).toBe("needs_review");
    expect(calls).toEqual(independentReviewEnabled ? ["plan", "specialist", "independent_review"] : ["plan", "specialist"]);
    const revisions = await f.rows(artifactRevisions);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].content).toContain("Schallschutznachweis");
    expect(revisions[0].content).toContain("Rw = 44.66896537322387 dB");
    expect(revisions[0].content).toContain("| Missing | — | — | — | Offen |");
    expect(revisions[0].content).not.toContain("Bebauungsplan");
    expect(revisions[0].payload.template).toBeUndefined();
    expect(revisions[0].payload.acousticDataset.receipt.input.rooms).toEqual([room]);
    expect(revisions[0].payload.acousticDataset.blockers).toContain("Room Missing: Window area missing");
    expect((await f.rows(agentRunSteps)).filter((s: any) => s.stepKey.startsWith("exterior-calculation:"))).toHaveLength(1);
    const storage = new Map<string, Buffer>();
    f.d.sourcePdfVersionIds = async () => [];
    f.d.sourceReferences = async () => [{ versionId: f.sourceVersionId, fileName: "Synthetic evidence.pdf", version: 1 }];
    f.d.pdfStorage = {
      write: async (key, bytes) => { storage.set(key, bytes); }, remove: async key => { storage.delete(key); },
      read: async key => storage.has(key) ? { stream: Readable.from([storage.get(key)!]), sizeBytes: storage.get(key)!.length } : null,
    };
    // Exercise immutable revision lookup, worker transfer, cache and saved calculator output.
    await prepareArtifactPdf(f.d, revisions[0].artifactId, revisions[0].id);
    const prepared = await prepareArtifactPdf(f.d, revisions[0].artifactId, revisions[0].id);
    expect(prepared).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of prepared!.stream) chunks.push(Buffer.from(chunk));
    const pdf = Buffer.concat(chunks);
    const extracted = Bun.spawnSync(["pdftotext", "-layout", "-", "-"], { stdin: pdf });
    expect(extracted.exitCode).toBe(0);
    const pages = extracted.stdout.toString().split("\f").filter(p => p.trim());
    expect(pages[0]).toContain("Prüfbericht");
    expect(pages[2]).toContain("Schallschutznachweis");
    expect(pages.join("\n")).toContain("44,669 − 2 dB = 42,669 dB vorhanden");
    expect(pages.join("\n")).toContain("Raum Missing");
    expect(pages.join("\n")).toContain("Window area missing");
    if (process.env.NACHWEIS_ENGINE_REVIEW_PATH) await Bun.write(process.env.NACHWEIS_ENGINE_REVIEW_PATH, pdf);
  } finally { await f.close(); }
});

integration("v2 chat resolves source conflicts with revision fences and creates a model-free unapproved sheet", async () => {
  const f = await fixture();
  const phases: string[] = [];
  const packets = exteriorNoisePackets(f.sourceVersionId);
  const floor = packets[0]!.facts.find(f => f.field === "floorAreaM2")!;
  packets[0]!.facts.push({ ...floor, value: 24, provenance: { ...packets[0]!.inventory[0]!.provenance, page: 2 } });
  packets[1]!.facts = packets[1]!.facts.filter(f => !(f.id === "FE1" && f.field === "areaM2"));
  const extraction = { ...packets[0]!, facts: packets.flatMap(p => p.facts),
    blockers: [{ roomId: "A01", reason: "Original source note still needs professional review" }] };
  f.d.calculateAcoustics = calculateAcoustics;
  const text = packets[0]!.inventory[0]!.provenance.excerpt;
  f.d.resolveSource = async () => ({ status: "resolved", source: { versionId: f.sourceVersionId, name: "Schedule.pdf", version: 1 },
    content: { status: "available", text, truncated: false } });
  f.d.executeSupervisor = async ({ phase }) => {
    phases.push(phase);
    if (phase === "plan") return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Extract inputs", sourceVersionIds: [f.sourceVersionId] }] } };
    if (phase === "specialist") return { status: "completed", output: { summary: "Room inputs", rationale: "Extraction", citations: [f.sourceVersionId], exteriorNoiseExtraction: extraction } };
    throw new Error("Incomplete inputs must not buy report/review calls");
  };
  try {
    const [chat] = await f.db.insert(conversations).values({ tenantId: f.d.tenantId, projectId: f.projectId,
      title: "Input review", createdBy: f.d.actorId }).returning();
    const created = await f.post("/runs", { ...f.input, conversationId: chat.id,
      sourceVersionIds: [f.sourceVersionId], workflow: { mode: "calculation" } });
    expect(created.status).toBe(201);
    for (let i = 0; i < 5; i++) await stepSupervisor(f.d, created.body.data.id);
    expect((await f.stopped(created.body.data.id)).status).toBe("needs_review");
    expect(phases).toEqual(["plan", "specialist"]);
    const [artifact] = await f.rows(artifacts);
    expect(await f.rows(artifacts)).toHaveLength(1);
    expect((await f.rows(messages)).some((m: any) => m.openui === `root = AcousticInputReview(${JSON.stringify(artifact.id)})`)).toBe(true);
    const path = `/conversations/${chat.id}/acoustic-inputs/${artifact.id}`;
    const loaded = await f.get(path);
    expect(loaded.status).toBe(200);
    const data = loaded.body.data;
    expect(data.fields.filter((v: any) => v.value === null)).toHaveLength(2);
    const key = (field: string, id: string) => data.fields.find((v: any) => v.field === field && v.id === id).key;
    const body = { expectedRevisionId: data.revisionId, action: "save", reason: "Use schedule revision 1; supplied missing window area",
      confirmInventory: true, changes: [{ key: key("floorAreaM2", "A01"), value: 20 }, { key: key("areaM2", "FE1"), value: 2 }] };
    expect((await f.post(path, body, { "x-other-tenant": "1" })).status).toBe(404);
    const [otherChat] = await f.db.insert(conversations).values({ tenantId: f.d.tenantId, projectId: f.projectId,
      title: "Other", createdBy: f.d.actorId }).returning();
    expect((await f.post(path.replace(chat.id, otherChat.id), body)).status).toBe(404);
    expect((await f.post(path, { ...body, action: "calculate", changes: [] })).status).toBe(409);
    expect((await f.post(path, { ...body, changes: [{ ...body.changes[1], value: -2 }] })).status).toBe(400);
    expect((await f.post(path, { ...body, changes: [body.changes[0], body.changes[0]] })).status).toBe(409);
    const permission = f.d.requirePermission;
    f.d.requirePermission = p => { if (p === "knowledge:write") throw Object.assign(new Error("Forbidden"), { status: 403 }); };
    expect((await f.post(path, body)).status).toBe(403);
    f.d.requirePermission = permission;
    const validate = f.d.validateSourceVersion;
    f.d.validateSourceVersion = async () => false;
    expect((await f.get(path)).status).toBe(404);
    expect((await f.post(path, body)).status).toBe(404);
    f.d.validateSourceVersion = validate;
    const response = await f.post(path, body);
    expect(response.status).toBe(200);
    expect(response.body.data.blockers).toEqual([]);
    expect(response.body.data.resolutions.map((r: any) => r.fact.provenance.kind)).toEqual(["source", "assumption"]);
    expect((await f.get(path)).body.data.revisionId).toBe(response.body.data.revisionId);
    expect((await f.post(path, body)).status).toBe(409);
    const calculate = { ...body, expectedRevisionId: response.body.data.revisionId, action: "calculate", changes: [] };
    const concurrent = await Promise.all([f.post(path, calculate), f.post(path, calculate)]);
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 409]);
    const output = concurrent.find(r => r.status === 200)!.body.data;
    expect(output.calculation.artifact.status).toBe("draft");
    expect((await f.get(`/artifacts/${output.calculation.artifact.id}`)).body.data.artifact.conversationId).toBe(chat.id);
    expect((await f.get(`/workspaces/${f.projectId}`)).body.data.artifacts
      .find((a: any) => a.id === output.calculation.artifact.id).conversationId).toBe(chat.id);
    const dataset = output.calculation.revision.payload.acousticDataset;
    expect(dataset.basedOn.revisionId).toBe(output.revisionId);
    expect(dataset.blockers).toEqual(["A01: Original source note still needs professional review"]);
    expect(dataset.receipt.batch.rooms[0].result.value).toBeCloseTo(41.4724225, 5);
    expect(dataset.receipt.input.rooms[0].fieldEvidence.find((e: any) => e.field === "element/FE1/areaM2").provenance.kind).toBe("assumption");
    expect((await f.rows(artifactRevisions)).find((r: any) => r.id === data.revisionId).payload.acousticInputReview.resolutions).toEqual([]);
    expect(phases).toEqual(["plan", "specialist"]);
    expect(f.calls()).toEqual({ providerCalls: 0, supervisorCalls: 0, decisionCalls: 0 });
    expect(f.audits.some(a => a[0] === "knowledge.acoustic_inputs.resolved")).toBe(true);
  } finally { await f.close(); }
});

for (const scenario of [
  { mode: "report", chat: true, problem: "applicability" },
  { mode: "calculation", chat: true, problem: "geometry" },
  { mode: "report", chat: false, problem: "missing" },
  { mode: "calculation", chat: false, problem: "conflict" },
  { mode: "calculation", chat: true, problem: "below_target" },
] as const) integration(`v2 ${scenario.mode} handles ${scenario.problem} inputs with chat=${scenario.chat}`, async () => {
  const f = await fixture();
  const phases: string[] = [];
  const packets = exteriorNoisePackets(f.sourceVersionId);
  const extraction = { ...packets[0]!, facts: packets.flatMap(p => p.facts) };
  if (scenario.problem === "applicability") extraction.facts.find(f => f.target === "applicability" && f.field === "assessment")!.value = "unknown";
  if (scenario.problem === "geometry") extraction.facts.find(f => f.id === "FE1" && f.field === "areaM2")!.value = 3;
  if (scenario.problem === "missing") extraction.facts = extraction.facts.filter(f => !(f.id === "FE1" && f.field === "areaM2"));
  if (scenario.problem === "conflict") extraction.facts.push({ ...extraction.facts.find(f => f.field === "floorAreaM2")!, value: 24 });
  if (scenario.problem === "below_target") extraction.facts.find(f => f.id === "FE1" && f.field === "rwDb")!.value = 15;
  f.d.calculateAcoustics = calculateAcoustics;
  f.d.resolveSource = async () => ({ status: "resolved", source: { versionId: f.sourceVersionId, name: "Schedule.pdf", version: 1 },
    content: { status: "available", text: extraction.inventory[0]!.provenance.excerpt, truncated: false } });
  f.d.executeSupervisor = async ({ phase }) => {
    phases.push(phase);
    if (phase === "plan") return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Extract inputs", sourceVersionIds: [f.sourceVersionId] }] } };
    if (phase === "specialist") return { status: "completed", output: { summary: "Room inputs", rationale: "Extraction", citations: [f.sourceVersionId], exteriorNoiseExtraction: extraction } };
    throw new Error("Blocked calculations must not buy report/review calls");
  };
  try {
    const [chat] = scenario.chat ? await f.db.insert(conversations).values({ tenantId: f.d.tenantId, projectId: f.projectId,
      title: "Input review", createdBy: f.d.actorId }).returning() : [];
    const created = await f.post("/runs", { ...f.input, ...(chat ? { conversationId: chat.id } : {}),
      sourceVersionIds: [f.sourceVersionId], workflow: scenario.mode === "report"
        ? { mode: "report", reportTemplate: "exterior-noise-concept" } : { mode: "calculation" } });
    expect(created.status).toBe(201);
    for (let i = 0; i < 5; i++) await stepSupervisor(f.d, created.body.data.id);
    expect((await f.stopped(created.body.data.id)).status).toBe("needs_review");
    expect(phases).toEqual(["plan", "specialist"]);
    const [state] = await f.rows(supervisorRuns);
    expect(state.phase).toBe("done");
    if (scenario.problem === "below_target") {
      expect(state.review.inputReviewRequired).toBeUndefined();
      const sheet = (await f.rows(artifactRevisions)).find((r: any) => r.payload?.acousticDataset);
      expect(sheet.payload.acousticDataset.receipt.batch.complete).toBe(true);
      expect(sheet.payload.acousticDataset.receipt.batch.rooms[0].result.exteriorNoise.marginDb).toBeLessThan(0);
      expect(sheet.payload.template).toBeUndefined();
      expect(sheet.content).not.toContain("Bebauungsplan");
      return;
    }
    expect(state.review.inputReviewRequired).toBe(true);
    const steps = (await f.rows(agentRunSteps)).filter((s: any) => s.stepKey.startsWith("exterior-calculation:"));
    expect(steps).toHaveLength(1);
    expect(steps[0].output.result.batch.rooms).toHaveLength(1);
    expect(steps[0].output.result.batch.rooms[0].roomId).toBe("A01");
    expect(steps[0].output.result.batch.complete).toBe(false);
    expect(state.review.calculationBlockers.length).toBeGreaterThan(0);
    expect(await f.rows(artifacts)).toHaveLength(chat ? 1 : 0);
    if (chat) {
      const [artifact] = await f.rows(artifacts);
      const loaded = await f.get(`/conversations/${chat.id}/acoustic-inputs/${artifact.id}`);
      expect(loaded.status).toBe(200);
      expect(loaded.body.data.blockers).toEqual([]); // Typed inputs can still be unsupported by the calculator.
      const path = `/conversations/${chat.id}/acoustic-inputs/${artifact.id}`;
      const request = { expectedRevisionId: loaded.body.data.revisionId, action: "calculate",
        reason: "Synthetic correction; not engineering approval", confirmInventory: true, changes: [] };
      // An explicit, model-free sheet remains available with honest per-room blockers.
      const blocked = await f.post(path, request);
      expect(blocked.status).toBe(200);
      expect(blocked.body.data.calculation.revision.payload.acousticDataset.receipt.batch.complete).toBe(false);
      expect(blocked.body.data.calculation.revision.payload.acousticDataset.receipt.batch.issues.length).toBeGreaterThan(0);
      expect(blocked.body.data.calculation.artifact.status).toBe("draft");
      const field = loaded.body.data.fields.find((f: any) => scenario.problem === "applicability"
        ? f.target === "applicability" && f.field === "assessment" : f.id === "FE1" && f.field === "areaM2");
      const corrected = await f.post(path, { ...request, expectedRevisionId: blocked.body.data.revisionId, changes: [{ key: field.key,
        value: scenario.problem === "applicability" ? "standard_exterior_noise" : 2 }] });
      expect(corrected.status).toBe(200);
      expect(corrected.body.data.calculation.revision.payload.acousticDataset.receipt.batch.complete).toBe(true);
      expect(corrected.body.data.calculation.artifact.status).toBe("draft");
      expect(phases).toEqual(["plan", "specialist"]);
    }
  } finally { await f.close(); }
});

integration("reviewed room inputs fork model-free scenarios with immutable provenance, fresh results and approval fences", async () => {
  const f = await fixture();
  try {
    f.d.calculateAcoustics = calculateAcoustics;
    const { method, ...room } = exteriorNoiseFixture();
    const p = { kind: "source" as const, versionId: f.sourceVersionId, page: 1, excerpt: "Evidence for discussion" };
    for (const record of [room.room, room.applicability, room.flanking, ...room.facades, ...room.facades.map(f => f.noise), ...room.elements]) record.provenance = p;
    const fieldEvidence = [
      ...room.facades.map(f => ({ field: `noise/${f.id}/levelDb`, provenance: p })),
      { field: `room/${room.room.id}/floorAreaM2`, provenance: p },
    ];
    const input = { method: "exterior_noise_batch" as const, scope: "Test", inventory: [{ roomId: room.room.id, provenance: p }], rooms: [{ ...room, fieldEvidence }] };
    const receipt = { ...calculateAcoustics(input), receiptId: crypto.randomUUID() };
    const { acousticDatasetSchema } = await import("../richtfest-shared/src/acoustic-calculation");
    const dataset = acousticDatasetSchema.parse({ version: 1, receipt, blockers: ["Confirm assessment period"], basedOn: null });
    const base = await f.db.transaction(tx => createArtifact(f.d, tx, { projectId: f.projectId, title: "Base", type: "draft",
      content: "Synthetic inputs", sourceVersionIds: [f.sourceVersionId] }, undefined, dataset));
    const path = `/artifacts/${base.artifact.id}/calculation-scenarios`;
    const body = { expectedRevisionId: base.revision.id, title: "Lower level", reason: "Compare assessed exterior levels",
      adjustments: room.facades.map(f => ({ roomId: room.room.id, target: "noise", id: f.id, field: "levelDb", value: f.noise.levelDb - 3 })) };
    expect((await f.post(path, body)).status).toBe(409);
    expect((await f.post(`/artifacts/${base.artifact.id}/review`, { expectedRevisionId: base.revision.id })).status).toBe(200);
    expect((await f.post(path, body, { "x-other-tenant": "1" })).status).toBe(404);
    const permission = f.d.requirePermission;
    f.d.requirePermission = p => { if (p === "knowledge:write") throw Object.assign(new Error("Forbidden"), { status: 403 }); };
    expect((await f.post(path, body)).status).toBe(403);
    f.d.requirePermission = permission;
    expect((await f.post(path, { ...body, adjustments: [{ ...body.adjustments[0], value: -1 }] })).status).toBe(400);
    expect((await f.post(path, { ...body, adjustments: [body.adjustments[0], body.adjustments[0]] })).status).toBe(409);
    expect((await f.post(path, { ...body, adjustments: [{ ...body.adjustments[0], field: "floorAreaM2" }] })).status).toBe(409);
    const validateSource = f.d.validateSourceVersion;
    f.d.validateSourceVersion = async () => false;
    expect((await f.post(path, body)).status).toBe(404);
    f.d.validateSourceVersion = validateSource;
    const response = await f.post(path, body);
    expect(response.status).toBe(201);
    const scenario = response.body.data;
    expect(scenario.artifact.status).toBe("draft");
    expect(scenario.artifact.runId).toBeNull();
    const result = scenario.revision.payload.acousticDataset;
    expect(result.basedOn).toEqual({ artifactId: base.artifact.id, revisionId: base.revision.id });
    // Both La values drop by 3, so relative exposure and composite Rw stay unchanged.
    expect(result.receipt.batch.rooms[0].result.value).toBeCloseTo(44.66896537322387, 10);
    expect(result.receipt.batch.rooms[0].result.exteriorNoise.marginDb - receipt.batch!.rooms[0]!.result!.exteriorNoise!.marginDb!).toBeCloseTo(3, 10);
    expect(result.receipt.input.rooms[0].facades[0].noise.provenance).toEqual({ kind: "assumption", reason: body.reason });
    expect(result.receipt.input.rooms[0].room.provenance).toEqual(p);
    expect(result.receipt.input.rooms[0].fieldEvidence).toEqual([
      fieldEvidence.at(-1),
      ...room.facades.map(f => ({ field: `noise/${f.id}/levelDb`, provenance: { kind: "assumption", reason: body.reason } })),
    ]);
    expect(result.blockers).toEqual(["Confirm assessment period"]);
    expect(scenario.revision.sourceVersionIds).toEqual([f.sourceVersionId]);
    expect(scenario.revision.content).toContain("| example-corner-room | wall-1 | levelDb | 70 | 67 |");
    expect((await f.rows(artifactRevisions)).find(r => r.id === base.revision.id)!.payload).toEqual(base.revision.payload);
    expect((await f.rows(artifacts)).find(a => a.id === base.artifact.id)!.status).toBe("approved");
    expect(f.audits.some(a => a[0] === "knowledge.acoustic_scenario.created")).toBe(true);
    expect(f.calls()).toEqual({ providerCalls: 0, supervisorCalls: 0, decisionCalls: 0 });
    expect(await f.rows(agentRuns)).toHaveLength(0);
    // Editing the original removes reusable server data and invalidates its approval.
    const revised = await f.post(`/artifacts/${base.artifact.id}/revisions`, { title: "Edited", content: "Changed", sourceVersionIds: [f.sourceVersionId],
      payload: { kind: "summary", data: [], acousticDataset: dataset } });
    expect(revised.status).toBe(201);
    expect(revised.body.data.payload.acousticDataset).toBeUndefined();
    expect((await f.post(path, body)).status).toBe(409);
    await f.post(`/artifacts/${base.artifact.id}/review`, { expectedRevisionId: revised.body.data.id });
    expect((await f.post(path, { ...body, expectedRevisionId: revised.body.data.id })).status).toBe(409);
  } finally { await f.close(); }
});

for (const workflow of [{ mode: "chat" }, { mode: "team" }, { mode: "calculation" }, ...templates.map(reportTemplate => ({ mode: "report", reportTemplate }))])
integration(`unconfigured, retry and fresh rerun retain ${JSON.stringify(workflow)}`, async () => {
  const f = await fixture();
  f.d.providerConfigured = async () => false;
  try {
    const result = await f.post("/runs", { ...f.input, sourceVersionIds: [f.sourceVersionId], workflow });
    expect(result.status).toBe(201);
    const id = result.body.data.id;
    expect(result.body.data.status).toBe("unconfigured");
    expect(result.body.data.modelPolicy.workflow).toEqual(workflow);
    f.d.providerConfigured = async () => true;
    const resumed = await f.post(`/runs/${id}/retry`);
    expect(resumed.status).toBe(201);
    // No execution checkpoint exists before configuration; retry creates a linked run.
    expect(resumed.body.data.retryOfRunId).toBe(id);
    expect(resumed.body.data.modelPolicy.workflow).toEqual(workflow);
    const resumedId = resumed.body.data.id;
    if (workflow.mode === "chat") await f.stopped(resumedId);
    else {
      expect((await f.rows(supervisorRuns)).map((row: any) => row.runId)).toContain(resumedId);
      expect((await f.post(`/runs/${resumedId}/cancel`)).status).toBe(201);
      const retry = await f.post(`/runs/${resumedId}/retry`);
      expect(retry.status).toBe(201);
      expect(retry.body.data.id).toBe(resumedId);
      expect(retry.body.data.modelPolicy.workflow).toEqual(workflow);
      await f.post(`/runs/${resumedId}/cancel`);
    }
    const fresh = await f.post(`/runs/${resumedId}/rerun`);
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.id).not.toBe(resumedId);
    expect(fresh.body.data.modelPolicy.workflow).toEqual(workflow);
    if (workflow.mode === "chat") await f.stopped(fresh.body.data.id);
  } finally { await f.close(); }
});

integration("mode preflight validates project, conversation, sources and permission before Jev", async () => {
  const f = await fixture();
  try {
    const foreign = crypto.randomUUID();
    for (const [body, headers] of [
      [{ ...f.input, projectId: foreign }, {}], [{ ...f.input, conversationId: foreign }, {}],
      [{ ...f.input, sourceVersionIds: [foreign] }, {}], [f.input, { "x-other-tenant": "true" }],
    ] as [unknown, Record<string, string>][]) {
      const result = await f.post("/mode-recommendation", body, headers);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.status).toBeLessThan(500);
    }
    f.d.requirePermission = () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };
    expect((await f.post("/mode-recommendation", f.input)).status).toBe(403);
    expect(f.calls().decisionCalls).toBe(0);
    expect(await f.rows(agentRuns)).toHaveLength(0);
  } finally { await f.close(); }
});

integration("mode preflight does not classify clipped conversation context", async () => {
  const f = await fixture();
  try {
    for (const [count, length, expected] of [[20, 10, "classified"], [21, 10, "context_limit"],
      [1, 2001, "context_limit"], [10, 1600, "context_limit"]] as const) {
      const [conversation] = await f.db.insert(conversations).values({ tenantId: f.d.tenantId,
        projectId: f.projectId, title: "Context bounds", createdBy: f.d.actorId }).returning();
      await f.db.insert(messages).values(Array.from({ length: count }, () => ({ tenantId: f.d.tenantId,
        conversationId: conversation!.id, authorId: f.d.actorId, actorKind: "human", body: "x".repeat(length) })));
      const result = await f.post("/mode-recommendation", { ...f.input, conversationId: conversation!.id });
      expect(result.body.data.outcome).toBe(expected);
    }
    expect(f.calls().decisionCalls).toBe(1);
    expect(await f.rows(agentRuns)).toHaveLength(0);
  } finally { await f.close(); }
});

for (const choice of ["chat", "team", "report", "calculation"] as const)
integration(`Jev mode recommendation returns standard ${choice} envelope without starting a run`, async () => {
  const f = await fixture();
  let calls = 0;
  f.d.executeDecision = async input => {
    calls++;
    expect(input.runId).toBeUndefined();
    return { status: "completed", output: { model: "jev-1.13.0", answers: { mode: { type: "choice", choice, confidence: 0.99,
      probabilities: { chat: choice === "chat" ? 0.99 : 0.0025, team: choice === "team" ? 0.99 : 0.0025,
        report: choice === "report" ? 0.99 : 0.0025, calculation: choice === "calculation" ? 0.99 : 0.0025, uncertain: 0.0025 } } } } };
  };
  try {
    const result = await f.post("/mode-recommendation", f.input);
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);
    expect(result.body.data).toMatchObject({ outcome: "classified", recommendation: choice, confidence: 0.99 });
    expect(typeof result.body.data.version).toBe("string");
    expect(calls).toBe(1);
    expect(await f.rows(agentRuns)).toHaveLength(0);
    expect(await f.rows(supervisorRuns)).toHaveLength(0);
  } finally { await f.close(); }
});

for (const scenario of ["unconfigured", "malformed", "uncertain", "failure"] as const)
integration(`mode preflight ${scenario} never starts runs or leaks provider output`, async () => {
  const f = await fixture();
  const secret = "sk-preflight-secret-raw-provider-body";
  f.d.executeDecision = async () => {
    if (scenario === "failure") throw Object.assign(new Error(secret), { providerFailure: true, failureCategory: "validation",
      diagnostics: { errorId: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", raw: secret, stack: secret } });
    if (scenario === "unconfigured") return { status: "unconfigured" };
    return { status: "completed", output: scenario === "malformed" ? { answers: secret }
      : { model: "jev-1.13.0", answers: { mode: { type: "choice", choice: "uncertain", confidence: 0.99,
        probabilities: { chat: 0.003, team: 0.003, report: 0.002, calculation: 0.002, uncertain: 0.99 } } } } };
  };
  try {
    const result = await f.post("/mode-recommendation", f.input);
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);
    expect(result.body.data.recommendation === null || result.body.data.recommendation === "uncertain").toBe(true);
    expect(typeof result.body.data.version).toBe("string");
    expect(result.body.data).toHaveProperty("outcome");
    expect(result.body.data).toHaveProperty("confidence");
    expect(await f.rows(agentRuns)).toHaveLength(0);
    expect(await f.rows(artifacts)).toHaveLength(0);
    expect(JSON.stringify([result.body, f.audits, await f.rows(agentRunSteps)])).not.toContain(secret);
    if (scenario === "failure") expect(f.audits.length).toBeGreaterThan(0);
  } finally { await f.close(); }
});

for (const choice of ["calculation", "report", "uncertain", "unconfigured"] as const)
integration(`durable ${choice} proposal requires confirmation and starts at most one scoped run`, async () => {
  const f = await fixture();
  let classifications = 0;
  f.d.estimateCallCost = () => 0.1;
  f.d.executeDecision = async () => {
    classifications++;
    return choice === "unconfigured" ? { status: "unconfigured" } : { status: "completed", output: {
      model: "jev-1.13.0", answers: { mode: { type: "choice", choice, confidence: 1,
        probabilities: Object.fromEntries(["chat", "team", "report", "calculation", "uncertain"].map(m => [m, m === choice ? 1 : 0])) } },
    } };
  };
  try {
    const [chat] = await f.db.insert(conversations).values({ tenantId: f.d.tenantId, projectId: f.projectId,
      title: "Proposed workflow", createdBy: f.d.actorId }).returning();
    const goal = choice === "report" ? "Erstelle ein Außenlärmkonzept." : "Kannst du mir einen Schallschutznachweis für dieses Projekt erstellen?";
    const [message] = await f.db.insert(messages).values({ tenantId: f.d.tenantId, conversationId: chat!.id,
      authorId: f.d.actorId, actorKind: "user", body: goal, sourceVersionIds: [f.sourceVersionId] }).returning();
    const path = `/conversations/${chat!.id}/workflow-proposals/${message!.id}`;
    const proposed = await f.post(path, { action: "propose", effort: "medium" });
    expect(proposed.status).toBe(200);
    expect(proposed.body.data.status).toBe("pending");
    expect(proposed.body.data.workflow).toEqual(choice === "calculation" ? { mode: "calculation" }
      : choice === "report" ? { mode: "report", reportTemplate: "exterior-noise-concept" } : null);
    expect((await f.post(path, { action: "propose" })).body.data.id).toBe(message!.id);
    expect(classifications).toBe(1);
    expect(await f.rows(agentRuns)).toHaveLength(0);
    expect(f.calls().providerCalls + f.calls().supervisorCalls).toBe(0);
    expect((await f.get(path)).body.data.goal).toBe(goal);
    expect((await f.get(`/conversations/${chat!.id}/workflow-proposals`)).body.data).toHaveLength(1);
    expect((await f.rows(messages)).filter(m => m.openui?.startsWith("root = WorkflowProposal("))).toHaveLength(1);
    const workflow = choice === "report" ? { mode: "report", reportTemplate: "exterior-noise-concept" } : { mode: "calculation" };
    const confirm = { action: "confirm", workflow, budget: { maxCostUsd: 3.5, maxAutomaticRetries: 1 } };
    expect((await f.post(path, confirm, { "x-other-tenant": "1" })).status).toBe(404);
    expect((await f.post(path.replace(chat!.id, crypto.randomUUID()), confirm)).status).toBe(404);
    expect((await f.post(path, { ...confirm, goal: "Forged request" })).status).toBe(400);
    expect((await f.post(path, { ...confirm, workflow: { mode: "report" } })).status).toBe(409);
    f.d.supervisorEnabled = false;
    expect((await f.post(path, confirm)).status).toBe(409);
    f.d.supervisorEnabled = true;
    await f.db.update(conversations).set({ archivedAt: new Date() }).where(eq(conversations.id, chat!.id));
    expect((await f.post(path, confirm)).status).toBe(409);
    await f.db.update(conversations).set({ archivedAt: null }).where(eq(conversations.id, chat!.id));
    const confirmed = await Promise.all([f.post(path, confirm), f.post(path, confirm)]);
    expect(confirmed.map(r => r.status)).toEqual([200, 200]);
    expect(confirmed[0]!.body.data.runId).toBe(confirmed[1]!.body.data.runId);
    const runs = await f.rows(agentRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.goal).toBe(goal);
    expect(runs[0]!.modelPolicy).toMatchObject({ workflow,
      runBudget: { maxCostUsd: 3.5, maxAutomaticRetries: 1 } });
    expect((await f.get(`/conversations/${chat!.id}/workflow-proposals`)).body.data).toHaveLength(1);
    expect((await f.get(path)).body.data).toMatchObject({ status: "confirmed", workflow });
    expect((await f.post(path, { action: "cancel" })).body.data.status).toBe("confirmed");
    expect(f.calls().providerCalls + f.calls().supervisorCalls).toBe(0);
  } finally { await f.close(); }
});

integration("cancelled proposals never execute; clear chat requests execute once without a proposal card", async () => {
  const f = await fixture();
  try {
    const [chat] = await f.db.insert(conversations).values({ tenantId: f.d.tenantId, projectId: f.projectId,
      title: "Chat routing", createdBy: f.d.actorId }).returning();
    const [message] = await f.db.insert(messages).values({ tenantId: f.d.tenantId, conversationId: chat!.id,
      authorId: f.d.actorId, actorKind: "user", body: "Explain the facade area." }).returning();
    const path = `/conversations/${chat!.id}/workflow-proposals/${message!.id}`;
    const result = await f.post(path, { action: "propose" });
    expect(result.status).toBe(200);
    expect(result.body.data.status).toBe("confirmed");
    await f.stopped(result.body.data.runId);
    expect((await f.post(path, { action: "propose" })).body.data.runId).toBe(result.body.data.runId);
    expect(f.calls().providerCalls).toBe(1);
    expect(f.calls().decisionCalls).toBe(1);
    expect((await f.rows(messages)).some(m => m.openui?.startsWith("root = WorkflowProposal("))).toBe(false);
    f.d.executeDecision = undefined;
    const [second] = await f.db.insert(messages).values({ tenantId: f.d.tenantId, conversationId: chat!.id,
      authorId: f.d.actorId, actorKind: "user", body: "Do that." }).returning();
    const pending = `/conversations/${chat!.id}/workflow-proposals/${second!.id}`;
    expect((await f.post(pending, { action: "propose" })).body.data.status).toBe("pending");
    expect((await f.post(pending, { action: "cancel" })).body.data.status).toBe("cancelled");
    expect((await f.post(pending, { action: "confirm", workflow: { mode: "chat" }, budget: {} })).body.data.status).toBe("cancelled");
    expect(await f.rows(agentRuns)).toHaveLength(1);
  } finally { await f.close(); }
});
