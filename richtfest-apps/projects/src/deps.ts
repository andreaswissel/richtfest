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
  requirePermission: (key: PermissionKey) => void;
  audit: (
    tx: any,
    action: string,
    entityType: string,
    entityId: string,
    metadata?: unknown,
  ) => Promise<void>;
  validateCustomer: (customerId: string) => Promise<boolean>;
  customerNames: (customerIds: string[]) => Promise<Record<string, string>>;
  fileStorage: FileStorage;
  geoapifyApiKey?: string;
};

/** Background worker has no request actor. OS supplies system-scoped audit. */
export type LocationWorkerDeps = {
  db: any;
  audit: (tx: any, tenantId: string, action: string, projectId: string, metadata?: unknown) => Promise<void>;
  reportError: () => void;
};

export type SourceExtractionDeps = {
  db: any;
  fileStorage: Pick<FileStorage, "read">;
  audit: (tx: any, tenantId: string, action: string, versionId: string, metadata?: unknown) => Promise<void>;
  reportError: () => void;
};

export type SourceModelDeps = SourceExtractionDeps & {
  structureDocument: (input: DocumentModelInput) => Promise<DocumentModelResult>;
};
