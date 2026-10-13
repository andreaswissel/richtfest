import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
  index,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import type { AddressReference, LocationContext, LocationPointCloud, LocationScene, ProjectAddress, SourceText, SourceFactInput } from "@richtfest/shared";

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
  purpose: text("purpose").$type<"project_evidence" | "reference_report" | "comparison_only">().notNull().default("project_evidence"),
  sourceRef: text("source_ref"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, table => ({ purposeCheck: check("projects_files_purpose_check", sql`${table.purpose} in ('project_evidence', 'reference_report', 'comparison_only')`) }));
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

// Explicit full-export attestation, not engineering/content approval. Versions inherit no pairing.
export const sourceRepresentations = pgTable("projects_source_representations", {
  originalVersionId: uuid("original_version_id").primaryKey().references(() => fileVersions.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
  pdfVersionId: uuid("pdf_version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
  confirmedBy: uuid("confirmed_by").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sourceExtractions = pgTable("projects_source_extractions", {
  versionId: uuid("version_id").primaryKey().references(() => fileVersions.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
  status: text("status").notNull().default("queued"),
  nextPage: integer("next_page").notNull().default(1),
  attempts: integer("attempts").notNull().default(0),
  result: jsonb("result").$type<SourceText>(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ jobs: index("projects_source_extractions_jobs").on(table.status, table.leaseUntil) }));

export const sourcePages = pgTable("projects_source_pages", {
  versionId: uuid("version_id").notNull().references(() => sourceExtractions.versionId, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
  page: integer("page").notNull(),
  content: jsonb("content").$type<SourceText>().notNull(),
}, table => ({ key: primaryKey({ columns: [table.versionId, table.page] }) }));

export const sourceModels = pgTable("projects_source_models", {
  versionId: uuid("version_id").primaryKey().references(() => fileVersions.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
  status: text("status").notNull().default("queued"),
  method: text("method"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ jobs: index("projects_source_models_jobs").on(table.status, table.leaseUntil) }));

export const sourceEntities = pgTable("projects_source_entities", {
  versionId: uuid("version_id").notNull().references(() => sourceModels.versionId, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
  key: text("key").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  globalId: text("global_id"),
}, table => ({ key: primaryKey({ columns: [table.versionId, table.key] }) }));

export const sourceFacts = pgTable("projects_source_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id").notNull(),
  tenantId: uuid("tenant_id").notNull(),
  entityKey: text("entity_key").notNull(),
  predicate: text("predicate").notNull(),
  kind: text("kind").notNull(),
  value: jsonb("value").$type<SourceFactInput["value"]>().notNull(),
  unit: jsonb("unit").$type<SourceFactInput["unit"]>(),
  provenance: text("provenance").notNull(),
  evidence: jsonb("evidence").$type<SourceFactInput["evidence"]>().notNull(),
  reviewStatus: text("review_status").notNull().default("unreviewed"),
  reviewRevision: integer("review_revision").notNull().default(0),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNote: text("review_note"),
}, table => ({
  entity: foreignKey({ columns: [table.versionId, table.entityKey], foreignColumns: [sourceEntities.versionId, sourceEntities.key] }).onDelete("cascade"),
  lookup: index("projects_source_facts_lookup").on(table.tenantId, table.versionId, table.entityKey),
  search: index("projects_source_facts_search").using("gin", sql`to_tsvector('simple', regexp_replace(${table.predicate} || ' ' || ${table.value}::text, '[[:punct:]]', ' ', 'g'))`),
}));
