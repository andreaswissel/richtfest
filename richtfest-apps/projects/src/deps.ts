import type { PermissionKey, DocumentModelInput, DocumentModelResult } from "@richtfest/shared";
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
  /** Domain that receives forwarded email (for example in.richtfest.ai); unset when inbound email is not configured. */
  inboundEmailDomain?: string | null;
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
