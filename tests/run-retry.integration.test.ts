import { expect, test } from "bun:test";
import express from "../richtfest-os/apps/api/node_modules/express";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { callProvider } from "../richtfest-os/apps/api/src/provider-runtime";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";
import { executeRun, runsRouter } from "../richtfest-apps/knowledge/src/runs";
import { agentRuns, agentRunSteps, agentRunAttempts, agentRunUsage, agentRunEvents, artifacts,
  artifactRevisions, conversations, messages } from "../richtfest-apps/knowledge/src/schema";

const integration = process.env.DATABASE_URL ? test : test.skip;

integration("durable retry reuses validated inference and atomic tool receipts; run again starts fresh", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const secret = "test-credential-never-persist";
  let rollbackTool = true, failFollowup = true, calls = 0;
  let instructions = "Produce a bounded review draft.";
  const d: AppDeps = {
    db, tenantId, actorId, requirePermission: () => {}, audit: async () => {},
    auditRun: async (_tx, action, _type, _id, _runId, _correlationId, metadata: any) => {
      if (action === "knowledge.agent_run.step_recorded" && metadata.kind === "tool" && rollbackTool) {
        rollbackTool = false;
        throw new Error("Simulated transaction failure after artifact creation");
      }
    },
    validateProject: async () => true, validateSource: async () => true, validateSourceVersion: async () => true,
    validateUser: async () => true, validateConversation: async () => true, cancelExecution: () => {},
    providerConfigured: async () => true, sourceReferences: async () => [], resolveSource: async () => ({}),
    listProjectSources: async () => ({ sources: [], truncated: false, authority: "unreviewed_source_inventory" }),
    componentContext: async () => ({ status: "available", items: [], truncated: false }),
    executeProvider: async input => ({ status: "completed", output: await callProvider({ ...input,
      context: { ...(input.context as object), credentialEcho: secret },
      systemInstructions: instructions, includeOpenUI: false,
    }, secret, async (_url, init) => {
      calls++;
      const prompt = JSON.parse(JSON.parse(String(init.body)).input);
      expect(prompt.context.componentCatalog).toEqual({ status: "available", items: [], truncated: false });
      if (prompt.toolResults.length && failFollowup) return new Response("sensitive upstream failure", { status: 500 });
      const output = prompt.toolResults.length
        ? { summary: "Draft and question saved once.", rationale: "Human review required.", citations: [], tools: [] }
        : { summary: `Preparing work ${secret}`, rationale: "Unreviewed proposal.", citations: [], tools: [
          { name: "create_draft", input: { title: "Review draft", content: "Source-linked proposal awaiting review." } },
          { name: "ask_missing_input", input: { question: "Which scope should be confirmed?" } },
        ] };
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
    }) }),
  };
  const server = express().use(express.json()).use(runsRouter(req => ({ ...d,
    tenantId: req.headers["x-other-tenant"] ? crypto.randomUUID() : tenantId,
  }))).use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message })).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body = {}) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const stopped = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Run did not stop");
  };
  try {
    const [thread] = await db.insert(conversations).values({ tenantId, projectId, title: "Retry test", createdBy: actorId }).returning();
    const created = await post("/runs", { projectId, conversationId: thread!.id, goal: "Prepare a review" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await stopped(id)).status).toBe("failed");
    expect(calls).toBe(1);
    expect(await db.select().from(artifacts).where(eq(artifacts.runId, id))).toHaveLength(0);
    const initialSteps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, id));
    const initialOutput = initialSteps.find(step => step.status === "completed")!;
    expect(initialOutput.output).toMatchObject({ summary: "Preparing work [redacted]" });
    expect(JSON.stringify(initialSteps)).not.toContain(secret);
    expect((initialOutput.input as any).instructions).toBe(instructions);
    expect(JSON.parse((initialOutput.input as any).prompt).goal).toBe("Prepare a review");
    expect(JSON.parse((initialOutput.input as any).prompt).context.credentialEcho).toBe("[redacted]");

    const retried = await post(`/runs/${id}/retry`);
    expect(retried.status).toBe(201);
    expect(retried.body.data.id).toBe(id);
    expect((await stopped(id)).status).toBe("failed");
    expect(calls).toBe(2); // Only the follow-up made a new network request.
    expect(await db.select().from(artifacts).where(eq(artifacts.runId, id))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.runId, id))).toHaveLength(1);

    failFollowup = false;
    expect((await post(`/runs/${id}/retry`)).status).toBe(201);
    expect((await stopped(id)).status).toBe("needs_review");
    expect(calls).toBe(3);
    expect(await db.select().from(artifacts).where(eq(artifacts.runId, id))).toHaveLength(1);
    const written = await db.select().from(messages).where(eq(messages.runId, id));
    expect(written.map(row => row.body).sort()).toEqual(["Draft and question saved once.", "Which scope should be confirmed?"]);
    const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, id));
    expect(steps.filter(step => step.kind === "tool" && step.status === "reused")).toHaveLength(2);
    expect(steps.filter(step => step.kind === "model" && step.status === "reused")).toHaveLength(2);
    expect(steps.find(step => step.id === initialOutput.id)).toEqual(initialOutput);
    expect((await post(`/runs/${id}/retry`)).status).toBe(409);

    const index = await (await fetch(`${base}/runs/${id}/steps`)).json() as any;
    expect(index.data).toHaveLength(steps.length);
    expect(index.data[0].input).toBeUndefined();
    const detail = await (await fetch(`${base}/runs/${id}/steps/${initialOutput.id}`)).json() as any;
    expect(detail.data.output.summary).toBe("Preparing work [redacted]");
    expect((await fetch(`${base}/runs/${id}/steps/${initialOutput.id}`, { headers: { "x-other-tenant": "true" } })).status).toBe(404);

    rollbackTool = true;
    const fresh = await post(`/runs/${id}/rerun`);
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.id).not.toBe(id);
    expect(fresh.body.data.retryOfRunId).toBe(id);
    expect((await stopped(fresh.body.data.id)).status).toBe("failed");
    expect(calls).toBe(4);

    // Changed instructions must miss even this run's saved successful inference.
    instructions = "Produce a bounded review draft. Preserve missing scope explicitly.";
    expect((await post(`/runs/${fresh.body.data.id}/retry`)).status).toBe(201);
    expect((await stopped(fresh.body.data.id)).status).toBe("needs_review");
    expect(calls).toBe(6);
    expect(await db.select().from(artifacts).where(eq(artifacts.tenantId, tenantId))).toHaveLength(2);

    // Cancelling an already completed draft must not resume finalization and
    // append a second result to the same run; this is a new reviewed attempt.
    expect((await post(`/runs/${id}/cancel`)).status).toBe(201);
    const afterCompletion = await post(`/runs/${id}/retry`);
    expect(afterCompletion.status).toBe(201);
    expect(afterCompletion.body.data.id).not.toBe(id);
    expect((await stopped(afterCompletion.body.data.id)).status).toBe("needs_review");
    expect(await db.select().from(artifacts).where(eq(artifacts.runId, id))).toHaveLength(1);
  } finally {
    server.close();
    for (const table of [agentRunSteps, agentRunAttempts, agentRunUsage, agentRunEvents, artifactRevisions, artifacts, messages, conversations, agentRuns])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
}, 15000);

