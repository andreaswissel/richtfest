import { expect, test } from "bun:test";
import express from "express";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "./db/client";
import { agentPresets, auditEvents } from "./db/schema";
import { createAgentPresetsRouter, vendorPreset } from "./agent-presets";

// Explicit local-only opt-in: never write to a deployed database during verification.
const url = process.env.AGENT_PRESET_TEST_DATABASE_URL;
const integration = url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname) ? test : test.skip;
integration("output limit endpoint patches only one role, rejects stale/unauthorized changes and caps output", async () => {
  const { db, pool } = createDatabase(url!);
  const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
  const config = vendorPreset("openai", "medium");
  config.specialists.source_reviewer = { ...config.specialists.source_reviewer, maxOutputTokens: 70000, reasoningEffort: "high" };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { id: actorId, tenantId, permissions: new Set(req.headers["x-manage"] === "yes" ? ["access:manage"] : []) };
    next();
  });
  app.use(createAgentPresetsRouter(db));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.code, message: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const body = { role: "source_reviewer", expectedVersion: 4, expectedModelId: config.specialists.source_reviewer.modelId, expectedMaxOutputTokens: 70000 };
  const patch = (payload = body, manage = true) => fetch(`http://127.0.0.1:${port}/agent/presets/openai/medium/output-limit`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-manage": manage ? "yes" : "no" }, body: JSON.stringify(payload) });
  try {
    await db.insert(agentPresets).values({ tenantId, provider: "openai", effort: "medium", config, version: 4, updatedBy: actorId });
    expect((await patch(body, false)).status).toBe(403);
    expect((await patch({ ...body, expectedVersion: 3 })).status).toBe(409);
    expect((await patch({ ...body, expectedModelId: "changed-model" })).status).toBe(409);
    expect((await patch({ ...body, expectedMaxOutputTokens: 80000 })).status).toBe(409);
    const response = await patch();
    expect(response.status).toBe(200);
    const [row] = await db.select().from(agentPresets).where(eq(agentPresets.tenantId, tenantId));
    expect(row.version).toBe(5);
    expect(row.config).toEqual({ ...config, specialists: { ...config.specialists, source_reviewer: { ...config.specialists.source_reviewer, maxOutputTokens: 128000 } } });
    expect((await patch()).status).toBe(409);
    expect((await patch({ ...body, expectedVersion: 5, expectedMaxOutputTokens: 128000 })).status).toBe(409);
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId));
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("agent.preset.updated");
    // The router has no run execution dependency: this operation writes only preset + audit.
    const supervisorBody = { ...body, role: "supervisor", expectedVersion: 5, expectedMaxOutputTokens: config.supervisor.maxOutputTokens };
    const concurrent = await Promise.all([patch(supervisorBody), patch(supervisorBody)]);
    expect(concurrent.map(item => item.status).sort()).toEqual([200, 409]);
    const [afterConcurrent] = await db.select().from(agentPresets).where(eq(agentPresets.tenantId, tenantId));
    expect(afterConcurrent.version).toBe(6);
    expect((afterConcurrent.config as any).supervisor).toEqual({ ...config.supervisor, maxOutputTokens: config.supervisor.maxOutputTokens * 2 });
    expect((afterConcurrent.config as any).specialists).toEqual((row.config as any).specialists);
    // An absent vendor row is safely materialized only by a successful transaction.
    await db.delete(agentPresets).where(eq(agentPresets.tenantId, tenantId));
    expect((await patch({ ...supervisorBody, expectedVersion: 2 })).status).toBe(409);
    expect(await db.select().from(agentPresets).where(eq(agentPresets.tenantId, tenantId))).toHaveLength(0);
    expect((await patch({ ...supervisorBody, expectedVersion: 1 })).status).toBe(200);
    const [vendorSaved] = await db.select().from(agentPresets).where(eq(agentPresets.tenantId, tenantId));
    const vendor = vendorPreset("openai", "medium");
    expect(vendorSaved.config).toEqual({ ...vendor, supervisor: { ...vendor.supervisor, maxOutputTokens: vendor.supervisor.maxOutputTokens * 2 } });
    const runs = await db.execute(sql`select id from knowledge_agent_runs where tenant_id = ${tenantId}`);
    expect(runs.rows).toHaveLength(0);
  } finally {
    await db.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
    await db.delete(agentPresets).where(eq(agentPresets.tenantId, tenantId));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
  }
});
