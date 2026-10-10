import { and, eq, or, sql, getTableColumns } from "drizzle-orm";
import { projectLocations as locations } from "./schema";
import type { LocationWorkerDeps } from "./deps";
import { importLocationContext } from "./location-context";
import { fetchLocationLidar } from "./location-lidar";
const { cloud: _cloud, ...jobColumns } = getTableColumns(locations);

/** One bounded job per process. Lease + SKIP LOCKED coordinates API replicas.
 * Expired running jobs are reclaimed after restart, fenced by a unique token. */
export async function runLocationJob(d: LocationWorkerDeps, signal: AbortSignal): Promise<boolean> {
  const token = crypto.randomUUID();
  const claim = await d.db.transaction(async (tx: any) => {
    const [row] = await tx.select(jobColumns).from(locations).where(and(
      or(eq(locations.contextStatus, "queued"), eq(locations.contextStatus, "running"), eq(locations.lidarStatus, "queued"), eq(locations.lidarStatus, "running")),
      sql`(${locations.leaseUntil} is null or ${locations.leaseUntil} < now())`,
    )).orderBy(locations.updatedAt).limit(1).for("update", { skipLocked: true });
    if (!row) return null;
    const kind = ["queued", "running"].includes(row.contextStatus) ? "context" : "lidar";
    await tx.update(locations).set({ ...(kind === "context" ? { contextStatus: "running", contextError: null } : { lidarStatus: "running", lidarError: null }), leaseToken: token, leaseUntil: new Date(Date.now() + 10 * 60_000), updatedAt: new Date() }).where(and(eq(locations.projectId, row.projectId), eq(locations.tenantId, row.tenantId)));
    await d.audit(tx, row.tenantId, `projects.location.${kind}.started`, row.projectId);
    return { row, kind };
  });
  if (!claim) return false;
  const { row, kind } = claim;
  const jobSignal = AbortSignal.any([signal, AbortSignal.timeout(8 * 60_000)]);
  let result: Record<string, unknown>;
  try {
    if (kind === "context") result = { context: await importLocationContext(jobSignal), contextStatus: "ready", contextError: null };
    else {
      if (!row.context) throw new Error("Location context missing; import first");
      result = { cloud: await fetchLocationLidar(row.context, jobSignal), lidarStatus: "ready", lidarError: null };
    }
  } catch (error) {
    // Known importer errors contain only public source details; network/runtime
    // errors get a safe message, never credentials, response bodies or stacks.
    const message = error instanceof Error && /^(Berlin |Site |LAS |No ground|Unsupported LAS|Truncated LAS|Location context|Invalid ZIP|Missing ZIP|ZIP |Oversized |Expected LAS|Unsafe ZIP|Upstream )/.test(error.message)
      ? error.message.slice(0, 500) : "Location source import unavailable or timed out. Retry the request.";
    const status = signal.aborted ? "queued" : "failed";
    result = kind === "context" ? { contextStatus: status, contextError: signal.aborted ? null : message } : { lidarStatus: status, lidarError: signal.aborted ? null : message };
  }
  await d.db.transaction(async (tx: any) => {
    const [saved] = await tx.update(locations).set({ ...result, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(locations.projectId, row.projectId), eq(locations.tenantId, row.tenantId), eq(locations.leaseToken, token))).returning({ projectId: locations.projectId });
    if (saved) await d.audit(tx, row.tenantId, `projects.location.${kind}.${kind === "context" ? result.contextStatus : result.lidarStatus}`, row.projectId);
  });
  return true;
}

export function startLocationWorker(d: LocationWorkerDeps) {
  const controller = new AbortController();
  let active: Promise<void> | null = null;
  const tick = () => {
    if (active || controller.signal.aborted) return;
    active = runLocationJob(d, controller.signal).then(() => {}, () => d.reportError()).finally(() => { active = null; });
  };
  const timer = setInterval(tick, 2000);
  timer.unref(); tick();
  return { async stop() { clearInterval(timer); controller.abort(); await active; } };
}
