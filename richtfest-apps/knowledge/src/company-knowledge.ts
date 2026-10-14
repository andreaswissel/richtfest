import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { companyKnowledgeSearchSchema, companyKnowledgeResultSchema, type CompanyKnowledgeReceipt } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { drafts, knowledgeCategories } from "./schema";
import { retrieveCompanyEntries } from "./company-library";
import { conflict } from "./workspace";
import { executeTrackedProvider } from "./usage";
import { knowledgeRelevanceQuestions, knowledgeRerankingVersion, rankCompanyKnowledge } from "./knowledge-reranking";

// Two <=48 KB results, an <=8 KiB category directory, plus receipt IDs and
// tool schema. Keep the existing reserve instead of shrinking source batches.
export const COMPANY_KNOWLEDGE_CONTEXT_BYTES = 112000;

/** Discovery in context avoids spending a specialist step just to find IDs. */
export async function companyKnowledgeCategories(d: AppDeps) {
  try { d.requirePermission("knowledge:read"); } catch { return undefined; }
  const categories = await d.db.select({ id: knowledgeCategories.id,
    name: sql<string>`left(${knowledgeCategories.name}, 100)`,
  }).from(knowledgeCategories).where(eq(knowledgeCategories.tenantId, d.tenantId))
    .orderBy(knowledgeCategories.name, knowledgeCategories.id).limit(101);
  const directory = { categories: categories.slice(0, 100), truncated: categories.length > 100 };
  while (Buffer.byteLength(JSON.stringify(directory), "utf8") > 8192) {
    directory.categories.pop();
    directory.truncated = true;
  }
  return directory;
}

export async function searchCompanyKnowledge(d: AppDeps, raw: unknown, db = d.db, limitReached = false,
  rerank?: { runId: string; correlationId: string; goal: string; generation: number; signal?: AbortSignal; rootRunId?: string; leaseToken?: string; assertActive?: () => Promise<void> },
) {
  d.requirePermission("knowledge:read");
  rerank?.signal?.throwIfAborted();
  const { terms, category } = companyKnowledgeSearchSchema.parse(raw);
  const canRerank = !!rerank && !!d.executeDecision && !limitReached && rerank.goal.length <= 2000;
  let entries = limitReached ? [] : (await retrieveCompanyEntries(d, { category: category ?? "all", status: "approved" }, terms, canRerank ? 12 : 4, 2000, db)).entries
    .map((entry: any) => ({ ...entry, categoryName: entry.categoryName?.slice(0, 100) ?? null,
      displayTitle: entry.displayTitle?.slice(0, 300) ?? null, sourceLabel: entry.sourceLabel?.slice(0, 300) ?? null,
      chapter: entry.chapter?.slice(0, 300) ?? null }));
  if (canRerank && entries.length > 4) {
    // Check authorization again immediately before exporting approved excerpts.
    // This function is only called outside the supervisor checkpoint transaction.
    await assertCompanyKnowledgeCurrent(d, [{ entries }], db);
    rerank!.signal?.throwIfAborted();
    try {
      const result = await executeTrackedProvider(d, { id: rerank!.runId, correlationId: rerank!.correlationId, provider: "typesafe" },
        { phase: "knowledge_rerank", generation: rerank!.generation, rootRunId: rerank!.rootRunId,
          leaseToken: rerank!.leaseToken, assertActive: rerank!.assertActive }, telemetry => d.executeDecision!({
          ...telemetry, runId: rerank!.runId, signal: rerank!.signal,
          state: { version: knowledgeRerankingVersion, goal: rerank!.goal, terms,
            candidates: entries.map(({ id, title, excerpt }: CompanyKnowledgeReceipt["entries"][number]) => ({ id, title, excerpt })) },
          questions: knowledgeRelevanceQuestions(entries),
        }));
      if (result.status === "completed") entries = rankCompanyKnowledge(entries, result.output).entries;
    } catch (error) {
      if (["budget_exhausted", "outcome_unknown"].includes(String((error as { code?: unknown })?.code))) throw error;
      // Failed/invalid decisions keep the identical deterministic top four.
      // Attempts and any reported usage remain in the run ledger.
    }
    rerank!.signal?.throwIfAborted();
  }
  entries = entries.slice(0, 4);
  const result = companyKnowledgeResultSchema.parse({ terms, category, entries,
    status: limitReached ? "limit_reached" : entries.length ? "matched" : "no_matches",
    coverage: { limited: true, maxEntries: 4, maxCharsPerEntry: 2000 },
  });
  // Unusual escaping/labels must not exceed the reserved tool context. Keep
  // higher-ranked exact excerpts, rather than cutting text inside an entry.
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 48000 && result.entries.length) result.entries.pop();
  if (result.status === "matched" && !result.entries.length) result.status = "no_matches";
  return result;
}

/** Historical receipts remain in the ledger, but revoked/edited content cannot silently resume. */
export async function assertCompanyKnowledgeCurrent(d: AppDeps, receipts: Pick<CompanyKnowledgeReceipt, "entries">[], db = d.db) {
  if (!receipts.length) return;
  d.requirePermission("knowledge:read");
  const entries = receipts.flatMap(r => r.entries);
  if (!entries.length) return;
  const current = await db.select({ id: drafts.id, title: drafts.title, body: drafts.body }).from(drafts).where(and(
    eq(drafts.tenantId, d.tenantId), isNull(drafts.projectId), eq(drafts.status, "approved"),
    inArray(drafts.id, entries.map(e => e.id)),
  ));
  for (const entry of entries) {
    const row = current.find((r: any) => r.id === entry.id);
    if (!row || row.title !== entry.title || createHash("sha256").update(row.body).digest("hex") !== entry.bodyHash)
      throw conflict("Retrieved company knowledge changed or is no longer approved. Start a new run to review current references.");
  }
}
