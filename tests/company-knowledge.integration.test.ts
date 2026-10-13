import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";
import { executeRun, validateTool, assertEvidenceCitations } from "../richtfest-apps/knowledge/src/runs";
import { createSupervisor, stepSupervisor } from "../richtfest-apps/knowledge/src/supervisor";
import { drafts, agentRuns, supervisorRuns, agentRunSteps, agentRunAttempts, agentRunUsage, agentRunEvents,
  tasks, messages, artifacts, artifactRevisions } from "../richtfest-apps/knowledge/src/schema";

const url = process.env.DATABASE_URL;
const integration = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ? test : test.skip;
async function fixture() {
  const connection = new URL(url!);
  const applicationName = `knowledge_test_${crypto.randomUUID()}`;
  connection.searchParams.set("application_name", applicationName);
  const { db, pool } = createDatabase(connection.href);
  const tenantId = crypto.randomUUID(), otherTenant = crypto.randomUUID(), actorId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const body = "Schallschutz: Mindestanforderungen sind kein vereinbarter erhöhter Schutz. Ausgabe 2022, Seite 17. Keine Projektprüfung.";
  const rows = await db.insert(drafts).values([
    { tenantId, title: "Approved acoustics reference", body, status: "approved", createdBy: actorId, approvedBy: actorId, approvedAt: new Date() },
    { tenantId, title: "Draft must stay private", body, status: "draft", createdBy: actorId },
    { tenantId, projectId, title: "Project draft is not company knowledge", body, status: "approved", createdBy: actorId },
    { tenantId: otherTenant, title: "Other tenant", body, status: "approved", createdBy: actorId },
  ]).returning();
  let permitted = true;
  const audits: string[] = [];
  const d: AppDeps = {
    db, tenantId, actorId, requirePermission: key => { if (!permitted && key === "knowledge:read") throw new Error("Forbidden"); },
    audit: async () => {}, auditRun: async (_tx, action) => { audits.push(action); },
    validateProject: async () => true, validateSource: async () => true, validateSourceVersion: async () => true,
    validateUser: async () => true, validateConversation: async () => true, cancelExecution: () => {},
    providerConfigured: async () => true, sourceReferences: async () => [], resolveSource: async () => ({}),
    listProjectSources: async () => ({ sources: [], truncated: false, authority: "unreviewed_source_inventory" }),
    executeProvider: async () => { throw new Error("Unexpected provider call"); },
  };
  const createRun = async () => (await db.insert(agentRuns).values({ tenantId, projectId, goal: "Review Schallschutz references",
    provider: "openai", requestedBy: actorId, correlationId: crypto.randomUUID(), checkpointVersion: 1 }).returning())[0]!;
  const cleanup = async () => {
    for (const tenant of [tenantId, otherTenant])
      for (const table of [agentRunSteps, agentRunAttempts, agentRunUsage, agentRunEvents, supervisorRuns, messages, artifactRevisions, artifacts, tasks, agentRuns, drafts])
        await db.delete(table).where(eq(table.tenantId, tenant));
    await pool.end();
  };
  return { db, pool, applicationName, d, body, rows, createRun, cleanup, audits, deny: () => { permitted = false; } };
}

