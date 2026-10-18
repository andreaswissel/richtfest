import { pgTable, uuid, text, timestamp, boolean, primaryKey, jsonb, uniqueIndex, integer } from "drizzle-orm/pg-core";

export const tenants = pgTable("os_tenants", { id: uuid("id").primaryKey().defaultRandom(), name: text("name").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const users = pgTable("os_users", { id: uuid("id").primaryKey().defaultRandom(), email: text("email").notNull().unique(), name: text("name").notNull(), uiDensity: text("ui_density").notNull().default("dense"), language: text("language").notNull().default("en"), theme: text("theme").notNull().default("light"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const roles = pgTable("os_roles", { id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull(), name: text("name").notNull(), description: text("description") }, (t) => ({ tenantName: uniqueIndex("os_roles_tenant_name").on(t.tenantId, t.name) }));
export const permissions = pgTable("os_permissions", { key: text("key").primaryKey(), description: text("description").notNull() });
export const rolePermissions = pgTable("os_role_permissions", { roleId: uuid("role_id").notNull(), permission: text("permission").notNull() }, (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permission] }) }));
export const memberships = pgTable("os_memberships", { tenantId: uuid("tenant_id").notNull(), userId: uuid("user_id").notNull(), roleId: uuid("role_id").notNull(), status: text("status").notNull().default("active") }, (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.userId] }) }));
export const invitations = pgTable("os_invitations", { id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull(), email: text("email").notNull(), roleId: uuid("role_id").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), acceptedAt: timestamp("accepted_at", { withTimezone: true }), cancelledAt: timestamp("cancelled_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const authDevOutbox = pgTable("os_auth_dev_outbox", { id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull(), email: text("email").notNull(), url: text("url").notNull(), token: text("token").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const auditEvents = pgTable("os_audit_events", { id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull(), actorId: uuid("actor_id"), actorType: text("actor_type").notNull().default("user"), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: uuid("entity_id"), correlationId: uuid("correlation_id"), runId: uuid("run_id"), metadata: jsonb("metadata"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() });
export const aiConnections = pgTable("os_ai_connections", { id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull(), userId: uuid("user_id"), provider: text("provider").notNull(), ciphertext: text("ciphertext").notNull(), iv: text("iv").notNull(), authTag: text("auth_tag").notNull(), createdBy: uuid("created_by").notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull() });
/** Per-user feature flags (keys from `featureFlags` in @richtfest/shared). A row means enabled; enabled_by is null for operator scripts. */
export const userFeatureFlags = pgTable("os_user_feature_flags", { tenantId: uuid("tenant_id").notNull(), userId: uuid("user_id").notNull(), flag: text("flag").notNull(), enabledBy: uuid("enabled_by"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull() }, (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.userId, t.flag] }) }));
export const osAgentSettings = pgTable("os_agent_settings", { tenantId: uuid("tenant_id").primaryKey(), provider: text("provider").notNull().default("openai"), updatedBy: uuid("updated_by").notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull() });

export const agentPresets = pgTable("os_agent_presets", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  provider: text("provider").notNull(),
  effort: text("effort").notNull(),
  version: integer("version").notNull().default(1),
  config: jsonb("config"),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ scope: uniqueIndex("os_agent_presets_scope").on(t.tenantId, t.provider, t.effort) }));
