import type { FeasibilitySiteFigures, FeatureFlagKey, PermissionKey } from "@richtfest/shared";

/** A resolved site: its state register and the address point in EPSG:25833, the assessment's frame. */
export type AssessmentSite = { region: "BE" | "HH"; address: string; origin: [number, number]; sources: { label: string; url: string }[] };

/** What the feasibility app needs from Richtfest OS, adapted by richtfest-os/apps/api/src/feasibility-host.ts. */
export type AppDeps = {
  evidence?: import("./evidence").EvidenceHost;
  db: any;
  tenantId: string;
  actorId: string;
  requirePermission: (key: PermissionKey) => void;
  can: (key: PermissionKey) => boolean;
  /** Whether a per-user feature flag is enabled for the actor in this tenant, read live from Richtfest OS. */
  featureEnabled: (flag: FeatureFlagKey) => Promise<boolean>;
  audit: (tx: any, action: string, entityType: string, entityId: string, metadata?: unknown) => Promise<void>;
  /** The project's name and address in this tenant, or null when it does not exist here. */
  project: (projectId: string, tx?: any) => Promise<{ id: string; name: string; address: string | null } | null>;
  /** Approved parcel area, Bebauungsplan GRZ/GFZ and existing Geschossfläche from the project's building model. */
  /** Exact Berlin or Hamburg address resolution, supplied by the host. No project geometry is changed. */
  resolveSite?: (projectId: string, signal: AbortSignal) => Promise<AssessmentSite>;
  /** Berlin TrueDOP orthophoto (JPEG) for a square window around an EPSG:25833 point, cached by the host. */
  aerialImage?: (projectId: string, origin: [number, number], halfWidth: number) => Promise<{ body: Buffer; stale: boolean; fetchedAt: Date; freshUntil: Date; attribution: string }>;
  siteFigures: (projectId: string) => Promise<FeasibilitySiteFigures>;
};
