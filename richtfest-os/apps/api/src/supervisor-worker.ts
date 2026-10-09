import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import type { Request } from "express";
import { listPendingSupervisors, stepSupervisor, supervisorProgress } from "@richtfest/knowledge";
import type { AppDeps } from "@richtfest/knowledge/deps";
import { memberships, rolePermissions, roles, users } from "./db/schema";
import type { Database } from "./db/client";
import type { Actor } from "./middleware/auth";
import { knowledgeDeps } from "./app-hosts";
import { env } from "./env";

/** Rehydrate access for each phase; a queued job never retains a user's old permissions. */
export async function backgroundKnowledgeDeps(db: Database, tenantId: string, actorId: string): Promise<AppDeps> {
  const rows = await db.select({ user: users, permission: rolePermissions.permission })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, and(eq(roles.id, memberships.roleId), eq(roles.tenantId, memberships.tenantId)))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, actorId), eq(memberships.status, "active")));
  const user = rows[0]?.user;
  const actor: Actor = {
    id: actorId, tenantId, email: user?.email ?? "", name: user?.name ?? "",
    uiDensity: user?.uiDensity === "normal" ? "normal" : "dense",
    language: user?.language === "de" ? "de" : "en",
    theme: user?.theme === "dark" ? "dark" : "light",
    permissions: new Set(rows.flatMap(row => row.permission ? [row.permission] : [])),
  };
  // Missing membership deliberately yields no permissions, allowing the app to persist a safe failure.
  if (!actor.permissions.has("richtfest-os:use")) actor.permissions.clear();
  return knowledgeDeps(db, { actor } as unknown as Request);
}

export async function startSupervisorWorker(db: Database, pool: Pool, options: {
  enabled?: boolean;
  resolveDeps?: (tenantId: string, actorId: string) => Promise<AppDeps>;
  databaseUrl?: string;
} = {}) {
  if (!(options.enabled ?? env.AGENT_SUPERVISOR_ENABLED)) return { stop: async () => {} };
  const { createMastraStorage, createSupervisorWorkflowRuntime } = await import("./agent-runtime/mastra-workflow");
  const storage = createMastraStorage(options.databaseUrl ?? env.DATABASE_URL);
  const resolveDeps = options.resolveDeps ?? ((tenantId, actorId) => backgroundKnowledgeDeps(db, tenantId, actorId));
  let stopping = false;
  let current: Promise<void> | undefined;
  async function tick() {
    const pending = await listPendingSupervisors(db, 3);
    await Promise.allSettled(pending.map(async entry => {
      const connection = await pool.connect();
      let locked = false;
      try {
        // A session lock spans framework checkpoints and coordinates replicas without Redis.
        const result = await connection.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as locked", [`richtfest-supervisor:${entry.runId}`]);
        locked = result.rows[0]?.locked === true;
        if (!locked || stopping) return;
        const runtime = createSupervisorWorkflowRuntime({ storage, advance: async runId => {
          const deps = await resolveDeps(entry.tenantId, entry.actorId);
          const before = await supervisorProgress(deps, runId);
          if (before.generation !== entry.generation || !["queued", "running"].includes(before.status)) return { done: true };
          if (stopping) throw new Error("Worker is shutting down");
          await stepSupervisor(deps, runId);
          const after = await supervisorProgress(deps, runId);
          return { done: after.generation !== entry.generation || !["queued", "running"].includes(after.status) };
        } });
        await runtime.execute(entry.runId, entry.generation);
      } finally {
        if (locked) await connection.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`richtfest-supervisor:${entry.runId}`]).catch(() => undefined);
        connection.release();
      }
    }));
  }
  const schedule = () => {
    if (stopping || current) return;
    current = tick().catch(() => console.error("Supervisor worker could not dispatch work; check database and runtime migrations.")).finally(() => { current = undefined; });
  };
  const timer = setInterval(schedule, 1500);
  timer.unref();
  schedule();
  return { stop: async () => { stopping = true; clearInterval(timer); await current; await storage.close(); } };
}
