import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  uniqueIndex,
  index,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import type { MappedNoiseSource, AddressReference, LocationContext, LocationPointCloud, LocationScene, ProjectAddress, SourceText, SourceFactInput, BuildingEvidence, BuildingPropertyValue } from "@richtfest/shared";

/** Tenant-scoped WMS snapshots; bytes live in private object storage. */
export const locationImages = pgTable("projects_location_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  requestHash: text("request_hash").notNull(),
  sourceUrl: text("source_url").notNull(),
  attribution: text("attribution").notNull(),
  mimeType: text("mime_type").notNull(),
  storageKey: text("storage_key"),
  checksum: text("checksum"),
  sizeBytes: integer("size_bytes"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  freshUntil: timestamp("fresh_until", { withTimezone: true }),
  failures: integer("failures").notNull().default(0),
  retryAt: timestamp("retry_at", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
}, table => ({ request: uniqueIndex("projects_location_images_request").on(table.tenantId, table.requestHash) }));

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
/** Planning tracking only; completion is not engineering approval or phase advancement. */
export const projectPlanning = pgTable("project_planning", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(1),
  currentPhase: text("current_phase").$type<import("@richtfest/shared").ProjectPhase>(),
  items: jsonb("items").$type<import("@richtfest/shared").ProjectPlanningItem[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  project: uniqueIndex("project_planning_project_unique").on(table.tenantId, table.projectId),
}));

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
  /** Document type confirmed by a person; without it the type is inferred on read. */
  documentType: text("document_type"),
  documentTypeReviewedBy: uuid("document_type_reviewed_by"),
  documentTypeReviewedAt: timestamp("document_type_reviewed_at", { withTimezone: true }),
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

// Building Model V1. Identity tables are intentionally stable and do not carry
// source revision or alternative state. Those concerns are represented below.
export const buildingModels = pgTable("projects_building_models", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull(),
  revision: integer("revision").notNull().default(0),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ project: uniqueIndex("projects_building_models_project_unique").on(table.tenantId, table.projectId) }));

export const buildingPlacements = pgTable("projects_building_placements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  origin: jsonb("origin").notNull(),
  orientation: jsonb("orientation"),
  alignmentStatus: text("alignment_status").notNull().default("unknown"),
  evidence: jsonb("evidence").$type<BuildingEvidence[]>().notNull().default([]),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ model: uniqueIndex("projects_building_placements_model_unique").on(table.modelId), statusCheck: check("projects_building_placements_status_check", sql`${table.alignmentStatus} in ('unknown','approximate','reviewed')`) }));

export const buildingRevisions = pgTable("projects_building_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  status: text("status").notNull().default("draft"),
  label: text("label"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ uniqueRevision: uniqueIndex("projects_building_revisions_unique").on(table.modelId, table.revision) }));

export const buildingAlternatives = pgTable("projects_building_alternatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  stableKey: text("stable_key").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ uniqueKey: uniqueIndex("projects_building_alternatives_key_unique").on(table.modelId, table.stableKey) }));

export const buildingBuildings = pgTable("projects_building_buildings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  stableKey: text("stable_key").notNull(),
  name: text("name").notNull(),
  constructionState: text("construction_state").notNull().default("unknown"),
  geometry: jsonb("geometry"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ uniqueKey: uniqueIndex("projects_building_buildings_key_unique").on(table.modelId, table.stableKey), stateCheck: check("projects_building_buildings_state_check", sql`${table.constructionState} in ('existing','retained','demolished','proposed','unknown')`) }));

export const buildingStoreys = pgTable("projects_building_storeys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  buildingId: uuid("building_id").notNull().references(() => buildingBuildings.id, { onDelete: "cascade" }),
  stableKey: text("stable_key").notNull(),
  name: text("name").notNull(),
  levelIndex: integer("level_index"),
  constructionState: text("construction_state").notNull().default("unknown"),
  geometry: jsonb("geometry"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ uniqueKey: uniqueIndex("projects_building_storeys_key_unique").on(table.buildingId, table.stableKey), stateCheck: check("projects_building_storeys_state_check", sql`${table.constructionState} in ('existing','retained','demolished','proposed','unknown')`) }));

