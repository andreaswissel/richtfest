CREATE TABLE feasibility_site_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  input jsonb NOT NULL,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX feasibility_site_assessments_project_unique ON feasibility_site_assessments (tenant_id, project_id);
--> statement-breakpoint
CREATE TABLE feasibility_site_assessment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  assessment_id uuid NOT NULL REFERENCES feasibility_site_assessments(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  method text NOT NULL,
  input jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX feasibility_site_assessment_revisions_unique ON feasibility_site_assessment_revisions (assessment_id, revision);
--> statement-breakpoint
CREATE INDEX feasibility_site_assessment_revisions_tenant ON feasibility_site_assessment_revisions (tenant_id, assessment_id);