integration("direct company retrieval is approved-only, scoped, audited and re-read on retry", async () => {
  const f = await fixture();
  const { db, d, rows, body } = f;
  let failFollowup = true;
  const results: any[] = [];
  try {
    const run = await f.createRun();
    d.executeProvider = async input => {
      if (!input.toolResults?.length) return { status: "completed", output: { summary: "Check guidance", rationale: "", citations: [],
        tools: [{ name: "search_company_knowledge", input: { terms: ["Schallschutz"] } }] } };
      const result = (input.toolResults[0] as any).result;
      results.push(result);
      if (failFollowup) throw new Error("Interrupted after retrieval");
      return { status: "completed", output: { summary: "No currently approved match; no conclusion about absent guidance.", rationale: "Bounded search", citations: [], tools: [] } };
    };
    await executeRun(d, run);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)))[0]!.status).toBe("failed");
    expect(results[0].entries).toEqual([{ id: rows[0]!.id, title: rows[0]!.title, status: "approved", excerpt: body,
      bodyHash: createHash("sha256").update(body).digest("hex") }]);
    expect(results[0].coverage.limited).toBe(true);
    expect(() => assertEvidenceCitations({ citations: [rows[0]!.id] }, new Set())).toThrow("not supplied");
    expect(() => validateTool("search_company_knowledge", { terms: ["Schallschutz"], status: "draft" })).toThrow();
    expect(() => validateTool("search_company_knowledge", { terms: ["Schallschutz"], tenantId: rows[3]!.tenantId })).toThrow();
    const [receipt] = await db.select().from(agentRunSteps).where(eq(agentRunSteps.id, results[0].receiptId));
    expect(receipt!.output).toMatchObject({ entries: results[0].entries });
    expect(f.audits).toContain("knowledge.agent_run.step_recorded");

    const [same] = await db.update(agentRuns).set({ status: "queued", generation: 1, error: null }).where(eq(agentRuns.id, run.id)).returning();
    await executeRun(d, same!);
    expect(results[1]).toEqual(results[0]); // rechecked reads preserve checkpoint identity
    await db.update(drafts).set({ status: "draft" }).where(eq(drafts.id, rows[0]!.id));
    failFollowup = false;
    const [retried] = await db.update(agentRuns).set({ status: "queued", generation: 2, error: null }).where(eq(agentRuns.id, run.id)).returning();
    await executeRun(d, retried!);
    expect(results[2]).toMatchObject({ status: "no_matches", entries: [] });
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)))[0]!.status).toBe("needs_review");
    expect((await db.select().from(agentRunSteps).where(eq(agentRunSteps.id, receipt!.id)))[0]!.output).toEqual(receipt!.output);
    const longBody = "Unrelated introduction. ".repeat(800) + "Schallschutz " + "Fachplaneranforderungen ".repeat(500);
    const eligible = await db.insert(drafts).values(Array.from({ length: 5 }, (_, index) => ({
      tenantId: d.tenantId, createdBy: d.actorId, title: `Additional reference ${index}`, body: longBody, status: "approved",
    }))).returning();
    await executeRun(d, await f.createRun());
    expect(results[3].entries).toHaveLength(4);
    for (const entry of results[3].entries) {
      expect(eligible.some(row => row.id === entry.id)).toBe(true);
      expect(entry.excerpt.length).toBeLessThanOrEqual(2000);
      expect(entry.excerpt).toContain("Schallschutz");
      expect(entry.body).toBeUndefined();
    }
    f.deny();
    await executeRun(d, await f.createRun());
    expect(results).toHaveLength(4);
  } finally { await f.cleanup(); }
});

