import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import type { ComponentInput } from "@richtfest/shared";
export const documents = pgTable("components_documents", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull(), componentId: uuid("component_id").notNull(),
  sha256: text("sha256").notNull(), pages: integer("pages").notNull(), sizeBytes: text("size_bytes").notNull(),
  storageKey: text("storage_key").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => ({ identity: uniqueIndex("components_document_hash").on(t.tenantId, t.componentId, t.sha256) }));
export const components = pgTable("components_components", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull(), key: text("key").notNull(),
  currentRevisionId: uuid("current_revision_id"), createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => ({ identity: uniqueIndex("components_tenant_key").on(t.tenantId, t.key) }));
export const revisions = pgTable("components_revisions", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull(), componentId: uuid("component_id").notNull(),
  revision: integer("revision").notNull(), data: jsonb("data").$type<ComponentInput>().notNull(), fingerprint: text("fingerprint").notNull(),
  reviewStatus: text("review_status").$type<"unreviewed" | "reviewed" | "rejected">().default("unreviewed").notNull(),
  reviewVersion: integer("review_version").default(0).notNull(), reviewNote: text("review_note"), reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }), createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => ({ numbered: uniqueIndex("components_revision_number").on(t.tenantId, t.componentId, t.revision), history: index("components_revision_history").on(t.tenantId, t.componentId) }));
