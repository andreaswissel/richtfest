import { eq, lte } from "drizzle-orm";
import type { FileStorage } from "./deps";
import { deletedProjectObjects } from "./schema";

type Deps = { db: any; fileStorage: Pick<FileStorage, "remove">; reportError: () => void };

/** Only cleanup receipts are locked; project deletion has already committed. */
export async function runProjectDeletionCleanup(d: Deps) {
  return d.db.transaction(async (tx: any) => {
    const [job] = await tx.select().from(deletedProjectObjects).where(lte(deletedProjectObjects.retryAt, new Date()))
      .orderBy(deletedProjectObjects.retryAt).limit(1).for("update", { skipLocked: true });
    if (!job) return false;
    try { await d.fileStorage.remove(job.storageKey); }
    catch {
      await tx.update(deletedProjectObjects).set({ attempts: job.attempts + 1,
        retryAt: new Date(Date.now() + Math.min(3600_000, 5000 * 2 ** Math.min(job.attempts, 10))) })
        .where(eq(deletedProjectObjects.id, job.id));
      d.reportError();
      return false;
    }
    // remove is idempotent: a crash before this commit safely retries the object.
    await tx.delete(deletedProjectObjects).where(eq(deletedProjectObjects.id, job.id));
    return true;
  });
}

export function startProjectDeletionWorker(d: Deps) {
  let active: Promise<unknown> | null = null;
  let stopped = false;
  const tick = () => {
    if (active || stopped) return;
    active = (async () => { for (let i = 0; i < 25 && !stopped; i++) if (!await runProjectDeletionCleanup(d)) break; })()
      .catch(() => d.reportError()).finally(() => { active = null; });
  };
  const timer = setInterval(tick, 2000); timer.unref(); tick();
  return { async stop() { stopped = true; clearInterval(timer); await active; } };
}
