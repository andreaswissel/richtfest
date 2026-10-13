import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppDeps } from "./deps";
import { drafts, knowledgeCategories as categories } from "./schema";

const domains: Record<string, string> = {
  Ankauf: "Ankauf",
  Ausstattung: "Ausstattung",
  Baurecht: "Baurecht",
  Betrieb: "Betrieb",
  Brandschutz: "Brandschutz",
  Flaeche: "Fläche",
  Foerderung: "Förderung",
  Honorar: "Honorar",
  Huelle: "Hülle",
  Prozess: "Prozess",
  Rohbau: "Rohbau",
  TGA: "TGA",
  Vergabe: "Vergabe",
};

/** Only the known import convention is classified; no inference from arbitrary titles. */
function metadata(row: { title: string; body: string }) {
  if (
    !/^<!-- richtfest-import:baukosten-2026-10-12:[a-zA-Z0-9_-]+ -->/.test(
      row.body,
    )
  )
    return null;
  const [sourceLabel, kind, domain, chapter, extra] = row.title.split(" · ");
  if (sourceLabel !== "Baukostenoptimierer" || extra !== undefined) return null;
  if (
    ["Kernhebel", "Kandidaten"].includes(kind) &&
    domains[domain] &&
    (!chapter ||
      (kind === "Kandidaten" && /^Teil [1-9]\d*\/[1-9]\d*$/.test(chapter)))
  ) {
    return {
      category: domains[domain],
      displayTitle: kind,
      sourceLabel,
      chapter: chapter ?? null,
    };
  }
  if (/^Fall (G-[1-7]|[DEFK]-1)$/.test(kind) && domain && !chapter) {
    return {
      category: "Fallstudien",
      displayTitle: domain,
      sourceLabel,
      chapter: kind,
    };
  }
  if (domain) return null;
  const referenceCategories: Record<string, string> = {
    "Überblick und sichere Nutzung": "Orientierung",
    Glossar: "Glossar",
    "Begriffliche Prüfnotizen": "Glossar",
    "Fall- und Rechenprüfung": "Qualität und Quellen",
    "Quellenhash-Index": "Qualität und Quellen",
  };
  return referenceCategories[kind]
    ? {
        category: referenceCategories[kind],
        displayTitle: kind,
        sourceLabel,
        chapter: null,
      }
    : null;
}

/** Dry-run by default. Fill only wholly unorganized imports, preserving human overrides. */
export async function organizeCompanyImports(
  d: Pick<
    AppDeps,
    "db" | "tenantId" | "actorId" | "requirePermission" | "audit"
  >,
  apply = false,
): Promise<{
  applied: boolean;
  scanned: number;
  unchanged: number;
  changes: ({ id: string; originalTitle: string } & NonNullable<
    ReturnType<typeof metadata>
  >)[];
}> {
  d.requirePermission("knowledge:read");
  d.requirePermission("knowledge:write");
  return d.db.transaction(async (tx: any) => {
    // Same category-before-draft lock order as the library write API.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${d.tenantId}), hashtext('company-import-organization'))`,
    );
    const knownCategories = await tx
      .select()
      .from(categories)
      .where(eq(categories.tenantId, d.tenantId))
      .orderBy(categories.id)
      .for("update");
    const rows = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.tenantId, d.tenantId), isNull(drafts.projectId)))
      .orderBy(drafts.id)
      .for("update");
    const changes = rows.flatMap((row: typeof drafts.$inferSelect) => {
      const proposal = metadata(row);
      if (
        !proposal ||
        row.categoryId ||
        row.displayTitle ||
        row.sourceLabel ||
        row.chapter
      )
        return [];
      return [{ id: row.id, originalTitle: row.title, ...proposal }];
    });
    if (apply)
      for (const change of changes) {
        let category = knownCategories.find(
          (c: { name: string }) =>
            c.name.toLowerCase() === change.category.toLowerCase(),
        );
        if (!category) {
          const inserted = await tx
            .insert(categories)
            .values({
              tenantId: d.tenantId,
              createdBy: d.actorId,
              name: change.category,
            })
            .onConflictDoNothing()
            .returning();
          category =
            inserted[0] ??
            (
              await tx
                .select()
                .from(categories)
                .where(
                  and(
                    eq(categories.tenantId, d.tenantId),
                    sql`lower(${categories.name}) = lower(${change.category})`,
                  ),
                )
            )[0];
          if (inserted.length)
            await d.audit(
              tx,
              "knowledge.category_created",
              "knowledge_category",
              category.id,
              { name: category.name },
            );
          knownCategories.push(category);
        }
        const { displayTitle, sourceLabel, chapter } = change;
        const values = {
          categoryId: category.id,
          displayTitle,
          sourceLabel,
          chapter,
        };
        await tx.update(drafts).set(values).where(eq(drafts.id, change.id));
        await d.audit(tx, "knowledge.library_updated", "draft", change.id, {
          changes: values,
          importConvention: "baukosten-2026-10-12",
        });
      }
    return {
      applied: apply,
      scanned: rows.length,
      unchanged: rows.length - changes.length,
      changes,
    };
  });
}
