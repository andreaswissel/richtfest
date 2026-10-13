import { and, eq, inArray, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { companyKnowledgeSearchSchema, companyKnowledgeResultSchema, type CompanyKnowledgeReceipt } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { drafts } from "./schema";
import { retrieveCompanyEntries } from "./company-library";
import { conflict } from "./workspace";

// Two searches, each with four 2,000-character excerpts, plus JSON escaping,
// identifiers and tool schema. Reserve this even before the first tool call.
export const COMPANY_KNOWLEDGE_CONTEXT_BYTES = 112000;

export async function searchCompanyKnowledge(d: AppDeps, raw: unknown, db = d.db, limitReached = false) {
  d.requirePermission("knowledge:read");
  const { terms } = companyKnowledgeSearchSchema.parse(raw);
  const entries = limitReached ? [] : (await retrieveCompanyEntries(d, { category: "all", status: "approved" }, terms, 4, 2000, db)).entries;
  return companyKnowledgeResultSchema.parse({ terms, entries,
    status: limitReached ? "limit_reached" : entries.length ? "matched" : "no_matches",
    coverage: { limited: true, maxEntries: 4, maxCharsPerEntry: 2000 },
  });
}

/** Historical receipts remain in the ledger, but revoked/edited content cannot silently resume. */
export async function assertCompanyKnowledgeCurrent(d: AppDeps, receipts: CompanyKnowledgeReceipt[]) {
  if (!receipts.length) return;
  d.requirePermission("knowledge:read");
  const entries = receipts.flatMap(r => r.entries);
  if (!entries.length) return;
  const current = await d.db.select({ id: drafts.id, title: drafts.title, body: drafts.body }).from(drafts).where(and(
    eq(drafts.tenantId, d.tenantId), isNull(drafts.projectId), eq(drafts.status, "approved"),
    inArray(drafts.id, entries.map(e => e.id)),
  ));
  for (const entry of entries) {
    const row = current.find((r: any) => r.id === entry.id);
    if (!row || row.title !== entry.title || createHash("sha256").update(row.body).digest("hex") !== entry.bodyHash)
      throw conflict("Retrieved company knowledge changed or is no longer approved. Start a new run to review current references.");
  }
}
