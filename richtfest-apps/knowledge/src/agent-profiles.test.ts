import { expect, test } from "bun:test";
import { agentProfilesRouter, assertKnowledgeBudget, defaultProfiles, profileInput, profileKey, snapshotAgentProfiles } from "./agent-profiles";
import { agentProfiles } from "./schema";
import type { AppDeps } from "./deps";

test("only existing roles and bounded profile fields are configurable", () => {
  expect(defaultProfiles().map(profile => profile.key)).toEqual(["supervisor", "source_reviewer", "requirements_reviewer", "independent_reviewer"]);
  expect(profileKey.safeParse("admin").success).toBe(false);
  expect(profileInput.safeParse({ instructions: "", triggerPhrases: [], knowledgeIds: [], permissions: ["access:manage"] }).success).toBe(false);
  expect(profileInput.safeParse({ instructions: "", triggerPhrases: [" "], knowledgeIds: [] }).success).toBe(false);
});

test("snapshot copies assigned reference content and preserves defaults for unsaved roles", async () => {
  const id = crypto.randomUUID();
  const saved = { key: "source_reviewer", instructions: "Compare dimensions", triggerPhrases: ["dimension"], knowledgeIds: [id], version: 2 };
  const db = { select: () => ({ from: (table: unknown) => ({ where: async () => table === agentProfiles ? [saved] : [{ id, title: "Guideline", body: "Approved reference" }] }) }) };
  const snapshot = await snapshotAgentProfiles({ tenantId: crypto.randomUUID(), db } as AppDeps);
  saved.instructions = "Changed later";
  expect(snapshot[1].instructions).toBe("Compare dimensions");
  expect(snapshot[1].version).toBe(2);
  expect(snapshot[1].knowledge[0].body).toBe("Approved reference");
  expect(snapshot[0].version).toBe(0);
  expect(snapshot[0].knowledge).toEqual([]);
});

test("aggregate knowledge budget rejects oversized references without truncation", () => {
  expect(() => assertKnowledgeBudget([{ title: "", body: "x".repeat(40000) }])).not.toThrow();
  expect(() => assertKnowledgeBudget([{ title: "Title", body: "x".repeat(40000) }])).toThrow("40,000 characters");
  expect(() => assertKnowledgeBudget([{ title: "", body: "x".repeat(20001) }, { title: "", body: "x".repeat(20000) }])).toThrow("40,000 characters");
});

test("run snapshot rejects knowledge that grew after profile assignment", async () => {
  const id = crypto.randomUUID();
  const saved = { key: "source_reviewer", instructions: "", triggerPhrases: [], knowledgeIds: [id], version: 1 };
  const db = { select: () => ({ from: (table: unknown) => ({ where: async () => table === agentProfiles ? [saved] : [{ id, title: "Guideline", body: "x".repeat(40001) }] }) }) };
  await expect(snapshotAgentProfiles({ tenantId: crypto.randomUUID(), db } as AppDeps)).rejects.toThrow("40,000 characters");
});

test("profile writes reject either missing permission before accessing data", async () => {
  for (const missing of ["knowledge:read", "access:manage"]) {
    const denied = new Error(`Missing ${missing}`);
    let dataAccessed = false;
    let failure: unknown;
    const d = {
      requirePermission: (permission: string) => { if (permission === missing) throw denied; },
      db: { transaction: () => { dataAccessed = true; throw new Error("Unauthorized data access"); } },
    } as unknown as AppDeps;
    const router = agentProfilesRouter(() => d);
    const route: any = router.stack.find((layer: any) => layer.route?.methods.put)?.route;
    expect(route).toBeDefined();
    await route.stack[0].handle({ params: { key: "supervisor" }, body: { instructions: "", triggerPhrases: [], knowledgeIds: [] } }, {}, (error: unknown) => { failure = error; });
    expect(failure).toBe(denied);
    expect(dataAccessed).toBe(false);
  }
});
