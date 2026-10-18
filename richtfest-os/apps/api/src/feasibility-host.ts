import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { formatProjectAddress } from "@richtfest/shared";
import type { AppDeps } from "@richtfest/feasibility/deps";
import { projects } from "@richtfest/projects/schema";
import { readFeasibilitySiteFigures } from "@richtfest/projects/building-model";
import { HttpError, type Actor } from "./middleware/auth";
import { recordAudit } from "./audit";
import type { Database } from "./db/client";
import { projectsDeps } from "./app-hosts";

/** Feasibility studies are a project view: access follows projects:read / projects:write in the actor's tenant. */
export function feasibilityDeps(db: Database, req: Request): AppDeps {
  const actor = (req as any).actor as Actor;
  return {
    db, tenantId: actor.tenantId, actorId: actor.id,
    requirePermission: key => { if (!actor.permissions.has(key)) throw new HttpError(403, "forbidden", `Permission ${key} is required`); },
    can: key => actor.permissions.has(key),
    audit: (tx, action, type, id, metadata) => recordAudit(tx, actor.id, actor.tenantId, action, type, id, metadata),
    project: async projectId => {
      const [row] = await db.select({ id: projects.id, name: projects.name, street: projects.street, postalCode: projects.postalCode, city: projects.city, country: projects.country })
        .from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, actor.tenantId))).limit(1);
      return row ? { id: row.id, name: row.name, address: formatProjectAddress(row) || null } : null;
    },
    siteFigures: projectId => readFeasibilitySiteFigures(projectsDeps(db, req), projectId),
  };
}
