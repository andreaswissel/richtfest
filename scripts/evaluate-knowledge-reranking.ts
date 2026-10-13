import { eq } from "../richtfest-os/apps/api/node_modules/drizzle-orm";
import { createDatabase } from "../richtfest-os/apps/api/src/db/client";
import { callDecisionModel } from "../richtfest-os/apps/api/src/decision-runtime";
import { searchCompanyKnowledge } from "../richtfest-apps/knowledge/src/company-knowledge";
import { knowledgeRerankingVersion } from "../richtfest-apps/knowledge/src/knowledge-reranking";
import { drafts, agentRuns, agentRunAttempts, agentRunUsage, agentRunSteps } from "../richtfest-apps/knowledge/src/schema";
import type { AppDeps } from "../richtfest-apps/knowledge/src/deps";

// Synthetic retrieval challenge, not a domain-approved or representative corpus.
// Five keyword-heavy distractors deliberately outrank the useful reference in SQL.
const cases = [
  { id: "de-acoustics", term: "Schallschutz", goal: "Welche Referenz beschreibt die Messung von Trittschall im Gebäude?",
    target: "Schallschutz: Für Trittschallmessungen wird ein Norm-Hammerwerk im Senderaum betrieben und der Pegel im Empfangsraum gemessen.",
    distractor: "Schallschutz Newsletter: Einladung zum Sommerfest. Anmeldung und Essensauswahl für Mitarbeitende. Keine Messverfahren." },
  { id: "en-cost", term: "cost", goal: "Find instructions for comparing supplier quotes including delivery fees.",
    target: "Cost comparison for supplier quotes: compare net unit prices and delivery fees for equal quantities before choosing an offer.",
    distractor: "Cost centre newsletter: office party attendance list and catering choices. No procurement or supplier information." },
  { id: "de-fire", term: "Brandschutz", goal: "Welche Referenz beschreibt das Freihalten der Fluchtwege?",
    target: "Brandschutz: Fluchtwege und Notausgänge dürfen nicht durch Material oder Möbel verstellt werden. Die lichte Breite bleibt frei.",
    distractor: "Brandschutz Arbeitskreis: Mitgliederliste und Termine der Betriebsfeier. Keine Regeln zu Fluchtwegen." },
  { id: "en-access", term: "access", goal: "Find the procedure for revoking an employee's software access when they leave.",
    target: "Access offboarding: disable the departing employee account, revoke active sessions and remove application memberships on the departure date.",
    distractor: "Access road gardening schedule: hedge trimming and tree planting near the parking area. No software or account procedures." },
];
const live = process.argv.includes("--live");
if (process.argv.slice(2).some(arg => arg !== "--live")) throw new Error("Only --live is supported");
if (!live) {
  console.log(JSON.stringify({ version: knowledgeRerankingVersion, cases: cases.length,
    note: "No database/network calls. --live requires a migrated disposable local DATABASE_URL and TYPESAFE_API_KEY; sends only built-in synthetic text." }));
  process.exit(0);
}
const url = process.env.DATABASE_URL;
if (!url || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname))
  throw new Error("Use a disposable local database");
const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("TYPESAFE_API_KEY is required");
const { db, pool } = createDatabase(url);
const results = [];
try {
  for (const item of cases) {
    const tenantId = crypto.randomUUID(), actorId = crypto.randomUUID();
    let cost: number | null = null, calls = 0, failure: string | null = null;
    try {
      const rows = await db.insert(drafts).values([item.target, ...Array(5).fill(`${item.term} `.repeat(30) + item.distractor)]
        .map((body, i) => ({ tenantId, createdBy: actorId, title: `${item.term} reference ${i}`, body, status: "approved" }))).returning();
      const [run] = await db.insert(agentRuns).values({ tenantId, projectId: crypto.randomUUID(), requestedBy: actorId,
        goal: item.goal, provider: "openai", correlationId: crypto.randomUUID() }).returning();
      const d = { db, tenantId, actorId, requirePermission: () => {}, auditRun: async () => {},
        executeDecision: async input => {
          calls++;
          try {
            return await callDecisionModel({ ...input, onUsage: async usage => {
              cost = usage.estimatedCostUsd ?? null;
              await input.onUsage?.(usage);
            } }, key);
          } catch (error: any) { failure = error.failureCategory ?? "unknown"; throw error; }
        },
      } as AppDeps;
      const start = performance.now();
      const baseline = await searchCompanyKnowledge(d, { terms: [item.term] });
      const baselineMs = performance.now() - start;
      const rerankStart = performance.now();
      const ranked = await searchCompanyKnowledge(d, { terms: [item.term] }, db, false,
        { runId: run!.id, correlationId: run!.correlationId, goal: item.goal, generation: 0 });
      const name = (id: string) => id === rows[0]!.id ? "relevant" : `distractor-${rows.findIndex(r => r.id === id)}`;
      results.push({ id: item.id, baseline: baseline.entries.map(e => name(e.id)), jev: ranked.entries.map(e => name(e.id)),
        baselineRecallAt4: Number(baseline.entries.some(e => e.id === rows[0]!.id)),
        jevRecallAt4: Number(ranked.entries.some(e => e.id === rows[0]!.id)),
        baselineMs, jevMs: performance.now() - rerankStart, calls, failure, estimatedCostUsd: cost });
    } finally {
      for (const table of [agentRunSteps, agentRunUsage, agentRunAttempts, agentRuns, drafts])
        await db.delete(table).where(eq(table.tenantId, tenantId));
    }
  }
} finally { await pool.end(); }
console.log(JSON.stringify({ version: knowledgeRerankingVersion, results,
  note: "Paired synthetic SQL vs Jev retrieval only. Both return four excerpts; this does not measure downstream answer quality or LLM cost savings. Labels are provisional, not a production benchmark." }, null, 2));
