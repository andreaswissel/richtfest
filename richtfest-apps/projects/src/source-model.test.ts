import { expect, test } from "bun:test";
import { runSourceModel } from "./source-model";
import type { SourceModelDeps } from "./deps";

test("bounded batches namespace collisions and publish only fully validated evidence", async () => {
  for (const invalid of [false, true]) {
    const text = "A".repeat(4000) + "B".repeat(4000);
    const published: any[] = [], updates: any[] = [], inputs: any[] = [];
    let selects = 0;
    const chain = (rows: any[]) => {
      const query: any = { then: (resolve: any) => Promise.resolve(rows).then(resolve) };
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit", "for"]) query[method] = () => query;
      return query;
    };
    const db: any = {
      transaction: async (fn: any) => fn(db),
      select: () => chain(++selects === 1 ? [{ job: { versionId: "revision", tenantId: "tenant", status: "queued" },
        source: { mimeType: "text/plain", createdBy: "actor" }, extraction: { status: "complete", result: { pages: 1 } }, name: "source.txt" }]
        : selects === 2 ? [{ page: 1, text }] : [{}]),
      update: () => ({ set: (value: any) => { updates.push(value); return { where: async () => {} }; } }),
      insert: () => ({ values: async (values: any[]) => { published.push(...values); } }),
    };
    const deps: SourceModelDeps = { db, audit: async () => {}, reportError: () => {}, fileStorage: { read: async () => { throw new Error("must use saved text"); } },
      structureDocument: async input => {
        inputs.push(input);
        return { status: "completed", metadata: {}, output: { entities: [{ key: "same", name: "Claim", kind: "document" }],
          facts: [{ entityKey: "same", predicate: "description", kind: "attribute", value: { type: "text", value: "Claim" }, unit: null, provenance: "extracted",
            evidence: { kind: "text", page: 1, quote: invalid && inputs.length === 2 ? "AB" : input.pages[0]!.text.slice(0, 2) } }] } };
      } };
    expect(await runSourceModel(deps, new AbortController().signal)).toBe(true);
    expect(inputs.map(input => input.pages.map((page: any) => page.text).join("")).join("")).toBe(text);
    expect(inputs.every(input => input.pages[0].text.length === 4000)).toBe(true);
    if (invalid) {
      expect(published).toEqual([]);
      expect(updates.at(-1)).toMatchObject({ status: "failed", metadata: { diagnostic: { code: "evidence", retryable: false } } });
    } else {
      expect(published.filter(row => row.key).map(row => row.key)).toEqual(["batch1:same", "batch2:same"]);
      expect(published.filter(row => row.entityKey).map(row => row.entityKey)).toEqual(["batch1:same", "batch2:same"]);
      expect(updates.at(-1)).toMatchObject({ status: "complete", metadata: { factCount: 2 } });
    }
  }
});
