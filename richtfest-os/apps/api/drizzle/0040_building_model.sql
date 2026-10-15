-- Shared Building Model V1. Identity is stable; source revisions, alternatives,
-- construction state, review state and proposals remain separate records.
CREATE TABLE "projects_building_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "project_id" uuid NOT NULL, "revision" integer NOT NULL DEFAULT 0,
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_models_project_unique" UNIQUE ("tenant_id", "project_id")
);
CREATE TABLE "projects_building_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL, "status" text NOT NULL DEFAULT 'draft', "label" text,
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_revisions_unique" UNIQUE ("model_id", "revision")
);
CREATE TABLE "projects_building_placements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "origin" jsonb NOT NULL, "orientation" jsonb,
  "alignment_status" text NOT NULL DEFAULT 'unknown', "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_placements_model_unique" UNIQUE ("model_id"),
  CONSTRAINT "projects_building_placements_status_check" CHECK ("alignment_status" IN ('unknown','approximate','reviewed'))
);
CREATE TABLE "projects_building_alternatives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "stable_key" text NOT NULL, "name" text NOT NULL, "status" text NOT NULL DEFAULT 'draft',
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_alternatives_key_unique" UNIQUE ("model_id", "stable_key")
);
CREATE TABLE "projects_building_buildings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "stable_key" text NOT NULL, "name" text NOT NULL, "construction_state" text NOT NULL DEFAULT 'unknown',
  "geometry" jsonb, "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_buildings_key_unique" UNIQUE ("model_id", "stable_key"),
  CONSTRAINT "projects_building_buildings_state_check" CHECK ("construction_state" IN ('existing','retained','demolished','proposed','unknown'))
);
CREATE TABLE "projects_building_storeys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "building_id" uuid NOT NULL REFERENCES "projects_building_buildings"("id") ON DELETE CASCADE,
  "stable_key" text NOT NULL, "name" text NOT NULL, "level_index" integer,
  "construction_state" text NOT NULL DEFAULT 'unknown', "geometry" jsonb,
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_storeys_key_unique" UNIQUE ("building_id", "stable_key"),
  CONSTRAINT "projects_building_storeys_state_check" CHECK ("construction_state" IN ('existing','retained','demolished','proposed','unknown'))
);
CREATE TABLE "projects_building_rooms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "storey_id" uuid NOT NULL REFERENCES "projects_building_storeys"("id") ON DELETE CASCADE,
  "stable_key" text NOT NULL, "name" text NOT NULL, "room_use" text,
  "construction_state" text NOT NULL DEFAULT 'unknown', "geometry" jsonb,
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_rooms_key_unique" UNIQUE ("storey_id", "stable_key"),
  CONSTRAINT "projects_building_rooms_state_check" CHECK ("construction_state" IN ('existing','retained','demolished','proposed','unknown'))
);
CREATE TABLE "projects_building_elements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "building_id" uuid NOT NULL REFERENCES "projects_building_buildings"("id") ON DELETE CASCADE,
  "storey_id" uuid REFERENCES "projects_building_storeys"("id") ON DELETE SET NULL,
  "room_id" uuid REFERENCES "projects_building_rooms"("id") ON DELETE SET NULL,
  "stable_key" text NOT NULL, "kind" text NOT NULL, "name" text NOT NULL,
  "construction_state" text NOT NULL DEFAULT 'unknown', "geometry" jsonb,
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_elements_key_unique" UNIQUE ("model_id", "stable_key"),
  CONSTRAINT "projects_building_elements_state_check" CHECK ("construction_state" IN ('existing','retained','demolished','proposed','unknown'))
);
CREATE TABLE "projects_building_properties" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL, "entity_id" uuid NOT NULL, "property_key" text NOT NULL,
  "claim_kind" text NOT NULL DEFAULT 'observed_fact',
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_properties_unique" UNIQUE ("model_id", "entity_type", "entity_id", "property_key"),
  CONSTRAINT "projects_building_properties_claim_kind_check" CHECK ("claim_kind" IN ('observed_fact','requirement','assumption','calculation_result'))
);
CREATE TABLE "projects_building_property_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "property_id" uuid NOT NULL REFERENCES "projects_building_properties"("id") ON DELETE CASCADE,
  "version" integer NOT NULL, "value" jsonb NOT NULL, "unit" text,
  "provenance" text NOT NULL, "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "review_status" text NOT NULL DEFAULT 'unreviewed', "review_revision" integer NOT NULL DEFAULT 0,
  "reviewed_by" uuid, "reviewed_at" timestamptz, "review_note" text,
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_property_versions_unique" UNIQUE ("property_id", "version")
);
CREATE TABLE "projects_building_measurements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL, "entity_id" uuid NOT NULL, "quantity" text NOT NULL, "value" numeric(20,8) NOT NULL, "unit" text NOT NULL,
  "method" text NOT NULL, "uncertainty" jsonb, "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "review_status" text NOT NULL DEFAULT 'unreviewed', "review_revision" integer NOT NULL DEFAULT 0, "reviewed_by" uuid, "reviewed_at" timestamptz,
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "projects_building_plan_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "storey_id" uuid REFERENCES "projects_building_storeys"("id") ON DELETE SET NULL,
  "source_version_id" uuid NOT NULL REFERENCES "projects_file_versions"("id") ON DELETE CASCADE,
  "page" integer NOT NULL, "page_count" integer, "layers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "coordinate_reference" text, "alignment_status" text NOT NULL DEFAULT 'unknown',
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "projects_building_relationships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "from_entity_type" text NOT NULL, "from_entity_id" uuid NOT NULL,
  "to_entity_type" text NOT NULL, "to_entity_id" uuid NOT NULL, "relationship_type" text NOT NULL,
  "metadata" jsonb, "review_status" text NOT NULL DEFAULT 'unreviewed',
  "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "projects_building_conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "property_id" uuid REFERENCES "projects_building_properties"("id") ON DELETE SET NULL,
  "entity_type" text NOT NULL, "entity_id" uuid NOT NULL, "property_key" text NOT NULL,
  "claims" jsonb NOT NULL, "status" text NOT NULL DEFAULT 'unresolved', "resolution_note" text,
  "resolved_by" uuid, "resolved_at" timestamptz, "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "projects_building_reconciliations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "source_version_id" uuid NOT NULL REFERENCES "projects_file_versions"("id") ON DELETE CASCADE,
  "source_entity_key" text NOT NULL, "target_entity_type" text NOT NULL, "target_entity_id" uuid,
  "method" text NOT NULL, "status" text NOT NULL DEFAULT 'proposed', "note" text,
  "reviewed_by" uuid, "reviewed_at" timestamptz, "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "projects_building_reconciliations_source_unique" UNIQUE ("model_id", "source_version_id", "source_entity_key")
);
CREATE TABLE "projects_building_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "projects_building_models"("id") ON DELETE CASCADE,
  "proposal_type" text NOT NULL, "target_entity_type" text, "target_entity_id" uuid,
  "expected_revision" integer NOT NULL, "payload" jsonb NOT NULL, "status" text NOT NULL DEFAULT 'pending',
  "deep_link" text, "created_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "projects_building_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL,
  "proposal_id" uuid NOT NULL REFERENCES "projects_building_proposals"("id") ON DELETE CASCADE,
  "decision" text NOT NULL, "note" text, "reviewed_by" uuid NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "projects_building_entities_lookup" ON "projects_building_rooms" ("tenant_id", "model_id", "storey_id");
CREATE INDEX "projects_building_elements_lookup" ON "projects_building_elements" ("tenant_id", "model_id", "room_id");
CREATE INDEX "projects_building_properties_lookup" ON "projects_building_properties" ("tenant_id", "model_id", "entity_type", "entity_id");
CREATE INDEX "projects_building_proposals_lookup" ON "projects_building_proposals" ("tenant_id", "model_id", "status", "created_at");