integration("cancelled direct execution cannot overwrite or duplicate its resumed generation", async () => {
  const { db, pool } = createDatabase(process.env.DATABASE_URL!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const late = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let calls = 0, permitted = true;
  const d = {
    db, tenantId, actorId, requirePermission: () => { if (!permitted) throw Object.assign(new Error("Forbidden"), { status: 403 }); },
    audit: async () => {}, auditRun: async () => {}, validateProject: async () => true,
    validateSourceVersion: async () => true, providerConfigured: async () => true, cancelExecution: () => {},
    listProjectSources: async () => ({ sources: [], truncated: false }),
    executeProvider: async () => {
      const first = ++calls === 1;
      if (first) { entered.resolve(); await late.promise; }
      return { status: "completed", output: { summary: first ? "Stale result" : "Resumed result", rationale: "Draft only", citations: [], tools: [],
        artifact: { title: "Deliverable", content: first ? "Stale draft" : "Resumed draft", type: "draft" } } };
    },
  } as unknown as AppDeps;
  const server = express().use(express.json()).use(runsRouter(() => d))
    .use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 500).json({ error: e.message })).listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let pending: Promise<void> | undefined;
  try {
    const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), goal: "Resume safely",
      provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID(), checkpointVersion: 1 }).returning();
    pending = executeRun(d, run);
    await entered.promise;
    expect((await fetch(`${base}/runs/${run!.id}/retry`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`${base}/runs/${run!.id}/cancel`, { method: "POST" })).status).toBe(201);
    permitted = false;
    expect((await fetch(`${base}/runs/${run!.id}/retry`, { method: "POST" })).status).toBe(403);
    permitted = true;
    expect((await fetch(`${base}/runs/${run!.id}/retry`, { method: "POST" })).status).toBe(201);
    for (let i = 0; i < 200; i++) {
      const [current] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
      if (current!.status === "needs_review") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    late.resolve();
    await pending;
    const [result] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(result).toMatchObject({ generation: 1, status: "needs_review", outputSummary: "Resumed result" });
    const revisions = await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, tenantId));
    expect(revisions.map(row => row.content)).toEqual(["Resumed draft"]);
  } finally {
    late.resolve();
    await pending;
    server.close();
    for (const table of [agentRunSteps, agentRunAttempts, agentRunEvents, artifactRevisions, artifacts, agentRuns])
      await db.delete(table).where(eq(table.tenantId, tenantId));
    await pool.end();
  }
});