export const buildingRooms = pgTable("projects_building_rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  storeyId: uuid("storey_id").notNull().references(() => buildingStoreys.id, { onDelete: "cascade" }),
  stableKey: text("stable_key").notNull(),
  name: text("name").notNull(),
  roomUse: text("room_use"),
  constructionState: text("construction_state").notNull().default("unknown"),
  geometry: jsonb("geometry"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ uniqueKey: uniqueIndex("projects_building_rooms_key_unique").on(table.storeyId, table.stableKey), stateCheck: check("projects_building_rooms_state_check", sql`${table.constructionState} in ('existing','retained','demolished','proposed','unknown')`) }));

export const buildingElements = pgTable("projects_building_elements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  buildingId: uuid("building_id").notNull().references(() => buildingBuildings.id, { onDelete: "cascade" }),
  storeyId: uuid("storey_id").references(() => buildingStoreys.id, { onDelete: "set null" }),
  roomId: uuid("room_id").references(() => buildingRooms.id, { onDelete: "set null" }),
  stableKey: text("stable_key").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  constructionState: text("construction_state").notNull().default("unknown"),
  geometry: jsonb("geometry"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ uniqueKey: uniqueIndex("projects_building_elements_key_unique").on(table.modelId, table.stableKey), stateCheck: check("projects_building_elements_state_check", sql`${table.constructionState} in ('existing','retained','demolished','proposed','unknown')`) }));

export const buildingProperties = pgTable("projects_building_properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  propertyKey: text("property_key").notNull(),
  claimKind: text("claim_kind").notNull().default("observed_fact"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ uniqueProperty: uniqueIndex("projects_building_properties_unique").on(table.modelId, table.entityType, table.entityId, table.propertyKey), claimKindCheck: check("projects_building_properties_claim_kind_check", sql`${table.claimKind} in ('observed_fact','requirement','assumption','calculation_result')`) }));

export const buildingPropertyVersions = pgTable("projects_building_property_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  propertyId: uuid("property_id").notNull().references(() => buildingProperties.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  value: jsonb("value").$type<BuildingPropertyValue>().notNull(),
  unit: text("unit"),
  provenance: text("provenance").notNull(),
  evidence: jsonb("evidence").$type<BuildingEvidence[]>().notNull().default([]),
  reviewStatus: text("review_status").notNull().default("unreviewed"),
  reviewRevision: integer("review_revision").notNull().default(0),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNote: text("review_note"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ uniqueVersion: uniqueIndex("projects_building_property_versions_unique").on(table.propertyId, table.version) }));

