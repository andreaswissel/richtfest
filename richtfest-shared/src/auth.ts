import { z } from "zod";

export const permissionKey = z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/);
export const permissions = [
  "richtfest-os:use", "crm:read", "crm:write", "projects:read", "projects:write",
  "components:read", "components:import", "components:review",
  "knowledge:read", "knowledge:write", "knowledge:approve", "agent:run", "access:manage"
] as const;
export type PermissionKey = (typeof permissions)[number];

export const authUser = z.object({ id: z.string().uuid(), email: z.string().email(), name: z.string(), tenantId: z.string().uuid() });
export type AuthUser = z.infer<typeof authUser>;

/**
 * Per-user feature flags: paused or unreleased capabilities enabled for named people in their workspace.
 * A flag adds visibility and API access on top of role permissions; it never replaces them.
 */
export const featureFlags = ["feasibility_financial_study"] as const;
export type FeatureFlagKey = (typeof featureFlags)[number];
export const isFeatureFlag = (value: string): value is FeatureFlagKey => (featureFlags as readonly string[]).includes(value);
