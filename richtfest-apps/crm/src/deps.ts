import type { PermissionKey } from "@richtfest/shared";
export type AppDeps = { db: any; tenantId: string; actorId: string; requirePermission: (key: PermissionKey) => void; audit: (tx: any, action: string, entityType: string, entityId: string, metadata?: unknown) => Promise<void> };