export const buildingMeasurements = pgTable("projects_building_measurements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  quantity: text("quantity").notNull(),
  value: numeric("value", { precision: 20, scale: 8 }).notNull(),
  unit: text("unit").notNull(),
  method: text("method").notNull(),
  uncertainty: jsonb("uncertainty"),
  evidence: jsonb("evidence").$type<BuildingEvidence[]>().notNull().default([]),
  reviewStatus: text("review_status").notNull().default("unreviewed"),
  reviewRevision: integer("review_revision").notNull().default(0),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const buildingPlanSources = pgTable("projects_building_plan_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  storeyId: uuid("storey_id").references(() => buildingStoreys.id, { onDelete: "set null" }),
  sourceVersionId: uuid("source_version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
  page: integer("page").notNull(),
  pageCount: integer("page_count"),
  layers: jsonb("layers").notNull().default([]),
  coordinateReference: text("coordinate_reference"),
  alignmentStatus: text("alignment_status").notNull().default("unknown"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A plan set (source revision) replaced by another one in this building model. Its storeys,
 * extractions and candidates leave the model view and agent context; the file itself is untouched. */
export const buildingSupersededSources = pgTable("projects_building_superseded_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  sourceVersionId: uuid("source_version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
  supersededByVersionId: uuid("superseded_by_version_id").references(() => fileVersions.id, { onDelete: "set null" }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ source: uniqueIndex("projects_building_superseded_sources_unique").on(table.modelId, table.sourceVersionId) }));

export const buildingRelationships = pgTable("projects_building_relationships", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  fromEntityType: text("from_entity_type").notNull(),
  fromEntityId: uuid("from_entity_id").notNull(),
  toEntityType: text("to_entity_type").notNull(),
  toEntityId: uuid("to_entity_id").notNull(),
  relationshipType: text("relationship_type").notNull(),
  metadata: jsonb("metadata"),
  reviewStatus: text("review_status").notNull().default("unreviewed"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const buildingConflicts = pgTable("projects_building_conflicts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").references(() => buildingProperties.id, { onDelete: "set null" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  propertyKey: text("property_key").notNull(),
  claims: jsonb("claims").notNull(),
  status: text("status").notNull().default("unresolved"),
  resolutionNote: text("resolution_note"),
  resolvedBy: uuid("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const buildingReconciliations = pgTable("projects_building_reconciliations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  sourceVersionId: uuid("source_version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
  sourceEntityKey: text("source_entity_key").notNull(),
  targetEntityType: text("target_entity_type").notNull(),
  targetEntityId: uuid("target_entity_id"),
  method: text("method").notNull(),
  status: text("status").notNull().default("proposed"),
  note: text("note"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ sourceEntity: uniqueIndex("projects_building_reconciliations_source_unique").on(table.modelId, table.sourceVersionId, table.sourceEntityKey) }));

export const buildingExtractionJobs = pgTable("projects_building_extractions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  sourceVersionId: uuid("source_version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
  storeyId: uuid("storey_id").notNull().references(() => buildingStoreys.id),
  page: integer("page").notNull(),
  extractorVersion: text("extractor_version").notNull().default("labels-v1"),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  result: jsonb("result"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ identity: uniqueIndex("projects_building_extractions_identity").on(t.modelId, t.sourceVersionId, t.storeyId, t.page, t.extractorVersion) }));

export const buildingExtractionCandidates = pgTable("projects_building_extraction_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => buildingExtractionJobs.id, { onDelete: "cascade" }),
  sourceKey: text("source_key").notNull(),
  entityType: text("entity_type").notNull(),
  name: text("name").notNull(),
  geometry: jsonb("geometry").notNull(),
  evidence: jsonb("evidence").notNull(),
  status: text("status").notNull().default("unreviewed"),
  targetEntityId: uuid("target_entity_id"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}, t => ({ identity: uniqueIndex("projects_building_extraction_candidates_identity").on(t.jobId, t.sourceKey) }));

/** Per-page segmentation barriers kept from plan extraction so magic selection can
 * flood-fill a clicked room without re-reading the PDF. One row per extraction job. */
export const buildingSelectionMasks = pgTable("projects_building_selection_masks", {
  jobId: uuid("job_id").primaryKey().references(() => buildingExtractionJobs.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  extractorVersion: text("extractor_version").notNull(),
  gridSize: integer("grid_size").notNull(),
  encoding: text("encoding").notNull(),
  data: text("data").notNull(),
  pageAspectRatio: numeric("page_aspect_ratio").notNull(),
  metresPerPageHeight: numeric("metres_per_page_height"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every planner change to a room outline, kept as training data for plan extraction:
 * what the extractor (or magic selection) proposed and what the planner made of it. */
export const buildingOutlineEdits = pgTable("projects_building_outline_edits", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  action: text("action").notNull(),
  method: text("method").notNull(),
  sourceVersionId: uuid("source_version_id").notNull(),
  page: integer("page").notNull(),
  jobId: uuid("job_id"),
  extractorVersion: text("extractor_version"),
  before: jsonb("before"),
  after: jsonb("after").notNull(),
  magic: jsonb("magic"),
  metrics: jsonb("metrics").notNull(),
  modelRevision: integer("model_revision").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ target: index("projects_building_outline_edits_target").on(t.modelId, t.targetId) }));

export const buildingProposals = pgTable("projects_building_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id").notNull().references(() => buildingModels.id, { onDelete: "cascade" }),
  proposalType: text("proposal_type").notNull(),
  targetEntityType: text("target_entity_type"),
  targetEntityId: uuid("target_entity_id"),
  expectedRevision: integer("expected_revision").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  deepLink: text("deep_link"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const buildingReviews = pgTable("projects_building_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  proposalId: uuid("proposal_id").notNull().references(() => buildingProposals.id, { onDelete: "cascade" }),
  decision: text("decision").notNull(),
  note: text("note"),
  reviewedBy: uuid("reviewed_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An inquiry to a stakeholder (architect, client, authority): a ticket that
 * bundles the request, emails, call notes and documents exchanged about it.
 * Component data inquiries keep the requested items as sent; what is still
 * outstanding is computed against the current model.
 */
export const inquiries = pgTable("projects_inquiries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"component_data" | "noise_data" | "general">().notNull(),
  title: text("title").notNull(),
  counterpart: text("counterpart").notNull(),
  status: text("status").$type<"open" | "waiting" | "answered" | "closed">().notNull().default("open"),
  items: jsonb("items").$type<unknown[]>().notNull().default([]),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, table => ({
  project: index("projects_inquiries_project").on(table.tenantId, table.projectId, table.updatedAt),
  kindCheck: check("projects_inquiries_kind_check", sql`${table.kind} in ('component_data','noise_data','general')`),
  statusCheck: check("projects_inquiries_status_check", sql`${table.status} in ('open','waiting','answered','closed')`),
}));

/** One exchange in an inquiry: the sent request, an email, a call, a note or a document. */
export const inquiryEntries = pgTable("projects_inquiry_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  inquiryId: uuid("inquiry_id").notNull().references(() => inquiries.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"request" | "email" | "call" | "note" | "document">().notNull(),
  direction: text("direction").$type<"outgoing" | "incoming" | "internal">().notNull(),
  subject: text("subject"),
  body: text("body"),
  fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
  /** Set when the entry was filed from an email received at the project's forwarding address. */
  inboundEmailId: uuid("inbound_email_id").references((): any => inboundEmails.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  inquiry: index("projects_inquiry_entries_inquiry").on(table.inquiryId, table.occurredAt),
  kindCheck: check("projects_inquiry_entries_kind_check", sql`${table.kind} in ('request','email','call','note','document')`),
  directionCheck: check("projects_inquiry_entries_direction_check", sql`${table.direction} in ('outgoing','incoming','internal')`),
}));

/** A project's forwarding address: <token>@<inbound domain>, and <token>+<inquiry ref>@… per inquiry. */
export const inboundMailboxes = pgTable("projects_inbound_mailboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull().unique().references(() => projects.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every email received at a forwarding address, kept once per provider message.
 * Mail to an inquiry's address is filed there; mail to the project address
 * waits in the project's inbox until a person files or dismisses it.
 */
export const inboundEmails = pgTable("projects_inbound_emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerEmailId: text("provider_email_id").notNull(),
  messageId: text("message_id"),
  recipient: text("recipient").notNull(),
  fromAddress: text("from_address"),
  fromName: text("from_name"),
  /** Sent by a workspace member (a CC on their own request) or received from outside. */
  direction: text("direction").$type<"incoming" | "outgoing">().notNull().default("incoming"),
  subject: text("subject"),
  body: text("body"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
  attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().notNull().default([]),
  status: text("status").$type<"filed" | "unfiled" | "dismissed">().notNull(),
  inquiryId: uuid("inquiry_id").references(() => inquiries.id, { onDelete: "set null" }),
  handledBy: uuid("handled_by"),
  handledAt: timestamp("handled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  provider: uniqueIndex("projects_inbound_emails_provider_unique").on(table.provider, table.providerEmailId),
  project: index("projects_inbound_emails_project").on(table.tenantId, table.projectId, table.status, table.receivedAt),
  statusCheck: check("projects_inbound_emails_status_check", sql`${table.status} in ('filed','unfiled','dismissed')`),
}));

/**
 * A road or railway whose noise reaches the project's facades. Added from the
 * mapped objects of an environment survey (a snapshot is kept) or by hand.
 * Its inputs are versioned in projects_noise_source_values.
 */
export const noiseSources = pgTable("projects_noise_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"road" | "rail">().notNull(),
  name: text("name").notNull(),
  mappedRef: text("mapped_ref"),
  mapped: jsonb("mapped").$type<(MappedNoiseSource & { surveyFileId: string; connectorVersion: string; retrievedAt: string }) | null>(),
  /** The inquiry that last requested this source's inputs. */
  inquiryId: uuid("inquiry_id").references(() => inquiries.id, { onDelete: "set null" }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  project: index("projects_noise_sources_project").on(table.tenantId, table.projectId),
  mapped: uniqueIndex("projects_noise_sources_mapped_unique").on(table.projectId, table.mappedRef),
  kindCheck: check("projects_noise_sources_kind_check", sql`${table.kind} in ('road','rail')`),
}));

/** Every value entered for a noise source input; the highest version is current, null clears it. */
export const noiseSourceValues = pgTable("projects_noise_source_values", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  sourceId: uuid("source_id").notNull().references(() => noiseSources.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  value: jsonb("value").$type<unknown>(),
  unit: text("unit"),
  /** Where the value comes from, e.g. "Hessen Mobil, Verkehrsmengenkarte 2021". */
  basis: text("basis"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  version: uniqueIndex("projects_noise_source_values_version").on(table.sourceId, table.key, table.version),
}));
