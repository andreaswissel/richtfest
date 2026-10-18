CREATE TABLE IF NOT EXISTS feasibility_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  site jsonb NOT NULL,
  scenarios jsonb NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS feasibility_studies_project_unique ON feasibility_studies (tenant_id, project_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feasibility_study_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  study_id uuid NOT NULL REFERENCES feasibility_studies(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  method text NOT NULL,
  site jsonb NOT NULL,
  scenarios jsonb NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS feasibility_study_revisions_unique ON feasibility_study_revisions (study_id, revision);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feasibility_study_revisions_tenant ON feasibility_study_revisions (tenant_id, study_id);
