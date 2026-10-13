import type { Request } from "express";
import type { AppDeps } from "@richtfest/components/deps";
import { HttpError, type Actor } from "./middleware/auth";
import { recordAudit } from "./audit";
import type { Database } from "./db/client";
import { storeComponentPdf } from "./component-documents";
import { fileStorage } from "./file-storage";
export function componentsDeps(db: Database, req: Request): AppDeps {
  const actor = (req as any).actor as Actor;
  return { db, tenantId: actor.tenantId, actorId: actor.id,
    canImport: actor.permissions.has("components:import"), canReview: actor.permissions.has("components:review"),
    requirePermission: key => { if (!actor.permissions.has(key)) throw new HttpError(403, "forbidden", `Permission ${key} is required`); },
    audit: (tx, action, type, id, metadata) => recordAudit(tx, actor.id, actor.tenantId, action, type, id, metadata),
    storePdf: (stream, id, sha256, pages) => storeComponentPdf(actor.tenantId, id, stream, sha256, pages),
    removePdf: key => fileStorage.remove(key),
    readPdf: key => fileStorage.read(key),
  };
}
