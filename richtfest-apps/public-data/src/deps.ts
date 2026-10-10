import type { PermissionKey } from "@richtfest/shared";

export type WorkerDeps = {
  db: any;
  saveRaw: (key: string, bytes: Uint8Array, mimeType: string, signal: AbortSignal) => Promise<void>;
  fetch: typeof globalThis.fetch;
  reportError: () => void;
};
export type AppDeps = {
  db: any;
  enabled: boolean;
  canRefreshProjectContext: boolean;
  requirePermission: (permission: PermissionKey) => void;
};
