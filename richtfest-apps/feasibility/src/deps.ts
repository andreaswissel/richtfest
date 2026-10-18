import type { FeasibilitySiteFigures, PermissionKey } from "@richtfest/shared";

/** What the feasibility app needs from Richtfest OS, adapted by richtfest-os/apps/api/src/feasibility-host.ts. */
export type AppDeps = {
  evidence?: import("./evidence").EvidenceHost;
  db: any;
  tenantId: string;
  actorId: string;
  requirePermission: (key: PermissionKey) => void;
  can: (key: PermissionKey) => boolean;
  audit: (tx: any, action: string, entityType: string, entityId: string, metadata?: unknown) => Promise<void>;
  /** The project's name and address in this tenant, or null when it does not exist here. */
  project: (projectId: string, tx?: any) => Promise<{ id: string; name: string; address: string | null } | null>;
  /** Approved parcel area, Bebauungsplan GRZ/GFZ and existing Geschossfläche from the project's building model. */
  /** Exact Berlin address resolution, supplied by the host. No project geometry is changed. */
  resolveBerlinSite?: (projectId: string, signal: AbortSignal) => Promise<{ address: string; origin: [number, number]; sources: { label: string; url: string }[] }>;
  siteFigures: (projectId: string) => Promise<FeasibilitySiteFigures>;
};
