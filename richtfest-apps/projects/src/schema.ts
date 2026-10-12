import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import type { AddressReference, LocationContext, LocationPointCloud, LocationScene, ProjectAddress } from "@richtfest/shared";

export const projectLocations = pgTable("projects_locations", {
  projectId: uuid("project_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  revision: integer("revision").notNull().default(0),
  scene: jsonb("scene").$type<LocationScene>().notNull().default({ objects: [], planningNotes: "" }),
  context: jsonb("context").$type<LocationContext>(),
  cloud: jsonb("cloud").$type<LocationPointCloud>(),
  requestedAddress: jsonb("requested_address").$type<ProjectAddress>(),
  contextStatus: text("context_status").notNull().default("idle"),
  contextError: text("context_error"),
  lidarStatus: text("lidar_status").notNull().default("idle"),
  lidarError: text("lidar_error"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ jobs: index("projects_locations_jobs").on(table.contextStatus, table.lidarStatus, table.leaseUntil) }));
export const projects = pgTable("projects_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  customerId: uuid("customer_id"),
  name: text("name").notNull(),
  street: text("street"),
  postalCode: text("postal_code"),
  city: text("city"),
  country: text("country"),
  addressReference: jsonb("address_reference").$type<AddressReference>(),
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
