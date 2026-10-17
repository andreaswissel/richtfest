ALTER TABLE projects_inquiries DROP CONSTRAINT IF EXISTS projects_inquiries_kind_check;
--> statement-breakpoint
ALTER TABLE projects_inquiries ADD CONSTRAINT projects_inquiries_kind_check CHECK (kind in ('component_data','noise_data','general'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS projects_noise_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects_projects(id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT projects_noise_sources_kind_check CHECK (kind in ('road','rail')),
  name text NOT NULL,
  mapped_ref text,
  mapped jsonb,
  inquiry_id uuid REFERENCES projects_inquiries(id) ON DELETE SET NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS projects_noise_sources_project ON projects_noise_sources (tenant_id, project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS projects_noise_sources_mapped_unique ON projects_noise_sources (project_id, mapped_ref);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS projects_noise_source_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES projects_noise_sources(id) ON DELETE CASCADE,
  key text NOT NULL,
  version integer NOT NULL,
  value jsonb,
  unit text,
  basis text,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS projects_noise_source_values_version ON projects_noise_source_values (source_id, key, version);
