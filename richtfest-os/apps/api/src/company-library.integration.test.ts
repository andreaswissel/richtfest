import { test, expect } from "bun:test";
import express from "express";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { companyLibraryRouter } from "../../../../richtfest-apps/knowledge/src/company-library";
import { organizeCompanyImports } from "../../../../richtfest-apps/knowledge/src/company-imports";
import type { AppDeps, ProviderRequest } from "@richtfest/knowledge/deps";
import { createDatabase } from "./db/client";

const url = process.env.DATABASE_URL;
const local =
  url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
(local ? test : test.skip)(
  "company library contracts: categories, private bounded retrieval and persisted evidence",
  async () => {
    const schema = `library_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = createDatabase(url!);
    await admin.pool.query(`create schema ${schema}`);
    const isolated = new URL(url!);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    const { db, pool } = createDatabase(isolated.href);
    const tenant = crypto.randomUUID(),
      other = crypto.randomUUID(),
      actor = crypto.randomUUID(),
      outsider = crypto.randomUUID();
    const fact = "Die Brandschutztür muss alle sechs Monate geprüft werden.";
    const longBody = "Unwichtiger Hintergrund. ".repeat(1800) + fact;
    let mode = "valid",
      configured = true,
      presetConfigured = true;
    let failApprovalAudit = false;
    const calls: ProviderRequest[] = [];
    const usage = {
      provider: "openai" as const,
      modelId: "fake",
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: null,
      cachedInputTokens: null,
      totalTokens: 14,
    };
    const app = express();
    app.use(express.json());
    app.use(
      companyLibraryRouter(
        (req) =>
          ({
            db,
            tenantId: req.headers["x-tenant"] ? other : tenant,
            actorId: req.headers["x-actor"] ? outsider : actor,
            requirePermission(
              key: Parameters<AppDeps["requirePermission"]>[0],
            ) {
              if (req.headers["x-deny"] === key)
                throw Object.assign(new Error("Forbidden"), { status: 403 });
            },
            audit: async (
              tx: any,
              action: string,
              _type: string,
              id: string,
            ) => {
              if (failApprovalAudit && action === "knowledge.draft.approved")
                throw new Error("Audit unavailable");
              await tx.execute(
                sql`insert into test_audit values (${action}, ${id})`,
              );
            },
            resolveActiveProvider: async () => "openai",
            providerConfigured: async () => configured,
            resolveSupervisorPreset: async () =>
              ({
                supervisor: {
                  modelId: presetConfigured ? "fake" : "",
                  reasoningEffort: "low",
                  maxOutputTokens: 5000,
                },
              }) as any,
            executeProvider: async (input: ProviderRequest) => {
              calls.push(input);
              expect(input.maxOutputTokens).toBe(2500);
              expect(input.includeOpenUI).toBe(false);
              expect(input.runId).toBeUndefined();
              await input.onUsage?.(usage);
              const context = input.context as any;
              if (!context.entries)
                return {
                  status: "completed",
                  output: {
                    terms:
                      mode === "empty" ? ["Quantenbanane"] : ["Brandschutztür"],
                    openuiReferences: [],
                  },
                };
              expect(
                context.entries.every((e: any) => e.excerpt.length <= 4000),
              ).toBe(true);
              expect(
                context.entries.some((e: any) => e.excerpt.includes(fact)),
              ).toBe(true);
              expect(context.coverage.limited).toBe(true);
              return {
                status: "completed",
                output: {
                  answer: "Alle sechs Monate.",
                  citations:
                    mode === "zero"
                      ? []
                      : [
                          {
                            id:
                              mode === "id"
                                ? crypto.randomUUID()
                                : context.entries[0].id,
                            quote: mode === "quote" ? "Frei erfunden" : fact,
                          },
                        ],
                },
              };
            },
          }) as unknown as AppDeps,
      ),
    );
    app.use((e: any, _req: any, res: any, _next: any) =>
      res
        .status(e.status ?? (e.name === "ZodError" ? 400 : 500))
        .json({ message: e.message }),
    );
    const server = app.listen(0),
      base = `http://127.0.0.1:${(server.address() as any).port}`;
    const request = async (
      path: string,
      method = "GET",
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const r = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    const insert = async (
      title: string,
      body = "Content",
      review = "draft",
      t = tenant,
      project: string | null = null,
    ) => {
      const id = crypto.randomUUID();
      await pool.query(
        "insert into knowledge_drafts (id,tenant_id,project_id,title,body,status,created_by,approved_by,approved_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          t,
          project,
          title,
          body,
          review,
          actor,
          review === "approved" ? actor : null,
          review === "approved" ? new Date("2026-01-01") : null,
        ],
      );
      return id;
    };
    try {
      await pool.query(
        `create table knowledge_drafts (id uuid primary key, tenant_id uuid not null, project_id uuid, title text not null, body text not null, status text not null default 'draft', source_refs jsonb default '[]', created_by uuid not null, approved_by uuid, approved_at timestamptz, created_at timestamptz not null default now()); create table test_audit (action text, id uuid)`,
      );
      await pool.query(
        await Bun.file(
          new URL(
            "../drizzle/0032_company_knowledge_library.sql",
            import.meta.url,
          ),
        ).text(),
      );
      await pool.query(
        await Bun.file(
          new URL(
            "../drizzle/0035_company_knowledge_conversations.sql",
            import.meta.url,
          ),
        ).text(),
      );
      const approved = await insert("Wartung", longBody, "approved"),
        draft = await insert("Entwurf", fact);
      const foreign = await insert("Fremd", fact, "approved", other),
        project = await insert(
          "Projekt",
          fact,
          "approved",
          tenant,
          crypto.randomUUID(),
        );
      for (let i = 0; i < 27; i++) await insert(`Eintrag ${i}`);
      const before = (
        await pool.query("select * from knowledge_drafts where id=$1", [
          approved,
        ])
      ).rows[0];
      const cat = (
        await request("/categories", "POST", { name: " Sicherheit " })
      ).body.data;
      expect(
        (await request("/categories", "POST", { name: "sICHERHEIT" })).status,
      ).toBe(409);
      const cat2 = (await request("/categories", "POST", { name: "Andere" }))
        .body.data;
      expect(
        (
          await request(`/categories/${cat2.id}`, "PATCH", {
            name: "sicherheit",
          })
        ).status,
      ).toBe(409);
      expect(
        (await request(`/categories/${cat2.id}`, "PATCH", { name: "Neu" })).body
          .data.name,
      ).toBe("Neu");
      const foreignCat = (
        await request(
          "/categories",
          "POST",
          { name: "Sicherheit" },
          { "x-tenant": "other" },
        )
      ).body.data.id;
      expect((await request(`/library?category=${foreignCat}`)).status).toBe(
        404,
      );
      expect(
        (await request(`/categories/${foreignCat}`, "PATCH", { name: "Bad" }))
          .status,
      ).toBe(404);
      const move = (ids: string[], categoryId: string | null) =>
        request("/categories/assign", "PATCH", { draftIds: ids, categoryId });
      expect(
        (await move([approved, approved, draft], cat.id)).body.data.changed
          .length,
      ).toBe(2);
      expect((await move([approved, foreign], null)).status).toBe(404);
      expect((await move([approved, project], null)).status).toBe(404);
      expect((await move([approved], foreignCat)).status).toBe(404);
      expect(
        (
          await pool.query("select * from knowledge_drafts where id=$1", [
            approved,
          ])
        ).rows[0],
      ).toEqual({ ...before, category_id: cat.id });
      expect((await move([draft], null)).status).toBe(200);
      const page0 = (await request("/library")).body.data,
        page1 = (await request("/library?page=1")).body.data;
      expect(page0.items.length).toBe(25);
      expect(page1.items.length).toBe(3);
      expect(page0.totalCount).toBe(29);
      expect(page0.items.some((e: any) => "body" in e)).toBe(false);
      expect(
        new Set([...page0.items, ...page1.items].map((e) => e.id)).size,
      ).toBe(28);
      const filtered = (await request("/library?q=kein&status=approved")).body
        .data;
      expect(filtered.total).toBe(0);
      expect(filtered.categories.find((c: any) => c.id === cat.id).count).toBe(
        1,
      );
      expect(filtered.unfiledCount).toBe(28);
      expect((await request("/library?status=invalid")).status).toBe(400);
      expect((await request("/library?page=-1")).status).toBe(400);
      for (const [path, method, body, permission] of [
        ["/library", "GET", undefined, "knowledge:read"],
        ["/categories", "POST", { name: "No" }, "knowledge:write"],
        [
          "/categories/assign",
          "PATCH",
          { draftIds: [draft], categoryId: null },
          "knowledge:read",
        ],
        [
          "/categories/assign",
          "PATCH",
          { draftIds: [draft], categoryId: null },
          "knowledge:write",
        ],
        ["/searches", "POST", { question: "Wartung?" }, "agent:run"],
        ["/searches", "POST", { question: "Wartung?" }, "knowledge:read"],
        ["/searches", "GET", undefined, "knowledge:read"],
      ] as const)
        expect(
          (await request(path, method, body, { "x-deny": permission })).status,
        ).toBe(403);
      expect(
        (await request("/library", "GET", undefined, { "x-deny": "agent:run" }))
          .body.data.canAsk,
      ).toBe(false);
      expect(
        (
          await request("/library", "GET", undefined, {
            "x-deny": "knowledge:write",
          })
        ).body.data.canManage,
      ).toBe(false);
      configured = false;
      expect(
        (await request("/searches", "POST", { question: "Wartung?" })).status,
      ).toBe(503);
      expect(calls.length).toBe(0);
      expect((await request("/searches")).body.data.configured).toBe(false);
      configured = true;
      presetConfigured = false;
      expect((await request("/searches")).body.data.configured).toBe(false);
      expect(
        (await request("/searches", "POST", { question: "Wartung?" })).status,
      ).toBe(503);
      expect(calls.length).toBe(0);
      presetConfigured = true;
      const searchInput = {
        question: "How often must the fire door be inspected?",
        category: cat.id,
        status: "approved",
      };
      const saved = (await request("/searches", "POST", searchInput)).body.data;
      expect(saved.status).toBe("completed");
      expect(calls.length).toBe(2);
      expect((calls[1].context as any).entries.map((e: any) => e.id)).toEqual([
        approved,
      ]);
      expect(saved.citations).toEqual([
        {
          id: approved,
          title: "Wartung",
          status: "approved",
          quote: fact,
          bodyHash: createHash("sha256").update(longBody).digest("hex"),
        },
      ]);
      expect(saved.usage).toEqual([usage, usage]);
      expect(saved.filters).toEqual({ category: cat.id, status: "approved" });
      expect((await request(`/searches/${saved.id}`)).body.data).toEqual({
        ...saved,
        turns: [saved],
      });
      expect((await request("/searches")).body.data.items[0].filters).toEqual(
        saved.filters,
      );
      expect(
        (
          await request("/searches", "POST", {
            ...searchInput,
            category: "all",
          })
        ).body.data.status,
      ).toBe("completed");
      expect(
        (calls.at(-1)!.context as any).entries.map((e: any) => e.id),
      ).toEqual([approved]);
      expect(
        (
          await request("/searches", "POST", {
            ...searchInput,
            category: "_none",
            status: "draft",
          })
        ).body.data.citations[0].id,
      ).toBe(draft);
      expect(
        (calls.at(-1)!.context as any).entries.map((e: any) => e.id),
      ).toEqual([draft]);
      for (const headers of [
        { "x-actor": "other" },
        { "x-tenant": "other" },
      ] as Record<string, string>[]) {
        expect(
          (await request(`/searches/${saved.id}`, "GET", undefined, headers))
            .status,
        ).toBe(404);
        expect(
          (await request("/searches", "GET", undefined, headers)).body.data
            .items,
        ).toEqual([]);
      }
      mode = "empty";
      const n = calls.length;
      expect(
        (await request("/searches", "POST", searchInput)).body.data,
      ).toMatchObject({ status: "completed", answer: "", citations: [] });
      expect(calls.length).toBe(n + 1);
      for (mode of ["id", "quote", "zero"]) {
        const failed = (await request("/searches", "POST", searchInput)).body
          .data;
        expect(failed).toMatchObject({
          status: "failed",
          answer: null,
          citations: [],
          error: "Knowledge search failed. No automatic retry.",
        });
        expect(failed.usage.length).toBe(2);
      }
      await pool.query(
        "update knowledge_searches set status='running',created_at=now()-interval '4 minutes' where id=$1",
        [saved.id],
      );
      const count = calls.length;
      expect((await request(`/searches/${saved.id}`)).body.data.status).toBe(
        "interrupted",
      );
      expect(
        (await request("/searches")).body.data.items.find(
          (e: any) => e.id === saved.id,
        ).status,
      ).toBe("interrupted");
      expect(calls.length).toBe(count);
      expect(
        (
          await pool.query(
            "select status from knowledge_searches where id=$1",
            [saved.id],
          )
        ).rows[0].status,
      ).toBe("running");
      expect(
        (
          await pool.query(
            "select count(*)::int as count from test_audit where action='knowledge.category_assigned'",
          )
        ).rows[0].count,
      ).toBe(3);
      expect(
        (
          await pool.query(
            "select count(*)::int as count from test_audit where action='knowledge.search_started'",
          )
        ).rows[0].count,
      ).toBe(7);
      mode = "valid";
      const metadata = {
        displayTitle: " Fire doors ",
        sourceLabel: " Handbook ",
        chapter: " Chapter 2 ",
      };
      const edit = await request(
        `/drafts/${approved}/library`,
        "PATCH",
        metadata,
      );
      expect(edit.status).toBe(200);
      expect(edit.body.data).toMatchObject({
        title: "Wartung",
        body: longBody,
        status: "approved",
        approvedBy: actor,
        displayTitle: "Fire doors",
        sourceLabel: "Handbook",
        chapter: "Chapter 2",
      });
      expect(
        (await request("/library?status=approved&q=fire")).body.data.items[0],
      ).toMatchObject({
        id: approved,
        displayTitle: "Fire doors",
        sourceLabel: "Handbook",
        chapter: "Chapter 2",
      });
      expect(
        (await request("/library?status=approved&q=Wartung")).body.data.total,
      ).toBe(1);
      await request(`/drafts/${approved}/library`, "PATCH", metadata);
      expect(
        (
          await pool.query(
            "select count(*)::int as n from test_audit where action='knowledge.library_updated'",
          )
        ).rows[0].n,
      ).toBe(1);
      const afterMetadata = (
        await pool.query("select * from knowledge_drafts where id=$1", [
          approved,
        ])
      ).rows[0];
      expect(afterMetadata).toEqual({
        ...before,
        category_id: cat.id,
        display_title: "Fire doors",
        source_label: "Handbook",
        chapter: "Chapter 2",
      });
      for (const id of [foreign, project])
        expect(
          (await request(`/drafts/${id}/library`, "PATCH", metadata)).status,
        ).toBe(404);
      for (const permission of ["knowledge:read", "knowledge:write"])
        expect(
          (
            await request(`/drafts/${approved}/library`, "PATCH", metadata, {
              "x-deny": permission,
            })
          ).status,
        ).toBe(403);
      for (const invalid of [
        { displayTitle: " " },
        { chapter: "x".repeat(301) },
        { body: "Overwrite" },
        { categoryId: "bad" },
      ])
        expect(
          (await request(`/drafts/${approved}/library`, "PATCH", invalid))
            .status,
        ).toBe(400);
      expect(
        (
          await request(`/drafts/${approved}/library`, "PATCH", {
            categoryId: foreignCat,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(`/drafts/${draft}/library`, "PATCH", {
            displayTitle: null,
            sourceLabel: null,
            chapter: null,
            categoryId: cat.id,
          })
        ).status,
      ).toBe(200);

      const root = (await request("/searches", "POST", searchInput)).body.data;
      const follow = (
        id: string,
        extra = {},
        headers: Record<string, string> = {},
      ) =>
        request(
          "/searches",
          "POST",
          { question: "And what about this?", parentSearchId: id, ...extra },
          headers,
        );
      for (const headers of [
        { "x-actor": "other" },
        { "x-tenant": "other" },
      ] as Record<string, string>[])
        expect((await follow(root.id, {}, headers)).status).toBe(404);
      expect((await follow(crypto.randomUUID())).status).toBe(404);
      expect((await follow("invalid")).status).toBe(400);
      expect((await follow(root.id, { category: "all" })).status).toBe(400);
      expect((await follow(root.id, { status: "draft" })).status).toBe(400);
      const child = (await follow(root.id)).body.data;
      expect(child).toMatchObject({
        parentSearchId: root.id,
        filters: root.filters,
        status: "completed",
      });
      for (const call of calls.slice(-2))
        expect((call.context as any).conversation.turns).toEqual([
          { question: root.question, answer: root.answer },
        ]);
      expect((calls.at(-1)!.context as any).entries[0]).toMatchObject({
        displayTitle: "Fire doors",
        sourceLabel: "Handbook",
        chapter: "Chapter 2",
      });
      expect((await request(`/searches/${child.id}`)).body.data.turns).toEqual([
        root,
        child,
      ]);
      expect(
        (await request("/searches")).body.data.items.some(
          (r: any) => r.id === root.id,
        ),
      ).toBe(false);
      expect((await follow(root.id)).status).toBe(409);
      expect((await follow(saved.id)).status).toBe(409); // Effective interruption, no persisted status mutation.
      await pool.query(
        "update knowledge_searches set status='running' where id=$1",
        [child.id],
      );
      expect((await follow(child.id)).status).toBe(409);
      await pool.query(
        "update knowledge_searches set status='failed',answer=null where id=$1",
        [child.id],
      );
      let leaf = (await follow(child.id)).body.data;
      expect(leaf.status).toBe("completed");
      // Scope validation covers every ancestor, not only the selected parent.
      await pool.query(
        "update knowledge_searches set created_by=$1 where id=$2",
        [outsider, root.id],
      );
      expect((await follow(leaf.id)).status).toBe(404);
      expect((await request(`/searches/${leaf.id}`)).status).toBe(404);
      await pool.query(
        "update knowledge_searches set created_by=$1,tenant_id=$2 where id=$3",
        [actor, other, root.id],
      );
      expect((await follow(leaf.id)).status).toBe(404);
      await pool.query(
        "update knowledge_searches set tenant_id=$1 where id=$2",
        [tenant, root.id],
      );
      for (let i = 3; i < 20; i++) {
        await pool.query(
          "update knowledge_searches set answer=$1,question=$2 where id=$3",
          ["a".repeat(10000), "q".repeat(1000), leaf.id],
        );
        leaf = (await follow(leaf.id)).body.data;
        expect(leaf.status).toBe("completed");
        for (const call of calls.slice(-2)) {
          const context = (call.context as any).conversation;
          expect(context.trust).toBe("UNTRUSTED");
          expect(context.previousAnswersAreEvidence).toBe(false);
          expect(context.turns.length).toBeLessThanOrEqual(6);
          expect(
            context.turns.reduce(
              (n: number, t: any) => n + t.question.length + t.answer.length,
              0,
            ),
          ).toBeLessThanOrEqual(12000);
          expect(call.systemInstructions?.toLowerCase()).toContain(
            "previous answers",
          );
        }
      }
      expect(
        (await request(`/searches/${leaf.id}`)).body.data.turns.length,
      ).toBe(20);
      expect((await follow(leaf.id)).status).toBe(409);
      expect(
        (await request("/searches")).body.data.items.length,
      ).toBeLessThanOrEqual(10);
      // Follow-up evidence cannot be supplied by previous answers.
      mode = "quote";
      const failedRoot = (await request("/searches", "POST", searchInput)).body
        .data;
      expect((await follow(failedRoot.id)).body.data.status).toBe("failed");
      mode = "valid";
      const concurrentRoot = (await request("/searches", "POST", searchInput))
        .body.data;
      const concurrent = await Promise.all([
        follow(concurrentRoot.id),
        follow(concurrentRoot.id),
      ]);
      expect(concurrent.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        (
          await pool.query(
            "select count(*)::int as n from knowledge_searches where parent_search_id=$1",
            [concurrentRoot.id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pool.query("select * from knowledge_drafts where id=$1", [
            approved,
          ])
        ).rows[0],
      ).toEqual(afterMetadata);

      const marker =
        "<!-- richtfest-import:baukosten-2026-10-12:fixture -->\nPreserved source";
      const importedTitle =
        "Baukostenoptimierer · Kandidaten · Honorar · Teil 2/3";
      const imported = await insert(importedTitle, marker, "approved");
      const umlaut = await insert(
        "Baukostenoptimierer · Kernhebel · Huelle",
        marker,
      );
      const caseStudy = await insert(
        "Baukostenoptimierer · Fall G-2 · Giersstraße 20, Berlin",
        marker,
      );
      const glossary = await insert("Baukostenoptimierer · Glossar", marker);
      const overrides = await insert(importedTitle, marker);
      await request(`/drafts/${overrides}/library`, "PATCH", {
        displayTitle: "Human title",
      });
      const untouched = [
        overrides,
        await insert(importedTitle, "No provenance marker"),
        await insert(importedTitle, marker, "draft", other),
        await insert(
          importedTitle,
          marker,
          "draft",
          tenant,
          crypto.randomUUID(),
        ),
        await insert("Baukostenoptimierer · Unbekannt · Honorar", marker),
      ];
      const snapshot = (ids: string[]) =>
        pool
          .query(
            "select * from knowledge_drafts where id=any($1::uuid[]) order by id",
            [ids],
          )
          .then((r) => r.rows);
      const originals = await snapshot([imported, ...untouched]);
      const deps = {
        db,
        tenantId: tenant,
        actorId: actor,
        requirePermission() {},
        audit: async (tx: any, action: string, _type: string, id: string) => {
          await tx.execute(
            sql`insert into test_audit values (${action}, ${id})`,
          );
        },
      };
      const plan = await organizeCompanyImports(deps);
      expect(plan.changes).toHaveLength(4);
      expect(plan.changes.find((c) => c.id === imported)).toEqual({
        id: imported,
        originalTitle: importedTitle,
        category: "Honorar",
        displayTitle: "Kandidaten",
        sourceLabel: "Baukostenoptimierer",
        chapter: "Teil 2/3",
      });
      expect(plan.changes.find((c) => c.id === umlaut)?.category).toBe("Hülle");
      expect(plan.changes.find((c) => c.id === caseStudy)).toMatchObject({
        category: "Fallstudien",
        displayTitle: "Giersstraße 20, Berlin",
        chapter: "Fall G-2",
      });
      expect(plan.changes.find((c) => c.id === glossary)?.category).toBe(
        "Glossar",
      );
      expect(await snapshot([imported, ...untouched])).toEqual(originals);
      const auditCount = async () =>
        (await pool.query("select count(*)::int as n from test_audit")).rows[0]
          .n;
      const auditBefore = await auditCount();
      expect((await organizeCompanyImports(deps, true)).changes).toEqual(
        plan.changes,
      );
      expect(await snapshot(untouched)).toEqual(
        originals.filter((r) => r.id !== imported),
      );
      const organized = (await snapshot([imported]))[0];
      const {
        category_id,
        display_title,
        source_label,
        chapter,
        ...preserved
      } = organized;
      expect({
        ...preserved,
        category_id: null,
        display_title: null,
        source_label: null,
        chapter: null,
      }).toEqual(originals.find((r) => r.id === imported));
      expect(
        (
          await request("/library?status=all&q=Kandidaten")
        ).body.data.items.find((r: any) => r.id === imported),
      ).toMatchObject({
        displayTitle: "Kandidaten",
        sourceLabel: "Baukostenoptimierer",
        chapter: "Teil 2/3",
      });
      expect(await auditCount()).toBe(auditBefore + 8); // Four categories and four records.
      expect((await organizeCompanyImports(deps, true)).changes).toEqual([]);
      expect(await auditCount()).toBe(auditBefore + 8);
      await expect(
        organizeCompanyImports(
          {
            ...deps,
            requirePermission() {
              throw new Error("Forbidden");
            },
          },
          true,
        ),
      ).rejects.toThrow("Forbidden");
      const reviewBefore = await snapshot([
        imported,
        umlaut,
        glossary,
        caseStudy,
      ]);
      const approveMany = (draftIds: string[], headers = {}) =>
        request("/drafts/approve", "POST", { draftIds }, headers);
      for (const permission of ["knowledge:read", "knowledge:approve"]) {
        expect(
          (await approveMany([umlaut], { "x-deny": permission })).status,
        ).toBe(403);
      }
      expect(
        (
          await request("/library", "GET", undefined, {
            "x-deny": "knowledge:approve",
          })
        ).body.data.canApprove,
      ).toBe(false);
      for (const invalid of [foreign, project, crypto.randomUUID()])
        expect((await approveMany([umlaut, invalid])).status).toBe(404);
      expect((await approveMany([])).status).toBe(400);
      expect((await approveMany(Array(101).fill(umlaut))).status).toBe(400);
      expect(await snapshot([imported, umlaut, glossary, caseStudy])).toEqual(
        reviewBefore,
      );
      failApprovalAudit = true;
      expect((await approveMany([umlaut, glossary])).status).toBe(500);
      expect(await snapshot([imported, umlaut, glossary, caseStudy])).toEqual(
        reviewBefore,
      );
      failApprovalAudit = false;
      const reviewed = await approveMany([imported, umlaut, umlaut, glossary], {
        "x-deny": "knowledge:write",
      });
      expect(reviewed.status).toBe(200); // Review does not require category-edit permission.
      expect([...reviewed.body.data.changed].sort()).toEqual(
        [umlaut, glossary].sort(),
      );
      const reviewAfter = await snapshot([
        imported,
        umlaut,
        glossary,
        caseStudy,
      ]);
      for (const row of reviewAfter) {
        const old = reviewBefore.find((r) => r.id === row.id);
        if ([umlaut, glossary].includes(row.id)) {
          expect(row).toEqual({
            ...old,
            status: "approved",
            approved_by: actor,
            approved_at: row.approved_at,
          });
          expect(row.approved_at).toBeInstanceOf(Date);
        } else expect(row).toEqual(old);
      }
      const approvalAudits = async () =>
        (
          await pool.query(
            "select id from test_audit where action='knowledge.draft.approved' order by id",
          )
        ).rows.map((r) => r.id);
      expect(await approvalAudits()).toEqual([umlaut, glossary].sort());
      expect(
        (await approveMany([imported, umlaut, glossary])).body.data.changed,
      ).toEqual([]);
      expect(await approvalAudits()).toEqual([umlaut, glossary].sort());
      expect(await snapshot([imported, umlaut, glossary, caseStudy])).toEqual(
        reviewAfter,
      );
    } finally {
      server.close();
      await pool.end();
      await admin.pool.query(`drop schema ${schema} cascade`);
      await admin.pool.end();
    }
  },
  30000,
);
