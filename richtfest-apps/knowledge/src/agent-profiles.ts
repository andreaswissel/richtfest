import { Router, type Request } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ok, domainSpecialistRoles } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { agentProfiles, drafts } from "./schema";
import { conflict, missing } from "./workspace";

export const profileKey = z.enum(["supervisor", "source_reviewer", "requirements_reviewer", "independent_reviewer", ...domainSpecialistRoles]);
const labels = { supervisor: "Supervisor", source_reviewer: "Source reviewer", requirements_reviewer: "Requirements reviewer", independent_reviewer: "Independent reviewer", sound_insulation: "Sound insulation specialist", construction_law: "Construction law specialist", cost_optimizer: "Cost options specialist" };
const domainDefaults = {
  sound_insulation: { instructions: "Review acoustic source evidence and prepare input proposals, identifying missing values and uncertainties. Never calculate or claim IFC semantic completeness.", triggerPhrases: ["sound insulation", "acoustics", "Schallschutz"] },
  construction_law: { instructions: "Propose source-based applicable requirements. Identify jurisdiction, edition and applicability uncertainty. Never provide binding legal approval.", triggerPhrases: ["construction law", "building regulations", "Baurecht", "jurisdiction"] },
  cost_optimizer: { instructions: "Compare evidence-backed options and identify price evidence, assumptions and gaps. Never invent prices or claim validated optimization or savings.", triggerPhrases: ["cost comparison", "cost options", "Kostenoptimierung", "budget"] },
};
export const profileInput = z.object({
  instructions: z.string().trim().max(10000),
  triggerPhrases: z.array(z.string().trim().min(1).max(200)).max(50),
  knowledgeIds: z.array(z.string().uuid()).max(20),
}).strict();
export type Profile = z.infer<typeof profileInput> & { key: z.infer<typeof profileKey>; label: string; version: number };
export type ProfileSnapshot = Profile & { knowledge: { id: string; title: string; body: string }[] };
export const defaultProfiles = (): Profile[] => profileKey.options.map(key => {
  const guidance = key in domainDefaults ? domainDefaults[key as keyof typeof domainDefaults] : undefined;
  return { key, label: labels[key], instructions: guidance?.instructions ?? "", triggerPhrases: [...(guidance?.triggerPhrases ?? [])], knowledgeIds: [], version: 0 };
});
export const MAX_PROFILE_KNOWLEDGE_CHARS = 40000;
export function assertKnowledgeBudget(knowledge: { title: string; body: string }[]) {
  if (knowledge.reduce((total, item) => total + item.title.length + item.body.length, 0) > MAX_PROFILE_KNOWLEDGE_CHARS)
    throw conflict("Assigned company knowledge exceeds 40,000 characters for one agent profile. Assign fewer or shorter knowledge items.");
}
const eligible = (tenantId: string) => and(eq(drafts.tenantId, tenantId), isNull(drafts.projectId), eq(drafts.status, "approved"));
export async function loadAgentProfiles(d: AppDeps, db = d.db) {
  const rows = await db.select().from(agentProfiles).where(eq(agentProfiles.tenantId, d.tenantId));
  return defaultProfiles().map(profile => {
    const saved = rows.find((row: any) => row.key === profile.key);
    return saved ? { ...profile, ...profileInput.parse({ instructions: saved.instructions, triggerPhrases: saved.triggerPhrases, knowledgeIds: saved.knowledgeIds }), version: saved.version } : profile;
  });
}
export async function snapshotAgentProfiles(d: AppDeps, db = d.db): Promise<ProfileSnapshot[]> {
  const profiles = await loadAgentProfiles(d, db);
  const ids = [...new Set(profiles.flatMap(profile => profile.knowledgeIds))];
  const knowledge = ids.length ? await db.select({ id: drafts.id, title: drafts.title, body: drafts.body }).from(drafts).where(and(eligible(d.tenantId), inArray(drafts.id, ids))) : [];
  return profiles.map(profile => {
    const assigned = knowledge.filter((item: any) => profile.knowledgeIds.includes(item.id)).map((item: any) => ({ ...item }));
    assertKnowledgeBudget(assigned);
    return { ...profile, knowledge: assigned };
  });
}
export function agentProfilesRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.get("/agent-profiles", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      let canManage = true;
      try { d.requirePermission("access:manage"); } catch { canManage = false; }
      const [profiles, knowledge] = await Promise.all([
        loadAgentProfiles(d),
        d.db.select({ id: drafts.id, title: drafts.title }).from(drafts).where(eligible(d.tenantId)),
      ]);
      res.json(ok({ profiles, knowledge, canManage, enabled: d.supervisorEnabled === true }));
    } catch (error) { next(error); }
  });
  router.put("/agent-profiles/:key", async (req, res, next) => {
    try {
      const d = getDeps(req);
      d.requirePermission("knowledge:read");
      d.requirePermission("access:manage");
      const key = profileKey.parse(req.params.key);
      const parsed = profileInput.parse(req.body);
      const input = { ...parsed, triggerPhrases: [...new Set(parsed.triggerPhrases)], knowledgeIds: [...new Set(parsed.knowledgeIds)] };
      const profile = await d.db.transaction(async (tx: any) => {
        if (input.knowledgeIds.length) {
          const rows = await tx.select({ id: drafts.id, title: drafts.title, body: drafts.body }).from(drafts).where(and(eligible(d.tenantId), inArray(drafts.id, input.knowledgeIds))).for("share");
          if (rows.length !== input.knowledgeIds.length) throw missing("Approved company knowledge not found");
          assertKnowledgeBudget(rows);
        }
        const [saved] = await tx.insert(agentProfiles).values({ ...input, key, tenantId: d.tenantId, updatedBy: d.actorId }).onConflictDoUpdate({
          target: [agentProfiles.tenantId, agentProfiles.key],
          set: { ...input, version: sql`${agentProfiles.version} + 1`, updatedBy: d.actorId, updatedAt: new Date() },
        }).returning();
        await d.audit(tx, "knowledge.agent_profile.updated", "agent_profile", saved.id, { key, version: saved.version, knowledgeIds: input.knowledgeIds });
        return { key, label: labels[key], ...input, version: saved.version };
      });
      res.json(ok(profile));
    } catch (error) { next(error); }
  });
  return router;
}
