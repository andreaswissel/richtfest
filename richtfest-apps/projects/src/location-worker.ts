import { and, eq, or, sql, getTableColumns } from "drizzle-orm";
import type { LocationContext, LocationTreeDetection } from "@richtfest/shared";
import { projectLocations as locations } from "./schema";
import type { LocationWorkerDeps } from "./deps";
import { contextFromPublicData, importLocationContext } from "./location-context";
import { fetchLocationLidar } from "./location-lidar";
import { withoutCadastreDuplicates } from "./location-trees";
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
  let result: Record<string, unknown>, detection: LocationTreeDetection | null = null;
  try {
    if (kind === "context") {
      if (!row.requestedAddress) throw new Error("Site address missing; save an address in project details and retry import");
      let context: LocationContext;
      if (row.context?.publicReleases?.length) {
        if (!d.publicDataSnapshot) throw new Error("Location context public data refresh is disabled");
        const snapshot = await d.publicDataSnapshot(row.context.origin, row.context.radius);
        if (!snapshot) throw new Error("Location context public data no longer covers the pinned site");
        // Refresh preserves the exact coordinate frame used by planning objects and LiDAR.
        context = contextFromPublicData(snapshot, row.context);
      } else context = await importLocationContext(row.requestedAddress, jobSignal, d.publicDataSnapshot);
      result = { context, contextStatus: "ready", contextError: null };
    }
    else {
      if (!row.context) throw new Error("Location context missing; import first");
      const lidar = await fetchLocationLidar(row.context, jobSignal);
      result = { cloud: lidar.cloud, lidarStatus: "ready", lidarError: null };
      detection = lidar.treeDetection;
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
    // Detected trees live on the context; merge against the current row so a LiDAR run and a
    // public-data refresh finishing in either order keep both, re-deduped against cadastre trees.
    const [current] = await tx.select({ context: locations.context }).from(locations).where(and(eq(locations.projectId, row.projectId), eq(locations.tenantId, row.tenantId), eq(locations.leaseToken, token))).for("update");
    const latest = current?.context as LocationContext | null | undefined, sameSite = (a?: LocationContext | null, b?: LocationContext | null) => !!a && !!b && a.siteId === b.siteId && a.origin.every((v, i) => v === b.origin[i]);
    if (detection && sameSite(latest, row.context)) result.context = { ...latest!, treeDetection: withoutCadastreDuplicates(detection, latest!.trees) };
    const refreshed = result.context as LocationContext | undefined;
    if (kind === "context" && refreshed && latest?.treeDetection && sameSite(latest, refreshed)) result.context = { ...refreshed, treeDetection: withoutCadastreDuplicates(latest.treeDetection, refreshed.trees) };
    const [saved] = await tx.update(locations).set({ ...result, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(locations.projectId, row.projectId), eq(locations.tenantId, row.tenantId), eq(locations.leaseToken, token))).returning({ projectId: locations.projectId });
    const context = kind === "context" ? result.context as LocationContext | undefined : undefined;
    if (saved && detection) await d.audit(tx, row.tenantId, "projects.location.trees.detected", row.projectId, { method: detection.method, sourceUrl: detection.sourceUrl, detectedTrees: (result.context as LocationContext | undefined)?.treeDetection?.trees.length ?? 0 });
    if (saved) await d.audit(tx, row.tenantId, `projects.location.${kind}.${kind === "context" ? result.contextStatus : result.lidarStatus}`, row.projectId,
      context?.publicReleases ? { publicReleaseIds: context.publicReleases.map(r => r.releaseId), previousPublicReleaseIds: (row.context as LocationContext | null)?.publicReleases?.map(r => r.releaseId) ?? [] } : undefined);
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
