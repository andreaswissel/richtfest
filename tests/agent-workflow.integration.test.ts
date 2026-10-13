import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";
import { runsRouter } from "../richtfest-apps/knowledge/src/runs";
import { stepSupervisor } from "../richtfest-apps/knowledge/src/supervisor";
import { agentRuns, agentRunSteps, agentRunAttempts, agentRunUsage, agentRunEvents,
  supervisorRuns, tasks, artifacts, artifactRevisions, annotations, conversations, messages, drafts } from "../richtfest-apps/knowledge/src/schema";
import { agentPresetSnapshotSchema } from "../richtfest-shared/src/agent-policy";

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
        probabilities: { chat: 0.99, team: 0.004, report: 0.004, uncertain: 0.002 } } },
    } }; },
  };
  const server = express().use(express.json()).use(runsRouter(req => ({ ...d,
    tenantId: req.headers["x-other-tenant"] ? crypto.randomUUID() : tenantId,
    validateProject: req.headers["x-other-tenant"] ? async () => false : d.validateProject,
  }))).use((error: any, _req: any, res: any, _next: any) =>
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
    for (const workflow of [{ mode: "team" }, { mode: "report", reportTemplate: templates[0] }]) {
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

for (const workflow of [{ mode: "chat" }, { mode: "team" }, ...templates.map(reportTemplate => ({ mode: "report", reportTemplate }))])
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

for (const choice of ["chat", "team", "report"] as const)
integration(`Jev mode recommendation returns standard ${choice} envelope without starting a run`, async () => {
  const f = await fixture();
  let calls = 0;
  f.d.executeDecision = async input => {
    calls++;
    expect(input.runId).toBeUndefined();
    return { status: "completed", output: { model: "jev-1.13.0", answers: { mode: { type: "choice", choice, confidence: 0.99,
      probabilities: { chat: choice === "chat" ? 0.99 : 0.003, team: choice === "team" ? 0.99 : 0.003,
        report: choice === "report" ? 0.99 : 0.003, uncertain: 0.004 } } } } };
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
        probabilities: { chat: 0.003, team: 0.003, report: 0.004, uncertain: 0.99 } } } } };
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
