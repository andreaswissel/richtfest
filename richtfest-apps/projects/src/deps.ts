import type {
  AcousticCalculationInput, AcousticCalculationResult, PermissionKey, DocumentModelInput, DocumentModelResult, ExteriorNoiseLevel, RatingLevelContribution, RoadNoiseReceiver, RoadNoiseSource, RoadRatingLevel,
} from "@richtfest/shared";
export type StoredObject = {
  sizeBytes: number;
  checksum: string;
  mimeType: string;
};
export type FileStorage = {
  kind: "local" | "bucket" | "unconfigured";
  initiate: (
    key: string,
    mimeType: string,
    localUploadUrl: string,
  ) => Promise<{
    uploadUrl: string;
    headers: Record<string, string>;
    expiresAt: string;
  }>;
  saveStream: (
    key: string,
    stream: NodeJS.ReadableStream,
    mimeType: string,
  ) => Promise<StoredObject>;
  head: (key: string) => Promise<StoredObject | null>;
  remove: (key: string) => Promise<void>;
  download: (
    key: string,
    mimeType: string,
    localDownloadUrl: string,
  ) => Promise<{
    redirectUrl?: string;
    stream?: NodeJS.ReadableStream;
    sizeBytes?: number;
  } | null>;
  read: (key: string, signal?: AbortSignal) => Promise<AsyncIterable<Uint8Array> | null>;
};
export type AppDeps = {
  db: any;
  tenantId: string;
  actorId: string;
  publicDataUpdates?: (releaseIds: string[]) => Promise<import("@richtfest/shared").PublicDataUpdate[]>;
  /** Imported file-published traffic counts (BASt, state road authorities) overlapping a WGS84 [west, south, east, north] box. */
  trafficCounts?: (bbox: [number, number, number, number]) => Promise<import("@richtfest/shared").TrafficCountRecord[]>;
  requirePermission: (key: PermissionKey) => void;
  audit: (
    tx: any,
    action: string,
    entityType: string,
    entityId: string,
    metadata?: unknown,
  ) => Promise<void>;
  /** Delete linked app records in the supplied transaction; return private object keys. */
  deleteLinkedProjectData?: (tx: any, projectId: string, sourceIds: string[]) => Promise<string[]>;
  validateCustomer: (customerId: string) => Promise<boolean>;
  customerNames: (customerIds: string[]) => Promise<Record<string, string>>;
  fileStorage: FileStorage;
  geoapifyApiKey?: string;
  /** OpenStreetMap Nominatim for site address points in states without open house coordinates (BY, MV, SH); null when disabled. */
  nominatim?: { url: string; userAgent: string } | null;
  /** Domain that receives forwarded email (for example in.richtfest.ai); unset when inbound email is not configured. */
  inboundEmailDomain?: string | null;
  /** Road noise (RLS-19) and relevant exterior noise levels (DIN 4109-2); null when no acoustic norm pack is configured. */
  exteriorNoise?: {
    packId: string;
    editions: { rls19: string; din4109: string };
    turnedAwayReductionDb: { open: number; closed: number };
    roadRatingLevels: (sources: RoadNoiseSource[], receivers: RoadNoiseReceiver[]) => RoadRatingLevel[];
    exteriorNoiseLevel: (contributions: RatingLevelContribution[]) => ExteriorNoiseLevel | null;
    /** Rw of a single-leaf massive wall from the component catalogue; absent when the pack has no catalogue. */
    massiveWallRw?: (input: import("@richtfest/shared").MassiveWallInput) => import("@richtfest/shared").MassiveWallRw;
  } | null;
  /** Interior sound methods and requirements from the norm pack; absent when the pack has no interior part or component catalogue. */
  interiorSound?: {
    editions: { requirements: string; method: string; junctions: string; screeds: string; catalogue: string };
    wallRequirement: (role: import("@richtfest/shared").InteriorWallRole) => { rwMinDb: number; ref: string } | null;
    ceilingRequirement: (role: import("@richtfest/shared").InteriorCeilingRole) => { rwMinDb: number | null; lnwMaxDb: number | null; ref: string } | null;
    massiveRw: (input: import("@richtfest/shared").MassiveWallInput) => import("@richtfest/shared").MassiveWallRw;
    airborne: (input: import("@richtfest/shared").AirborneInput) => import("@richtfest/shared").AirborneResult;
    impact: (input: import("@richtfest/shared").ImpactInput) => import("@richtfest/shared").ImpactResult;
  } | null;
  /** The deterministic acoustic calculator (DIN 4109 exterior noise verification), shared with the knowledge app. */
  calculateAcoustics?: (input: AcousticCalculationInput) => AcousticCalculationResult;
};

/** Receiving email runs without a request actor; the OS verifies the provider webhook and supplies system-scoped audit. */
export type InboundEmailDeps = {
  db: any;
  fileStorage: FileStorage;
  domain: string;
  audit: (tx: any, tenantId: string, action: string, entityType: string, entityId: string, metadata?: unknown) => Promise<void>;
  /** Email addresses of the tenant's active members, to tell their own CCs from replies. */
  memberEmails: (tenantId: string) => Promise<string[]>;
};

/** Background worker has no request actor. OS supplies system-scoped audit. */
export type LocationWorkerDeps = {
  db: any;
  publicDataSnapshot?: (origin: [number, number], radius: number) => Promise<import("@richtfest/shared").PublicDataSnapshot | null>;
  audit: (tx: any, tenantId: string, action: string, projectId: string, metadata?: unknown) => Promise<void>;
  reportError: () => void;
};

export type SourceExtractionDeps = {
  db: any;
  fileStorage: Pick<FileStorage, "read">;
  /** Optional OS-owned TypeSafe adapter. Source extraction remains complete when unavailable. */
  executeDecision?: (input: {
    tenantId: string;
    actorId: string;
    state: unknown;
    questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
    signal?: AbortSignal;
  }) => Promise<{ status: "completed"; output: unknown; usage?: unknown } | { status: "unconfigured" }>;
  audit: (tx: any, tenantId: string, action: string, versionId: string, metadata?: unknown) => Promise<void>;
  reportError: () => void;
};

export type SourceModelDeps = SourceExtractionDeps & {
  structureDocument: (input: DocumentModelInput) => Promise<DocumentModelResult>;
  classifyImage?: (input: { tenantId: string; actorId: string; projectId: string; versionId: string; page: number },
    signal?: AbortSignal) => Promise<import("@richtfest/shared").SourceImageReceipt>;
};
