import { Readable } from "node:stream";
import type { Request } from "express";
import type { AppDeps, WorkerDeps } from "@richtfest/public-data/deps";
import type { Database } from "./db/client";
import { fileStorage } from "./app-hosts";
import { HttpError, type Actor } from "./middleware/auth";
import { env } from "./env";

export function publicDataDeps(db: Database, req: Request): AppDeps {
  const actor = (req as any).actor as Actor;
  return { db, enabled: env.PUBLIC_DATA_ENABLED, canRefreshProjectContext: actor.permissions.has("projects:write"), requirePermission: permission => {
    if (!actor.permissions.has(permission)) throw new HttpError(403, "forbidden", `Permission ${permission} is required`);
  } };
}
export function publicDataWorkerDeps(db: Database): WorkerDeps {
  return {
    db, fetch: globalThis.fetch,
    saveRaw: async (key, bytes, mimeType, signal) => {
      if (fileStorage.kind === "bucket") {
        // Reuse the private Railway Bucket's direct-upload contract, not its local-only stream adapter.
        const upload = await fileStorage.initiate(key, mimeType, "");
        const result = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.headers, body: Buffer.from(bytes), signal, redirect: "error" });
        await result.body?.cancel();
        if (!result.ok) throw new Error("Public data evidence upload failed");
      } else {
        signal.throwIfAborted();
        await fileStorage.saveStream(key, Readable.from([bytes]), mimeType);
      }
    },
    reportError: () => console.error("Public data worker database operation failed; will retry"),
  };
}
