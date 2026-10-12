import { expect, test } from "bun:test";
import { agentProfilesRouter, assertKnowledgeBudget, defaultProfiles, profileInput, profileKey, snapshotAgentProfiles } from "./agent-profiles";
import { agentProfiles } from "./schema";
import type { AppDeps } from "./deps";
import { agentPresetSnapshotSchema, domainSpecialistRoles } from "@richtfest/shared";
import { assertConfiguredAssignments, plannerRoles, supervisorPlan } from "./supervisor";

test("only existing roles and bounded profile fields are configurable", () => {
  expect(defaultProfiles().map(profile => profile.key)).toEqual(["supervisor", "source_reviewer", "requirements_reviewer", "independent_reviewer", ...domainSpecialistRoles]);
  expect(profileKey.safeParse("admin").success).toBe(false);
  expect(profileInput.safeParse({ instructions: "", triggerPhrases: [], knowledgeIds: [], permissions: ["access:manage"] }).success).toBe(false);
  expect(profileInput.safeParse({ instructions: "", triggerPhrases: [" "], knowledgeIds: [] }).success).toBe(false);
  expect(profileInput.safeParse({ instructions: "", triggerPhrases: [], knowledgeIds: [], enabled: true }).success).toBe(false);
});

test("domain routing and assignments use only the immutable preset, not configured profile guidance", () => {
  const model = { modelId: "test", maxOutputTokens: 1000, maxSteps: 1 };
  const legacy = agentPresetSnapshotSchema.parse({ supervisor: model, specialists: { source_reviewer: model, requirements_reviewer: model }, effort: "medium", provider: "openai", version: 1, source: "workspace", maxTasks: 4, maxParallel: 2, maxRevisions: 1 });
  const profiles = defaultProfiles().map(profile => ({ ...profile, knowledge: [] }));
  expect(plannerRoles(legacy, profiles).availableRoles).toEqual(["source_reviewer", "requirements_reviewer"]);
  expect(plannerRoles(legacy, profiles).routingHints.map(hint => hint.role)).toEqual(["source_reviewer", "requirements_reviewer"]);
  for (const role of domainSpecialistRoles) {
    const plan = supervisorPlan.parse({ tasks: [{ role, goal: "Review evidence", sourceVersionIds: [] }] });
    expect(() => assertConfiguredAssignments(plan, legacy)).toThrow("disabled");
    const enabled = agentPresetSnapshotSchema.parse({ ...legacy, specialists: { ...legacy.specialists, [role]: model } });
    expect(() => assertConfiguredAssignments(plan, enabled)).not.toThrow();
    expect(plannerRoles(enabled, profiles).availableRoles).toContain(role);
    expect(plannerRoles(enabled, profiles).routingHints.find(hint => hint.role === role)?.triggerPhrases.length).toBeGreaterThan(0);
  }
});

test("domain profile snapshots preserve saved guidance and reference content independently of later changes", async () => {
  const id = crypto.randomUUID();
  const saved = { key: "sound_insulation", instructions: "Compare acoustic inputs", triggerPhrases: ["acoustic inputs"], knowledgeIds: [id], version: 3 };
  const reference = { id, title: "Acoustic guidance", body: "Approved input definitions" };
  const db = { select: () => ({ from: (table: unknown) => ({ where: async () => table === agentProfiles ? [saved] : [reference] }) }) };
  const snapshot = await snapshotAgentProfiles({ tenantId: crypto.randomUUID(), db } as AppDeps);
  saved.instructions = "Changed";
  saved.triggerPhrases.push("Later phrase");
  reference.body = "Changed reference";
  const profile = snapshot.find(profile => profile.key === "sound_insulation")!;
  expect(profile.instructions).toBe("Compare acoustic inputs");
  expect(profile.triggerPhrases).toEqual(["acoustic inputs"]);
  expect(profile.knowledge[0].body).toBe("Approved input definitions");
  expect(profile.version).toBe(3);
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
