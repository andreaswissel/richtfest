import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { SupportProposal, SupportSource } from "@richtfest/shared";

export const supportConversations = pgTable("support_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  createdBy: uuid("created_by").notNull(),
  title: text("title").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => ({ owner: index("support_conversations_owner").on(t.tenantId, t.createdBy, t.createdAt) }));

export const supportMessages = pgTable("support_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull().references(() => supportConversations.id),
  requestId: uuid("request_id"),
  role: text("role").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("completed"),
  openui: text("openui"),
  proposal: jsonb("proposal").$type<SupportProposal>(),
  sources: jsonb("sources").$type<SupportSource[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => ({ conversation: index("support_messages_conversation").on(t.conversationId, t.createdAt), request: uniqueIndex("support_messages_request").on(t.requestId) }));

export const supportReports = pgTable("support_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  createdBy: uuid("created_by").notNull(),
  conversationId: uuid("conversation_id").references(() => supportConversations.id),
  messageId: uuid("message_id").references(() => supportMessages.id),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  pagePath: text("page_path"),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => ({ tenant: index("support_reports_tenant").on(t.tenantId, t.id), message: uniqueIndex("support_reports_message").on(t.messageId) }));