integration("specialist knowledge receipts reach synthesis and independent review; changed references cannot resume", async () => {
  const f = await fixture();
  const { db, d, rows } = f;
  const versionId = crypto.randomUUID();
  const model = { modelId: "test-model", maxOutputTokens: 2048, maxSteps: 4 };
  const received: any[] = [];
  let receipt: any;
  let interruptOnce = true;
  d.resolveSource = async () => ({ status: "resolved", source: { versionId, name: "Project specification", version: 1 },
    content: { status: "available", text: "The project has not agreed an increased protection target." } });
  d.executeSupervisor = async input => {
    const context = input.context as any;
    if (input.phase === "plan") return { status: "completed", output: { tasks: [{ role: "source_reviewer", goal: "Schallschutz", sourceVersionIds: [versionId] }] } };
    if (input.phase === "specialist") {
      expect(input.searchCompanyKnowledge).toBeDefined();
      const result = await input.searchCompanyKnowledge!({ terms: ["Schallschutz"] });
      receipt = result.status === "already_retrieved" ? context.companyKnowledge.find((r: any) => r.receiptId === result.receiptId) : result;
      expect(receipt.entries[0].id).toBe(rows[0]!.id);
      expect(await input.searchCompanyKnowledge!({ terms: ["Schallschutz"] })).toMatchObject({ status: "already_retrieved", receiptId: receipt.receiptId, entries: [] });
      if (interruptOnce) {
        interruptOnce = false;
        throw Object.assign(new Error("Interrupted after saved retrieval"), { providerFailure: true, retryable: true, providerStatus: 503 });
      }
      expect(await input.searchCompanyKnowledge!({ terms: ["Quantenbanane"] })).toMatchObject({ status: "no_matches", entries: [] });
      expect(await input.searchCompanyKnowledge!({ terms: ["Brandschutz"] })).toMatchObject({ status: "limit_reached", entries: [] });
      return { status: "completed", output: { summary: "Approved acoustics reference distinguishes minimum and agreed protection; project target remains open.", rationale: "Company guidance, not project evidence.", citations: [versionId] } };
    }
    received.push({ phase: input.phase, receipts: context.companyKnowledge });
    expect(input.searchCompanyKnowledge).toBeUndefined();
    return { status: "completed", output: { summary: "Target requires agreement.", rationale: "Reference is not project evidence.", citations: [versionId], decision: "accept", revisions: [],
      ...(input.phase === "review" ? { document: { title: "Protection target", content: `Approved acoustics reference distinguishes protection targets. The project has not agreed increased protection [${versionId}].` } } : { findings: [] }),
    } };
  };
  const start = async () => {
    const run = await f.createRun();
    run.sourceVersionIds = [versionId];
    await db.update(agentRuns).set({ sourceVersionIds: [versionId] }).where(eq(agentRuns.id, run.id));
    await createSupervisor(d, db, run, "medium", { provider: "openai", effort: "medium", source: "vendor", version: 1,
      supervisor: model, specialists: { source_reviewer: model, requirements_reviewer: model }, maxParallel: 2, maxTasks: 4, maxRevisions: 1, independentReviewEnabled: true });
    await stepSupervisor(d, run.id); // plan
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)))[0]).toMatchObject({ status: "running" });
    await stepSupervisor(d, run.id); // specialist + receipts
    return run;
  };
  try {
    const run = await start();
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run.id));
    expect((state!.assignments as any[])[0].companyKnowledge[0]).toEqual(receipt);
    expect((state!.history as any[]).find(h => h.phase === "specialist_batch").companyKnowledge[0]).toEqual(receipt);
    await stepSupervisor(d, run.id);
    await stepSupervisor(d, run.id);
    expect(received.map(r => r.phase)).toEqual(["review", "independent_review"]);
    expect(received.every(r => r.receipts[0].entries[0].id === rows[0]!.id)).toBe(true);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)))[0]!.status).toBe("needs_review");
    const [document] = await db.select().from(artifactRevisions).where(eq(artifactRevisions.tenantId, d.tenantId));
    expect(document!.content).toContain("Approved acoustics reference");
    expect(document!.content).not.toContain(rows[0]!.id);

    const stale = await start();
    await db.update(drafts).set({ body: "Schallschutz: changed after specialist retrieval" }).where(eq(drafts.id, rows[0]!.id));
    await stepSupervisor(d, stale.id);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, stale.id)))[0]!.status).toBe("failed");
    expect(received).toHaveLength(2); // no synthesis of outdated reference snapshots
  } finally { await f.cleanup(); }
});

