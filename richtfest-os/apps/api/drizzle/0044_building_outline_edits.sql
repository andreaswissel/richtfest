CREATE TABLE IF NOT EXISTS projects_building_selection_masks (
  job_id uuid PRIMARY KEY REFERENCES projects_building_extractions(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  model_id uuid NOT NULL REFERENCES projects_building_models(id) ON DELETE CASCADE,
  extractor_version text NOT NULL,
  grid_size integer NOT NULL,
  encoding text NOT NULL,
  data text NOT NULL,
  page_aspect_ratio numeric NOT NULL,
  metres_per_page_height numeric,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS projects_building_outline_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  model_id uuid NOT NULL REFERENCES projects_building_models(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  action text NOT NULL,
  method text NOT NULL,
  source_version_id uuid NOT NULL,
  page integer NOT NULL,
  job_id uuid,
  extractor_version text,
  before jsonb,
  after jsonb NOT NULL,
  magic jsonb,
  metrics jsonb NOT NULL,
  model_revision integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS projects_building_outline_edits_target ON projects_building_outline_edits (model_id, target_id);
