CREATE TABLE project_planning (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects_projects(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1,
  current_phase text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_planning_project_unique ON project_planning (tenant_id, project_id);
