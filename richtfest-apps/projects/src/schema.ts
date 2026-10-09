import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
export const projects = pgTable("projects_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  customerId: uuid("customer_id"),
  name: text("name").notNull(),
  status: text("status").notNull().default("planning"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const projectMembers = pgTable("projects_members", {
  projectId: uuid("project_id").notNull(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  access: text("access").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const files = pgTable("projects_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull(),
  name: text("name").notNull(),
  sourceType: text("source_type").notNull(),
  sourceRef: text("source_ref"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const fileVersions = pgTable(
  "projects_file_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    fileId: uuid("file_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("pending"),
    sourceMetadata: jsonb("source_metadata"),
    checksum: text("checksum"),
    storageKey: text("storage_key"),
    sizeBytes: integer("size_bytes"),
    mimeType: text("mime_type"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    fileVersion: uniqueIndex("projects_file_versions_file_version_unique").on(
      table.tenantId,
      table.fileId,
      table.version,
    ),
  }),
);