for (const outcome of ["complete", "cancel", "withdraw"] as const) integration(`sibling knowledge reads overlap without losing limits or fencing: ${outcome}`, async () => {
  const f = await fixture();
  const { db, pool, d } = f;
  const model = { modelId: "test-model", maxOutputTokens: 2048, maxSteps: 4 };
  const gate = await pool.connect();
  let rootGate: Awaited<ReturnType<typeof pool.connect>> | undefined;
  let advancing: Promise<void> | undefined;
  const waitForBlocked = async (fragment: string, count: number) => {
    let observed = 0;
    for (let i = 0; i < 100; i++) {
      const result = await pool.query("select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like $2", [f.applicationName, `%${fragment}%`]);
      observed = result.rows[0].count;
      if (observed >= count) break;
      await Bun.sleep(20);
    }
    expect(observed).toBeGreaterThanOrEqual(count);
  };
  const results: any[] = [];
  d.executeSupervisor = async input => {
    if (input.phase === "plan") return { status: "completed", output: { tasks: ["source_reviewer", "requirements_reviewer"].map(role => ({ role, goal: "Review company guidance", sourceVersionIds: [] })) } };
    const duplicates = await Promise.all([1, 2].map(() => input.searchCompanyKnowledge!({ terms: ["Schallschutz"] })));
    expect(duplicates.map(r => r.status).sort()).toEqual(["already_retrieved", "matched"]);
    expect(duplicates[0]!.receiptId).toBe(duplicates[1]!.receiptId);
    // Race two different queries for the assignment's one remaining slot.
    const remaining = await Promise.all(["Mindestanforderungen", "Schutz"].map(term => input.searchCompanyKnowledge!({ terms: [term] })));
    expect(remaining.map(r => r.status).sort()).toEqual(["limit_reached", "matched"]);
    results.push(...duplicates, ...remaining);
    return { status: "completed", output: { summary: "Company guidance remains separate from project evidence.", rationale: "Bounded retrieval", citations: [] } };
  };
  try {
    const run = await f.createRun();
    await createSupervisor(d, db, run, "medium", { provider: "openai", effort: "medium", source: "vendor", version: 1,
      supervisor: model, specialists: { source_reviewer: model, requirements_reviewer: model }, maxParallel: 2, maxTasks: 4, maxRevisions: 1 });
    await stepSupervisor(d, run.id);
    // Hold only the knowledge table: every independent SELECT should reach
    // this gate, rather than holding the parent's checkpoint lock while waiting.
    await gate.query("begin; lock table knowledge_drafts in access exclusive mode");
    advancing = stepSupervisor(d, run.id);
    await waitForBlocked("ts_headline", 4);
    if (outcome === "cancel") {
      await db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, run.id));
    } else if (outcome === "withdraw") {
      rootGate = await pool.connect();
      await rootGate.query("begin");
      await rootGate.query("select id from knowledge_agent_runs where id=$1 for update", [run.id]);
    }
    await gate.query("commit");
    if (rootGate) {
      // Searches have read approved text, but cannot commit their receipts yet.
      await waitForBlocked("knowledge_agent_runs", 4);
      await db.update(drafts).set({ status: "draft" }).where(eq(drafts.id, f.rows[0]!.id));
      await rootGate.query("commit");
    }
    await advancing;
    const [state] = await db.select().from(supervisorRuns).where(eq(supervisorRuns.runId, run.id));
    const receipts = (state!.assignments as any[]).flatMap(a => a.companyKnowledge ?? []);
    if (outcome === "complete") {
      expect(results).toHaveLength(8);
      expect(receipts).toHaveLength(4);
      expect((state!.assignments as any[]).every(a => a.companyKnowledge.length === 2)).toBe(true);
      expect(receipts.every(r => r.entries[0].id === f.rows[0]!.id)).toBe(true);
    } else {
      expect(results).toHaveLength(0);
      expect(receipts).toHaveLength(0);
      expect((await db.select().from(agentRunSteps).where(eq(agentRunSteps.tenantId, d.tenantId))).filter(r => r.kind === "tool")).toHaveLength(0);
      expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run.id)))[0]!.status).toBe(outcome === "cancel" ? "cancelled" : "failed");
    }
  } finally {
    await gate.query("rollback");
    gate.release();
    if (rootGate) { await rootGate.query("rollback"); rootGate.release(); }
    await advancing;
    await f.cleanup();
  }
}, 15000);
