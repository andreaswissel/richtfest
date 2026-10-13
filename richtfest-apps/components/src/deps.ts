import type { PermissionKey } from "@richtfest/shared";
export type AppDeps = {
  db: any; tenantId: string; actorId: string; canImport: boolean; canReview: boolean;
  requirePermission: (key: PermissionKey) => void;
  audit: (tx: any, action: string, entityType: string, entityId: string, metadata?: unknown) => Promise<void>;
  storePdf: (stream: NodeJS.ReadableStream, componentId: string, sha256: string, pages: number) => Promise<{ storageKey: string; sizeBytes: number }>;
  removePdf: (key: string) => Promise<void>;
  readPdf: (key: string) => Promise<AsyncIterable<Uint8Array> | null>;
};
