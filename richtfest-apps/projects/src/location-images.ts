import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import type { AppDeps } from "./deps";
import { locationImages as images } from "./schema";
import { boundedBody } from "./location-context";

const WEEK = 7 * 24 * 60 * 60_000;
const MAX_BYTES = 16 * 1024 * 1024;
const unavailable = (retryAt?: Date | null) => Object.assign(new Error("The imagery service is temporarily unavailable"), {
  status: 503, code: "imagery_unavailable", retryAt,
});

/** The URL is built by the location router from an allowlisted WMS, never from user input. */
export async function cachedLocationImage(d: AppDeps, projectId: string, url: URL, mimeType: string, attribution: string) {
  if (d.fileStorage.kind === "unconfigured") throw unavailable();
  url.searchParams.sort();
  const sourceUrl = url.href;
  const requestHash = createHash("sha256").update(`wms-image-v1\n${sourceUrl}`).digest("hex");
  const scope = and(eq(images.tenantId, d.tenantId), eq(images.requestHash, requestHash));
  const deadline = Date.now() + 50_000;

  while (Date.now() < deadline) {
    const [row] = await d.db.select().from(images).where(scope) as Array<typeof images.$inferSelect>;
    if (!row) {
      await d.db.transaction(async (tx: any) => {
        const [created] = await tx.insert(images).values({ tenantId: d.tenantId, requestHash, sourceUrl, attribution, mimeType })
          .onConflictDoNothing().returning();
        if (created) await d.audit(tx, "projects.location_image.queued", "project", projectId, { imageId: created.id });
      });
      continue;
    }

    // Buffer before sending: a missing/incomplete object must not produce a broken 200 response.
    let saved: Buffer | undefined;
    if (row.storageKey) {
      try {
        const stream = await d.fileStorage.read(row.storageKey, AbortSignal.timeout(15_000));
        if (stream) {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of stream) {
            size += chunk.byteLength;
            if (size > MAX_BYTES) throw new Error("Stored imagery exceeds its import budget");
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          if (bytes.length === row.sizeBytes && createHash("sha256").update(bytes).digest("hex") === row.checksum) saved = bytes;
        }
      } catch (error) {
        // Local storage can retain metadata after the blob is removed. Other storage outages
        // must not turn every viewer into another upstream download.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
      }
    }
    const result = (body: Buffer, stale: boolean) => ({ body, stale, fetchedAt: row.fetchedAt!, freshUntil: row.freshUntil! });
    if (saved && row.freshUntil && row.freshUntil.getTime() > Date.now()) return result(saved, false);
    if (row.retryAt && row.retryAt.getTime() > Date.now()) {
      if (saved) return result(saved, true);
      throw unavailable(row.retryAt);
    }

    const token = randomUUID();
    const claimed = await d.db.transaction(async (tx: any) => {
      const [claim] = await tx.update(images).set({ leaseToken: token, leaseUntil: sql`now() + interval '90 seconds'` })
        .where(and(scope, sql`(${images.leaseUntil} is null or ${images.leaseUntil} <= now())`,
          sql`(${images.retryAt} is null or ${images.retryAt} <= now())`,
          sql`${images.storageKey} is not distinct from ${row.storageKey}`)).returning();
      if (claim) await d.audit(tx, "projects.location_image.started", "project", projectId, { imageId: row.id });
      return Boolean(claim);
    });
    if (!claimed) {
      if (saved) return result(saved, true);
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }

    const owned = and(scope, eq(images.leaseToken, token), sql`${images.leaseUntil} > now()`);
    const storageKey = `${d.tenantId}/${row.id}/${requestHash}/${token}`;
    let published = false;
    let retryAfter = 0;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45_000), redirect: "error" });
      const retry = response.headers.get("retry-after");
      if (retry) {
        const until = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
        if (Number.isFinite(until) && until < 8.64e15) retryAfter = until;
      }
      if (!response.ok || !response.headers.get("content-type")?.startsWith(mimeType)) {
        await response.body?.cancel();
        throw unavailable();
      }
      const body = await boundedBody(response, MAX_BYTES);
      // WMS services sometimes return an XML error with an image content type.
      const valid = mimeType === "image/jpeg" ? body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
        : body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (!valid) throw unavailable();
      const stored = await d.fileStorage.saveStream(storageKey, Readable.from([body]), mimeType);
      const fetchedAt = new Date(), freshUntil = new Date(fetchedAt.getTime() + WEEK);
      published = await d.db.transaction(async (tx: any) => {
        const [updated] = await tx.update(images).set({ storageKey, ...stored, fetchedAt, freshUntil,
          failures: 0, retryAt: null, leaseToken: null, leaseUntil: null }).where(owned).returning();
        if (updated) await d.audit(tx, "projects.location_image.saved", "project", projectId,
          { imageId: row.id, checksum: stored.checksum, sizeBytes: stored.sizeBytes });
        return Boolean(updated);
      });
      if (published) {
        if (row.storageKey) await d.fileStorage.remove(row.storageKey).catch(() => {});
        return { body, stale: false, fetchedAt, freshUntil };
      }
    } catch {
      const retryAt = new Date(Math.max(retryAfter, Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(row.failures, 6))));
      await d.db.transaction(async (tx: any) => {
        const [updated] = await tx.update(images).set({ failures: sql`${images.failures} + 1`, retryAt,
          leaseToken: null, leaseUntil: null }).where(owned).returning();
        if (updated) await d.audit(tx, "projects.location_image.failed", "project", projectId, { imageId: row.id, retryAt });
      });
      if (saved) return result(saved, true);
      throw unavailable(retryAt);
    } finally {
      if (!published) await d.fileStorage.remove(storageKey).catch(() => {});
    }
    // An expired lease cannot publish. Read the new owner's result instead.
  }
  throw unavailable(new Date(Date.now() + 1000));
}
