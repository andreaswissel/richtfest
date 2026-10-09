import { z } from "zod";

export const permissionKey = z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/);
export const permissions = [
  "richtfest-os:use", "crm:read", "crm:write", "projects:read", "projects:write",
  "knowledge:read", "knowledge:write", "knowledge:approve", "agent:run", "access:manage"
] as const;
export type PermissionKey = (typeof permissions)[number];

export const authUser = z.object({ id: z.string().uuid(), email: z.string().email(), name: z.string(), tenantId: z.string().uuid() });
export type AuthUser = z.infer<typeof authUser>;
