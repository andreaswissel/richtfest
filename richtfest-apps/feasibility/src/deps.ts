import type { FeasibilitySiteFigures, PermissionKey } from "@richtfest/shared";

/** What the feasibility app needs from Richtfest OS, adapted by richtfest-os/apps/api/src/feasibility-host.ts. */
export type AppDeps = {
  db: any;
  tenantId: string;
  actorId: string;
  requirePermission: (key: PermissionKey) => void;
  can: (key: PermissionKey) => boolean;
  audit: (tx: any, action: string, entityType: string, entityId: string, metadata?: unknown) => Promise<void>;
  /** The project's name and address in this tenant, or null when it does not exist here. */
  project: (projectId: string) => Promise<{ id: string; name: string; address: string | null } | null>;
  /** Approved parcel area, Bebauungsplan GRZ/GFZ and existing Geschossfläche from the project's building model. */
  siteFigures: (projectId: string) => Promise<FeasibilitySiteFigures>;
};
