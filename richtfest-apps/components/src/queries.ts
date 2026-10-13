import { and, or, eq, sql, asc } from "drizzle-orm";
import { z } from "zod";
import { componentEvidencePolicy, type ComponentRecord } from "@richtfest/shared";
import { components, revisions } from "./schema";
import type { AppDeps } from "./deps";

export function record(row: any): ComponentRecord {
  return { id: row.componentId, revisionId: row.id, revision: row.revision, reviewVersion: row.reviewVersion,
    reviewStatus: row.reviewStatus, reviewNote: row.reviewNote, reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), data: row.data };
}
export function textFilter(query: string, categoryKeywords = false) {
  const words = categoryKeywords
    ? query.toLowerCase().match(/[\p{L}\p{N}._-]{3,}/gu) ?? []
    : query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const predicates = words.map(word => {
    const category = categoryKeywords && (/^(fenster|window|windows)$/.test(word) ? "window_system" : /^(decke|decken|slab|slabs|floor|ceiling|ceilings)$/.test(word) ? "floor_slab" : null);
    return category ? sql`${revisions.data}->>'category' = ${category}` : sql`strpos(lower(concat_ws(' ', ${components.key}, ${revisions.data}->>'name', ${revisions.data}->>'manufacturer')), ${word}) > 0`;
  });
  // A natural-language agent goal needs any matching product/category term,
  // not every word ("compare windows for this project" is not a product name).
  return categoryKeywords ? (or(...predicates) ?? sql`false`) : and(...predicates);
}
export function currentRows(d: AppDeps) {
  return d.db.select({ row: revisions }).from(components).innerJoin(revisions,
    and(eq(revisions.id, components.currentRevisionId), eq(revisions.tenantId, components.tenantId), eq(revisions.componentId, components.id)));
}
export async function searchReviewedComponents(d: AppDeps, input: { query?: string; id?: string }) {
  d.requirePermission("components:read");
  const parsed = z.object({ query: z.string().trim().max(200).optional(), id: z.string().uuid().optional() }).strict().parse(input);
  const rows = await currentRows(d).where(and(eq(components.tenantId, d.tenantId), eq(revisions.reviewStatus, "reviewed"),
    parsed.id ? eq(components.id, parsed.id) : undefined, parsed.query ? textFilter(parsed.query, true) : undefined))
    .orderBy(asc(components.key)).limit(6);
  const items: ComponentRecord[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, 5)) {
    const item = record(row.row);
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes + size > 24000) continue;
    items.push(item); bytes += size;
  }
  return { items, truncated: rows.length > items.length, evidencePolicy: componentEvidencePolicy };
}
