CREATE TABLE IF NOT EXISTS projects_building_colour_legends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  model_id uuid NOT NULL REFERENCES projects_building_models(id) ON DELETE CASCADE,
  source_version_id uuid NOT NULL REFERENCES projects_file_versions(id) ON DELETE CASCADE,
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS projects_building_colour_legends_unique ON projects_building_colour_legends (model_id, source_version_id);
