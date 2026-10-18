import { createFeasibilityEvidenceHost } from "./feasibility-evidence-host";
import { resolveLocationAddress } from "@richtfest/projects/location-context";
import { aerialWindow } from "@richtfest/projects/location-images";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { aerialSourceFor, formatProjectAddress } from "@richtfest/shared";
import type { AppDeps } from "@richtfest/feasibility/deps";
import { projects } from "@richtfest/projects/schema";
import { readFeasibilitySiteFigures } from "@richtfest/projects/building-model";
import { HttpError, type Actor } from "./middleware/auth";
import { recordAudit } from "./audit";
import { hasFeatureFlag } from "./feature-flags";
import type { Database } from "./db/client";
import { projectsDeps } from "./app-hosts";

/** Feasibility studies are a project view: access follows projects:read / projects:write in the actor's tenant. */
export function feasibilityDeps(db: Database, req: Request): AppDeps {
  const actor = (req as any).actor as Actor;
  return {
    db, tenantId: actor.tenantId, actorId: actor.id,
    evidence: createFeasibilityEvidenceHost(db, projectsDeps(db, req)),
    requirePermission: key => { if (!actor.permissions.has(key)) throw new HttpError(403, "forbidden", `Permission ${key} is required`); },
    can: key => actor.permissions.has(key),
    featureEnabled: flag => hasFeatureFlag(db, actor.tenantId, actor.id, flag),
    audit: (tx, action, type, id, metadata) => recordAudit(tx, actor.id, actor.tenantId, action, type, id, metadata),
    project: async (projectId, tx) => {
      const query = (tx ?? db).select({ id: projects.id, name: projects.name, street: projects.street, postalCode: projects.postalCode, city: projects.city, country: projects.country })
        .from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, actor.tenantId))).limit(1);
      const [row] = await (tx ? query.for("key share") : query);
      return row ? { id: row.id, name: row.name, address: formatProjectAddress(row) || null } : null;
    },
    resolveBerlinSite: async (projectId, signal) => {
      const [row] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, actor.tenantId))).limit(1);
      if (!row) throw new HttpError(404, "not_found", "Project not found");
      if (row.city?.trim().toLowerCase() !== "berlin") throw new HttpError(422, "berlin_address_required", "Save a complete Berlin site address in project details first");
      try {
        return await resolveLocationAddress(row, signal);
      } catch (error) {
        if (signal.aborted || !(error instanceof Error)) throw error;
        // Address-register messages tell the user what to fix in project details; keep them instead of a generic 500.
        if (/unavailable|invalid coordinates|retry/i.test(error.message)) throw new HttpError(502, "site_address_service_unavailable", error.message);
        throw new HttpError(422, "site_address_unresolved", error.message);
      }
    },
    aerialImage: async (projectId, origin, halfWidth) => {
      const source = aerialSourceFor({ siteId: "berlin-assessment", crs: "EPSG:25833" })!;
      const image = await aerialWindow(projectsDeps(db, req), projectId, source.id, "EPSG:25833", origin, halfWidth, 2048, source.attribution);
      return { ...image, attribution: source.attribution };
    },
    siteFigures: projectId => readFeasibilitySiteFigures(projectsDeps(db, req), projectId),
  };
}
