import { sql } from "drizzle-orm";
import type { Database } from "./db/client";

// Ephemeral abort handles only; authoritative cancellation and generation live in Postgres.
const controllers = new Map<string, Set<AbortController>>();
export function cancelSupervisorExecution(runId: string) {
  for (const controller of controllers.get(runId) ?? []) controller.abort();
}

export async function withSupervisorCancellation<T>(db: Database, tenantId: string, actorId: string, runId: string, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const active = controllers.get(runId) ?? new Set<AbortController>();
  active.add(controller);
  controllers.set(runId, active);
  const state = async () => {
    const result = await db.execute(sql`select r.status, coalesce(s.generation, r.generation) as generation
      from knowledge_agent_runs r
      left join knowledge_supervisor_runs s on s.run_id=coalesce(r.parent_run_id,r.id) and s.tenant_id=r.tenant_id
      where r.id=${runId} and r.tenant_id=${tenantId}`);
    return result.rows[0] as { status: string; generation: number } | undefined;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const access = await db.execute(sql`select rp.permission from os_memberships m
      join os_roles role on role.id=m.role_id and role.tenant_id=m.tenant_id
      join os_role_permissions rp on rp.role_id=role.id
      where m.tenant_id=${tenantId} and m.user_id=${actorId} and m.status='active'`);
    const permissions = new Set(access.rows.map(row => row.permission));
    if (!["richtfest-os:use", "agent:run", "knowledge:read", "knowledge:write", "projects:read"].every(key => permissions.has(key))) throw new Error("Supervisor access is no longer available");
    const initial = await state();
    if (!initial || initial.status !== "running") throw new Error("Supervisor execution is no longer active");
    let checking = false;
    timer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void state().then(current => {
        if (!current || current.status !== "running" || current.generation !== initial.generation) controller.abort();
      }).catch(() => controller.abort()).finally(() => { checking = false; });
    }, 500);
    timer.unref();
    controller.signal.throwIfAborted();
    return await execute(controller.signal);
  } finally {
    if (timer) clearInterval(timer);
    active.delete(controller);
    if (!active.size) controllers.delete(runId);
  }
}
