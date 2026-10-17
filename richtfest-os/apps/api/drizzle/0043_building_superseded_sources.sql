CREATE TABLE IF NOT EXISTS projects_building_superseded_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  model_id uuid NOT NULL REFERENCES projects_building_models(id) ON DELETE CASCADE,
  source_version_id uuid NOT NULL REFERENCES projects_file_versions(id) ON DELETE CASCADE,
  superseded_by_version_id uuid REFERENCES projects_file_versions(id) ON DELETE SET NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS projects_building_superseded_sources_unique ON projects_building_superseded_sources (model_id, source_version_id);
